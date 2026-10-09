import type { ProjectSummary } from "../ipc";
import { rootCompositionOf } from "../ipc/compositions";
import { snapFrameFloor } from "../frames";
import { motifLayersToBake } from "./exportBake";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";
import { tInLayerUsForLayerLocalFrame } from "./motifs/motifFrames";
import { captureMotifFrameResult } from "./motifs/host";
import { controlStoredMotifCapture } from "./motifs/frameTransport";
import { hashCacheKey } from "./motifs/frameCache";
import { sharedBakedKeyIndex, sharedMotifFrameCache } from "./motifs/motifRasterCache";
import { frameTimeUs } from "./worker/frameGrid";
import type { MotifReadTask } from "./worker/motifStream";

/** Uses the same composition-frame selection as the compositor, including
 * nested Group instances, trimmed ranges, held tails and output-fps changes.
 * Planning allocates metadata only; the producer admits reads by byte budget. */
export function planExportMotifFrame(
  summary: ProjectSummary, tUs: number, finalizationToken?: string,
): MotifReadTask[] {
  const comp = rootCompositionOf(summary);
  const t = snapFrameFloor(tUs, comp.fps_num, comp.fps_den);
  return motifLayersToBake(summary, t, t + 1, comp.fps_num, comp.fps_den).map(spec => {
    const desc = motifFrameDescriptor(spec.view,
      spec.sampleLocalUs ?? tInLayerUsForLayerLocalFrame(spec.firstFrame, spec.tStartUs, comp.fps_num, comp.fps_den),
      spec.durationUs, comp.fps_num, comp.fps_den, spec.motif)!;
    return {
      layerId: spec.layerId, frame: spec.firstFrame,
      bytes: desc.renderW * desc.renderH * 4,
      async read(signal) {
        signal.throwIfAborted();
        if (sharedBakedKeyIndex.has(desc.cacheKey)) {
          try {
            const bitmap = await sharedMotifFrameCache.readBitmap(desc.cacheKey, desc.contentFrame, finalizationToken);
            if (bitmap) return bitmap; // producer closes late results on cancel
          } catch { /* missing/corrupt cache: produce the required pixels */ }
        }
        signal.throwIfAborted();
        const key = `export-motif:${crypto.randomUUID()}`;
        const cancel = () => controlStoredMotifCapture({ key, action: "cancel" });
        signal.addEventListener("abort", cancel, { once: true });
        let bitmap: ImageBitmap;
        let persisted: boolean;
        try {
          ({ bitmap, persisted } = await captureMotifFrameResult(spec.motif.manifest.id,
            desc.tSec, desc.canonicalProps, desc.renderW, desc.renderH,
            spec.motif.manifest.settle_rafs, spec.motif.manifest.content_hash,
            comp.fps_num, comp.fps_den, { key, high: true,
              bake: { hash: hashCacheKey(desc.cacheKey), frame: desc.contentFrame }, bakeOptional: true,
              ...(finalizationToken ? { finalizationToken } : {}) }));
        } finally { signal.removeEventListener("abort", cancel); }
        if (persisted) {
          if (!signal.aborted) sharedBakedKeyIndex.add(desc.cacheKey, desc.contentFrame);
          return bitmap;
        }
        // Cache is an optimization: failure must never discard valid pixels.
        // Native capture persists during the existing OSR lease; only portable
        // capture or unavailable native readback needs this PNG compatibility path.
        // Await within the read reservation so writes cannot build an unbounded queue.
        if (!signal.aborted) {
          let canvas: OffscreenCanvas | undefined;
          try {
            canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Motif cache canvas unavailable");
            ctx.drawImage(bitmap, 0, 0);
            const png = await canvas.convertToBlob({ type: "image/png" });
            if (!signal.aborted) {
              await sharedMotifFrameCache.writeFrame(desc.cacheKey, desc.contentFrame, png);
              sharedBakedKeyIndex.add(desc.cacheKey, desc.contentFrame);
            }
          } catch (error) {
            console.warn("[weftcut/export] Motif cache write skipped:", error);
          } finally { if (canvas) canvas.width = canvas.height = 0; }
        }
        return bitmap;
      },
    };
  });
}

export function exportMotifPlanner(summary: ProjectSummary, startUs: number, fpsNum: number, fpsDen: number, finalizationToken?: string) {
  return (index: number) => planExportMotifFrame(summary, frameTimeUs(startUs, index, fpsNum, fpsDen), finalizationToken);
}
