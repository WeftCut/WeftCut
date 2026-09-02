// The Shots Panel's store, with the shot channels mocked.
//
// The load-bearing assertion in this file is the first one: selecting a clip
// must issue NO `analyze_shots_floor` call. A floor scan is a whole-source
// decode, and clicking clips is the highest-frequency gesture in the app — so
// a regression there is minutes of ffmpeg on a gesture that should cost a
// `stat`.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEntryInput, ShotReport } from "../ipc";

const mocks = vi.hoisted(() => ({
  shotFloorReportCached: vi.fn<(id: string) => Promise<boolean>>(),
  analyzeShotsFloor: vi.fn<(id: string) => Promise<ShotReport>>(),
  reduceShotReport: vi.fn(),
  shotDefaultOpts: vi.fn(),
  shotFloorSensitivity: vi.fn(),
  logEmit: vi.fn<(input: LogEntryInput) => Promise<void>>(),
}));

vi.mock("../ipc", () => ({
  shotFloorReportCached: (id: string) => mocks.shotFloorReportCached(id),
  analyzeShotsFloor: (id: string) => mocks.analyzeShotsFloor(id),
  reduceShotReport: (...args: unknown[]) => mocks.reduceShotReport(...args),
  shotDefaultOpts: () => mocks.shotDefaultOpts(),
  shotFloorSensitivity: () => mocks.shotFloorSensitivity(),
  logEmit: (input: LogEntryInput) => mocks.logEmit(input),
}));

import {
  analyzeShotSubject,
  invalidateShotSource,
  loadShotDefaults,
  resetShotsStore,
  setCandidateAccepted,
  setRowKept,
  setShotSubject,
  useShotsStore,
  type ShotSubject,
} from "./shotsStore";

function report(cuts: number[]): ShotReport {
  return {
    shots: [{ index: 0, t_start_us: 0, t_end_us: 6_000_000, keyframe_t_us: 3_000_000, flags: [] }],
    cut_scores: cuts.map((t_us) => ({ t_us, score: 0.9 })),
  };
}

function subject(mediaId: string, layerId = `layer-${mediaId}`): ShotSubject {
  return { layerId, mediaId, srcInUs: 0, srcOutUs: 6_000_000 };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/// Enough microtask turns for a probe-then-fetch-then-reduce chain to settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  mocks.shotDefaultOpts.mockResolvedValue({ sensitivity: 0.4, min_shot_us: 500_000 });
  mocks.shotFloorSensitivity.mockResolvedValue(0.05);
  mocks.reduceShotReport.mockImplementation((r: ShotReport) => Promise.resolve(r));
  mocks.logEmit.mockResolvedValue(undefined);
  resetShotsStore();
});

describe("selection never scans", () => {
  it("issues the probe and NO scan when a source has no cached report", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(false);
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();

    expect(mocks.shotFloorReportCached).toHaveBeenCalledWith("m1");
    // The whole point of the probe. A scan here would be minutes of ffmpeg on a
    // click.
    expect(mocks.analyzeShotsFloor).not.toHaveBeenCalled();
    expect(useShotsStore.getState().cached).toBe(false);
    expect(useShotsStore.getState().reduced).toBeNull();
  });

  it("fetches and reduces when the probe finds one", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(true);
    mocks.analyzeShotsFloor.mockResolvedValue(report([2_000_000]));
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();

    expect(mocks.analyzeShotsFloor).toHaveBeenCalledTimes(1);
    expect(useShotsStore.getState().cached).toBe(true);
    expect(useShotsStore.getState().reduced?.cut_scores).toHaveLength(1);
    expect(mocks.reduceShotReport).toHaveBeenCalledWith(expect.anything(), {
      sensitivity: 0.4,
      minShotUs: 500_000,
      inUs: 0,
      outUs: 6_000_000,
    });
  });

  it("re-selecting a clip costs one probe and no second fetch", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(true);
    mocks.analyzeShotsFloor.mockResolvedValue(report([2_000_000]));
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();
    setShotSubject(null);
    await settle();
    setShotSubject(subject("m1"));
    await settle();

    expect(mocks.shotFloorReportCached).toHaveBeenCalledTimes(2);
    // The report is held per media id, so coming back to the clip is instant.
    expect(mocks.analyzeShotsFloor).toHaveBeenCalledTimes(1);
  });

  it("re-binding the same subject issues nothing at all", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(true);
    mocks.analyzeShotsFloor.mockResolvedValue(report([]));
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();
    setShotSubject(subject("m1"));
    await settle();

    // The Panel restates its subject on every summary tick; an idempotent bind
    // is what keeps a keystroke elsewhere in the app from re-probing.
    expect(mocks.shotFloorReportCached).toHaveBeenCalledTimes(1);
  });
});

describe("a late answer for a previous subject", () => {
  it("is dropped rather than shown against the new clip", async () => {
    const first = deferred<boolean>();
    mocks.shotFloorReportCached.mockImplementation((id) =>
      id === "m1" ? first.promise : Promise.resolve(false),
    );
    mocks.analyzeShotsFloor.mockResolvedValue(report([2_000_000, 4_000_000]));
    await loadShotDefaults();

    setShotSubject(subject("m1"));
    setShotSubject(subject("m2"));
    await settle();
    expect(useShotsStore.getState().cached).toBe(false);

    // m1's probe now answers "yes" — for a clip nobody is looking at.
    first.resolve(true);
    await settle();
    expect(useShotsStore.getState().subject?.mediaId).toBe("m2");
    expect(useShotsStore.getState().cached).toBe(false);
    expect(useShotsStore.getState().reduced).toBeNull();
  });
});

