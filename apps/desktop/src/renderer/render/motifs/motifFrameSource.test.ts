import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import {
  acquireMotifFrame, peekMotifFrame, resetMotifFrameRequests, sharedBakedKeyIndex,
  sharedMotifFrameCache, sharedMotifOverlayCache, type MotifFrameRequest,
} from './motifFrameSource';
import { captureMotif, MotifTransportError, type MotifCaptureReply, type MotifCaptureRequest } from './frameTransport';
import type { MotifFrameDescriptor } from './motifFrameDescriptor';
import type { MotifFrameCache } from './frameCache';
import { hashCacheKey } from '../../../shared/motifs/cacheKey';
import { MOTIF_TUNING_DEFAULTS } from '../../../shared/motifs/tuning';

vi.mock('./frameTransport', async importOriginal => ({
  ...await importOriginal<typeof import('./frameTransport')>(), captureMotif: vi.fn(),
}));

interface FakeCall {
  request: MotifCaptureRequest;
  answer: (reply: MotifCaptureReply) => void;
  fail: (error: Error) => void;
  setPriority: Mock;
  cancel: Mock;
}
let calls: FakeCall[];
let read: MockInstance<MotifFrameCache['readBitmap']>;
let pins: () => number;
let overlayPins: () => number;

const bitmap = () => ({ width: 4, height: 4, close: vi.fn() }) as unknown as ImageBitmap;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const pixels = (persisted = false) => ({ kind: 'pixels' as const, bitmap: bitmap(), persisted });
function desc(frame = 0, cacheKey = 'k', overlayActive = false): MotifFrameDescriptor {
  return {
    cacheKey, motifId: 'm', contentHash: 'h', fpsNum: 30, fpsDen: 1, contentFrame: frame,
    contentDurationFrames: 100, contentDurationUs: 3_333_333, srcInUs: 0, renderW: 4, renderH: 4,
    canonicalProps: { seconds: 5 }, tSec: frame / 30, overlayActive,
  };
}
function acquire(d: MotifFrameDescriptor, request: Partial<MotifFrameRequest> = {}) {
  const controller = new AbortController();
  const { lease, setPriority } = acquireMotifFrame(d, { scaleDiv: 1, priority: 'current', signal: controller.signal, ...request });
  // Requests a test leaves pending are superseded by the reset after it.
  lease.catch(() => {});
  return { lease, controller, setPriority };
}
/** Lookahead captures the send window keeps in main at once. */
const sendWindow = MOTIF_TUNING_DEFAULTS.captureRequests;
const sentFrames = () => calls.map(call => call.request.address!.frame);
const superseded = { code: 'superseded' };

