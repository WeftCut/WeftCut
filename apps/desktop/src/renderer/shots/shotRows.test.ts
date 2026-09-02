// The row view model, with no DOM and no IPC.
//
// The fixture reports here are not invented shapes: every expectation about
// what `reduce` yields was taken from the real `Backend.reduce_shot_report`
// over this exact report, so the "veto equals a threshold that excludes the
// candidate" test compares two derivations of the same measured answer.
//
// The addon itself is NOT loaded here. `reduceShotReport` is an instance method
// on `Backend`, whose constructor spins a tokio runtime with no shutdown entry
// point — a vitest worker that constructed one would never exit. So the Rust
// side's answers are pinned as literals below and the veto path is asserted
// against them.

import { describe, expect, it } from "vitest";

import type { AnimTrack, LayerSummary, Shot, ShotReport } from "../ipc";
import { acceptedCutsSrcUs, discardedSpans, shotRows } from "./shotRows";

const FPS = { num: 30, den: 1 };
const NONE: ReadonlySet<number> = new Set<number>();

function shot(
  tStartUs: number,
  tEndUs: number,
  extra: Partial<Shot> = {},
): Shot {
  return {
    index: 0,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    keyframe_t_us: tStartUs + Math.floor((tEndUs - tStartUs) / 2),
    flags: [],
    ...extra,
  };
}

/// The floor scan's own three-shot answer on the synthetic colour concat the
/// spec measured: candidates at 2 s (1.000) and 4 s (0.520), stats on every
/// span the scan actually sampled.
const MEASURED: ShotReport = {
  shots: [
    shot(0, 2_000_000, {
      brightness: 0.12,
      motion: 0.9,
      sharpness: 0.004,
      flags: ["black"],
    }),
    shot(2_000_000, 4_000_000, {
      index: 1,
      brightness: 0.61,
      motion: 0.2,
      sharpness: 0.02,
    }),
    shot(4_000_000, 6_000_000, {
      index: 2,
      brightness: 0.44,
      motion: 0.1,
      sharpness: 0.03,
      flags: ["freeze"],
    }),
  ],
  cut_scores: [
    { t_us: 2_000_000, score: 1.0 },
    { t_us: 4_000_000, score: 0.52 },
  ],
};

/// The SAME report reduced at a threshold that excludes the 0.520 candidate —
/// verbatim what Rust answers for `reduce(report, 0.7, 100_000, 0, 6_000_000)`.
/// Note the merged span's absent stats and empty flags: that is the reduce's own
/// rule for a span it never measured.
const MERGED_BY_THRESHOLD: ShotReport = {
  shots: [
    shot(0, 2_000_000, {
      brightness: 0.12,
      motion: 0.9,
      sharpness: 0.004,
      flags: ["black"],
    }),
    shot(2_000_000, 6_000_000, { index: 1 }),
  ],
  cut_scores: [{ t_us: 2_000_000, score: 1.0 }],
};

