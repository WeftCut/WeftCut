// The export Worker's native-decode source handle. Implements the same
// `ExportDecodeSession` contract the WebCodecs `ExportSourceHandle` does, so the
// export driving loop (dispatch → consume → evict) drives it identically — but
// instead of decoding a proxy with WebCodecs it consumes NV12 (8-bit) or
// I420P10 (10-bit) frames a main-process native session decodes from the
// ORIGINAL (a WebCodecs-blind codec, e.g. ProRes). Each handle owns its
// session's port; the page only opens it (docs/export-ipc-transport.md
// § Decode-in).
//
// Backpressure is a lease window: the session parks once `window` frames are
// out, and each frame's lease goes back when that frame leaves the ring.

import type {
  DecodeWireFrame,
  DecodeWireMsg,
  ExportDecodeCommand,
  ExportDecodeOpenInfo,
  PlaneColor,
} from "../../../shared/frameCarrier/wire";
import type { ExportColorDiag } from "../decoder/ExportDecoderPool";
import { ExportFrameStore } from "../decoder/ExportDecoderPool";
import { nativePlaneColor, type SourceColor } from "../decoder/ffprobeColorSpace";
import type { ExportDecodeSession, SourceHandleInit } from "../decoder/session";
import type { TenBitFrame } from "../decoder/tenBitFrame";
import type { NativeNv12Frame } from "../decoder/nv12Frame";
import { cpuPlaneFrame } from "../frameCarrier/cpuPlaneFrame";
import type { ExportTransportFormat } from "../exportDecodeRouting";
import type { ExportEvent, ExportRequest } from "./protocol";

/// The handle's end of its session port (a `MessagePort` in the Worker).
export interface DecodePort {
  onmessage: ((event: MessageEvent<DecodeWireMsg>) => void) | null;
  postMessage(cmd: ExportDecodeCommand): void;
  close(): void;
}

export interface NativeDecodeOpenRequest {
  sessionId: string;
  path: string;
  outFormat: ExportTransportFormat;
  window: number;
  /// The colour the session's planes carry.
  color: PlaneColor;
}

/// How a handle starts and ends its native session.
export interface NativeDecodeSessions {
  /// Opens a session and resolves with its open info and its port.
  open(request: NativeDecodeOpenRequest): Promise<{ info: ExportDecodeOpenInfo; port: DecodePort }>;
  /// Ends session `sessionId` in main, opened or still opening.
  ///
  /// LANDMINE: never as a command on the session's port. The export releases
  /// one phase's handle and opens the next phase's in the same turn; a close
  /// on the port takes a different route to main than the open and can arrive
  /// behind it, while the old session still holds its decoder memory, so main
  /// refuses the open on a host with a small memory target.
  close(sessionId: string): void;
}

/// The Worker global's part of the `nd:open` ⇄ `nd:openResult` handshake.
export interface OpenScope {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: ExportEvent): void;
}

/// Asks the page to open each session (`nd:open`), matching every
/// `nd:openResult` to its request by `reqId`, and to close it (`nd:close`).
/// Both go to the page in the order they were asked for.
///
/// LANDMINE: exportWorker.ts owns `self.onmessage`; this listens with
/// `addEventListener` so both coexist, and ignores every other message type.
export function createNativeDecodeSessions(scope: OpenScope): NativeDecodeSessions {
  let nextReqId = 1;
  const pending = new Map<
    number,
    { resolve: (opened: { info: ExportDecodeOpenInfo; port: DecodePort }) => void; reject: (e: Error) => void }
  >();
  scope.addEventListener("message", (event) => {
    const msg = event.data as ExportRequest | null;
    if (msg?.type !== "nd:openResult") return;
    const waiting = pending.get(msg.reqId);
    if (!waiting) return;
    pending.delete(msg.reqId);
    if (msg.ok) waiting.resolve({ info: msg.info, port: msg.port });
    else waiting.reject(new Error(msg.error));
  });
  return {
    open: (request) =>
      new Promise((resolve, reject) => {
        const reqId = nextReqId++;
        pending.set(reqId, { resolve, reject });
        scope.postMessage({ type: "nd:open", reqId, ...request });
      }),
    close: (sessionId) => scope.postMessage({ type: "nd:close", sessionId }),
  };
}

