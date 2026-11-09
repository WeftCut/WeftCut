import { describe, expect, it } from 'vitest';
import type { AnimTrack, LayerSummary, ProjectSummary, TrackSummary } from '../../ipc';
import type { LayerBakeStatus } from '../../timeline/motifBakeStatusStore';
import { compositionFixture, groupLayerFixture, ROOT_ID, summaryFixture } from '../../testing/summaryFixture';
import { getMotif } from './catalog';
import { motifLayerStatuses, planMotifPreparation, type PreparationInput } from './motifDemand';

const stat = (value: number): AnimTrack<number> => ({ mode: 'Static', value });
const motif = (id: string, start: number, end: number, props: Record<string, unknown> = { seconds: 5 }): LayerSummary => ({
  ...groupLayerFixture({ id, tStartUs: start, tEndUs: end }), kind: 'Motif',
  params: { kind: 'Motif', motif_id: 'countdown', src_in_us: 0, props,
    x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), rotation_deg: stat(0),
    anchor_x: stat(0.5), anchor_y: stat(0.5), opacity: stat(1), scale_linked: true },
});
const track = (layers: LayerSummary[], id = 'track'): TrackSummary => ({
  id, kind: 'Video', label: null, enabled: true, locked: false,
  muted: false, solo: false, role: null, transient: true, layers,
});
const prepare = (summary: ProjectSummary, over: Partial<PreparationInput> = {}) => planMotifPreparation({
  summary, openCompositionId: ROOT_ID, fpsNum: 30, fpsDen: 1, generation: 1, automatic: true,
  explicit: new Set(), promote: [], motif: getMotif, ...over,
});
const statuses = (summary: ProjectSummary, demand: ReturnType<typeof prepare>, over: {
  statuses?: Map<string, LayerBakeStatus>; saved?: Map<string, Set<number>>; automatic?: boolean;
  explicit?: Set<string>; preparationError?: string | null; warm?: (key: string) => number;
} = {}) => motifLayerStatuses({
  summary, openCompositionId: ROOT_ID, fpsNum: 30, fpsDen: 1, motif: getMotif,
  statuses: over.statuses ?? new Map(), layerRanges: demand.layerRanges,
  preparationError: over.preparationError ?? null, automatic: over.automatic ?? true,
  explicit: over.explicit ?? new Set(),
  saved: key => over.saved?.get(key),
  complete: (key, total) => (over.saved?.get(key)?.size ?? 0) >= total,
  warm: over.warm ?? (() => 0),
});

describe('planMotifPreparation', () => {
  it('declares each clip\'s used range of shared content and every live key', () => {
    const summary = summaryFixture({ root: { tracks: [track([
      motif('past', 0, 1_000_000), motif('current', 1_000_000, 3_000_000),
      motif('incoming', 2_500_000, 4_000_000), motif('distant', 8_000_000, 10_000_000),
    ])] } });
    const { plan, layerRanges, liveCacheKeys } = prepare(summary);
    expect(plan.generation).toBe(1);
    expect(plan.contents).toHaveLength(1);
    expect(plan.contents[0]!.ranges).toEqual([{ start: 0, end: 30 }, { start: 0, end: 60 }, { start: 0, end: 45 }, { start: 0, end: 60 }]);
    expect(plan.contents[0]!.contentFrames).toBe(150);
    expect(plan.collect).toBe(true);
    expect(liveCacheKeys).toEqual([plan.contents[0]!.cacheKey]);
    expect(plan.live.map(l => l.cacheKey)).toEqual(liveCacheKeys);
    expect(layerRanges.get('current')).toEqual([{ start: 0, end: 60 }]);
  });

  it('prepares a trimmed Group using distinct visible instance windows', () => {
    const summary = summaryFixture({
      root: { tracks: [track([
        groupLayerFixture({ id: 'active', tStartUs: 0, tEndUs: 3_000_000, srcInUs: 0, srcOutUs: 3_000_000 }),
        groupLayerFixture({ id: 'incoming', tStartUs: 2_300_000, tEndUs: 4_000_000, srcInUs: 1_000_000, srcOutUs: 2_700_000 }),
      ])] },
      groups: [compositionFixture({ id: 'comp-group', duration_us: 5_000_000, tracks: [track([motif('child', 0, 5_000_000)])] })],
    });
    const { plan, layerRanges } = prepare(summary);
    expect(plan.contents[0]!.ranges).toEqual([{ start: 0, end: 90 }, { start: 30, end: 81 }]);
    expect(plan.contents[0]!.contentFrames).toBe(150);
    expect(layerRanges.get('child')).toEqual([{ start: 0, end: 90 }, { start: 30, end: 81 }]);
  });

  it('orders clips by timeline position across tracks and keeps shared-content windows separate', () => {
    const early = motif('early', 0, 1_000_000);
    const later = motif('later', 5_000_000, 6_000_000);
    if (later.params.kind === 'Motif') later.params.src_in_us = 2_000_000;
    const middle = motif('middle', 2_000_000, 3_000_000, { seconds: 3 });
    const summary = summaryFixture({ root: { tracks: [track([later, middle]), track([early], 'track-2')] } });
    const { plan: p } = prepare(summary);
    expect(p.contents).toHaveLength(2);
    expect(p.sequence).toEqual([
      { cacheKey: p.contents[0]!.cacheKey, ranges: [{ start: 0, end: 30 }] },
      { cacheKey: p.contents[1]!.cacheKey, ranges: [{ start: 0, end: 30 }] },
      { cacheKey: p.contents[0]!.cacheKey, ranges: [{ start: 60, end: 90 }] },
    ]);
  });

  it('without automatic work demands only explicit content, still describing every clip\'s range', () => {
    const summary = summaryFixture({ root: { tracks: [track([motif('auto', 0, 1_000_000), motif('chosen', 2_000_000, 3_000_000, { seconds: 3 })])] } });
    const { plan, layerRanges } = prepare(summary, { automatic: false, explicit: new Set(['chosen']) });
    expect(plan.contents).toMatchObject([{ explicit: true, ranges: [{ start: 0, end: 90 }] }]);
    expect(plan.retryKeys).toBeUndefined();
    expect(layerRanges.get('auto')).toEqual([{ start: 0, end: 30 }]);
    expect(prepare(summary, { automatic: false }).plan.contents).toEqual([]);
  });

  it('keeps an explicit layer demanded when its Group is not the open or root timeline', () => {
    const summary = summaryFixture({
      root: { tracks: [track([])] },
      groups: [compositionFixture({ id: 'comp-group', duration_us: 5_000_000, tracks: [track([
        motif('chosen', 0, 1_000_000), motif('neighbour', 1_000_000, 2_000_000, { seconds: 3 }),
      ])] })],
    });
    const { plan, layerRanges } = prepare(summary, { explicit: new Set(['chosen']) });
    expect(plan.contents).toMatchObject([{ explicit: true, ranges: [{ start: 0, end: 150 }] }]);
    expect(layerRanges.size).toBe(0);
    expect(prepare(summary).plan.contents).toEqual([]);
  });

  it('retries promoted content, newest request first, timeline order within one', () => {
    const summary = summaryFixture({ root: { tracks: [track([
      motif('a', 0, 1_000_000), motif('b', 1_000_000, 2_000_000, { seconds: 3 }), motif('c', 2_000_000, 3_000_000, { seconds: 4 }),
    ])] } });
    const { plan } = prepare(summary, { automatic: false, explicit: new Set(['a', 'b', 'c']), promote: [['c'], ['b', 'a']] });
    const [a, b, c] = plan.contents.map(content => content.cacheKey);
    expect(plan.contents.every(content => content.explicit)).toBe(true);
    expect(plan.retryKeys).toEqual([a, b, c]);
    expect(plan.promoteKeys).toEqual([c, a, b]);
  });

  it('marks unresolved catalog references unsafe for collection', () => {
    const layer = motif('missing', 0, 1_000_000);
    if (layer.params.kind === 'Motif') layer.params.motif_id = 'unresolved-package';
    const { plan } = prepare(summaryFixture({ root: { tracks: [track([layer])] } }));
    expect(plan.collect).toBe(false);
    expect(plan.contents).toEqual([]);
  });
});

