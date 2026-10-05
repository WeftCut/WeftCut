import { Application, GlobalResourceRegistry } from 'pixi.js';
import { PLAYBACK_CALIBRATION as protocol, playbackCalibrationRecommendation, type PlaybackCalibrationCell } from '../../shared/playback-calibration';
import { APP_SETTINGS_DEFAULTS } from '../../shared/app-settings';
import { Compositor } from '../render/Compositor';
import { PlaybackEngine } from '../render/PlaybackEngine';
import { AudioGraph } from '../render/audio/AudioGraph';
import { PreviewAudioEngine } from '../render/audio/PreviewAudioEngine';
import { installPreviewPresentation } from '../render/installPreviewPresentation';
import { webgpuDeviceOf } from '../render/webgpuDevice';
import { setSlotFenceBackend, sharedSlotFenceQueue } from '../render/decoder/transports/slotFenceQueue';
import { resetFfmpegCapabilitySession } from '../render/decoder/ffmpegCapability';
import { liveFrameRingCount } from '../render/decoder/frameRingBudget';
import { useAppSettingsStore } from '../settings/appSettingsStore';
import { initEval } from '../eval';
import { calibrationScene, type CalibrationFixture } from './scene';

type Device = { streamId: string; adapter: { name: string; vendorId: number; deviceId: number; luid: string } | null };
type Cell = PlaybackCalibrationCell & { wallMs?: number; dropped?: number; late?: number; anomalyRatio?: number;
  maxHeldMs?: number; consumedFrames?: number[]; devices?: Device[]; readyMs?: number; cleanupMs?: number;
  startPositionUs?: number; endPositionUs?: number; submittedFrames?: number; observations?: Array<{ elapsedMs: number; dropped: number;
    late: number; maxHeldMs: number; consumedFrames: number[] }> };
const report: { protocol: typeof protocol; cells: Cell[]; state: string; error?: string; elapsedMs?: number;
  recommendation?: ReturnType<typeof playbackCalibrationRecommendation>; fixture?: CalibrationFixture;
  renderer?: number; preparationMs?: number } = {
  protocol, cells: protocol.counts.map(count => ({ count, status: 'not-run', reasons: [] })), state: 'preparing',
};
// Purpose-built developer entry, never installed in a normal editor renderer.
Object.assign(window, { __calibrationReport: report });
const publish = () => window.api.backend.invoke('calibration_publish', report).catch(() => {});
const publishing = setInterval(() => { void publish(); }, 500);
const label = document.getElementById('status')!;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const begin = performance.now();
  while (!(await check())) {
    if (performance.now() - begin > timeoutMs) throw new Error('Calibration readiness/reset timeout');
    await sleep(25);
  }
}

