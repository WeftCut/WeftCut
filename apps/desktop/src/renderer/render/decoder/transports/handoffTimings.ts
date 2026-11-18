// Rolling window over the per-frame handoff timings for the hardware lane: the
// preload stamps every slot it reads with `gvfMs` / `cibMs` / `residentMs`
// (preload/decodeSessionPorts.ts), `GpuTransport` adds what its read
// completion cost and the slot fence's health, and this window summarizes them.
//
// The number this exists for is `barrier`: the read-completion cost on the
// renderer thread before a slot can be released. Read completion is
// load-bearing for cross-device read ordering — without it the lane presents
// frames pool_size out of order (slotFenceQueue.ts) — so with several hardware
// clips it is a suspect for presentation judder that `lag`/dropped-frame
// counters cannot see.
//
// Pure and allocation-light: a fixed ring, sorted only when a summary is asked
// for (the HUD polls at 2 Hz).

import type { SlotReadTiming } from "../../../../shared/frameCarrier/wire";

/// Health of the slot fence queue, as `GpuTransport` reports it per frame.
/// `pendingPeak`/`forcedWaits`/`forcedWaitMsTotal` are cumulative counters (the
/// window keeps the max, so they survive the ring); `waitMs` is one completed
/// submit→release and is absent until the first fence drains. The production
/// queue is signal-only, so its forced counters stay zero; non-zero values come
/// from the queue's explicit unsafe-deadline diagnostic policy.
export interface FenceHandoffStats {
  waitMs?: number;
  pendingPeak: number;
  forcedWaits: number;
  forcedWaitMsTotal: number;
}

export interface HandoffTimingSummary {
  slotTurnover?: { pending: number; oldestMs: number; completed: number; waitP95Ms: number | null } | null;
  /// Samples in the window.
  n: number;
  /// The read-completion cost on the renderer thread, ms.
  barrierP50: number;
  barrierP95: number;
  barrierMax: number;
  /// The barrier split into its two phases — the draw or submit, and the CPU
  /// read. Under the fence the whole cost is the submit; under the one-pixel
  /// proof the draw is the wait for the GPU copy (shared/readCompletion.ts).
  barrierDrawP50: number;
  barrierReadP50: number;
  /// Frames whose read completion fell back to the one-pixel proof because no
  /// device could take a fence — cumulative over the session. Zero when the
  /// fence ran for every frame; a run that wants to certify the fence checks
  /// this, since an order check passes under the proof just as well.
  proofFallbacks: number;
  /// The three health indicators for the slot fence, which trades a blocking
  /// wait for a deferred one and therefore has failure modes the barrier
  /// timings above cannot show.
  ///
  /// `fenceWaitP50` is the deferred wait itself (submit → release), null until
  /// a fence completes — it is NOT loop cost, and reading it as such is the
  /// mistake this split exists to prevent. `fencePendingQueuePeak` is how deep
  /// the unreleased queue ever got: approaching `poolSize` means the deferral is
  /// starving the producer rather than freeing it. `fenceForcedWaits` counts
  /// releases the queue's unsafe-deadline diagnostic policy forced; it stays
  /// zero for production's signal-only fence.
  fenceWaitP50: number | null;
  fencePendingQueuePeak: number;
  fenceForcedWaits: number;
  /// Wall-clock ms burned inside forced spins, SUMMED over the session. A sum
  /// and not a percentile on purpose: spins are a minority of frames, so every
  /// percentile reports them as zero. Structurally 0 for the slot fence: a
  /// promise-based completion signal has nothing to poll. A zero here means no
  /// spin exists; `fencePendingQueuePeak`/`fenceWaitP50` carry its health.
  fenceForcedWaitMsTotal: number;
  /// `createImageBitmap` — an enqueue, so cheap; read completion is what waits
  /// for the copy this call schedules.
  cibP50: number;
  /// Whole preload residency: getVideoFrame → bitmap ready to post.
  residentP50: number;
}

