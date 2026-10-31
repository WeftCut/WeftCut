import { describe, expect, it } from 'vitest';
import { ExportTimeEstimate } from './exportTimeEstimate';

describe('measured export encoding ETA', () => {
  it('waits for real progress and five seconds of rendering', () => {
    const timing = new ExportTimeEstimate(100_000);
    expect(timing.snapshot(105_000).estimated_remaining_ms).toBeNull();
    timing.observe(0.1, 101_000);
    expect(timing.snapshot(104_999).estimated_remaining_ms).toBeNull();
    timing.observe(0.5, 110_000);
    expect(timing.snapshot(110_000)).toEqual({ render_elapsed_ms: 10_000, estimated_remaining_ms: 10_000 });
  });

  it('adapts to recent scene complexity instead of keeping startup speed forever', () => {
    const timing = new ExportTimeEstimate(0);
    for (let second = 1; second <= 60; second++) timing.observe(second / 100, second * 1_000);
    expect(timing.snapshot(60_000).estimated_remaining_ms).toBeCloseTo(40_000);
    for (let second = 61; second <= 120; second++) timing.observe(0.6 + (second - 60) / 1_000, second * 1_000);
    expect(timing.snapshot(120_000).estimated_remaining_ms).toBeCloseTo(340_000);
  });

  it('retains a bounded rolling window even with per-frame progress updates', () => {
    const timing = new ExportTimeEstimate(0);
    for (let ms = 10; ms <= 120_000; ms += 10) {
      timing.observe(ms <= 60_000 ? ms / 100_000 : 0.6 + (ms - 60_000) / 1_000_000, ms);
    }
    // One-second buckets can straddle the scene-complexity boundary by <1s.
    expect(timing.snapshot(120_000).estimated_remaining_ms).toBeGreaterThan(339_000);
    expect(timing.snapshot(120_000).estimated_remaining_ms).toBeLessThan(341_000);
  });

  it('accounts for short waits and hides stale estimates during a stall', () => {
    const timing = new ExportTimeEstimate(0);
    timing.observe(0.25, 10_000);
    expect(timing.snapshot(10_000).estimated_remaining_ms).toBe(30_000);
    timing.observe(0.25, 20_000);
    expect(timing.snapshot(20_000).estimated_remaining_ms).toBe(60_000);
    expect(timing.snapshot(40_000).estimated_remaining_ms).toBeNull();
    timing.observe(0.5, 50_000);
    expect(timing.snapshot(50_000).estimated_remaining_ms).toBe(50_000);
  });

  it('ignores invalid or regressing progress and never estimates zero at 100%', () => {
    const timing = new ExportTimeEstimate(0);
    timing.observe(0.5, 10_000);
    for (const progress of [NaN, Infinity, -1, 0.1]) timing.observe(progress, 10_001);
    expect(timing.snapshot(10_000).estimated_remaining_ms).toBe(10_000);
    timing.observe(0.75, 9_000);
    expect(timing.snapshot(10_000).estimated_remaining_ms).toBe(10_000);
    timing.observe(2, 11_000);
    expect(timing.snapshot(11_000).estimated_remaining_ms).toBeNull();
  });
});
