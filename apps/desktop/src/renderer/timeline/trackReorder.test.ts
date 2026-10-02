import { describe, expect, it } from "vitest";
import { trackPositionAtGap, trackPositionForMove } from "./trackReorder";

describe("whole-track destinations", () => {
  const ids = ["titles", "b-roll", "audio", "a-roll"];
  it("inserts above, between and below A/B, converting screen gaps to stored order", () => {
    expect(trackPositionAtGap(ids, "titles", 2)).toBe(2);
    expect(trackPositionAtGap(ids, "titles", 4)).toBe(0);
    expect(trackPositionAtGap(ids, "audio", 0)).toBe(3);
    expect(trackPositionAtGap(ids, "titles", 0)).toBeNull();
    expect(trackPositionAtGap(ids, "titles", 1)).toBeNull();
  });
  it("the four menu moves agree with dragging, including disabled edge actions", () => {
    expect(trackPositionForMove(ids, "audio", "up")).toBe(trackPositionAtGap(ids, "audio", 1));
    expect(trackPositionForMove(ids, "audio", "down")).toBe(trackPositionAtGap(ids, "audio", 4));
    expect(trackPositionForMove(ids, "audio", "top")).toBe(trackPositionAtGap(ids, "audio", 0));
    expect(trackPositionForMove(ids, "audio", "bottom")).toBe(trackPositionAtGap(ids, "audio", 4));
    expect(trackPositionForMove(ids, "titles", "up")).toBeNull();
    expect(trackPositionForMove(ids, "a-roll", "down")).toBeNull();
  });
});
