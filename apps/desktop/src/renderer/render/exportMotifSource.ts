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
          // Export reads full size. A missing or corrupt frame (null) is
          // captured below; a `MotifTransportError` fails the export instead,
          // because the file is not known to be bad (ADR 0154).
          const bitmap = await sharedMotifFrameCache.readBitmap(desc.cacheKey, desc.contentFrame, 1,
            finalizationToken ? { finalizationToken } : {});
          if (bitmap) return bitmap; // producer closes late results on cancel
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
            spec.motif.manifest.content_hash,
            comp.fps_num, comp.fps_den, { key, high: true,
              bake: { hash: hashCacheKey(desc.cacheKey), frame: desc.contentFrame },
              ...(finalizationToken ? { finalizationToken } : {}) }));
        } finally { signal.removeEventListener("abort", cancel); }
        // Main stores what it captures (ADR 0158). A frame it failed to store
        // stays uncached; export keeps its pixels either way.
        if (persisted && !signal.aborted) sharedBakedKeyIndex.add(desc.cacheKey, desc.contentFrame);
        return bitmap;
      },
    };
  });
}

export function exportMotifPlanner(summary: ProjectSummary, startUs: number, fpsNum: number, fpsDen: number, finalizationToken?: string) {
  return (index: number) => planExportMotifFrame(summary, frameTimeUs(startUs, index, fpsNum, fpsDen), finalizationToken);
}