/// A clip carrying the whole source, starting one second into its composition —
/// so a timeline time is never accidentally equal to its source time.
function layerAt(
  tStartUs: number,
  srcInUs: number,
  srcOutUs: number,
): LayerSummary {
  const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });
  return {
    id: "layer-1",
    label: null,
    t_start_us: tStartUs,
    t_end_us: tStartUs + (srcOutUs - srcInUs),
    kind: "VideoClip",
    color_hint: "#334455",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "VideoClip",
      media_id: "media-1",
      media_label: "clip.mp4",
      src_in_us: srcInUs,
      src_out_us: srcOutUs,
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

describe("shotRows", () => {
  it("projects each span into the layer's own composition without snapping", () => {
    const rows = shotRows(MEASURED, layerAt(1_000_000, 0, 6_000_000), FPS, NONE, NONE);
    expect(rows.map((r) => [r.srcStartUs, r.srcEndUs])).toEqual([
      [0, 2_000_000],
      [2_000_000, 4_000_000],
      [4_000_000, 6_000_000],
    ]);
    // `t_start_us + (src - src_in_us)` — the same mapping `cutsToTimeline` uses
    // before it snaps.
    expect(rows.map((r) => [r.tStartUs, r.tEndUs])).toEqual([
      [1_000_000, 3_000_000],
      [3_000_000, 5_000_000],
      [5_000_000, 7_000_000],
    ]);
    expect(rows.map((r) => r.durationUs)).toEqual([
      2_000_000, 2_000_000, 2_000_000,
    ]);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rows.every((r) => r.keep)).toBe(true);
  });

  it("maps against the layer's OWN window, not the source's origin", () => {
    // A trimmed clip inside a Group: the source window opens at 1 s and the clip
    // sits at 10 s, so nothing lines up by accident.
    const trimmed: ShotReport = {
      shots: [shot(1_000_000, 2_000_000), shot(2_000_000, 5_000_000, { index: 1 })],
      cut_scores: [{ t_us: 2_000_000, score: 1.0 }],
    };
    const rows = shotRows(
      trimmed,
      layerAt(10_000_000, 1_000_000, 5_000_000),
      FPS,
      NONE,
      NONE,
    );
    expect(rows.map((r) => r.tStartUs)).toEqual([10_000_000, 11_000_000]);
    expect(rows.map((r) => r.tEndUs)).toEqual([11_000_000, 14_000_000]);
  });

  it("gives the first row no opening candidate and every other row one", () => {
    const rows = shotRows(MEASURED, layerAt(0, 0, 6_000_000), FPS, NONE, NONE);
    // The window edge is a hard boundary in `build_shots`, so there is nothing
    // to weigh and no score control to draw.
    expect(rows[0]?.openingCandidate).toBeNull();
    expect(rows[1]?.openingCandidate).toEqual({
      srcUs: 2_000_000,
      score: 1.0,
      // One nominal 30 fps frame earlier — the outgoing half of the pair.
      beforeSrcUs: 2_000_000 - 33_333,
    });
    expect(rows[2]?.openingCandidate?.score).toBe(0.52);
  });

  it("clamps a frame-pair's earlier time at source zero", () => {
    const early: ShotReport = {
      shots: [shot(0, 10_000), shot(10_000, 6_000_000, { index: 1 })],
      cut_scores: [{ t_us: 10_000, score: 0.9 }],
    };
    const rows = shotRows(early, layerAt(0, 0, 6_000_000), FPS, NONE, NONE);
    expect(rows[1]?.openingCandidate?.beforeSrcUs).toBe(0);
  });

  it("keeps absent stats absent rather than reading them as zero", () => {
    const rows = shotRows(
      MERGED_BY_THRESHOLD,
      layerAt(0, 0, 6_000_000),
      FPS,
      NONE,
      NONE,
    );
    expect(rows[0]?.stats).toEqual({
      brightness: 0.12,
      motion: 0.9,
      sharpness: 0.004,
    });
    // The span the reduce assembled itself: unmeasured, so `null` and never a
    // triple of zeroes.
    expect(rows[1]?.stats).toBeNull();
  });

  it("treats a partially-sampled shot as unmeasured", () => {
    const partial: ShotReport = {
      shots: [shot(0, 6_000_000, { brightness: 0.4 })],
      cut_scores: [],
    };
    const rows = shotRows(partial, layerAt(0, 0, 6_000_000), FPS, NONE, NONE);
    // A scan fills all three or none; half a triple is not a measurement to
    // render two thirds of.
    expect(rows[0]?.stats).toBeNull();
  });
});

