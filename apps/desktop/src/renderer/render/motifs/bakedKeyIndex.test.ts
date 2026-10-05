import { describe, expect, it } from "vitest";
import { BakedKeyIndex } from "./bakedKeyIndex";

describe("BakedKeyIndex", () => {
  it("distinguishes saved frames, known holes and unknown coverage", () => {
    const idx = new BakedKeyIndex();
    expect(idx.hasFrame("a", 0)).toBe(false);
    idx.add("a");
    expect(idx.hasFrame("a", 0)).toBeUndefined();
    idx.add("a", 2);
    expect(idx.hasFrame("a", 2)).toBe(true);
    expect(idx.hasFrame("a", 0)).toBeUndefined();
    idx.restoreFrames("a", new Set([0, 1]));
    expect(idx.hasFrame("a", 3)).toBe(false);
    idx.forgetFrame("a", 1);
    expect(idx.hasFrame("a", 1)).toBe(false);
    expect(idx.isComplete("a", 3)).toBe(false);
    idx.add("a", 1);
    expect(idx.isComplete("a", 3)).toBe(true);
  });
  it("add / has by cacheKey", () => {
    const idx = new BakedKeyIndex();
    expect(idx.has("a")).toBe(false);
    idx.add("a");
    expect(idx.has("a")).toBe(true);
  });

  it("hydrate keeps only live keys whose hash is on disk", () => {
    const idx = new BakedKeyIndex();
    idx.setLiveCandidates(["live", "stale"]);
    idx.hydrateFromHashes(new Set(["deadbeef"]), (k) => (k === "live" ? "deadbeef" : "00000000"));
    expect(idx.has("live")).toBe(true);
    expect(idx.has("stale")).toBe(false);
  });

  it("clear empties the set", () => {
    const idx = new BakedKeyIndex();
    idx.add("a");
    idx.clear();
    expect(idx.has("a")).toBe(false);
  });

  it("distinguishes a directory, interrupted coverage and a complete sequence", () => {
    const idx = new BakedKeyIndex();
    idx.add("a");
    expect(idx.isComplete("a", 3)).toBe(false);
    idx.restoreFrames("a", new Set([0, 2, 3]));
    expect(idx.isComplete("a", 3)).toBe(false);
    idx.add("a", 1);
    expect(idx.isComplete("a", 3)).toBe(true);
    idx.clear();
    expect(idx.framesFor("a")).toBeUndefined();
    expect(idx.isComplete("a", 3)).toBe(false);
  });

  it("forgets coverage for directories that GC removed before an undo", () => {
    const idx = new BakedKeyIndex();
    idx.restoreFrames("a", new Set([0, 1]));
    idx.setLiveCandidates(["a"]);
    idx.hydrateFromHashes(new Set());
    expect(idx.framesFor("a")).toBeUndefined();
    expect(idx.isComplete("a", 2)).toBe(false);
  });

  it("a concurrent write does not turn unknown coverage into a scanned inventory", () => {
    const idx = new BakedKeyIndex();
    idx.add("a", 2);
    expect(idx.framesFor("a")).toBeUndefined();
    idx.restoreFrames("a", new Set([0, 1]));
    expect(idx.framesFor("a")).toEqual(new Set([0, 1, 2]));
    expect(idx.isComplete("a", 3)).toBe(true);
  });
});
