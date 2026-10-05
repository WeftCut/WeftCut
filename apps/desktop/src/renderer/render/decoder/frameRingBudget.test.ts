import { afterEach, expect, it } from "vitest";
import { MIB, hydratePerformanceSettings } from "../../../shared/performance-settings";
import {
  frameRingByteBudget, registerFrameRing, unregisterFrameRing, resetFrameRingBudgetForTest,
} from "./frameRingBudget";

afterEach(() => {
  hydratePerformanceSettings(undefined);
  resetFrameRingBudgetForTest();
});

it("redistributes a runtime target across already registered rings", () => {
  registerFrameRing();
  registerFrameRing();
  expect(frameRingByteBudget()).toBe(512 * MIB);
  hydratePerformanceSettings({ frame_ring_mib: 256 });
  expect(frameRingByteBudget()).toBe(128 * MIB);
  unregisterFrameRing();
  expect(frameRingByteBudget()).toBe(256 * MIB);
  hydratePerformanceSettings(undefined);
  expect(frameRingByteBudget()).toBe(1024 * MIB);
});
