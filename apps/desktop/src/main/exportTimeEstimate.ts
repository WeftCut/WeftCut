/** A bounded rolling average of actual render progress, not media fps or an
 * encoder's burst speed. Preparation and finalization are timed separately.
 * The clock is supplied by main (monotonic performance.now()). */
export class ExportTimeEstimate {
  private samples: Array<{ at: number; progress: number }>;
  private advancedAt: number;
  private progress = 0;

  constructor(private readonly startedAt: number) {
    this.samples = [{ at: startedAt, progress: 0 }];
    this.advancedAt = startedAt;
  }

  observe(progress: number, now: number) {
    if (!Number.isFinite(progress) || now < this.samples.at(-1)!.at) return;
    // Duplicate or out-of-order IPC updates cannot rewind an estimate.
    if (progress <= this.progress) return;
    this.progress = Math.min(1, progress);
    this.advancedAt = now;
    const last = this.samples.at(-1)!;
    // At most one retained sample per second, even with per-frame progress.
    if (this.samples.length > 1 && Math.floor((now - this.startedAt) / 1_000)
      === Math.floor((last.at - this.startedAt) / 1_000)) {
      this.samples[this.samples.length - 1] = { at: now, progress: this.progress };
    } else {
      this.samples.push({ at: now, progress: this.progress });
    }
    // Keep the sample immediately before the window as an interpolation anchor.
    while (this.samples.length > 2 && this.samples[1]!.at <= now - 60_000) this.samples.shift();
  }

  snapshot(now: number) {
    const elapsed_ms = Math.max(0, now - this.startedAt);
    const first = this.samples[0]!;
    const span = now - first.at;
    const advanced = this.progress - first.progress;
    // Do not promise a zero-second export: flushing/audio/mux still follow.
    // A stall invalidates the estimate rather than leaving a stale countdown.
    const remaining = elapsed_ms >= 5_000 && advanced > 0 && span > 0
      && this.progress < 1 && now - this.advancedAt < 30_000
      ? (1 - this.progress) * span / advanced : null;
    return {
      render_elapsed_ms: elapsed_ms,
      estimated_remaining_ms: remaining !== null && Number.isFinite(remaining) ? remaining : null,
    };
  }
}