describe("shotRows — vetoing an opening candidate", () => {
  const layer = layerAt(0, 0, 6_000_000);
  const vetoed: ReadonlySet<number> = new Set([4_000_000]);

  it("produces exactly the span the reduce produces at a threshold that excludes it", () => {
    const merged = shotRows(MEASURED, layer, FPS, vetoed, NONE);
    const reduced = shotRows(MERGED_BY_THRESHOLD, layer, FPS, NONE, NONE);
    // The SPAN is the contract both paths owe — a marker and a split have to
    // land on the same frame whichever way the boundary was dropped.
    expect(merged.map((r) => [r.srcStartUs, r.srcEndUs])).toEqual(
      reduced.map((r) => [r.srcStartUs, r.srcEndUs]),
    );
    expect(merged.map((r) => [r.tStartUs, r.tEndUs])).toEqual(
      reduced.map((r) => [r.tStartUs, r.tEndUs]),
    );
    // And the cover frame agrees too: the reduce picks the midpoint of a span it
    // did not measure, and so does the merge.
    expect(merged.map((r) => r.keyframeTUs)).toEqual(
      reduced.map((r) => r.keyframeTUs),
    );
  });

  it("drops the merged span's stats and flags, as the reduce does for a span it never measured", () => {
    const merged = shotRows(MEASURED, layer, FPS, vetoed, NONE);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.stats).toBeNull();
    // Not the union of the parts' flags, even though a flag is existential: the
    // row must not say more about a span than `reduce` says about the same one,
    // or a later measurement of the merged span would be overwriting a guess.
    expect(merged[1]?.flags).toEqual([]);
    expect(merged[1]?.flags).toEqual(
      shotRows(MERGED_BY_THRESHOLD, layer, FPS, NONE, NONE)[1]?.flags,
    );
  });

  it("keeps the vetoed boundary on the row it merged into, so the merge undoes", () => {
    const merged = shotRows(MEASURED, layer, FPS, vetoed, NONE);
    // Without this a cleared checkbox would be a one-way door: the control that
    // set it disappears with the row it collapsed.
    expect(merged[1]?.mergedCandidates.map((c) => c.srcUs)).toEqual([4_000_000]);
    expect(merged[1]?.mergedCandidates[0]?.score).toBe(0.52);
  });

  it("ignores a veto naming the window edge", () => {
    // Row 0 renders no candidate control, so it cannot be vetoed through the UI
    // — a set that names its time anyway is stale, not an instruction.
    const rows = shotRows(MEASURED, layer, FPS, new Set([0]), NONE);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.srcStartUs).toBe(0);
  });

  it("merges a run of consecutive vetoes into one span", () => {
    const rows = shotRows(
      MEASURED,
      layer,
      FPS,
      new Set([2_000_000, 4_000_000]),
      NONE,
    );
    expect(rows).toHaveLength(1);
    expect([rows[0]?.srcStartUs, rows[0]?.srcEndUs]).toEqual([0, 6_000_000]);
    expect(rows[0]?.openingCandidate).toBeNull();
    expect(rows[0]?.mergedCandidates.map((c) => c.srcUs)).toEqual([
      2_000_000, 4_000_000,
    ]);
  });
});

describe("shotRows — keep and the apply derivations", () => {
  const layer = layerAt(0, 0, 6_000_000);

  it("marks only the rows the reviewer unchecked", () => {
    const rows = shotRows(MEASURED, layer, FPS, NONE, new Set([2_000_000]));
    expect(rows.map((r) => r.keep)).toEqual([true, false, true]);
    expect(discardedSpans(rows)).toEqual([
      { srcStartUs: 2_000_000, srcEndUs: 4_000_000 },
    ]);
  });

  it("offers every surviving boundary as a cut, and never the window edge", () => {
    expect(acceptedCutsSrcUs(shotRows(MEASURED, layer, FPS, NONE, NONE))).toEqual([
      2_000_000, 4_000_000,
    ]);
    expect(
      acceptedCutsSrcUs(shotRows(MEASURED, layer, FPS, new Set([4_000_000]), NONE)),
    ).toEqual([2_000_000]);
  });

  it("discards nothing by default", () => {
    expect(discardedSpans(shotRows(MEASURED, layer, FPS, NONE, NONE))).toEqual([]);
  });
});
