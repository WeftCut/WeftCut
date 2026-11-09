import { describe, expect, it } from 'vitest';
import type { AnimTrack, LayerSummary, ProjectSummary, TrackSummary } from '../../ipc';
import type { LayerBakeStatus } from '../../timeline/motifBakeStatusStore';
import { compositionFixture, groupLayerFixture, ROOT_ID, summaryFixture } from '../../testing/summaryFixture';
import { getMotif } from './catalog';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';
import type { MotifFrameDescriptor } from './motifFrameDescriptor';
import {
  motifLayerStatuses, planLookaheadTargets, planMotifDemand, planMotifPreparation, planMotifPresence,
  type LookaheadContent, type LookaheadInput, type LookaheadTarget, type PreparationInput,
} from './motifDemand';

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

const lookahead = (summary: ProjectSummary, playheadUs: number, over: Partial<LookaheadInput> = {}) => planMotifDemand({
  summary, openCompositionId: ROOT_ID, fpsNum: 30, fpsDen: 1, playheadUs, scaleDiv: 1,
  budget: { capBytes: 512 * 1024 * 1024, requests: 256, lookaheadUs: 500_000, historyFrames: 3 },
  motif: getMotif, complete: () => false, ...over,
});
const addresses = (targets: LookaheadTarget[]) => targets.map(({ cacheKey, frame }) => ({ cacheKey, frame }));

describe('planMotifDemand', () => {
  it('warms active and imminent layers from where the playhead meets each, and nothing past them', () => {
    const summary = summaryFixture({ root: { tracks: [track([
      motif('past', 0, 1_000_000), motif('current', 1_000_000, 3_000_000),
      motif('incoming', 2_500_000, 4_000_000), motif('distant', 8_000_000, 10_000_000),
    ])] } });
    const targets = lookahead(summary, 2_000_000);
    // One content, two instance windows: frame 30 of `current`, 0 of `incoming`.
    expect(targets.slice(0, 4).map(t => t.frame)).toEqual([30, 0, 31, 1]);
    expect(targets).toHaveLength(150);
    expect(new Set(targets.map(t => t.cacheKey)).size).toBe(1);
    expect(targets.every((t, i) => t.priority === 'ahead' && t.order === i)).toBe(true);
    expect(lookahead(summary, 4_000_000)).toEqual([]);
  });

  it('warms a trimmed Group from each visible instance window', () => {
    const summary = summaryFixture({
      root: { tracks: [track([
        groupLayerFixture({ id: 'active', tStartUs: 0, tEndUs: 3_000_000, srcInUs: 0, srcOutUs: 3_000_000 }),
        groupLayerFixture({ id: 'incoming', tStartUs: 2_300_000, tEndUs: 4_000_000, srcInUs: 1_000_000, srcOutUs: 2_700_000 }),
      ])] },
      groups: [compositionFixture({ id: 'comp-group', duration_us: 5_000_000, tracks: [track([motif('child', 0, 5_000_000)])] })],
    });
    expect(lookahead(summary, 2_000_000).slice(0, 2).map(t => t.frame)).toEqual([60, 30]);
  });

  it('keeps recent history behind the playhead as background', () => {
    const summary = summaryFixture({ root: { tracks: [track([motif('clip', 0, 5_000_000)])] } });
    const targets = lookahead(summary, 1_000_000, { budget: { capBytes: 512 * 1024 * 1024, requests: 8, lookaheadUs: 500_000, historyFrames: 3 } });
    expect(targets.map(t => [t.frame, t.priority])).toEqual([
      [30, 'ahead'], [31, 'ahead'], [32, 'ahead'], [33, 'ahead'], [34, 'ahead'],
      [29, 'background'], [28, 'background'], [27, 'background'],
    ]);
    expect(targets.every(t => t.content.contentFrame === 30 && t.scaleDiv === 1)).toBe(true);
  });

  it('sizes only fully saved content at the playback divisor', () => {
    const summary = summaryFixture({ root: { tracks: [track([motif('clip', 0, 5_000_000)])] } });
    const { renderW, renderH } = lookahead(summary, 0)[0]!.content;
    const capBytes = renderW * renderH * 4 * 4;
    const budget = { capBytes, requests: 256, lookaheadUs: 500_000, historyFrames: 0 };
    const holes = lookahead(summary, 0, { scaleDiv: 2, budget });
    expect(holes).toHaveLength(4);
    expect(holes.every(t => t.scaleDiv === 2)).toBe(true);
    expect(lookahead(summary, 0, { scaleDiv: 2, budget, complete: () => true }).length).toBeGreaterThanOrEqual(13);
  });
});

