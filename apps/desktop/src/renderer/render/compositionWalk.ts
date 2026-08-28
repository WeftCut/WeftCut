// The one recursive walk over a project's layers. Every flat
// `tracks[].layers[]` loop that has to see INSIDE a Group — the export decode
// set, the emptiness gate, the motif pre-bake, font collection, the preview
// prewarm planners — goes through here, so "a flat project is no longer the
// whole project" (ADR 0052) is decided in one place. The Compositor's own
// sweep does not use it: a `CompositionNode` walks its one composition and
// recurses through its child nodes, because it owns sprites per instance.
//
// Twin: `native/src/audio/mix.rs` `for_each_audio_layer` — same offset and
// window convention, same depth cap. Keep them in step.

import { snapFrameRound } from "../frames";
import type { CompositionSummary, LayerSummary, ProjectSummary, TrackSummary } from "../ipc";

/// Recursion cap, mirroring the Rust mixer's. Validation rejects reference
/// cycles on commit; this is the backstop that keeps a bad snapshot from
/// recursing forever rather than a limit anyone is expected to reach.
export const MAX_COMPOSITION_DEPTH = 32;

/// A leaf layer as the walk hands it out: where it sits in ROOT time once
/// every enclosing Group's placement has clipped it, and how to get back to
/// its own composition's clock.
export interface PlacedLayer {
  layer: LayerSummary;
  track: TrackSummary;
  /// The composition the layer sits in.
  compositionId: string;
  /// Root-time origin of that composition: local `t` ↔ root `t + offsetUs`.
  offsetUs: number;
  /// Root-time placement, half-open, clipped to every enclosing window.
  tStartUs: number;
  tEndUs: number;
  /// What the clipping cut off the head and the tail (each ≥ 0). A source
  /// read that honours the clip starts `headUs` into the layer.
  headUs: number;
  tailUs: number;
  /// Group layers entered to reach here, root excluded, as `refPath` joins
  /// them. Two placements of one Group are two paths, which is why anything
  /// keyed per instance (a decode session, a baked motif) keys on
  /// `instanceKey(path, layer.id)` and never on the layer id alone.
  path: string;
  depth: number;
}

/// `path` for the children of the Group layer `refLayerId` placed under `parentPath`.
export function refPath(parentPath: string, refLayerId: string): string {
  return `${parentPath}${refLayerId}/`;
}

/// The per-instance identity of a layer: unchanged from the bare id at the
/// root, so a flat project's keys — pool keys, bake keys — are what they
/// always were.
export function instanceKey(path: string, layerId: string): string {
  return path + layerId;
}

/// Root-time placement of `layer` sitting in a composition whose origin is
/// `offsetUs`, clipped to the half-open window `[windowStartUs, windowEndUs)`.
/// `tStartUs >= tEndUs` means the window leaves nothing of it.
export function placeLayer(
  layer: LayerSummary,
  offsetUs: number,
  windowStartUs: number,
  windowEndUs: number,
): { tStartUs: number; tEndUs: number; headUs: number; tailUs: number } {
  const placedStart = offsetUs + layer.t_start_us;
  const placedEnd = offsetUs + layer.t_end_us;
  const tStartUs = Math.max(placedStart, windowStartUs);
  const tEndUs = Math.min(placedEnd, windowEndUs);
  return { tStartUs, tEndUs, headUs: tStartUs - placedStart, tailUs: placedEnd - tEndUs };
}

/// The frame a Group layer opens onto its composition: the child's origin in
/// root time and the window its placement narrows the parent's to. Spec § Time
/// and audio: parent `t` ↔ child `t − t_start + src_in`, inverted here so the
/// child's origin is `placed_start − src_in`.
///
/// `srcInUs` is the ref's own `params.src_in_us`, taken as an argument rather
/// than read off `ref`: narrowing a `LayerSummary` on `params.kind` narrows the
/// PARAMS, not the layer, so every caller already holds the number by the time
/// it reaches here and an intersection type would only force a cast.
export function childFrame(
  ref: LayerSummary,
  srcInUs: number,
  parentOffsetUs: number,
  windowStartUs: number,
  windowEndUs: number,
): { offsetUs: number; windowStartUs: number; windowEndUs: number } {
  const placed = placeLayer(ref, parentOffsetUs, windowStartUs, windowEndUs);
  return {
    offsetUs: parentOffsetUs + ref.t_start_us - srcInUs,
    windowStartUs: placed.tStartUs,
    windowEndUs: placed.tEndUs,
  };
}

