// The three apply verbs: the exact wire shape each one sends, which of them a
// reviewed list can run at all, and what the store looks like afterwards.
//
// `apply_shot_cuts` is mocked — the channel has its own tests, and what is at
// risk here is the translation from rows a person ticked into the two arguments
// it consumes: the canonical cut list, and the segment indices a discard names.
//
// Rows are built by the real `shotRows`, not hand-written, because the claim
// under test is that row `i` IS segment `i`. A hand-made row could assert that
// mapping into existence.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnimTrack,
  ApplyShotCutsResult,
  LayerSummary,
  LogEntryInput,
  ProjectSettingsPatch,
  ProjectSettingsView,
  Shot,
  ShotReport,
} from "../ipc";

const mocks = vi.hoisted(() => ({
  applyShotCuts: vi.fn<(args: unknown) => Promise<ApplyShotCutsResult>>(),
  shotFloorReportCached: vi.fn<(id: string) => Promise<boolean>>(),
  analyzeShotsFloor: vi.fn(),
  reduceShotReport: vi.fn(),
  shotDefaultOpts: vi.fn(),
  shotFloorSensitivity: vi.fn(),
  getProjectSettings: vi.fn<() => Promise<ProjectSettingsView>>(),
  updateProjectSettings: vi.fn<(patch: ProjectSettingsPatch) => Promise<void>>(),
  logEmit: vi.fn<(input: LogEntryInput) => Promise<void>>(),
}));

vi.mock("../ipc", () => ({
  applyShotCuts: (args: unknown) => mocks.applyShotCuts(args),
  shotFloorReportCached: (id: string) => mocks.shotFloorReportCached(id),
  analyzeShotsFloor: (id: string) => mocks.analyzeShotsFloor(id),
  reduceShotReport: (...args: unknown[]) => mocks.reduceShotReport(...args),
  shotDefaultOpts: () => mocks.shotDefaultOpts(),
  shotFloorSensitivity: () => mocks.shotFloorSensitivity(),
  getProjectSettings: () => mocks.getProjectSettings(),
  updateProjectSettings: (patch: ProjectSettingsPatch) =>
    mocks.updateProjectSettings(patch),
  logEmit: (input: LogEntryInput) => mocks.logEmit(input),
}));

import { shotRows, type ShotRow } from "./shotRows";
import {
  applyShotVerb,
  setCandidateAccepted,
  setRowKept,
  setShotSubject,
  shotApplyBlocker,
  resetShotsStore,
  useShotsStore,
} from "./shotsStore";

const FPS = { num: 30, den: 1 };
const NONE: ReadonlySet<number> = new Set<number>();
const MEDIA_ID = "media-1";
const LAYER_ID = "layer-1";

function shot(tStartUs: number, tEndUs: number, index: number): Shot {
  return {
    index,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    keyframe_t_us: tStartUs + Math.floor((tEndUs - tStartUs) / 2),
    flags: [],
  };
}

/// Three shots over a 6 s source, opening on candidates at 2 s and 4 s — the
/// synthetic colour concat the spec measured, so the two scores straddle a
/// usable threshold.
const REPORT: ShotReport = {
  shots: [
    shot(0, 2_000_000, 0),
    shot(2_000_000, 4_000_000, 1),
    shot(4_000_000, 6_000_000, 2),
  ],
  cut_scores: [
    { t_us: 2_000_000, score: 1.0 },
    { t_us: 4_000_000, score: 0.52 },
  ],
};

/// The whole source on a clip that starts one second in, so a source time is
/// never accidentally equal to the timeline time it maps to.
function layer(): LayerSummary {
  const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });
  return {
    id: LAYER_ID,
    label: null,
    t_start_us: 1_000_000,
    t_end_us: 7_000_000,
    kind: "VideoClip",
    color_hint: "#334455",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: MEDIA_ID,
      media_label: "clip.mp4",
      src_in_us: 0,
      src_out_us: 6_000_000,
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      opacity: num(1),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      speed: 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
  };
}

