import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotifFrameReader, MotifTransportError, type MotifFrameReaderDeps, type MotifReaderWorkerLike } from './MotifFrameReader';
import type { MotifTextureRead } from './frameTransport';
import type { MotifReaderWorkerIn, MotifReaderWorkerOut } from './motifReaderWorker';
import type { MotifReadRequest } from '../../../shared/motifs/readerProtocol';

const timing = { readMs: 1, decodeMs: 2, hashMs: 3, scaleMs: 4 };
function bitmap() { return { width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap; }
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

class FakeWorker implements MotifReaderWorkerLike {
  onmessage: ((event: MessageEvent<MotifReaderWorkerOut>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly ports: { port: MessagePort; epoch: number }[] = [];
  readonly reads: MotifReadRequest[] = [];
  terminate = vi.fn();
  postMessage(message: MotifReaderWorkerIn): void {
    if ('port' in message) this.ports.push(message);
    else this.reads.push(message);
  }
  answer(data: MotifReaderWorkerOut): void { this.onmessage?.({ data } as MessageEvent<MotifReaderWorkerOut>); }
}

function setup(options: { textureLane?: boolean; autoPort?: boolean } = {}) {
  const workers: FakeWorker[] = [];
  let events!: { port(port: MessagePort): void; reset(): void };
  const port = () => events.port({ close: vi.fn() } as unknown as MessagePort);
  const connect = vi.fn(() => { if (options.autoPort !== false) port(); });
  const readTexture = vi.fn<MotifFrameReaderDeps['readTexture']>(async () => null);
  const reader = new MotifFrameReader({
    textureLane: options.textureLane ?? false,
    readTexture,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    connect,
    listen: handlers => { events = handlers; },
    timeoutMs: 1_000,
  });
  return {
    reader, connect, readTexture, workers, port,
    reset: () => events.reset(),
    get worker() { return workers.at(-1)!; },
  };
}

describe('MotifFrameReader utility lane', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a miss gives null; a frame gives the worker bitmap and its stage times', async () => {
    const h = setup();
    const miss = h.reader.read('key', 3, 2);
    await flush();
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.worker.ports).toHaveLength(1);
    const [request] = h.worker.reads;
    expect(request).toMatchObject({ frame: 3, div: 2 });
    expect(request!.hash).toMatch(/^[0-9a-f]{32}$/);
    h.worker.answer({ id: request!.id, miss: true });
    await expect(miss).resolves.toBeNull();

    const hit = h.reader.read('key', 4, 1);
    await flush();
    const frame = bitmap();
    h.worker.answer({ id: h.worker.reads[1]!.id, bitmap: frame, timing, bitmapMs: 5 });
    await expect(hit).resolves.toBe(frame);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.reader.stats).toMatchObject({
      reads: { texture: 0, utility: 2 }, misses: 1, fallbacks: 0, transportFailures: 0, restarts: 0,
      stages: { readMs: 1, decodeMs: 2, hashMs: 3, scaleMs: 4, bitmapMs: 5, importMs: null, uploadMs: null },
    });
  });

  it('an error reply is a transport error, retried exactly once', async () => {
    const h = setup();
    const read = h.reader.read('key', 0, 1);
    const settled = read.catch(error => error);
    await flush();
    h.worker.answer({ id: h.worker.reads[0]!.id, error: 'pool closed' });
    await flush();
    expect(h.worker.reads).toHaveLength(2);
    h.worker.answer({ id: h.worker.reads[1]!.id, error: 'pool closed' });
    const error = await settled;
    expect(error).toBeInstanceOf(MotifTransportError);
    expect(error).toMatchObject({ lane: 'utility', reason: 'error' });
    expect(h.worker.reads).toHaveLength(2);
    expect(h.reader.stats.transportFailures).toBe(2);
  });

  it('a reset is a transport error; the retry reconnects and reads on the new port', async () => {
    const h = setup();
    const read = h.reader.read('key', 0, 1);
    await flush();
    h.reset();
    await flush();
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.worker.ports.map(p => p.epoch)).toEqual([1, 2]);
    expect(h.worker.reads).toHaveLength(2);
    const frame = bitmap();
    h.worker.answer({ id: h.worker.reads[1]!.id, bitmap: frame, timing, bitmapMs: 1 });
    await expect(read).resolves.toBe(frame);
    expect(h.reader.stats).toMatchObject({ transportFailures: 1, restarts: 1 });
  });

  it('a reset on the retry too throws, never null', async () => {
    const h = setup();
    const settled = h.reader.read('key', 0, 1).catch(error => error);
    await flush();
    h.reset();
    await flush();
    h.reset();
    expect(await settled).toMatchObject({ name: 'MotifTransportError', reason: 'reset' });
    expect(h.worker.reads).toHaveLength(2);
  });

  it('a silent port times out, retries once on a new connection, then throws', async () => {
    const h = setup();
    const settled = h.reader.read('key', 0, 1).catch(error => error);
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.worker.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled).toMatchObject({ name: 'MotifTransportError', reason: 'timeout' });
    expect(h.worker.reads).toHaveLength(2);
  });

  it('a connect main never answers times out and connects again', async () => {
    const h = setup({ autoPort: false });
    const read = h.reader.read('key', 0, 1);
    await flush();
    expect(h.worker).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.connect).toHaveBeenCalledTimes(2);
    h.port();
    await flush();
    h.worker.answer({ id: h.worker.reads[0]!.id, miss: true });
    await expect(read).resolves.toBeNull();
  });

  it('a closed port fails its reads; a close from a superseded port is ignored', async () => {
    const h = setup();
    const first = h.reader.read('key', 0, 1);
    await flush();
    h.worker.answer({ closed: 1 });
    await flush();
    expect(h.worker.ports.map(p => p.epoch)).toEqual([1, 2]);
    h.worker.answer({ closed: 1 });
    await flush();
    expect(h.connect).toHaveBeenCalledTimes(2);
    h.worker.answer({ id: h.worker.reads[1]!.id, miss: true });
    await expect(first).resolves.toBeNull();
    expect(h.reader.stats).toMatchObject({ transportFailures: 1, restarts: 1 });
  });

  it('a worker crash restarts the worker and the connection', async () => {
    const h = setup();
    const read = h.reader.read('key', 0, 1);
    await flush();
    const crashed = h.worker;
    crashed.onerror?.({ preventDefault() {} } as ErrorEvent);
    await flush();
    expect(crashed.terminate).toHaveBeenCalled();
    expect(h.workers).toHaveLength(2);
    h.worker.answer({ id: h.worker.reads[0]!.id, miss: true });
    await expect(read).resolves.toBeNull();
  });

  it('keeps at most three reads in flight; extras queue', async () => {
    const h = setup();
    const reads = [0, 1, 2, 3, 4].map(frame => h.reader.read('key', frame, 1));
    await flush();
    expect(h.worker.reads.map(r => r.frame)).toEqual([0, 1, 2]);
    h.worker.answer({ id: h.worker.reads[1]!.id, miss: true });
    await flush();
    expect(h.worker.reads.map(r => r.frame)).toEqual([0, 1, 2, 3]);
    for (const request of h.worker.reads.slice(2)) h.worker.answer({ id: request.id, miss: true });
    await flush();
    expect(h.worker.reads.map(r => r.frame)).toEqual([0, 1, 2, 3, 4]);
    for (const request of [h.worker.reads[0]!, h.worker.reads[4]!]) h.worker.answer({ id: request.id, miss: true });
    await expect(Promise.all(reads)).resolves.toEqual([null, null, null, null, null]);
  });

  it('closes a bitmap that arrives after its read failed', async () => {
    const h = setup();
    const read = h.reader.read('key', 0, 1).catch(error => error);
    await flush();
    const late = h.worker.reads[0]!.id;
    h.reset();
    await flush();
    const frame = bitmap();
    h.worker.answer({ id: late, bitmap: frame, timing, bitmapMs: 1 });
    expect(frame.close).toHaveBeenCalled();
    h.worker.answer({ id: h.worker.reads[1]!.id, miss: true });
    await expect(read).resolves.toBeNull();
  });

  it('an E2E interceptor wraps admitted reads; production builds ignore it', async () => {
    const g = globalThis as { __weftcutE2EMotifReadInterceptor?: unknown };
    const seen: unknown[] = [];
    g.__weftcutE2EMotifReadInterceptor = (address: unknown, div: number, next: () => Promise<ImageBitmap | null>) => {
      seen.push({ address, div });
      return seen.length === 1 ? Promise.resolve(null) : next();
    };
    try {
      const h = setup();
      vi.stubEnv('VITE_WEFTCUT_E2E', '1');
      await expect(h.reader.readAddress({ hash: 'a'.repeat(32), frame: 2 }, 2)).resolves.toBeNull();
      expect(h.worker).toBeUndefined();
      const read = h.reader.read('key', 0, 1);
      await flush();
      h.worker.answer({ id: h.worker.reads[0]!.id, miss: true });
      await expect(read).resolves.toBeNull();
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual({ address: { hash: 'a'.repeat(32), frame: 2 }, div: 2 });

      vi.stubEnv('VITE_WEFTCUT_E2E', '');
      const plain = h.reader.read('key', 1, 1);
      await flush();
      h.worker.answer({ id: h.worker.reads[1]!.id, miss: true });
      await expect(plain).resolves.toBeNull();
      expect(seen).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      delete g.__weftcutE2EMotifReadInterceptor;
    }
  });
});

