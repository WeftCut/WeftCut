import { describe, expect, it } from "vitest";

import { timeUsAtFrame } from "../frames";
import type { AnimTrack, CompositionSummary, LayerSummary, TrackSummary } from "../ipc";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import {
  childFrame,
  compositionLocalUs,
  forEachLayer,
  forEachLayerInTime,
  instanceKey,
  MAX_COMPOSITION_DEPTH,
  placeLayer,
  refPath,
  type PlacedLayer,
} from "./compositionWalk";

// The recursive walk is where "a flat project is no longer the whole project"
// (ADR 0052) is decided, so every consumer inherits whatever it gets wrong: the
// export decode set, the emptiness gate, the motif pre-bake, font collection.
// What is pinned here is the arithmetic those consumers cannot re-derive —
// the parent↔child time mapping, the window narrowing as Groups nest, the
// head/tail a narrowed window implies, and the per-placement identity that
// keeps two instances of one Group from sharing a decode position.

const S = 1_000_000;

const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });

const colorLayer = (
  id: string,
  tStartUs: number,
  tEndUs: number,
  over: Partial<LayerSummary> = {},
): LayerSummary => ({
  id,
  label: null,
  t_start_us: tStartUs,
  t_end_us: tEndUs,
  kind: "Color",
  color_hint: "#4488cc",
  enabled: true,
  locked: false,
  params: {
    kind: "Color",
    color: { mode: "Static", value: { r: 10, g: 20, b: 30, a: 255 } },
    width: 1920,
    height: 1080,
  },
  effects: [],
  ...over,
});

const refLayer = (
  id: string,
  compositionId: string,
  tStartUs: number,
  tEndUs: number,
  srcInUs = 0,
  over: Partial<LayerSummary> = {},
): LayerSummary => ({
  id,
  label: null,
  t_start_us: tStartUs,
  t_end_us: tEndUs,
  kind: "CompositionRef",
  color_hint: "#886644",
  enabled: true,
  locked: false,
  params: {
    kind: "CompositionRef",
    composition_id: compositionId,
    composition_label: null,
    src_in_us: srcInUs,
    src_out_us: srcInUs + (tEndUs - tStartUs),
    x: stat(0),
    y: stat(0),
    scale_x: stat(1),
    scale_y: stat(1),
    scale_linked: true,
    rotation_deg: stat(0),
    opacity: stat(1),
    anchor_x: stat(0.5),
    anchor_y: stat(0.5),
  },
  effects: [],
  ...over,
});

const track = (id: string, layers: LayerSummary[], enabled = true): TrackSummary => ({
  id,
  kind: "Video",
  label: id,
  enabled,
  locked: false,
  muted: false,
  solo: false,
  role: null,
  transient: true,
  layers,
});

/// A composition holding one track of `layers`.
const comp = (id: string, layers: LayerSummary[], over: Partial<CompositionSummary> = {}) =>
  compositionFixture({ id, tracks: [track(`${id}-t`, layers)], ...over });

/// Everything the walk reports for `[t0Us, t1Us)` from the root, in visit order.
const walk = (
  summary: Parameters<typeof forEachLayerInTime>[0],
  t0Us = Number.NEGATIVE_INFINITY,
  t1Us = Number.POSITIVE_INFINITY,
): PlacedLayer[] => {
  const out: PlacedLayer[] = [];
  forEachLayerInTime(summary, summary.root_id, t0Us, t1Us, 0, (p) => out.push(p));
  return out;
};

describe("placeLayer", () => {
  it("shifts a layer by its composition's offset and clips it to the window", () => {
    const placed = placeLayer(colorLayer("C", 1 * S, 4 * S), 2 * S, 4 * S, 5 * S);
    // Placed at [3 s, 6 s); the window keeps [4 s, 5 s) of it.
    expect(placed).toEqual({
      tStartUs: 4 * S,
      tEndUs: 5 * S,
      headUs: 1 * S,
      tailUs: 1 * S,
    });
  });

  it("reports an empty span (start ≥ end) for a layer the window excludes", () => {
    const placed = placeLayer(colorLayer("C", 0, 1 * S), 0, 2 * S, 3 * S);
    expect(placed.tStartUs >= placed.tEndUs).toBe(true);
  });
});

