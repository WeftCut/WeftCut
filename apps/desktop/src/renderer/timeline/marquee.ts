// What a marquee rectangle takes, for both of the timeline's selectable
// populations — clips and keyframes — and what that means for the clip
// selection. Pure: no React, no DOM, so every rule is provable from hand-fed
// rows the way `geometry.test.ts` proves `trackIdAtClientY`. The gesture and the
// overlay rectangle live elsewhere. See ADR 0051.

import type { GroupSummary, TrackSummary } from "../ipc";
import {
  computeValueRange,
  timeToXPx,
  valueToY,
  type CurveGeom,
} from "../keyframe/curveGraph";
import { isHiddenTwinAxis, readParamTrack } from "../keyframe/descriptors";
import type { SelectedKeyframe } from "../keyframe/selectionStore";
import {
  computeLayerSlices,
  layerSliceRect,
  type MeasuredTrackRow,
} from "./geometry";

/// A drag rectangle, in whatever coordinate space the rows it is tested against
/// were measured in.
export interface MarqueeBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/// The direction of the drag carries no meaning: an up-and-left drag describes
/// the same rectangle as its mirror.
export function normalizeBox(b: MarqueeBox): MarqueeBox {
  return {
    x0: Math.min(b.x0, b.x1),
    y0: Math.min(b.y0, b.y1),
    x1: Math.max(b.x0, b.x1),
    y1: Math.max(b.y0, b.y1),
  };
}

/// `[a0, a1)` against `[b0, b1)`. Requiring both intervals to be non-empty is
/// what makes a zero-width or zero-height box take nothing, and what makes a box
/// that exactly abuts a chip's edge leave it alone: the two meet at a single
/// coordinate that neither of them contains.
function overlapsHalfOpen(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): boolean {
  return a0 < a1 && b0 < b1 && a0 < b1 && b0 < a1;
}

/// `v` inside `[lo, hi)` — the point form, for a keyframe diamond's centre. A
/// point is not a degenerate interval as far as `overlapsHalfOpen` is concerned,
/// which requires both intervals non-empty so a zero-extent box takes nothing;
/// the two nonetheless agree on an edge, low bound in and high bound out.
function containsHalfOpen(v: number, lo: number, hi: number): boolean {
  return v >= lo && v < hi;
}

/// Every clip the box touches, in track-then-layer order.
///
/// Intersect, never enclose. A clip longer than the viewport can never be
/// enclosed, so enclose-semantics would make exactly the long clips
/// unselectable.
///
/// The two axes come from opposite places and the asymmetry is deliberate. x is
/// arithmetic: `t_start_us`/`t_end_us` × `pxPerSec` is the chip's exact extent,
/// and since the timeline does not virtualize chips, measuring them would work —
/// it would just buy N `getBoundingClientRect` calls and a mandatory DOM for an
/// answer already known exactly. y can never be arithmetic; the LANDMINE on
/// `trackIdAtClientY` is why `rows` are measured.
///
/// A track without a row contributes nothing, which is how the A/B Roll display
/// filter is honoured — structurally, because the caller registers rows for the
/// lanes it actually rendered. Re-reading the filter here would be a second copy
/// of a rule that must not drift from the one the lanes obey.
///
/// Groups are not fanned out here; that is `resolveMarqueeSelection`'s job. This
/// function answers "what did the box touch" and stays free of project
/// semantics.
export function marqueeHitClips(args: {
  box: MarqueeBox;
  rows: readonly MeasuredTrackRow[];
  tracks: readonly TrackSummary[];
  pxPerSec: number;
}): string[] {
  const box = normalizeBox(args.box);
  const rowByTrackId = new Map(args.rows.map((row) => [row.trackId, row]));
  const hit: string[] = [];
  for (const track of args.tracks) {
    const row = rowByTrackId.get(track.id);
    if (row === undefined) continue;
    // Locks are the whole filter, by `selectionCommands.ts:29`'s rule. A locked
    // clip is not a target but a hole, and it already behaves as one.
    if (track.locked) continue;
    const slices = computeLayerSlices(track.layers);
    const laneHeight = row.bottom - row.top;
    for (const layer of track.layers) {
      if (layer.locked) continue;
      const band = layerSliceRect(laneHeight, slices.get(layer.id) ?? "full");
      const bandTop = row.top + band.top;
      if (!overlapsHalfOpen(bandTop, bandTop + band.height, box.y0, box.y1)) {
        continue;
      }
      const left = (layer.t_start_us / 1_000_000) * args.pxPerSec;
      const right = (layer.t_end_us / 1_000_000) * args.pxPerSec;
      if (!overlapsHalfOpen(left, right, box.x0, box.x1)) continue;
      hit.push(layer.id);
    }
  }
  return hit;
}

/// One rendered keyframe sub-lane row's measured band, in the box's coordinate
/// space, tagged with the property it draws.
export interface MeasuredSubLaneRow {
  trackId: string;
  paramKey: string;
  top: number;
  bottom: number;
  /// The row's OWN answer — `KeyframeLane`'s `paramKey === focusedParamKey`.
  /// Never a comparison of `bottom - top` against `KF_SUBLANE_EXPANDED_H`: that
  /// would be a second definition of "expanded" for a future height change to
  /// break silently.
  expanded: boolean;
}

