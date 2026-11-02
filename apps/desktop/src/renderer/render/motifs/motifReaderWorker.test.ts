import { describe, expect, it, vi } from 'vitest';
import { serveMotifReader, type MotifReaderWorkerIn, type MotifReaderWorkerOut, type MotifReaderWorkerScope } from './motifReaderWorker';
import type { MotifReadReply } from '../../../shared/motifs/readerProtocol';

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function fakePort() {
  const closeListeners: (() => void)[] = [];
  const port = {
    onmessage: null as ((event: MessageEvent<MotifReadReply>) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
    addEventListener: (type: string, listener: () => void) => { if (type === 'close') closeListeners.push(listener); },
    reply: (data: MotifReadReply) => port.onmessage?.({ data } as MessageEvent<MotifReadReply>),
    closeFromMain: () => closeListeners.forEach(listener => listener()),
  };
  return port;
}

function setup() {
  const posted: { message: MotifReaderWorkerOut; transfer?: Transferable[] }[] = [];
  const scope: MotifReaderWorkerScope = { onmessage: null, postMessage: (message, transfer) => { posted.push({ message, ...(transfer ? { transfer } : {}) }); } };
  const makeBitmap = vi.fn(async (_rgba: Uint8Array, width: number, height: number) => ({ width, height }) as ImageBitmap);
  serveMotifReader(scope, makeBitmap);
  const send = (data: MotifReaderWorkerIn) => scope.onmessage?.({ data } as MessageEvent<MotifReaderWorkerIn>);
  return { posted, makeBitmap, send };
}

describe('motifReaderWorker', () => {
  it('forwards reads to the port and turns pixels into a transferred bitmap', async () => {
    const h = setup(), port = fakePort();
    h.send({ port: port as unknown as MessagePort, epoch: 1 });
    h.send({ id: 1, hash: 'a'.repeat(32), frame: 0, div: 2 });
    expect(port.postMessage).toHaveBeenCalledWith({ id: 1, hash: 'a'.repeat(32), frame: 0, div: 2 });
    const timing = { readMs: 1, decodeMs: 1, hashMs: 1, scaleMs: 1 };
    port.reply({ id: 1, frame: { width: 2, height: 1, rgba: new Uint8Array(8), timing } });
    await flush();
    expect(h.makeBitmap).toHaveBeenCalledWith(expect.any(Uint8Array), 2, 1);
    const { message, transfer } = h.posted[0]!;
    expect(message).toMatchObject({ id: 1, bitmap: { width: 2, height: 1 }, timing });
    expect(transfer).toEqual([(message as { bitmap: ImageBitmap }).bitmap]);
  });

  it('passes misses and errors through, and reports a closed port by epoch', async () => {
    const h = setup(), port = fakePort();
    h.send({ port: port as unknown as MessagePort, epoch: 4 });
    port.reply({ id: 1, miss: true });
    port.reply({ id: 2, error: 'pool closed' });
    port.closeFromMain();
    await flush();
    expect(h.posted.map(p => p.message)).toEqual([{ id: 1, miss: true }, { id: 2, error: 'pool closed' }, { closed: 4 }]);
    h.send({ id: 3, hash: 'a'.repeat(32), frame: 0, div: 1 });
    expect(h.posted.at(-1)!.message).toEqual({ id: 3, error: 'Motif reader port missing' });
  });

  it('a new port supersedes the previous one, whose close is not reported', () => {
    const h = setup(), first = fakePort(), second = fakePort();
    h.send({ port: first as unknown as MessagePort, epoch: 1 });
    h.send({ port: second as unknown as MessagePort, epoch: 2 });
    expect(first.close).toHaveBeenCalled();
    first.closeFromMain();
    expect(h.posted).toEqual([]);
  });
});
