import { MIB, PERFORMANCE_DEFAULTS, PERFORMANCE_FIELDS, type PerformanceSettings } from './performance-settings';
import { budgetsFromPerformance, readPerformanceBudgets, resolvePerformanceBudgets, type PerformanceBudgets } from './performance-budgets';
import { PLAYBACK_CALIBRATION, readCalibrationRecommendation, type CalibrationRecommendation } from './playback-calibration';

/** null means automatic for this resource only. Decode throughput is independent. */
export interface PerformancePolicy {
  version: 1;
  cache_mib: number | null;
  gpu_buffer_mib: number | null;
  decode: 'baseline' | 'tested';
  decoder_limit?: number | null;
  buffer_frames?: number | null;
}
export type PerformancePolicyPatch = Partial<Omit<PerformancePolicy, 'version'>>;
export const DEFAULT_PERFORMANCE_POLICY: PerformancePolicy = Object.freeze({
  version: 1, cache_mib: null, gpu_buffer_mib: null, decode: 'baseline',
});
export const BASELINE_BUDGETS = Object.freeze(budgetsFromPerformance(PERFORMANCE_DEFAULTS));
export interface PerformanceEnvironment {
  totalMemoryMiB?: number;
  gpuMemoryMiB?: number;
  machineId?: string;
  appVersion?: string;
  now?: () => string;
}
/** A saved recommendation, not a claim that caches or every codec were tested. */
export interface PerformanceTestProfile {
  version: 1;
  protocol: number;
  saved_at: string;
  machine_id: string;
  app_version: string;
  calibration: CalibrationRecommendation;
  budgets: PerformanceBudgets;
}

export function readPerformancePolicy(value: unknown): PerformancePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as PerformancePolicy;
  if (p.version !== 1 || !['baseline', 'tested'].includes(p.decode)
    || Object.keys(p).some(key => !['version', 'cache_mib', 'gpu_buffer_mib', 'decode', 'decoder_limit', 'buffer_frames'].includes(key))) return null;
  if (!readPerformanceBudgets({ cache_mib: p.cache_mib ?? 512, gpu_buffer_mib: p.gpu_buffer_mib ?? 64 })
    || p.cache_mib === undefined || p.gpu_buffer_mib === undefined) return null;
  for (const [key, range] of Object.entries({ decoder_limit: PERFORMANCE_FIELDS.preview_gpu_sessions, buffer_frames: PERFORMANCE_FIELDS.preview_gpu_pool_slots })) {
    const value = p[key as 'decoder_limit' | 'buffer_frames'];
    if (value != null && (!Number.isSafeInteger(value) || value < range.min || value > range.max)) return null;
  }
  return { version: 1, cache_mib: p.cache_mib, gpu_buffer_mib: p.gpu_buffer_mib, decode: p.decode,
    ...(p.decoder_limit !== undefined ? { decoder_limit: p.decoder_limit } : {}),
    ...(p.buffer_frames !== undefined ? { buffer_frames: p.buffer_frames } : {}),
  };
}

export function patchPerformancePolicy(current: PerformancePolicy, patch: unknown): PerformancePolicy {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).some(key => !['cache_mib', 'gpu_buffer_mib', 'decode', 'decoder_limit', 'buffer_frames'].includes(key))) {
    throw new Error('Invalid performance policy');
  }
  const next = readPerformancePolicy({ ...current, ...patch });
  if (!next) throw new Error('Invalid performance policy');
  return next;
}

/** Capacity-based allocation heuristics, not measured throughput or optimal
 * cache sizes. Missing GPU facts preserve the shipping transport allowance. */
