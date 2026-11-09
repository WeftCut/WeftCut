// The deep module for the collapsed FFmpeg decode engine (see docs/preview.md
// §Decode engine, ADR 0030): owns a `FrameRing` and a swappable `DecodeTransport`
// (GPU or SW), and does IN-PLACE HW→SW fallback on a transport failure — the
// ring survives the swap so playback doesn't visibly reset. Every transport
// switch follows one contract (ADR 0162, `ffmpegSourceLifecycle.ts`). `implements
// PreviewDecodeSession` so it drops into the existing pool/Compositor seam
// (`SourceDecoderPool.ts`), which acquires it whenever the resolved engine is ffmpeg.
import type { PreviewDecodeSession, PreviewDecodeDevice } from "./session";
import type { FfmpegLane } from "./decodeEngine";
import { FrameRing } from "./FrameRing";
import type { DecodeTransport } from "./transports/DecodeTransport";
import type { HandoffTimingSummary } from "./transports/handoffTimings";
import { GpuTransport } from "./transports/GpuTransport";
import { SwTransport } from "./transports/SwTransport";
import { pickInitialLane, markHwUnusable } from "./ffmpegCapability";
import { isTenBitPixFmt } from "../../../shared/hwLaneEligibility";
import type { FfmpegLaneResolution } from "./ffmpegCapability";
import { noteLaneOpen, noteHardwareSelection, noteHardwareFallback, hardwareDecodeEvidence } from "./ffmpegLaneTrail";
import { checkedMove, judgeFailure, type Attempt, type Slot } from "./ffmpegSourceLifecycle";
import {
  resolveBudgetSpillProfile,
  type BudgetSpillCadenceDiv,
  type BudgetSpillScaleDiv,
} from "./budgetSpillProfile";

const IDLE_DISPOSE_MS = 5_000;
/// How long a capacity refusal holds the source before a frame request retries.
const CAPACITY_RETRY_MS = 1_000;
// Both native lanes autonomously fill 500 ms after a request. Refill with
// 150 ms still available instead of sending a round trip every display tick.
// Ring anchors/eviction still advance every tick; seeks bypass this gate when
// their target is not cached, and capacity remains the independent upper bound.
const REFILL_LOOKAHEAD_US = 150_000;
let nextStreamSeq = 0;

/// The HW lanes that COPY BACK to CPU frames and ship bytes over the previewSw
/// transport (Linux NVDEC/VAAPI — ADR 0029; macOS VideoToolbox — issue #10), as
/// opposed to the Windows shared-texture lane (d3d11va → GpuTransport). One
/// predicate so `makeHardwareTransport` and `usesSwTransport` cannot drift.
function isCopyBackHwLane(lane: string): boolean {
  return lane === "nvdec" || lane === "vaapi" || lane === "videotoolbox";
}

export interface FfmpegSourceInit {
  layerId: string;
  mediaId: string;
  hardwareEvidenceIdentity?: { layerId: string; mediaId: string };
  sourcePath: string;
  sourceColor?: VideoColorSpaceInit;
  codec?: string | null;
  pixFmt?: string | null;
  /// Media dimensions — threaded into `pickInitialLane`'s classKey so the
  /// renderer-derived cache key matches main's probe (both bucket resolution
  /// on max(w, h); omitting these collapses every source to the "sd" bucket).
  width?: number | null;
  height?: number | null;
  componentAvailable: boolean;
  poolSize?: number;
  /// Playback-resolution divisor (1 | 2 | 4) for the SOFTWARE transport: native
  /// ships frames at `src / n`, cutting the per-frame IPC bytes a 4K source
  /// spends. Preview only, and only on the byte-shipping lanes (software + the
  /// Linux/macOS copy-back lanes); the Windows shared-texture lane has no IPC
  /// pixels to reclaim. Omitted = 1 = full resolution.
  playbackScaleDiv?: number;
  /// Bench-only: pin the lane (docs/decode-bench.md). Skips capability probing.
  forceLane?: FfmpegLane;
}

