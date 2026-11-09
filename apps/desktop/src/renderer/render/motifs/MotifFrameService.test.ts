import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnimTrack, LayerSummary, TrackSummary } from '../../ipc';
import { compositionFixture, groupLayerFixture, ROOT_ID, summaryFixture } from '../../testing/summaryFixture';
import type { PrewarmContentSpec } from './MotifPrewarmer';
import { MotifFrameService } from './MotifFrameService';
import { requestPrebake } from './prebakeIntents';
import { sharedBakedKeyIndex } from './motifFrameSource';
import { useMotifBakeStatusStore } from '../../timeline/motifBakeStatusStore';
import { syncUserMotifsFromBackend } from './syncCatalog';
import { setUserMotifs } from './catalog';

const { warm, bake, state } = vi.hoisted(() => ({ warm: vi.fn(), bake: vi.fn(), state: { generation: 0, automatic: true, fail: false, publish: () => {},
  coverage: {} as Record<string, number[]>, statuses: {} as Record<string, object> } }));
vi.mock('./MotifPrewarmer', () => ({ MotifPrewarmer: class {
  setTargets = warm; dispose() {}
} }));
vi.mock('./bakeClient', () => ({ MotifBakeClient: class {
  generation = ++state.generation;
  constructor(private changed: (value: unknown) => void, private failed: (error: unknown) => void) {
    state.publish = () => this.changed({ generation: this.generation, statuses: state.statuses, coverage: state.coverage });
  }
  reconcile(projectId: string, plan: (session: unknown) => unknown) {
    bake(plan({ projectId, generation: this.generation }));
    if (state.fail) { this.failed(new Error('disconnected')); return; }
    this.changed({ generation: this.generation, statuses: state.statuses, coverage: state.coverage });
  }
  invalidate() {} dispose() {}
} }));
vi.mock('./syncCatalog', () => ({ syncUserMotifsFromBackend: vi.fn(async () => {}) }));
vi.mock('../../settings/appSettingsStore', () => ({
  useAppSettingsStore: { getState: () => ({ settings: { prebake_motifs: state.automatic } }), subscribe: () => () => {} },
}));

const stat = (value: number): AnimTrack<number> => ({ mode: 'Static', value });
const motif = (id: string, start: number, end: number): LayerSummary => ({
  ...groupLayerFixture({ id, tStartUs: start, tEndUs: end }), kind: 'Motif',
  params: { kind: 'Motif', motif_id: 'countdown', src_in_us: 0, props: { seconds: 5 },
    x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), rotation_deg: stat(0),
    anchor_x: stat(0.5), anchor_y: stat(0.5), opacity: stat(1), scale_linked: true },
});
const track = (layers: LayerSummary[]): TrackSummary => ({
  id: 'track', kind: 'Video', label: null, enabled: true, locked: false,
  muted: false, solo: false, role: null, transient: true, layers,
});
const targets = () => warm.mock.lastCall![0] as PrewarmContentSpec[];
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); state.automatic = true; state.fail = false; state.coverage = {}; state.statuses = {}; });

