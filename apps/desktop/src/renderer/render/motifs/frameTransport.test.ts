import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMotif, readMotifTexture, type MotifCaptureRequest } from './frameTransport';
import { MotifError } from '../../../shared/motifs/errors';

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
  it('sends the request as given, each with its own request id', async () => {
    replies = [{ bitmap: { width: 2 }, persisted: false }, { bitmap: { width: 2 }, persisted: true }, { bitmap: { width: 2 } }];
    await expect(capture().reply).resolves.toEqual({ kind: 'pixels', bitmap: { width: 2 }, persisted: false });
    await capture({ store: 'keep', finalizationToken: 'fin' }).reply;
    await capture({ store: 'keep', afterMiss: true, priority: 'ahead' }).reply;
    const sent = requests.map(r => r.capture as Record<string, unknown>);
    expect(sent[0]).toEqual({ ...args, priority: 'current', address: cache, requestId: expect.any(Number) });
    expect(sent[1]).toMatchObject({ address: cache, store: 'keep', finalizationToken: 'fin', priority: 'current' });
    expect(sent[2]).toMatchObject({ address: cache, store: 'keep', afterMiss: true, priority: 'ahead' });
    expect(new Set(sent.map(r => r.requestId)).size).toBe(3);
  });

  it('answers `stored` without pixels; an unaddressed capture must carry pixels', async () => {
    replies = [{ bitmap: null, persisted: true, stored: true }, { bitmap: null, persisted: true, stored: true }];
    await expect(capture().reply).resolves.toEqual({ kind: 'stored' });
    await expect(unaddressed().reply).rejects.toThrow('Motif capture returned no frame');
  });

  it('sends each priority change, down as well as up, and controls only an open capture', async () => {
    replies = [{ bitmap: { width: 2 } }];
    const call = capture({ priority: 'background' });
    call.setPriority('current');
    call.setPriority('current');
    call.setPriority('ahead');
    call.cancel();
    call.setPriority('current');
    call.cancel();
    await call.reply;
    const requestId = (requests[0]!.capture as Record<string, unknown>).requestId;
    expect(controls()).toEqual([
      { requestId, action: 'priority', priority: 'current' },
      { requestId, action: 'priority', priority: 'ahead' },
      { requestId, action: 'cancel' },
    ]);
  });

  it('sends no control after the reply', async () => {
    replies = [{ bitmap: { width: 2 } }];
    const call = capture();
    await call.reply;
    call.setPriority('background');
    call.cancel();
    await settle();
    expect(controls()).toEqual([]);
  });

  it('a capture main withdrew rejects `superseded`', async () => {
    replies = [{ superseded: true }];
    const error = await capture().reply.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MotifError);
    expect(error).toMatchObject({ code: 'superseded' });
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
