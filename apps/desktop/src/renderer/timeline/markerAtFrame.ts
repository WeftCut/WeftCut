import { displayedFrameStartUs } from "../frames";
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