export function automaticPerformanceBudgets(totalMemoryMiB?: number, calibration?: CalibrationRecommendation | null, gpuMemoryMiB?: number): PerformanceBudgets {
  const retentionBaseline = totalMemoryMiB && totalMemoryMiB > 32768
    ? Math.min(8192, Math.floor(BASELINE_BUDGETS.cache_mib * totalMemoryMiB / 32768 / 16) * 16)
    : BASELINE_BUDGETS.cache_mib;
  const cache = totalMemoryMiB && Number.isFinite(totalMemoryMiB) && totalMemoryMiB > 0
    ? Math.max(512, Math.min(retentionBaseline, Math.floor(totalMemoryMiB / 8 / 16) * 16))
    : BASELINE_BUDGETS.cache_mib;
  // A transport allowance, not an application VRAM cap. Small dedicated carveouts
  // on integrated GPUs are not treated as the capacity of their shared memory.
  const capacityBudget = gpuMemoryMiB && Number.isFinite(gpuMemoryMiB) && gpuMemoryMiB > 512
    ? Math.max(64, Math.min(8192, Math.floor(gpuMemoryMiB / 8 / 16) * 16))
    : BASELINE_BUDGETS.gpu_buffer_mib;
  const gpu = calibration
    ? Math.min(8192, Math.ceil((calibration.maximum.preview_gpu_sessions * 3840 * 2160 * 4 * 3 / (1024 * 1024)
      + PERFORMANCE_DEFAULTS.motif_gpu_mib) / 16) * 16)
    : capacityBudget;
  return { cache_mib: cache, gpu_buffer_mib: gpu };
}

export function resolvePerformancePolicy(policy: PerformancePolicy, totalMemoryMiB?: number, calibration?: CalibrationRecommendation | null, gpuMemoryMiB?: number) {
  const activeTest = policy.decode === 'tested' ? calibration : null;
  const automatic = automaticPerformanceBudgets(totalMemoryMiB, activeTest, gpuMemoryMiB);
  const budgets = { cache_mib: policy.cache_mib ?? automatic.cache_mib,
    gpu_buffer_mib: policy.gpu_buffer_mib ?? automatic.gpu_buffer_mib };
  const base = resolvePerformanceBudgets(budgets, activeTest);
  const frames = policy.buffer_frames ?? base.preview_gpu_pool_slots;
  const sessions = policy.decoder_limit ?? base.preview_gpu_sessions;
  // Explicit concurrency also replaces the old fixed three-4K area guard.
  // Admission still charges actual coded dimensions and actual buffer bytes.
  const area = policy.decoder_limit != null ? PERFORMANCE_FIELDS.preview_gpu_pixel_area.max
    : activeTest?.maximum.preview_gpu_pixel_area ?? PERFORMANCE_DEFAULTS.preview_gpu_pixel_area;
  const performance: PerformanceSettings = Object.freeze({ ...base, preview_gpu_sessions: sessions,
    preview_gpu_pool_slots: frames, preview_gpu_pixel_area: Math.min(area, Math.floor(budgets.gpu_buffer_mib * MIB / (4 * frames))) });
  return { budgets, automatic, performance };
}

export function readPerformanceTestProfile(value: unknown): PerformanceTestProfile | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as PerformanceTestProfile;
  const calibration = readCalibrationRecommendation(p.calibration);
  const budgets = readPerformanceBudgets(p.budgets);
  if (p.version !== 1 || !Number.isInteger(p.protocol) || !calibration || !budgets
    || typeof p.saved_at !== 'string' || !Number.isFinite(Date.parse(p.saved_at))
    || typeof p.machine_id !== 'string' || typeof p.app_version !== 'string') return null;
  return { version: 1, protocol: p.protocol, saved_at: p.saved_at, machine_id: p.machine_id,
    app_version: p.app_version, calibration, budgets };
}

export function performanceTestMatches(profile: PerformanceTestProfile, env: PerformanceEnvironment): boolean {
  return profile.protocol === PLAYBACK_CALIBRATION.version && profile.machine_id === (env.machineId ?? '')
    && profile.app_version === (env.appVersion ?? '');
}

export function savePerformanceTestProfile(calibration: CalibrationRecommendation, cacheMiB: number, env: PerformanceEnvironment): PerformanceTestProfile {
  return { version: 1, protocol: PLAYBACK_CALIBRATION.version,
    saved_at: env.now?.() ?? new Date().toISOString(), machine_id: env.machineId ?? '', app_version: env.appVersion ?? '',
    calibration, budgets: { ...automaticPerformanceBudgets(env.totalMemoryMiB, calibration), cache_mib: cacheMiB } };
}
