import { localAt } from './compositionClock';
// Pure Motif export-range planning. Pixel acquisition is bounded and demand-driven
// in exportMotifSource.ts; this module allocates no bitmaps.

import { frameIndexInLayer, snapFrameFloor } from "../frames";
import type { ProjectSummary, MotifView } from "../ipc";
import { compositionLocalUs, forEachLayerInTime, instanceKey } from "./compositionWalk";
import { getMotif, type Motif } from "./motifs/catalog";
import { motifDurationFrames } from "./motifs/motifFrames";

/// One Motif layer to bake: its id, the resolved `Motif`, the layer's
/// `MotifView`, and the comp-fps frame range to raster. `durationFrames` is
/// the layer's full animated length on the comp grid (NOT clamped to the export
/// range) so the per-frame index math matches `MotifSprite.update` exactly —
/// a partial export range only narrows WHICH of those frames we actually bake.
export interface MotifBakeSpec {
  /// Per-instance identity (`instanceKey`) — the key the Worker's
  /// `CompositionNode` asks `motifFrames` for. The bare layer id at the root;
  /// path-prefixed inside a Group, because two placements of one Group reach
  /// different frames of the same Motif layer and each needs its own array.
  layerId: string;
  motif: Motif;
  view: MotifView;
  /// Layer duration in microseconds (`t_end_us - t_start_us`).
  durationUs: number;
  sampleLocalUs?: number;
  /// Total animated frames on the comp grid (`motifDurationFrames`).
  durationFrames: number;
  /// First/last comp-frame index (inclusive) overlapping the export range.
  /// Clamped to `[0, durationFrames - 1]`.
  firstFrame: number;
  lastFrame: number;
  /// Layer start time in microseconds on the composition timeline (`t_start_us`).
  /// Required to reconstruct `tInLayerUs` the same way the compositor does for
  /// each layer-local frame, so the bake's content-frame selection mirrors the
  /// preview path exactly (see `tInLayerUsForLayerLocalFrame`).
  tStartUs: number;
}

/// Collect the Motif layers (enabled, on an enabled track) whose interval
/// overlaps `[startUs, endUs)`, resolving each to a `MotifBakeSpec`. Pure +
/// Node-testable: no DOM, no rasterize. Layers whose `motif_id` isn't in the
/// catalog are skipped (they can't render anywhere — the live compositor warns
/// too). `fpsNum/fpsDen` are the COMPOSITION fps.
export function motifLayersToBake(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
  fpsNum: number,
  fpsDen: number,
): MotifBakeSpec[] {
  const out: MotifBakeSpec[] = [];
  // The ROOT and every Group placed on it — what export renders. The walk
  // hands each Motif layer its ROOT-time placement (`tStartUs`/`tEndUs`,
  // already clipped by every enclosing Group's window) plus the `offsetUs` of
  // the composition it sits in, which is all the frame math below needs.
  forEachLayerInTime(summary, summary.root_id, startUs, endUs, 0, (placed) => {
    const { layer } = placed;
    if (layer.params.kind !== "Motif") return;

    const view = layer.params;
    const motif = getMotif(view.motif_id);
    if (!motif) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/export] bake: unknown motif "${view.motif_id}" ` +
          `(layer ${layer.id}) — skipping`,
      );
      return;
    }

    const durationUs = layer.t_end_us - layer.t_start_us;
    const durationFrames = motifDurationFrames(durationUs, fpsNum, fpsDen);

    // Comp-frame indices of the export-range overlap, expressed layer-local
    // (motifs have no source-in offset, so layer-local time = the OWN
    // composition's time − t_start_us). Mirrors `MotifSprite.update`'s
    // `frameIndexInLayer(tInLayerUs, ...)` + the `min(durationFrames - 1, …)`
    // clamp. We bake only the frames the export can reach; a frame the
    // playhead never visits would be wasted raster work.
    const overlapStartUs = Math.max(placed.tStartUs, startUs);
    // The last instant the layer is visible inside the range is the smaller
    // of the layer's last displayable µs and the range's. `endUs` is
    // exclusive, so subtract 1 µs before mapping to a frame index.
    const overlapEndUs = Math.min(placed.tEndUs, endUs) - 1;
    // Snap the ROOT bound to the composition-frame grid, then map it down to
    // this layer's own composition exactly as the Worker's nested
    // `CompositionNode` does (`compositionLocalUs`) — both sides therefore
    // reach one frame index, and at the root (offset 0) the mapping is the
    // identity the flat path always had. The snap comes first because the
    // Worker's Compositor snaps `tUs` in `compositeFrame` before any of this:
    // when `startUs` is off-grid (the playhead set to a raw time via "set
    // range to playhead") the raw bound maps one frame HIGHER than the snapped
    // one, so `injectedFrames[first]` would be `undefined` and the leading
    // exported frame would show a blank.
    const localFrame = (tRootUs: number): number =>
      frameIndexInLayer(
        compositionLocalUs(
          placed.clock ? localAt(placed.clock, snapFrameFloor(tRootUs, fpsNum, fpsDen)) : snapFrameFloor(tRootUs, fpsNum, fpsDen) - placed.offsetUs,
          fpsNum,
          fpsDen,
        ) - layer.t_start_us,
        fpsNum,
        fpsDen,
      );
    const firstFrame = Math.min(durationFrames - 1, localFrame(overlapStartUs));
    const lastFrame = Math.min(durationFrames - 1, localFrame(overlapEndUs));

    out.push({
      layerId: instanceKey(placed.path, layer.id),
      motif,
      view,
      durationUs,
      ...(placed.clock && (placed.clock.rate.num !== placed.clock.rate.den || layer.params.kind === "Motif" && layer.params.time_map) ? { sampleLocalUs: localAt(placed.clock, snapFrameFloor(overlapStartUs, fpsNum, fpsDen)) - layer.t_start_us } : {}),
      durationFrames,
      firstFrame,
      lastFrame,
      tStartUs: layer.t_start_us,
    });
  });
  return out;
}
