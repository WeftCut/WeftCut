import type { ProjectSummary } from "../ipc";
import { rootCompositionOf } from "../ipc/compositions";
import { snapFrameFloor } from "../frames";
import { motifLayersToBake } from "./exportBake";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";
import { tInLayerUsForLayerLocalFrame } from "./motifs/motifFrames";
import { acquireMotifFrame } from "./motifs/motifFrameSource";
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
        // Full size, read through the export's finalization or captured and
        // kept by main (ADR 0158). A transport error fails the export: the
        // file is not known to be bad (ADR 0154). A frame main failed to
        // store stays uncached and the export keeps its pixels.
        const lease = await acquireMotifFrame(desc, {
          scaleDiv: 1, priority: 'current', signal, purpose: 'export',
          ...(finalizationToken ? { finalizationToken } : {}),
        }).lease;
        // The stream owns the bitmap from here: it transfers or closes it.
        return lease.bitmap;
      },
    };
  });
}

export function exportMotifPlanner(summary: ProjectSummary, startUs: number, fpsNum: number, fpsDen: number, finalizationToken?: string) {
  return (index: number) => planExportMotifFrame(summary, frameTimeUs(startUs, index, fpsNum, fpsDen), finalizationToken);
}