let workerSessions: NativeDecodeSessions | null = null;

/// LANDMINE: lazy. Nothing at module top level may touch `self`: the node
/// vitest suites import the export pool, which imports this module.
const sessionsInWorker: NativeDecodeSessions = {
  open: (request) => (workerSessions ??= createNativeDecodeSessions(self as unknown as OpenScope)).open(request),
  close: (sessionId) => (workerSessions ??= createNativeDecodeSessions(self as unknown as OpenScope)).close(sessionId),
};

/// Module counter for a realm-safe unique `sessionId`. Math.random / Date.now
/// are banned/absent in some realms; a monotonic counter is deterministic and
/// sufficient (one handle = one session for its lifetime).
let seq = 0;

export class NativeExportSourceHandle implements ExportDecodeSession {
  readonly mediaId: string;
  readonly ring = new ExportFrameStore();
  private readonly sessions: NativeDecodeSessions;
  private readonly sessionId: string;
  private readonly sourcePath: string;
  private readonly outFormat: ExportTransportFormat;
  private readonly window: number;
  /// The colour stamped on every pushed frame: what the session's planes carry
  /// (`nativePlaneColor` of the source's resolved colour), the same value the
  /// session is opened with; fixed per handle (one handle = one source). The
  /// session's own tags (raw FFmpeg names in its open info) are never used:
  /// they would fork the app's single colour model.
  private readonly frameColorSpace: SourceColor;
  /// `aUs` of the previous `decodeRange`; `aUs < lastRangeAUs` is a backward
  /// clip-reuse jump — the only case that must reset the ring's EOS clamp.
  private lastRangeAUs = Number.NEGATIVE_INFINITY;

  private readyP: Promise<void> | null = null;
  /// Null until the session is open, and again once it is over (disposed, or a
  /// terminal error): nothing is posted to a session that is gone.
  private port: DecodePort | null = null;
  /// The session was asked to end; a port that arrives later is only closed.
  private ended = false;
  private _disposed = false;

  /// Aggregated into the export `done` perf payload. `dispatchedTotal` mirrors
  /// the WebCodecs handle's "work fed" counter (here: frames received);
  /// `firstFrameDiag` captures the first frame's colour for the E2E harness.
  dispatchedTotal = 0;
  firstFrameDiag: ExportColorDiag | null = null;

  get sourceUrl(): string {
    return this.sourcePath;
  }

