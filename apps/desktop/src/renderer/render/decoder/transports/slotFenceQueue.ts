// Deferred slot releases for the hardware preview lane, taken on the renderer's
// own PRESENTED graphics device: the lane's one read-completion strategy.
//
// Why a release must wait at all: the native decode thread overwrites a
// shared-texture slot in place as soon as it is released, on ffmpeg's own D3D11
// device, while Chromium reads it (getVideoFrame → createImageBitmap) on the
// GPU process's device. Chromium cannot track that cross-device dependency, and
// `await createImageBitmap` resolves before the copy has run on the GPU. A slot
// released then is overwritten with the frame pool_size ahead while the copy is
// still pending, and the bitmap carries that frame's pixels under this frame's
// PTS (observed: decoded index = expected + pool_size). The ring sorts by PTS,
// so this shows as out-of-order playback, not tearing. What must wait is the
// RELEASE, never the delivery: the page's own use of the bitmap only queues
// more GPU work behind the copy.
//
// The completion signal on the renderer's WebGPU device is a PROMISE, so a slot
// that is not ready yet costs nothing on the renderer thread to keep waiting
// for. It is not that the signal arrives sooner: it arrives around 90ms. That
// hold can limit decode throughput with a shallow native pool, but completion
// is the ownership boundary — elapsed wall time is not evidence that native may
// safely overwrite the shared texture. Why this and not a synchronous proof
// per frame: docs/notes/slot-read-completion-2026-11-18.md.
//
// INVARIANT — every live submitted bitmap releases EXACTLY ONCE, and only after
// its probe signals. `submit` either queues the release or performs a completed
// fallback before returning; a failed fallback reports failure without release
// so the caller can close the stream. Nothing else may release. The release is
// deliberately independent of PAINT: a frame the ring evicts, or one that
// arrives while the compositor is suspended, still holds a slot and still
// releases. The one exception is a stream tearing down (`dropFor`), where the
// slots cease to exist with the native session and releasing into it is the
// thing to avoid.

import type { FenceHandoffStats } from "./handoffTimings";
import { webgpuDeviceOf } from "../../webgpuDevice";
import { createReadCompletionProof } from "../../../../shared/readCompletion";

/// One in-flight completion probe over one delivered bitmap.
export interface SlotFenceProbe {
  /// Non-blocking: has the GPU finished the copy this probe was taken after?
  signalled(): boolean;
  /// Release whatever GPU object the probe holds.
  dispose(): void;
}

/// The graphics device the probes are taken on. Injected rather than reached for
/// so this queue is testable without a GPU, and so "no device registered yet"
/// is a state the fallback ladder handles rather than a crash.
export interface SlotFenceBackend {
  /// Submit the completion-forcing copy and start its probe. `onSignal` is a
  /// WAKE-UP, not the ack — the queue re-reads `signalled()` itself, so a
  /// backend that over-fires it is harmless. Null = this backend could not run,
  /// and the caller must fall back to the one-pixel proof.
  submit(bmp: ImageBitmap, onSignal: () => void): SlotFenceProbe | null;
}

/// What ran for one submitted bitmap: the device `fence`, the one-pixel
/// `proof` when no device could take one, or `none` when neither could run.
/// `drawMs`/`readMs` split the blocking cost the way `ReadCompletionCost` does.
export interface SlotFenceSubmission {
  applied: "fence" | "proof" | "none";
  drawMs: number;
  readMs: number;
}

export type SlotFenceReleasePolicy =
  | { mode: "signal-only" }
  | { mode: "unsafe-deadline"; deadlineMs: number };

type PendingSlot = {
  streamId: string;
  slot: number;
  probe: SlotFenceProbe;
  submittedAt: number;
  ack: () => void;
};

type StreamStats = {
  pending: number;
  pendingPeak: number;
  forcedWaits: number;
  lastWaitMs: number | null;
  completed: number;
  waits: number[];
};

/// The one-pixel proof (shared/readCompletion.ts): synchronous on the renderer
/// thread, once per frame per session. Reached only when no device is
/// registered, so that a missing device degrades to SLOW rather than to
/// INCORRECT.
///
/// Null = not even a 2D context, so nothing ran. Reported as `none`, which is an
/// alarm and not a cost.
const proveReadComplete = createReadCompletionProof();

export class SlotFenceQueue {
  private backend: SlotFenceBackend | null = null;
  private readonly pending: PendingSlot[] = [];
  private readonly statsByStream = new Map<string, StreamStats>();
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  /// Production uses `signal-only`: an unsignalled probe retains ownership until
  /// it signals or its stream closes. `unsafe-deadline` releases on a timer and
  /// exists only for diagnostics/tests; it may recycle a shared texture while
  /// Chromium is still reading it.
  constructor(
    private readonly releasePolicy: SlotFenceReleasePolicy = { mode: "signal-only" },
  ) {}

