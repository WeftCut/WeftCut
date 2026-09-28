import { planBakeTargets, type BakeContent, type BakeTarget } from "./bakePlan";
import { IdleBatchQueue } from "./idleBatchQueue";

export type BakePhase = "baking" | "ready" | "error";
export interface BakeStatus { phase: BakePhase; done: number; total: number; }

/// One content the baker should persist in full. `render(frame)` rasters an
/// arbitrary content frame (the Compositor's closure → `bakeMotifFrame`, CDP).
export interface BakeContentSpec extends BakeContent {
  render: (frame: number) => Promise<ImageBitmap>;
}

export interface MotifBakerDeps {
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// True if (cacheKey, frame) PNG already on disk → skip. Consulted ONCE per
  /// frame (when the frame is pulled into a batch), so the whole bake is O(N).
  isOnDisk: (cacheKey: string, frame: number) => Promise<boolean>;
  /// Encode + write the PNG, then mark the cacheKey baked. Throws are caught.
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
  /// Per-cacheKey bake progress. total = contentDurationFrames; done counts
  /// frames persisted OR skipped-as-already-on-disk. Reset each setTargets.
  private status = new Map<string, BakeStatus>();
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
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) return null; // content no longer active
        return { ...target, spec };
      },
      run: async ({ cacheKey, frame, spec }) => {
        this.inFlightKeys.add(cacheKey);
        try {
          // The disk-skip check runs per-frame inside the batch — a skipped
          // (already-baked) frame just consumes a slot; skips are the cheap
          // case. Each frame's `isOnDisk` is consulted exactly once.
          if (await this.deps.isOnDisk(cacheKey, frame)) { this.bump(cacheKey); return; }
          const bmp = await spec.render(frame);
          if (this.loop.isDisposed()) {
            // Disposed mid-raster: this bitmap will never be persisted, so
            // close it to avoid leaking the decoded image.
            bmp.close();
            return;
          }
          await this.deps.persist(cacheKey, frame, bmp);
          this.deps.warm(cacheKey, frame, bmp);
          this.bump(cacheKey);
        } catch {
          this.markError(cacheKey);
        } finally {
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
    this.loop.setQueue(planBakeTargets(specs, () => false));
    // Preserve status across re-plans: re-calling setTargets with an unchanged
    // active set (every frame, as the playhead moves) must NOT reset a ready
    // content back to baking — that flickers the UI dot. Keep the prior status
    // object for keys still present; announce "baking" only for NEW keys.
    const prev = this.status;
    this.status = new Map();
    for (const s of specs) {
      const old = prev.get(s.cacheKey);
      if (old) {
        this.status.set(s.cacheKey, old);
      } else {
        const st: BakeStatus = { phase: "baking", done: 0, total: s.contentDurationFrames };
        this.status.set(s.cacheKey, st);
        this.deps.onStatus?.(s.cacheKey, { ...st });
      }
    }
  }

  /// A frame completed (persisted or already-on-disk). Advance done; flip to
  /// ready when complete. No-op if the content is not in the "baking" phase —
  /// a re-planned queue can re-process already-counted frames; a ready content
  /// must stay put and must not overshoot.
  private bump(cacheKey: string): void {
    const st = this.status.get(cacheKey);
    if (!st || st.phase !== "baking") return;
    st.done = Math.min(st.total, st.done + 1);
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
    this.touched.clear();
  }
}