describe('MotifFrameReader texture lane', () => {
  it('reads at the divisor, with the finalization token', async () => {
    const h = setup({ textureLane: true });
    const frame = bitmap();
    h.readTexture.mockResolvedValueOnce({
      bitmap: frame, importMs: 2,
      timing: { read: timing, premultiplyMs: 1, acquireMs: 1, gpuMs: 1 },
    });
    await expect(h.reader.read('key', 7, 4, { finalizationToken: 'fin' })).resolves.toBe(frame);
    expect(h.readTexture).toHaveBeenCalledWith(expect.objectContaining({ frame: 7, div: 4, finalizationToken: 'fin' }));
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.reader.stats).toMatchObject({ reads: { texture: 1, utility: 0 }, stages: { uploadMs: 3, importMs: 2, bitmapMs: null } });
  });

  it('`unavailable` falls back to the utility lane and is not a transport failure', async () => {
    const h = setup({ textureLane: true });
    h.readTexture.mockResolvedValueOnce('unavailable' satisfies MotifTextureRead);
    const read = h.reader.read('key', 0, 2);
    await flush();
    expect(h.worker.reads).toEqual([expect.objectContaining({ frame: 0, div: 2 })]);
    const frame = bitmap();
    h.worker.answer({ id: h.worker.reads[0]!.id, bitmap: frame, timing, bitmapMs: 1 });
    await expect(read).resolves.toBe(frame);
    expect(h.reader.stats).toMatchObject({ reads: { texture: 0, utility: 1 }, fallbacks: 1, transportFailures: 0 });
  });

  it('a texture miss is null; a transport error retries once and then throws', async () => {
    const h = setup({ textureLane: true });
    await expect(h.reader.read('key', 0, 1)).resolves.toBeNull();
    h.readTexture.mockRejectedValue(new MotifTransportError('texture', 'timeout'));
    await expect(h.reader.read('key', 1, 1)).rejects.toMatchObject({ lane: 'texture', reason: 'timeout' });
    expect(h.readTexture).toHaveBeenCalledTimes(3);
    expect(h.reader.stats).toMatchObject({ misses: 1, transportFailures: 2 });
  });
});
