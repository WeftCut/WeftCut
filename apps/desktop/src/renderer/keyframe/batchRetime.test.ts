import { describe, expect, it } from "vitest";

import {
  retimeGroupsOf,
  scaleSelection,
  selectionExtent,
  translateSelection,
  type Grid,
  type RetimeGroup,
} from "./batchRetime";
import type { AnimTrack, Keyframe, LayerSummary, Rgba, TrackSummary } from "../ipc";
import type { ParamTrackEntry } from "../timeline/keyframeBatch";

type KeyframedTrack = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

const GRID: Grid = { num: 30, den: 1 };
/// One 30 fps frame, and the canonical µs of frame `n`. Written out rather than
/// imported from the grid so a test states the number it means.
///
/// The canonical times are NOT additive — `frames(20) − frames(1)` is a
/// microsecond off `frames(19)` — so an expectation about a translated key says
/// `frames(a) − frames(b)`, never a third frame index. The lattice is settled
/// by the actor's write-time snap, not here.
const F = 33_333;
const frames = (n: number) => Math.round((n * 1_000_000) / 30);

const kf = (id: string, tUs: number, value = 1): Keyframe<number> => ({
  id,
  t_us: tUs,
  value,
  in: { x: 2 / 3, y: 2 / 3, mode: "Free" },
  out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
  continuity: "Broken",
  segment: { kind: "Linear" },
});

const keyed = (keys: Keyframe<number>[]): KeyframedTrack => ({
  mode: "Keyframed",
  extrapolate: { before: "Hold", after: "Hold" },
  value: keys,
});

function group(over: Partial<RetimeGroup> & { track: RetimeGroup["track"] }): RetimeGroup {
  return {
    layerId: "L1",
    paramKey: "opacity",
    kfIds: over.track.value.map((k) => k.id),
    tStartUs: 0,
    durationUs: 3_000_000,
    ...over,
  };
}

/// The times of one entry's track, in the array order the entry carries — which
/// is the collision policy, so a test that sorted them would prove nothing.
const timesOf = (entry: ParamTrackEntry): number[] =>
  entry[2].mode === "Keyframed" ? entry[2].value.map((k) => k.t_us) : [];

const idsOf = (entry: ParamTrackEntry): string[] =>
  entry[2].mode === "Keyframed" ? entry[2].value.map((k) => k.id) : [];

