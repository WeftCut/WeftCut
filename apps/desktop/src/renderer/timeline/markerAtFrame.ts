import { displayedFrameStartUs, frameIndexCeil, snapFrameCeil, timeUsAtFrame } from "../frames";
import type {
  CompositionSummary,
  MarkerAnchorArg,
  MarkerSummary,
} from "../ipc";

/// The `M` key's same-frame rule, as one pure function: which marker, if any,
/// STARTS in the frame the playhead is displaying? A hit means `M` opens rename
/// for it; a miss means `M` adds.
///
/// Matching is on where a mark BEGINS, so a region merely spanning the playhead
/// does not block a new point marker — "this frame already carries a mark" is a
/// statement about starts, not coverage. Markers arrive sorted by `t_us`, so
/// when several share the frame (a batched agent sweep can), the first is the
/// stable winner.
export function markerStartingInFrame(
  markers: readonly MarkerSummary[],
  playheadUs: number,
  fpsNum: number,
  fpsDen: number,
): MarkerSummary | null {
  const frameStartUs = displayedFrameStartUs(playheadUs, fpsNum, fpsDen);
  for (const marker of markers) {
    if (displayedFrameStartUs(marker.t_us, fpsNum, fpsDen) === frameStartUs) {
      return marker;
    }
  }
  return null;
}

/// The anchor a mark at `tUs` would carry on `layerId`, or null when that layer
/// cannot hold one — nothing selected worth anchoring to, a clip the mark does
/// not touch, or a kind with no source window to measure into.
///
/// One statement of "what attach means" for both surfaces that offer it: the `M`
/// key, which needs the anchor itself to add and tie in one commit, and the
/// marker menu's *Attach to clip* row, which needs only whether one exists.
///
/// LANDMINE: a renderer-side twin of `applyAttachMarker`'s three refusals
/// (main/state/mutations/markers.ts) and nothing enforces the agreement. Drift
/// does not throw — it greys a legal attach out, or offers one the actor then
/// refuses. The kind list is the twin that bites first: `Motif` carries a
/// `src_in_us` and is still NOT anchorable, because main's `hasSourceWindow` is
/// the three kinds with a full source WINDOW.
export function markerAnchorFor(
  composition: CompositionSummary,
  layerId: string,
  tUs: number,
): MarkerAnchorArg | null {
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.id !== layerId) continue;
      if (tUs < layer.t_start_us || tUs >= layer.t_end_us) return null;
      const p = layer.params;
      if (
        p.kind !== "VideoClip" &&
        p.kind !== "Audio" &&
        p.kind !== "CompositionRef"
      ) {
        return null;
      }
      return { layer: layerId, src_us: tUs - layer.t_start_us + p.src_in_us };
    }
  }
  return null;
}

/// The timeline-space interval a marker may be dragged within — both bounds
/// INCLUSIVE, both on the composition frame grid — or `null` when the marker
/// cannot be moved at all (an anchor this composition does not hold, a kind with
/// no source window, a span holding no whole frame).
///
/// LANDMINE: the renderer-side twin of `applyUpdateMarker`'s span refusal
/// (main/state/mutations/markers.ts), the way `markerAnchorFor` above is the
/// twin of `applyAttachMarker`'s three. Same consequence when the two drift: no
/// throw, just a gesture that previews a landing the actor then refuses.
///
/// Stated in TIMELINE space, never in source space. The obvious reading — clamp
/// `src_us` to `[src_in_us, src_out_us]` — is wrong at the top: `src_us ===
/// src_out_us` is exactly `markerHibernating`'s condition (main/state/summary.ts),
/// so the glyph would VANISH from under the cursor at the instant it reached the
/// edge, which is the worst feedback a clamp can give. The clip's span is
/// half-open, so the last legal landing is the start of the last frame it shows.
///
/// A FREE marker is bounded BELOW only. `composition.duration_us` is a derived
/// high-water mark of the layers (ADR 0005) that markers neither move nor are
/// validated against, so a ceiling taken from it would shrink when a clip is
/// deleted and retroactively forbid a mark that was placed legally.
export interface MarkerDragBoundsUs {
  minUs: number;
  /// `null` = unbounded above.
  maxUs: number | null;
}
export function markerDragBoundsUs(
  composition: CompositionSummary,
  marker: MarkerSummary,
): MarkerDragBoundsUs | null {
  if (marker.anchor_layer === null) return { minUs: 0, maxUs: null };
  const num = composition.fps_num;
  const den = composition.fps_den;
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.id !== marker.anchor_layer) continue;
      const p = layer.params;
      if (
        p.kind !== "VideoClip" &&
        p.kind !== "Audio" &&
        p.kind !== "CompositionRef"
      ) {
        return null;
      }
      // Ceil, and ceil-minus-one: a layer's own endpoints may sit on the audio
      // lattice rather than this grid (ADR 0038), and only these two land a
      // canonical time inside the half-open span whichever grid the edges are on.
      const minUs = snapFrameCeil(layer.t_start_us, num, den);
      const maxUs = timeUsAtFrame(
        frameIndexCeil(layer.t_end_us, num, den) - 1,
        num,
        den,
      );
      return maxUs < minUs ? null : { minUs, maxUs };
    }
  }
  return null;
}

/// Where a dragged marker actually lands. The clamp is the RENDERER's half of
/// the split the codebase takes everywhere: the gesture keeps the value legal,
/// the actor refuses an illegal one — so a marker held hard against a clip edge
/// stops there and stays painted, instead of being previewed off the clip and
/// bounced back by a refusal at release.
export function clampMarkerTimeUs(tUs: number, bounds: MarkerDragBoundsUs): number {
  const atLeast = Math.max(tUs, bounds.minUs);
  return bounds.maxUs === null ? atLeast : Math.min(atLeast, bounds.maxUs);
}