beforeEach(() => {
  calls = [];
  vi.mocked(captureMotif).mockClear().mockImplementation(request => {
    let answer!: FakeCall['answer'], fail!: FakeCall['fail'];
    const reply = new Promise<MotifCaptureReply>((yes, no) => { answer = yes; fail = no; });
    const call = { request, answer, fail, setPriority: vi.fn(), cancel: vi.fn() };
    calls.push(call);
    return { reply, setPriority: call.setPriority, cancel: call.cancel };
  });
  read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockResolvedValue(null);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
  const retain = vi.spyOn(sharedMotifFrameCache, 'retain');
  const release = vi.spyOn(sharedMotifFrameCache, 'release');
  pins = () => retain.mock.calls.length - release.mock.calls.length;
  const overlayRetain = vi.spyOn(sharedMotifOverlayCache, 'retain');
  const overlayRelease = vi.spyOn(sharedMotifOverlayCache, 'release');
  overlayPins = () => overlayRetain.mock.calls.length - overlayRelease.mock.calls.length;
});
afterEach(async () => {
  resetMotifFrameRequests();
  for (const call of calls) call.fail(new Error('test over'));
  await settle();
  sharedBakedKeyIndex.clear();
  sharedMotifFrameCache.clearAll();
  sharedMotifOverlayCache.clearAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('L0', () => {
  it('a hit resolves with a pinned lease, and eviction closes the bitmap only after release', async () => {
    const cached = bitmap();
    sharedMotifFrameCache.setFrame('k', 0, 1, cached);
    const lease = await acquire(desc()).lease;
    const peeked = peekMotifFrame(desc(), 1)!;
    expect([lease.bitmap, peeked.bitmap]).toEqual([cached, cached]);
    expect(pins()).toBe(2);
    sharedMotifFrameCache.clearAll();
    lease.release(); lease.release();
    expect(cached.close).not.toHaveBeenCalled();
    peeked.release();
    expect(cached.close).toHaveBeenCalledOnce();
    expect(pins()).toBe(0);
    expect(captureMotif).not.toHaveBeenCalled();
  });

  it('a live capture serves every divisor; a stored frame only its own', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const first = acquire(desc(), { scaleDiv: 2 });
    await settle();
    calls[0]!.answer(pixels());
    (await first.lease).release();
    expect(peekMotifFrame(desc(), 1)).not.toBeNull();
    sharedMotifFrameCache.clearAll();
    sharedMotifFrameCache.setFrame('k', 1, 2, bitmap());
    expect(peekMotifFrame(desc(1), 2)).not.toBeNull();
    expect(peekMotifFrame(desc(1), 1)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('jobs', () => {
  it('one capture of an unsaved frame is published once and pinned per subscriber', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const a = acquire(desc(3)), b = acquire(desc(3), { priority: 'ahead' });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toEqual({
      motifId: 'm', tSec: 0.1, propsJson: '{"seconds":5}', width: 4, height: 4, contentHash: 'h',
      fpsNum: 30, fpsDen: 1, priority: 'current', address: { hash: hashCacheKey('k'), frame: 3 },
    });
    const shown = bitmap();
    calls[0]!.answer({ kind: 'pixels', bitmap: shown, persisted: false });
    const [one, two] = await Promise.all([a.lease, b.lease]);
    expect([one.bitmap, two.bitmap, one.frame]).toEqual([shown, shown, 3]);
    expect(sharedMotifFrameCache.getFrame('k', 3, 1)).toBe(shown);
    expect(pins()).toBe(2);
    one.release(); two.release();
    expect(pins()).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('a failure rejects every subscriber and a later request starts afresh', async () => {
    const a = acquire(desc()), b = acquire(desc(), { priority: 'background' });
    await settle();
    calls[0]!.fail(new Error('capture failed'));
    await expect(a.lease).rejects.toThrow('capture failed');
    await expect(b.lease).rejects.toThrow('capture failed');
    const retry = acquire(desc());
    await settle();
    expect(calls).toHaveLength(2);
    calls[1]!.answer(pixels());
    (await retry.lease).release();
  });

  it('a request names its divisor: two divisors are two jobs', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    read.mockImplementation(async () => bitmap());
    const [half, full] = await Promise.all([acquire(desc(), { scaleDiv: 2 }).lease, acquire(desc()).lease]);
    expect(read.mock.calls.map(([, , div]) => div)).toEqual([2, 1]);
    expect(half.bitmap).not.toBe(full.bitmap);
    half.release(); full.release();
  });
});

describe('owners and aborts', () => {
  it('a newer current request from the same owner cancels the transport call, unless an ahead subscriber shares it', async () => {
    const owner = {};
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const old = acquire(desc(0), { owner });
    await settle();
    const next = acquire(desc(1), { owner });
    await expect(old.lease).rejects.toMatchObject(superseded);
    expect(calls[0]!.cancel).toHaveBeenCalledOnce();
    const late = bitmap();
    calls[0]!.answer({ kind: 'pixels', bitmap: late, persisted: false });
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(sharedMotifFrameCache.hasFrame('k', 0, 1)).toBe(false);
    calls[1]!.answer(pixels());
    (await next.lease).release();

    const warm = acquire(desc(5), { priority: 'ahead' });
    const shown = acquire(desc(5), { owner });
    await settle();
    expect(calls[2]!.request.priority).toBe('current');
    const newest = acquire(desc(6), { owner });
    await expect(shown.lease).rejects.toMatchObject(superseded);
    expect(calls[2]!.cancel).not.toHaveBeenCalled();
    calls[2]!.answer(pixels());
    (await warm.lease).release();
    await settle();
    calls[3]!.answer(pixels());
    (await newest.lease).release();
    expect(pins()).toBe(0);
  });

  it('an abort before admission captures nothing', async () => {
    const aborted = new AbortController(); aborted.abort();
    await expect(acquireMotifFrame(desc(), { scaleDiv: 1, priority: 'current', signal: aborted.signal }).lease).rejects.toMatchObject(superseded);
    const { lease, controller } = acquire(desc());
    controller.abort();
    await expect(lease).rejects.toMatchObject(superseded);
    await settle();
    expect(captureMotif).not.toHaveBeenCalled();
  });

  it('an abort after admission cancels the capture and closes its late result unpublished', async () => {
    const { lease, controller } = acquire(desc());
    await settle();
    controller.abort();
    await expect(lease).rejects.toMatchObject(superseded);
    expect(calls[0]!.cancel).toHaveBeenCalledOnce();
    const late = bitmap();
    calls[0]!.answer({ kind: 'pixels', bitmap: late, persisted: true });
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(sharedMotifFrameCache.size()).toBe(0);
    // Stored is stored, whoever still wants the frame.
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(true);
  });

  it('a `stored` reply after every subscriber left still records the frame, and reads nothing', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const { lease, controller } = acquire(desc());
    await settle();
    controller.abort();
    await expect(lease).rejects.toMatchObject(superseded);
    calls[0]!.answer({ kind: 'stored' });
    await settle();
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('read or capture', () => {
  it('a `stored` reply reads the frame at the request divisor', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const half = bitmap();
    read.mockResolvedValueOnce(half);
    const { lease } = acquire(desc(), { scaleDiv: 2 });
    await settle();
    calls[0]!.answer({ kind: 'stored' });
    expect((await lease).bitmap).toBe(half);
    expect(read).toHaveBeenCalledExactlyOnceWith('k', 0, 2, {});
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(true);
    expect(sharedMotifFrameCache.hasFrame('k', 0, 1)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a read miss drops the frame from coverage and asks main without `afterMiss`, so main checks the store', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    const { lease } = acquire(desc());
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toMatchObject({ address: { hash: hashCacheKey('k'), frame: 0 } });
    expect(calls[0]!.request).not.toHaveProperty('afterMiss');
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(false);
    calls[0]!.answer(pixels());
    (await lease).release();
    expect(read).toHaveBeenCalledOnce();
  });

  it('a stale read miss of a stored frame reads it again and captures nothing', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    const saved = bitmap();
    read.mockResolvedValueOnce(null).mockResolvedValueOnce(saved);
    const { lease } = acquire(desc());
    await settle();
    calls[0]!.answer({ kind: 'stored' });
    expect((await lease).bitmap).toBe(saved);
    expect(read).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(true);
  });

  it('a stored frame that misses on every read is captured `afterMiss` after its second read, and never read a third time', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    const { lease } = acquire(desc());
    await settle();
    calls[0]!.answer({ kind: 'stored' });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(calls.map(call => call.request.afterMiss)).toEqual([undefined, true]);
    calls[1]!.answer(pixels());
    (await lease).release();
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });

  it('a stored frame that misses on read is captured `afterMiss`', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const { lease } = acquire(desc());
    await settle();
    calls[0]!.answer({ kind: 'stored' });
    await settle();
    expect(read).toHaveBeenCalledOnce();
    expect(calls.map(call => call.request.afterMiss)).toEqual([undefined, true]);
    calls[1]!.answer(pixels());
    (await lease).release();
  });

  it.each([
    ['a `stored` reply and a read miss', new Set<number>(), 1],
    ['a read miss, a `stored` reply and a read miss', new Set([0]), 2],
  ])('after %s, a `stored` reply rejects as a miss instead of reading again', async (_name, saved, reads) => {
    sharedBakedKeyIndex.restoreFrames('k', saved);
    const { lease } = acquire(desc());
    await settle();
    calls[0]!.answer({ kind: 'stored' });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.request.afterMiss).toBe(true);
    calls[1]!.answer({ kind: 'stored' });
    await expect(lease).rejects.toMatchObject({ code: 'miss' });
    await settle();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(calls).toHaveLength(2);
  });

  it('a transport error rejects and never captures', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    read.mockRejectedValueOnce(new MotifTransportError('utility', 'closed'));
    await expect(acquire(desc()).lease).rejects.toBeInstanceOf(MotifTransportError);
    await settle();
    expect(captureMotif).not.toHaveBeenCalled();
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(true);
  });

  it('a parameter-preview frame is never read and has no address', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    sharedBakedKeyIndex.beginHydration();
    const { lease } = acquire(desc(0, 'k', true));
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(calls[0]!.request).not.toHaveProperty('address');
    calls[0]!.answer(pixels());
    const overlay = await lease;
    expect(sharedMotifOverlayCache.getFrame('k', 0, 1)).toBe(overlay.bitmap);
    expect(sharedMotifFrameCache.size()).toBe(0);
    expect([overlayPins(), pins()]).toEqual([1, 0]);
    overlay.release(); overlay.release();
    expect(overlayPins()).toBe(0);
  });
});

describe('admission', () => {
  it('sends current, then ahead, then background, and a promotion reaches the capture in main', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const running = acquire(desc(0), { priority: 'background' });
    await settle();
    const queued = [acquire(desc(1), { priority: 'background' }), acquire(desc(2), { priority: 'ahead' }), acquire(desc(3))];
    const promoted = acquire(desc(0));
    await settle();
    expect(calls[0]!.request.priority).toBe('background');
    expect(calls[0]!.setPriority).toHaveBeenCalledExactlyOnceWith('current');
    for (let i = 0; i < 4; i++) {
      calls[i]!.answer(pixels());
      await settle();
    }
    expect(sentFrames()).toEqual([0, 3, 2, 1]);
    for (const { lease } of [running, promoted, ...queued]) (await lease).release();
    expect(pins()).toBe(0);
  });

  it('sends a current capture at once while the send window is full of lookahead', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    for (let frame = 0; frame <= sendWindow; frame++) acquire(desc(frame), { priority: 'ahead' });
    await settle();
    expect(calls).toHaveLength(sendWindow);
    acquire(desc(50));
    await settle();
    expect(sentFrames()).toEqual([...Array.from({ length: sendWindow }, (_, i) => i), 50]);
    expect(calls.at(-1)!.request.priority).toBe('current');
  });

  it('keeps at most `captureRequests` lookahead captures in main, a promoted one included', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    for (let frame = 0; frame < sendWindow + 2; frame++) acquire(desc(frame), { priority: 'ahead' });
    await settle();
    expect(calls).toHaveLength(sendWindow);
    // Promoted, frame 0 keeps its place: frame `sendWindow` still waits.
    const shown = acquire(desc(0));
    await settle();
    expect(calls[0]!.setPriority).toHaveBeenCalledExactlyOnceWith('current');
    expect(calls).toHaveLength(sendWindow);
    calls[0]!.answer(pixels());
    (await shown.lease).release();
    await settle();
    expect(calls).toHaveLength(sendWindow + 1);
    calls[1]!.answer(pixels());
    await settle();
    expect(calls).toHaveLength(sendWindow + 2);
  });

  it('a current capture demoted in main takes a place in the send window', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const shown = acquire(desc(9));
    acquire(desc(9), { priority: 'ahead' });
    await settle();
    for (let frame = 0; frame < sendWindow; frame++) acquire(desc(frame), { priority: 'ahead' });
    shown.controller.abort();
    await settle();
    expect(calls[0]!.setPriority).toHaveBeenCalledExactlyOnceWith('ahead');
    expect(sentFrames()).toEqual([9, ...Array.from({ length: sendWindow - 1 }, (_, i) => i)]);
  });

  it('sends lookahead lowest order first, ties in arrival order, and a re-rank changes what goes next', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    for (let i = 0; i < sendWindow; i++) acquire(desc(100 + i), { priority: 'ahead', order: -1 });
    await settle();
    const late = acquire(desc(1), { priority: 'ahead', order: 5 });
    acquire(desc(2), { priority: 'ahead', order: 3 });
    acquire(desc(3), { priority: 'ahead', order: 3 });
    acquire(desc(4), { priority: 'ahead' });
    await settle();
    late.setPriority('ahead', 0);
    for (let i = 0; i < 4; i++) {
      calls[i]!.answer(pixels());
      await settle();
    }
    expect(sentFrames().slice(sendWindow)).toEqual([1, 2, 3, 4]);
  });

  it('a job takes the lowest order among its subscribers', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    for (let i = 0; i < sendWindow; i++) acquire(desc(100 + i), { priority: 'ahead', order: -1 });
    await settle();
    acquire(desc(1), { priority: 'ahead', order: 1 });
    acquire(desc(2), { priority: 'ahead', order: 2 });
    acquire(desc(2), { priority: 'ahead', order: 0 });
    await settle();
    calls[0]!.answer(pixels());
    await settle();
    expect(sentFrames().at(-1)).toBe(2);
  });

  it('a demotion reaches the capture in main, and promoting a waiting one sends it at once', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const warm = acquire(desc(0), { priority: 'ahead' });
    await settle();
    warm.setPriority('background');
    await settle();
    expect(calls[0]!.setPriority).toHaveBeenCalledExactlyOnceWith('background');
    for (let i = 1; i < sendWindow; i++) acquire(desc(i), { priority: 'ahead' });
    const queued = acquire(desc(9), { priority: 'background' });
    await settle();
    expect(calls).toHaveLength(sendWindow);
    queued.setPriority('current');
    await settle();
    expect(calls.at(-1)!.request).toMatchObject({ priority: 'current', address: { frame: 9 } });
  });

  it('a project reset fences queued work and work waiting for the inventory', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const running = acquire(desc(0));
    await settle();
    const queued = acquire(desc(1));
    sharedBakedKeyIndex.beginHydration();
    const waiting = acquire(desc(2));
    resetMotifFrameRequests();
    sharedBakedKeyIndex.finishHydration();
    for (const { lease } of [running, queued, waiting]) await expect(lease).rejects.toMatchObject(superseded);
    const late = bitmap();
    calls[0]!.answer({ kind: 'pixels', bitmap: late, persisted: false });
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(sharedMotifFrameCache.size()).toBe(0);
  });
});

