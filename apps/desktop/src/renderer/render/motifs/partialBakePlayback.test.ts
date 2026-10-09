import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotifPrewarmer } from './MotifPrewarmer';
import {
  cancelMotifFrameRequest, resetMotifFrameRequests, resolveMotifFrame,
  sharedBakedKeyIndex, sharedMotifFrameCache,
  setMotifPreparationCoverage,
} from './motifRasterCache';
import { captureMotifFrameResult } from './host';

vi.mock('./host', () => ({ captureMotifFrameResult: vi.fn() }));
vi.mock('./frameTransport', () => ({ controlStoredMotifCapture: vi.fn() }));

const bitmap = () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;
const motif = { manifest: { id: 'long', size: [1, 1], settle_rafs: 2 } } as unknown as Parameters<typeof resolveMotifFrame>[0];
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let cleanup: (() => void)[];

beforeEach(() => {
  cleanup = [];
  vi.stubGlobal('window', {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
  vi.mocked(captureMotifFrameResult).mockImplementation(() => new Promise(resolve => {
    cleanup.push(() => resolve({ bitmap: bitmap(), persisted: false }));
  }));
});
afterEach(async () => {
  cleanup.forEach(fn => fn());
  resetMotifFrameRequests();
  await settle();
  sharedBakedKeyIndex.clear();
  sharedMotifFrameCache.clearAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function warm(keys = ['long']) {
  const callbacks: (() => void)[] = [];
  const prewarmer = new MotifPrewarmer({
    capBytes: 40,
    hasFrame: (key, frame) => sharedMotifFrameCache.hasFrame(key, frame),
    setFrame: (key, frame, value) => { sharedMotifFrameCache.setFrame(key, frame, value); },
    prioritizeFrames: targets => sharedMotifFrameCache.prioritizeFrames(targets),
    schedule: cb => { callbacks.push(cb); return callbacks.length; }, cancel: () => {},
    cancelRequest: cancelMotifFrameRequest,
  });
  cleanup.unshift(() => prewarmer.dispose());
  const specs = keys.map(cacheKey => ({
    cacheKey, contentFrame: 0, contentDurationFrames: 1_000, frameBytes: 4,
    render: (frame: number, key: string) => resolveMotifFrame(motif, cacheKey, frame, frame / 60, 1_000 / 60, {}, key, 60, 1, false, 'background'),
  }));
  prewarmer.setTargets(specs);
  callbacks.shift()!();
  return { prewarmer, callbacks, specs };
}

it('pipelines three saved frames of an incomplete long Motif without capture', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 100 }, (_, i) => i)));
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockImplementation(() => new Promise(resolve => {
    cleanup.push(() => resolve(bitmap()));
  }));
  warm();
  await settle();
  expect(read.mock.calls.map(([, frame]) => frame)).toEqual([0, 1, 2]);
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
});

it('waits for main-owned preparation instead of switching its capture page for speculative frames', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  setMotifPreparationCoverage(['long']);
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockResolvedValue(bitmap());
  const h = warm();
  await settle();
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  for (let i = 0; i < 5; i++) {
    // Progress updates may rebuild the prewarm plan many times while main
    // is rendering other content. Those updates must not start a second producer.
    setMotifPreparationCoverage(['long']);
    h.prewarmer.setTargets(h.specs);
    await settle();
  }
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
  sharedBakedKeyIndex.add('long', 2);
  setMotifPreparationCoverage(['long']);
  await settle();
  expect(read).toHaveBeenCalledExactlyOnceWith('long', 2);
  expect(sharedMotifFrameCache.hasFrame('long', 2)).toBe(true);
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
});

it('foreground demand promotes a waiting main-owned frame and still shares one capture with prewarm', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  setMotifPreparationCoverage(['long']);
  warm();
  await settle();
  const foreground = resolveMotifFrame(motif, 'long', 0, 0, 20, {}, 'sprite', 60, 1);
  await settle();
  expect(captureMotifFrameResult).toHaveBeenCalledOnce();
  expect(vi.mocked(captureMotifFrameResult).mock.calls[0]![9].high).toBe(true);
  cleanup.at(-1)!();
  (await foreground).close();
  await settle();
  expect(sharedMotifFrameCache.hasFrame('long', 0)).toBe(true);
  expect(captureMotifFrameResult).toHaveBeenCalledOnce();
});

it('returns speculative capture ownership when automatic preparation is disabled', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  setMotifPreparationCoverage(['long']);
  warm();
  await settle();
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
  setMotifPreparationCoverage([]);
  await settle();
  expect(captureMotifFrameResult).toHaveBeenCalledOnce();
});

it('retries a failed disk read only after main publishes repaired coverage', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([0]));
  setMotifPreparationCoverage(['long']);
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockResolvedValueOnce(null).mockResolvedValue(bitmap());
  warm();
  await settle();
  expect(read).toHaveBeenCalledOnce();
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
  sharedBakedKeyIndex.add('long', 0);
  setMotifPreparationCoverage(['long']);
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(sharedMotifFrameCache.hasFrame('long', 0)).toBe(true);
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
});