describe('MotifFrameService prewarm admission', () => {
  it('does not replan or reset warming for marker and visual-only edits', () => {
    vi.stubGlobal('document', {});
    let summary = summaryFixture({ root: { tracks: [track([motif('clip', 0, 2_000_000)])] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0 });
    try {
      service.handleProjectChanged();
      const warmCalls = warm.mock.calls.length;
      summary = structuredClone(summary);
      summary.compositions[ROOT_ID]!.markers.push({ id: 'cue', label: 'Cue', t_us: 100_000,
        end_t_us: null, note: '', color_hint: '#fff', anchor_layer: null, anchor_src_us: null, hibernating: false });
      const clip = summary.compositions[ROOT_ID]!.tracks[0]!.layers[0]!;
      clip.label = 'Renamed';
      if (clip.params.kind === 'Motif') clip.params.x = stat(200);
      service.handleProjectChanged();
      expect(bake).toHaveBeenCalledOnce();
      expect(warm).toHaveBeenCalledTimes(warmCalls);
    } finally { service.dispose(); }
  });

  it('uses the startup catalog for edits and replans when the catalog actually changes', async () => {
    vi.stubGlobal('document', {});
    const summary = summaryFixture({ root: { tracks: [track([motif('clip', 0, 2_000_000)])] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0 });
    try {
      service.handleProjectChanged(); await Promise.resolve();
      service.handleProjectChanged(); await Promise.resolve();
      expect(syncUserMotifsFromBackend).not.toHaveBeenCalled();
      const plans = bake.mock.calls.length;
      setUserMotifs([]); await Promise.resolve();
      expect(bake).toHaveBeenCalledTimes(plans + 1);
    } finally { service.dispose(); }
    const plans = bake.mock.calls.length;
    setUserMotifs([]); await Promise.resolve();
    expect(bake).toHaveBeenCalledTimes(plans);
  });

  it('replans for content, placement, Group clocks, open timeline and frame-grid changes', () => {
    vi.stubGlobal('document', {});
    const child = motif('child', 0, 2_000_000);
    const group = groupLayerFixture({ id: 'group' });
    const summary = summaryFixture({ root: { tracks: [track([group])] }, groups: [
      compositionFixture({ id: 'comp-group', tracks: [track([child])] }),
    ] });
    let open = ROOT_ID, fpsNum = 30, fpsDen = 1;
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => open,
      fpsNum: () => fpsNum, fpsDen: () => fpsDen, currentTimeUs: () => 0 });
    const update = (edit: () => void) => {
      const count = bake.mock.calls.length; edit(); service.handleProjectChanged();
      expect(bake).toHaveBeenCalledTimes(count + 1);
    };
    try {
      service.handleProjectChanged();
      if (child.params.kind !== 'Motif' || group.params.kind !== 'CompositionRef') throw new Error('fixture');
      const content = child.params, clock = group.params;
      update(() => { content.props = { seconds: 3 }; });
      update(() => { content.src_in_us = 100_000; });
      update(() => { content.time_map = { kind: 'Affine', rate: { num: 2, den: 1 } }; });
      update(() => { content.content_window = { in_us: 0, out_us: 1_000_000 }; });
      update(() => { child.t_start_us = 100_000; });
      update(() => { clock.time_map = { kind: 'Affine', rate: { num: 2, den: 1 } }; });
      update(() => { clock.source_phase = { in: { num: 1, den: 2 }, out: { num: 0, den: 1 } }; });
      update(() => { group.t_end_us = 1_000_000; });
      update(() => { open = 'comp-group'; });
      expect(bake.mock.lastCall![0].contents).not.toEqual([]);
      update(() => { fpsNum = 60; });
      expect(bake.mock.lastCall![0].contents[0].capture.fpsNum).toBe(60);
      update(() => { fpsDen = 2; });
      update(() => { child.enabled = false; });
      expect(bake.mock.lastCall![0].live).toEqual([]);
      update(() => { child.enabled = true; });
      update(() => { summary.compositions['comp-group']!.tracks[0]!.enabled = false; });
      expect(bake.mock.lastCall![0].live).toEqual([]);
    } finally { service.dispose(); }
  });
  it('warms active and imminent layers while declaring used ranges once per project change', async () => {
    vi.stubGlobal('document', {});
    const summary = summaryFixture({ root: { tracks: [track([
      motif('past', 0, 1_000_000), motif('current', 1_000_000, 3_000_000),
      motif('incoming', 2_500_000, 4_000_000), motif('distant', 8_000_000, 10_000_000),
    ])] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 2_000_000 });
    try {
      service.handleProjectChanged();
      await Promise.resolve();
      expect(targets().map(s => s.contentFrame)).toEqual([30, 0]);
      expect(targets().every(s => s.historyFrames === 3)).toBe(true);
      expect(bake.mock.lastCall![0].contents).toHaveLength(1);
      expect(bake.mock.lastCall![0].contents[0].ranges).toEqual([{ start: 0, end: 30 }, { start: 0, end: 60 }, { start: 0, end: 45 }, { start: 0, end: 60 }]);
      expect(bake.mock.lastCall![0].contents[0].contentFrames).toBe(150);
      service.noteFrameBoundary(4_000_000);
      expect(targets()).toEqual([]);
      expect(bake).toHaveBeenCalledOnce();
    } finally { service.dispose(); }
  });

  it('prewarms and prepares a trimmed Group using distinct visible instance windows', async () => {
    vi.stubGlobal('document', {});
    const summary = summaryFixture({
      root: { tracks: [track([
        groupLayerFixture({ id: 'active', tStartUs: 0, tEndUs: 3_000_000, srcInUs: 0, srcOutUs: 3_000_000 }),
        groupLayerFixture({ id: 'incoming', tStartUs: 2_300_000, tEndUs: 4_000_000, srcInUs: 1_000_000, srcOutUs: 2_700_000 }),
      ])] },
      groups: [compositionFixture({ id: 'comp-group', duration_us: 5_000_000, tracks: [track([motif('child', 0, 5_000_000)])] })],
    });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 2_000_000 });
    try {
      service.handleProjectChanged();
      await Promise.resolve();
      expect(targets().map(s => s.contentFrame)).toEqual([60, 30]);
      expect(new Set(targets().map(s => s.cacheKey)).size).toBe(1);
      expect(bake.mock.lastCall![0].contents[0].ranges).toEqual([{ start: 0, end: 90 }, { start: 30, end: 81 }]);
      expect(bake.mock.lastCall![0].contents[0].contentFrames).toBe(150);
    } finally { service.dispose(); }
  });

  it('keeps an explicit full-content choice through edits and requests retry only on user action', async () => {
    vi.stubGlobal('document', {});
    state.automatic = false;
    const layer = motif('manual', 0, 1_000_000);
    const summary = summaryFixture({ root: { tracks: [track([layer])] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0 });
    try {
      service.handleProjectChanged();
      await Promise.resolve();
      expect(bake.mock.lastCall![0].contents).toEqual([]);
      expect(bake.mock.lastCall![0].live).toHaveLength(1);
      // An omitted inventory must retain a disk probe; it is not proof that
      // this key has zero saved frames.
      expect(sharedBakedKeyIndex.hasFrame(bake.mock.lastCall![0].live[0].cacheKey, 0)).toBeUndefined();
      requestPrebake('manual');
      const first = bake.mock.lastCall![0];
      expect(first.contents[0]).toMatchObject({ explicit: true, ranges: [{ start: 0, end: 150 }] });
      expect(first.retryKeys).toEqual([first.contents[0].cacheKey]);
      expect(first.promoteKeys).toEqual([first.contents[0].cacheKey]);
      if (layer.params.kind !== 'Motif') throw new Error('fixture');
      layer.params.props = { seconds: 3 };
      service.handleProjectChanged();
      await Promise.resolve();
      const edited = bake.mock.lastCall![0];
      expect(edited.contents[0]).toMatchObject({ explicit: true, ranges: [{ start: 0, end: 90 }] });
      expect(edited.retryKeys).toBeUndefined();
      expect(edited.promoteKeys).toBeUndefined();
      expect(edited.contents[0].cacheKey).not.toBe(first.contents[0].cacheKey);
      service.dispose();
      expect(bake.mock.lastCall![0]).toBe(edited);
    } finally { service.dispose(); }
  });

  it('keeps a pre-bake request made before the preview has a Compositor or its project', async () => {
    vi.stubGlobal('document', {}); state.automatic = false;
    requestPrebake('early');
    let summary: ReturnType<typeof summaryFixture> | null = null;
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0 });
    try {
      summary = summaryFixture({ root: { tracks: [track([motif('early', 0, 1_000_000)])] } });
      service.handleProjectChanged(); await Promise.resolve();
      expect(bake.mock.lastCall![0].contents).toMatchObject([{ explicit: true, ranges: [{ start: 0, end: 150 }] }]);
    } finally { service.dispose(); }
  });

  it('drops a deleted layer\'s full-content choice for good', async () => {
    vi.stubGlobal('document', {}); state.automatic = false;
    const layer = motif('chosen', 0, 1_000_000);
    let summary = summaryFixture({ root: { tracks: [track([layer])] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0 });
    try {
      service.handleProjectChanged(); await Promise.resolve();
      requestPrebake('chosen');
      expect(bake.mock.lastCall![0].contents).toMatchObject([{ explicit: true }]);
      summary = summaryFixture({ root: { tracks: [track([])] } });
      service.handleProjectChanged(); await Promise.resolve();
      expect(bake.mock.lastCall![0].contents).toEqual([]);
      // Same content under another id, then the deleted layer restored by undo.
      for (const id of ['copy', 'chosen']) {
        summary = summaryFixture({ root: { tracks: [track([{ ...structuredClone(layer), id }])] } });
        service.handleProjectChanged(); await Promise.resolve();
        expect(bake.mock.lastCall![0].contents).toEqual([]);
        expect(bake.mock.lastCall![0].retryKeys).toBeUndefined();
      }
    } finally { service.dispose(); }
  });

  it('orders clips by timeline position across tracks and keeps shared-content windows separate', async () => {
    vi.stubGlobal('document', {});
    const early = motif('early', 0, 1_000_000);
    const later = motif('later', 5_000_000, 6_000_000);
    if (later.params.kind === 'Motif') later.params.src_in_us = 2_000_000;
    const middle = motif('middle', 2_000_000, 3_000_000);
    if (middle.params.kind === 'Motif') middle.params.props = { seconds: 3 };
    const summary = summaryFixture({ root: { tracks: [track([later, middle]), { ...track([early]), id: 'track-2' }] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 5_500_000 });
    try {
      service.handleProjectChanged(); await Promise.resolve();
      const p = bake.mock.lastCall![0];
      expect(p.contents).toHaveLength(2);
      expect(p.sequence).toEqual([
        { cacheKey: p.contents[0].cacheKey, ranges: [{ start: 0, end: 30 }] },
        { cacheKey: p.contents[1].cacheKey, ranges: [{ start: 0, end: 30 }] },
        { cacheKey: p.contents[0].cacheKey, ranges: [{ start: 60, end: 90 }] },
      ]);
      const key = p.contents[0].cacheKey;
      state.coverage = { [key]: Array.from({ length: 30 }, (_, i) => i) };
      state.statuses = { [key]: { phase: 'queued', done: 30, total: 60 } };
      state.publish(); await Promise.resolve();
      expect(useMotifBakeStatusStore.getState().byLayer.early).toMatchObject({ phase: 'ready', done: 30, total: 30 });
      expect(useMotifBakeStatusStore.getState().byLayer.later).toMatchObject({ phase: 'queued', done: 0, total: 30 });
      service.noteFrameBoundary(0);
      expect(bake).toHaveBeenCalledOnce();
      // Turning automatic work off does not undo the first clip's saved range.
      state.automatic = false; state.statuses = {};
      service.handleProjectChanged(); await Promise.resolve();
      expect(useMotifBakeStatusStore.getState().byLayer.early).toMatchObject({ phase: 'ready', done: 30, total: 30 });
    } finally { service.dispose(); }
  });

  it('promotes the Motifs inside a Group together in timeline order', async () => {
    vi.stubGlobal('document', {}); state.automatic = false;
    const late = motif('late-child', 2_000_000, 3_000_000);
    if (late.params.kind === 'Motif') late.params.props = { seconds: 3 };
    const summary = summaryFixture({
      root: { tracks: [track([groupLayerFixture({ id: 'group' })])] },
      groups: [compositionFixture({ id: 'comp-group', duration_us: 5_000_000,
        tracks: [track([late, motif('early-child', 0, 1_000_000)])] })],
    });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0 });
    try {
      service.handleProjectChanged(); await Promise.resolve();
      requestPrebake('group');
      const p = bake.mock.lastCall![0];
      expect(p.contents.map((c: any) => JSON.parse(c.capture.propsJson).seconds)).toEqual([5, 3]);
      expect(p.promoteKeys).toEqual(p.contents.map((c: any) => c.cacheKey));
      expect(p.contents.every((c: any) => c.explicit)).toBe(true);
    } finally { service.dispose(); }
  });

  it('reports failed preparation instead of silently restarting preview warming, and recovers on acknowledgement', async () => {
    vi.stubGlobal('document', {});
    state.fail = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = summaryFixture({ root: { tracks: [track([motif('visible', 0, 1_000_000)])] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 0 });
    try {
      service.handleProjectChanged();
      await sharedBakedKeyIndex.whenHydrated();
      expect(targets()).toHaveLength(0);
      expect(useMotifBakeStatusStore.getState().byLayer.visible).toMatchObject({ phase: 'error', error: 'Error: disconnected' });
      state.fail = false;
      const key = bake.mock.lastCall![0].contents[0].cacheKey;
      state.coverage = { [key]: Array.from({ length: 30 }, (_, i) => i) };
      state.statuses = { [key]: { phase: 'ready', done: 30, total: 30 } };
      service.handleProjectChanged(); await Promise.resolve();
      expect(targets()).toHaveLength(1);
      expect(useMotifBakeStatusStore.getState().byLayer.visible).toMatchObject({ phase: 'ready', done: 30, total: 30 });
    } finally { service.dispose(); vi.restoreAllMocks(); }
  });
});