/// Nearest-rank percentile over an already-sorted array. `q` in [0,1].
function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? 0;
}

export class HandoffTimings {
  private readonly barrier: number[] = [];
  private readonly barrierDraw: number[] = [];
  private readonly barrierRead: number[] = [];
  private readonly cib: number[] = [];
  private readonly resident: number[] = [];
  private next = 0;
  private count = 0;
  /// Cumulative, NOT a ring entry: a fallback that scrolls out of a 120-frame
  /// window is a fallback nobody sees.
  private proofs = 0;
  /// Deferred-fence waits get their OWN ring: they ride in on a frame message
  /// but only some frames carry one (none until the first fence drains), so
  /// indexing them alongside the per-frame stamps would pad the window with
  /// zeros and halve the reported wait.
  private readonly fenceWait: number[] = [];
  private fenceNext = 0;
  private fenceCount = 0;
  /// Cumulative counters from the fence queue, kept as maxima — the sender only
  /// ever grows them, so max is last-known and survives the ring's eviction.
  private fencePendingPeak = 0;
  private fenceForced = 0;
  private fenceForcedMsTotal = 0;

  constructor(private readonly capacity = 120) {}

  /// Record one slot: the preload's read stamps, what its read completion cost
  /// here (`proof`: the one-pixel proof ran because no fence could), and the
  /// fence queue's health after it.
  record(read: SlotReadTiming, completion: { drawMs: number; readMs: number; proof: boolean }, fence?: FenceHandoffStats): void {
    const i = this.next % this.capacity;
    this.barrier[i] = completion.drawMs + completion.readMs;
    this.barrierDraw[i] = completion.drawMs;
    this.barrierRead[i] = completion.readMs;
    this.cib[i] = read.cibMs;
    this.resident[i] = read.residentMs;
    if (completion.proof) this.proofs += 1;
    if (fence) {
      this.fencePendingPeak = Math.max(this.fencePendingPeak, fence.pendingPeak);
      this.fenceForced = Math.max(this.fenceForced, fence.forcedWaits);
      this.fenceForcedMsTotal = Math.max(this.fenceForcedMsTotal, fence.forcedWaitMsTotal);
      if (fence.waitMs !== undefined) {
        this.fenceWait[this.fenceNext % this.capacity] = fence.waitMs;
        this.fenceNext += 1;
        if (this.fenceCount < this.capacity) this.fenceCount += 1;
      }
    }
    this.next += 1;
    if (this.count < this.capacity) this.count += 1;
  }

  /// Null until at least one sample lands, so a caller can tell "no hardware
  /// frames yet" from "0 ms".
  summary(): HandoffTimingSummary | null {
    if (this.count === 0) return null;
    const b = this.barrier.slice(0, this.count).sort((x, y) => x - y);
    const bd = this.barrierDraw.slice(0, this.count).sort((x, y) => x - y);
    const br = this.barrierRead.slice(0, this.count).sort((x, y) => x - y);
    const c = this.cib.slice(0, this.count).sort((x, y) => x - y);
    const r = this.resident.slice(0, this.count).sort((x, y) => x - y);
    return {
      n: this.count,
      barrierP50: pct(b, 0.5),
      barrierP95: pct(b, 0.95),
      barrierMax: b[b.length - 1] ?? 0,
      barrierDrawP50: pct(bd, 0.5),
      barrierReadP50: pct(br, 0.5),
      proofFallbacks: this.proofs,
      fenceWaitP50: this.fenceCount === 0
        ? null
        : pct(this.fenceWait.slice(0, this.fenceCount).sort((x, y) => x - y), 0.5),
      fencePendingQueuePeak: this.fencePendingPeak,
      fenceForcedWaits: this.fenceForced,
      fenceForcedWaitMsTotal: this.fenceForcedMsTotal,
      cibP50: pct(c, 0.5),
      residentP50: pct(r, 0.5),
    };
  }
}
