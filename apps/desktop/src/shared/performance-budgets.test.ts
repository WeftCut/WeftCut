import { describe, expect, it } from 'vitest';
import { PERFORMANCE_FIELDS, PERFORMANCE_DEFAULTS, MIB, patchPerformanceSettings } from './performance-settings';
import { PLAYBACK_CALIBRATION, playbackCalibrationRecommendation } from './playback-calibration';
import { budgetsFromPerformance, readPerformanceBudgets, resolvePerformanceBudgets } from './performance-budgets';

const calibration = playbackCalibrationRecommendation(PLAYBACK_CALIBRATION.counts.map(count => ({
  count, status: count <= 5 ? 'pass' : 'slow', reasons: [],
})))!;

describe('performance budget policy', () => {
  it.each([512, 1024, 1728, 8192])('allocates exactly %s MiB and respects every runtime field range', cache => {
    const settings = resolvePerformanceBudgets({ cache_mib: cache, gpu_buffer_mib: 256 }, calibration);
    expect(settings.frame_ring_mib + settings.motif_cache_mib + settings.filmstrip_cache_mib + settings.waveform_cache_mib).toBe(cache);
    expect(patchPerformanceSettings(undefined, settings)).toEqual(settings);
    expect(settings.preview_gpu_pool_slots).toBe(3);
    expect(settings.preview_gpu_sessions).toBe(5);
    expect(settings.preview_gpu_pixel_area * 4 * 3).toBeLessThanOrEqual(256 * MIB);
    expect(settings.preview_gpu_pixel_area).toBeLessThanOrEqual(calibration.maximum.preview_gpu_pixel_area);
  });

  it('does not turn a larger memory budget into unsupported decode capacity', () => {
    const settings = resolvePerformanceBudgets({ cache_mib: 8192, gpu_buffer_mib: 8192 });
    expect(settings.preview_gpu_sessions).toBe(PERFORMANCE_DEFAULTS.preview_gpu_sessions);
    expect(settings.preview_gpu_pixel_area).toBe(PERFORMANCE_DEFAULTS.preview_gpu_pixel_area);
  });

  it('preserves the shipping cache total when adopting its budgets', () => {
    const budgets = budgetsFromPerformance(PERFORMANCE_DEFAULTS);
    expect(budgets.cache_mib).toBe(1728);
    const resolved = resolvePerformanceBudgets(budgets);
    for (const field of ['frame_ring_mib', 'motif_cache_mib', 'filmstrip_cache_mib', 'waveform_cache_mib'] as const) {
      expect(resolved[field]).toBe(PERFORMANCE_DEFAULTS[field]);
    }
  });

  it('rejects invalid intent and keeps the isolated benchmark outside user budget limits', () => {
    for (const input of [null, [], {}, { cache_mib: 512, gpu_buffer_mib: 64, extra: 1 },
      { cache_mib: 511, gpu_buffer_mib: 64 }, { cache_mib: 512, gpu_buffer_mib: NaN }]) {
      expect(readPerformanceBudgets(input)).toBeNull();
    }
    expect(PLAYBACK_CALIBRATION.performance.gpu_buffer_mib * MIB).toBeGreaterThanOrEqual(8 * 3840 * 2160 * 4 * 3);
    for (const [key, spec] of Object.entries(PERFORMANCE_FIELDS)) {
      const value = PLAYBACK_CALIBRATION.performance[key as keyof typeof PERFORMANCE_FIELDS];
      expect(value).toBeGreaterThanOrEqual(spec.min);
      expect(value).toBeLessThanOrEqual(spec.max);
    }
  });
});