describe('motifLayerStatuses', () => {
  it('shows a clip\'s progress on its own used range, ready once that range is saved', () => {
    const early = motif('early', 0, 1_000_000);
    const later = motif('later', 5_000_000, 6_000_000);
    if (later.params.kind === 'Motif') later.params.src_in_us = 2_000_000;
    const summary = summaryFixture({ root: { tracks: [track([later, motif('middle', 2_000_000, 3_000_000, { seconds: 3 })]), track([early], 'track-2')] } });
    const demand = prepare(summary);
    const key = demand.plan.contents[0]!.cacheKey;
    const saved = new Map([[key, new Set(Array.from({ length: 30 }, (_, i) => i))]]);
    const byLayer = statuses(summary, demand, { saved, statuses: new Map([[key, { phase: 'queued', done: 30, total: 60 }]]) });
    expect(byLayer.early).toMatchObject({ phase: 'ready', done: 30, total: 30 });
    expect(byLayer.later).toMatchObject({ phase: 'queued', done: 0, total: 30 });
    expect(byLayer.middle).toBeUndefined();
    // Turning automatic work off does not undo the first clip's saved range.
    const off = prepare(summary, { automatic: false });
    expect(statuses(summary, off, { saved, automatic: false }).early).toMatchObject({ phase: 'ready', done: 30, total: 30 });
  });

  it('reports a preparation error only on layers that demand preparation', () => {
    const summary = summaryFixture({ root: { tracks: [track([motif('auto', 0, 1_000_000), motif('chosen', 2_000_000, 3_000_000, { seconds: 3 })])] } });
    const demand = prepare(summary);
    expect(statuses(summary, demand, { preparationError: 'down' }).auto).toMatchObject({ phase: 'error', error: 'down', total: 150 });
    const manual = statuses(summary, demand, { preparationError: 'down', automatic: false, explicit: new Set(['chosen']) });
    expect(manual.auto).toBeUndefined();
    expect(manual.chosen).toMatchObject({ phase: 'error', total: 90 });
  });

  it('falls back to memory warmth, and to ready when every frame is saved', () => {
    const summary = summaryFixture({ root: { tracks: [track([motif('clip', 0, 1_000_000)])] } });
    const demand = prepare(summary, { automatic: false });
    const key = demand.plan.live[0]!.cacheKey;
    expect(statuses(summary, demand).clip).toBeUndefined();
    expect(statuses(summary, demand, { warm: () => 10 }).clip).toMatchObject({ phase: 'warming', done: 10, total: 150 });
    expect(statuses(summary, demand, { warm: () => 150 }).clip).toMatchObject({ phase: 'preview_ready' });
    const all = new Map([[key, new Set(Array.from({ length: 150 }, (_, i) => i))]]);
    expect(statuses(summary, demand, { saved: all }).clip).toMatchObject({ phase: 'ready', done: 30, total: 30 });
  });
});
