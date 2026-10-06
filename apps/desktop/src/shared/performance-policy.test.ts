import { describe, expect, it } from 'vitest';
import { PERFORMANCE_DEFAULTS } from './performance-settings';
import { automaticPerformanceBudgets, DEFAULT_PERFORMANCE_POLICY, patchPerformancePolicy, readPerformancePolicy, resolvePerformancePolicy } from './performance-policy';
import { PLAYBACK_CALIBRATION, playbackCalibrationRecommendation } from './playback-calibration';

const test = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({ count, status: count <= 5 ? 'pass' : 'slow', reasons: [] })))!;

describe('performance intent', () => {
  it('preserves the complete shipping baseline rather than reducing it to a standard tier', () => {
    expect(resolvePerformancePolicy(DEFAULT_PERFORMANCE_POLICY, 32768).performance).toEqual(PERFORMANCE_DEFAULTS);
    expect(automaticPerformanceBudgets(32768)).toEqual({ cache_mib: 1728, gpu_buffer_mib: 416 });
    expect(automaticPerformanceBudgets()).toEqual(automaticPerformanceBudgets(NaN));
    expect(automaticPerformanceBudgets(4096)).toEqual({ cache_mib: 512, gpu_buffer_mib: 416 });
  });
  it('overrides each resource independently and restores each to automatic', () => {
    let p = patchPerformancePolicy(DEFAULT_PERFORMANCE_POLICY, { cache_mib: 2304 });
    expect(p.gpu_buffer_mib).toBeNull();
    p = patchPerformancePolicy(p, { gpu_buffer_mib: 1024 });
    p = patchPerformancePolicy(p, { cache_mib: null });
    expect(resolvePerformancePolicy(p, 32768).budgets).toEqual({ cache_mib: 1728, gpu_buffer_mib: 1024 });
  });
  it('does not infer throughput from memory or adopt an unselected test', () => {
    const p = { ...DEFAULT_PERFORMANCE_POLICY, gpu_buffer_mib: 8192 };
    expect(resolvePerformancePolicy(p, 32768, test).performance.preview_gpu_pixel_area).toBe(PERFORMANCE_DEFAULTS.preview_gpu_pixel_area);
    expect(resolvePerformancePolicy({ ...p, decode: 'tested' }, 32768, test).performance.preview_gpu_pixel_area).toBe(test.maximum.preview_gpu_pixel_area);
  });
  it('rejects invalid and ambiguous intent instead of silently clamping user values', () => {
    for (const patch of [{ cache_mib: -1 }, { gpu_buffer_mib: Infinity }, { cache_mib: undefined },
      { decode: 'fast' }, { typo: 123 }, [], null, { version: 2 }, { decoder_limit: 33 }, { decoder_limit: -1 },
      { buffer_frames: 0 }, { buffer_frames: 17 }, { buffer_frames: 1.5 }]) {
      expect(() => patchPerformancePolicy(DEFAULT_PERFORMANCE_POLICY, patch)).toThrow();
    }
    expect(readPerformancePolicy({ version: 1, decode: 'baseline' })).toBeNull();
  });
  it('scales allocation with detected capacity without claiming more decode throughput', () => {
    const result = resolvePerformancePolicy(DEFAULT_PERFORMANCE_POLICY, 65536, null, 16384);
    expect(result.budgets).toEqual({ cache_mib: 3456, gpu_buffer_mib: 2048 });
    expect(result.performance.preview_gpu_sessions).toBe(5);
    expect(automaticPerformanceBudgets(32768, null, 8192).gpu_buffer_mib).toBe(1024);
    expect(automaticPerformanceBudgets(32768, null, 256).gpu_buffer_mib).toBe(416);
    expect(automaticPerformanceBudgets(32768, null, NaN).gpu_buffer_mib).toBe(416);
  });
  it('honors manual concurrency and buffer depth without retaining the old area cap', () => {
    const policy = patchPerformancePolicy(DEFAULT_PERFORMANCE_POLICY, { decoder_limit: 12, buffer_frames: 6, gpu_buffer_mib: 4096 });
    const result = resolvePerformancePolicy(policy).performance;
    expect(result.preview_gpu_sessions).toBe(12);
    expect(result.preview_gpu_pool_slots).toBe(6);
    expect(result.preview_gpu_pixel_area).toBeGreaterThan(12 * 3840 * 2160);
    expect(result.preview_gpu_pixel_area * 4 * 6).toBeLessThanOrEqual(4096 * 1024 * 1024);
    const constrained = resolvePerformancePolicy({ ...policy, gpu_buffer_mib: 64 }).performance;
    expect(constrained.preview_gpu_pixel_area * 4 * 6).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(resolvePerformancePolicy({ ...policy, decoder_limit: 0 }).performance.preview_gpu_sessions).toBe(0);
  });
});