interface FfmpegSourceDeps {
  makeGpu?: () => DecodeTransport;
  makeSw?: (profile?: {
    accel?: { lane: string; device: string | null };
    scaleDiv: BudgetSpillScaleDiv;
    cadenceDiv: BudgetSpillCadenceDiv;
    /// Present ONLY for the 10-bit videotoolbox profile (I420P10); every other
    /// byte-shipping open stays NV12 with no key, so exact-match seam tests
    /// keep reading today's payload.
    outFormat?: "I420P10";
  }) => DecodeTransport;
  pickLane?: typeof pickInitialLane;
  /// The owning preview pool may synchronously reclaim retained hardware
  /// sessions when this source loses admission to transient capacity. True
  /// means at least one lease was released, so retry the authoritative open
  /// once before accepting the software spill. Absent in benches/export.
  reclaimRetainedCapacity?: () => boolean | Promise<boolean>;
}

export class FfmpegSource implements PreviewDecodeSession {
  readonly ring = new FrameRing();
  readonly mediaId: string;
  readonly layerId: string;
  private readonly init: FfmpegSourceInit;
  private readonly deps: FfmpegSourceDeps;
  /// Where the transport stands; the moves are in `ffmpegSourceLifecycle.ts`.
  private slot: Slot = { kind: "idle" };
  /// The switch in flight. Every move of `slot` past `idle` happens inside one;
  /// `ensureReady` joins it.
  private work: Promise<void> | null = null;
  /// The lane of the newest attempt: the one opening, open, or just left.
  private lane: FfmpegLane = "software";
  /// The resolved HW lane the current hardware attempt keys its transport on
  /// (copy-back nvdec/vaapi/videotoolbox → SwTransport; Windows d3d11va →
  /// GpuTransport). null unless `pickInitialLane` resolved a named HW lane; a
  /// forced-lane bench run leaves it null and falls to the GPU transport.
  private hwPlan: { lane: string; device: string | null } | null = null;
  private startedHardware = false;
  private disposeP: Promise<void> | null = null;
  private lastUseMs = 0;
  private lastTargetUs: number | null = null;
  private requestVersion = 0;
  private requestedTargetUs: number | null = null;
  private onFirstFrameCb: (() => void) | null = null;
  private firedFirstFrame = false;
  private fatalCb: ((reason: string) => void) | null = null;
  /// LIVE playback-resolution divisor. Seeded from `init`, replaced by
  /// `setPlaybackScaleDiv`; every byte-shipping open reads it fresh, so a later
  /// lane change picks up the current value rather than the one the source
  /// was born with.
  private scaleDiv: number;

  constructor(init: FfmpegSourceInit, deps: FfmpegSourceDeps = {}) {
    this.init = init;
    this.deps = deps;
    this.mediaId = init.mediaId;
    this.layerId = init.layerId;
    this.scaleDiv = init.playbackScaleDiv ?? 1;
  }

  get disposed(): boolean { return this.slot.kind === "disposed"; }
  currentLane(): FfmpegLane { return this.lane; }
  currentDecodeDevice(): PreviewDecodeDevice | null {
    if (this.slot.kind !== "ready") return null;
    return this.slot.attempt.lane === "software" ? { kind: "software", backend: "ffmpeg", device: null }
      : { kind: "hardware", backend: this.hwPlan?.lane ?? "hardware", device: this.hwPlan?.device ?? null };
  }

  /// The attempt holding a transport (opening or open), else null.
  private held(): Attempt | null {
    return this.slot.kind === "opening" || this.slot.kind === "ready" ? this.slot.attempt : null;
  }
  private current(attempt: Attempt): boolean { return this.held() === attempt; }
  private move(to: Slot): void { this.slot = checkedMove(this.slot, to); }

