// Native byte-frame `DecodeTransport`: the software lane and the copy-back
// hardware lanes, which ship decoded frames as bytes (ADR 0029). The transport
// owns its session's port: frames, the end and errors arrive on it in the
// session's order, and `request` and `release` go up it
// (docs/preview.md § The Standard engine).
//
// Frames wrap zero-copy as CPU-plane frames (`cpuPlaneFrame`), dispatched on
// each frame's own `format`, and the Compositor converts them in its own
// ingest passes (`Nv12Ingest` / `TenBitIngest`), never as `VideoFrame`s.
//
// This is the transport half only — no FrameRing, no first-frame/fatal-error
// hooks, no idle bookkeeping. Those stay with `FfmpegSource` (the caller),
// which owns exactly one `DecodeTransport` at a time and sets the ring's
// eviction anchor itself (see `requestFrameAt` below).
import type { DecodeWireFrame, DecodeWireMsg, PreviewDecodeCommand, PreviewDecodeOptions } from "../../../../shared/frameCarrier/wire";
import { openDecodeSession } from "../../../ipc/decodeSession";
import { cpuPlaneFrame } from "../../frameCarrier/cpuPlaneFrame";
import type { SourceColor } from "../ffprobeColorSpace";
import type { DecodeTransport, DecodeTransportOpen, TransportFrame } from "./DecodeTransport";

/// The transport's end of its session port.
interface SessionPort {
  onmessage: ((event: MessageEvent<DecodeWireMsg>) => void) | null;
  postMessage(cmd: PreviewDecodeCommand): void;
  close(): void;
}

export class SwTransport implements DecodeTransport {
  /// The session id, supplied by the caller's `open()`: fresh per open, so a
  /// late message of an earlier session can never reach this one.
  private streamId = "";

  /// The colour stamped on every frame: the source's resolved colour from
  /// `open()`. Frames carry none of their own.
  private colorSpace!: SourceColor;

  private port: SessionPort | null = null;

  private _disposed = false;

  /// A terminal error ended the session: its frames are released, not shown.
  private failed = false;

  private frameCb: ((frame: TransportFrame, ptsUs: number, durUs: number) => void) | null = null;

  private errorCb: ((reason: string) => void) | null = null;

  /// Last target requested, for cheap same-target dedup. Unlike `GpuTransport`'s
  /// coalescing pump, a request is a fire-and-forget post with no round-trip
  /// to coalesce behind.
  private lastSentTargetUs: number | null = null;
  /// Discontinuity generation, not a refill sequence. Forward refills must
  /// accept still-useful frames already travelling from the preceding horizon.
  private requestId = 1;

  /// `accel`: optional hardware copy-back lane (Linux NVDEC/VAAPI, macOS
  /// VideoToolbox), opened in place of the software lane. The frame path is
  /// identical either way.
  ///
  /// `scaleDiv`: optional playback-resolution divisor (1 | 2 | 4). Native
  /// downscales each frame before it crosses IPC and reports the shipped
  /// dims on the frame, which the Compositor renormalizes against the media
  /// size. Absent or 1 = full resolution, and nothing rides the open.
  ///
  /// `cadenceDiv`: optional output cadence divisor; absent or 1 ships every
  /// frame and nothing rides the open.
  ///
  /// `outFormat`: optional CPU transport format. Absent or 'NV12' = the 8-bit
  /// path; 'I420P10' opens 10-bit output — `FfmpegSource` picks it for a
  /// 10-bit source on the videotoolbox lane. Delivery still dispatches per
  /// frame on the frame's own `format`, never on this request.
  constructor(
    private readonly accel?: { lane: string; device: string | null },
    private readonly scaleDiv?: number,
    private readonly cadenceDiv?: number,
    private readonly outFormat?: "NV12" | "I420P10",
  ) {}

  /// Open the native session and take its port. Throws on failure (the open
  /// rejecting); the caller (`FfmpegSource`) decides whether that's
  /// recoverable. The rejection is the only report of it: an `onError` as well
  /// would hand one failure to two recovery paths (ADR 0162).
  ///
  /// No frame is lost between the open and the listener below: the port is
  /// created before main opens the session and queues what it receives until
  /// `onmessage` is set, and frames only follow a `request` anyway.
  async open(o: DecodeTransportOpen): Promise<void> {
    this.streamId = o.streamId;
    this.colorSpace = o.sourceColor;
    const { port } = await openDecodeSession(this.streamId, () =>
      window.api.previewDecode.open({ sessionId: this.streamId, path: o.path, options: this.openOptions() }),
    );
    // Disposed while opening: the close already went out by session id.
    if (this._disposed) {
      port.close();
      return;
    }
    this.port = port;
    port.onmessage = (event) => this.onMessage(event.data);
  }

