import { afterEach, expect, it, vi } from 'vitest';
import { MOTIF_BAKE_READY_EVENT, type MotifBakePlan, type MotifBakeSnapshot } from '../../../shared/motifs/baking';
import { groupLayerFixture, ROOT_ID, summaryFixture } from '../../testing/summaryFixture';
import type { LookaheadTarget } from './motifDemand';
import { MotifDemandSession } from './MotifDemandSession';
import { captureMotif, type MotifCaptureReply } from './frameTransport';
import { acquireMotifFrame, bindMotifFrameWorkspace } from './motifFrameSource';
import { installMotifFrameWorkspaceListener } from './motifFrameWorkspace';
import { requestPrebake } from './prebakeIntents';

const h = vi.hoisted(() => ({
  warm: vi.fn(), invoke: vi.fn(), listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock('../../bridge/ipc', () => ({ invoke: h.invoke }));
vi.mock('../../bridge/events', () => ({ listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
  const listeners = h.listeners.get(name) ?? new Set();
  h.listeners.set(name, listeners);
  listeners.add(callback);
  return () => { listeners.delete(callback); };
} }));
// Main's end of the presence is out of these tests (no page, no frame port).
vi.mock('./frameTransport', async original => ({
  ...await original<typeof import('./frameTransport')>(), declareMotifPresence: vi.fn(), captureMotif: vi.fn(),
}));
vi.mock('./MotifPrewarmer', () => ({ MotifPrewarmer: class { setTargets = h.warm; dispose() {} } }));
vi.mock('../../settings/appSettingsStore', () => ({ useAppSettingsStore: {
  getState: () => ({ settings: { prebake_motifs: true } }), subscribe: () => () => {},
} }));

/** How many contents the latest lookahead plan warms. */
const warmedContents = () => new Set((h.warm.mock.lastCall![0] as LookaheadTarget[]).map(t => t.cacheKey)).size;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ready = (generation: number, projectId: string) => {
  for (const listener of h.listeners.get(MOTIF_BAKE_READY_EVENT) ?? []) listener({ payload: { generation, projectId } });
};
afterEach(() => { bindMotifFrameWorkspace(null); vi.unstubAllGlobals(); vi.clearAllMocks(); h.listeners.clear(); });

it('keeps an in-flight acknowledgement through unrelated edits and redeclares on session readiness', async () => {
  vi.stubGlobal('document', {});
  const layer = groupLayerFixture({ id: 'motif' });
  const { composition_id: _id, composition_label: _label, src_out_us: _out, ...transform } =
    layer.params.kind === 'CompositionRef' ? layer.params : (() => { throw new Error('fixture'); })();
  layer.kind = 'Motif';
  layer.params = { ...transform, kind: 'Motif', motif_id: 'countdown', props: { seconds: 5 } };
  let summary = summaryFixture({ root: { tracks: [{ id: 'track', label: null, kind: 'Video', enabled: true,
    locked: false, muted: false, solo: false, role: null, transient: false, layers: [layer] }] } });
  let generation = 1;
  let finish!: (snapshot: MotifBakeSnapshot) => void;
  let held = true;
  const plans: MotifBakePlan[] = [];
  const snapshot = (): MotifBakeSnapshot => ({ generation, statuses: {}, coverage: {} });
  h.invoke.mockImplementation(async (channel: string, args?: { plan: MotifBakePlan }) => {
    if (channel === 'motif_bake_session') return { generation, projectId: summary.project_id };
    if (channel === 'motif_bake_snapshot') return snapshot();
    if (channel === 'motif_bake_reconcile') {
      plans.push(args!.plan);
      if (held) return new Promise<MotifBakeSnapshot>(resolve => { finish = resolve; });
      return snapshot();
    }
    throw new Error(`Unexpected invocation: ${channel}`);
  });
  const service = new MotifDemandSession({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
    fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0, playing: () => false });
  try {
    service.handleProjectChanged(); await tick();
    expect(plans).toHaveLength(1);
    const calls = h.invoke.mock.calls.length;
    summary = structuredClone(summary); summary.name = 'renamed';
    service.handleProjectChanged(); await tick();
    expect(h.invoke).toHaveBeenCalledTimes(calls);
    held = false; finish(snapshot()); await tick();
    expect(warmedContents()).toBe(1);

    // A failed workspace switch can reopen admission with the SAME generation.
    // The input guard must not swallow this recovery or the later new session.
    ready(generation, summary.project_id);
    await tick(); expect(plans).toHaveLength(2);
    generation++;
    ready(generation, summary.project_id);
    await tick(); expect(plans).toHaveLength(3);
    expect(plans.at(-1)!.generation).toBe(generation);

    requestPrebake('motif'); await tick();
    requestPrebake('motif'); await tick();
    expect(plans).toHaveLength(5);
    expect(plans.at(-1)!.retryKeys).toHaveLength(1);
    expect(warmedContents()).toBe(1);
  } finally { service.dispose(); await tick(); }
});

it.each(['first open', 'remount'])('keeps the export capture through Preview %s in the same workspace', async (opening) => {
  vi.stubGlobal('document', {});
  const summary = summaryFixture();
  const generation = 1;
  const plans = vi.fn();
  h.invoke.mockImplementation(async (channel: string, args?: { plan: MotifBakePlan }) => {
    if (channel === 'motif_bake_session') return { generation, projectId: summary.project_id };
    if (channel === 'motif_bake_reconcile') {
      plans(args!.plan);
      return { generation, statuses: {}, coverage: {} } satisfies MotifBakeSnapshot;
    }
    throw new Error(`Unexpected invocation: ${channel}`);
  });
  const stopWorkspace = await installMotifFrameWorkspaceListener();
  const openPreview = () => {
    const preview = new MotifDemandSession({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0, playing: () => false });
    preview.handleProjectChanged();
    return preview;
  };
  let preview: MotifDemandSession | undefined;
  const abort = new AbortController();
  try {
    if (opening === 'remount') {
      preview = openPreview();
      await vi.waitFor(() => expect(plans).toHaveBeenCalledTimes(1));
      plans.mockClear();
    }
    let finish!: (reply: MotifCaptureReply) => void;
    const cancel = vi.fn();
    vi.mocked(captureMotif).mockImplementation(() => ({
      reply: new Promise(resolve => { finish = resolve; }), setPriority: vi.fn(), cancel,
    }));
    const { lease } = acquireMotifFrame({
      cacheKey: 'export-frame', motifId: 'countdown', contentHash: 'content', fpsNum: 30, fpsDen: 1,
      contentFrame: 0, contentDurationFrames: 30, contentDurationUs: 1_000_000, srcInUs: 0,
      renderW: 4, renderH: 4, canonicalProps: { seconds: 1 }, tSec: 0, overlayActive: false,
    }, { purpose: 'export', finalizationToken: 'export-plan', scaleDiv: 1, priority: 'current', signal: abort.signal });
    void lease.catch(() => {});
    await vi.waitFor(() => expect(captureMotif).toHaveBeenCalledOnce());

    preview?.dispose();
    ready(generation, summary.project_id);
    preview = openPreview();
    await vi.waitFor(() => expect(plans).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ generation })));
    expect(cancel).not.toHaveBeenCalled();

    const bitmap = { width: 4, height: 4, close: vi.fn() } as unknown as ImageBitmap;
    finish({ kind: 'pixels', bitmap, persisted: false });
    const frame = await lease;
    expect(frame.bitmap).toBe(bitmap);
    frame.release();
  } finally {
    preview?.dispose();
    abort.abort();
    stopWorkspace();
  }
});
