// @vitest-environment jsdom
//
// The Motif section's rows for the Motif itself: its Version against the
// library, and the Source row that names the project Motif's own folder and
// opens that folder, never a file in it (a `.html` file's default handler is a
// browser).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { LibraryMotifRow, MotifCatalog, ProjectMotifRow } from "../ipc";

const listMotifCatalog = vi.hoisted(() => vi.fn());
vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  listMotifCatalog,
}));
const shellOpen = vi.hoisted(() => vi.fn(async (_target: string) => {}));
vi.mock("@/bridge/shell", () => ({ open: shellOpen, reveal: vi.fn() }));

import { MotifPackageRows } from "./MotifManagement";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FOLDER = "/home/u/Film/Motifs/lower";
const row = { group: "project", id: "lower", uid: "u", status: "ok", state: "project_only", from: null,
  path: FOLDER, revision: "r", motif: null } as ProjectMotifRow;
const catalog: MotifCatalog = { project: [row], library: [], misnamed: [] };

describe("MotifPackageRows", () => {
  it("shows the Motif's version and its folder, and opens that folder", async () => {
    listMotifCatalog.mockResolvedValue(catalog);
    render(<MotifPackageRows motifId="lower" files />);
    expect(await screen.findByText(FOLDER)).toBeTruthy();
    expect(screen.getByText("Version")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(shellOpen).toHaveBeenCalledWith(FOLDER);
  });

  it("copies the folder path", async () => {
    const user = userEvent.setup();
    listMotifCatalog.mockResolvedValue(catalog);
    render(<MotifPackageRows motifId="lower" files />);
    await user.click(await screen.findByRole("button", { name: "Copy path" }));
    expect(await navigator.clipboard.readText()).toBe(FOLDER);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says why the folder did not open", async () => {
    listMotifCatalog.mockResolvedValue(catalog);
    shellOpen.mockRejectedValueOnce(new Error("no file manager"));
    render(<MotifPackageRows motifId="lower" files />);
    await userEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    expect(await screen.findByText(/no file manager/)).toBeTruthy();
  });

  it("has no Source row for a Motif that cannot render", async () => {
    listMotifCatalog.mockResolvedValue(catalog);
    render(<MotifPackageRows motifId="lower" files={false} />);
    expect(await screen.findByText("Version")).toBeTruthy();
    expect(screen.queryByText(FOLDER)).toBeNull();
  });
});

describe("MotifPackageRows version note", () => {
  it("says how the two differ only when they do, warning that updating replaces edits made here", async () => {
    const libraryRow = { group: "library", id: "lower", status: "installed", revision: "L3", in_project: "lower",
      motif: { id: "lower", name: "Lower", version: 3, size: [64, 64], default_duration_s: 1, props_schema: {} } } as unknown as LibraryMotifRow;
    const diverged = { ...row, uid: "u", state: "modified", from: { uid: "u", version: 2, revision: "L2" } } as ProjectMotifRow;
    listMotifCatalog.mockResolvedValue({ project: [diverged], library: [libraryRow], misnamed: [] });
    render(<MotifPackageRows motifId="lower" files />);
    expect(await screen.findByText(/since library version 2, and the library is now at version 3\. Updating replaces these edits\./)).toBeTruthy();
    cleanup();

    const inSync = { ...diverged, state: "in_sync", from: { uid: "u", version: 3, revision: "L3" } } as ProjectMotifRow;
    listMotifCatalog.mockResolvedValue({ project: [inSync], library: [libraryRow], misnamed: [] });
    render(<MotifPackageRows motifId="lower" files />);
    await screen.findByText(FOLDER);
    expect(document.querySelector(".prop-motif-version-gap")).toBeNull();
  });
});