/// The rows the Panel would be showing, given the reviewer's two decision sets.
function rowsWith(
  vetoedSrcUs: ReadonlySet<number> = NONE,
  discardedSrcStartUs: ReadonlySet<number> = NONE,
): ShotRow[] {
  return shotRows(REPORT, layer(), FPS, vetoedSrcUs, discardedSrcStartUs);
}

/// Enough microtask turns for one apply's await chain to settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function logRows(): LogEntryInput[] {
  return mocks.logEmit.mock.calls.map(([entry]) => entry);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.logEmit.mockResolvedValue(undefined);
  // False, so binding the subject costs one probe and starts no fetch: this
  // file's rows come in as an argument, not out of a reduce.
  mocks.shotFloorReportCached.mockResolvedValue(false);
  resetShotsStore();
  setShotSubject({
    layerId: LAYER_ID,
    mediaId: MEDIA_ID,
    srcInUs: 0,
    srcOutUs: 6_000_000,
  });
});

describe("the wire shape of each verb", () => {
  it("splits at every accepted boundary and names no segments", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "split",
      layer_ids: ["seg-a", "seg-b", "seg-c"],
    });

    await applyShotVerb("split", rowsWith(), "clip.mp4");
    await settle();

    expect(mocks.applyShotCuts).toHaveBeenCalledWith({
      layer_id: LAYER_ID,
      mode: "split",
      cuts_src_us: [2_000_000, 4_000_000],
    });
    // No `discard_segments` at all: the channel reads it in no other mode, and
    // an argument the answer never mentions would only invite a reader to think
    // a split can delete.
    expect(mocks.applyShotCuts.mock.calls[0]?.[0]).not.toHaveProperty(
      "discard_segments",
    );
  });

  it("marks the same list a split would cut at", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "mark",
      marker_ids: ["m1", "m2"],
    });

    await applyShotVerb("mark", rowsWith(), "clip.mp4");
    await settle();

    // Identical boundaries, one canonical list: the acceptance condition the
    // slice exists to hold.
    expect(mocks.applyShotCuts).toHaveBeenCalledWith({
      layer_id: LAYER_ID,
      mode: "mark",
      cuts_src_us: [2_000_000, 4_000_000],
    });
  });

  it("discards the unchecked rows by their own index", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "discard",
      layer_ids: ["seg-a", "seg-c"],
    });
    setRowKept(MEDIA_ID, 2_000_000, false);

    const rows = rowsWith(NONE, new Set([2_000_000]));
    await applyShotVerb("discard", rows, "clip.mp4");
    await settle();

    expect(mocks.applyShotCuts).toHaveBeenCalledWith({
      layer_id: LAYER_ID,
      mode: "discard",
      // The cut list is unfiltered: a discard cuts at every accepted boundary
      // and only then deletes what it named.
      cuts_src_us: [2_000_000, 4_000_000],
      discard_segments: [1],
    });
  });

  it("sends the list a veto shortened, with the rows renumbered around it", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "discard",
      layer_ids: ["seg-a"],
    });
    // Clearing the 4 s candidate merges shot 3 into shot 2, so the surviving
    // second row spans 2–6 s and is index 1 — the segment a split at the one
    // remaining boundary produces.
    const rows = rowsWith(new Set([4_000_000]), new Set([2_000_000]));
    expect(rows).toHaveLength(2);

    await applyShotVerb("discard", rows, "clip.mp4");
    await settle();

    expect(mocks.applyShotCuts).toHaveBeenCalledWith({
      layer_id: LAYER_ID,
      mode: "discard",
      cuts_src_us: [2_000_000],
      discard_segments: [1],
    });
  });
});

