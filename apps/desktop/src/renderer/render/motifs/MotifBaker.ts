import { planBakeTargets, type BakeContent, type BakeTarget } from "./bakePlan";
import { IdleBatchQueue } from "./idleBatchQueue";
import type { CapturedFrame } from './frameTransport';

export type BakePhase = "baking" | "ready" | "error";
export interface BakeStatus { phase: BakePhase; done: number; total: number; }

/// One content the baker should persist in full. `render(frame)` rasters an
/// arbitrary content frame (the frame service's shared acquisition closure).
export interface BakeContentSpec extends BakeContent {
  /// A capture can already have been atomically persisted in main while its
  /// OSR surface was leased. Plain bitmaps use the compatibility PNG writer.
  render: (frame: number) => Promise<ImageBitmap | CapturedFrame>;
}

export interface MotifBakerDeps {
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// True if (cacheKey, frame) cache file already on disk → skip. Consulted ONCE per
  /// frame (when the frame is pulled into a batch), so the whole bake is O(N).
  isOnDisk: (cacheKey: string, frame: number) => Promise<boolean>;
  /// Encode + write the frame, then mark the cacheKey baked. Throws are caught.
  persist: (cacheKey: string, frame: number, bmp: ImageBitmap) => Promise<void>;
  /// Optionally warm L0 with the freshly-baked bitmap (so the just-baked frame
  /// is instantly available without a disk round-trip). The cache OWNS the
  /// bitmap after this.
  warm: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  /// Report coarse per-content status. Called immediately on setTargets
  /// (baking) and once per drain batch for touched keys (progress / ready /
  /// error). Never throws. Optional so existing callers/tests don't need it.
  onStatus?: (cacheKey: string, status: BakeStatus) => void;
  batchSize?: number;
}

/// A queued target resolved to its spec at pull time (see `take`).
interface BakeBatchItem extends BakeTarget {
  spec: BakeContentSpec;
}

/// Idle-paced, full-content writer for L2. `setTargets` (re)plans synchronously
/// and arms; the shared `IdleBatchQueue` loop renders+persists missing frames
/// in priority order, yielding between batches. The SOLE writer of L2 (the
/// resolver is read-only), so there's no fire-and-forget eviction race.
/// Preview-only (DOM-gated by the Compositor).
export class MotifBaker {
  private specsByKey = new Map<string, BakeContentSpec>();
  /// Per-cacheKey bake progress, preserved while the content stays targeted.
  private status = new Map<string, BakeStatus>();
  /// Completion is frame identity, not number of successful jobs: replanning
  /// can enqueue a frame that is still in flight or already completed.
  private completed = new Map<string, Set<number>>();
  /// cacheKeys with a frame being rendered/persisted RIGHT NOW. Tracked apart
  /// from specsByKey because a setTargets re-plan retires a spec while its
  /// in-flight frame keeps writing — and that write's hash dir must stay
  /// GC-live until the write lands (see `targetCacheKeys`).
  private readonly inFlightKeys = new Set<string>();
  /// cacheKeys whose status advanced during the in-flight batch; drained by
  /// the loop's onBatchDone into one onStatus emit per touched key per batch.
  private readonly touched = new Set<string>();
  private readonly loop: IdleBatchQueue<BakeTarget, BakeBatchItem>;

