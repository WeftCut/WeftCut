// Native GPU `DecodeTransport`: the Windows d3d11va lane, whose frames stay on
// the GPU in a pool of shared-texture slots. The transport owns its session's
// port: each slot, already read into an `ImageBitmap` by the preload
// (preload/slotReader.ts), the end and errors arrive on it in the session's
// order, and `request` and `release` go up it (docs/preview.md § The Standard
// engine).
//
// A slot goes back only once nothing can still be reading it: the shared slot
// fence (slotFenceQueue.ts) says when the GPU has run the copy the bitmap was
// made with, and only then is the slot released.
//
// This is the transport half only — no FrameRing, no first-frame/fatal-error
// hooks, no idle bookkeeping. Those stay with `FfmpegSource` (the caller),
// which owns exactly one `DecodeTransport` at a time.
import { performanceSettings } from "../../../../shared/performance-settings";
import type { PreviewGpuColorSpace } from "../../../../shared/ipc";
import type { PreviewGpuCommand, SlotReadMsg, SlotSessionMsg } from "../../../../shared/frameCarrier/wire";
import { openDecodeSession } from "../../../ipc/decodeSession";
import type { DecodeTransport, DecodeTransportOpen } from "./DecodeTransport";
import { nativePlaneColor, planeConversion, type SourceColor } from "../ffprobeColorSpace";
import { HandoffTimings, type HandoffTimingSummary } from "./handoffTimings";
import { sharedSlotFenceQueue } from "./slotFenceQueue";

/// The transport's end of its session port.
interface SessionPort {
  onmessage: ((event: MessageEvent<SlotSessionMsg>) => void) | null;
  postMessage(cmd: PreviewGpuCommand): void;
  close(): void;
}

/// How the session's shader converts its planes (`planeConversion` of
/// `nativePlaneColor` of the source's resolved colour, the same decision the
/// ingest shaders make for the other native lanes) in the shape
/// `previewGpu.open` carries.
export function deriveColorSpace(sourceColor: SourceColor): PreviewGpuColorSpace {
  const planes = nativePlaneColor(sourceColor);
  const conversion = planeConversion(planes);
  return {
    primaries: conversion.primaries,
    transfer: planes.transfer,
    matrix: conversion.matrix,
    range: conversion.fullRange ? "full" : "limited",
  };
}

export class GpuTransport implements DecodeTransport {
  /// The session id, supplied by the caller's `open()`: fresh per open, so a
  /// late message of an earlier session can never reach this one.
  private streamId = "";

  private port: SessionPort | null = null;

  private _disposed = false;

  /// Resolves once main has closed the session and released its admission
  /// lease, so a priority replacement may safely open.
  private disposeP: Promise<void> | null = null;

  /// Rolling window over the preload's per-slot read stamps and this side's
  /// read-completion cost.
  private readonly timings = new HandoffTimings();

  private frameCb: ((bitmap: ImageBitmap, ptsUs: number, durUs: number) => void) | null = null;
  private errorCb: ((reason: string) => void) | null = null;
  private eofCb: (() => void) | null = null;

  private lastRequestedTargetUs: number | null = null;

  /// Open the native session and take its port. Throws on failure (most
  /// commonly `hw-budget-exceeded`); the caller (`FfmpegSource`) decides
  /// whether that's recoverable.
  ///
  /// No slot is lost between the open and the listener below: the port is
  /// created before main opens the session and queues what it receives until
  /// `onmessage` is set, and slots only fill after a `request` anyway.
  async open(o: DecodeTransportOpen): Promise<void> {
    if (this._disposed) return;
    this.streamId = o.streamId;
    const { port } = await openDecodeSession(this.streamId, () =>
      window.api.previewGpu.open({
        sessionId: this.streamId,
        path: o.path,
        // The configured pool (default 3) mirrors the WebCodecs path's
        // headroom: a couple of lookahead frames in flight plus one being read.
        poolSize: o.poolSize ?? performanceSettings().preview_gpu_pool_slots,
        colorSpace: deriveColorSpace(o.sourceColor),
        // Missing/invalid probe dimensions deliberately ride as zero: main's
        // budget validates and fails closed before native allocation.
        codedWidth: o.codedWidth ?? 0,
        codedHeight: o.codedHeight ?? 0,
      }),
    );
    // Disposed while opening: the close already went out by session id.
    if (this._disposed) {
      port.close();
      return;
    }
    this.port = port;
    port.onmessage = (event) => this.onMessage(event.data);
  }

  private onMessage(msg: SlotSessionMsg): void {
    switch (msg.kind) {
      case "slot":
        this.onSlot(msg);
        return;
      case "end":
        if (!this._disposed) this.eofCb?.();
        return;
      // Terminal or not, an error is a transport failure: `FfmpegSource`
      // falls back to software (ADR 0162). A terminal one also means the
      // session thread is gone and nothing more will arrive.
      case "error":
        if (!this._disposed) this.errorCb?.(msg.message);
        return;
      // A GPU session sends neither.
      case "bytes":
      case "mark":
        return;
    }
  }

