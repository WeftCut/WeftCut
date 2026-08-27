import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../ipc";

const mocks = vi.hoisted(() => ({
  projectSummary: vi.fn<() => Promise<ProjectSummary>>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  onProjectChanged: null as (() => void) | null,
}));

vi.mock("../ipc", () => ({
  projectSummary: () => mocks.projectSummary(),
}));

vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (_event: string, callback: () => void) => {
    mocks.onProjectChanged = callback;
    mocks.listen();
    return mocks.unlisten;
  }),
}));

import { useProjectStore, wireProjectStore } from "./projectStore";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import type { LayerSummary, TrackSummary } from "../ipc";

function summary(name: string): ProjectSummary {
  return summaryFixture({
    project_id: "project-1",
    name: name,
    media: [],
    history: {
      cursor: 0,
      len: 0,
      can_undo: false,
      can_redo: false,
    },
    audio_roles: [],
    root: {
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 0,
      tracks: [],
      markers: [],
      transitions: [],
      links: [],
    },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("wireProjectStore summary ordering", () => {
  beforeEach(() => {
    mocks.projectSummary.mockReset();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    mocks.onProjectChanged = null;
    useProjectStore.getState().apply(null);
  });

  it("does not publish an older success while a newer request is pending", async () => {
    mocks.projectSummary.mockResolvedValueOnce(summary("baseline"));
    const unwire = await wireProjectStore();
    const older = deferred<ProjectSummary>();
    const newer = deferred<ProjectSummary>();
    mocks.projectSummary
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    mocks.onProjectChanged!();
    mocks.onProjectChanged!();
    older.resolve(summary("older"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("baseline");

    newer.resolve(summary("newer"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("newer");
    unwire();
  });

  it("does not publish an older failure while a newer request is pending", async () => {
    mocks.projectSummary.mockResolvedValueOnce(summary("baseline"));
    const unwire = await wireProjectStore();
    const older = deferred<ProjectSummary>();
    const newer = deferred<ProjectSummary>();
    mocks.projectSummary
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    mocks.onProjectChanged!();
    mocks.onProjectChanged!();
    older.reject(new Error("stale failure"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("baseline");

    newer.resolve(summary("newer"));
    await settle();
    expect(useProjectStore.getState().summary?.name).toBe("newer");
    unwire();
  });

  it("invalidates an in-flight request when unwired", async () => {
    mocks.projectSummary.mockResolvedValueOnce(summary("baseline"));
    const unwire = await wireProjectStore();
    const pending = deferred<ProjectSummary>();
    mocks.projectSummary.mockReturnValueOnce(pending.promise);

    mocks.onProjectChanged!();
    unwire();
    pending.resolve(summary("after-unwire"));
    await settle();

    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().summary?.name).toBe("baseline");
  });
});

describe("indices span every composition", () => {
  const stat = <T,>(value: T) => ({ mode: "Static" as const, value });
  const color = (id: string): LayerSummary => ({
    id, label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "Color", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: { kind: "Color", color: stat({ r: 0, g: 0, b: 0, a: 255 }), width: 16, height: 9 },
  });
  const track = (id: string, layers: LayerSummary[]): TrackSummary => ({
    id, kind: "Video", label: null, enabled: true, locked: false, muted: false, solo: false,
    role: null, transient: true, layers,
  });

  it("resolves a layer inside a Group to its layer, track and composition", () => {
    useProjectStore.getState().apply(
      summaryFixture({
        root: { tracks: [track("t-root", [color("root-a")])] },
        groups: [compositionFixture({ id: "comp-g1", tracks: [track("t-g1", [color("inner-a")])] })],
      }),
    );
    const s = useProjectStore.getState();
    expect(s.layerById.get("inner-a")?.id).toBe("inner-a");
    expect(s.trackIdByLayerId.get("inner-a")).toBe("t-g1");
    expect(s.compositionIdByLayerId.get("inner-a")).toBe("comp-g1");
    expect(s.compositionIdByLayerId.get("root-a")).toBe(ROOT_ID);
    expect(s.compositionIdByTrackId.get("t-g1")).toBe("comp-g1");
    expect(s.compositionIdByTrackId.get("t-root")).toBe(ROOT_ID);
    useProjectStore.getState().apply(null);
    expect(useProjectStore.getState().compositionIdByLayerId.size).toBe(0);
  });
});
