// The one gap rule, pinned from both sides: what a press resolves to, and what
// "still a gap" means for a span the store is holding. Hand-fed layers, no
// summary — the rule reads two fields and nothing else.
import { describe, expect, it } from "vitest";
import { gapAt, isGapOn } from "./gap";

const span = (s: number, e: number) => ({ t_start_us: s, t_end_us: e });

// A ends 2 s, B runs 4–6 s, C 6–8 s: one interior gap at [2 s, 4 s), a hard cut
// at 6 s, and the head is occupied.
const LANE = [span(0, 2_000_000), span(4_000_000, 6_000_000), span(6_000_000, 8_000_000)];

describe("gapAt", () => {
  it("resolves a press between two clips to the whole span between them", () => {
    expect(gapAt(LANE, 3_000_000)).toEqual({ s: 2_000_000, e: 4_000_000 });
  });

  it("is half-open at both ends: a press on a clip's start is on the clip, on its end is in the gap", () => {
    expect(gapAt(LANE, 4_000_000)).toBeNull();
    expect(gapAt(LANE, 2_000_000)).toEqual({ s: 2_000_000, e: 4_000_000 });
  });

  it("answers null under a clip and at a hard cut", () => {
    expect(gapAt(LANE, 1_000_000)).toBeNull();
    expect(gapAt(LANE, 6_000_000)).toBeNull();
  });

  it("treats the space before the first clip as a gap from composition time 0", () => {
    expect(gapAt([span(2_000_000, 4_000_000)], 1_000_000)).toEqual({ s: 0, e: 2_000_000 });
  });

  it("refuses trailing space, an empty lane and negative time — none has a right edge to close up to", () => {
    expect(gapAt(LANE, 9_000_000)).toBeNull();
    expect(gapAt([], 1_000_000)).toBeNull();
    expect(gapAt(LANE, -1)).toBeNull();
  });

  it("reads the gap off ALL layers on the lane, whatever their class or order", () => {
    // An audio layer under the picture on a combined row, listed out of order:
    // the gap is the span free of both.
    const combined = [span(4_000_000, 6_000_000), span(0, 1_000_000), span(0, 2_000_000)];
    expect(gapAt(combined, 3_000_000)).toEqual({ s: 2_000_000, e: 4_000_000 });
    // A picture still running over an empty audio half is not blank.
    const halfBlank = [span(0, 4_000_000), span(0, 1_000_000), span(4_000_000, 6_000_000)];
    expect(gapAt(halfBlank, 2_000_000)).toBeNull();
  });
});

describe("isGapOn", () => {
  it("accepts exactly the span gapAt answers", () => {
    expect(isGapOn(LANE, 2_000_000, 4_000_000)).toBe(true);
    expect(isGapOn([span(2_000_000, 4_000_000)], 0, 2_000_000)).toBe(true);
  });

  it("rejects a sub-span of a gap — free is not the same as being the gap", () => {
    expect(isGapOn(LANE, 2_500_000, 4_000_000)).toBe(false);
    expect(isGapOn(LANE, 2_000_000, 3_000_000)).toBe(false);
  });

  it("rejects a span a clip has moved into, and one whose edge is no longer a boundary", () => {
    const moved = [span(0, 2_000_000), span(3_000_000, 6_000_000)];
    expect(isGapOn(moved, 2_000_000, 4_000_000)).toBe(false);
    expect(isGapOn(moved, 2_000_000, 3_000_000)).toBe(true);
  });

  it("rejects trailing space and degenerate spans", () => {
    expect(isGapOn(LANE, 8_000_000, 9_000_000)).toBe(false);
    expect(isGapOn(LANE, 3_000_000, 3_000_000)).toBe(false);
    expect(isGapOn(LANE, -1, 4_000_000)).toBe(false);
  });
});
