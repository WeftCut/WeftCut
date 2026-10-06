// A GPU-byte budget shared across every live preview `FrameRing`.
//
// Why it exists: the ring's retention policy is a TIME window (1 s lookahead +
// 0.5 s lookbehind), which spends wildly different amounts of GPU memory
// depending on frame size — the `ImageBitmap`s it holds are ~8 MB at 1080p and
// ~33 MB at 4K. Measured (docs/playback-perf.md), one 4K clip pins ~1.9 GB and
// two ask for ~4 GB, at which point the decoders stop producing usable frames
// entirely: three of four rings read EMPTY at 1080p×4 while all four decoders
// reported full-rate delivery. The tick stayed clean through all of it, so the
// wall is retained bytes, not compositing.
//
// The budget is shared rather than per-ring so one clip may use the whole thing
// and N clips divide it — a fixed per-ring cap would needlessly shrink the
// single-clip case, which is the one that measures well today.
//
// LANDMINE: this is a TARGET, not a hard cap. `FrameRing`'s frame floors
// deliberately override it (see MIN_LOOKAHEAD_FRAMES there) — a ring starved
// below a few frames would thrash and would break the warm-up gate, which is
// worse than overshooting the byte target. Two 4K clips therefore settle above
// this total, just bounded instead of unbounded.
//
// Preview only: export retains frames in `ExportFrameStore`, not here.

// Runtime target; lower budgets can increase long-GOP re-seek churn.
// The FrameRing forward-frame floor still overrides this target.
import { cacheBudget } from '../cacheBudget';

let liveRings = 0;

/// Called from the `FrameRing` constructor.
export function registerFrameRing(): void {
  liveRings += 1;
}

/// Called from `FrameRing.dispose()`, which is idempotent — a double dispose
/// must not inflate the divisor, because every OTHER ring would silently get a
/// smaller share. Clamped at zero so an unbalanced call can't go negative and
/// hand out an absurd budget.
export function unregisterFrameRing(): void {
  liveRings = Math.max(0, liveRings - 1);
}

/// This ring's share of the total, in bytes.
export function frameRingByteBudget(): number {
  return cacheBudget.allowance('frame_ring_mib') / Math.max(1, liveRings);
}

/// Diagnostics + tests: how many rings are dividing the budget.
export function liveFrameRingCount(): number {
  return liveRings;
}

/// Unit tests only — module state outlives a test otherwise.
export function resetFrameRingBudgetForTest(): void {
  liveRings = 0;
}
