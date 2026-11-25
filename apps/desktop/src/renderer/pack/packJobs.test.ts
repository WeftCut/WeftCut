// @vitest-environment jsdom
//
// Pack and unpack from the renderer: what each refusal says, and the notice a
// pack's end leaves. The unpack's questions are Open project's
// (startup/openProject.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { PackFailure } from "../../shared/projectPack";
import { WorkspaceFailure } from "../../shared/workspaceErrors";

const bridge = vi.hoisted(() => ({ invokeRaw: vi.fn(), open: vi.fn(), notify: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn(), invokeRaw: (cmd: string, args?: unknown) => bridge.invokeRaw(cmd, args) }));
vi.mock("@/bridge/dialog", () => ({ open: (opts: unknown) => bridge.open(opts), save: vi.fn() }));
vi.mock("@/bridge/notification", () => ({ sendNotification: (opts: unknown) => bridge.notify(opts) }));

import { describePackError, runPack } from "./packJobs";
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
    expect(said(new PackFailure({ refusal: "NotAPack", detail: "the pack holds no project.wcpr" })))
      .toBe("That file isn't a WeftCut pack: the pack holds no project.wcpr");
    expect(said(new PackFailure({ refusal: "FolderNotEmpty", folder: "Example" })))
      .toBe("That folder already holds a non-empty “Example”. Pick another folder.");
    expect(said(new PackFailure({ refusal: "NotEnoughSpace", needed: 3 * 1024 ** 3, available: 1024 ** 3 })))
      .toBe("Not enough free space: the project needs 3.0 GB, the drive has 1.0 GB.");
  });

  it("says a newer schema as the open does", () => {
    const tooNew = new WorkspaceFailure({ error: "ProjectSchemaTooNew", found: 99, supported: 7 });
    expect(describePackError(ipcError(tooNew), t, "unpack", "/home/u/in/Example.wcpk")).toContain("v99");
  });

  it("names the step that failed for anything else", () => {
    expect(describePackError(new Error("disk full"), t, "pack", "/home/u/out/Example.wcpk")).toBe("Couldn't pack the project: disk full");
    expect(describePackError(new Error("disk full"), t, "unpack", "/home/u/Projects/Example")).toBe("Couldn't unpack the project: disk full");
  });
});

describe("the end of a pack", () => {
  const archive = "/home/u/out/Example.wcpk";

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
    bridge.invokeRaw.mockRejectedValue(new Error("Example.wcpk: permission denied"));
    await runPack(t, archive);
    expect(useComputeJobNoticeStore.getState().notice).toMatchObject({
      outcome: "error", title: "Pack failed", body: "Couldn't pack the project: Example.wcpk: permission denied",
    });
    expect(useComputeJobNoticeStore.getState().notice).not.toHaveProperty("reveal");
  });
});