  /// Diagnostics: the live transport's preload handoff timings, or null on the
  /// software lane (no preload stage) / before the first instrumented frame.
  handoffTimings(): HandoffTimingSummary | null {
    return this.held()?.transport.handoffTimings?.() ?? null;
  }
  /// The resolved HW lane name (`nvdec`|`vaapi`|`videotoolbox`|`d3d11va`) the
  /// current hardware attempt keyed its transport on, or null on the software
  /// lane / a forced-lane bench run. E2E-only: the lane-parameterized
  /// conformance spec reads this (via `ActiveClipProbe.hwLane`) to assert WHICH
  /// HW lane engaged.
  currentHwLane(): string | null { return this.hwPlan?.lane ?? null; }
  private get evidenceIdentity(): { layerId: string; mediaId: string } { return this.init.hardwareEvidenceIdentity ?? this; }
  hardwareEvidence() { return hardwareDecodeEvidence(this.evidenceIdentity.layerId, this.evidenceIdentity.mediaId); }
  isDowngraded(): boolean { return this.startedHardware && this.lane === "software"; }
  /// True only for this decode session's transient admission spill. Runtime
  /// device/capability failures remain sticky and must never be recycled by
  /// preview priority changes.
  isBudgetSpill(): boolean {
    return this.slot.kind === "ready" && this.slot.attempt.spill && this.slot.attempt.lane === "software";
  }

  /// Capacity recovery changes the transport, never the session/ring identity.
  /// Closing a prewarmed handle here would throw away the very frames meant
  /// to bridge the cut. Only transient admission spills may retry this way.
  async retryHardwareAfterReclaim(): Promise<void> {
    if (this.slot.kind !== "ready" || !this.isBudgetSpill()) return;
    const { attempt } = this.slot;
    await this.run(async () => {
      await this.release(attempt.transport);
      if (!this.disposed) await this.resolveAndOpen();
    });
  }
  /// True while this source actually HOLDS a main-process admission lease — a
  /// transport on the shared-texture hardware lane. A source between
  /// transports holds none, and the copy-back lanes (nvdec/vaapi/videotoolbox)
  /// ride `previewSw`: they hold global memory credits but no shared-texture
  /// HW session slot. This reclaim only targets that HW slot.
  holdsHwSessionLease(): boolean {
    const attempt = this.held();
    return attempt !== null && attempt.lane === "hardware" && !this.shipsBytes(attempt.lane);
  }
  /// Cumulative frames this source delivered, for the PerfHUD's per-clip fps
  /// column and the playback bench. Counted at the ring rather than in a
  /// transport so an internal HW→SW lane flip keeps ONE monotonic series — both
  /// transports push into the same `FrameRing`.
  decodedFrameCount(): number { return this.ring.pushCount; }
  isLookaheadFull(): boolean { return this.ring.isLookaheadFull(); }
  isIdle(nowMs: number): boolean { return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS; }

  onFirstFrame(cb: () => void): void {
    if (this.firedFirstFrame) { cb(); return; }
    this.onFirstFrameCb = cb;
  }
  onFatalError(cb: (reason: string) => void): void { this.fatalCb = cb; }

  async ensureReady(): Promise<void> {
    this.lastUseMs = performance.now();
    const slot = this.slot;
    switch (slot.kind) {
      case "ready":
      case "disposed":
        return;
      case "failed":
        throw slot.error;
      case "blocked":
        if (performance.now() < slot.retryAfterMs) throw slot.error;
        break;
      case "idle":
        break;
      default:
        return this.work ?? undefined;
    }
    return this.run(() => this.resolveAndOpen());
  }

  /// Run one switch. A divisor that changed while it ran is applied once it
  /// settles, so a switch never has to stop half way.
  private run(task: () => Promise<void>): Promise<void> {
    const work = task().finally(() => {
      if (this.work === work) this.work = null;
      this.applyScaleDiv();
    });
    this.work = work;
    return work;
  }

