import { describe, expect, it } from "vitest";
import { planPrewarmTargets, type PrewarmContent } from "./prewarmPlan";

/// Caps are BYTES (the L0 budget); `frameBytes: 1` keeps a byte cap equal to
/// a frame count so the planning math stays readable.
const content = (
  cacheKey: string,
  contentFrame: number,
  contentDurationFrames: number,
  frameBytes = 1,
): PrewarmContent => ({ cacheKey, contentFrame, contentDurationFrames, frameBytes });

describe("planPrewarmTargets", () => {
  it("warms the whole content when it fits the budget, playhead-first then forward then backfill", () => {
    const plan = planPrewarmTargets([content("a", 2, 5)], 240);
    expect(plan).toEqual([
      { cacheKey: "a", frame: 2 },
      { cacheKey: "a", frame: 3 },
      { cacheKey: "a", frame: 4 },
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
    ]);
  });
  it("windows to the per-content budget when content exceeds it (forward from current)", () => {
    const plan = planPrewarmTargets([content("a", 10, 100)], 4);
    expect(plan).toEqual([
      { cacheKey: "a", frame: 10 },
      { cacheKey: "a", frame: 11 },
      { cacheKey: "a", frame: 12 },
      { cacheKey: "a", frame: 13 },
    ]);
  });
  it("splits the budget across contents and round-robins (union <= cap)", () => {
    const plan = planPrewarmTargets(
      [content("a", 0, 100), content("b", 0, 100)],
      4,
    );
    expect(plan).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "b", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "b", frame: 1 },
    ]);
    expect(plan.length).toBeLessThanOrEqual(4);
  });
  it("scales the warm window by the content's real frame cost (bytes)", () => {
    // 48-byte budget over 2 contents: a 4-byte frame warms 6 deep, a 12-byte
    // frame only 2 — same memory share, different frame counts.
    const plan = planPrewarmTargets(
      [content("small", 0, 100, 4), content("big", 0, 100, 12)],
      48,
    );
    expect(plan).toEqual([
      { cacheKey: "small", frame: 0 },
      { cacheKey: "big", frame: 0 },
      { cacheKey: "small", frame: 1 },
      { cacheKey: "big", frame: 1 },
      { cacheKey: "small", frame: 2 },
      { cacheKey: "small", frame: 3 },
      { cacheKey: "small", frame: 4 },
      { cacheKey: "small", frame: 5 },
    ]);
  });
  it("dedups contents by cacheKey", () => {
    const plan = planPrewarmTargets(
      [content("a", 0, 3), content("a", 0, 3)],
      240,
    );
    expect(plan).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "a", frame: 2 },
    ]);
  });
  it("returns [] for no contents", () => {
    expect(planPrewarmTargets([], 240)).toEqual([]);
  });
});
