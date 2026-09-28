import { planPrewarmTargets, type PrewarmContent, type PrewarmTarget } from "./prewarmPlan";
import { IdleBatchQueue } from "./idleBatchQueue";

/// One active motif content the prewarmer can rasterize. The planning fields
/// (cacheKey, contentFrame, contentDurationFrames) come from
/// `motifFrameDescriptor`; `render(frame)` rasters an arbitrary content frame
/// of this content.
export interface PrewarmContentSpec extends PrewarmContent {
  render: (frame: number) => Promise<ImageBitmap>;
}

export interface MotifPrewarmerDeps {
  /// Warm budget in BYTES, shared across all active contents; the planner
  /// divides it by each content's `frameBytes`. Sourced from the L0 cache's
  /// byte budget so the plan fits. `prioritizeFrames` makes the cache prefer
  /// that window over past frames which playback has recently touched.
  capBytes: number;
  hasFrame: (cacheKey: string, frame: number) => boolean;
  setFrame: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  /// Refresh retention priority of cached targets, highest-priority first.
  /// No bitmap ownership transfer and no change to the cache's byte budget.
  prioritizeFrames: (targets: readonly PrewarmTarget[]) => void;
  /// Schedule a callback for "later" (idle). Returns a cancel token. Real impl:
  /// requestIdleCallback with a setTimeout fallback. Tests inject a manual one.
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// Max frames to raster per scheduled batch before yielding. Keeps the loop
  /// off the play tick's back.
  batchSize?: number;
  /// Fired after each drained batch so a watcher can recompute cache coverage
  /// (the prewarmer doesn't own status — the Compositor reads L0 coverage).
  /// Never throws. Optional so existing callers/tests don't need it.
  onProgress?: () => void;
}

/// A queued target resolved to its spec at pull time (see `take`).
interface PrewarmBatchItem extends PrewarmTarget {
  spec: PrewarmContentSpec;
}

/// Budget-paced background filler. `setTargets` (re)plans; the shared
/// `IdleBatchQueue` loop rasters missing frames in priority order until the
/// plan is fully cached, yielding between batches. Never owns bitmaps (the
/// cache does). Preview-only.
export class MotifPrewarmer {
  private specsByKey = new Map<string, PrewarmContentSpec>();
  private targetFrames = new Map<string, Set<number>>();
  private readonly loop: IdleBatchQueue<PrewarmTarget, PrewarmBatchItem>;

  constructor(private readonly deps: MotifPrewarmerDeps) {
    this.loop = new IdleBatchQueue<PrewarmTarget, PrewarmBatchItem>({
      schedule: deps.schedule,
      cancel: deps.cancel,
      batchSize: deps.batchSize ?? 3,
      take: (target) => {
        if (this.deps.hasFrame(target.cacheKey, target.frame)) return null; // already cached
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) return null; // content no longer active
        return { ...target, spec };
      },
      run: async ({ cacheKey, frame, spec }) => {
        const bmp = await spec.render(frame);
        if (this.loop.isDisposed() || !this.targetFrames.get(cacheKey)?.has(frame)) {
          // A seek/re-plan can retire this request while it is in flight.
          // Do not let an obsolete result evict the new window's frames.
          bmp.close();
          return;
        }
        this.deps.setFrame(cacheKey, frame, bmp);
      },
      onBatchDone: () => {
        if (!this.loop.isDisposed()) this.deps.onProgress?.();
      },
    });
  }

  /// Replace the active contents (deduped by cacheKey by the planner) and the
  /// playhead-relative plan, then (re)arm the loop.
  setTargets(specs: PrewarmContentSpec[]): void {
    if (this.loop.isDisposed()) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    const targets = planPrewarmTargets(specs, this.deps.capBytes);
    this.targetFrames.clear();
    for (const { cacheKey, frame } of targets) {
      let frames = this.targetFrames.get(cacheKey);
      if (!frames) this.targetFrames.set(cacheKey, frames = new Set());
      frames.add(frame);
    }
    this.deps.prioritizeFrames(targets);
    this.loop.setQueue(targets);
  }

  dispose(): void {
    this.loop.dispose();
    this.specsByKey.clear();
    this.targetFrames.clear();
  }
}