  private async resolveAndOpen(): Promise<void> {
    this.move({ kind: "resolving" });
    const pick = this.deps.pickLane ?? pickInitialLane;
    const res: FfmpegLaneResolution = this.init.forceLane
      ? { lane: this.init.forceLane, hwLane: null, device: null }
      : await pick(
        {
          mediaId: this.mediaId,
          codec: this.init.codec ?? null,
          pixFmt: this.init.pixFmt ?? null,
          // Conditional spread, not `width: this.init.width` —
          // exactOptionalPropertyTypes rejects an explicit `undefined` for
          // the optional `width?`/`height?` fields.
          ...(this.init.width !== undefined ? { width: this.init.width } : {}),
          ...(this.init.height !== undefined ? { height: this.init.height } : {}),
          componentAvailable: this.init.componentAvailable,
        },
        undefined,
        this.init.sourcePath,
      );
    if (this.disposed) return;
    noteHardwareSelection(this.evidenceIdentity.layerId, this.evidenceIdentity.mediaId, res.diagnostic);
    this.hwPlan = res.lane === "hardware" && res.hwLane
      ? { lane: res.hwLane, device: res.device }
      : null;
    // Sticky: a retry after a fallback re-picks software for a marked media,
    // and the clip still fell from hardware.
    this.startedHardware ||= res.lane === "hardware";
    await this.openOrRecover(res.lane, false, undefined);
  }

  /// Open `lane`; if that fails, follow `judgeFailure` until a transport is
  /// open, the source is blocked or failed, or it was disposed. Rejects with
  /// the failure when it ends blocked or failed.
  ///
  /// `transition` is passed only by a HW→SW fallback, so the lane trail can
  /// name what was left and why — see `noteLaneOpen`'s explicit-`from` rule.
  private async openOrRecover(
    lane: FfmpegLane,
    spill: boolean,
    transition: { from: FfmpegLane; reason: string } | undefined,
    canReclaim = this.deps.reclaimRetainedCapacity !== undefined,
  ): Promise<void> {
    const failure = await this.open(lane, spill, transition);
    if (failure && !this.disposed) await this.recover(lane, failure.error, canReclaim);
  }

