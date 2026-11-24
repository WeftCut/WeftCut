// @vitest-environment jsdom
//
// Pack and Open packed project from the renderer: what each refusal says, the
// order the unpack flow asks its questions in, and the notice a pack's end
// leaves.
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { PackFailure } from "../../shared/projectPack";
import { WorkspaceFailure } from "../../shared/workspaceErrors";

const bridge = vi.hoisted(() => ({ invokeRaw: vi.fn(), open: vi.fn(), notify: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn(), invokeRaw: (cmd: string, args?: unknown) => bridge.invokeRaw(cmd, args) }));
vi.mock("@/bridge/dialog", () => ({ open: (opts: unknown) => bridge.open(opts), save: vi.fn() }));
vi.mock("@/bridge/notification", () => ({ sendNotification: (opts: unknown) => bridge.notify(opts) }));

import { describePackError, openPackedProject, runPack } from "./packJobs";
import { useComputeJobNoticeStore } from "../compute/computeJobNotices";

const t = i18n.t.bind(i18n);
/** An IPC rejection as the renderer receives it: Electron prefixes the message. */
const ipcError = (error: Error) => new Error(`Error invoking remote method 'backend:invoke': ${error.name}: ${error.message}`);

afterEach(() => {
  bridge.invokeRaw.mockReset();
  bridge.open.mockReset();
  bridge.notify.mockReset();
  useComputeJobNoticeStore.setState({ notice: null });
});

describe("what a refusal says", () => {
  it("names each pack refusal in words, with its facts", () => {
    const said = (e: Error) => describePackError(ipcError(e), t, "unpack", "/home/u/Projects/Example");
    expect(said(new PackFailure({ refusal: "PackBusy" }))).toBe("A pack or unpack is already running.");
    expect(said(new PackFailure({ refusal: "NotAPack", detail: "the pack holds no project.json" })))
      .toBe("That file isn't a WeftCut pack: the pack holds no project.json");
    expect(said(new PackFailure({ refusal: "FolderNotEmpty", folder: "Example" })))
      .toBe("That folder already holds a non-empty “Example”. Pick another folder.");
    expect(said(new PackFailure({ refusal: "NotEnoughSpace", needed: 3 * 1024 ** 3, available: 1024 ** 3 })))
      .toBe("Not enough free space: the project needs 3.0 GB, the drive has 1.0 GB.");
  });

  it("says a newer schema as the open does", () => {
    const tooNew = new WorkspaceFailure({ error: "ProjectSchemaTooNew", found: 99, supported: 7 });
    expect(describePackError(ipcError(tooNew), t, "unpack", "/home/u/in/Example.weftcut")).toContain("v99");
  });

  it("names the step that failed for anything else", () => {
    expect(describePackError(new Error("disk full"), t, "pack", "/home/u/out/Example.weftcut")).toBe("Couldn't pack the project: disk full");
    expect(describePackError(new Error("disk full"), t, "unpack", "/home/u/Projects/Example")).toBe("Couldn't unpack the project: disk full");
  });
});

describe("Open packed project", () => {
  it("reads the pack before it asks where to put it, then unpacks there", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/in/Example.weftcut").mockResolvedValueOnce("/home/u/Projects");
    bridge.invokeRaw.mockImplementation(async (cmd: string) => cmd === "project_unpack_inspect"
      ? { name: "Example", folder_name: "Example", files: 3, bytes: 300 }
      : { outcome: "done", dir: "/home/u/Projects/Example" });
    await expect(openPackedProject(t)).resolves.toBeNull();
    expect(bridge.invokeRaw.mock.calls).toEqual([
      ["project_unpack_inspect", { archive: "/home/u/in/Example.weftcut" }],
      ["project_unpack", { archive: "/home/u/in/Example.weftcut", parent: "/home/u/Projects" }],
    ]);
    expect(bridge.open.mock.calls[1]![0]).toMatchObject({ directory: true, title: "Choose where to put “Example”" });
  });

  it("says why a file cannot be opened and asks nothing more", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/in/notes.weftcut");
    bridge.invokeRaw.mockRejectedValue(ipcError(new PackFailure({ refusal: "NotAPack", detail: "not a zip" })));
    await expect(openPackedProject(t)).resolves.toBe("That file isn't a WeftCut pack: not a zip");
    expect(bridge.open).toHaveBeenCalledTimes(1);
  });

  it("unpacks nothing when the folder picker is cancelled", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/in/Example.weftcut").mockResolvedValueOnce(null);
    bridge.invokeRaw.mockResolvedValue({ name: "Example", folder_name: "Example", files: 3, bytes: 300 });
    await expect(openPackedProject(t)).resolves.toBeNull();
    expect(bridge.invokeRaw.mock.calls.map(([cmd]) => cmd)).toEqual(["project_unpack_inspect"]);
  });
});

describe("the end of a pack", () => {
  const archive = "/home/u/out/Example.weftcut";

  it("leaves a notice that can show the pack in its folder", async () => {
    bridge.invokeRaw.mockResolvedValue({ outcome: "done", archive, files: 4 });
    await runPack(t, archive);
    expect(bridge.invokeRaw).toHaveBeenCalledWith("project_pack", { archive });
    expect(useComputeJobNoticeStore.getState().notice).toMatchObject({ outcome: "ok", title: "Project packed", reveal: archive });
  });

  it("leaves none for a cancel, which the user pressed", async () => {
    bridge.invokeRaw.mockResolvedValue({ outcome: "cancelled" });
    await runPack(t, archive);
    expect(useComputeJobNoticeStore.getState().notice).toBeNull();
  });

  it("says why it failed", async () => {
    bridge.invokeRaw.mockRejectedValue(new Error("Example.weftcut: permission denied"));
    await runPack(t, archive);
    expect(useComputeJobNoticeStore.getState().notice).toMatchObject({
      outcome: "error", title: "Pack failed", body: "Couldn't pack the project: Example.weftcut: permission denied",
    });
    expect(useComputeJobNoticeStore.getState().notice).not.toHaveProperty("reveal");
  });
});