/// Caps are BYTES (the L0 budget); `frameBytes: 1` keeps a byte cap equal to
/// a frame count so the planning math stays readable.
const content = (
  cacheKey: string,
  contentFrame: number,
  contentDurationFrames: number,
  frameBytes = 1,
  scaleDiv: MotifReaderDiv = 1,
): LookaheadContent => ({
  cacheKey, contentFrame, contentDurationFrames, frameBytes, scaleDiv,
  descriptor: { cacheKey, contentFrame } as MotifFrameDescriptor,
});

describe('planLookaheadTargets', () => {
  it('warms the whole content when it fits the budget, playhead-first then forward then backfill', () => {
    const plan = planLookaheadTargets([content('a', 2, 5)], 240);
    expect(addresses(plan)).toEqual([
      { cacheKey: 'a', frame: 2 },
      { cacheKey: 'a', frame: 3 },
      { cacheKey: 'a', frame: 4 },
      { cacheKey: 'a', frame: 0 },
      { cacheKey: 'a', frame: 1 },
    ]);
  });
  it('windows to the per-content budget when content exceeds it (forward from current)', () => {
    const plan = planLookaheadTargets([content('a', 10, 100)], 4);
    expect(addresses(plan)).toEqual([
      { cacheKey: 'a', frame: 10 },
      { cacheKey: 'a', frame: 11 },
      { cacheKey: 'a', frame: 12 },
      { cacheKey: 'a', frame: 13 },
    ]);
  });
  it('splits the budget across contents and round-robins (union <= cap)', () => {
    const plan = planLookaheadTargets([content('a', 0, 100), content('b', 0, 100)], 4);
    expect(addresses(plan)).toEqual([
      { cacheKey: 'a', frame: 0 },
      { cacheKey: 'b', frame: 0 },
      { cacheKey: 'a', frame: 1 },
      { cacheKey: 'b', frame: 1 },
    ]);
  });
  it('scales the warm window by the content\'s real frame cost (bytes)', () => {
    // 48-byte budget over 2 contents: a 4-byte frame warms 6 deep, a 12-byte
    // frame only 2 — same memory share, different frame counts.
    const plan = planLookaheadTargets([content('small', 0, 100, 4), content('big', 0, 100, 12)], 48);
    expect(addresses(plan)).toEqual([
      { cacheKey: 'small', frame: 0 },
      { cacheKey: 'big', frame: 0 },
      { cacheKey: 'small', frame: 1 },
      { cacheKey: 'big', frame: 1 },
      { cacheKey: 'small', frame: 2 },
      { cacheKey: 'small', frame: 3 },
      { cacheKey: 'small', frame: 4 },
      { cacheKey: 'small', frame: 5 },
    ]);
  });
  it('dedups contents by cacheKey', () => {
    const plan = planLookaheadTargets([content('a', 0, 3), content('a', 0, 3)], 240);
    expect(addresses(plan)).toEqual([
      { cacheKey: 'a', frame: 0 },
      { cacheKey: 'a', frame: 1 },
      { cacheKey: 'a', frame: 2 },
    ]);
  });
  it('returns [] for no contents', () => {
    expect(planLookaheadTargets([], 240)).toEqual([]);
  });
  it('reserves a small recent window so slightly late reads remain useful', () => {
    const plan = planLookaheadTargets([{ ...content('a', 10, 100), historyFrames: 3 }], 8);
    expect(plan.map(p => p.frame)).toEqual([10, 11, 12, 13, 14, 9, 8, 7]);
  });
  it('keeps both instance windows of the same content within one byte budget', () => {
    const plan = planLookaheadTargets([content('a', 0, 100), content('a', 50, 100)], 4);
    expect(plan.map(p => p.frame)).toEqual([0, 50, 1, 51]);
  });
  it('does not exceed its byte cap even when one frame cannot fit', () => {
    expect(planLookaheadTargets([content('a', 0, 100, 10)], 9)).toEqual([]);
  });
  it('bounds the plan by its request count', () => {
    expect(planLookaheadTargets([content('a', 0, 100), content('b', 0, 100)], 240, 5)).toHaveLength(5);
  });

  it('classes frames against the earliest window of a content and names them by its last', () => {
    const plan = planLookaheadTargets([
      { ...content('a', 5, 10, 1, 2), historyFrames: 1 }, { ...content('a', 3, 10, 1, 2), historyFrames: 1 },
    ], 6);
    // Frame 4 is behind the first window's playhead but ahead of the second's.
    expect(plan.map(t => [t.frame, t.priority, t.order])).toEqual([
      [5, 'ahead', 0], [3, 'ahead', 1], [6, 'ahead', 2], [4, 'ahead', 3], [7, 'ahead', 4], [8, 'ahead', 5],
    ]);
    expect(plan.every(t => t.content.contentFrame === 3 && t.scaleDiv === 2)).toBe(true);
  });
});

