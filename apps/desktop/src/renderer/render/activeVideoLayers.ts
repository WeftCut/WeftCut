// The single source of truth for "which VideoClip layers does export decode?"
// Both the export Worker's decode loop (exportWorker.ts `activeVideoClips`)
// and the export-readiness gate (app/useExportFlow.ts and worker/runExport.ts,
// which scope the gate via `referencedVideoMediaIds`) select from this. They
// MUST stay in lockstep: if the gate selects a different set than the Worker
// decodes, an undecodable source either reaches the Worker un-gated (the scary
// failure returns) or the export hangs on a proxy it never needed.
//
// The selection recurses into Groups (`compositionWalk.ts`), so a clip inside
// one is reported at its MAPPED root time and with the source trim its Group's
// window implies — which is what lets the Worker and the export-mode
// Compositor derive the same `exportHandleKey` for it.

import type { ProjectSummary } from "../ipc";
import { forEachLayerInTime, instanceKey } from "./compositionWalk";

export interface ActiveVideoLayer {
  /// Per-instance identity: the bare layer id at the root, path-prefixed
  /// inside a Group (`instanceKey`), so two placements of one Group are two
  /// decode positions rather than one contested key.
  layerId: string;
  mediaId: string;
  /// ROOT-time placement, clipped by every enclosing Group's window.
  tStartUs: number;
  tEndUs: number;
  /// Source-in for THAT placement: the authored `src_in_us` advanced by
  /// whatever the clipping cut off the head.
  srcInUs: number;
}

/// Every enabled VideoClip layer on an enabled track whose interval overlaps
/// [aUs, bUs] (bUs INCLUSIVE — matches the Worker's per-chunk call, which
/// passes `chunkEndUs` as an inclusive PTS). Audio/Image/Text/etc. are not
/// WebCodecs-video-decoded and are excluded.
export function selectActiveVideoLayers(
  summary: ProjectSummary,
  aUs: number,
  bUs: number,
): ActiveVideoLayer[] {
  const out: ActiveVideoLayer[] = [];
  // Export renders the ROOT (compositionScopeStore.ts); the walk descends from
  // there through every Group placed on it. `bUs` is inclusive and the walk's
  // range half-open, hence the +1.
  forEachLayerInTime(summary, summary.root_id, aUs, bUs + 1, 0, (placed) => {
    const { layer } = placed;
    if (layer.params.kind !== "VideoClip") return;
    out.push({
      layerId: instanceKey(placed.path, layer.id),
      mediaId: layer.params.media_id,
      tStartUs: placed.tStartUs,
      tEndUs: placed.tEndUs,
      srcInUs: layer.params.src_in_us + placed.headUs,
    });
  });
  return out;
}

/// Distinct video media ids the export of [startUs, endUs) will decode.
/// `endUs` is the half-open range end; pass `endUs - 1` to the inclusive
/// selector so the boundary matches the Worker's chunk math exactly.
export function referencedVideoMediaIds(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
): Set<string> {
  return new Set(
    selectActiveVideoLayers(summary, startUs, endUs - 1).map((l) => l.mediaId),
  );
}

/// True iff the export of `[startUs, endUs)` has any *visible* content — an
/// enabled non-Audio layer (VideoClip / ImageOverlay / Text / Color / Motif)
/// on an enabled track overlapping the range. A video export with nothing
/// visible would emit pure black; the caller rejects that as "no video
/// material" instead. (Audio emptiness is judged Rust-side — a video clip's
/// audio stream isn't visible from a ProjectSummary.)
///
/// A Group layer is not itself content: the walk reports what is INSIDE it, so
/// a Group over an empty composition contributes nothing and a range holding
/// only such Groups is correctly empty. The walk has no early exit, so this
/// visits every reachable layer; the callback is a kind test.
export function hasVisibleContent(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
): boolean {
  let visible = false;
  forEachLayerInTime(summary, summary.root_id, startUs, endUs, 0, ({ layer }) => {
    if (layer.params.kind !== "Audio") visible = true;
  });
  return visible;
}
