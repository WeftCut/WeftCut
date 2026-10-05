/** Machine-local resource policy. Defaults preserve the measured shipping profile.
 * Units and validation live here; consumers must read at admission/maintenance,
 * never capture these defaults at module initialization. */
export const MIB = 1024 * 1024;

export const PERFORMANCE_FIELDS = Object.freeze({
  preview_gpu_sessions: { default: 5, min: 0, max: 32, unit: "count" },
  preview_gpu_pixel_area: { default: 3 * 3840 * 2160, min: 1, max: 16 * 7680 * 4320, unit: "pixels" },
  preview_gpu_pool_slots: { default: 3, min: 1, max: 16, unit: "count" },
  frame_ring_mib: { default: 1024, min: 128, max: 8192, unit: "MiB" },
  motif_cache_mib: { default: 512, min: 16, max: 4096, unit: "MiB" },
  motif_gpu_mib: { default: 128, min: 16, max: 2048, unit: "MiB" },
  motif_gpu_sessions: { default: 8, min: 1, max: 32, unit: "count" },
  filmstrip_cache_mib: { default: 160, min: 16, max: 2048, unit: "MiB" },
  waveform_cache_mib: { default: 32, min: 4, max: 512, unit: "MiB" },
} as const);

export type PerformanceKey = keyof typeof PERFORMANCE_FIELDS;
export type PerformanceSettings = Readonly<Record<PerformanceKey, number>>;
export const PERFORMANCE_KEYS = Object.keys(PERFORMANCE_FIELDS) as PerformanceKey[];
export const PERFORMANCE_DEFAULTS: PerformanceSettings = Object.freeze(
  Object.fromEntries(PERFORMANCE_KEYS.map(key => [key, PERFORMANCE_FIELDS[key].default])),
) as PerformanceSettings;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valid(key: PerformanceKey, value: unknown): value is number {
  const { min, max } = PERFORMANCE_FIELDS[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Corrupt/old disk data recovers per field, retaining other valid choices. */
export function readPerformanceSettings(value: unknown): PerformanceSettings {
  const result = { ...PERFORMANCE_DEFAULTS };
  if (isRecord(value)) for (const key of PERFORMANCE_KEYS) {
    if (valid(key, value[key])) result[key] = value[key];
  }
  return Object.freeze(result);
}

/** Strict, atomic runtime patch. null restores the shipping defaults. */
export function patchPerformanceSettings(current: unknown, patch: unknown): PerformanceSettings {
  if (patch === null) return PERFORMANCE_DEFAULTS;
  if (!isRecord(patch)) throw new Error("performance must be an object or null");
  const result = { ...readPerformanceSettings(current) };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(PERFORMANCE_FIELDS, key)) throw new Error(`Unknown performance setting: ${key}`);
    const field = key as PerformanceKey;
    if (!valid(field, value)) {
      const { min, max } = PERFORMANCE_FIELDS[field];
      throw new Error(`performance.${key} must be an integer between ${min} and ${max}`);
    }
    result[field] = value;
  }
  return Object.freeze(result);
}

// Each process has one read-only snapshot. Only app-settings bootstrap/commit
// (main) and app-settings hydration (renderer) publish it; never persist here.
let current = PERFORMANCE_DEFAULTS;
export function performanceSettings(): PerformanceSettings { return current; }
export function hydratePerformanceSettings(value: unknown): void {
  current = readPerformanceSettings(value);
}