/// A composition's own clock for a time expressed in its parent's: the raw
/// mapping — `src_in + tInLayer`, equivalently `tRoot − offsetUs` — put back
/// onto the shared lattice.
///
/// The re-snap is load-bearing, not hygiene. A canonical grid time is
/// `round(frame × 1e6 × den / num)`, so `anchor(i) − anchor(a) + anchor(b)`
/// misses `anchor(i − a + b)` by up to a µs: at 30 fps, root frame 4 under a
/// Group starting on frame 2 lands ONE µs below the child's frame-2 anchor, and
/// a child layer starting there reads as not yet active for exactly that frame.
/// Rounding to the nearest boundary absorbs the residual — the frame period
/// dwarfs it at every rate — and is the identity on a time already canonical.
///
/// Degenerate fps (a project-less sentinel) passes through: there is no grid to
/// snap to, and nothing composites then either.
export function compositionLocalUs(
  rawLocalUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return rawLocalUs;
  return snapFrameRound(rawLocalUs, fpsNum, fpsDen);
}

/// Visit every enabled LEAF layer on an enabled track reachable from `compId`
/// whose root-time placement overlaps the half-open `[t0Us, t1Us)`, recursing
/// through enabled `CompositionRef` layers. The ref itself is never reported —
/// a Group is what it contains, so a Group over an empty composition
/// contributes nothing (that is the emptiness gate's answer too).
///
/// `offsetUs` is where the composition's own `t = 0` sits in root time
/// (0 for the root). The query range never narrows; what narrows on the way
/// down is the WINDOW — the intersection of the entered Groups' placements —
/// and the reported `tStartUs`/`tEndUs` are clipped to it, not to the query.
/// A key derived from them therefore names the layer's placement, never the
/// caller's range, which is what lets the export Worker's per-chunk selection
/// and the Compositor's per-node acquire arrive at one `exportHandleKey`.
///
/// A ref whose composition the summary does not carry, or one nested past
/// `MAX_COMPOSITION_DEPTH`, contributes nothing — the same silence as Rust.
export function forEachLayerInTime(
  summary: ProjectSummary,
  compId: string,
  t0Us: number,
  t1Us: number,
  offsetUs: number,
  f: (placed: PlacedLayer) => void,
  frame: { windowStartUs: number; windowEndUs: number; path: string; depth: number } = {
    windowStartUs: Number.NEGATIVE_INFINITY,
    windowEndUs: Number.POSITIVE_INFINITY,
    path: "",
    depth: 0,
  },
): void {
  if (frame.depth > MAX_COMPOSITION_DEPTH) return;
  if (frame.windowStartUs >= frame.windowEndUs || t0Us >= t1Us) return;
  const comp: CompositionSummary | undefined = summary.compositions[compId];
  if (!comp) return;
  for (const track of comp.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers) {
      if (!layer.enabled) continue;
      const placed = placeLayer(layer, offsetUs, frame.windowStartUs, frame.windowEndUs);
      if (placed.tStartUs >= placed.tEndUs) continue;
      // Half-open overlap with the query range.
      if (placed.tEndUs <= t0Us || placed.tStartUs >= t1Us) continue;
      if (layer.params.kind === "CompositionRef") {
        const child = childFrame(
          layer,
          layer.params.src_in_us,
          offsetUs,
          frame.windowStartUs,
          frame.windowEndUs,
        );
        forEachLayerInTime(summary, layer.params.composition_id, t0Us, t1Us, child.offsetUs, f, {
          windowStartUs: child.windowStartUs,
          windowEndUs: child.windowEndUs,
          path: refPath(frame.path, layer.id),
          depth: frame.depth + 1,
        });
        continue;
      }
      f({
        layer,
        track,
        compositionId: compId,
        offsetUs,
        ...placed,
        path: frame.path,
        depth: frame.depth,
      });
    }
  }
}

/// Every enabled leaf reachable from `compId`, whatever the time — the
/// project-wide walks (fonts, motif cache keys) that have no range.
export function forEachLayer(
  summary: ProjectSummary,
  compId: string,
  f: (placed: PlacedLayer) => void,
): void {
  forEachLayerInTime(
    summary,
    compId,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    0,
    f,
  );
}