  /// Only what differs from the default open rides the wire.
  private openOptions(): PreviewDecodeOptions {
    return {
      ...(this.accel ? { lane: this.accel.lane } : {}),
      ...(this.accel?.device != null ? { device: this.accel.device } : {}),
      ...(this.scaleDiv !== undefined && this.scaleDiv > 1 ? { scaleDiv: this.scaleDiv } : {}),
      ...(this.cadenceDiv !== undefined && this.cadenceDiv > 1 ? { cadenceDiv: this.cadenceDiv } : {}),
      ...(this.outFormat === "I420P10" ? { outFormat: this.outFormat } : {}),
    };
  }

  private onMessage(msg: DecodeWireMsg): void {
    switch (msg.kind) {
      case "bytes":
        this.onBytes(msg);
        return;
      // Not reported: the native cursor already absorbs requests past the end.
      case "end":
      case "mark":
        return;
      // A non-terminal error (a failed seek or decode) is logged in main and
      // the next request seeks again. A terminal one ended the session.
      case "error":
        if (!msg.terminal || this.failed || this._disposed) return;
        this.failed = true;
        this.errorCb?.(msg.message);
        return;
    }
  }

  /// Every frame's lease goes back exactly once, whatever becomes of the frame:
  /// shown, superseded, malformed, or arriving after dispose or a terminal error.
  private onBytes(msg: DecodeWireFrame): void {
    try {
      if (this._disposed || this.failed) return;
      // A frame of an earlier request generation fills a hole the ring no longer has.
      if (msg.requestId !== undefined && msg.requestId !== this.requestId) return;
      this.acceptFrame(msg);
    } finally {
      this.port?.postMessage({ type: "release", lease: msg.lease });
    }
  }

  /// A layout-drifted buffer must not crash the stream (mirrors the GPU
  /// transport's non-fatal posture for a bad port message): the frame is
  /// dropped with a warning.
  private acceptFrame(msg: DecodeWireFrame): void {
    let frame: TransportFrame;
    try {
      frame = cpuPlaneFrame(msg, this.colorSpace);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] preview-sw ${this.streamId} frame wrap failed:`, e);
      return;
    }
    // ptsUs is already source-normalized microseconds (Rust's shared
    // `media_time::ticks_to_source_us`, matching DecodeClock's truncation
    // contract) — no further offset needed before handing it to the caller.
    this.frameCb?.(frame, msg.ptsUs, msg.durUs);
  }

  onFrame(cb: (frame: TransportFrame, ptsUs: number, durUs: number) => void): void {
    this.frameCb = cb;
  }

  /// A terminal session error: the session is gone. Never called from
  /// `open()`, whose failure is its rejection.
  onError(cb: (reason: string) => void): void {
    this.errorCb = cb;
  }

  /// No-op: the session's `end` is not reported (see `onMessage`).
  onEof(_cb: () => void): void {
    // intentionally empty
  }

  /// Nudge the native session's decode target toward `tUs`. Does NOT touch a
  /// ring anchor — the ring lives on `FfmpegSource`, which sets its own anchor
  /// before/around calling this.
  requestFrameAt(tUs: number): void {
    if (this._disposed || this.failed || !this.port) return;
    if (tUs === this.lastSentTargetUs) return;
    if (this.lastSentTargetUs !== null && (tUs < this.lastSentTargetUs || tUs - this.lastSentTargetUs > 1_000_000)) {
      this.requestId = (this.requestId + 1) >>> 0;
    }
    this.lastSentTargetUs = tUs;
    this.port.postMessage({ type: "request", targetUs: tUs, requestId: this.requestId });
  }

  /// Drop the same-target dedup latch. Without this, a ring flush followed by a
  /// request for the EXACT last-sent target (frame-grid snapping makes exact
  /// repeats routine) is swallowed here while the ring it should refill sits
  /// empty — the ring flush and this latch share no reset point unless the
  /// caller provides one.
  resetRequestDedup(): void {
    this.lastSentTargetUs = null;
    this.requestId = (this.requestId + 1) >>> 0;
  }

  /// Tear down: end the session in main, then drop the port. Safe even if
  /// `open()` never completed.
  ///
  /// LANDMINE: the close goes by session id over IPC, not up the port. A port
  /// message reaches main only after the next transport's open, which the
  /// caller starts right after this; that open would then be refused while
  /// this session still holds its memory reservation.
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.streamId) window.api.previewDecode.close({ sessionId: this.streamId });
    this.port?.close();
  }
}
