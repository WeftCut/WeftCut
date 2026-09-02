import { describe, expect, it } from "vitest";

import { segmentsForSpan } from "./segmentsForSpan";
import type { DescSegment } from "../ipc";

function seg(
  tStartUs: number,
  tEndUs: number,
  text: string,
  tags: string[] = [],
): DescSegment {
  return { t_start_us: tStartUs, t_end_us: tEndUs, text, tags };
}

describe("segmentsForSpan", () => {
  it("returns nothing when the source has no description at all", () => {
    expect(segmentsForSpan(null, 0, 2_000_000)).toEqual([]);
    expect(segmentsForSpan([], 0, 2_000_000)).toEqual([]);
  });

  it("returns nothing for a shot the described ranges never reached", () => {
    const segments = [seg(0, 2_000_000, "a hallway")];
    expect(segmentsForSpan(segments, 4_000_000, 6_000_000)).toEqual([]);
  });

  // The acceptance: a segment the model sampled ACROSS a detected boundary
  // belongs to both shots. Dropping it, or clipping its prose to a row edge,
  // would hide the disagreement between the model and the detector that this
  // column exists to show.
  it("puts a straddling segment on both shots", () => {
    const straddler = seg(1_500_000, 2_500_000, "she turns to the window");
    const segments = [straddler];
    expect(segmentsForSpan(segments, 0, 2_000_000)).toEqual([straddler]);
    expect(segmentsForSpan(segments, 2_000_000, 4_000_000)).toEqual([straddler]);
  });

  // Half-open on both sides, the predicate Rust's `segments_in` uses: a segment
  // that merely meets an edge belongs to the row it lies inside, not to its
  // neighbour.
  it("does not spill a segment onto the row it only touches", () => {
    const segments = [seg(0, 2_000_000, "a hallway")];
    expect(segmentsForSpan(segments, 2_000_000, 4_000_000)).toEqual([]);
    expect(segmentsForSpan(segments, 0, 2_000_000)).toHaveLength(1);
  });

  it("orders several overlapping segments by start", () => {
    const segments = [
      seg(3_000_000, 4_000_000, "third"),
      seg(1_000_000, 2_000_000, "first"),
      seg(2_000_000, 3_000_000, "second"),
    ];
    expect(
      segmentsForSpan(segments, 0, 6_000_000).map((s) => s.text),
    ).toEqual(["first", "second", "third"]);
  });

  it("carries the tags through untouched", () => {
    const segments = [seg(0, 2_000_000, "a hallway", ["interior", "wide"])];
    expect(segmentsForSpan(segments, 0, 2_000_000)[0]?.tags).toEqual([
      "interior",
      "wide",
    ]);
  });

  // `sort` mutates in place, and the array it is handed is the store's own.
  it("leaves the input array's order alone", () => {
    const segments = [
      seg(3_000_000, 4_000_000, "third"),
      seg(1_000_000, 2_000_000, "first"),
    ];
    segmentsForSpan(segments, 0, 6_000_000);
    expect(segments.map((s) => s.text)).toEqual(["third", "first"]);
  });
});
