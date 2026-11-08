import type { MotifCaptureControl, MotifCaptureRequest as MotifCaptureWireRequest, MotifFramePriority, MotifReadUnavailable, MotifTextureReadRequest, MotifUploadTiming } from '../../../shared/motifs/frameTransport';
import { isMotifErrorCode, MotifError, motifSuperseded, type MotifErrorCode } from '../../../shared/motifs/errors';
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

/** One request for a Motif frame in main (ADR 0160); the transport names it. */
export type MotifCaptureRequest = Omit<MotifCaptureWireRequest, 'requestId'>;

/** `stored`: the frame is on disk at the request's address and main sent no
 * pixels; the caller reads it (ADR 0154). Never the reply to `afterMiss`. */
export type MotifCaptureReply =
  | { kind: 'pixels'; bitmap: ImageBitmap; persisted: boolean }
  | { kind: 'stored' };

/** A capture in flight. `cancel` withdraws it from main's queue; a capture
 * already running still answers, and the caller closes what arrives. */
export interface MotifCaptureCall {
  reply: Promise<MotifCaptureReply>;
  /** Up or down; main moves the queued capture. */
  setPriority(priority: MotifFramePriority): void;
  cancel(): void;
}

// Unique per frame port, which is per document. Main keys requests by sender
// as well, and a reloaded document's request takes over its predecessor's id.
let nextRequestId = 0;

export function captureMotif(request: MotifCaptureRequest): MotifCaptureCall {
  const perf = typeof window === 'undefined' ? undefined
    : (window as unknown as { __weftcutMotifPerf?: { renders: number } }).__weftcutMotifPerf;
  if (perf) perf.renders++;
  const requestId = ++nextRequestId;
  let priority = request.priority;
  let open = true;
  const reply = (async (): Promise<MotifCaptureReply> => {
    try {
      const { bitmap, persisted, stored } = await send({ capture: { ...request, requestId } satisfies MotifCaptureWireRequest });
      if (bitmap) return { kind: 'pixels', bitmap, persisted };
      if (stored && request.address) return { kind: 'stored' };
      throw new Error("Motif capture returned no frame");
    } finally { open = false; }
  })();
  // Same port as the capture, so a control cannot overtake its request.
  const control = (message: MotifCaptureControl) => { if (open) port?.postMessage({ control: message }); };
  return {
    reply,
    setPriority: next => {
      if (next === priority) return;
      priority = next;
      control({ requestId, action: 'priority', priority: next });
    },
    cancel: () => {
      control({ requestId, action: 'cancel' });
      open = false;
    },
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
  /** Main withdrew the capture; it rejects `superseded` here. */
  superseded?: boolean;
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
      if (data.superseded) request.reject(motifSuperseded());
      else if (data.error) request.reject(isMotifErrorCode(data.code) ? new MotifError(data.code, data.error) : new Error(data.error));
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
