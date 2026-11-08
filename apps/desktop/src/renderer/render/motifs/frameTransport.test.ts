import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMotif, readMotifTexture, type MotifCaptureRequest } from './frameTransport';

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
        if (!data.control) port!.postMessage({ id: data.id, ...replies.shift() });
      };
    },
  });
});
afterAll(() => { preloadPort?.close(); vi.unstubAllGlobals(); });
beforeEach(() => { requests.length = 0; replies = []; });

const cache = { hash: 'c'.repeat(32), frame: 5 };
const args = { motifId: 'm', tSec: 0, propsJson: '{}', width: 2, height: 2, contentHash: '' };
const capture = (request: Partial<MotifCaptureRequest> = {}) => captureMotif({ ...args, priority: 'current', address: cache, ...request });
const unaddressed = () => captureMotif({ ...args, priority: 'current' });
const controls = () => requests.filter(r => r.control).map(r => r.control);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('captureMotif', () => {
  it('asks main to check its store at the address, keep the frame for export, and skip the check after a miss', async () => {
    replies = [{ bitmap: { width: 2 }, persisted: false }, { bitmap: { width: 2 }, persisted: true }, { bitmap: { width: 2 } }, { bitmap: { width: 2 } }];
    await expect(capture().reply).resolves.toEqual({ kind: 'pixels', bitmap: { width: 2 }, persisted: false });
    await capture({ store: 'keep', finalizationToken: 'fin' }).reply;
    await capture({ store: 'keep', afterMiss: true, priority: 'ahead' }).reply;
    await unaddressed().reply;
    const sent = requests.map(r => r.capture as Record<string, unknown>);
    expect(sent[0]).toMatchObject({ ...args, cache, high: true });
    expect(sent[0]).not.toHaveProperty('bake');
    expect(sent[1]).toMatchObject({ cache, bake: cache, finalizationToken: 'fin', high: true });
    expect(sent[2]).toMatchObject({ bake: cache, high: false });
    expect(sent[2]).not.toHaveProperty('cache');
    expect(sent[3]).not.toHaveProperty('cache');
    expect(new Set(sent.map(r => r.coalesceKey)).size).toBe(4);
  });

  it('answers `stored` without pixels; an unaddressed capture must carry pixels', async () => {
    replies = [{ bitmap: null, persisted: true, stored: true }, { bitmap: null, persisted: true, stored: true }];
    await expect(capture().reply).resolves.toEqual({ kind: 'stored' });
    await expect(unaddressed().reply).rejects.toThrow('Motif capture returned no frame');
  });

  it('promotes to current once, never demotes, and controls only an unanswered capture', async () => {
    replies = [{ bitmap: { width: 2 } }];
    const call = capture({ priority: 'background' });
    call.setPriority('ahead');
    call.setPriority('current');
    call.setPriority('current');
    call.cancel();
    await call.reply;
    const key = (requests[0]!.capture as Record<string, unknown>).coalesceKey;
    expect(controls()).toEqual([{ key, action: 'promote' }, { key, action: 'cancel' }]);
    call.cancel();
    await settle();
    expect(controls()).toHaveLength(2);
  });

  it('a coded capture failure arrives with its code; an uncoded one stays plain', async () => {
    replies = [{ error: 'superseded by a newer request', code: 'superseded' }, { error: 'Error: boom' }];
    await expect(capture().reply).rejects.toMatchObject({ code: 'superseded', message: '[motif:superseded] superseded by a newer request' });
    const plain = await capture().reply.catch((error: unknown) => error);
    expect(plain).not.toHaveProperty('code');
    expect(plain).toMatchObject({ message: 'Error: boom' });
  });
});

describe('texture lane read', () => {
  it('sends the divisor; `unavailable` keeps its reason and generation, and an error reply is distinct', async () => {
    replies = [{ unavailable: 'lane', generation: 2 }, { unavailable: 'read', generation: 2 }, { error: 'Motif texture import missing' }];
    await expect(readMotifTexture({ hash: cache.hash, frame: 1, div: 4 })).resolves.toEqual({ kind: 'unavailable', reason: 'lane', generation: 2 });
    expect(requests[0]).toMatchObject({ hash: cache.hash, frame: 1, div: 4 });
    await expect(readMotifTexture({ hash: cache.hash, frame: 1, div: 4 })).resolves.toEqual({ kind: 'unavailable', reason: 'read', generation: 2 });
    await expect(readMotifTexture({ hash: cache.hash, frame: 1, div: 4 })).rejects.toMatchObject({ name: 'MotifTransportError', lane: 'texture', reason: 'error' });
  });
});