  /// Point the queue at a device, or at nothing. Entries already pending keep
  /// their own probes — those are self-contained objects, so a re-registration
  /// (a StrictMode remount, a renderer rebuild) never strands a slot.
  setBackend(backend: SlotFenceBackend | null): void {
    this.backend = backend;
  }

  /// Take responsibility for one delivered bitmap's slot. Returns what ran; the
  /// release is queued (`fence`), done (`proof`), or withheld (`none`,
  /// requiring the caller to close the stream).
  submit(streamId: string, slot: number, bmp: ImageBitmap, ack: () => void): SlotFenceSubmission {
    const t0 = performance.now();
    // The copy is what forces completion; the probe only reports it. Both are
    // the backend's business, and either failing means the ladder must catch it.
    //
    // A THROW is caught as well as a null, so the invariant below does not rest on
    // a backend honouring its contract: the shipped one converts its own failures
    // to null, but an escaping throw here would skip the ack entirely and strand
    // the slot — the one outcome this queue must never produce.
    let probe: SlotFenceProbe | null = null;
    try {
      probe = this.backend?.submit(bmp, () => this.drain()) ?? null;
    } catch {
      probe = null;
    }
    if (probe) {
      const drawMs = performance.now() - t0;
      this.pending.push({ streamId, slot, probe, submittedAt: performance.now(), ack });
      const stats = this.statsFor(streamId);
      stats.pending += 1;
      stats.pendingPeak = Math.max(stats.pendingPeak, stats.pending);
      this.schedulePump();
      return { applied: "fence", drawMs, readMs: 0 };
    }
    // A failed CPU fallback proves nothing about the outstanding GPU read.
    // Report `none` without ack: GpuTransport closes this stream and reports
    // failure to its owner, which may switch lanes inside the same FrameRing.
    let cost: { drawMs: number; readMs: number } | null = null;
    try {
      cost = proveReadComplete(bmp);
    } catch {
      cost = null;
    }
    if (cost) ack();
    return cost
      ? { applied: "proof", ...cost }
      : { applied: "none", drawMs: 0, readMs: 0 };
  }

  /// Ack every pending slot whose probe has signalled. In the explicit unsafe
  /// compatibility mode, a blown deadline is also released and counted.
  /// Cheap enough to call opportunistically — a frame arriving is a wake-up the
  /// queue may already have been waiting for.
  drain(): void {
    if (this.pending.length === 0) return;
    const now = performance.now();
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      let done = false;
      try {
        done = p.probe.signalled();
      } catch {
        // An unreadable probe is not proof of completion. Retain its slot for
        // stream teardown, but keep draining independent slots.
        continue;
      }
      const unsafeDeadlineExpired =
        this.releasePolicy.mode === "unsafe-deadline" &&
        now - p.submittedAt >= this.releasePolicy.deadlineMs;
      if (!done && !unsafeDeadlineExpired) continue;
      // Completion owns the slot release, not successful destruction of the
      // probe wrapper. A lost device can make cleanup throw after the work has
      // already settled; do not let that strand this or earlier ready slots.
      try {
        p.probe.dispose();
      } catch {
        // Best-effort GPU-object cleanup; ownership release continues below.
      }
      this.pending.splice(i, 1);
      const stats = this.statsFor(p.streamId);
      stats.pending = Math.max(0, stats.pending - 1);
      stats.lastWaitMs = performance.now() - p.submittedAt;
      stats.waits[stats.completed++ % 120] = stats.lastWaitMs;
      if (!done) stats.forcedWaits += 1;
      // `!done` is reachable only through the explicitly unsafe constructor
      // option. Keep it observable rather than silently presenting that result
      // as a completed fence.
      try {
        p.ack();
      } catch {
        // The production callback owns its transport-failure response (it closes
        // the native session). Do not let one failed delivery strand other
        // independently completed slots in this drain pass.
      }
    }
  }

  /// Drop a closing stream's pending slots WITHOUT releasing them. Their reads
  /// may still be in flight, and the renderer's teardown closes the session
  /// right after (`GpuTransport.dispose`): the native close stops the decode
  /// thread, so the slots cease to exist with it.
  dropFor(streamId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.streamId !== streamId) continue;
      // Device teardown may make destroying its probe throw. Closing the stream
      // still has to forget every local ownership record; native joins and
      // destroys the slots independently, so retaining this entry cannot help.
      try {
        p.probe.dispose();
      } catch {
        // Best-effort GPU-object cleanup; local queue cleanup is unconditional.
      }
      this.pending.splice(i, 1);
    }
    this.statsByStream.delete(streamId);
    if (this.pending.length === 0 && this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  /// This stream's fence health in the shape the handoff window records, or
  /// undefined before its first submit. `forcedWaitMsTotal` is structurally 0:
  /// a promise-based signal has no blocking spin to burn thread time in.
  stats(streamId: string): FenceHandoffStats | undefined {
    const s = this.statsByStream.get(streamId);
    if (!s) return undefined;
    return {
      pendingPeak: s.pendingPeak,
      forcedWaits: s.forcedWaits,
      forcedWaitMsTotal: 0,
      ...(s.lastWaitMs !== null ? { waitMs: s.lastWaitMs } : {}),
    };
  }

  /// Un-acked slots still held, across every stream. Diagnostics + tests.
  pendingCount(): number {
    return this.pending.length;
  }

  turnover(streamId: string): { pending: number; oldestMs: number; completed: number; waitP95Ms: number | null } | null {
    const s = this.statsByStream.get(streamId);
    if (!s) return null;
    const now = performance.now();
    let oldestMs = 0;
    for (const p of this.pending) if (p.streamId === streamId) oldestMs = Math.max(oldestMs, now - p.submittedAt);
    const waits = [...s.waits].sort((a, b) => a - b);
    return { pending: s.pending, oldestMs, completed: s.completed,
      waitP95Ms: waits.length ? waits[Math.ceil(waits.length * 0.95) - 1]! : null };
  }

  private statsFor(streamId: string): StreamStats {
    let s = this.statsByStream.get(streamId);
    if (!s) {
      s = { pending: 0, pendingPeak: 0, forcedWaits: 0, lastWaitMs: null, completed: 0, waits: [] };
      this.statsByStream.set(streamId, s);
    }
    return s;
  }

  /// Drain driver for the gaps between frames and between signals. Runs only
  /// while something is pending and stops the moment the queue empties.
  ///
  /// The safe production path is woken directly by the backend's completion
  /// callback and does not poll. Only the explicit unsafe deadline mode needs a
  /// timer so its compatibility timeout can elapse between frames.
  private schedulePump(): void {
    if (this.releasePolicy.mode !== "unsafe-deadline") return;
    if (this.pumpTimer !== null || this.pending.length === 0) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.drain();
      this.schedulePump();
    }, 0);
  }
}

