import { describe, expect, it } from "vitest";

import {
  compUsFromPx,
  compUsFromSourceUs,
  pxFromCompUs,
  regionVisibility,
  resolveHandleDrag,
  resolveRegionDrag,
  sourceUsFromCompUs,
  type RegionPxContext,
  type RegionSourceMap,
} from "./audioRegionGeometry";

/// 100 px/s, so one pixel is a round 10 ms and every expectation below is exact.
/// The block starts 200 px into the axis and plays from 1 s of the composition,
/// so neither origin can be mistaken for the other's.
const PX: RegionPxContext = { pxPerSec: 100, blockLeftPx: 200, tStartUs: 1_000_000 };

/// The clip plays its media from 3 s, so a composition time and its source time
/// are never the same number.
const MAP: RegionSourceMap = { tStartUs: 1_000_000, srcInUs: 3_000_000 };

/// The clip under every drag case: 1 s → 5 s, four seconds of room around the
/// 0.25 s minimum the filter needs.
const CLIP = { tStartUs: 1_000_000, tEndUs: 5_000_000, minUs: 250_000 };

describe("audioRegionGeometry px↔µs", () => {
  it("reads the block's own origin, not the axis's", () => {
    expect(compUsFromPx(200, PX)).toBe(1_000_000);
    expect(compUsFromPx(300, PX)).toBe(2_000_000);
    expect(pxFromCompUs(1_000_000, PX)).toBe(200);
    expect(pxFromCompUs(2_000_000, PX)).toBe(300);
  });

  it("round-trips both ways", () => {
    expect(pxFromCompUs(compUsFromPx(437, PX), PX)).toBeCloseTo(437, 6);
    expect(compUsFromPx(pxFromCompUs(2_345_600, PX), PX)).toBeCloseTo(2_345_600, 3);
  });

  // A lane collapsed to zero zoom has no time under a pixel; an infinity here
  // would reach the commit as a region bound.
  it("answers the clip's start on a collapsed axis", () => {
    expect(compUsFromPx(9_999, { ...PX, pxPerSec: 0 })).toBe(1_000_000);
  });
});

describe("audioRegionGeometry source↔composition", () => {
  it("round-trips a bound through both axes", () => {
    expect(sourceUsFromCompUs(1_500_000, MAP)).toBe(3_500_000);
    expect(compUsFromSourceUs(3_500_000, MAP)).toBe(1_500_000);
    expect(sourceUsFromCompUs(compUsFromSourceUs(4_200_000, MAP), MAP)).toBe(4_200_000);
  });
});

describe("resolveRegionDrag", () => {
  it("orders the two ends, whichever way the pointer went", () => {
    const leftToRight = resolveRegionDrag({
      ...CLIP,
      pressUs: 1_500_000,
      releaseUs: 2_500_000,
    });
    const rightToLeft = resolveRegionDrag({
      ...CLIP,
      pressUs: 2_500_000,
      releaseUs: 1_500_000,
    });
    expect(leftToRight).toEqual({ inUs: 1_500_000, outUs: 2_500_000 });
    expect(rightToLeft).toEqual(leftToRight);
  });

  it("holds both ends inside the clip", () => {
    expect(resolveRegionDrag({ ...CLIP, pressUs: -9_000_000, releaseUs: 9_000_000 })).toEqual({
      inUs: 1_000_000,
      outUs: 5_000_000,
    });
  });

  // The press is the anchor, so the short-drag expansion follows the pointer's
  // direction — and at the clip's tail that is the only direction with room.
  it("expands a too-short drag away from the press", () => {
    expect(resolveRegionDrag({ ...CLIP, pressUs: 1_500_000, releaseUs: 1_550_000 })).toEqual({
      inUs: 1_500_000,
      outUs: 1_750_000,
    });
    expect(resolveRegionDrag({ ...CLIP, pressUs: 2_000_000, releaseUs: 1_950_000 })).toEqual({
      inUs: 1_750_000,
      outUs: 2_000_000,
    });
  });

  it("expands leftwards from a press at the clip's end", () => {
    expect(resolveRegionDrag({ ...CLIP, pressUs: 5_000_000, releaseUs: 4_950_000 })).toEqual({
      inUs: 4_750_000,
      outUs: 5_000_000,
    });
    // A click with no travel reads as a drag to the right, which has nowhere to
    // go here — the window slides back inside whole.
    expect(resolveRegionDrag({ ...CLIP, pressUs: 5_000_000, releaseUs: 5_000_000 })).toEqual({
      inUs: 4_750_000,
      outUs: 5_000_000,
    });
  });

  it("expands rightwards from a press at the clip's start", () => {
    expect(resolveRegionDrag({ ...CLIP, pressUs: 1_000_000, releaseUs: 1_000_000 })).toEqual({
      inUs: 1_000_000,
      outUs: 1_250_000,
    });
  });

  // Whole µs out, whatever the pointer's fractional position, so the expansion
  // can never land a microsecond short of the minimum.
  it("rounds the pointer's own µs before expanding", () => {
    expect(
      resolveRegionDrag({ ...CLIP, pressUs: 1_500_000.4, releaseUs: 1_500_100.6 }),
    ).toEqual({ inUs: 1_500_000, outUs: 1_750_000 });
  });

  it("fills a clip exactly as long as the minimum", () => {
    expect(
      resolveRegionDrag({ tStartUs: 0, tEndUs: 250_000, minUs: 250_000, pressUs: 125_000, releaseUs: 125_000 }),
    ).toEqual({ inUs: 0, outUs: 250_000 });
  });

  // The arm button is disabled on a clip this short, but a clip trimmed short
  // after arming still reaches the release.
  it("produces nothing on a clip shorter than the minimum", () => {
    expect(
      resolveRegionDrag({ tStartUs: 0, tEndUs: 200_000, minUs: 250_000, pressUs: 0, releaseUs: 200_000 }),
    ).toBeNull();
  });
});

