import {
  PERFORMANCE_DEFAULTS, PERFORMANCE_KEYS,
  type PerformanceSettings,
} from "./performance-settings";

// Fixed resource preferences, not detected machine capacity. Persist resolved
// values only: changing this table must never rewrite an existing user's budget.
export const PERFORMANCE_TIERS = ["less", "standard", "maximum"] as const;
export type PerformanceTier = typeof PERFORMANCE_TIERS[number];
export type PerformanceChoice = PerformanceTier | "custom";

const profile = (values: Partial<PerformanceSettings>): PerformanceSettings =>
  Object.freeze({ ...PERFORMANCE_DEFAULTS, ...values });

export const PERFORMANCE_PRESETS: Readonly<Record<PerformanceTier, PerformanceSettings>> = Object.freeze({
  less: profile({
    preview_gpu_sessions: 2, preview_gpu_pixel_area: 3840 * 2160,
    frame_ring_mib: 512, motif_cache_mib: 256, motif_gpu_mib: 64,
    motif_gpu_sessions: 4, filmstrip_cache_mib: 80, waveform_cache_mib: 16,
  }),
  standard: profile({
    preview_gpu_sessions: 3, preview_gpu_pixel_area: 2 * 3840 * 2160,
    frame_ring_mib: 768, motif_cache_mib: 384, motif_gpu_mib: 96,
    motif_gpu_sessions: 6, filmstrip_cache_mib: 120, waveform_cache_mib: 24,
  }),
  maximum: profile({}),
});

export function isPerformanceTier(value: unknown): value is PerformanceTier {
  return PERFORMANCE_TIERS.some(tier => tier === value);
}

export function performancePresetOf(settings: PerformanceSettings): PerformanceChoice {
  return PERFORMANCE_TIERS.find(tier => PERFORMANCE_KEYS.every(key => settings[key] === PERFORMANCE_PRESETS[tier][key])) ?? "custom";
}