  /// Every slot goes back at most once, and only once nothing can still be
  /// reading it: after its fence or proof (shown or not), at once when the
  /// preload's read failed. A slot whose read nothing can prove, and every
  /// slot after dispose, is never released: the session's close reclaims it.
  private onSlot(msg: SlotReadMsg): void {
    if (this._disposed) {
      msg.bitmap?.close();
      return;
    }
    const release = () => this.release(msg.slot, msg.gen);
    // Nothing will prove this slot's read: its close reclaims the slot.
    const unproven = () => this.fail("GPU slot read completion could not be verified");
    if (msg.bitmap === undefined) {
      // Nothing holds a read of the slot: `getVideoFrame`'s frame is closed.
      release();
      this.errorCb?.(msg.error);
      return;
    }
    const queue = sharedSlotFenceQueue();
    // Before `frameCb`, and unconditionally: the slot's release cannot depend
    // on the ring keeping the frame, or on anything painting it.
    const completion = queue.submit(this.streamId, msg.slot, msg.bitmap, release, unproven);
    if (completion.applied === "none") {
      msg.bitmap.close();
      unproven();
      return;
    }
    this.timings.record(
      msg.timing,
      { drawMs: completion.drawMs, readMs: completion.readMs, proof: completion.applied === "proof" },
      queue.stats(this.streamId),
    );
    // A frame arriving is the wake-up the already-queued slots were waiting
    // for; doing it here costs no scheduling.
    queue.drain();
    this.frameCb?.(msg.bitmap, msg.ptsUs, msg.durUs);
  }

  /// Hands a slot back up the port. The port is read live, not captured:
  /// `dispose()` nulls it, so no release reaches a session that is closing.
  private release(slot: number, gen: number): void {
    try {
      this.port?.postMessage({ type: "release", slot, gen });
    } catch {
      // Native cannot learn the slot is free if the port has failed. Report it
      // and close the session instead of leaving its pool one slot short: the
      // report is what lets `FfmpegSource` fall back. Deferred so `dropFor`
      // cannot mutate the fence queue while it drains other completed slots.
      queueMicrotask(() => this.fail("GPU slot release could not be delivered"));
    }
  }

  /// A slot this session cannot hand back: report it once (`FfmpegSource`
  /// falls back) and close the session, whose close reclaims the slot.
  private fail(reason: string): void {
    if (this._disposed) return;
    this.errorCb?.(reason);
    void this.dispose().catch(() => {});
  }

  /// Read handoff timings for this session, or null before the first slot.
  /// Diagnostics only — nothing decides on it.
  handoffTimings(): HandoffTimingSummary | null {
    const summary = this.timings.summary();
    return summary ? { ...summary, slotTurnover: sharedSlotFenceQueue().turnover(this.streamId) } : null;
  }

  onFrame(cb: (bitmap: ImageBitmap, ptsUs: number, durUs: number) => void): void {
    this.frameCb = cb;
  }

  /// A session error (decode, seek, slot or read failure, or the session
  /// thread stopping). Never called from `open()`, whose failure is its
  /// rejection.
  onError(cb: (reason: string) => void): void {
    this.errorCb = cb;
  }

  onEof(cb: () => void): void {
    this.eofCb = cb;
  }

  /// Move the native session's decode anchor to `tUs`. Does not touch a ring
  /// anchor — the ring lives on `FfmpegSource`.
  requestFrameAt(tUs: number): void {
    if (this._disposed || !this.port) return;
    if (this.lastRequestedTargetUs === tUs) return;
    this.lastRequestedTargetUs = tUs;
    this.port.postMessage({ type: "request", targetUs: tUs });
  }

  resetRequestDedup(): void {
    this.lastRequestedTargetUs = null;
  }

  /// Tear down: drop this session's unreleased slots, then close the session
  /// in main. Resolves only once main has closed it and released its admission
  /// lease. Safe even if `open()` never completed.
  ///
  /// LANDMINE: the close goes by session id over IPC, not up the port, and it
  /// answers. A HW→SW fallback opens its software session only after this
  /// resolves (ADR 0162); a close that had not reached main by then would let
  /// that open, or a priority replacement, be refused while this session still
  /// holds its lease.
  dispose(): Promise<void> {
    if (this.disposeP) return this.disposeP;
    this._disposed = true;
    // Pending slots are dropped without a release: their reads may still be
    // in flight, and the native close destroys the slots with the session.
    sharedSlotFenceQueue().dropFor(this.streamId);
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
      this.port = null;
    }
    this.disposeP = this.streamId ? window.api.previewGpu.close({ sessionId: this.streamId }) : Promise.resolve();
    return this.disposeP;
  }
}
