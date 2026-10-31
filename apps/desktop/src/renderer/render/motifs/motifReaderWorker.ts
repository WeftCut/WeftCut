import type { MotifReadReply, MotifReadRequest, MotifReadTiming } from '../../../shared/motifs/readerProtocol';

// The utility lane's renderer half (ADR 0154). Requests and scaled pixels
// travel on this worker's own port to the Motif reader utility, so only the
// finished bitmap reaches the page; the page's main thread never sees pixels.

/** Page → worker: the document's current reader port, or one read. */
export type MotifReaderWorkerIn = { port: MessagePort; epoch: number } | MotifReadRequest;

/** Worker → page. `closed` names the epoch of a port that closed. */
export type MotifReaderWorkerOut =
  | { id: number; bitmap: ImageBitmap; timing: MotifReadTiming; bitmapMs: number }
  | { id: number; miss: true }
  | { id: number; error: string }
  | { closed: number };

export interface MotifReaderWorkerScope {
  onmessage: ((event: MessageEvent<MotifReaderWorkerIn>) => void) | null;
  postMessage(message: MotifReaderWorkerOut, transfer?: Transferable[]): void;
}

/** Straight RGBA to a bitmap. ImageData is built here, inside the worker. */
function bitmapFromRgba(rgba: Uint8Array, width: number, height: number): Promise<ImageBitmap> {
  const pixels = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
  return createImageBitmap(new ImageData(pixels, width, height));
}

export function serveMotifReader(
  scope: MotifReaderWorkerScope,
  makeBitmap: (rgba: Uint8Array, width: number, height: number) => Promise<ImageBitmap> = bitmapFromRgba,
): void {
  let port: MessagePort | null = null;

  function attach(next: MessagePort, epoch: number): void {
    // Main already superseded the previous port; replies still on it belong
    // to reads the page has failed.
    const previous = port;
    port = next;
    if (previous) { previous.onmessage = null; previous.close(); }
    next.onmessage = ({ data }: MessageEvent<MotifReadReply>) => { void reply(data); };
    // A navigation the document survives, or a utility crash, closes it.
    next.addEventListener('close', () => {
      if (port !== next) return;
      port = null;
      scope.postMessage({ closed: epoch });
    });
  }

  async function reply(data: MotifReadReply): Promise<void> {
    if (!data || typeof data !== 'object' || typeof data.id !== 'number') return;
    const { id } = data;
    if ('miss' in data) { scope.postMessage({ id, miss: true }); return; }
    if ('error' in data) { scope.postMessage({ id, error: String(data.error) }); return; }
    const { width, height, rgba, timing } = data.frame;
    const start = performance.now();
    try {
      const bitmap = await makeBitmap(rgba, width, height);
      scope.postMessage({ id, bitmap, timing, bitmapMs: performance.now() - start }, [bitmap]);
    } catch (error) {
      scope.postMessage({ id, error: String((error as Error)?.message ?? error) });
    }
  }

  scope.onmessage = ({ data }) => {
    if ('port' in data) { attach(data.port, data.epoch); return; }
    if (!port) { scope.postMessage({ id: data.id, error: 'Motif reader port missing' }); return; }
    port.postMessage({ id: data.id, hash: data.hash, frame: data.frame, div: data.div } satisfies MotifReadRequest);
  };
}

// Module worker entry; importing this file elsewhere (tests, types) starts nothing.
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  serveMotifReader(self as unknown as MotifReaderWorkerScope);
}
