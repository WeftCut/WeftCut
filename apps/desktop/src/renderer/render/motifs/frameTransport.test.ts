import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMotifResult, MotifTransportError, readMotifTexture } from './frameTransport';

const reader = vi.hoisted(() => ({ readAddress: vi.fn() }));
vi.mock('./MotifFrameReader', () => ({ motifFrameReader: () => reader }));

// The preload's end of the frame port: answers each request from `replies`.
type Reply = Record<string, unknown>;
const requests: Record<string, unknown>[] = [];
let replies: Reply[] = [];
let preloadPort: MessagePort | null = null;

beforeAll(() => {
  vi.stubGlobal('window', {
    postMessage: (_message: unknown, _origin: string, [port]: MessagePort[]) => {
      preloadPort = port!;
      port!.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => {
        requests.push(data);
        port!.postMessage({ id: data.id, ...replies.shift() });
      };
    },
  });
});
afterAll(() => { preloadPort?.close(); vi.unstubAllGlobals(); });
beforeEach(() => { requests.length = 0; replies = []; reader.readAddress.mockReset(); });

const cache = { hash: 'c'.repeat(32), frame: 5 };
const capture = { motifId: 'm', cache, finalizationToken: 'fin' };

describe('capture `stored` reply', () => {
  it('reads the stored frame through the reader at the requested divisor', async () => {
    const bitmap = { width: 1 };
    reader.readAddress.mockResolvedValueOnce(bitmap);
    replies = [{ bitmap: null, persisted: true, stored: true }];
    // Stored under that divisor in L0, unlike a live capture.
    await expect(captureMotifResult(capture, 2)).resolves.toEqual({ bitmap, persisted: true, scaleDiv: 2 });
    expect(reader.readAddress).toHaveBeenCalledWith(cache, 2, { finalizationToken: 'fin' });
    expect(requests).toHaveLength(1);
  });

  it('reads a joined bake at its address', async () => {
    reader.readAddress.mockResolvedValueOnce({ width: 1 });
    replies = [{ bitmap: null, persisted: true, stored: true }];
    const bake = { hash: 'b'.repeat(32), frame: 5 };
    await captureMotifResult({ ...capture, bake });
    expect(reader.readAddress).toHaveBeenCalledWith(bake, 1, { finalizationToken: 'fin' });
  });

  it('a miss captures again without `cache`, once', async () => {
    reader.readAddress.mockResolvedValue(null);
    replies = [{ bitmap: null, persisted: true, stored: true }, { bitmap: { width: 2 }, persisted: false }];
    await expect(captureMotifResult(capture)).resolves.toEqual({ bitmap: { width: 2 }, persisted: false, scaleDiv: 'live' });
    expect(requests.map(r => r.capture)).toEqual([capture, { motifId: 'm', finalizationToken: 'fin' }]);

    replies = [{ bitmap: null, persisted: true, stored: true }, { bitmap: null, persisted: true, stored: true }];
    await expect(captureMotifResult(capture)).rejects.toThrow('Motif capture returned no frame');
    expect(requests).toHaveLength(4);
  });

  it('a transport error propagates and does not capture again', async () => {
    reader.readAddress.mockRejectedValueOnce(new MotifTransportError('utility', 'reset'));
    replies = [{ bitmap: null, persisted: true, stored: true }];
    await expect(captureMotifResult(capture)).rejects.toBeInstanceOf(MotifTransportError);
    expect(requests).toHaveLength(1);
  });
});

describe('texture lane read', () => {
  it('sends the divisor; `unavailable` and an error reply are distinct', async () => {
    replies = [{ unavailable: true }, { error: 'Motif texture import missing' }];
    await expect(readMotifTexture({ hash: cache.hash, frame: 1, div: 4 })).resolves.toBe('unavailable');
    expect(requests[0]).toMatchObject({ hash: cache.hash, frame: 1, div: 4 });
    await expect(readMotifTexture({ hash: cache.hash, frame: 1, div: 4 })).rejects.toMatchObject({ name: 'MotifTransportError', lane: 'texture', reason: 'error' });
  });
});