/// The completion probe on a WebGPU device: copy one pixel out of the bitmap on
/// the queue Pixi presents from, then ask that queue when its submitted work is
/// done.
///
/// Why one pixel and not the whole frame: GPU synchronization is per-RESOURCE, so reading
/// any part of the bitmap orders after the whole pending write into it — and
/// that write IS the read of the shared slot. A full-frame copy would add real
/// bandwidth (8MB at 1080p, 33MB at 4K) to the device we are trying not to
/// disturb, every frame, to establish the same dependency.
///
/// `onSubmittedWorkDone` is the fence: a promise, so there is no polling and no
/// spin. It resolves on its own; it is just slow to.
class WebgpuSlotFence implements SlotFenceBackend {
  /// One 1×1 destination, created lazily and reused for the whole session. The
  /// pixels are never read — only the dependency matters.
  private tex: GPUTexture | null = null;

  constructor(private readonly device: GPUDevice) {}

  submit(bmp: ImageBitmap, onSignal: () => void): SlotFenceProbe | null {
    try {
      // RENDER_ATTACHMENT is required of a copyExternalImageToTexture
      // destination, COPY_DST of any copy destination.
      this.tex ??= this.device.createTexture({
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture(
        { source: bmp },
        { texture: this.tex },
        [1, 1],
      );
      let done = false;
      // A rejected promise (device lost) settles as signalled: there can be no
      // remaining device work to protect, and leaving it pending would retain
      // the native slot until stream teardown.
      const settle = (): void => {
        done = true;
        onSignal();
      };
      void this.device.queue.onSubmittedWorkDone().then(settle, settle);
      return { signalled: () => done, dispose: () => {} };
    } catch {
      // A detached bitmap or a dead device — report "could not run" so the
      // caller falls back to the one-pixel proof instead.
      return null;
    }
  }

}

/// Derive a backend from the host's Pixi renderer, or null when it offers none.
///
/// WebGPU only, DELIBERATELY. Taking the fence on a Pixi WebGL2 context would
/// mean `bindTexture` on a context whose bound-texture cache Pixi maintains
/// itself, so the fence would corrupt compositing state; the WebGPU device
/// hands out a private texture and a queue with no such shared state. The
/// preview renderer prefers WebGPU (see PixiPreview), so this is also the path
/// that actually runs; a WebGL preview falls back to the one-pixel proof, which
/// is slow but correct and is counted as a proof rather than blending in.
export function slotFenceBackendForRenderer(renderer: unknown): SlotFenceBackend | null {
  const device = webgpuDeviceOf(renderer);
  return device ? new WebgpuSlotFence(device) : null;
}

/// The one queue every `GpuTransport` shares. Module-level because the device is
/// the host application's, not any one session's, and because the release
/// obligation outlives the frame that created it.
const shared = new SlotFenceQueue();

export function sharedSlotFenceQueue(): SlotFenceQueue {
  return shared;
}

/// Point the shared queue at the host's device. Called by the preview host when
/// its Pixi Application initializes, and with null on teardown.
export function setSlotFenceBackend(backend: SlotFenceBackend | null): void {
  shared.setBackend(backend);
}
