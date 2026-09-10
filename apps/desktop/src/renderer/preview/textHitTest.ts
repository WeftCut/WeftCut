// Which Text layer is under a point on the preview — the Text tool's first
// question, and the first time the preview answers "what is at this pixel" at
// all. Pure: the geometry is `centerInFrame.ts`'s `layerFrameAt` and
// `gizmoGeometry.ts`'s `layerQuad`, the same two the gizmo boxes a layer with,
// so the rectangle a click lands in IS the rectangle the gizmo would draw
// (that file's LANDMINE about second copies applies here too).
//
// Scoped to Text on purpose, and only while the Text tool is armed: this is
// not the preview becoming a selection surface (ADR 0067). A click that
// misses every Text layer is a click on empty frame, whatever else is drawn
// there.

import type { CompositionSummary, LayerSummary } from "../ipc";
import { layerFrameAt } from "./centerInFrame";
import { layerQuad, type Pt } from "./gizmoGeometry";

export interface TextHitTestInput {
  composition: Pick<CompositionSummary, "tracks">;
  /// The instant on the composition's own clock.
  tUs: number;
  /// Composition pixels.
  point: Pt;
  /// `GizmoProbe.naturalSizeOf`: the box when one is set, the measured glyph
  /// block when not (ADR 0049). Null for a layer the compositor has not
  /// staged, whose footprint is then unknowable — not zero — and is skipped.
  naturalSizeOf: (layerId: string) => { w: number; h: number } | null;
}

/// Whether `p` lies inside the convex quad `q`, either winding. A flipped
/// layer (negative scale) reverses the winding, so the test asks for one
/// consistent sign rather than a particular one. Edges count as inside.
export function pointInQuad(p: Pt, q: readonly [Pt, Pt, Pt, Pt]): boolean {
  let positive = false;
  let negative = false;
  for (let i = 0; i < 4; i += 1) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross > 0) positive = true;
    else if (cross < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

/// The TOPMOST Text layer under `point` at `tUs`, or null.
///
/// Topmost = the last track in `tracks` order, which is the compositor's own
/// z-order (`CompositionNode` hands out `zIndex` walking the tracks forward).
/// Within a track no two layers overlap in time, so order there is moot.
///
/// Locked and disabled layers, and layers on locked or disabled tracks, are
/// TRANSPARENT: the click falls through to whatever is under them, or to empty
/// frame. That is Premiere's rule for a locked track and the honest one — the
/// tool cannot edit such a layer, so reporting it would only turn a click into
/// a refusal.
export function hitTestTextLayer(input: TextHitTestInput): LayerSummary | null {
  const { tracks } = input.composition;
  for (let t = tracks.length - 1; t >= 0; t -= 1) {
    const track = tracks[t]!;
    if (track.locked || !track.enabled) continue;
    for (const layer of track.layers) {
      if (layer.params.kind !== "Text") continue;
      if (layer.locked || !layer.enabled) continue;
      if (input.tUs < layer.t_start_us || input.tUs >= layer.t_end_us) continue;
      const size = input.naturalSizeOf(layer.id);
      if (!size || size.w <= 0 || size.h <= 0) continue;
      if (pointInQuad(input.point, layerQuad(layerFrameAt(layer, input.tUs, size)))) {
        return layer;
      }
    }
  }
  return null;
}
