// @vitest-environment jsdom
//
// File > Pack project: the portability report with its actions, what the
// pack will hold and the licence line, then the file to write; the pack runs
// once a file is picked, and the dialog closes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../i18n";
import type { PackPlan, PortabilityReport } from "../ipc";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), invokeRaw: vi.fn(), save: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({
  invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args),
  invokeRaw: (cmd: string, args?: unknown) => bridge.invokeRaw(cmd, args),
}));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn(), save: (opts: unknown) => bridge.save(opts) }));

import { PackDialog } from "./PackDialog";

afterEach(() => { cleanup(); bridge.invoke.mockReset(); bridge.invokeRaw.mockReset(); bridge.save.mockReset(); });

const report: PortabilityReport = {
  portable: false,
  media: { outside: [], missing: [] },
  motifs: { missing: [], invalid: [], untracked: ["spare"] },
  fonts: { excluded: [], missing: [] },
  style: { outside: null },
};
const plan: PackPlan = { files: 2, bytes: 1.5 * 1024 * 1024, file_name: "Example.wcpk" };

function backend() {
  bridge.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "project_portability") return report;
    if (cmd === "project_trash_motif_folder") return null;
    throw new Error(`unexpected ${cmd}`);
  });
  bridge.invokeRaw.mockImplementation(async (cmd: string, args?: { archive: string }) => {
    if (cmd === "project_pack_plan") return plan;
    if (cmd === "project_pack") return { outcome: "cancelled" };
    throw new Error(`unexpected ${cmd} ${JSON.stringify(args)}`);
  });
}

describe("the pack dialog", () => {
  it("shows the portability report with its actions, the pack's size and the licence line", async () => {
    backend();
    render(<PackDialog onClose={() => {}} />);
    expect(await screen.findByText("2 files · 1.5 MB")).toBeTruthy();
    expect(screen.getByText("Check font licenses before you share the pack.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Move Motifs/spare/ to the trash" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("project_trash_motif_folder", { name: "spare" }));
  });

  it("asks for the file under the project's name, then packs into it and closes", async () => {
    backend();
    bridge.save.mockResolvedValue("/home/u/out/Example.wcpk");
    const onClose = vi.fn();
    render(<PackDialog onClose={onClose} />);
    await screen.findByText("2 files · 1.5 MB");
    fireEvent.click(screen.getByRole("button", { name: "Pack…" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bridge.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: "Example.wcpk", filters: [{ name: "WeftCut pack", extensions: ["wcpk"] }],
    }));
    expect(bridge.invokeRaw).toHaveBeenCalledWith("project_pack", { archive: "/home/u/out/Example.wcpk" });
  });

  it("packs nothing and stays open when no file is picked", async () => {
    backend();
    bridge.save.mockResolvedValue(null);
    const onClose = vi.fn();
    render(<PackDialog onClose={onClose} />);
    await screen.findByText("2 files · 1.5 MB");
    fireEvent.click(screen.getByRole("button", { name: "Pack…" }));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: "Pack…" }) as HTMLButtonElement).disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.invokeRaw.mock.calls.map(([cmd]) => cmd)).not.toContain("project_pack");
  });
});
