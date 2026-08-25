// The clip half of the timeline marquee: which clips a rectangle takes, and what
// that means for the selection. Pure — no React, no DOM — so every rule is
// provable from hand-fed rows the way `geometry.test.ts` proves
// `trackIdAtClientY`. The gesture, the overlay rectangle and the keyframe
// population live elsewhere. See ADR 0051.

import type { GroupSummary, TrackSummary } from "../ipc";
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
