import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnimTrack, LayerSummary, TrackSummary } from '../../ipc';
import { compositionFixture, groupLayerFixture, ROOT_ID, summaryFixture } from '../../testing/summaryFixture';
import type { PrewarmContentSpec } from './MotifPrewarmer';
import { MotifFrameService } from './MotifFrameService';

const { warm, bake } = vi.hoisted(() => ({ warm: vi.fn(), bake: vi.fn() }));
vi.mock('./MotifPrewarmer', () => ({ MotifPrewarmer: class {
  setTargets = warm; dispose() {}
} }));
vi.mock('./MotifBaker', () => ({ MotifBaker: class {
  setTargets = bake; dispose() {}
} }));
vi.mock('../../settings/appSettingsStore', () => ({
  useAppSettingsStore: { getState: () => ({ settings: { prebake_motifs: true } }) },
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
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('MotifFrameService prewarm admission', () => {
  it('warms active and imminent layers while full-content baking still sees the whole timeline', () => {
    vi.stubGlobal('document', {});
    const summary = summaryFixture({ root: { tracks: [track([
      motif('past', 0, 1_000_000), motif('current', 1_000_000, 3_000_000),
      motif('incoming', 2_500_000, 4_000_000), motif('distant', 8_000_000, 10_000_000),
    ])] } });
    const service = new MotifFrameService({ projectSummary: () => summary, openCompositionId: () => ROOT_ID,
      fpsNum: () => 30, fpsDen: () => 1, currentTimeUs: () => 2_000_000 });
    try {
      service.noteFrameBoundary(2_000_000);
      expect(targets().map(s => s.contentFrame)).toEqual([30, 0]);
      expect(targets().every(s => s.historyFrames === 3)).toBe(true);
      expect(bake.mock.lastCall![0]).toHaveLength(4);
      service.noteFrameBoundary(4_000_000);
      expect(targets()).toEqual([]);
    } finally { service.dispose(); }
  });

  it('prewarms a trimmed Group at its visible entry frame and retains distinct instance windows', () => {
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
      service.noteFrameBoundary(2_000_000);
      expect(targets().map(s => s.contentFrame)).toEqual([60, 30]);
      expect(new Set(targets().map(s => s.cacheKey)).size).toBe(1);
    } finally { service.dispose(); }
  });
});
