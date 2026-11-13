import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { MotifPrewarmer } from './MotifPrewarmer';
import { planLookaheadTargets, type LookaheadContent } from './motifDemand';
import { motifTuning } from './tuning';
import {
  acquireMotifFrame, motifFrameCoverage, bindMotifFrameWorkspace,
  sharedBakedKeyIndex, sharedMotifFrameCache, setMotifPreparationCoverage,
} from './motifFrameSource';
import { captureMotif, MotifTransportError, type MotifCaptureReply, type MotifCaptureRequest } from './frameTransport';
import type { MotifFrameDescriptor } from './motifFrameDescriptor';
import type { MotifFrameCache } from './frameCache';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';
import type { MotifFramePriority } from '../../../shared/motifs/frameTransport';
import { hashCacheKey } from '../../../shared/motifs/cacheKey';
import { MOTIF_TUNING_DEFAULTS } from '../../../shared/motifs/tuning';

vi.mock('./frameTransport', async importOriginal => ({
  ...await importOriginal<typeof import('./frameTransport')>(), captureMotif: vi.fn(),
}));

const bitmap = () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const live = (): MotifCaptureReply => ({ kind: 'pixels', bitmap: bitmap(), persisted: false });
function desc(cacheKey: string, frame = 0): MotifFrameDescriptor {
  return {
    cacheKey, motifId: 'long', contentHash: '', fpsNum: 60, fpsDen: 1, contentFrame: frame,
    contentDurationFrames: 1_000, contentDurationUs: 16_666_667, srcInUs: 0, renderW: 1, renderH: 1,
    canonicalProps: {}, tSec: frame / 60, overlayActive: false,
  };
}
const current = (frame: number, scaleDiv: MotifReaderDiv = 1) =>
  acquireMotifFrame(desc('long', frame), { scaleDiv, priority: 'current', signal: new AbortController().signal }).lease;
/** Lookahead captures the send window keeps in main at once. */
const sendWindow = MOTIF_TUNING_DEFAULTS.captureRequests;
let cleanup: (() => void)[];
let captures: {
  request: MotifCaptureRequest; answer: (reply: MotifCaptureReply) => void;
  setPriority: (priority: MotifFramePriority) => void; cancel: () => void;
}[];
let read: MockInstance<MotifFrameCache['readBitmap']>;

beforeEach(() => {
  bindMotifFrameWorkspace(1);
  cleanup = [];
  captures = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
  read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockResolvedValue(null);
  vi.mocked(captureMotif).mockClear().mockImplementation(request => {
    let answer!: (reply: MotifCaptureReply) => void;
    const reply = new Promise<MotifCaptureReply>(resolve => { answer = resolve; });
    const call = { request, answer, setPriority: vi.fn(), cancel: vi.fn() };
    captures.push(call);
    cleanup.push(() => answer(live()));
    return { reply, setPriority: call.setPriority, cancel: call.cancel };
  });
});
afterEach(async () => {
  cleanup.forEach(fn => fn());
  bindMotifFrameWorkspace(null);
  await settle();
  sharedBakedKeyIndex.clear();
  sharedMotifFrameCache.clearAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function prewarmer() {
  const callbacks: (() => void)[] = [];
  const instance = new MotifPrewarmer({
    coverage: motifFrameCoverage, acquire: acquireMotifFrame,
    schedule: cb => { callbacks.push(cb); return callbacks.length; }, cancel: () => {},
  });
  cleanup.unshift(() => instance.dispose());
  /** The session's lookahead plan over `specs` within a 40-byte L0. */
  const set = (specs: LookaheadContent[]) => instance.setTargets(planLookaheadTargets(specs, 40, motifTuning().prewarmRequests));
  return { prewarmer: instance, set, callbacks };
}
const spec = (cacheKey: string, contentFrame = 0, contentDurationFrames = 1_000, historyFrames = 0): LookaheadContent => ({
  cacheKey, contentFrame, contentDurationFrames, frameBytes: 4, historyFrames,
  descriptor: desc(cacheKey, contentFrame), scaleDiv: 1,
});

function warm(keys = ['long']) {
  const h = prewarmer();
  const specs = keys.map(cacheKey => spec(cacheKey));
  h.set(specs);
  h.callbacks.shift()!();
  return { ...h, specs };
}

it('pipelines three saved frames of an incomplete long Motif without capture', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 100 }, (_, i) => i)));
  read.mockImplementation(() => new Promise(resolve => { cleanup.push(() => resolve(bitmap())); }));
  warm();
  await settle();
  expect(read.mock.calls.map(([, frame]) => frame)).toEqual([0, 1, 2]);
  expect(captureMotif).not.toHaveBeenCalled();
});