describe("the status rows", () => {
  it("pairs a split's Started and Ok under one op_id, with both counts", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "split",
      layer_ids: ["seg-a", "seg-b", "seg-c"],
    });

    await applyShotVerb("split", rowsWith(), "clip.mp4");
    await settle();

    const rows = logRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      i18n_key: "log.shots_apply_split_started",
      i18n_args: { clip: "clip.mp4", cuts: 2 },
      op_state: { state: "Started" },
      category: { kind: "Project" },
      source: { kind: "User" },
    });
    expect(rows[1]).toMatchObject({
      i18n_key: "log.shots_apply_split_done",
      i18n_args: { clip: "clip.mp4", segments: 3 },
      op_state: { state: "Ok" },
    });
    expect(rows[0]?.op_id).toBe(rows[1]?.op_id);
  });

  it("counts markers, not segments, for a mark", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "mark",
      marker_ids: ["m1", "m2"],
    });

    await applyShotVerb("mark", rowsWith(), "clip.mp4");
    await settle();

    expect(logRows()[1]).toMatchObject({
      i18n_key: "log.shots_apply_mark_done",
      i18n_args: { clip: "clip.mp4", markers: 2 },
    });
  });

  it("names the survivors and the discarded count for a discard", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "discard",
      layer_ids: ["seg-a", "seg-c"],
    });

    await applyShotVerb(
      "discard",
      rowsWith(NONE, new Set([2_000_000])),
      "clip.mp4",
    );
    await settle();

    const rows = logRows();
    expect(rows[0]).toMatchObject({
      i18n_key: "log.shots_apply_discard_started",
      i18n_args: { clip: "clip.mp4", cuts: 2, discarded: 1 },
    });
    // Survivors are what the channel answers with; the discarded count is only
    // knowable from what was asked for, which is why the row carries both.
    expect(rows[1]).toMatchObject({
      i18n_key: "log.shots_apply_discard_done",
      i18n_args: { clip: "clip.mp4", segments: 2, discarded: 1 },
    });
  });

  it("terminates the op on a refusal and puts its sentence in the inline slot", async () => {
    mocks.applyShotCuts.mockRejectedValue(
      new Error(
        JSON.stringify({
          error: "InvalidArgument",
          field: "discard_segments",
          detail:
            "discard_segments names all 3 segment(s) — discarding every segment is a delete, not an apply",
        }),
      ),
    );

    await applyShotVerb("discard", rowsWith(), "clip.mp4");
    await settle();

    // The channel's own rule, verbatim: it is the only statement of it, and the
    // Panel deliberately holds no second copy to pre-empt the press with.
    expect(useShotsStore.getState().error).toContain("is a delete, not an apply");
    expect(useShotsStore.getState().applying).toBeNull();
    const rows = logRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      op_state: { state: "Err" },
      level: "error",
      details: { context: "apply_shot_cuts" },
    });
    // An unterminated op keeps the status bar's running badge spinning for the
    // rest of the session.
    expect(rows[0]?.op_id).toBe(rows[1]?.op_id);
  });

  it("falls back to its own sentence when the throw is not a structured refusal", async () => {
    mocks.applyShotCuts.mockRejectedValue(new Error("the track is on fire"));

    await applyShotVerb("split", rowsWith(), "clip.mp4");
    await settle();

    expect(logRows()[1]).toMatchObject({
      i18n_key: "log.shots_apply_failed",
      op_state: { state: "Err" },
    });
  });
});

