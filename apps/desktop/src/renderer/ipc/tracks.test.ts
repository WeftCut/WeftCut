import { describe, expect, it } from "vitest";
import { trackStatic, type AnimTrack } from "./index";

describe("trackStatic", () => {
  it("returns the static value", () => {
    expect(trackStatic({ mode: "Static", value: 0.5 }, 1)).toBe(0.5);
  });
  it("returns the first keyframe value when keyframes exist", () => {
    const t: AnimTrack<number> = {
      mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
      value: [
        { id: "k1", t_us: 5, value: 0.25, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
        { id: "k2", t_us: 9, value: 0.75, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
      ],
    };
    expect(trackStatic(t, 1)).toBe(0.25);
  });
  it("falls back on empty keyframes", () => {
    expect(trackStatic({ mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [] }, 1)).toBe(1);
  });
});