describe("Analyze", () => {
  it("pairs Started and Ok under one op_id and carries the candidate count", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(false);
    mocks.analyzeShotsFloor.mockResolvedValue(report([2_000_000, 4_000_000]));
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();

    await analyzeShotSubject("clip.mp4");
    await settle();

    const rows = mocks.logEmit.mock.calls.map(([entry]) => entry);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.shots_analyze_started",
      i18n_args: { clip: "clip.mp4" },
      op_state: { state: "Started" },
      source: { kind: "User" },
      category: { kind: "Project" },
    });
    expect(rows[1]).toMatchObject({
      i18n_key: "log.shots_analyze_done",
      i18n_args: { clip: "clip.mp4", candidates: 2 },
      op_state: { state: "Ok" },
    });
    expect(rows[0]?.op_id).toBe(rows[1]?.op_id);
    expect(useShotsStore.getState().cached).toBe(true);
    expect(useShotsStore.getState().analyzing).toBeNull();
  });

  it("clears the running flag on failure and keeps the tool's own sentence", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(false);
    mocks.analyzeShotsFloor.mockRejectedValue(
      new Error("shot cuts: source has no probed duration — re-import it"),
    );
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();

    await analyzeShotSubject("clip.mp4");
    await settle();

    expect(useShotsStore.getState().analyzing).toBeNull();
    // The re-import instruction is the only actionable half of the failure, so
    // it reaches the inline slot verbatim.
    expect(useShotsStore.getState().error).toContain("re-import it");
    const rows = mocks.logEmit.mock.calls.map(([entry]) => entry);
    // The op is TERMINATED, not left open: an unterminated one keeps the status
    // bar's running badge spinning for the rest of the session.
    expect(rows[1]).toMatchObject({ op_state: { state: "Err" }, level: "error" });
    expect(rows[0]?.op_id).toBe(rows[1]?.op_id);
  });

  it("is a no-op while one is already running", async () => {
    const scan = deferred<ShotReport>();
    mocks.shotFloorReportCached.mockResolvedValue(false);
    mocks.analyzeShotsFloor.mockReturnValue(scan.promise);
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();

    void analyzeShotSubject("clip.mp4");
    await settle();
    await analyzeShotSubject("clip.mp4");
    await settle();

    // Two would bill two whole-source decodes and race their reports onto one
    // subject.
    expect(mocks.analyzeShotsFloor).toHaveBeenCalledTimes(1);
    expect(mocks.logEmit).toHaveBeenCalledTimes(1);
    scan.resolve(report([]));
    await settle();
  });
});

describe("invalidateShotSource", () => {
  it("re-probes the open subject so the pool's warmer reaches the Panel", async () => {
    mocks.shotFloorReportCached.mockResolvedValueOnce(false);
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();
    expect(useShotsStore.getState().cached).toBe(false);

    // The pool's "Analyze shots" has just written the report this Panel said
    // was missing.
    mocks.shotFloorReportCached.mockResolvedValue(true);
    mocks.analyzeShotsFloor.mockResolvedValue(report([2_000_000]));
    invalidateShotSource("m1");
    await settle();

    expect(useShotsStore.getState().cached).toBe(true);
    expect(useShotsStore.getState().reduced?.cut_scores).toHaveLength(1);
  });

  it("forgets a report for a source nobody is looking at, without probing", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(true);
    mocks.analyzeShotsFloor.mockResolvedValue(report([2_000_000]));
    await loadShotDefaults();
    setShotSubject(subject("m1"));
    await settle();
    mocks.shotFloorReportCached.mockClear();

    invalidateShotSource("m2");
    await settle();
    expect(mocks.shotFloorReportCached).not.toHaveBeenCalled();
    expect(useShotsStore.getState().reports.has("m1")).toBe(true);
  });
});

describe("the reviewer's two decisions", () => {
  it("holds vetoes and discards per media id", () => {
    setCandidateAccepted("m1", 2_000_000, false);
    setRowKept("m1", 0, false);
    setCandidateAccepted("m2", 4_000_000, false);

    const s = useShotsStore.getState();
    expect([...(s.vetoed.get("m1") ?? [])]).toEqual([2_000_000]);
    expect([...(s.discarded.get("m1") ?? [])]).toEqual([0]);
    expect([...(s.vetoed.get("m2") ?? [])]).toEqual([4_000_000]);

    // Re-accepting is what makes a merge reversible.
    setCandidateAccepted("m1", 2_000_000, true);
    expect([...(useShotsStore.getState().vetoed.get("m1") ?? [])]).toEqual([]);
  });

  it("reduces only once the detection defaults are known", async () => {
    mocks.shotFloorReportCached.mockResolvedValue(true);
    mocks.analyzeShotsFloor.mockResolvedValue(report([2_000_000]));
    setShotSubject(subject("m1"));
    await settle();
    // No defaults read yet, so there is nothing to reduce at.
    expect(mocks.reduceShotReport).not.toHaveBeenCalled();

    await loadShotDefaults();
    await settle();
    expect(mocks.reduceShotReport).toHaveBeenCalledTimes(1);
  });
});
