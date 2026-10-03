// Application session wiring. Preview panels borrow this owner, never create
// or dispose it. Store subscriptions keep audio current with no canvas mounted.
import { convertFileSrc } from "@/bridge/ipc";
import { AudioGraph } from "./AudioGraph";
import { PreviewAudioEngine } from "./PreviewAudioEngine";
import { useProjectStore } from "../../state/projectStore";
import { previewRenderTargetId, useCompositionAnchorStore } from "../../state/compositionAnchorStore";
import { previewLocalUs, setPlayheadFromPreview } from "../../state/playheadProjection";
import { playheadTimeUs } from "../../state/playheadStore";
import { layerFxState, readyAudioPath, useAudioFxStore } from "../../state/audioFxStore";
import { registerTransport, releaseTransport, setTransportSnapshot } from "../../state/playbackStore";
import { subscribeRoleGainOverrides } from "./roleGainOverrides";
import { prepareRetimedAudio, reportAudioMeter } from "../../ipc";
import { clearMasterMeter, publishMasterMeter, publishMasterMeterSilent,
  publishRoleMeters, publishRoleMetersSilent, roleMeterDemandWanted,
  subscribeRoleMeterDemand } from "../../state/masterMeterStore";

let current: PreviewAudioEngine | null = null;
export function activePreviewAudioEngine(): PreviewAudioEngine | null { return current; }
export function previewAudioEngine(): PreviewAudioEngine {
  // Pixi's asynchronous init may finish before App's passive mount effect.
  // Creation is lazy, but disposal belongs exclusively to the App session.
  current ??= new PreviewAudioEngine(new AudioGraph(), (layerId, mediaId) => {
    const path = readyAudioPath(layerFxState(layerId)) ?? useProjectStore.getState().mediaById.get(mediaId)?.conform_path;
    return path ? convertFileSrc(path) : null;
  }, async (compositionId, signal) => {
    while (true) {
      signal.throwIfAborted();
      const result = await prepareRetimedAudio(compositionId);
      signal.throwIfAborted();
      if (!result.waiting) return result.stems.map(s => ({ ...s, url: convertFileSrc(s.path) }));
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  });
  return current;
}

export function startPreviewAudioSession(): () => void {
  const engine = previewAudioEngine();
  let stopped = false;
  let syncing = false;
  let target: string | null | undefined;
  let projectId: string | null | undefined;
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  const sync = (): void => {
    if (stopped) return;
    const summary = useProjectStore.getState().summary;
    const nextTarget = previewRenderTargetId();
    const nextProjectId = summary?.project_id ?? null;
    const retarget = target !== nextTarget || projectId !== nextProjectId;
    const position = previewLocalUs(playheadTimeUs());
    syncing = true;
    try {
      engine.setProject(summary, nextTarget);
      if (retarget) engine.seek(projectId !== undefined && projectId !== nextProjectId ? 0 : position);
      target = nextTarget; projectId = nextProjectId;
    } finally { syncing = false; }
  };
  const syncMeters = (): void => {
    const wanted = engine.isPlaying() && roleMeterDemandWanted();
    if (wanted && meterTimer === null) meterTimer = setInterval(() => {
      const now = performance.now();
      publishMasterMeter(engine.graph.meterSnapshot(), now);
      publishRoleMeters(engine.graph.roleMeterSnapshots(), now);
    }, 50);
    if (!wanted && meterTimer !== null) { clearInterval(meterTimer); meterTimer = null; }
    if (!engine.isPlaying()) { publishMasterMeterSilent(); publishRoleMetersSilent(); }
  };
  const cleanups = [
    engine.onTimeUpdate((tUs) => { if (!syncing) setPlayheadFromPreview(tUs); }),
    engine.onStateChange((state) => { setTransportSnapshot(state); syncMeters(); }),
    useProjectStore.subscribe(sync),
    useCompositionAnchorStore.subscribe(() => {
      // Orphan moment writes also notify this store. Only a target change
      // retargets playback; otherwise an emitted moment would seek itself.
      if (previewRenderTargetId() !== target) sync();
    }),
    useAudioFxStore.subscribe(() => engine.refresh()),
    subscribeRoleGainOverrides(() => engine.refresh()),
    subscribeRoleMeterDemand(syncMeters),
  ];
  sync();
  registerTransport(engine);
  setTransportSnapshot(engine.snapshot());
  syncMeters();
  const reportTimer = setInterval(() => {
    if (!engine.isPlaying()) return;
    const meter = engine.graph.meterSnapshot();
    void reportAudioMeter({ rmsDb: Number.isFinite(meter.rmsDb) ? meter.rmsDb : -120,
      peakDb: Number.isFinite(meter.peakDb) ? meter.peakDb : -120 }).catch(() => {});
  }, 500);
  return () => {
    stopped = true;
    cleanups.forEach((cleanup) => cleanup());
    clearInterval(reportTimer);
    if (meterTimer !== null) clearInterval(meterTimer);
    releaseTransport(engine);
    engine.dispose();
    clearMasterMeter();
    if (current === engine) current = null;
  };
}
