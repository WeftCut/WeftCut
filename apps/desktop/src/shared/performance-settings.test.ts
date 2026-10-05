import { describe, expect, it } from "vitest";
import {
  PERFORMANCE_DEFAULTS, PERFORMANCE_FIELDS, PERFORMANCE_KEYS,
  patchPerformanceSettings, readPerformanceSettings,
} from "./performance-settings";

describe("performance settings contract", () => {
  it("recovers old and malformed files per field", () => {
    for (const value of [undefined, null, [], "bad"]) {
      expect(readPerformanceSettings(value)).toEqual(PERFORMANCE_DEFAULTS);
    }
    expect(readPerformanceSettings({ frame_ring_mib: 256, motif_cache_mib: -1, future: 3 }))
      .toEqual({ ...PERFORMANCE_DEFAULTS, frame_ring_mib: 256 });
  });

  it("rejects unknown fields and malformed runtime patches", () => {
    for (const patch of [[], 42, "bad", { unknown: 1 }]) {
      expect(() => patchPerformanceSettings(PERFORMANCE_DEFAULTS, patch)).toThrow();
    }
  });

  it.each(PERFORMANCE_KEYS)("bounds %s and refuses non-integer/non-finite values", key => {
    const { min, max } = PERFORMANCE_FIELDS[key];
    for (const value of [min, max]) {
      expect(patchPerformanceSettings(PERFORMANCE_DEFAULTS, { [key]: value })[key]).toBe(value);
    }
    for (const value of [min - 1, max + 1, NaN, Infinity, 1.5, "3", null]) {
      expect(() => patchPerformanceSettings(PERFORMANCE_DEFAULTS, { [key]: value })).toThrow();
    }
  });

  it("merges independent patches and resets without changing the defaults", () => {
    const a = patchPerformanceSettings(undefined, { preview_gpu_sessions: 2 });
    const b = patchPerformanceSettings(a, { motif_cache_mib: 64 });
    expect(b).toEqual({ ...PERFORMANCE_DEFAULTS, preview_gpu_sessions: 2, motif_cache_mib: 64 });
    expect(patchPerformanceSettings(b, null)).toEqual(PERFORMANCE_DEFAULTS);
    expect(Object.isFrozen(b)).toBe(true);
    expect(PERFORMANCE_DEFAULTS.preview_gpu_sessions).toBe(5);
  });
});
