import { MIB, PERFORMANCE_DEFAULTS, readPerformanceSettings, type PerformanceSettings } from './performance-settings';
import type { CalibrationRecommendation } from './playback-calibration';

/** User-owned budgets. Individual caches and decoder allocation are derived. */
export interface PerformanceBudgets { cache_mib: number; gpu_buffer_mib: number }
export const PERFORMANCE_BUDGET_FIELDS = {
  cache_mib: { min: 512, max: 8192 },
  gpu_buffer_mib: { min: 64, max: 8192 },
} as const;
export interface PerformanceResourceInfo {
  total_memory_mib: number;
  gpu?: PerformanceGpuHardware | null;
  gpu_buffers: { used_bytes: number; limit_bytes: number; preview_bytes: number; motif_bytes: number };
}
export interface PerformanceGpuHardware {
  name: string;
  luid: string;
  dedicatedMemoryMib: number;
  sharedMemoryMib: number;
}
// Producer fills ahead while Chromium reads one picture; a pipeline depth,
// not a hardware capability claim.
export const PREVIEW_BUFFER_FRAMES = 3;
export const REFERENCE_4K_PIXELS = 3840 * 2160;
export const REFERENCE_FRAME_BYTES = REFERENCE_4K_PIXELS * 4;
const CACHE_WEIGHTS = { frame_ring_mib: 32, motif_cache_mib: 16, filmstrip_cache_mib: 5, waveform_cache_mib: 1 } as const;
const CACHE_KEYS = Object.keys(CACHE_WEIGHTS) as (keyof typeof CACHE_WEIGHTS)[];
const roundBudget = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.ceil(value / 16) * 16));

export function readPerformanceBudgets(value: unknown): PerformanceBudgets | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !Object.hasOwn(PERFORMANCE_BUDGET_FIELDS, key))) return null;
  for (const [key, { min, max }] of Object.entries(PERFORMANCE_BUDGET_FIELDS)) {
    const number = record[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) return null;
  }
  return { cache_mib: record.cache_mib as number, gpu_buffer_mib: record.gpu_buffer_mib as number };
}

/** Preserve old preferences until the user explicitly adopts budgets. */
export function budgetsFromPerformance(value: unknown): PerformanceBudgets {
  const settings = readPerformanceSettings(value);
  return {
    cache_mib: roundBudget(CACHE_KEYS.reduce((sum, key) => sum + settings[key], 0), 512, 8192),
    gpu_buffer_mib: settings.gpu_buffer_mib,
  };
}

export function resolvePerformanceBudgets(budgets: PerformanceBudgets, calibration: CalibrationRecommendation | null = null): PerformanceSettings {
  if (!readPerformanceBudgets(budgets)) throw new Error('Invalid performance budgets');
  // Shipping retention priorities, 32:16:5:1. Assign rounding remainder to
  // video so the cache targets sum exactly to the budget. These are explicit
  // allocation priorities, not benchmark findings.
  const cache = Object.fromEntries(CACHE_KEYS.map(key => [key, Math.floor(budgets.cache_mib * CACHE_WEIGHTS[key] / 54)])) as Record<keyof typeof CACHE_WEIGHTS, number>;
  cache.frame_ring_mib += budgets.cache_mib - CACHE_KEYS.reduce((sum, key) => sum + cache[key], 0);
  const sessions = calibration?.maximum.preview_gpu_sessions ?? PERFORMANCE_DEFAULTS.preview_gpu_sessions;
  const area = calibration?.maximum.preview_gpu_pixel_area ?? PERFORMANCE_DEFAULTS.preview_gpu_pixel_area;
  return Object.freeze({
    ...PERFORMANCE_DEFAULTS, ...cache,
    gpu_buffer_mib: budgets.gpu_buffer_mib,
    preview_gpu_pool_slots: PREVIEW_BUFFER_FRAMES,
    preview_gpu_sessions: sessions,
    preview_gpu_pixel_area: Math.min(area, Math.floor(budgets.gpu_buffer_mib * MIB / (4 * PREVIEW_BUFFER_FRAMES))),
    // Three transport lanes retain up to two sets of dimensions per lane.
    motif_gpu_sessions: PERFORMANCE_DEFAULTS.motif_gpu_sessions,
    motif_gpu_mib: Math.min(PERFORMANCE_DEFAULTS.motif_gpu_mib, budgets.gpu_buffer_mib),
  });
}
