import type { ClockSyncSnapshot } from "./clock";

export interface PreviewSyncSnapshot {
  clock: ClockSyncSnapshot | null;
  samples: number;
  clockSkewMs: number | null;
  videoLateMs: number | null;
  videoLeadMs: number | null;
  missingLayers: number;
  heldScenes: number;
  submitIntervalMs: { p95: number; p99: number; max: number } | null;
}

/// Submitted pictures, not scan-out or speaker measurements. All frame ranges
/// are mapped to the open composition clock before reaching this module.
/// Fixed storage; statistics sorting happens only when telemetry is polled.
export class PreviewSyncTracker {
  private intervals = new Float64Array(600);
  private count = 0;
  private previousMs: number | null = null;
  private targetUs = 0;
  private latestStartUs = -Infinity;
  private earliestEndUs = Infinity;
  private missing = 0;
  private held = 0;
  private state: Omit<PreviewSyncSnapshot, "submitIntervalMs"> = {
    clock: null, samples: 0, clockSkewMs: null, videoLateMs: null,
    videoLeadMs: null, missingLayers: 0, heldScenes: 0,
  };

  begin(targetUs: number): void {
    this.targetUs = targetUs;
    this.latestStartUs = -Infinity; this.earliestEndUs = Infinity;
    this.missing = 0; this.held = 0;
  }

  frame(startUs: number | null, endUs: number | null): void {
    if (startUs === null) { this.missing++; return; }
    this.latestStartUs = Math.max(this.latestStartUs, startUs);
    if (endUs !== null) this.earliestEndUs = Math.min(this.earliestEndUs, endUs);
  }

  hold(startUs: number | null, durationUs: number): void {
    this.held++;
    this.frame(startUs, startUs === null ? null : startUs + durationUs);
  }

  submit(nowMs: number, clock: ClockSyncSnapshot | null): void {
    if (this.previousMs !== null) {
      this.intervals[this.count++ % this.intervals.length] = Math.max(0, nowMs - this.previousMs);
    }
    this.previousMs = nowMs;
    // No estimate is fabricated when the clock is unavailable or paused.
    const outputUs = clock?.outputCompUs ?? null;
    this.state = {
      clock, samples: this.state.samples + 1,
      clockSkewMs: outputUs === null ? null : (this.targetUs - outputUs) / 1000,
      videoLateMs: outputUs === null || !Number.isFinite(this.earliestEndUs)
        ? null : Math.max(0, outputUs - this.earliestEndUs) / 1000,
      videoLeadMs: outputUs === null || !Number.isFinite(this.latestStartUs)
        ? null : Math.max(0, this.latestStartUs - outputUs) / 1000,
      missingLayers: this.missing, heldScenes: this.held,
    };
  }

  interrupt(): void { this.previousMs = null; }
  reset(): void {
    this.count = 0; this.previousMs = null;
    this.state = { clock: null, samples: 0, clockSkewMs: null, videoLateMs: null,
      videoLeadMs: null, missingLayers: 0, heldScenes: 0 };
  }
  snapshot(): PreviewSyncSnapshot {
    const sorted = this.intervals.slice(0, Math.min(this.count, this.intervals.length)).sort();
    const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
    return { ...this.state, submitIntervalMs: sorted.length === 0 ? null : {
      p95: percentile(0.95), p99: percentile(0.99), max: sorted[sorted.length - 1]!,
    } };
  }
}
