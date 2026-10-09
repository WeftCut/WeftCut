// The live per-frame producer for Motifs: captures one frame through the
// webcap CDP path, bumping the same perf instrument so existing e2e
// render-count assertions keep working.
import { captureMotifFrame } from "./host";
import type { Motif } from "./catalog";

export async function rasterMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
  contentHash?: string,
  coalesceKey?: string,
  fpsNum?: number,
  fpsDen?: number,
): Promise<ImageBitmap> {
  if (typeof window !== "undefined") {
    const perf = (window as unknown as { __weftcutMotifPerf?: { renders: number } })
      .__weftcutMotifPerf;
    if (perf) perf.renders++;
  }
  return captureMotifFrame(motifId, tSec, props, width, height, settleRafs, contentHash, coalesceKey, fpsNum, fpsDen);
}

/// Portable direct-capture helper, at the motif's manifest size. The editor's
/// background preparation runs in main and persists without sending pixels;
/// this helper always captures. `tSec = frame * fpsDen/fpsNum`;
/// the fps pair is also forwarded so the capture's `meta.fps` names the same
/// rate the frame grid was computed on.
export function bakeMotifFrame(
  motif: Motif,
  frame: number,
  fpsNum: number,
  fpsDen: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  const [w, h] = motif.manifest.size;
  return rasterMotifFrame(motif.manifest.id, (frame * fpsDen) / fpsNum, canonicalProps, w!, h!, motif.manifest.settle_rafs, motif.manifest.content_hash, undefined, fpsNum, fpsDen);
}
