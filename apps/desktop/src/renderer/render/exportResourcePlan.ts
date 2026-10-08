import { resourceAllocation } from '../../shared/resource-policy';
import { resourceBlockError } from '../../shared/export-resources';
import type { MediaSummary, ProjectSummary } from '../ipc';
import type { ExportDecodeRouting } from './exportDecodeRouting';
import { rootCompositionOf } from '../ipc/compositions';
import { selectActiveVideoLayers } from './activeVideoLayers';
import { exportHandleKey } from './decoder/ExportDecoderPool';
import { openMediaInput } from './decoder/mediaInput';
import { resolveDecode } from './decodeRoute';
import { convertFileSrc } from '@/bridge/ipc';
import { tenBitExportCapable } from './exportSettings';
import { forEachLayerInTime, instanceKey } from './compositionWalk';
import { motifLayersToBake } from './exportBake';
import { acquireExportResources, exportBufferBytes } from './resourceClient';
import { EXPORT_FRAME_WINDOW, exportDecoderMiB, minimumExportFrames, type ExportResourcePlan } from '../../shared/export-resources';

export interface ExportSourceDemand { width: number; height: number; tenBit: boolean; minimumFrames: number; nativeMiB?: number }
export interface ExportActiveDemand { key: string; mediaId: string; start: number; end: number }

/** Half-open spans and shared decoder identities use the same semantics as
 * production. Sequential clips pay for one window, true overlaps pay for both. */
export function peakDecoderMiB(clips: ExportActiveDemand[], memory: Record<string, number>): number {
  const events = clips.flatMap(c => [{ at:c.start, delta:1, ...c }, { at:c.end, delta:-1, ...c }])
    .filter(c => c.end > c.start).sort((a,b) => a.at-b.at || a.delta-b.delta);
  const live = new Map<string, number>(); let used=0, peak=0;
  for (const event of events) {
    const before=live.get(event.key) ?? 0, after=before+event.delta;
    live.set(event.key,after);
    if (!before && after) used += memory[event.mediaId]!;
    if (before && !after) used -= memory[event.mediaId]!;
    peak=Math.max(peak,used);
  }
  return peak;
}

export function buildExportResourcePlans(input: {
  sources: Record<string, ExportSourceDemand>; clips: ExportActiveDemand[];
  workerMiB: number; encoderMiB: number; motifBufferBytes: number; captureMiB?: number; motifFrameBytes?: number;
}): ExportResourcePlan[] {
  const plans: ExportResourcePlan[]=[];
  for (const fraction of [0, .5, 1]) {
    const frameWindows: Record<string,number>={}, memory: Record<string,number>={};
    for (const [id,source] of Object.entries(input.sources)) {
      const frames=Math.max(source.minimumFrames, Math.ceil(EXPORT_FRAME_WINDOW-(EXPORT_FRAME_WINDOW-source.minimumFrames)*fraction));
      frameWindows[id]=frames;
      memory[id]=source.nativeMiB ?? exportDecoderMiB(source.width,source.height,source.tenBit,frames);
    }
    const motifFrames = 3 - fraction * 2;
    const motifBufferBytes = Math.ceil(input.motifBufferBytes * (1-fraction) + (input.motifFrameBytes ?? input.motifBufferBytes) * fraction);
    const workerMiB = Math.ceil(input.workerMiB + (motifBufferBytes-input.motifBufferBytes)/1048576);
    const memoryMiB=Math.max(64, workerMiB+input.encoderMiB+motifFrames*(input.captureMiB ?? 0)+peakDecoderMiB(input.clips,memory));
    if (!plans.some(p => p.memoryMiB === memoryMiB)) plans.push({ memoryMiB, workerMiB, motifBufferBytes, motifFrames, frameWindows });
  }
  return plans;
}

/** Metadata-only preflight: no decoder, canvas, encoder or video worker exists
 * yet. Read the actual decode target's coded dimensions and AVC level; persisted
 * display dimensions are not sufficient for a safe allocation. */
