// The idle-loop skeleton shared by MotifPrewarmer and MotifBaker: a target
// queue drained in small CONCURRENT batches on scheduled (idle) callbacks.
// The owner injects the pull-time mapping (`take`) and the per-item async
// work (`run`); this class owns only the loop discipline:
//
//   - never arm with an empty queue (an idle loop must not spin);
//   - never re-arm while a batch is running or a callback is scheduled;
//   - cancel the pending callback on dispose;
//   - a frame's failure is caught per item — it never escapes the batch.

export interface IdleBatchQueueDeps<T, I> {
  /// Schedule a callback for "later" (idle). Returns a cancel token.
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// Max items pulled into one batch before yielding back to idle.
  batchSize: number;
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
  private running = false;
  private disposed = false;

  constructor(private readonly deps: IdleBatchQueueDeps<T, I>) {}

  isDisposed(): boolean {
    return this.disposed;
  }

  /// Replace the queued targets, then (re)arm the loop. No-op once disposed.
  setQueue(targets: T[]): void {
    if (this.disposed) return;
    this.queue = targets;
    this.arm();
  }

  private arm(): void {
    if (this.disposed || this.running || this.scheduled != null) return;
    if (this.queue.length === 0) return;
    this.scheduled = this.deps.schedule(() => {
      this.scheduled = null;
      void this.drainBatch();
    });
  }

  private async drainBatch(): Promise<void> {
    if (this.disposed) return;
    this.running = true;
    try {
      // Pull up to batchSize FRESH items (`take` drops stale/cached targets),
      // then run them CONCURRENTLY. Renders serialize through the per-motif
      // harness (microtask-serialized — safe), but async work parallelizes
      // across the RasterPool, so the loop fills at pool speed instead of 1x.
      const batch: I[] = [];
      while (batch.length < this.deps.batchSize && this.queue.length > 0) {
        const item = this.deps.take(this.queue.shift()!);
        if (item !== null) batch.push(item);
      }
      await Promise.all(
        batch.map(async (item) => {
          try {
            await this.deps.run(item);
          } catch {
            // A frame's work failed (e.g. raster/persist on a disposed pool)
            // — drop it, keep going. One bad frame never kills the loop.
          }
        }),
      );
    } finally {
      this.deps.onBatchDone?.();
      this.running = false;
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
