import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import {
  acquireMotifFrame, peekMotifFrame, resetMotifFrameRequests, sharedBakedKeyIndex,
  sharedMotifFrameCache, sharedMotifOverlayCache, type MotifFrameRequest,
} from './motifFrameSource';
import { captureMotif, MotifTransportError, type MotifCaptureReply, type MotifCaptureRequest } from './frameTransport';
import type { MotifFrameDescriptor } from './motifFrameDescriptor';
import type { MotifFrameCache } from './frameCache';
import { hashCacheKey } from '../../../shared/motifs/cacheKey';

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
  const lease = acquireMotifFrame(d, { scaleDiv: 1, priority: 'current', signal: controller.signal, ...request });
  // Requests a test leaves pending are superseded by the reset after it.
  lease.catch(() => {});
  return { lease, controller };
}
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
    await expect(acquireMotifFrame(desc(), { scaleDiv: 1, priority: 'current', signal: aborted.signal })).rejects.toMatchObject(superseded);
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
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).not.toBe(true);
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

  it('a read miss captures once, after the miss, and drops the frame from coverage', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set([0]));
    const { lease } = acquire(desc());
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toMatchObject({ afterMiss: true, address: { hash: hashCacheKey('k'), frame: 0 } });
    expect(sharedBakedKeyIndex.hasFrame('k', 0)).toBe(false);
    calls[0]!.answer(pixels());
    (await lease).release();
    expect(read).toHaveBeenCalledOnce();
  });

  it('a stored frame that misses on read is captured after the miss', async () => {
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
    overlay.release();
  });
});

describe('admission', () => {
  it('serves current, then ahead, then background, and a promotion reaches the running capture', async () => {
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
    expect(calls.map(call => call.request.address!.frame)).toEqual([0, 3, 2, 1]);
    for (const { lease } of [running, promoted, ...queued]) (await lease).release();
    expect(pins()).toBe(0);
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

  it('pipelines captures while a preview holds the capture slot', async () => {
    sharedBakedKeyIndex.restoreFrames('k', new Set());
    acquire(desc(0));
    exported(desc(1)); exported(desc(2));
    await settle();
    expect(calls.map(call => call.request.address!.frame)).toEqual([0, 1, 2]);
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
});