/// Every keyframe whose diamond CENTRE the box takes, in row-then-layer-then-key
/// order. Cross-layer and cross-property: one row draws every layer on its
/// track, and every row the box reaches contributes.
///
/// Centre point, no radius, in both modes. A tolerance belongs to clicking
/// (`keyframeHitTest`'s `radiusPx`), not to sweeping an area — in an expanded
/// row the box must actually cover the dot, which is the point of drawing one.
///
/// The y test is row-height dependent, and the asymmetry is a measurement rather
/// than a taste. A sub-lane is never a dope sheet — `KeyframeCurveGraph`
/// positions every diamond by value at BOTH heights — so y always carries
/// meaning. But 24 px of value axis against a 7 px glyph rotated 45° (a ~4.95 px
/// half-diagonal, one diamond covering ~40% of the axis) is not vertical aim the
/// user has, while 72 px is about seven distinguishable levels. So an expanded
/// row tests the drawn (x, y) and a collapsed one tests x against any vertical
/// overlap with its band. A 2D test in a collapsed row would make keys
/// unselectable that the user can plainly see and click.
///
/// `geom` is per CURVE, not per row: each layer on a row draws its own value
/// axis from its own `computeValueRange`, so two dots at one screen y mean
/// different values. That is pre-existing rendering, and testing the drawn
/// position is what keeps the box honest about it.
///
/// LANDMINE: the axis comes from the COMMITTED `track.value`, while
/// `KeyframeCurveGraph` builds its geom from `renderKeys` — which carries the
/// live handle-drag and easing-popover previews. Do not reach for the preview
/// store to close that gap. It would couple selection to an unrelated in-flight
/// gesture, and the gap cannot open in practice: a marquee drag and a handle
/// drag are both pointer gestures, so they cannot overlap.
export function marqueeHitKeyframes(args: {
  box: MarqueeBox;
  rows: readonly MeasuredSubLaneRow[];
  tracks: readonly TrackSummary[];
  pxPerSec: number;
}): SelectedKeyframe[] {
  const box = normalizeBox(args.box);
  const trackById = new Map(args.tracks.map((track) => [track.id, track]));
  const hit: SelectedKeyframe[] = [];
  for (const row of args.rows) {
    const track = trackById.get(row.trackId);
    if (track === undefined) continue;
    // A locked track's sub-lanes are still rendered, so this is a decision and
    // not a structural consequence: excluded, by `selectionCommands.ts:29`'s
    // rule — do not build a selection that arms an operation the user cannot
    // perform.
    if (track.locked) continue;
    // The row's own band: the whole y test in a collapsed row, and in an
    // expanded one a cheap skip ahead of the stricter centre test below.
    if (!overlapsHalfOpen(row.top, row.bottom, box.y0, box.y1)) continue;
    for (const layer of track.layers) {
      if (layer.locked) continue;
      // What the row itself skips, mirroring `KeyframeLane`: a linked layer's
      // hidden `scale_y` is not on screen, so it cannot be in a box, and a param
      // this layer does not animate draws no diamonds to take.
      if (isHiddenTwinAxis(row.paramKey, layer.params)) continue;
      const trk = readParamTrack(layer.params, row.paramKey);
      if (trk === null || trk.mode !== "Keyframed") continue;
      const geom: CurveGeom = {
        pxPerSec: args.pxPerSec,
        layerTStartUs: layer.t_start_us,
        height: row.bottom - row.top,
        ...computeValueRange(trk.value),
      };
      for (const kf of trk.value) {
        // `timeToXPx` folds in the layer's start and answers absolute ruler px,
        // which IS canvas-relative — x = 0 is the canvas's left edge, at t = 0.
        if (!containsHalfOpen(timeToXPx(kf.t_us, geom), box.x0, box.x1)) continue;
        // `valueToY` does not: it answers ROW-LOCAL y, hence the row's measured
        // top. Drop that term and every expanded row hit-tests a band one canvas
        // origin above the one the user sees.
        if (
          row.expanded &&
          !containsHalfOpen(row.top + valueToY(kf.value, geom), box.y0, box.y1)
        ) {
          continue;
        }
        hit.push({ layerId: layer.id, paramKey: row.paramKey, kfId: kf.id });
      }
    }
  }
  return hit;
}

/// The selection a box implies. Total and stateless, so the gesture can re-run it
/// on every pointermove instead of accumulating — which is what lets the user
/// shrink the box back and release a clip they over-reached.
///
/// `mode` has one member. The additive path is already `Shift+click`'s
/// (`toggleLayerSelection`), and a `Shift`-marquee, if ever added, must UNION
/// rather than toggle: two overlapping XOR boxes cancel each other, and
/// accumulating across boxes is the only thing such a gesture is for.
///
/// `snapshotPrimary` is the primary at pointerdown. The rest of the pointerdown
/// snapshot is the gesture's business — Escape restores it — and `replace` has no
/// use for it.
export function resolveMarqueeSelection(args: {
  snapshotPrimary: string | null;
  hit: readonly string[];
  groupByLayerId: ReadonlyMap<string, string>;
  groups: readonly GroupSummary[];
  mode: "replace";
}): { ids: string[]; primary: string | null } {
  const groupById = new Map(args.groups.map((group) => [group.id, group]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const take = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const layerId of args.hit) {
    take(layerId);
    // Touching one member takes the whole group, as a plain click does
    // (`selectFromClick`) — members and all, locked ones included, so the box
    // cannot build a selection a click could not. The cost is a highlight
    // outside the box, possibly off screen; the alternative is a half-group
    // selection the next Delete would tear apart, since only selection carries
    // the group and the op level does not fan out.
    const groupId = args.groupByLayerId.get(layerId);
    if (groupId === undefined) continue;
    for (const memberId of groupById.get(groupId)?.layer_ids ?? []) {
      take(memberId);
    }
  }
  // A surviving primary is KEPT, the rule `selectAllLayers` applies: a sweep must
  // not move the Attribute panel off the clip being inspected.
  const primary =
    args.snapshotPrimary !== null && seen.has(args.snapshotPrimary)
      ? args.snapshotPrimary
      : (ids[0] ?? null);
  return { ids, primary };
}