describe("what the store holds afterwards", () => {
  it("drops the review a split consumed", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "split",
      layer_ids: ["seg-a", "seg-b", "seg-c"],
    });
    setCandidateAccepted(MEDIA_ID, 4_000_000, false);
    setRowKept(MEDIA_ID, 2_000_000, false);

    await applyShotVerb("split", rowsWith(), "clip.mp4");
    await settle();

    // The decisions are keyed by a span's SOURCE start, and the second segment
    // begins at exactly the boundary that was just cut — so a surviving
    // decision would come up as a fresh clip's first row already unchecked.
    expect(useShotsStore.getState().vetoed.get(MEDIA_ID)).toBeUndefined();
    expect(useShotsStore.getState().discarded.get(MEDIA_ID)).toBeUndefined();
    // The subject is left to the selection: `project:changed` drops the
    // vanished layer id, which is the path every other mutation takes.
    expect(useShotsStore.getState().subject?.layerId).toBe(LAYER_ID);
  });

  it("drops them for a discard too", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "discard",
      layer_ids: ["seg-a"],
    });
    setRowKept(MEDIA_ID, 2_000_000, false);

    await applyShotVerb(
      "discard",
      rowsWith(NONE, new Set([2_000_000])),
      "clip.mp4",
    );
    await settle();

    expect(useShotsStore.getState().discarded.get(MEDIA_ID)).toBeUndefined();
  });

  it("keeps the review after a mark — the clip is still there", async () => {
    mocks.applyShotCuts.mockResolvedValue({
      mode: "mark",
      marker_ids: ["m1", "m2"],
    });
    setRowKept(MEDIA_ID, 2_000_000, false);

    await applyShotVerb("mark", rowsWith(), "clip.mp4");
    await settle();

    expect(useShotsStore.getState().subject?.layerId).toBe(LAYER_ID);
    expect(useShotsStore.getState().discarded.get(MEDIA_ID)?.has(2_000_000)).toBe(
      true,
    );
  });

  it("refuses a second apply while one is in flight", async () => {
    const first = deferred<ApplyShotCutsResult>();
    mocks.applyShotCuts.mockReturnValue(first.promise);

    void applyShotVerb("split", rowsWith(), "clip.mp4");
    await settle();
    expect(useShotsStore.getState().applying).toBe("split");

    await applyShotVerb("mark", rowsWith(), "clip.mp4");
    await settle();

    // One commit, and one Started row: a second press mid-commit would send the
    // row indices of a list the first press is already consuming.
    expect(mocks.applyShotCuts).toHaveBeenCalledTimes(1);
    expect(logRows()).toHaveLength(1);

    first.resolve({ mode: "split", layer_ids: ["seg-a"] });
    await settle();
    expect(useShotsStore.getState().applying).toBeNull();
  });

  it("sends nothing at all with no subject bound", async () => {
    setShotSubject(null);

    await applyShotVerb("split", rowsWith(), "clip.mp4");
    await settle();

    expect(mocks.applyShotCuts).not.toHaveBeenCalled();
    expect(mocks.logEmit).not.toHaveBeenCalled();
  });
});

describe("which verbs a reviewed list can run", () => {
  it("offers all three over a list with a boundary and something unchecked", () => {
    const rows = rowsWith(NONE, new Set([2_000_000]));
    expect(shotApplyBlocker("split", rows, null)).toBeNull();
    expect(shotApplyBlocker("mark", rows, null)).toBeNull();
    expect(shotApplyBlocker("discard", rows, null)).toBeNull();
  });

  it("greys the discard until something is unchecked", () => {
    expect(shotApplyBlocker("discard", rowsWith(), null)).toBe(
      "shots_panel.apply_no_discards",
    );
  });

  it("greys both cutting verbs when every boundary is cleared", () => {
    // Both candidates vetoed collapses the list to one row, which has no
    // opening candidate — so there is no boundary left to cut at or mark, and
    // the channel would answer with the unchanged layer id.
    const rows = rowsWith(new Set([2_000_000, 4_000_000]));
    expect(rows).toHaveLength(1);
    expect(shotApplyBlocker("split", rows, null)).toBe(
      "shots_panel.apply_no_cuts",
    );
    expect(shotApplyBlocker("mark", rows, null)).toBe("shots_panel.apply_no_cuts");
  });

  it("does NOT pre-empt an all-unchecked discard", () => {
    // The channel refuses that one ("discarding every segment is a delete"),
    // and a second copy of the rule here would be free to drift from it. So the
    // press goes out and its refusal is what the reviewer reads.
    const every = new Set([0, 2_000_000, 4_000_000]);
    const rows = rowsWith(NONE, every);
    expect(rows.every((r) => !r.keep)).toBe(true);
    expect(shotApplyBlocker("discard", rows, null)).toBeNull();
  });

  it("greys everything while an apply runs", () => {
    const rows = rowsWith(NONE, new Set([2_000_000]));
    for (const verb of ["split", "mark", "discard"] as const) {
      expect(shotApplyBlocker(verb, rows, "split")).toBe(
        "shots_panel.apply_running",
      );
    }
  });
});
