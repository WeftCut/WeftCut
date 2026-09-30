// Composition-grid, range and Group selection regressions for Motif export.
// Pixel streaming and cache recovery are covered by exportMotifSource.test.ts.

import { afterEach, describe, expect, it, test } from "vitest";

import type { AnimTrack, LayerParamsView, ProjectSummary, MotifView } from "../ipc";
import { frameIndexInLayer, snapFrameFloor } from "../frames";
import { motifLayersToBake } from "./exportBake";
import {
  previewRenderTargetId,
  setPreviewRenderTarget,
} from "../state/compositionAnchorStore";
import { useProjectStore } from "../state/projectStore";
import { motifContentFrame, motifDurationFrames, tInLayerUsForLayerLocalFrame } from "./motifs/motifFrames";
import { getMotif, type Motif } from "./motifs/catalog";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";

const COUNTDOWN = "countdown"; // built-in, 480x480

const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });

function motifLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
  overrides: Partial<MotifView> = {},
): { id: string; t_start_us: number; t_end_us: number; params: LayerParamsView } {
  const params: LayerParamsView = {
    kind: "Motif",
    motif_id: COUNTDOWN,
    x: stat(0),
    y: stat(0),
    scale_x: stat(1),
    scale_y: stat(1),
    scale_linked: true,
    rotation_deg: stat(0),
    anchor_x: { mode: "Static", value: 0.5 },
    anchor_y: { mode: "Static", value: 0.5 },
    opacity: stat(1),
    src_in_us: 0,
    props: {},
    ...overrides,
  };
  return { id, t_start_us: tStartUs, t_end_us: tEndUs, params };
}

interface BakeTestLayer {
  id: string;
  t_start_us: number;
  t_end_us: number;
  params: LayerParamsView;
  enabled?: boolean;
}

/// A Group layer placing `compositionId` at `tStartUs`, opening its window
/// `srcInUs` into it.
function refLayer(
  id: string,
  compositionId: string,
  tStartUs: number,
  tEndUs: number,
  srcInUs = 0,
): BakeTestLayer {
  return {
    id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
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
      anchor_x: stat(0.5),
      anchor_y: stat(0.5),
      opacity: stat(1),
    },
  };
}

/// Minimal ProjectSummary whose ROOT carries one track of the given layers,
/// plus a track per further composition in `groups` (keyed by its id). Only
/// the fields `motifLayersToBake` reads carry real values; the empty
/// collections around them are what the project store's own indexing walks, so
/// a test can hand the SAME summary to both. The rest is cast.
function summaryWith(
  layers: BakeTestLayer[],
  trackEnabled = true,
  groups: Record<string, BakeTestLayer[]> = {},
): ProjectSummary {
  const oneTrack = (id: string, ls: BakeTestLayer[]) => ({
    id,
    tracks: [
      {
        id: `${id}-track`,
        enabled: trackEnabled,
        layers: ls.map((l) => ({ enabled: l.enabled ?? true, ...l })),
      },
    ],
    transitions: [],
    markers: [],
    links: [],
  });
  return {
    project_id: "p-bake",
    root_id: "root",
    compositions: {
      root: oneTrack("root", layers),
      ...Object.fromEntries(
        Object.entries(groups).map(([id, ls]) => [id, oneTrack(id, ls)]),
      ),
    },
    media: [],
    audio_roles: [],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
  } as unknown as ProjectSummary;
}