  constructor(private readonly deps: MotifBakerDeps) {
    this.loop = new IdleBatchQueue<BakeTarget, BakeBatchItem>({
      schedule: deps.schedule,
      cancel: deps.cancel,
      batchSize: deps.batchSize ?? 2,
      take: (target) => {
        if (this.completed.get(target.cacheKey)?.has(target.frame)) return null;
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) return null; // content no longer active
        return { ...target, spec };
      },
      run: async ({ cacheKey, frame, spec }) => {
        this.inFlightKeys.add(cacheKey);
        let owned: ImageBitmap | null = null;
        try {
          // The disk-skip check runs per-frame inside the batch — a skipped
          // (already-baked) frame just consumes a slot; skips are the cheap
          // case. Each frame's `isOnDisk` is consulted exactly once.
          const onDisk = await this.deps.isOnDisk(cacheKey, frame);
          if (this.loop.isDisposed()) return;
          if (onDisk) { this.bump(cacheKey, frame); return; }
          const result = await spec.render(frame);
          const captured = 'bitmap' in result ? result : { bitmap: result, persisted: false };
          owned = captured.bitmap;
          if (this.loop.isDisposed()) return;
          if (!captured.persisted) await this.deps.persist(cacheKey, frame, owned);
          if (this.loop.isDisposed()) return;
          this.deps.warm(cacheKey, frame, owned);
          owned = null; // ownership transferred to L0 only after warm succeeds
          this.bump(cacheKey, frame);
        } catch (error) {
          if (this.status.get(cacheKey)?.phase !== "error") {
            console.warn("[weftcut/motifs] pre-bake frame failed", { frame, error });
          }
          this.markError(cacheKey);
        } finally {
          owned?.close(); // failed persist / teardown: nobody else owns it
          this.inFlightKeys.delete(cacheKey);
        }
      },
      onBatchDone: () => {
        for (const k of this.touched) {
          const st = this.status.get(k);
          if (st) this.deps.onStatus?.(k, { ...st });
        }
        this.touched.clear();
      },
    });
  }

  /// Replace the active bake set, plan the whole content (playhead-first), and
  /// arm — all synchronously, like `MotifPrewarmer.setTargets`, so a caller
  /// (and the unit test's settle loop) sees a scheduled callback immediately.
  setTargets(specs: BakeContentSpec[]): void {
    if (this.loop.isDisposed()) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    for (const key of this.completed.keys()) {
      if (!this.specsByKey.has(key)) this.completed.delete(key);
    }
    this.loop.setQueue(planBakeTargets(
      specs.filter((s) => this.status.get(s.cacheKey)?.phase !== "ready"),
      (key, frame) => this.completed.get(key)?.has(frame) ?? false,
    ));
    // Preserve status across re-plans: re-calling setTargets with an unchanged
    // active set (every frame, as the playhead moves) must NOT reset a ready
    // content back to baking — that flickers the UI dot. Keep the prior status
    // object for keys still present; announce "baking" only for NEW keys.
    const prev = this.status;
    this.status = new Map();
    for (const s of specs) {
      const old = prev.get(s.cacheKey);
      if (old) {
        if (old.phase === "error") {
          old.phase = "baking";
          this.deps.onStatus?.(s.cacheKey, { ...old });
        }
        this.status.set(s.cacheKey, old);
      } else {
        const st: BakeStatus = { phase: "baking", done: 0, total: s.contentDurationFrames };
        this.status.set(s.cacheKey, st);
        this.deps.onStatus?.(s.cacheKey, { ...st });
      }
    }
  }

  /// A frame completed (persisted or already-on-disk). Advance done; flip to
  /// ready when complete. Count successes even after another frame failed, so
  /// a retry only needs the missing frames. A ready content must stay put.
  private bump(cacheKey: string, frame: number): void {
    const st = this.status.get(cacheKey);
    if (!st || st.phase === "ready") return;
    let frames = this.completed.get(cacheKey);
    if (!frames) this.completed.set(cacheKey, frames = new Set());
    if (frames.has(frame)) return;
    frames.add(frame);
    st.done = frames.size;
    if (st.done >= st.total) st.phase = "ready";
    this.touched.add(cacheKey);
  }

  private markError(cacheKey: string): void {
    const st = this.status.get(cacheKey);
    if (!st) return;
    st.phase = "error";
    this.touched.add(cacheKey);
  }

  /// cacheKeys the GC live set must protect: every content currently targeted
  /// (queued, `specsByKey`) plus any frame writing right now (`inFlightKeys` —
  /// its spec may already be re-planned away). The Compositor unions these into
  /// `gcUnreferenced`'s live set so a hash dir the baker is writing into is
  /// never collected mid-write.
  targetCacheKeys(): string[] {
    return [...new Set([...this.specsByKey.keys(), ...this.inFlightKeys])];
  }

  dispose(): void {
    this.loop.dispose();
    this.specsByKey.clear();
    this.status.clear();
    this.completed.clear();
    this.touched.clear();
  }
}
