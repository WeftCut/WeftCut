import type { MotifCacheAddress, MotifCaptureControl, MotifTextureReadRequest, MotifUploadTiming } from '../../../shared/motifs/frameTransport';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';

export interface CapturedFrame { bitmap: ImageBitmap; persisted: boolean }
interface FrameReply {
  bitmap: ImageBitmap | null;
  persisted: boolean;
  /** Capture only: the frame is on disk and main sent no pixels. */
  stored: boolean;
  /** `motif:read` only: the texture lane cannot serve this read. */
  unavailable: boolean;
  timing?: MotifUploadTiming;
  importMs?: number;
}
let port: MessagePort | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (frame: FrameReply) => void; reject: (error: Error) => void }>();

export type MotifReaderLane = 'texture' | 'utility';
export type MotifTransportFailure = 'timeout' | 'closed' | 'reset' | 'error';

/** A Motif read lane failed (ADR 0154). Not a miss: the frame stays in
 * coverage, and the caller keeps its previous frame or fails the export. */
export class MotifTransportError extends Error {
  override readonly name = 'MotifTransportError';
  constructor(readonly lane: MotifReaderLane, readonly reason: MotifTransportFailure, detail?: string) {
    super(`Motif ${lane} lane ${reason}${detail ? `: ${detail}` : ''}`);
  }
}

class FramePortTimeout extends Error {
  constructor() { super("Motif frame transport timed out"); }
}

/** One texture-lane answer: a bitmap, a miss (null), or `unavailable`. */
export type MotifTextureRead =
  | { bitmap: ImageBitmap; timing?: MotifUploadTiming; importMs?: number }
  | 'unavailable'
  | null;

/** The Windows texture lane at a divisor; `MotifFrameReader` is its only
 * caller. An error reply or a silent port is a `MotifTransportError`. */
export async function readMotifTexture(read: MotifTextureReadRequest): Promise<MotifTextureRead> {
  let reply: FrameReply;
  try { reply = await request({ ...read }); }
  catch (error) {
    throw new MotifTransportError('texture', error instanceof FramePortTimeout ? 'timeout' : 'error', (error as Error).message);
  }
  if (reply.unavailable) return 'unavailable';
  if (!reply.bitmap) return null;
  return {
    bitmap: reply.bitmap,
    ...(reply.timing ? { timing: reply.timing } : {}),
    ...(reply.importMs !== undefined ? { importMs: reply.importMs } : {}),
  };
}

export async function readStoredMotifFrame(hash: string, frame: number, finalizationToken?: string): Promise<ImageBitmap | null> {
  const reply = await request({ hash, frame, div: 1, finalizationToken });
  if (reply.unavailable) throw new Error("Motif texture lane unavailable");
  return reply.bitmap;
}

export async function captureStoredMotifFrame(capture: Record<string, unknown>): Promise<ImageBitmap> {
  return (await captureMotifResult(capture)).bitmap;
}

/** `scaleDiv` is the divisor a `stored` reply is read at. */
export function captureMotifResult(capture: Record<string, unknown>, scaleDiv: MotifReaderDiv = 1): Promise<CapturedFrame> {
  return captureOnce(capture, scaleDiv, false);
}

async function captureOnce(capture: Record<string, unknown>, scaleDiv: MotifReaderDiv, recaptured: boolean): Promise<CapturedFrame> {
  const { bitmap, persisted, stored } = await request({ capture });
  if (bitmap) return { bitmap, persisted };
  if (!stored) throw new Error("Motif capture returned no frame");
  // Main sent no pixels (ADR 0154): read the frame through the reader. A
  // joined bake persisted at `bake`; otherwise the `cache` re-check found it.
  const address = (capture.bake ?? capture.cache) as MotifCacheAddress | undefined;
  if (address) {
    const { motifFrameReader } = await import('./MotifFrameReader');
    // A transport error propagates: the file is not known to be bad.
    const read = await motifFrameReader().readAddress(address, scaleDiv,
      typeof capture.finalizationToken === 'string' ? { finalizationToken: capture.finalizationToken } : {});
    if (read) return { bitmap: read, persisted: true };
  }
  // The stored frame did not read, and the reader reported it to main. Capture
  // live, without the `cache` re-check, so a corrupt file cannot loop.
  if (recaptured) throw new Error("Motif capture returned no frame");
  const live = { ...capture };
  delete live.cache;
  return captureOnce(live, scaleDiv, true);
}

// Same port as capture admission, so promote/cancel cannot overtake its request.
export function controlStoredMotifCapture(control: MotifCaptureControl): void {
  port?.postMessage({ control });
}

interface FramePortMessage {
  id: number;
  bitmap?: ImageBitmap | null;
  persisted?: boolean;
  stored?: boolean;
  unavailable?: boolean;
  timing?: MotifUploadTiming;
  importMs?: number;
  error?: string;
}

function request(args: Record<string, unknown>): Promise<FrameReply> {
  if (!port) {
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = ({ data }: MessageEvent<FramePortMessage>) => {
      const request = pending.get(data.id);
      if (!request) { data.bitmap?.close(); return; }
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve({
        bitmap: data.bitmap ?? null, persisted: data.persisted === true,
        stored: data.stored === true, unavailable: data.unavailable === true,
        ...(data.timing ? { timing: data.timing } : {}),
        ...(typeof data.importMs === 'number' ? { importMs: data.importMs } : {}),
      });
    };
    port.start();
    window.postMessage({ type: "weftcut:motif-frame-port" }, "*", [channel.port2]);
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    // Capture includes bounded initialization (30s), frame (5s) and queue/transport.
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new FramePortTimeout());
    }, args.capture ? 60_000 : 15_000);
    pending.set(id, {
      resolve: frame => { clearTimeout(timeout); resolve(frame); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    port!.postMessage({ id, ...args });
  });
}