describe("motifLayersToBake", () => {
  test("full-range bake covers [0, motifDurationFrames-1] on COMP fps", () => {
    // 5 s @ 30 fps → 150 comp frames.
    const summary = summaryWith([motifLayer("L1", 0, 5_000_000)]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(motifDurationFrames(5_000_000, 30, 1));
    expect(s.durationFrames).toBe(150);
    // The whole animation is baked: first frame 0, last frame 149.
    expect(s.firstFrame).toBe(0);
    expect(s.lastFrame).toBe(s.durationFrames - 1);
    expect(s.lastFrame).toBe(149);
    // Total baked count == the full comp-frame count.
    expect(s.lastFrame - s.firstFrame + 1).toBe(s.durationFrames);
  });

  test("output-fps independence: the bake count tracks COMP fps, not the export's output fps", () => {
    // Whatever output fps the caller later picks, the bake is always on the
    // comp fps passed here. Pass comp fps = 30 even for a hypothetical 60fps
    // OUTPUT export: 150 frames, not 300.
    const summary = summaryWith([motifLayer("L1", 0, 5_000_000)]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs[0]!.durationFrames).toBe(150);
  });

  test("a mid-layer export start narrows to the overlapping comp-frame window", () => {
    // 10 s layer @ 30 fps (300 frames). Export only [3s, 6s).
    const summary = summaryWith([motifLayer("L1", 0, 10_000_000)]);
    const specs = motifLayersToBake(summary, 3_000_000, 6_000_000, 30, 1);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(300);
    // frame index of t=3s is 90; t just under 6s is 179 (frame 180 starts at 6s,
    // which is excluded by the half-open range).
    expect(s.firstFrame).toBe(90);
    expect(s.lastFrame).toBe(179);
  });

  test("a layer offset on the timeline bakes from its own frame 0", () => {
    // Layer placed at t=2s, 5 s long → covers [2s, 7s). Motifs have no
    // source-in offset, so frame 0 is at the layer's t_start (2s).
    const summary = summaryWith([motifLayer("L1", 2_000_000, 7_000_000)]);
    const specs = motifLayersToBake(summary, 0, 10_000_000, 30, 1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(150);
    expect(s.firstFrame).toBe(0);
    expect(s.lastFrame).toBe(149);
  });

  test("skips disabled layers, disabled tracks, and out-of-range layers", () => {
    const summary = summaryWith([
      motifLayer("on", 0, 5_000_000),
      { ...motifLayer("off", 0, 5_000_000), enabled: false },
      motifLayer("past", 8_000_000, 10_000_000), // outside [0, 5s)
    ]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs.map((s) => s.layerId)).toEqual(["on"]);

    const disabledTrack = motifLayersToBake(
      summaryWith([motifLayer("L1", 0, 5_000_000)], false),
      0,
      5_000_000,
      30,
      1,
    );
    expect(disabledTrack).toHaveLength(0);
  });

  test("skips non-Motif layers and unknown motif ids", () => {
    const summary = summaryWith([
      motifLayer("known", 0, 5_000_000),
      motifLayer("unknown", 0, 5_000_000, {
        motif_id: "does-not-exist",
      } as Partial<MotifView>),
    ]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs.map((s) => s.layerId)).toEqual(["known"]);
  });

  test("no Motif layers → empty result", () => {
    const summary = summaryWith([]);
    expect(motifLayersToBake(summary, 0, 5_000_000, 30, 1)).toEqual([]);
  });

  test("a Motif inside a Group bakes its OWN frame range, keyed by the ref path", () => {
    // The Group sits at 2 s on the root reading its composition from 0 s, so
    // the composition's own 0 is at root 2 s. A 1 s Motif at 0 inside it is
    // live over root [2 s, 3 s) and animates from ITS frame 0 — layer-local,
    // exactly as the Worker's nested `MotifSprite` indexes it.
    const summary = summaryWith(
      [refLayer("G", "g", 2_000_000, 4_000_000)],
      true,
      { g: [motifLayer("inner", 0, 1_000_000)] },
    );
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    // The key the Worker asks `motifFrames` for is the layer's PER-INSTANCE
    // identity; the bare id would collide between two placements of one Group.
    expect(s.layerId).toBe("G/inner");
    expect(s.tStartUs).toBe(0);
    expect(s.firstFrame).toBe(0);
    expect(s.lastFrame).toBe(s.durationFrames - 1);
    expect(s.durationFrames).toBe(motifDurationFrames(1_000_000, 30, 1));
  });

  test("two placements of one Group bake separately, each over its own range", () => {
    // Instance A shows the composition's first half second, instance B opens
    // half a second in — so they need different frames of the same Motif layer
    // and cannot share one array.
    const summary = summaryWith(
      [
        refLayer("A", "g", 0, 500_000),
        refLayer("B", "g", 4_000_000, 4_500_000, 500_000),
      ],
      true,
      { g: [motifLayer("inner", 0, 1_000_000)] },
    );
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs.map((s) => s.layerId)).toEqual(["A/inner", "B/inner"]);
    // 30 fps, half a second each: A covers frames 0–14, B 15–29.
    expect([specs[0]!.firstFrame, specs[0]!.lastFrame]).toEqual([0, 14]);
    expect([specs[1]!.firstFrame, specs[1]!.lastFrame]).toEqual([15, 29]);
  });

  test("a Group the summary cannot resolve bakes nothing", () => {
    const summary = summaryWith([refLayer("G", "missing", 0, 2_000_000)]);
    expect(motifLayersToBake(summary, 0, 5_000_000, 30, 1)).toEqual([]);
  });

  test("frame-parity: off-grid startUs maps to the same firstFrame the Worker visits", () => {
    // Regression guard for the frame-parity bug: when the export range's
    // `startUs` is NOT on the composition-frame grid (reachable via "set range
    // to playhead" — `currentTimeUs` is not snapped), the bake must derive
    // `firstFrame` through the SAME snap the Worker applies, or the worker's
    // first request has no baked bitmap → blank leading frame.
    //
    // Setup: 5 s Motif layer at t_start=0, comp fps = 30/1, export starting at
    // 50_000 µs — inside frame 1's cell [33_333, 66_667).
    const FPS_NUM = 30;
    const FPS_DEN = 1;
    const START_US = 50_000; // deliberately off-grid; inside frame 1's cell

    const summary = summaryWith([motifLayer("L1", 0, 5_000_000)]);
    const specs = motifLayersToBake(summary, START_US, 5_000_000, FPS_NUM, FPS_DEN);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;

    // The Worker snaps `tUs` with `snapFrameFloor` before subtracting
    // `t_start_us`, so the first frame it requests equals:
    const expectedFirstFrame = frameIndexInLayer(
      snapFrameFloor(START_US, FPS_NUM, FPS_DEN) - 0, // t_start_us = 0
      FPS_NUM,
      FPS_DEN,
    );
    expect(expectedFirstFrame).toBe(1);

    // The bake's firstFrame must match the worker's first request — frame 1
    // must be baked so its `injectedFrames` slot is defined, not a hole.
    expect(s.firstFrame).toBe(expectedFirstFrame);

    // At t_start_us = 0 the snap is now provably redundant: floor-then-index and
    // index-directly agree because the grid floor is idempotent on the canonical
    // grid. It stops being redundant once `t_start_us` is subtracted (the
    // parity suites below cover that at /1001 rates).
    expect(frameIndexInLayer(START_US - 0, FPS_NUM, FPS_DEN)).toBe(expectedFirstFrame);
  });
});

// ---------------------------------------------------------------------------
// Export bake / preview PARITY tests
//
// The core invariant: for every layer-local frame `f` that the export Worker
// will request, the bake loop's selection — `motifFrameDescriptor` fed the
// reconstructed `tInLayerUsForLayerLocalFrame(f, tStartUs, …)` — must return
// the SAME content frame as the live preview's `motifContentFrame(tInLayerUs,
// …)`. The compositor derives `tInLayerUs = snapFrameFloor(compFrameUs) -
// t_start_us`; the reconstruction mirrors it exactly so that
// floor(a+b) ≠ floor(a)+floor(b) divergences at /1001 fps boundaries are
// eliminated.
// ---------------------------------------------------------------------------

const US = 1_000_000;

/// Reproduce the compositor's content-frame selection for an absolute comp
/// frame index, mirroring MotifSprite.update's preview path.
function previewContentFrameAt(
  compFrameIdx: number,
  tStartUs: number,
  srcInUs: number,
  contentDurUs: number,
  n: number,
  d: number,
): number {
  const compFrameUs = snapFrameFloor(Math.round((compFrameIdx * US * d) / n), n, d);
  const tInLayerUs = compFrameUs - tStartUs;
  return motifContentFrame(tInLayerUs, srcInUs, contentDurUs, n, d).frame;
}

const countdownMotif = getMotif(COUNTDOWN)!;

/// A `content_duration_s` holdable: plays its in-animation from content frame
/// 0, then clamps/holds the tail. Never windows (src_in is ignored).
const holdableMotif: Motif = {
  manifest: {
    id: "holdable",
    name: "Holdable",
    version: 1,
    size: [1280, 320],
    default_duration_s: 5,
    content_duration_s: 0.8,
    props_schema: {},
  },
  hasParamsUi: false,
};

/// A wholly uncapped motif: animates over the layer width, never windows.
const uncappedMotif: Motif = {
  manifest: {
    id: "uncapped",
    name: "Uncapped",
    version: 1,
    size: [640, 360],
    default_duration_s: 5,
    props_schema: {},
  },
  hasParamsUi: false,
};

/// Export's content-frame selection for layer-local slot `f` — the same
/// tInLayerUs reconstruction + `motifFrameDescriptor` call the bake loop makes.
function exportContentFrameAt(
  f: number,
  tStartUs: number,
  view: { props: Record<string, unknown>; src_in_us: number },
  layerWidthUs: number,
  n: number,
  d: number,
  motif: Motif,
): number {
  return motifFrameDescriptor(
    view,
    tInLayerUsForLayerLocalFrame(f, tStartUs, n, d),
    layerWidthUs,
    n,
    d,
    motif,
  )!.contentFrame;
}

/// Assert export and preview select the same content frame for every
/// layer-local frame of a layer. `expectedSrcInUs`/`expectedContentDurUs` are
/// what the descriptor must resolve from the motif + view — asserted up front
/// so a wiring mistake fails loudly instead of comparing two equally-wrong
/// paths.
function expectParity(opts: {
  motif: Motif;
  props?: Record<string, unknown>;
  /// The layer view's src_in; the descriptor decides whether it applies.
  viewSrcInUs?: number;
  tStartFrame: number;
  layerWidthUs: number;
  frames: number;
  n: number;
  d: number;
  expectedSrcInUs: number;
  expectedContentDurUs: number;
}): void {
  const { motif, n, d } = opts;
  const view = { props: opts.props ?? {}, src_in_us: opts.viewSrcInUs ?? 0 };
  const tStartUs = snapFrameFloor(Math.round((opts.tStartFrame * US * d) / n), n, d);
  const desc0 = motifFrameDescriptor(view, 0, opts.layerWidthUs, n, d, motif)!;
  expect(desc0.srcInUs).toBe(opts.expectedSrcInUs);
  expect(desc0.contentDurationUs).toBe(opts.expectedContentDurUs);
  const mismatches: number[] = [];
  for (let f = 0; f < opts.frames; f++) {
    const preview = previewContentFrameAt(
      opts.tStartFrame + f, tStartUs, opts.expectedSrcInUs, opts.expectedContentDurUs, n, d,
    );
    const bake = exportContentFrameAt(f, tStartUs, view, opts.layerWidthUs, n, d, motif);
    if (preview !== bake) mismatches.push(f);
  }
  expect(mismatches).toEqual([]);
}

describe("export bake matches preview content frame", () => {
  it("windowed motif: every layer-local frame at 29.97fps with src_in>0 and t_start>0", () => {
    const n = 30000, d = 1001;
    // Layer starts at comp frame 30, src_in scrubbed in by ~1s, content 6s.
    expectParity({
      motif: countdownMotif,
      props: { seconds: 6 },
      viewSrcInUs: snapFrameFloor(Math.round((30 * US * d) / n), n, d), // ~1s, grid-aligned
      tStartFrame: 30,
      layerWidthUs: 3_000_000,
      frames: 90, // 3s window
      n, d,
      expectedSrcInUs: snapFrameFloor(Math.round((30 * US * d) / n), n, d),
      expectedContentDurUs: 6_000_000,
    });
  });

  it("windowed motif: src_in==0 and t_start==0 (legacy/common path)", () => {
    const n = 30000, d = 1001;
    expectParity({
      motif: countdownMotif,
      props: { seconds: 6 },
      tStartFrame: 0,
      layerWidthUs: 3_000_000,
      frames: 90,
      n, d,
      expectedSrcInUs: 0,
      expectedContentDurUs: 6_000_000,
    });
  });

  it("windowed motif: every layer-local frame at 30fps (integer rate) with src_in>0", () => {
    const n = 30, d = 1;
    expectParity({
      motif: countdownMotif,
      props: { seconds: 5 },
      viewSrcInUs: snapFrameFloor(Math.round((10 * US * d) / n), n, d),
      tStartFrame: 15,
      layerWidthUs: 2_000_000,
      frames: 60,
      n, d,
      expectedSrcInUs: snapFrameFloor(Math.round((10 * US * d) / n), n, d),
      expectedContentDurUs: 5_000_000,
    });
  });

  it("windowed motif: every layer-local frame at 24fps with src_in>0", () => {
    const n = 24, d = 1;
    expectParity({
      motif: countdownMotif,
      props: { seconds: 4 },
      viewSrcInUs: snapFrameFloor(Math.round((12 * US * d) / n), n, d), // 0.5s in
      tStartFrame: 24, // 1s in
      layerWidthUs: 2_000_000,
      frames: 48,
      n, d,
      expectedSrcInUs: snapFrameFloor(Math.round((12 * US * d) / n), n, d),
      expectedContentDurUs: 4_000_000,
    });
  });

  it("holdable motif (content_duration_s): never windows, clamps the tail — 23.976fps", () => {
    const n = 24000, d = 1001;
    expectParity({
      motif: holdableMotif,
      // src_in set on the view: the descriptor must IGNORE it (holdables play
      // from content frame 0), and the preview expectation agrees.
      viewSrcInUs: snapFrameFloor(Math.round((24 * US * d) / n), n, d),
      tStartFrame: 24,
      layerWidthUs: 2_000_000,
      frames: 48,
      n, d,
      expectedSrcInUs: 0,
      expectedContentDurUs: 800_000,
    });
  });

  it("uncapped motif: layer width is the content, src_in ignored — 59.94fps", () => {
    const n = 60000, d = 1001;
    expectParity({
      motif: uncappedMotif,
      viewSrcInUs: snapFrameFloor(Math.round((60 * US * d) / n), n, d),
      tStartFrame: 60,
      layerWidthUs: 1_500_000,
      frames: 90,
      n, d,
      expectedSrcInUs: 0,
      expectedContentDurUs: 1_500_000,
    });
  });

  it("windowed motif: every frame of a MID-LAYER export range at 29.97fps", () => {
    const n = 30000, d = 1001;
    const tStartUs = snapFrameFloor(Math.round((30 * US * d) / n), n, d); // ~1s in
    const srcInUs = snapFrameFloor(Math.round((15 * US * d) / n), n, d); // ~0.5s
    const summary = summaryWith([
      motifLayer("L1", tStartUs, tStartUs + 10_000_000, {
        src_in_us: srcInUs,
        props: { seconds: 10 },
      }),
    ]);
    const specs = motifLayersToBake(summary, 3_000_000, 6_000_000, n, d);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    // Genuinely mid-layer: the range's first slot is not the layer's frame 0.
    expect(s.firstFrame).toBeGreaterThan(0);
    expect(s.lastFrame).toBeLessThan(s.durationFrames - 1);
    const view = { props: { seconds: 10 }, src_in_us: srcInUs };
    const mismatches: number[] = [];
    for (let f = s.firstFrame; f <= s.lastFrame; f++) {
      const absFrame = frameIndexInLayer(s.tStartUs, n, d) + f;
      const preview = previewContentFrameAt(absFrame, s.tStartUs, srcInUs, 10_000_000, n, d);
      const bake = exportContentFrameAt(f, s.tStartUs, view, s.durationUs, n, d, countdownMotif);
      if (preview !== bake) mismatches.push(f);
    }
    expect(mismatches).toEqual([]);
  });
});

/// Export renders the ROOT, and it has to keep doing so now that the preview
/// can be pointed anywhere (ADR 0053 decision 3). Asserted here rather than
/// trusted at the call site: a preview that names a composition is exactly the
/// change that invites wiring export to it.
describe("what export renders", () => {
  afterEach(() => {
    useProjectStore.getState().apply(null);
  });

  it("bakes the film from the root, with the Group in it, while the preview is locked to that Group", () => {
    const summary = summaryWith(
      [motifLayer("film", 0, 1_000_000), refLayer("G", "g", 2_000_000, 3_000_000)],
      true,
      { g: [motifLayer("inner", 0, 1_000_000)] },
    );
    useProjectStore.getState().apply(summary);
    setPreviewRenderTarget("g");
    expect(previewRenderTargetId()).toBe("g");

    // The film's own Motif is the half a walk re-pointed at the preview would
    // lose; the Group's is the half that proves it is still composited in.
    expect(motifLayersToBake(summary, 0, 5_000_000, 30, 1).map((s) => s.layerId)).toEqual([
      "film",
      "G/inner",
    ]);
  });
});
