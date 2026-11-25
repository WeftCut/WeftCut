// @vitest-environment jsdom
//
// Open project: one picker takes a project file or a pack. A project file
// opens in place; a pack is read before the user is asked where to put it.
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { PackFailure } from "../../shared/projectPack";
import { WorkspaceFailure } from "../../shared/workspaceErrors";
import { LEGACY_PROJECT_FILE, PACK_EXTENSION, PROJECT_EXTENSION } from "../../shared/projectFile";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), invokeRaw: vi.fn(), open: vi.fn(), notify: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({
  invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args),
  invokeRaw: (cmd: string, args?: unknown) => bridge.invokeRaw(cmd, args),
}));
vi.mock("@/bridge/dialog", () => ({ open: (opts: unknown) => bridge.open(opts), save: vi.fn() }));
vi.mock("@/bridge/notification", () => ({ sendNotification: (opts: unknown) => bridge.notify(opts) }));

import { openProject, openProjectFromEditor } from "./openProject";
import { useComputeJobNoticeStore } from "../compute/computeJobNotices";

const t = i18n.t.bind(i18n);
/** An IPC rejection as the renderer receives it: Electron prefixes the message. */
const ipcError = (error: Error) => new Error(`Error invoking remote method 'backend:invoke': ${error.name}: ${error.message}`);
const inspected = { name: "Example", folder_name: "Example", files: 3, bytes: 300 };
const opened = vi.fn();

afterEach(() => {
  bridge.invoke.mockReset();
  bridge.invokeRaw.mockReset();
  bridge.open.mockReset();
  opened.mockReset();
  useComputeJobNoticeStore.setState({ notice: null });
});

describe("the picker", () => {
  it("offers project files and packs together, and a 0.8 project file apart", async () => {
    bridge.open.mockResolvedValueOnce(null);
    await openProject(t, opened);
    const { filters, directory } = bridge.open.mock.calls[0]![0] as { filters: { name: string; extensions: string[] }[]; directory?: boolean };
    expect(directory).toBeFalsy();
    expect(filters[0]!.extensions).toEqual([PROJECT_EXTENSION, PACK_EXTENSION]);
    expect(filters[1]!.name).toContain(LEGACY_PROJECT_FILE);
  });

  it("opens nothing when cancelled", async () => {
    bridge.open.mockResolvedValueOnce(null);
    await expect(openProject(t, opened)).resolves.toBeNull();
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(bridge.invokeRaw).not.toHaveBeenCalled();
  });
});

describe("a project file", () => {
  it("is handed to main as picked, which opens its folder; the caller moves to it once open", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/Projects/Example/project.wcpr");
    bridge.invoke.mockImplementation(async () => { expect(opened).not.toHaveBeenCalled() });
    await expect(openProject(t, opened)).resolves.toBeNull();
    expect(bridge.invoke).toHaveBeenCalledWith("project_open", { path: "/home/u/Projects/Example/project.wcpr" });
    expect(bridge.invokeRaw).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledOnce();
  });

  it("says why it did not open, and the caller stays where it is", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/notes/todo.json");
    bridge.invoke.mockImplementation(async (cmd: string) => { if (cmd === "project_open") throw ipcError(new WorkspaceFailure({ error: "NotProjectFolder" })); return null });
    await expect(openProject(t, opened)).resolves.toBe(t("startup.not_project_folder"));
    expect(opened).not.toHaveBeenCalled();
  });

  it("leaves the project already open as it is when its own file is picked", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/Projects/Example/project.wcpr");
    bridge.invoke.mockImplementation(async (cmd: string) => cmd === "project_open_state" ? { dir: "/home/u/Projects/Example" } : undefined);
    await expect(openProject(t, opened)).resolves.toBeNull();
    expect(bridge.invoke).not.toHaveBeenCalledWith("project_open", expect.anything());
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("a pack", () => {
  it("is read before the user is asked where to put it, then unpacked there", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/in/Example.wcpk").mockResolvedValueOnce("/home/u/Projects");
    bridge.invokeRaw.mockImplementation(async (cmd: string) => cmd === "project_unpack_inspect"
      ? inspected
      : { outcome: "done", dir: "/home/u/Projects/Example" });
    await expect(openProject(t, opened)).resolves.toBeNull();
    expect(bridge.invokeRaw.mock.calls).toEqual([
      ["project_unpack_inspect", { archive: "/home/u/in/Example.wcpk" }],
      ["project_unpack", { archive: "/home/u/in/Example.wcpk", parent: "/home/u/Projects" }],
    ]);
    expect(bridge.open.mock.calls[1]![0]).toMatchObject({ directory: true, title: "Choose where to put “Example”" });
    expect(bridge.invoke).not.toHaveBeenCalled();
    // Main opens the unpacked folder and tells the window itself.
    expect(opened).not.toHaveBeenCalled();
  });

  it("says why it cannot be opened and asks nothing more", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/in/notes.wcpk");
    bridge.invokeRaw.mockRejectedValue(ipcError(new PackFailure({ refusal: "NotAPack", detail: "not a zip" })));
    await expect(openProject(t, opened)).resolves.toBe("That file isn't a WeftCut pack: not a zip");
    expect(bridge.open).toHaveBeenCalledTimes(1);
  });

  it("unpacks nothing when the folder picker is cancelled", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/in/Example.wcpk").mockResolvedValueOnce(null);
    bridge.invokeRaw.mockResolvedValue(inspected);
    await expect(openProject(t, opened)).resolves.toBeNull();
    expect(bridge.invokeRaw.mock.calls.map(([cmd]) => cmd)).toEqual(["project_unpack_inspect"]);
  });
});

describe("from the editor", () => {
  it("leaves a notice saying why it did not open", async () => {
    bridge.open.mockResolvedValueOnce("/home/u/Projects/Example/project.wcpr");
    bridge.invoke.mockImplementation(async (cmd: string) => { if (cmd === "project_open") throw ipcError(new WorkspaceFailure({ error: "NotProjectFolder" })); return null });
    await openProjectFromEditor(t, opened);
    expect(useComputeJobNoticeStore.getState().notice).toMatchObject({
      outcome: "error", title: t("open_project.failed_title"), body: t("startup.not_project_folder"),
    });
  });
});