describe('planMotifPresence', () => {
  const as = (layer: LayerSummary, motifId: string): LayerSummary =>
    ({ ...layer, params: { ...(layer.params as Extract<LayerSummary['params'], { kind: 'Motif' }>), motif_id: motifId, props: {} } });
  const presence = (summary: ProjectSummary, playheadUs: number, lookaheadUs = 1_000_000) => planMotifPresence({
    summary, openCompositionId: ROOT_ID, fpsNum: 30, fpsDen: 1, playheadUs, lookaheadUs, motif: getMotif,
  });
  const ids = (p: ReturnType<typeof presence>) => ({ visible: p.visible.map(v => v.motifId).sort(), next: p.next?.motifId ?? null })

  it('names each content version on screen once, and the soonest other one to enter within the lookahead', () => {
    const summary = summaryFixture({ root: { tracks: [track([
      motif('a1', 0, 2_000_000), motif('a2', 500_000, 3_000_000),
      as(motif('third', 1_200_000, 4_000_000), 'lower-third'),
      as(motif('later', 1_800_000, 4_000_000), 'text-fx'),
    ])] } });
    expect(ids(presence(summary, 600_000))).toEqual({ visible: ['countdown'], next: 'lower-third' });
    expect(presence(summary, 600_000).next).toMatchObject({ inMs: 600, width: 1280, height: 320 });
    expect(presence(summary, 600_000).visible[0]!.contentHash).toBe(getMotif('countdown')!.manifest.content_hash ?? '');
    // Beyond the lookahead, nothing is next.
    expect(ids(presence(summary, 600_000, 500_000))).toEqual({ visible: ['countdown'], next: null });
    // A Motif entering that is already on screen is not next; the one after it is.
    expect(ids(presence(summary, 1_300_000))).toEqual({ visible: ['countdown', 'lower-third'], next: 'text-fx' });
  });

  it('counts a Motif inside a Group, and nothing on a disabled track', () => {
    const summary = summaryFixture({
      root: { tracks: [track([groupLayerFixture({ id: 'g', compositionId: 'inner', tStartUs: 0, tEndUs: 4_000_000 })]),
        { ...track([as(motif('off', 0, 4_000_000), 'text-fx')], 'muted'), enabled: false }] },
      groups: [compositionFixture({ id: 'inner', tracks: [track([as(motif('inner-third', 0, 4_000_000), 'lower-third')])] })],
    });
    expect(ids(presence(summary, 100_000))).toEqual({ visible: ['lower-third'], next: null });
  });
});
