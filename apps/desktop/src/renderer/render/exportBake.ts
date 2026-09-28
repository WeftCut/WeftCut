// Main-thread Motif pre-capture for export.
//
// The export Worker has no DOM and no backend `invoke`, so it can't capture
// Motif frames itself. Instead the MAIN thread captures EVERY frame of each
// Motif layer in the export range to an `ImageBitmap[]` (indexed by
// composition-frame) via the SAME CDP path the preview uses (`bakeMotifFrame`
// → `captureMotifFrame` → the offscreen Motif host window), and the bitmaps are
// TRANSFERRED into the Worker, where `MotifSprite` binds them by index
// synchronously. Export pixels are therefore identical to preview (one
// producer) and carry the Motif's transparent backdrop.
//
// The bake runs on the COMPOSITION fps grid — the same grid the Worker's
// Compositor uses when it constructs each `MotifSprite`. The export OUTPUT fps
// may differ; the Worker maps each output-frame time back to a composition
// frame index via `frameIndexInLayer(..., compFps)`, so the bake MUST be keyed
// on comp fps or the indices diverge.
//
// CACHE HYGIENE: this bake produces FRESH bitmaps (a CDP capture, or a
// an on-disk L2 frame) and never reads the in-RAM
// `sharedMotifFrameCache` (L0). Transfer NEUTERS the source ImageBitmap;
// pulling L0 bitmaps would neuter preview's cached frames and break live
// preview after an export. (L2 *disk* reads are safe — they decode to a fresh
// bitmap, not a shared one.)
//
// FRAME MATH: `motifFrameDescriptor` is the single authority for (cacheKey,
// contentFrame, canonicalProps); this module only reconstructs each
// layer-local frame's `tInLayerUs` (`tInLayerUsForLayerLocalFrame`) and asks.
// PROPS: canonicalization goes through the descriptor's LENIENT canonicalizer
// (drop unknown / fill defaults / fall back on invalid) — a deliberate change
// from the earlier STRICT bake, which threw on invalid props and failed the
// whole export. Preview already renders such layers via the same lenient
// path, so export now matches what preview shows instead of rejecting it.

import { frameIndexInLayer, snapFrameFloor } from "../frames";
import type { ProjectSummary, MotifView } from "../ipc";
import { compositionLocalUs, forEachLayerInTime, instanceKey } from "./compositionWalk";
import { getMotif, type Motif } from "./motifs/catalog";
import { bakeMotifFrame } from "./motifs/motifRaster";
import { motifDurationFrames, tInLayerUsForLayerLocalFrame } from "./motifs/motifFrames";
import { sharedBakedKeyIndex, sharedMotifFrameCache } from "./motifs/motifRasterCache";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";

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
          snapFrameFloor(tRootUs, fpsNum, fpsDen) - placed.offsetUs,
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
      durationFrames,
      firstFrame,
      lastFrame,
      tStartUs: layer.t_start_us,
    });
  });
  return out;
}

/// Progress callback: `(baked, total)` cumulative frames across all layers.
export type BakeProgress = (baked: number, total: number) => void;

/// Bake every Motif layer overlapping `[startUs, endUs)` to a per-layer
/// `ImageBitmap[]` indexed by COMPOSITION-frame index. The array is sparse only
/// at the head when the export range starts mid-layer: indices `[0, firstFrame)`
/// are left `undefined` (the Worker never requests them — they're outside the
/// range), so the array's `length` is `lastFrame + 1` and `frames[idx]` is the
/// capture for comp-frame `idx`. The Worker binds `frames[clamp(idx)]`.
///
/// MUST run on the MAIN thread (backend `invoke` / CDP is not available in the
/// Worker). `fpsNum/fpsDen` are the COMPOSITION fps. Captures fresh bitmaps via
/// the CDP path (NOT the shared preview cache — see the module header).
export async function exportBakeMotifs(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
  fpsNum: number,
  fpsDen: number,
  onProgress?: BakeProgress,
): Promise<Record<string, ImageBitmap[]>> {
  const specs = motifLayersToBake(summary, startUs, endUs, fpsNum, fpsDen);
  const result: Record<string, ImageBitmap[]> = {};
  if (specs.length === 0) return result;

  const total = specs.reduce(
    (acc, s) => acc + (s.lastFrame - s.firstFrame + 1),
    0,
  );
  let baked = 0;
  onProgress?.(0, total);

  for (const spec of specs) {
    // Allocate up to lastFrame; leave [0, firstFrame) holes for a mid-layer
    // export start. Bitmaps land at their comp-frame index so the Worker's
    // frames[frameIndexInLayer(...)] is a direct hit.
    const frames: ImageBitmap[] = new Array(spec.lastFrame + 1);
    for (let frame = spec.firstFrame; frame <= spec.lastFrame; frame++) {
      // ONE descriptor per frame is the whole frame math: reconstruct the
      // `tInLayerUs` the compositor will derive for this layer-local slot,
      // then read contentFrame / cacheKey / canonicalProps off the same
      // authority the preview uses. The cacheKey is tInLayerUs-independent
      // (identity/props/size/fps/durationFrames only), so one call per frame
      // serves both the L2 lookup and the capture.
      const desc = motifFrameDescriptor(
        spec.view,
        tInLayerUsForLayerLocalFrame(frame, spec.tStartUs, fpsNum, fpsDen),
        spec.durationUs,
        fpsNum,
        fpsDen,
        spec.motif,
      );
      // Defensive: the descriptor never returns null today.
      if (!desc) continue;
      const contentFrame = desc.contentFrame;
      // Disk-first: persisted frames are keyed by (cacheKey, content frame).
      // The shared reader returns a FRESH bitmap, safe to transfer, from the
      // LZ4 frame cache. Gated by the in-RAM baked-key index so an
      // un-baked Motif never pays a per-frame fs probe. Any read error falls
      // through to a live capture, so a disk hiccup can't blank an export.
      if (sharedBakedKeyIndex.has(desc.cacheKey)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const bitmap = await sharedMotifFrameCache.readBitmap(desc.cacheKey, contentFrame);
          if (bitmap) {
            frames[frame] = bitmap;
            baked++;
            onProgress?.(baked, total);
            continue;
          }
        } catch {
          // fall through to a live CDP capture
        }
      }
      // CDP capture of the hidden Motif host — the SAME producer the preview
      // prewarmer/baker use (manifest size + manifest settle_rafs), so the
      // exported bitmap is pixel-identical to preview AND carries the Motif's
      // transparent backdrop.
      // eslint-disable-next-line no-await-in-loop
      const bitmap = await bakeMotifFrame(spec.motif, contentFrame, fpsNum, fpsDen, desc.canonicalProps);
      frames[frame] = bitmap;
      baked++;
      onProgress?.(baked, total);
    }
    result[spec.layerId] = frames;
  }

  return result;
}
