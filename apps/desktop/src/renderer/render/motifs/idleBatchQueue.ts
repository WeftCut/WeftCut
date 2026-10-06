// The idle-loop skeleton used by MotifBaker: a target
// queue drained with bounded concurrency on scheduled (idle) callbacks.
// The owner injects the pull-time mapping (`take`) and the per-item async
// work (`run`); this class owns only the loop discipline:
//
//   - never arm with an empty queue (an idle loop must not spin);
//   - replenish free slots without waiting for the slowest sibling;
//   - cancel the pending callback on dispose;
//   - a frame's failure is caught per item — it never escapes the batch.

export interface IdleBatchQueueDeps<T, I> {
  /// Schedule a callback for "later" (idle). Returns a cancel token.
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// Max items in flight; refill free slots on the next idle callback.
  batchSize: number | (() => number);
  /// Map a queued target to its batch item at PULL time — so a mid-batch
  /// re-plan can't swap the owner's spec out from under an in-flight item —
  /// or return null to drop the target (already-cached / content no longer
  /// active). Sync by design: an async skip check belongs inside `run`.
  take: (target: T) => I | null;
  /// Per-item async work. A throw is caught per item — it never escapes the
  /// batch. After each await, check `isDisposed()` and close any bitmap that
  /// can no longer be delivered.
  run: (item: I) => Promise<void>;
  /// Fired once after each drained batch settles — even an empty one, and
  /// even when disposed mid-batch (an owner that cares checks `isDisposed()`
  /// itself). Contract: never throws.
  onBatchDone?: () => void;
}

export class IdleBatchQueue<T, I> {
  private queue: T[] = [];
  private scheduled: number | null = null;
  private running = 0;
  private disposed = false;

  constructor(private readonly deps: IdleBatchQueueDeps<T, I>) {}

  isDisposed(): boolean {
    return this.disposed;
  }
  wake(): void { this.arm(); }

  /// Replace the queued targets, then (re)arm the loop. No-op once disposed.
  setQueue(targets: T[]): void {
    if (this.disposed) return;
    this.queue = targets;
    this.arm();
  }

  private arm(): void {
    if (this.disposed || this.running >= this.limit() || this.scheduled != null) return;
    if (this.queue.length === 0) return;
    this.scheduled = this.deps.schedule(() => {
      this.scheduled = null;
      void this.drainBatch();
    });
  }

  private limit(): number {
    return typeof this.deps.batchSize === "function" ? this.deps.batchSize() : this.deps.batchSize;
  }

  private async drainBatch(): Promise<void> {
    if (this.disposed) return;
    try {
      // Pull up to batchSize FRESH items (`take` drops stale/cached targets),
      // then run them CONCURRENTLY. Renders serialize through the per-motif
      // harness (microtask-serialized — safe), but async work parallelizes
      // across the RasterPool, so the loop fills at pool speed instead of 1x.
      const batch: I[] = [];
      const batchSize = Math.max(0, this.limit() - this.running);
      while (batch.length < batchSize && this.queue.length > 0) {
        const item = this.deps.take(this.queue.shift()!);
        if (item !== null) batch.push(item);
      }
      this.running += batch.length;
      await Promise.all(
        batch.map(async (item) => {
          try {
            await this.deps.run(item);
          } catch {
            // A frame's work failed (e.g. raster/persist on a disposed pool)
            // — drop it, keep going. One bad frame never kills the loop.
          } finally {
            this.running--;
            this.arm();
          }
        }),
      );
    } finally {
      this.deps.onBatchDone?.();
      this.arm(); // more queued? reschedule. else idle.
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled != null) {
      this.deps.cancel(this.scheduled);
      this.scheduled = null;
    }
    this.queue = [];
  }
}
