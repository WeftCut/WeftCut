import { describe, expect, it } from "vitest";
import { PERFORMANCE_DEFAULTS, PERFORMANCE_KEYS, patchPerformanceSettings, readPerformanceSettings } from "./performance-settings";
import { PERFORMANCE_PRESETS, PERFORMANCE_TIERS, performanceGroupPatch, performanceGroupTierOf, performancePresetOf } from "./performance-presets";

describe("fixed performance presets", () => {
  it("keeps the current default budget as maximum and every preset valid", () => {
    expect(PERFORMANCE_PRESETS.maximum).toEqual(PERFORMANCE_DEFAULTS);
    for (const tier of PERFORMANCE_TIERS) {
      const preset = PERFORMANCE_PRESETS[tier];
      expect(patchPerformanceSettings(undefined, preset)).toEqual(preset);
      expect(performancePresetOf(preset)).toBe(tier);
      expect(preset.preview_gpu_pool_slots).toBe(3);
    }
    for (const key of PERFORMANCE_KEYS) {
      expect(PERFORMANCE_PRESETS.less[key]).toBeLessThanOrEqual(PERFORMANCE_PRESETS.standard[key]);
      expect(PERFORMANCE_PRESETS.standard[key]).toBeLessThanOrEqual(PERFORMANCE_PRESETS.maximum[key]);
    }
  });

  it("changes one simple group without replacing another group's custom values or advanced-only slots", () => {
    const custom = { ...PERFORMANCE_DEFAULTS, preview_gpu_sessions: 7, preview_gpu_pool_slots: 6, frame_ring_mib: 1337 };
    const cache = patchPerformanceSettings(custom, performanceGroupPatch("cache", "less"));
    expect(cache.preview_gpu_sessions).toBe(7);
    expect(cache.preview_gpu_pool_slots).toBe(6);
    expect(cache.frame_ring_mib).toBe(512);
    expect(performanceGroupTierOf(cache, "cache")).toBe("less");
    expect(performanceGroupTierOf(cache, "parallel")).toBe("custom");
    expect(performancePresetOf(cache)).toBe("custom");

    const parallel = patchPerformanceSettings(custom, performanceGroupPatch("parallel", "standard"));
    expect(parallel.frame_ring_mib).toBe(1337);
    expect(parallel.preview_gpu_pool_slots).toBe(6);
    expect(parallel.preview_gpu_sessions).toBe(3);
    expect(parallel.preview_gpu_pixel_area).toBe(16_588_800);
  });

  it("a complete preset replaces every advanced edit; mixed groups remain custom", () => {
    const custom = Object.fromEntries(PERFORMANCE_KEYS.map(key => [key, PERFORMANCE_DEFAULTS[key] + 1]));
    const restored = patchPerformanceSettings(custom, PERFORMANCE_PRESETS.standard);
    expect(restored).toEqual(PERFORMANCE_PRESETS.standard);
    const mixed = patchPerformanceSettings(restored, performanceGroupPatch("parallel", "maximum"));
    expect(performancePresetOf(mixed)).toBe("custom");
    expect(performanceGroupTierOf(mixed, "cache")).toBe("standard");
    expect(performanceGroupTierOf(mixed, "parallel")).toBe("maximum");
  });

  it("recognition never rewrites saved values to fit a newer preset", () => {
    const saved = { ...PERFORMANCE_PRESETS.standard, frame_ring_mib: 700 };
    const loaded = readPerformanceSettings(JSON.parse(JSON.stringify(saved)));
    expect(performancePresetOf(loaded)).toBe("custom");
    expect(performanceGroupTierOf(loaded, "cache")).toBe("custom");
    expect(loaded).toEqual(saved);
  });
});