it('waits for main-owned preparation instead of switching its capture page for speculative frames', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  setMotifPreparationCoverage(['long']);
  read.mockResolvedValue(bitmap());
  const h = warm();
  await settle();
  expect(captureMotif).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  for (let i = 0; i < 5; i++) {
    // Progress updates may rebuild the prewarm plan many times while main
    // is rendering other content. Those updates must not start a second producer.
    setMotifPreparationCoverage(['long']);
    h.set(h.specs);
    await settle();
  }
  expect(captureMotif).not.toHaveBeenCalled();
  sharedBakedKeyIndex.add('long', 2);
  setMotifPreparationCoverage(['long']);
  await settle();
  expect(read).toHaveBeenCalledExactlyOnceWith('long', 2, 1, {});
  expect(sharedMotifFrameCache.hasFrame('long', 2, 1)).toBe(true);
  expect(captureMotif).not.toHaveBeenCalled();
});

it('current demand captures a frame main is preparing, sharing one capture with lookahead', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  setMotifPreparationCoverage(['long']);
  warm();
  await settle();
  const shown = current(0);
  await settle();
  expect(captures).toHaveLength(1);
  expect(captures[0]!.request.priority).toBe('current');
  captures[0]!.answer(live());
  (await shown).release();
  await settle();
  expect(sharedMotifFrameCache.hasFrame('long', 0, 1)).toBe(true);
  expect(captures).toHaveLength(1);
});

it('returns speculative capture ownership when automatic preparation is disabled', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  setMotifPreparationCoverage(['long']);
  warm();
  await settle();
  expect(captureMotif).not.toHaveBeenCalled();
  setMotifPreparationCoverage([]);
  await settle();
  expect(captureMotif).toHaveBeenCalledTimes(sendWindow);
});

it('retries a failed disk read only after main publishes repaired coverage', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([0]));
  setMotifPreparationCoverage(['long']);
  read.mockResolvedValueOnce(null).mockResolvedValue(bitmap());
  warm();
  await settle();
  expect(read).toHaveBeenCalledOnce();
  expect(captureMotif).not.toHaveBeenCalled();
  sharedBakedKeyIndex.add('long', 0);
  setMotifPreparationCoverage(['long']);
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(sharedMotifFrameCache.hasFrame('long', 0, 1)).toBe(true);
  expect(captureMotif).not.toHaveBeenCalled();
});

it('reads saved frames beyond several missing frames while captures are slow', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([3, 4, 5, 6, 7]));
  read.mockImplementation((_key, frame) => {
    if (frame < 3) return Promise.resolve(null);
    return new Promise(resolve => { cleanup.push(() => resolve(bitmap())); });
  });
  warm();
  await settle();
  expect(read.mock.calls.map(([, frame]) => frame)).toEqual([3, 4, 5]);
  expect(captureMotif).toHaveBeenCalledTimes(sendWindow);
});

it('an uncached sibling does not reduce saved-frame read concurrency', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([0, 1, 2, 3, 4]));
  read.mockImplementation(() => new Promise(resolve => { cleanup.push(() => resolve(bitmap())); }));
  warm(['cold', 'long']);
  await settle();
  expect(read.mock.calls).toEqual([['long', 0, 1, {}], ['long', 1, 1, {}], ['long', 2, 1, {}]]);
  expect(captureMotif).toHaveBeenCalledTimes(sendWindow);
});

it('a transport error preserves disk coverage and never starts a replacement capture', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([0]));
  read.mockRejectedValueOnce(new MotifTransportError('utility', 'closed'));
  await expect(current(0, 2)).rejects.toBeInstanceOf(MotifTransportError);
  expect(sharedBakedKeyIndex.hasFrame('long', 0)).toBe(true);
  read.mockResolvedValue(bitmap());
  (await current(0, 2)).release();
  expect(read.mock.calls.map(([, , div]) => div)).toEqual([2, 2]);
  expect(captureMotif).not.toHaveBeenCalled();
});

it('reads saved frames at the preview divisor and captures holes at full size', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([0]));
  read.mockResolvedValue(bitmap());
  (await current(0, 4)).release();
  const hole = current(1, 4);
  await settle();
  captures[0]!.answer(live());
  (await hole).release();
  expect(read).toHaveBeenCalledExactlyOnceWith('long', 0, 4, {});
  expect(sharedMotifFrameCache.hasFrame('long', 0, 1)).toBe(false);
  // A capture is full size, so it serves every divisor.
  expect(sharedMotifFrameCache.hasFrame('long', 1, 1)).toBe(true);
  expect(sharedMotifFrameCache.hasFrame('long', 1, 4)).toBe(true);
});

it('missing frames release disk capacity and keep only the send window in main', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 10 }, (_, i) => i)));
  read.mockImplementation(async (_key, frame) => frame < 3 ? null : bitmap());
  warm();
  await settle();
  expect(read).toHaveBeenCalledTimes(10);
  expect(captures).toHaveLength(sendWindow);
  // The first capture after a read miss lets main check the store.
  expect(captures[0]!.request).not.toHaveProperty('afterMiss');
  for (let frame = 3; frame < 10; frame++) expect(sharedMotifFrameCache.hasFrame('long', frame, 1)).toBe(true);
  expect(sharedBakedKeyIndex.hasFrame('long', 0)).toBe(false);
});

