// @vitest-environment jsdom
//
// The portability check dialog: one line for a folder that carries
// everything, the report's groups otherwise, and the report read again after
// each action.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "../i18n";
import type { PortabilityReport } from "../ipc";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({ invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args) }));

import { PortabilityDialog } from "./PortabilityDialog";
import { useSettingsRequest } from "../settings/settingsRequest";

afterEach(() => { cleanup(); bridge.invoke.mockReset(); });

const clean: PortabilityReport = {
  portable: true,
  media: { outside: [], missing: [] },
  motifs: { missing: [], invalid: [], untracked: [] },
  fonts: { excluded: [], missing: [] },
  style: { outside: null },
};

/** Answers the dialog's channels: reports in turn, the last one repeated. */
function backend(reports: PortabilityReport[], trash: () => unknown = () => null) {
  bridge.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "project_portability") return reports.length > 1 ? reports.shift() : reports[0];
    if (cmd === "project_trash_motif_folder") return trash();
    throw new Error(`unexpected ${cmd}`);
  });
}

const region = (name: string) => screen.getByRole("region", { name });

describe("the portability check dialog", () => {
  it("says the folder carries everything, and lists no group, when nothing is outside it", async () => {
    backend([clean]);
    render(<PortabilityDialog onClose={() => {}} />);
    expect(await screen.findByText("This folder carries everything the project needs.")).toBeTruthy();
    expect(screen.queryAllByRole("region")).toEqual([]);
  });

  it("lists each kind of item under its group, the folders a copy leaves in a group of their own", async () => {
    backend([{
      portable: false,
      media: { outside: [{ media_id: "m1", label: "clip.mp4", path: "/home/u/Videos/clip.mp4" }], missing: [{ media_id: "m2", label: "gone.wav", path: "/home/u/gone.wav" }] },
      motifs: { missing: [{ motif_id: "lower", diagnostic: "Motifs/lower/ is missing" }], invalid: [{ motif_id: "torn", diagnostic: "index.html is missing" }], untracked: ["spare"] },
      fonts: { excluded: [{ family: "Example Sans", installed: true }, { family: "Elsewhere Serif", installed: false }], missing: [{ family: "Nowhere", weight: 700, italic: true, layer_ids: ["l1"] }] },
      style: { outside: "/home/u/styles/house" },
    }]);
    render(<PortabilityDialog onClose={() => {}} />);
    expect(await screen.findByText("The project folder does not carry these.")).toBeTruthy();
    expect(within(region("Media outside the folder")).getByText("/home/u/Videos/clip.mp4")).toBeTruthy();
    expect(within(region("Missing media")).getByText("gone.wav")).toBeTruthy();
    expect(within(region("Missing Motifs")).getByText("lower")).toBeTruthy();
    expect(within(region("Invalid Motifs")).getByText("index.html is missing")).toBeTruthy();
    const fonts = region("Fonts excluded from the project");
    expect(within(fonts).getByText("Excluded")).toBeTruthy();
    expect(within(fonts).getByText("Excluded · not installed here")).toBeTruthy();
    expect(within(fonts).getAllByRole("button").map((b) => b.textContent)).toEqual(["Open Settings > Project > Fonts"]);
    expect(within(region("Missing fonts")).getByText("Bold Italic")).toBeTruthy();
    expect(within(region("Style not in the folder")).getByText("/home/u/styles/house")).toBeTruthy();
    expect(within(region("Not carried by a copy")).getByRole("button", { name: "Move Motifs/spare/ to the trash" })).toBeTruthy();
  });

  it("moves an unused Motif folder to the trash and reads the report again, a refusal shown", async () => {
    const withSpare = { ...clean, motifs: { ...clean.motifs, untracked: ["spare"] } };
    backend([withSpare, withSpare, clean], () => { throw new Error("the trash is unavailable"); });
    render(<PortabilityDialog onClose={() => {}} />);
    const trash = await screen.findByRole("button", { name: "Move Motifs/spare/ to the trash" });
    // Portable, with the unused folder listed on its own.
    expect(screen.getByText("This folder carries everything the project needs.")).toBeTruthy();
    fireEvent.click(trash);
    expect(await screen.findByRole("alert")).toBeTruthy();
    backend([clean]);
    fireEvent.click(screen.getByRole("button", { name: "Move Motifs/spare/ to the trash" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Not carried by a copy" })).toBeNull());
    const calls = bridge.invoke.mock.calls.map(([cmd, args]) => [cmd, args]);
    expect(calls.filter(([cmd]) => cmd === "project_trash_motif_folder")).toEqual([
      ["project_trash_motif_folder", { name: "spare" }], ["project_trash_motif_folder", { name: "spare" }],
    ]);
    // Read on open and after each action.
    expect(calls.filter(([cmd]) => cmd === "project_portability")).toHaveLength(3);
  });

  it("closes itself and opens Settings on the Project pane for excluded fonts", async () => {
    backend([{ ...clean, portable: false, fonts: { excluded: [{ family: "Example Sans", installed: true }], missing: [] } }]);
    const onClose = vi.fn();
    render(<PortabilityDialog onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings > Project > Fonts" }));
    expect(onClose).toHaveBeenCalled();
    expect(useSettingsRequest.getState().request?.category).toBe("project");
  });
});