  constructor(init: SourceHandleInit, sessions: NativeDecodeSessions = sessionsInWorker) {
    this.mediaId = init.mediaId;
    const ne = init.nativeExport!;
    this.sourcePath = ne.sourcePath;
    this.outFormat = ne.outFormat;
    this.window = ne.window;
    this.frameColorSpace = nativePlaneColor(init.sourceColor);
    // Unique, realm-safe, stable for this handle's lifetime.
    this.sessionId = `nd-${seq++}-${init.mediaId}-${init.handleKey ?? init.mediaId}`;
    this.sessions = sessions;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  ensureReady(): Promise<void> {
    if (this.readyP) return this.readyP;
    // The open info is not needed: frames carry their own dimensions and an
    // already source-normalized `ptsUs`, and colour comes from `sourceColor`.
    const { matrix, fullRange } = this.frameColorSpace;
    this.readyP = this.sessions.open({
      sessionId: this.sessionId,
      path: this.sourcePath,
      outFormat: this.outFormat,
      window: this.window,
      color: { matrix, fullRange },
    }).then(({ port }) => {
      // Ended while opening: the close already went out, behind the open.
      if (this.ended) {
        port.close();
        return;
      }
      this.port = port;
      port.onmessage = (event) => this.onMessage(event.data);
    });
    return this.readyP;
  }

  /// Dispatch a decode range, then RESOLVE IMMEDIATELY. Awaiting frames or the
  /// range's `mark` here would deadlock the window: the session parks after
  /// `window` frames, and leases only come back from the consume loop.
  /// WebCodecs production can remain pending; the Worker starts both adapters
  /// without awaiting range completion, then consumes their rings.
  async decodeRange(aUs: number, bUs: number): Promise<void> {
    await this.ensureReady();
    if (this._disposed) return;
    // Backward clip-reuse jump starts a new decode generation. Frames and
    // finality proofs from the prior generation cannot satisfy its targets;
    // release them (and their leases) before the native session re-seeks.
    if (aUs < this.lastRangeAUs) {
      this.ring.flush();
      this.ring.clearEosDrain();
    }
    this.lastRangeAUs = aUs;
    this.port?.postMessage({ type: "range", aUs: Math.round(aUs), bUs: Math.round(bUs) });
  }

  evictBefore(cutoffUs: number): void {
    this.ring.evictBefore(cutoffUs);
  }

  private onMessage(msg: DecodeWireMsg): void {
    if (this._disposed) return;
    switch (msg.kind) {
      case "bytes":
        this.onFrame(msg);
        return;
      // Ordered range completion is a presentation-finality proof: every frame
      // in `[aUs, bUs]` arrived before it, so quantized targets in the range no
      // longer need an out-of-range lookahead frame to settle.
      case "mark":
        this.ring.completeRange(msg.aUs, msg.bUs);
        return;
      // End of stream: the ring clamps grid-overrun waiters to the last held
      // frame. Safe because the port delivers in the session's order, so every
      // frame sent before `end` has already been pushed.
      case "end":
        this.ring.beginEosDrain();
        this.ring.finishEosDrain();
        return;
      // Any error fails the export (no mid-export fallback, ADR 0033); a
      // terminal one also ends the session, so its port closes now.
      case "error":
        this.ring.fail(msg.message);
        if (msg.terminal) this.endSession();
        return;
    }
  }

  private onFrame(msg: DecodeWireFrame): void {
    const release = () => this.port?.postMessage({ type: "release", lease: msg.lease });
    // A frame whose format contradicts the session's outFormat means the
    // native session and this handle disagree about the transport — fail the
    // ring (the export aborts) rather than misinterpret the plane bytes.
    if (msg.format !== this.outFormat) {
      release();
      this.ring.fail(`native frame format ${msg.format} contradicts session outFormat ${this.outFormat}`);
      return;
    }
    const colorSpace = this.frameColorSpace;
    let built: NativeNv12Frame | TenBitFrame;
    try {
      built = cpuPlaneFrame(msg, colorSpace);
    } catch (e) {
      release();
      this.ring.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    // LANDMINE: the lease goes back in `close`, the moment the ring lets the
    // frame go, on every path (evict, a parking waiter freeing frames behind
    // it, a backward flush, dispose). The session may already be parked on a
    // full window, and the export loop's next evict runs only after the wait
    // that freed the frame resolves: a later release deadlocks the export.
    const frame = { ...built, close: release };
    // Captured BEFORE push: the push may already let the frame go.
    if (!this.firstFrameDiag) {
      this.firstFrameDiag = { mediaId: this.mediaId, configColor: colorSpace, frameColor: colorSpace, frameFormat: msg.format };
    }
    this.dispatchedTotal++;
    this.ring.push(frame, msg.ptsUs);
  }

  /// Ends the native session in main, once, and drops the port. A session
  /// that was never asked for has nothing to end.
  private endSession(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.readyP) this.sessions.close(this.sessionId);
    const port = this.port;
    this.port = null;
    if (!port) return;
    port.onmessage = null;
    port.close();
  }

  /// Export drives decoding via `decodeRange`; the Compositor's per-tick nudge
  /// is a no-op here (matches ExportSourceHandle).
  requestFrameAt(_tUs: number): Promise<void> {
    return Promise.resolve();
  }

  /// Export composites synchronously; no first-frame repaint.
  onFirstFrame(_cb: () => void): void {
    // intentional no-op
  }

  dispose(): void {
    if (this._disposed) return; // idempotent
    // Set disposed FIRST so a late message no-ops.
    this._disposed = true;
    // Hands back the lease of every frame still held, then ends the session.
    this.ring.dispose();
    this.endSession();
  }
}