it('a newly baked queued frame starts reading while an unrelated capture is still running', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  read.mockResolvedValue(bitmap());
  warm();
  await settle();
  expect(captureMotif).toHaveBeenCalledTimes(sendWindow);
  expect(read).not.toHaveBeenCalled();
  sharedBakedKeyIndex.add('long', sendWindow);
  await settle();
  expect(read).toHaveBeenCalledExactlyOnceWith('long', sendWindow, 1, {});
  expect(sharedMotifFrameCache.hasFrame('long', sendWindow, 1)).toBe(true);
  expect(captureMotif).toHaveBeenCalledTimes(sendWindow);
});

it('captures lookahead of every content before history behind a playhead', async () => {
  sharedBakedKeyIndex.restoreFrames('a', new Set());
  sharedBakedKeyIndex.restoreFrames('b', new Set());
  const h = prewarmer();
  // `a` plays its last frame: one frame ahead, the rest of its window behind.
  h.set([spec('a', 9, 10, 3), spec('b', 0, 10, 3)]);
  h.callbacks.shift()!();
  for (let i = 0; i < 10; i++) {
    await settle();
    captures[i]!.answer(live());
  }
  const of = (key: string) => captures.filter(call => call.request.address!.hash === hashCacheKey(key))
    .map(call => [call.request.priority, call.request.address!.frame]);
  expect(of('a')).toEqual([['ahead', 9], ['background', 8], ['background', 7], ['background', 6], ['background', 0]]);
  expect(of('b')).toEqual([0, 1, 2, 3, 4].map(frame => ['ahead', frame]));
  // Every lookahead frame of `b` is captured before any history of `a`.
  expect(captures.slice(0, 6).every(call => call.request.priority === 'ahead')).toBe(true);
});

it('a playhead that passes a lookahead capture demotes it in main, and a seek back promotes it again', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  const h = prewarmer();
  h.set([spec('long', 0, 1_000, 2)]);
  h.callbacks.shift()!();
  await settle();
  expect(captures.map(call => [call.request.address!.frame, call.request.priority])).toEqual([[0, 'ahead'], [1, 'ahead']]);
  h.set([spec('long', 1, 1_000, 2)]);
  await settle();
  expect(vi.mocked(captures[0]!.setPriority).mock.calls).toEqual([['background']]);
  h.set([spec('long', 0, 1_000, 2)]);
  await settle();
  expect(vi.mocked(captures[0]!.setPriority).mock.calls).toEqual([['background'], ['ahead']]);
  expect(captures).toHaveLength(sendWindow);
});

it('seek cancels queued old-window work and closes late admitted results', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 200 }, (_, i) => i)));
  const values: ImageBitmap[] = [];
  const finish: (() => void)[] = [];
  read.mockImplementation(() => new Promise(resolve => {
    const value = bitmap(); values.push(value);
    const release = () => resolve(value);
    finish.push(release); cleanup.push(release);
  }));
  const h = warm();
  await settle();
  h.set([spec('long', 100)]);
  h.callbacks.shift()!();
  finish.slice(0, 3).forEach(fn => fn());
  await settle();
  expect(read.mock.calls.map(([, frame]) => frame)).toEqual([0, 1, 2, 100, 101, 102]);
  expect(values.slice(0, 3).every(value => vi.mocked(value.close).mock.calls.length === 1)).toBe(true);
  h.prewarmer.dispose();
  finish.slice(3).forEach(fn => fn());
  await settle();
  expect(read).toHaveBeenCalledTimes(6);
  expect(sharedMotifFrameCache.size()).toBe(0);
  expect(captureMotif).not.toHaveBeenCalled();
});

it('current demand promotes a queued lookahead read without acquiring it twice', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 100 }, (_, i) => i)));
  const finish = new Map<number, () => void>();
  read.mockImplementation((_key, frame) => new Promise(resolve => {
    const release = () => resolve(bitmap());
    finish.set(frame, release); cleanup.push(release);
  }));
  warm();
  await settle();
  const shown = current(9);
  await settle();
  finish.get(0)!();
  await settle();
  expect(read.mock.calls.map(([, frame]) => frame)).toEqual([0, 1, 2, 9]);
  finish.get(9)!();
  (await shown).release();
  await settle();
  expect(sharedMotifFrameCache.hasFrame('long', 9, 1)).toBe(true);
  expect(read.mock.calls.filter(([, frame]) => frame === 9)).toHaveLength(1);
});

it('retiring lookahead does not cancel the current subscriber sharing its capture', async () => {
  const h = warm();
  await settle();
  expect(captures[0]!.request.priority).toBe('ahead');
  const shown = current(0);
  await settle();
  h.set([]);
  captures[0]!.answer(live());
  const lease = await shown;
  expect(captures[0]!.cancel).not.toHaveBeenCalled();
  expect(sharedMotifFrameCache.getFrame('long', 0, 1)).toBe(lease.bitmap);
  lease.release();
  expect(captures).toHaveLength(sendWindow);
  expect(captures.slice(1).every(call => vi.mocked(call.cancel).mock.calls.length === 1)).toBe(true);
});