export async function prepareExportResourcePlans(input: {
  summary: ProjectSummary; media: ReadonlyMap<string, MediaSummary>; routing?: ExportDecodeRouting | undefined;
  startUs: number; endUs: number; bitDepth: 8|10; nativeEncoder: boolean;
  outputWidth: number; outputHeight: number; signal: AbortSignal;
}): Promise<ExportResourcePlan[]> {
  const comp=rootCompositionOf(input.summary);
  const clips=selectActiveVideoLayers(input.summary,input.startUs,input.endUs-1).map(l => ({
    key:exportHandleKey(l.mediaId,l.srcInUs,l.tStartUs,l.rate), mediaId:l.mediaId,
    start:Math.max(input.startUs,l.tStartUs), end:Math.min(input.endUs,l.tEndUs),
  }));
  const sources: Record<string,ExportSourceDemand>={};
  for (const id of new Set(clips.map(c => c.mediaId))) {
    input.signal.throwIfAborted();
    const media=input.media.get(id); if (!media) throw new Error(`Missing export source: ${id}`);
    const native=input.routing?.routes[id];
    const tenBit=input.bitDepth===10 && tenBitExportCapable(media);
    const releaseMetadata = await acquireExportResources(16, 0, undefined, input.signal);
    try {
    if (native?.engine==='native') {
      sources[id]={width:0,height:0,tenBit,minimumFrames:24,nativeMiB:await window.api.resources.estimateDecoder(native.sourcePath)};
    } else {
      const path=tenBit ? media.path : resolveDecode(media).exportPath;
      if (!path) throw new Error(`Export source is not ready: ${media.label}`);
      const opened=await openMediaInput(convertFileSrc(path),input.signal);
      try {
        const config=await opened.videoTrack.getDecoderConfig();
        if (!config?.codedWidth || !config.codedHeight) throw new Error(`Missing coded dimensions: ${media.label}`);
        sources[id]={width:config.codedWidth,height:config.codedHeight,tenBit,minimumFrames:minimumExportFrames(config)};
      } finally { opened.dispose(); }
    }
    } finally { releaseMetadata(); }
  }
  input.signal.throwIfAborted();
  const pixels=comp.width*comp.height*(input.bitDepth===10?8:4);
  const motifs=motifLayersToBake(input.summary,input.startUs,input.endUs,comp.fps_num,comp.fps_den);
  const hasMotifs=motifs.length>0;
  // Each producer frame has at most one capture in flight plus one GPU lane.
  const captureMiB=Math.max(0,...motifs.map(m => {
    const bytes=m.motif.manifest.size[0]*m.motif.manifest.size[1]*4;
    return Math.ceil(16+bytes*4/1048576)+Math.ceil(bytes/1048576);
  }));
  const motifBytes=Object.fromEntries(motifs.map(m => [m.layerId,m.motif.manifest.size[0]*m.motif.manifest.size[1]*8]));
  const motifSpans: ExportActiveDemand[]=[];
  forEachLayerInTime(input.summary,input.summary.root_id,input.startUs,input.endUs,0,placed => {
    const key=instanceKey(placed.path,placed.layer.id);
    if (motifBytes[key]) motifSpans.push({key,mediaId:key,start:placed.tStartUs,end:placed.tEndUs});
  });
  const motifFrameBytes=peakDecoderMiB(motifSpans,motifBytes);
  const motifBufferBytes=hasMotifs?Math.max(motifFrameBytes,pixels,Math.floor(exportBufferBytes()/2)):0;
  const plans=buildExportResourcePlans({ sources,clips,motifBufferBytes,captureMiB,motifFrameBytes,
    workerMiB:Math.ceil(64+(pixels*8+motifBufferBytes)/1048576),
    encoderMiB:input.nativeEncoder?128+Math.ceil(input.outputWidth*input.outputHeight*32/1048576):0,
  });
  const minimum=Math.min(...plans.map(p => p.memoryMiB)), work=resourceAllocation().work_mib;
  if (minimum>work) throw resourceBlockError({kind:'blocked',reason:'budget-too-small',requestedMiB:minimum,availableMiB:work,workMiB:work,revision:0});
  return plans;
}