describe("resolveHandleDrag", () => {
  it("stops the in bound a whole minimum short of the out bound", () => {
    expect(
      resolveHandleDrag({ ...CLIP, bound: "in", newUs: 2_400_000, otherUs: 2_500_000 }),
    ).toBe(2_250_000);
    expect(
      resolveHandleDrag({ ...CLIP, bound: "in", newUs: 1_800_000, otherUs: 2_500_000 }),
    ).toBe(1_800_000);
  });

  it("stops the out bound a whole minimum past the in bound", () => {
    expect(
      resolveHandleDrag({ ...CLIP, bound: "out", newUs: 1_600_000, otherUs: 1_500_000 }),
    ).toBe(1_750_000);
    expect(
      resolveHandleDrag({ ...CLIP, bound: "out", newUs: 3_000_000, otherUs: 1_500_000 }),
    ).toBe(3_000_000);
  });

  it("keeps both bounds inside the clip", () => {
    expect(
      resolveHandleDrag({ ...CLIP, bound: "in", newUs: -9_000_000, otherUs: 2_500_000 }),
    ).toBe(1_000_000);
    expect(
      resolveHandleDrag({ ...CLIP, bound: "out", newUs: 9_000_000, otherUs: 1_500_000 }),
    ).toBe(5_000_000);
  });

  // The bound the user is not touching cannot be moved from here, so a region
  // already crowding an edge gives the clip the last word.
  it("prefers the clip's edge when the minimum cannot be honoured", () => {
    expect(
      resolveHandleDrag({ ...CLIP, bound: "in", newUs: 1_050_000, otherUs: 1_100_000 }),
    ).toBe(1_000_000);
  });
});

describe("regionVisibility", () => {
  const WINDOW = { visibleLoUs: 3_000_000, visibleHiUs: 7_000_000 };

  it("reports a region wholly inside the window", () => {
    expect(regionVisibility({ ...WINDOW, inUs: 4_000_000, outUs: 5_000_000 })).toBe("visible");
  });

  it("reports a region hanging over either edge", () => {
    expect(regionVisibility({ ...WINDOW, inUs: 2_000_000, outUs: 4_000_000 })).toBe("clipped");
    expect(regionVisibility({ ...WINDOW, inUs: 6_000_000, outUs: 8_000_000 })).toBe("clipped");
    expect(regionVisibility({ ...WINDOW, inUs: 1_000_000, outUs: 9_000_000 })).toBe("clipped");
  });

  // Touching an edge is not showing: a region that ends exactly where the window
  // begins has no pixel inside it.
  it("reports a region the window has left behind", () => {
    expect(regionVisibility({ ...WINDOW, inUs: 1_000_000, outUs: 3_000_000 })).toBe("offscreen");
    expect(regionVisibility({ ...WINDOW, inUs: 7_000_000, outUs: 8_000_000 })).toBe("offscreen");
  });
});
