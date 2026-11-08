import type { MotifCacheAddress, MotifCaptureControl, MotifFramePriority, MotifReadUnavailable, MotifTextureReadRequest, MotifUploadTiming } from '../../../shared/motifs/frameTransport';
import { isMotifErrorCode, MotifError, type MotifErrorCode } from '../../../shared/motifs/errors';
import { MOTIF_DEADLINES } from '../../../shared/motifs/tuning';

interface FrameReply {
  bitmap: ImageBitmap | null;
  persisted: boolean;
  /** Capture only: the frame is on disk and main sent no pixels. */
  stored: boolean;
  /** `motif:read` only: the texture lane does not serve this read. */
  unavailable: MotifReadUnavailable | null;
  timing?: MotifUploadTiming;
  importMs?: number;
}
let port: MessagePort | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (frame: FrameReply) => void; reject: (error: Error) => void }>();

export type MotifReaderLane = 'texture' | 'utility';
export type MotifTransportFailure = 'timeout' | 'closed' | 'reset' | 'error';

/** A Motif read lane failed (ADR 0154), code `transport`. Not a miss: the
 * frame stays in coverage, and the caller keeps its previous frame or fails
 * the export. */
export class MotifTransportError extends MotifError {
  override name = 'MotifTransportError';
  constructor(readonly lane: MotifReaderLane, readonly reason: MotifTransportFailure, detail?: string) {
    super('transport', `Motif ${lane} lane ${reason}${detail ? `: ${detail}` : ''}`);
  }
}

class FramePortTimeout extends Error {
  constructor() { super("Motif frame transport timed out"); }
}

/** One texture-lane answer: a bitmap, a miss (null), or `unavailable`. */
export type MotifTextureRead =
  | { bitmap: ImageBitmap; timing?: MotifUploadTiming; importMs?: number }
  | MotifReadUnavailable
  | null;

/** The Windows texture lane at a divisor; `MotifFrameReader` is its only
 * caller. An error reply or a silent port is a `MotifTransportError`. */
export async function readMotifTexture(read: MotifTextureReadRequest): Promise<MotifTextureRead> {
  let reply: FrameReply;
  try { reply = await send({ ...read }); }
  catch (error) {
    throw new MotifTransportError('texture', error instanceof FramePortTimeout ? 'timeout' : 'error', (error as Error).message);
  }
  if (reply.unavailable) return reply.unavailable;
  if (!reply.bitmap) return null;
  return {
    bitmap: reply.bitmap,
    ...(reply.timing ? { timing: reply.timing } : {}),
    ...(reply.importMs !== undefined ? { importMs: reply.importMs } : {}),
  };
}

/** One capture of a Motif frame in main's capture host. */
export interface MotifCaptureRequest {
  motifId: string;
  tSec: number;
  propsJson: string;
  width: number;
  height: number;
  contentHash: string;
  /** The composition fps `tSec` was computed on; main falls back to 30. */
  fpsNum?: number;
  fpsDen?: number;
  priority: MotifFramePriority;
  /** The frame's cache address. Without one, main neither stores the frame
   * nor answers `stored`. */
  address?: MotifCacheAddress;
  /** `keep`: main stores the frame and reports whether it did. `offer`
   * (default): main stores it when it has room. */
  store?: 'keep' | 'offer';
  /** The renderer's read of `address` missed: main captures without checking
   * the store, so a corrupt file cannot answer `stored` again. */
  afterMiss?: boolean;
  finalizationToken?: string;
}

/** `stored`: the frame is on disk at the request's address and main sent no
 * pixels; the caller reads it (ADR 0154). */
export type MotifCaptureReply =
  | { kind: 'pixels'; bitmap: ImageBitmap; persisted: boolean }
  | { kind: 'stored' };

/** A capture in flight. `cancel` withdraws it from main's queue; a capture
 * already running still answers, and the caller closes what arrives. */
export interface MotifCaptureCall {
  reply: Promise<MotifCaptureReply>;
  setPriority(priority: MotifFramePriority): void;
  cancel(): void;
}

// Main keys queued captures by sender; a reloaded document must not reuse its
// predecessor's keys.
const callPrefix = `motif-capture:${crypto.randomUUID()}`;
let nextCall = 0;

export function captureMotif(request: MotifCaptureRequest): MotifCaptureCall {
  const perf = typeof window === 'undefined' ? undefined
    : (window as unknown as { __weftcutMotifPerf?: { renders: number } }).__weftcutMotifPerf;
  if (perf) perf.renders++;
  const { priority, address, store, afterMiss, finalizationToken, ...args } = request;
  // Main's queue has two classes: `current` is high, the rest are low. A
  // promotion cannot be taken back.
  const key = `${callPrefix}:${++nextCall}`;
  let high = priority === 'current';
  let settled = false;
  const reply = (async (): Promise<MotifCaptureReply> => {
    try {
      const { bitmap, persisted, stored } = await send({ capture: {
        ...args, coalesceKey: key, high,
        ...(address && store === 'keep' ? { bake: address } : {}),
        ...(address && !afterMiss ? { cache: address } : {}),
        ...(finalizationToken ? { finalizationToken } : {}),
      } });
      if (bitmap) return { kind: 'pixels', bitmap, persisted };
      if (stored && address) return { kind: 'stored' };
      throw new Error("Motif capture returned no frame");
    } finally { settled = true; }
  })();
  // Same port as the capture, so a control cannot overtake its request.
  const control = (action: MotifCaptureControl['action']) => {
    if (!settled) port?.postMessage({ control: { key, action } });
  };
  return {
    reply,
    setPriority: next => {
      if (next !== 'current' || high) return;
      high = true;
      control('promote');
    },
    cancel: () => control('cancel'),
  };
}

interface FramePortMessage {
  id: number;
  bitmap?: ImageBitmap | null;
  persisted?: boolean;
  stored?: boolean;
  unavailable?: MotifReadUnavailable['reason'];
  generation?: number;
  timing?: MotifUploadTiming;
  importMs?: number;
  error?: string;
  /** Present when `error` is a MotifError's detail (preload `motifFrames.ts`). */
  code?: MotifErrorCode;
}

function unavailableReply({ unavailable, generation }: FramePortMessage): MotifReadUnavailable | null {
  if (unavailable !== 'lane' && unavailable !== 'read') return null;
  return { kind: 'unavailable', reason: unavailable, generation: typeof generation === 'number' ? generation : 0 };
}

function send(args: Record<string, unknown>): Promise<FrameReply> {
  if (!port) {
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = ({ data }: MessageEvent<FramePortMessage>) => {
      const request = pending.get(data.id);
      if (!request) { data.bitmap?.close(); return; }
      pending.delete(data.id);
      if (data.error) request.reject(isMotifErrorCode(data.code) ? new MotifError(data.code, data.error) : new Error(data.error));
      else request.resolve({
        bitmap: data.bitmap ?? null, persisted: data.persisted === true,
        stored: data.stored === true, unavailable: unavailableReply(data),
        ...(data.timing ? { timing: data.timing } : {}),
        ...(typeof data.importMs === 'number' ? { importMs: data.importMs } : {}),
      });
    };
    port.start();
    window.postMessage({ type: "weftcut:motif-frame-port" }, "*", [channel.port2]);
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new FramePortTimeout());
    }, args.capture ? MOTIF_DEADLINES.captureTransportMs : MOTIF_DEADLINES.readTransportMs);
    pending.set(id, {
      resolve: frame => { clearTimeout(timeout); resolve(frame); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    port!.postMessage({ id, ...args });
  });
}
