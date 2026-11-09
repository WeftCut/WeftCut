import { afterEach, expect, it, vi } from 'vitest';
import { MOTIF_BAKE_READY_EVENT, type MotifBakePlan, type MotifBakeSnapshot } from '../../../shared/motifs/baking';
import { groupLayerFixture, ROOT_ID, summaryFixture } from '../../testing/summaryFixture';
import type { LookaheadTarget } from './motifDemand';
import { MotifDemandSession } from './MotifDemandSession';
import { requestPrebake } from './prebakeIntents';

const h = vi.hoisted(() => ({
  warm: vi.fn(), invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('../../bridge/ipc', () => ({ invoke: h.invoke }));
vi.mock('../../bridge/events', () => ({ listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
  h.listeners.set(name, callback); return () => { h.listeners.delete(name); };
} }));
// Main's end of the presence is out of these tests (no page, no frame port).
vi.mock('./frameTransport', async original => ({ ...await original<typeof import('./frameTransport')>(), declareMotifPresence: vi.fn() }));
vi.mock('./MotifPrewarmer', () => ({ MotifPrewarmer: class { setTargets = h.warm; dispose() {} } }));
vi.mock('../../settings/appSettingsStore', () => ({ useAppSettingsStore: {
  getState: () => ({ settings: { prebake_motifs: true } }), subscribe: () => () => {},
} }));

/** How many contents the latest lookahead plan warms. */
const warmedContents = () => new Set((h.warm.mock.lastCall![0] as LookaheadTarget[]).map(t => t.cacheKey)).size;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); h.listeners.clear(); });

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
    h.listeners.get(MOTIF_BAKE_READY_EVENT)!({ payload: { generation, projectId: summary.project_id } });
    await tick(); expect(plans).toHaveLength(2);
    generation++;
    h.listeners.get(MOTIF_BAKE_READY_EVENT)!({ payload: { generation, projectId: summary.project_id } });
    await tick(); expect(plans).toHaveLength(3);
    expect(plans.at(-1)!.generation).toBe(generation);

    requestPrebake('motif'); await tick();
    requestPrebake('motif'); await tick();
    expect(plans).toHaveLength(5);
    expect(plans.at(-1)!.retryKeys).toHaveLength(1);
    expect(warmedContents()).toBe(1);
  } finally { service.dispose(); await tick(); }
});