describe("retimeGroupsOf", () => {
  const layer = (over: Partial<LayerSummary>): LayerSummary =>
    ({
      id: "L1",
      kind: "VideoClip",
      label: null,
      t_start_us: 0,
      t_end_us: 1_000_000,
      enabled: true,
      locked: false,
      color_hint: "#888",
      params: { kind: "VideoClip", opacity: keyed([kf("a", frames(3))]) },
      effects: [],
      ...over,
    }) as unknown as LayerSummary;

  const trackOf = (layers: LayerSummary[]): TrackSummary =>
    ({
      id: "T1",
      kind: "Video",
      label: null,
      enabled: true,
      locked: false,
      muted: false,
      solo: false,
      role: null,
      transient: false,
      layers,
    }) as unknown as TrackSummary;

  it("carries the layer's own start and span, which is what puts the group on the composition clock", () => {
    const groups = retimeGroupsOf({
      selected: [{ layerId: "L1", paramKey: "opacity", kfId: "a" }],
      tracks: [trackOf([layer({ t_start_us: 2_000_000, t_end_us: 5_000_000 })])],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.tStartUs).toBe(2_000_000);
    expect(groups[0]!.durationUs).toBe(3_000_000);
    expect(selectionExtent(groups)?.firstUs).toBe(2_000_000 + frames(3));
  });
});

describe("translateSelection", () => {
  it("moves every selected key by one delta snapped to the frame grid", () => {
    const g = group({ track: keyed([kf("a", 0), kf("b", frames(30))]) });
    const { entries, appliedDeltaUs } = translateSelection([g], F * 2 + 500, GRID);

    expect(appliedDeltaUs).toBe(frames(2));
    expect(timesOf(entries[0]!)).toEqual([frames(2), frames(30) + frames(2)]);
  });

  it("commits nothing when the snapped delta is zero", () => {
    const g = group({ track: keyed([kf("a", frames(10))]) });
    const { entries, appliedDeltaUs } = translateSelection([g], 4_000, GRID);

    expect(appliedDeltaUs).toBe(0);
    expect(entries).toEqual([]);
  });

  it("stops the group at the earliest selected key's own start", () => {
    const g = group({ track: keyed([kf("a", frames(1)), kf("b", frames(20))]) });
    const { appliedDeltaUs, entries } = translateSelection([g], -frames(10), GRID);

    expect(appliedDeltaUs).toBe(-frames(1));
    expect(timesOf(entries[0]!)).toEqual([0, frames(20) - frames(1)]);
  });

  it("stops at the TIGHTEST wall across layers, not each layer's own", () => {
    // Both layers hold a key at the same composition time; the short layer's
    // end is two frames past it, the long one's is far away.
    const short = group({
      layerId: "short",
      track: keyed([kf("s", frames(10))]),
      durationUs: frames(12),
    });
    const long = group({
      layerId: "long",
      track: keyed([kf("l", frames(10))]),
      durationUs: frames(300),
    });
    const { appliedDeltaUs, entries } = translateSelection(
      [short, long],
      frames(100),
      GRID,
    );

    expect(appliedDeltaUs).toBe(frames(2));
    expect(timesOf(entries[0]!)).toEqual([frames(12)]);
    expect(timesOf(entries[1]!)).toEqual([frames(12)]);
  });

  it("orders a moved key LAST so it replaces the stationary key it lands on", () => {
    // `b` starts at 0 and moves exactly onto `c`; `c` is not selected, so
    // main's last-wins dedupe has to see the moved key after it.
    const g = group({
      track: keyed([kf("b", 0), kf("c", frames(5)), kf("d", frames(10))]),
      kfIds: ["b"],
    });
    const { entries } = translateSelection([g], frames(5), GRID);

    expect(idsOf(entries[0]!)).toEqual(["c", "d", "b"]);
    expect(timesOf(entries[0]!)).toEqual([frames(5), frames(10), frames(5)]);
  });

  it("passes a stationary key without disturbing it", () => {
    const g = group({
      track: keyed([kf("a", 0), kf("still", frames(5)), kf("b", frames(10))]),
      kfIds: ["b"],
    });
    const { entries } = translateSelection([g], -frames(8), GRID);

    expect(idsOf(entries[0]!)).toEqual(["a", "still", "b"]);
    expect(timesOf(entries[0]!)).toEqual([0, frames(5), frames(10) - frames(8)]);
  });

  it("answers nothing for a selection whose keys the tracks no longer carry", () => {
    const g = group({ track: keyed([kf("a", 0)]), kfIds: ["gone"] });
    expect(translateSelection([g], frames(5), GRID)).toEqual({
      entries: [],
      appliedDeltaUs: 0,
    });
  });
});

describe("selectionExtent", () => {
  it("reads the ends on the composition clock, not on each layer's own", () => {
    const early = group({
      layerId: "early",
      tStartUs: frames(10),
      track: keyed([kf("a", 0)]),
    });
    const late = group({
      layerId: "late",
      tStartUs: frames(100),
      track: keyed([kf("b", 0)]),
    });

    expect(selectionExtent([early, late])).toEqual({
      firstUs: frames(10),
      lastUs: frames(100),
      distinct: 2,
    });
  });

  it("counts two keys at one moment as ONE distinct time", () => {
    const g = group({ track: keyed([kf("a", frames(4)), kf("b", frames(4))]) });
    expect(selectionExtent([g])?.distinct).toBe(1);
  });
});

describe("scaleSelection", () => {
  it("scales about the anchor and snaps each key AFTER the multiply", () => {
    const g = group({
      track: keyed([kf("a", 0), kf("mid", frames(10)), kf("b", frames(20))]),
    });
    const { entries, appliedK } = scaleSelection([g], 0, 0.5, GRID);

    expect(appliedK).toBe(0.5);
    // Every result is a canonical grid time, which a pre-snapped delta could
    // not have produced for the middle key.
    expect(timesOf(entries[0]!)).toEqual([0, frames(5), frames(10)]);
  });

  it("holds the anchor key still whichever end is grabbed", () => {
    const g = group({ track: keyed([kf("a", frames(10)), kf("b", frames(30))]) });
    const { entries } = scaleSelection([g], frames(30), 0.5, GRID);

    expect(timesOf(entries[0]!)).toEqual([frames(20), frames(30)]);
  });

  it("floors the factor so adjacent selected keys never merge or flip", () => {
    // Two keys two frames apart, shrunk to a tenth: unfloored they would land
    // on the same frame.
    const g = group({ track: keyed([kf("a", 0), kf("b", frames(2))]) });
    const { entries, appliedK } = scaleSelection([g], 0, 0.1, GRID);

    expect(appliedK).toBeCloseTo(0.5, 4);
    const times = timesOf(entries[0]!);
    expect(times).toEqual([0, frames(1)]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(F);
  });

  it("stops growing at the layer's end, the same wall a translate obeys", () => {
    const g = group({
      track: keyed([kf("a", 0), kf("b", frames(10))]),
      durationUs: frames(20),
    });
    const { appliedK, entries } = scaleSelection([g], 0, 8, GRID);

    expect(appliedK).toBeCloseTo(2, 4);
    expect(timesOf(entries[0]!)).toEqual([0, frames(20)]);
  });

  it("takes the tightest wall across layers", () => {
    const long = group({
      layerId: "long",
      track: keyed([kf("a", 0), kf("l", frames(10))]),
      durationUs: frames(300),
    });
    const short = group({
      layerId: "short",
      track: keyed([kf("s", frames(10))]),
      durationUs: frames(15),
    });
    const { appliedK } = scaleSelection([long, short], 0, 8, GRID);

    expect(appliedK).toBeCloseTo(1.5, 4);
  });

  it("orders a moved key LAST so a scale replaces on collision too", () => {
    const g = group({
      track: keyed([kf("a", 0), kf("still", frames(5)), kf("b", frames(20))]),
      kfIds: ["a", "b"],
    });
    const { entries } = scaleSelection([g], 0, 0.25, GRID);

    expect(idsOf(entries[0]!)).toEqual(["still", "a", "b"]);
    expect(timesOf(entries[0]!)).toEqual([frames(5), 0, frames(5)]);
  });

  it("commits nothing for a selection with fewer than two distinct times", () => {
    const g = group({ track: keyed([kf("a", frames(4))]) });
    expect(scaleSelection([g], 0, 2, GRID)).toEqual({ entries: [], appliedK: 1 });
  });

  it("commits nothing when the clamped factor leaves every key where it was", () => {
    const g = group({ track: keyed([kf("a", 0), kf("b", frames(10))]) });
    expect(scaleSelection([g], 0, 1, GRID).entries).toEqual([]);
  });
});

/// Both gestures read a key's time and never its value, so a colour group is
/// retimed by the same arithmetic as a numeric one — which is what makes one
/// selection across an `opacity` and a `color` track a single gesture.
describe("colour groups", () => {
  const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
  const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };
  const colorKf = (id: string, tUs: number, value: Rgba): Keyframe<Rgba> => ({
    ...kf(id, tUs),
    value,
  });
  const colorKeyed = (keys: Keyframe<Rgba>[]): Extract<AnimTrack<Rgba>, { mode: "Keyframed" }> => ({
    mode: "Keyframed",
    extrapolate: { before: "Hold", after: "Hold" },
    value: keys,
  });
  const valuesOf = (entry: ParamTrackEntry): unknown[] =>
    entry[2].mode === "Keyframed" ? entry[2].value.map((k) => k.value) : [];

  it("translates an opacity group and a colour group by one delta, values untouched", () => {
    const opacity = group({ track: keyed([kf("o", frames(10), 0.5)]) });
    const colour = group({
      layerId: "text",
      paramKey: "color",
      track: colorKeyed([colorKf("c", frames(10), RED), colorKf("d", frames(20), GREEN)]),
    });
    const { entries, appliedDeltaUs } = translateSelection([opacity, colour], frames(5), GRID);

    expect(appliedDeltaUs).toBe(frames(5));
    expect(timesOf(entries[0]!)).toEqual([frames(10) + frames(5)]);
    expect(timesOf(entries[1]!)).toEqual([frames(10) + frames(5), frames(20) + frames(5)]);
    expect(valuesOf(entries[0]!)).toEqual([0.5]);
    expect(valuesOf(entries[1]!)).toEqual([RED, GREEN]);
  });

  it("scales both groups about one anchor", () => {
    const opacity = group({ track: keyed([kf("o0", 0), kf("o1", frames(10))]) });
    const colour = group({
      layerId: "text",
      paramKey: "color",
      track: colorKeyed([colorKf("c0", 0, RED), colorKf("c1", frames(10), GREEN)]),
    });
    const { entries, appliedK } = scaleSelection([opacity, colour], 0, 2, GRID);

    expect(appliedK).toBe(2);
    expect(timesOf(entries[0]!)).toEqual([0, frames(20)]);
    expect(timesOf(entries[1]!)).toEqual([0, frames(20)]);
    expect(valuesOf(entries[1]!)).toEqual([RED, GREEN]);
  });
});
