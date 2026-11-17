import { describe, it, expect, vi, beforeEach } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({ invoke: (cmd: string, args?: unknown) => bridge.invoke(cmd, args) }));
vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));

import { listen } from "@/bridge/events";
import { clearProjectMotifs, installMotifsChangedListener, syncProjectMotifsFromBackend } from "./syncCatalog";
import { getMotif, motifUnavailable, setProjectMotifs } from "./catalog";

const manifest = (id: string, size: [number, number]) =>
  ({ id, name: id, version: 1, size, default_duration_s: 2, props_schema: {}, html: "<html></html>", content_hash: "r" });

describe("syncProjectMotifsFromBackend", () => {
  beforeEach(() => { setProjectMotifs(); bridge.invoke.mockReset(); });

  it("fills the catalog from the project group only, with its broken Motifs as unavailable", async () => {
    bridge.invoke.mockResolvedValue([
      { ...manifest("lower", [320, 240]), group: "project", uid: "u1", status: "ok", state: "in_sync", from: null, path: "/home/u/Film/Motifs/lower", revision: "r" },
      { group: "project", id: "gone", uid: "u2", status: "missing", state: "project_only", from: null, path: "/home/u/Film/Motifs/gone", revision: null, diagnostic: "Motifs/gone/ is missing" },
    ]);
    await syncProjectMotifsFromBackend();
    expect(bridge.invoke).toHaveBeenCalledWith("list_motifs", { group: "project" });
    expect(getMotif("lower")?.manifest.size).toEqual([320, 240]);
    expect(getMotif("gone")).toBeNull();
    expect(motifUnavailable("gone")).toMatchObject({ status: "missing", diagnostic: "Motifs/gone/ is missing" });
  });

  it("re-pulls on motifs:changed, so a Motif placed by the commit that sent it resolves", async () => {
    await installMotifsChangedListener();
    const onChanged = vi.mocked(listen).mock.calls.at(-1)![1] as () => void;
    bridge.invoke.mockResolvedValue([
      { ...manifest("lower", [320, 240]), group: "project", uid: "u1", status: "ok", state: "in_sync", from: null, path: "/home/u/Film/Motifs/lower", revision: "r" },
    ]);
    expect(getMotif("lower")).toBeNull();
    onChanged();
    await vi.waitFor(() => expect(getMotif("lower")).not.toBeNull());
  });

  it("keeps the last catalog when the IPC fails", async () => {
    setProjectMotifs([manifest("kept", [10, 10])]);
    bridge.invoke.mockRejectedValue(new Error("ipc down"));
    await expect(syncProjectMotifsFromBackend()).resolves.toBeUndefined();
    expect(getMotif("kept")).not.toBeNull();
  });

  it("drops a pull still in flight when the project goes", async () => {
    let answer!: (rows: unknown[]) => void;
    bridge.invoke.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const pull = syncProjectMotifsFromBackend();
    clearProjectMotifs();
    answer([{ ...manifest("old", [10, 10]), group: "project", uid: "u", status: "ok", state: "in_sync", from: null, path: "/p", revision: "r" }]);
    await pull;
    expect(getMotif("old")).toBeNull();
  });
});