describe("childFrame", () => {
  it("maps parent time to the child's clock: child t = parent t − t_start + src_in", () => {
    const ref = refLayer("R", "g", 3 * S, 5 * S, 400_000);
    const frame = childFrame(ref, 400_000, 0, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
    // The child's own t = 0 sits at parent 3 s − 0.4 s.
    expect(frame.offsetUs).toBe(2_600_000);
    // Parent 3 s is the ref's first instant, and reads the child at src_in.
    expect(3 * S - frame.offsetUs).toBe(400_000);
    // The window is the ref's own placement.
    expect(frame.windowStartUs).toBe(3 * S);
    expect(frame.windowEndUs).toBe(5 * S);
  });

  it("narrows, never widens, the window it is handed", () => {
    const ref = refLayer("R", "g", 0, 10 * S);
    const frame = childFrame(ref, 0, 0, 2 * S, 4 * S);
    expect(frame.windowStartUs).toBe(2 * S);
    expect(frame.windowEndUs).toBe(4 * S);
  });
});

describe("compositionLocalUs", () => {
  it("puts a mapped time back on the lattice when the offset knocks it off", () => {
    // 30 fps: frame 2 is 66_667 µs and frame 4 is 133_333, so a Group starting
    // on frame 2 maps root frame 4 to 66_666 — one µs BELOW the child's frame-2
    // anchor, where a child layer starting there would read as not yet active.
    const raw = timeUsAtFrame(4, 30, 1) - timeUsAtFrame(2, 30, 1);
    expect(raw).toBe(66_666);
    expect(compositionLocalUs(raw, 30, 1)).toBe(timeUsAtFrame(2, 30, 1));
  });

  it("is the identity on a time already canonical", () => {
    for (const frame of [0, 1, 2, 3, 7, 29, 150]) {
      const t = timeUsAtFrame(frame, 30000, 1001);
      expect(compositionLocalUs(t, 30000, 1001)).toBe(t);
    }
  });

  it("passes a time through when there is no grid to snap to", () => {
    expect(compositionLocalUs(12_345, 0, 1)).toBe(12_345);
    expect(compositionLocalUs(12_345, 30, 0)).toBe(12_345);
  });
});

describe("forEachLayerInTime", () => {
  it("reports a flat project's layers unchanged — offset 0, no clipping, empty path", () => {
    const summary = summaryFixture({
      root: { tracks: [track("t1", [colorLayer("C", 1 * S, 2 * S)])] },
    });
    expect(walk(summary)).toMatchObject([
      {
        compositionId: ROOT_ID,
        offsetUs: 0,
        tStartUs: 1 * S,
        tEndUs: 2 * S,
        headUs: 0,
        tailUs: 0,
        path: "",
        depth: 0,
      },
    ]);
  });

  it("reports a layer inside a Group at its mapped root time, never the Group itself", () => {
    // The Group sits at 1 s reading its composition from 0.4 s in, so the
    // child's own 0 is at root 0.6 s and its 0.5 s–1.5 s layer lands at
    // 1.1 s–2.1 s.
    const summary = summaryFixture({
      root: { tracks: [track("t1", [refLayer("R", "g", 1 * S, 3 * S, 400_000)])] },
      groups: [comp("g", [colorLayer("C", 500_000, 1_500_000)])],
    });
    const seen = walk(summary);
    expect(seen.map((p) => p.layer.id)).toEqual(["C"]);
    expect(seen[0]).toMatchObject({
      compositionId: "g",
      offsetUs: 600_000,
      tStartUs: 1_100_000,
      tEndUs: 2_100_000,
      headUs: 0,
      tailUs: 0,
      path: refPath("", "R"),
      depth: 1,
    });
  });

  it("intersects the windows of two nested Groups, and reports what they cut as head/tail", () => {
    // Root: the outer Group occupies [1 s, 2 s).
    // Inside it: the inner Group spans its whole 5 s reading from 0.5 s in, so
    // the inner composition's own 0 sits at root 0.5 s.
    // Inside that: a 4 s layer, i.e. root [0.5 s, 4.5 s) — of which the outer
    // Group's window keeps only [1 s, 2 s).
    const summary = summaryFixture({
      root: { tracks: [track("t1", [refLayer("R1", "g1", 1 * S, 2 * S)])] },
      groups: [
        comp("g1", [refLayer("R2", "g2", 0, 5 * S, 500_000)]),
        comp("g2", [colorLayer("C", 0, 4 * S)]),
      ],
    });
    const seen = walk(summary);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      compositionId: "g2",
      offsetUs: 500_000,
      tStartUs: 1 * S,
      tEndUs: 2 * S,
      // The clipping cut 0.5 s off the head and 2.5 s off the tail: a source
      // read honouring the placement starts 0.5 s into the layer.
      headUs: 500_000,
      tailUs: 2_500_000,
      depth: 2,
      path: refPath(refPath("", "R1"), "R2"),
    });
  });

  it("distinguishes two placements of one Group by path, so their keys differ", () => {
    // The same composition twice, 4 s apart. At any one root time the two
    // instances are looking at different frames of it — which is exactly why
    // anything keyed per instance keys on the path, not the layer id.
    const summary = summaryFixture({
      root: {
        tracks: [
          track("t1", [refLayer("A", "g", 0, 2 * S), refLayer("B", "g", 4 * S, 6 * S)]),
        ],
      },
      groups: [comp("g", [colorLayer("C", 0, 2 * S)])],
    });
    const seen = walk(summary);
    expect(seen.map((p) => p.layer.id)).toEqual(["C", "C"]);
    expect(seen.map((p) => p.tStartUs)).toEqual([0, 4 * S]);
    const keys = seen.map((p) => instanceKey(p.path, p.layer.id));
    expect(keys).toEqual(["A/C", "B/C"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps the root's keys bare, so a flat project's pool and bake keys are unchanged", () => {
    expect(instanceKey("", "layer-1")).toBe("layer-1");
  });

  it("clips the reported placement to the window, never to the query range", () => {
    // A key derived from `tStartUs`/`tEndUs` has to name the layer's placement
    // and not the caller's range, or the export Worker's per-chunk selection
    // and the Compositor's per-node acquire would derive different keys.
    const summary = summaryFixture({
      root: { tracks: [track("t1", [colorLayer("C", 0, 10 * S)])] },
    });
    expect(walk(summary, 3 * S, 4 * S)[0]).toMatchObject({
      tStartUs: 0,
      tEndUs: 10 * S,
    });
  });

  it("skips a layer whose placement misses the half-open query range", () => {
    const summary = summaryFixture({
      root: {
        tracks: [
          track("t1", [colorLayer("before", 0, 1 * S), colorLayer("after", 2 * S, 3 * S)]),
        ],
      },
    });
    // `before` ends exactly at 1 s and `after` starts exactly at 2 s.
    expect(walk(summary, 1 * S, 2 * S)).toEqual([]);
    expect(walk(summary, 999_999, 1 * S).map((p) => p.layer.id)).toEqual(["before"]);
    expect(walk(summary, 2 * S, 2_000_001).map((p) => p.layer.id)).toEqual(["after"]);
  });

  it("gates on the ref and on the leaf: a disabled Group hides its whole composition", () => {
    const summary = summaryFixture({
      root: {
        tracks: [
          track("t1", [refLayer("off", "g", 0, 2 * S, 0, { enabled: false })]),
          track("t2", [refLayer("on", "g", 0, 2 * S)]),
          track("t3", [refLayer("offtrack", "g", 0, 2 * S)], false),
        ],
      },
      groups: [comp("g", [colorLayer("C", 0, 2 * S), colorLayer("D", 0, 2 * S, { enabled: false })])],
    });
    const seen = walk(summary);
    expect(seen.map((p) => instanceKey(p.path, p.layer.id))).toEqual(["on/C"]);
  });

  it("reports nothing for a ref whose composition the summary does not carry", () => {
    const summary = summaryFixture({
      root: { tracks: [track("t1", [refLayer("R", "ghost", 0, 2 * S)])] },
    });
    expect(walk(summary)).toEqual([]);
  });

  it("stops descending past MAX_COMPOSITION_DEPTH", () => {
    // A chain two levels deeper than the cap, each composition holding one
    // Color of its own so the deepest level actually reached is observable.
    const depth = MAX_COMPOSITION_DEPTH + 2;
    const groups: CompositionSummary[] = [];
    for (let i = 1; i <= depth; i++) {
      const layers: LayerSummary[] = [colorLayer(`C${i}`, 0, 10 * S)];
      if (i < depth) layers.push(refLayer(`R${i}`, `g${i + 1}`, 0, 10 * S));
      groups.push(comp(`g${i}`, layers));
    }
    const summary = summaryFixture({
      root: { tracks: [track("t1", [colorLayer("C0", 0, 10 * S), refLayer("R0", "g1", 0, 10 * S)])] },
      groups,
    });
    const seen = walk(summary);
    const depths = seen.map((p) => p.depth);
    // Root is depth 0, and the cap is the last depth still walked.
    expect(Math.max(...depths)).toBe(MAX_COMPOSITION_DEPTH);
    expect(seen).toHaveLength(MAX_COMPOSITION_DEPTH + 1);
    expect(seen.map((p) => p.layer.id)).not.toContain(`C${depth}`);
  });
});

describe("forEachLayer", () => {
  it("visits every reachable leaf whatever the time — the walks with no range", () => {
    const summary = summaryFixture({
      root: { tracks: [track("t1", [refLayer("R", "g", 900 * S, 902 * S)])] },
      groups: [comp("g", [colorLayer("C", 0, 2 * S)])],
    });
    const seen: PlacedLayer[] = [];
    forEachLayer(summary, summary.root_id, (p) => seen.push(p));
    expect(seen.map((p) => p.layer.id)).toEqual(["C"]);
    expect(seen[0]!.tStartUs).toBe(900 * S);
  });
});