async function run(): Promise<void> {
  const begin = performance.now();
  const input = await window.api.backend.invoke('calibration_input') as { fixture: CalibrationFixture; protocol: typeof protocol };
  if (JSON.stringify(input.protocol) !== JSON.stringify(protocol)) throw new Error('Calibration renderer build is stale');
  const { fixture } = input;
  report.fixture = fixture;
  if (fixture.width !== protocol.width || fixture.height !== protocol.height || fixture.fps !== protocol.fps
    || fixture.durationUs !== protocol.durationUs) throw new Error('Fixture does not match the fixed protocol');
  await initEval();
  useAppSettingsStore.getState().hydrate({ ...APP_SETTINGS_DEFAULTS, performance: protocol.performance,
    decode_engine: 'ffmpeg', playback_resolution: 'full' });
  const app = new Application();
  await app.init({ width: protocol.width, height: protocol.height, resolution: protocol.outputWidth / protocol.width,
    background: 0x000000, antialias: true, preference: 'webgpu' });
  document.getElementById('surface')!.appendChild(app.canvas);
  installPreviewPresentation(app);
  report.renderer = app.renderer.type;
  report.preparationMs = performance.now() - begin;
  let expectedDevice: string | undefined;
  try {
    for (const cell of report.cells) {
      label.textContent = `H.264 · 4K · 60 fps — ${cell.count}/8 simultaneous videos`;
      report.state = 'running';
      if (document.hidden) throw new Error('Test surface is hidden');
      resetFfmpegCapabilitySession();
      const scene = calibrationScene(fixture, cell.count);
      const compositor = new Compositor({ app, width: protocol.width, height: protocol.height, mode: 'preview',
        resolveSource: () => ({ engine: 'ffmpeg', source: 'original', status: 'ok', target: fixture.path,
          key: `ffmpeg:original:${fixture.path}` }),
        originalAssetUrl: () => null, sourceColor: () => ({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }),
        mediaById: id => scene.media.find(m => m.id === id) });
      const graph = new AudioGraph();
      const audio = new PreviewAudioEngine(graph, () => null);
      audio.setProject(scene, scene.root_id);
      compositor.setProject(scene, scene.root_id);
      compositor.setPlaybackScaleDiv(1);
      const engine = new PlaybackEngine({ compositor, ticker: app.ticker, audio });
      const probes = () => Array.from({ length: cell.count }, (_, i) => compositor.activeClipProbe(`video-${i}`));
      let observe: (() => void) | undefined;
      try {
        const readyBegin = performance.now();
        await until(() => probes().every(p => p?.sourceKind === 'native-gpu' && p.spriteBound && p.spriteStaged), 15_000);
        cell.readyMs = performance.now() - readyBegin;
        const devices = await window.api.backend.invoke('calibration_devices') as Device[];
        if (devices.length !== cell.count || devices.some(d => !d.adapter)) throw new Error('Actual decoder GPU identity unavailable');
        expectedDevice ??= devices[0]!.adapter!.luid;
        if (devices.some(d => d.adapter!.luid !== expectedDevice)) throw new Error('Decoder GPU changed');
        cell.devices = devices;
        engine.seek(protocol.startUs);
        engine.play();
        await until(() => engine.isPlaying(), 5000);
        await sleep(protocol.warmupMs);
        cell.startPositionUs = engine.positionUs();
        if (cell.startPositionUs + protocol.sampleMs * 1000 >= fixture.durationUs) throw new Error('Insufficient source duration for sampling');
        const baseline = compositor.getPerfSnapshot();
        const before = baseline.underrun;
        const beforeSubmit = baseline.sync?.samples;
        if (beforeSubmit == null) throw new Error('Presentation telemetry unavailable');
        const start = performance.now();
        const lastPts = probes().map(p => p?.boundFramePtsUs ?? null);
        const lastChanged = lastPts.map(() => start);
        const consumed = lastPts.map(() => 0);
        let maxHeldMs = 0;
        cell.observations = [];
        const invalid = new Set<string>();
        observe = () => {
          const now = performance.now();
          const ps = probes();
          for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            if (!p || p.sourceKind !== 'native-gpu' || !p.spriteStaged || !p.spriteBound) {
              invalid.add(`Layer ${i}: route=${p?.sourceKind}, staged=${p?.spriteStaged}, bound=${p?.spriteBound}`);
            }
            maxHeldMs = Math.max(maxHeldMs, now - lastChanged[i]!);
            if (p?.boundFramePtsUs != null && p.boundFramePtsUs !== lastPts[i]) {
              consumed[i]!++;
              lastPts[i] = p.boundFramePtsUs;
              lastChanged[i] = now;
            }
          }
          if (document.hidden) invalid.add('Test surface was hidden');
          const elapsedMs = now - start;
          if (elapsedMs >= (cell.observations!.length + 1) * 1000) {
            const snapshot = compositor.getPerfSnapshot().underrun;
            cell.observations!.push({ elapsedMs, dropped: snapshot.droppedFrames - before.droppedFrames,
              late: snapshot.lateFrames - before.lateFrames, maxHeldMs, consumedFrames: [...consumed] });
          }
        };
        app.ticker.add(observe, undefined, -30);
        await sleep(protocol.sampleMs);
        observe();
        const elapsed = performance.now() - start;
        cell.endPositionUs = engine.positionUs();
        const submitted = compositor.getPerfSnapshot().sync?.samples;
        if (submitted == null) invalid.add('Presentation telemetry unavailable');
        cell.submittedFrames = (submitted ?? beforeSubmit) - beforeSubmit;
        if (cell.submittedFrames === 0) invalid.add('No frames submitted for presentation');
        if (!engine.isPlaying() || cell.endPositionUs <= cell.startPositionUs) invalid.add('Playback clock stopped');
        const after = compositor.getPerfSnapshot().underrun;
        const dropped = after.droppedFrames - before.droppedFrames;
        const late = after.lateFrames - before.lateFrames;
        const anomalyRatio = (dropped + late) / (elapsed / 1000 * protocol.fps);
        const endDevices = await window.api.backend.invoke('calibration_devices') as Device[];
        if (endDevices.length !== cell.count || endDevices.some(d => d.adapter?.luid !== expectedDevice)) invalid.add('Decoder device or session count changed');
        Object.assign(cell, { wallMs: elapsed, dropped, late, anomalyRatio, maxHeldMs, consumedFrames: consumed });
        if (invalid.size) {
          cell.status = 'invalid'; cell.reasons.push(...invalid);
        } else {
          if (consumed.some(n => n === 0)) cell.reasons.push('A decoded video did not advance during sampling');
          if (anomalyRatio > protocol.maxAnomalyRatio) cell.reasons.push('Dropped/late frame frequency exceeds experimental threshold');
          if (maxHeldMs > protocol.maxHeldMs) cell.reasons.push('Continuous frame hold exceeds experimental threshold');
          cell.status = cell.reasons.length ? 'slow' : 'pass';
        }
      } catch (error) {
        cell.status = 'invalid'; cell.reasons.push(String(error));
      } finally {
        if (observe) app.ticker.remove(observe);
        const cleanup = performance.now();
        engine.pause(); engine.dispose(); audio.dispose(); compositor.dispose();
        await until(async () => (await window.api.previewGpu.budget()).sessions.used === 0
          && liveFrameRingCount() === 0 && sharedSlotFenceQueue().pendingCount() === 0, 10_000);
        cell.cleanupMs = performance.now() - cleanup;
      }
    }
    report.recommendation = playbackCalibrationRecommendation(report.cells);
    report.state = 'complete';
  } finally {
    const device = webgpuDeviceOf(app.renderer);
    setSlotFenceBackend(null);
    app.destroy(true, { children: true });
    GlobalResourceRegistry.release();
    device?.destroy();
    report.elapsedMs = performance.now() - begin;
  }
}
void run().catch(error => { report.state = 'error'; report.error = String(error); }).finally(async () => {
  clearInterval(publishing);
  await publish();
  label.textContent = report.state === 'complete' ? 'Calibration complete — experimental report' : 'Calibration stopped';
  document.getElementById('result')!.textContent = JSON.stringify(report, null, 2);
});