  /// The failed transport is already closed. `canReclaim` is false once this
  /// switch has asked the pool.
  private async recover(lane: FfmpegLane, error: unknown, canReclaim: boolean): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const verdict = judgeFailure({ lane, reason, forced: this.init.forceLane !== undefined, canReclaim });
    switch (verdict.kind) {
      case "blocked":
        this.move({ kind: "blocked", error, retryAfterMs: performance.now() + CAPACITY_RETRY_MS });
        throw error;
      case "fatal":
        this.move({ kind: "failed", error });
        this.fatalCb?.(reason);
        throw error;
      case "reclaim": {
        // Main remains the admission authority; there is deliberately no
        // renderer-side budget pre-check.
        let reclaimed = false;
        try {
          reclaimed = await this.deps.reclaimRetainedCapacity!();
        } catch (reclaimErr) {
          // Capacity relief is opportunistic. If its ordered close fails, keep
          // the fallback guarantee: spill to software rather than a black clip.
          // eslint-disable-next-line no-console
          console.warn(`[weftcut/ffmpeg] capacity reclaim failed for ${this.layerId}`, reclaimErr);
        }
        if (this.disposed) return;
        return reclaimed
          ? this.openOrRecover("hardware", false, undefined, false)
          : this.recover(lane, error, false);
      }
      case "software":
        if (verdict.mark) markHwUnusable(this.mediaId, reason);
        noteHardwareFallback(this.evidenceIdentity.layerId, this.evidenceIdentity.mediaId, reason);
        // Console too, not just the lane-trail row: bench harnesses read the
        // PAGE console, and the fallback's CAUSE must survive into a report.
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/decode] decoder hardware-lane error: ${reason} — falling back to software (media ${this.mediaId})`,
        );
        return this.openOrRecover("software", verdict.spill, { from: "hardware", reason }, false);
    }
  }

  /// Open one transport, wiring its frames into the ring. Null once it is open
  /// (or the source was disposed meanwhile); on failure the transport is
  /// closed first and the failure returned.
  private async open(
    lane: FfmpegLane,
    spill: boolean,
    transition: { from: FfmpegLane; reason: string } | undefined,
  ): Promise<{ error: unknown } | null> {
    const transport = lane === "hardware"
      ? this.makeHardwareTransport()
      : this.makeSoftwareTransport(undefined, spill);
    const attempt: Attempt = { lane, transport, scaleDiv: this.scaleDiv, spill, eof: false, openError: null };
    transport.onFrame((frame, ptsUs, durUs) => {
      if (!this.current(attempt)) { frame.close(); return; }
      this.ring.push(frame, ptsUs, durUs);
      if (!this.firedFirstFrame) {
        this.firedFirstFrame = true;
        this.onFirstFrameCb?.();
        this.onFirstFrameCb = null;
      }
    });
    transport.onError((reason) => this.transportFailed(attempt, reason));
    transport.onEof(() => { if (this.current(attempt)) attempt.eof = true; });
    this.move({ kind: "opening", attempt });
    this.lane = lane;
    // A fresh streamId per open so late frames from a swapped-out transport
    // (still draining on the old streamId) can never land in the ring.
    const streamId = `ffmpeg:${lane}:${this.layerId}:${nextStreamSeq++}`;
    let failure: { error: unknown } | null = null;
    try {
      // Conditional spread, not `sourceColor: this.init.sourceColor` —
      // exactOptionalPropertyTypes rejects an explicit `undefined` for the
      // optional `sourceColor?`/`poolSize?` fields on `DecodeTransportOpen`.
      await transport.open({
        streamId,
        path: this.init.sourcePath,
        ...(this.init.sourceColor !== undefined ? { sourceColor: this.init.sourceColor } : {}),
        ...(this.init.poolSize !== undefined ? { poolSize: this.init.poolSize } : {}),
        ...(this.init.width != null ? { codedWidth: this.init.width } : {}),
        ...(this.init.height != null ? { codedHeight: this.init.height } : {}),
      });
    } catch (error) {
      failure = { error };
    }
    // Only disposal moves the slot while an attempt opens: errors are held on
    // the attempt, and every other switch starts from `ready`.
    if (this.disposed) return null;
    if (!failure && attempt.openError !== null) failure = { error: new Error(attempt.openError) };
    if (failure) {
      await this.release(transport);
      return failure;
    }
    this.move({ kind: "ready", attempt });
    // Only a lane CHANGE emits — the trail, not this call site, keeps it
    // once-per-transition across the initial open, fallbacks and re-opens.
    noteLaneOpen({ layerId: this.layerId, mediaId: this.mediaId, lane, ...(transition ?? {}) });
    if (this.lastTargetUs !== null) transport.requestFrameAt(this.requestedTargetUs ?? this.lastTargetUs);
    return null;
  }

  /// Close `transport` and wait for it: main frees its session, memory
  /// credits and any GPU lease only then, and the next open may need them. A
  /// failed close does not stop the switch; main's admission still checks
  /// the next open.
  private async release(transport: DecodeTransport): Promise<void> {
    let closing: Promise<unknown>;
    try {
      closing = Promise.resolve(transport.dispose());
    } catch (error) {
      closing = Promise.reject(error);
    }
    const closed = closing.then(() => undefined, (closeErr: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/ffmpeg] transport close failed for ${this.layerId}`, closeErr);
    });
    this.move({ kind: "releasing", closed });
    await closed;
  }

  /// An error from `attempt`'s transport. Before its open settles it belongs
  /// to that open; once open it starts a fallback; from any other attempt it
  /// is late and dropped.
  private transportFailed(attempt: Attempt, reason: string): void {
    if (this.slot.kind === "opening" && this.slot.attempt === attempt) {
      attempt.openError ??= reason;
      return;
    }
    if (this.slot.kind !== "ready" || this.slot.attempt !== attempt) return;
    void this.run(async () => {
      await this.release(attempt.transport);
      if (!this.disposed) await this.recover(attempt.lane, new Error(reason), this.deps.reclaimRetainedCapacity !== undefined);
    }).catch(() => { /* reported as blocked or fatal */ });
  }

  /// Pick the hardware transport by the resolved HW lane: the copy-back lanes
  /// (Linux nvdec/vaapi, macOS videotoolbox) ride the SW transport with a hw
  /// accel — decode happens on the GPU/OS media engine but frames ship as CPU
  /// NV12 over the SAME previewSw transport; the Windows shared-texture lane
  /// (d3d11va) rides the GPU transport. A forced lane (bench) has no hwPlan and
  /// falls to the GPU transport.
  private makeHardwareTransport(): DecodeTransport {
    const hw = this.hwPlan;
    if (hw && isCopyBackHwLane(hw.lane)) {
      // The copy-back lanes ship the same NV12 bytes over the same IPC, so they
      // want the playback-resolution divisor just as much as software does.
      return this.makeSoftwareTransport({ lane: hw.lane, device: hw.device }, false);
    }
    return this.deps.makeGpu?.() ?? new GpuTransport();
  }

  /// One constructor seam owns every byte-shipping profile. The formal spill
  /// (`spill`) follows only a budget refusal; ordinary software and the
  /// copy-back lanes preserve the user's resolution and full cadence.
  ///
  /// The transport FORMAT is decided here too (issue #10): a 10-bit
  /// source on the videotoolbox lane opens I420P10, so ProRes/10-bit frames
  /// ride the ten-bit adapter instead of being quantized to NV12. Every other
  /// open — plain software (including the HW→SW fallback of the same media),
  /// the Linux copy-back lanes, 8-bit sources on videotoolbox — stays NV12
  /// exactly; the software lane's 10-bit behavior is deliberately NOT widened.
  private makeSoftwareTransport(accel: { lane: string; device: string | null } | undefined, spill: boolean): DecodeTransport {
    const profile = resolveBudgetSpillProfile({
      budgetExceeded: spill,
      codedWidth: this.init.width,
      codedHeight: this.init.height,
      playbackScaleDiv: this.scaleDiv,
    });
    const tenBit = accel?.lane === "videotoolbox" && isTenBitPixFmt(this.init.pixFmt ?? null);
    return this.deps.makeSw?.({
      ...(accel ? { accel } : {}),
      ...profile,
      ...(tenBit ? { outFormat: "I420P10" as const } : {}),
    }) ?? new SwTransport(accel, profile.scaleDiv, profile.cadenceDiv, tenBit ? "I420P10" : undefined);
  }

  /// True when `lane` ships frames through `SwTransport` — plain software, or
  /// a copy-back HW lane, all of which pack bytes across IPC. Mirrors
  /// `makeHardwareTransport`'s routing, and is the only place the
  /// playback-resolution divisor can change anything.
  private shipsBytes(lane: FfmpegLane): boolean {
    if (lane === "software") return true;
    const hw = this.hwPlan;
    return hw !== null && isCopyBackHwLane(hw.lane);
  }

  /// Adopt a new playback-resolution divisor on a LIVE source, without a
  /// reload and without a lane change: close the transport, open the SAME lane
  /// with a fresh streamId, keep the SAME `FrameRing` — the painter keeps
  /// drawing the frames already cached and `open` re-requests the last target.
  ///
  /// Deliberately does NOT re-open the Windows shared-texture lane: its pixels
  /// never cross IPC, so the divisor cannot shrink anything there, and closing
  /// + re-opening a d3d11va session would spend a scarce HW session slot
  /// (`PREVIEW_GPU_MAX_SESSIONS`) for no gain — and risk losing it to another
  /// clip mid-swap.
  /// The value is still recorded, so a later HW→SW fallback opens with it.
  setPlaybackScaleDiv(div: number): void {
    if (div === this.scaleDiv) return;
    this.scaleDiv = div;
    this.applyScaleDiv();
  }

  /// Re-open an open byte-shipping transport whose divisor is stale. Waits for
  /// `ready`: a switch in flight applies it when it settles (`run`).
  private applyScaleDiv(): void {
    if (this.slot.kind !== "ready") return;
    const { attempt } = this.slot;
    if (attempt.scaleDiv === this.scaleDiv || !this.shipsBytes(attempt.lane)) return;
    void this.run(async () => {
      await this.release(attempt.transport);
      if (!this.disposed) await this.openOrRecover(attempt.lane, attempt.spill, undefined);
    }).catch(() => { /* reported as blocked or fatal */ });
  }

  async requestFrameAt(tUs: number): Promise<void> {
    const version = ++this.requestVersion;
    this.requestedTargetUs = tUs;
    // A switch in flight is not waited for: the ring keeps moving below, and
    // the switch's open requests the newest target itself.
    if (this.slot.kind !== "ready" && this.work === null) {
      try {
        await this.ensureReady();
      } catch {
        // Already reported: a fatal through `onFatalError` (the Compositor
        // swaps engines on that), a capacity refusal by holding the source.
        // Without this catch every per-tick nudge mints a fresh unhandled
        // rejection for the same failure, forever.
        return;
      }
    }
    this.lastUseMs = performance.now();
    if (this.disposed || version !== this.requestVersion) return;
    // Null while a switch runs.
    const attempt = this.slot.kind === "ready" ? this.slot.attempt : null;
    const prevTargetUs = this.lastTargetUs;
    this.lastTargetUs = tUs;
    // Backward seek past everything cached: the ring now holds ONLY future-dated
    // frames, which `setAnchor` can never evict (front-only). Drop them, or the
    // painter holds a wrong-region frame until playback grinds all the way back
    // up to the cached span — measured at 12 s of frozen picture. This mirrors
    // the WebCodecs lane, where `PacketPump.decideReset`'s backward arm flushes.
    if (this.ring.strandedAheadOf(tUs)) {
      this.ring.flush();
      // EOF is not terminal for a backward seek: the native session re-arms
      // decoding on the seek its `on_request` performs. Without clearing the
      // latch, the `return` below would swallow every later request for the rest
      // of this transport's life — the session would never produce again.
      if (attempt) {
        attempt.eof = false;
        attempt.transport.resetRequestDedup?.();
      }
    } else if (attempt?.eof && prevTargetUs !== null && tUs < prevTargetUs) {
      // Backward seek with NOTHING cached: `strandedAheadOf` is false on an
      // empty ring by construction, and post-eof lookbehind eviction (the
      // `setAnchor` below keeps running while `eof` gates requests) drains the
      // ring to exactly that state. Without this arm the latch has no escape —
      // the transport is never re-armed and the clip stays black for the rest
      // of the session. A backward move is the same re-arm the stranded flush
      // performs; there is just nothing left to flush.
      attempt.eof = false;
      attempt.transport.resetRequestDedup?.();
    }
    this.ring.setAnchor(tUs);      // always — drives lookbehind eviction, even post-eof
    // eof seen on the current transport — its own IPC is done, but the anchor
    // above must still advance so the ring keeps evicting stale frames.
    if (!attempt || attempt.eof) return;
    // Backpressure — the ring's byte ceiling bounds what the decoder PRODUCES
    // on this lane, not only what it retains. It cannot starve the lane:
    // the byte arm is floored at `MIN_LOOKAHEAD_FRAMES` ahead and the time arm
    // wants a full second — deeper than the native pump's own 500 ms horizon, so
    // steady playback never reaches here and the native cursor sets the pace.
    if (this.ring.isLookaheadFull()) return;
    if (this.ring.hasLookaheadAt(tUs, REFILL_LOOKAHEAD_US)) return;
    attempt.transport.requestFrameAt(tUs);
  }

  /// Pool-only ordered teardown. Unlike ordinary fire-and-forget `dispose`,
  /// this resolves after the transport — or one a switch was still closing —
  /// has released main's session and any GPU admission lease, making it safe
  /// to open a priority replacement.
  disposeAndWait(): Promise<void> {
    if (this.disposeP) return this.disposeP;
    const slot = this.slot;
    const closing = slot.kind === "opening" || slot.kind === "ready" ? Promise.resolve(slot.attempt.transport.dispose())
      : slot.kind === "releasing" ? slot.closed
        : Promise.resolve();
    this.move({ kind: "disposed" });
    this.ring.dispose();
    this.onFirstFrameCb = null;
    this.disposeP = closing.then(() => undefined);
    return this.disposeP;
  }

  dispose(): void {
    void this.disposeAndWait();
  }
}