describe('project reset', () => {
  it('closes a read that lands after the reset, unpublished', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    let land!: (bitmap: ImageBitmap) => void;
    read.mockReturnValueOnce(new Promise(resolve => { land = resolve; }));
    const { lease } = acquire(desc());
    await settle();
    resetMotifFrameRequests();
    await expect(lease).rejects.toMatchObject(superseded);
    const late = bitmap();
    land(late);
    await settle();
    expect(late.close).toHaveBeenCalledOnce();
    expect(sharedMotifFrameCache.size()).toBe(0);
    expect(pins()).toBe(0);
  });

  it('a `stored` reply that lands after the reset reads nothing and records nothing', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const { lease } = acquire(desc());
    await settle();
    resetMotifFrameRequests();
    await expect(lease).rejects.toMatchObject(superseded);
    calls[0]!.answer({ kind: 'stored' });
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(false);
  });
});

describe('export', () => {
  const exported = (d: MotifFrameDescriptor, request: Partial<MotifFrameRequest> = {}) =>
    acquire(d, { purpose: 'export', finalizationToken: 'fin', ...request });

  it('reads with its token into a bitmap of its own and leaves L0 alone', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    sharedMotifFrameCache.setFrame('k', 0, 1, bitmap());
    const saved = bitmap();
    read.mockResolvedValueOnce(saved);
    const lease = await exported(desc()).lease;
    expect(lease.bitmap).toBe(saved);
    expect(read).toHaveBeenCalledExactlyOnceWith('k', 0, 1, { finalizationToken: 'fin' });
    expect(sharedMotifFrameCache.getFrame('k', 0, 1)).not.toBe(saved);
    expect(pins()).toBe(0);
    lease.release();
    expect(saved.close).toHaveBeenCalledOnce();
  });

  it('asks main to keep a capture, and resolves its pixels even when main failed to store them', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    const unstored = exported(desc(0)), stored = exported(desc(1));
    await settle();
    expect(calls[0]!.request).toMatchObject({ priority: 'current', store: 'keep', finalizationToken: 'fin', address: { frame: 0 } });
    calls[0]!.answer(pixels(false));
    calls[1]!.answer(pixels(true));
    await Promise.all([unstored.lease, stored.lease]);
    expect([sharedBakedKeyIndex.hasFrame('k', 0), sharedBakedKeyIndex.hasFrame('k', 1)]).toEqual([false, true]);
    expect(sharedMotifFrameCache.size()).toBe(0);
  });

  it('waits for the inventory before choosing between read and capture', async () => {
    sharedBakedKeyIndex.beginHydration();
    const saved = bitmap();
    read.mockResolvedValueOnce(saved);
    const { lease } = exported(desc());
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(captureMotif).not.toHaveBeenCalled();
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    sharedBakedKeyIndex.finishHydration();
    expect((await lease).bitmap).toBe(saved);
    expect(captureMotif).not.toHaveBeenCalled();
  });

  it('pipelines captures outside the send window', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    for (let frame = 0; frame < sendWindow; frame++) acquire(desc(frame), { priority: 'ahead' });
    await settle();
    exported(desc(10)); exported(desc(11));
    await settle();
    expect(sentFrames()).toEqual([...Array.from({ length: sendWindow }, (_, i) => i), 10, 11]);
  });

  it('two exports of one frame share a capture and own separate bitmaps', async () => {
    const a = exported(desc()), b = exported(desc());
    await settle();
    calls[0]!.answer(pixels());
    const [one, two] = await Promise.all([a.lease, b.lease]);
    expect(calls).toHaveLength(1);
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(one.bitmap).not.toBe(two.bitmap);
  });

  it.each([0, 1])('an export aborted while the clones are made gets nothing, and its bitmap is closed (subscriber %i)', async aborted => {
    let clone!: (bitmap: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockReturnValueOnce(new Promise(resolve => { clone = resolve; }));
    const requests = [exported(desc()), exported(desc())];
    await settle();
    const original = bitmap(), copy = bitmap();
    calls[0]!.answer({ kind: 'pixels', bitmap: original, persisted: false });
    await settle();
    requests[aborted]!.controller.abort();
    clone(copy);
    await expect(requests[aborted]!.lease).rejects.toMatchObject(superseded);
    const kept = await requests[1 - aborted]!.lease;
    // The first subscriber gets the original, the rest a clone each.
    expect(kept.bitmap).toBe(aborted === 0 ? copy : original);
    expect((aborted === 0 ? original : copy).close).toHaveBeenCalledOnce();
    kept.release();
  });
});