it('reads saved frames beyond several missing frames while one capture is slow', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([3, 4, 5, 6, 7]));
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockImplementation((_key, frame) => {
    if (frame < 3) return Promise.resolve(null);
    return new Promise(resolve => { cleanup.push(() => resolve(bitmap())); });
  });
  warm();
  await settle();
  expect(read.mock.calls.map(([, frame]) => frame)).toEqual([3, 4, 5]);
  expect(captureMotifFrameResult).toHaveBeenCalledTimes(1);
});

it('an uncached sibling does not reduce saved-frame read concurrency', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set([0, 1, 2, 3, 4]));
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockImplementation(() => new Promise(resolve => {
    cleanup.push(() => resolve(bitmap()));
  }));
  warm(['cold', 'long']);
  await settle();
  expect(read.mock.calls).toEqual([['long', 0], ['long', 1], ['long', 2]]);
  expect(captureMotifFrameResult).toHaveBeenCalledTimes(1);
});

it('failed reads release disk capacity and use only one capture slot', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 10 }, (_, i) => i)));
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockImplementation(async (_key, frame) => {
    if (frame < 3) throw new Error('unreadable frame');
    return bitmap();
  });
  warm();
  await settle();
  expect(read).toHaveBeenCalledTimes(10);
  expect(captureMotifFrameResult).toHaveBeenCalledTimes(1);
  for (let frame = 3; frame < 10; frame++) expect(sharedMotifFrameCache.hasFrame('long', frame)).toBe(true);
  expect(sharedBakedKeyIndex.hasFrame('long', 0)).toBe(false);
});

it('a newly baked queued frame starts reading while an unrelated capture is still running', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set());
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockResolvedValue(bitmap());
  warm();
  await settle();
  expect(captureMotifFrameResult).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  sharedBakedKeyIndex.add('long', 2);
  await settle();
  expect(read).toHaveBeenCalledExactlyOnceWith('long', 2);
  expect(sharedMotifFrameCache.hasFrame('long', 2)).toBe(true);
  expect(captureMotifFrameResult).toHaveBeenCalledTimes(1);
});

it('seek cancels queued old-window work and closes late admitted results', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 200 }, (_, i) => i)));
  const values: ImageBitmap[] = [];
  const finish: (() => void)[] = [];
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockImplementation(() => new Promise(resolve => {
    const value = bitmap(); values.push(value);
    const release = () => resolve(value);
    finish.push(release); cleanup.push(release);
  }));
  const h = warm();
  await settle();
  h.prewarmer.setTargets(h.specs.map(spec => ({ ...spec, contentFrame: 100 })));
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
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
});

it('foreground demand promotes a queued prewarm read without acquiring it twice', async () => {
  sharedBakedKeyIndex.restoreFrames('long', new Set(Array.from({ length: 100 }, (_, i) => i)));
  const finish = new Map<number, () => void>();
  const read = vi.spyOn(sharedMotifFrameCache, 'readBitmap').mockImplementation((_key, frame) => new Promise(resolve => {
    const release = () => resolve(bitmap());
    finish.set(frame, release); cleanup.push(release);
  }));
  warm();
  await settle();
  const foreground = resolveMotifFrame(motif, 'long', 9, 9 / 60, 1_000 / 60, {}, 'sprite', 60, 1);
  finish.get(0)!();
  await settle();
  expect(read.mock.calls.map(([, frame]) => frame)).toEqual([0, 1, 2, 9]);
  finish.get(9)!();
  const value = await foreground;
  value.close();
  await settle();
  expect(sharedMotifFrameCache.hasFrame('long', 9)).toBe(true);
  expect(read.mock.calls.filter(([, frame]) => frame === 9)).toHaveLength(1);
});

it('a project reset fences work waiting for inventory restoration', async () => {
  sharedBakedKeyIndex.beginHydration();
  const old = resolveMotifFrame(motif, 'long', 0, 0, 20, {}, 'old-project', 60, 1);
  const rejected = expect(old).rejects.toThrow('superseded');
  await settle();
  resetMotifFrameRequests();
  sharedBakedKeyIndex.finishHydration();
  await rejected;
  expect(captureMotifFrameResult).not.toHaveBeenCalled();
});

it('retiring prewarm demand does not cancel the foreground subscriber sharing its capture', async () => {
  const h = warm();
  await settle();
  expect(vi.mocked(captureMotifFrameResult).mock.calls[0]![9].high).toBe(false);
  const finish = cleanup.at(-1)!;
  const foreground = resolveMotifFrame(motif, 'long', 0, 0, 20, {}, 'sprite', 60, 1);
  h.prewarmer.setTargets([]);
  finish();
  const value = await foreground;
  expect(value.close).not.toHaveBeenCalled();
  value.close();
  await settle();
  expect(captureMotifFrameResult).toHaveBeenCalledTimes(1);
  expect(sharedMotifFrameCache.size()).toBe(0);
});

it('a capture failure returns its slot and allows a later retry', async () => {
  vi.mocked(captureMotifFrameResult).mockRejectedValueOnce(new Error('capture failed'));
  const failed = resolveMotifFrame(motif, 'long', 0, 0, 20, {}, 'sprite', 60, 1);
  await expect(failed).rejects.toThrow('capture failed');
  const retry = resolveMotifFrame(motif, 'long', 0, 0, 20, {}, 'sprite', 60, 1);
  await settle();
  expect(captureMotifFrameResult).toHaveBeenCalledTimes(2);
  cleanup.at(-1)!();
  (await retry).close();
});
