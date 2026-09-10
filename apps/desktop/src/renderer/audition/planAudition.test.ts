// What the audition plays, as arithmetic. Every case here is a rule the ear
// would otherwise have to catch: an excerpt that starts in the wrong place, one
// that drops the join it exists to demonstrate, or one that plays the pause it
// is about to remove.

import { describe, expect, it } from "vitest";

import { planAudition } from "./planAudition";

/// A trimmed clip: `srcInUs` is not zero, so every assertion below is about the
/// SOURCE axis and not about a timeline offset that happens to match it.
const CLIP = { tStartUs: 10_000_000, tEndUs: 40_000_000, srcInUs: 2_000_000 };

/// Timeline → source, the mapping the plan applies.
const src = (tUs: number): number => tUs - CLIP.tStartUs + CLIP.srcInUs;

/// Four evenly spaced 2 s pauses inside the clip.
const PAUSES = [
  { t_start_us: 14_000_000, t_end_us: 16_000_000 },
  { t_start_us: 20_000_000, t_end_us: 22_000_000 },
  { t_start_us: 26_000_000, t_end_us: 28_000_000 },
  { t_start_us: 32_000_000, t_end_us: 34_000_000 },
];

const PAD = 100_000;

describe("planAudition anchoring", () => {
  // The playhead says where the user is looking, so the excerpt starts there.
  it("starts at the first join at or after the playhead", () => {
    const plan = planAudition(PAUSES, PAD, CLIP, 23_000_000);
    expect(plan.joins).toEqual([2, 3]);
    expect(plan.segments[0]?.srcStartUs).toBe(src(25_100_000));
  });

  // A playhead somewhere else entirely is not a position inside this clip, so
  // the clip's own start is the honest anchor.
  it("falls back to the clip start when the playhead is outside the clip", () => {
    const plan = planAudition(PAUSES, PAD, CLIP, 5_000_000);
    expect(plan.joins).toEqual([0, 1, 2]);
  });

  it("covers at most three joins", () => {
    expect(planAudition(PAUSES, PAD, CLIP, 0).joins).toHaveLength(3);
  });

  it("covers fewer joins when the clip holds fewer pauses", () => {
    const plan = planAudition(PAUSES.slice(0, 2), PAD, CLIP, 0);
    expect(plan.joins).toEqual([0, 1]);
    // Lead, the stretch between the two joins, and tail.
    expect(plan.segments).toHaveLength(3);
  });

  // Nothing to demonstrate is still a question worth answering with sound.
  it("plays the anchor's own stretch when no join lies ahead of it", () => {
    const plan = planAudition(PAUSES, PAD, CLIP, 39_000_000);
    expect(plan.joins).toEqual([]);
    expect(plan.segments).toEqual([
      { srcStartUs: src(39_000_000), srcEndUs: src(40_000_000) },
    ]);
  });
});

describe("planAudition segments", () => {
  // The pad is the whole point of the excerpt: what plays across a join is the
  // 100 ms kept on each side, not the pause itself.
  it("ends and resumes each segment on the pad, not on the pause", () => {
    const plan = planAudition(PAUSES.slice(0, 1), PAD, CLIP, 0);
    expect(plan.segments).toEqual([
      { srcStartUs: src(13_100_000), srcEndUs: src(14_100_000) },
      { srcStartUs: src(15_900_000), srcEndUs: src(16_900_000) },
    ]);
  });

  it("gives the first and last join a second of context", () => {
    const plan = planAudition(PAUSES.slice(0, 1), PAD, CLIP, 0);
    const [lead, tail] = plan.segments;
    expect(lead!.srcEndUs - lead!.srcStartUs).toBe(1_000_000);
    expect(tail!.srcEndUs - tail!.srcStartUs).toBe(1_000_000);
  });

  // A pause at the very head keeps no pad on the side that has nothing outside
  // it, which is also the side with no context to play.
  it("keeps no lead for a pause that touches the clip head", () => {
    const plan = planAudition(
      [{ t_start_us: CLIP.tStartUs, t_end_us: 12_000_000 }],
      PAD,
      CLIP,
      0,
    );
    expect(plan.segments).toEqual([
      { srcStartUs: src(11_900_000), srcEndUs: src(12_900_000) },
    ]);
  });

  it("skips a pause whose core the pad collapses", () => {
    const plan = planAudition(
      [{ t_start_us: 14_000_000, t_end_us: 14_100_000 }, PAUSES[1]!],
      PAD,
      CLIP,
      0,
    );
    expect(plan.joins).toEqual([1]);
  });
});

describe("planAudition cap", () => {
  // Three joins six seconds apart: the material BETWEEN them is what the joins
  // are made of, so the cap comes off the two ends instead.
  it("trims the context rather than dropping a join", () => {
    const wide = [
      { t_start_us: 12_000_000, t_end_us: 14_000_000 },
      { t_start_us: 20_000_000, t_end_us: 22_000_000 },
      { t_start_us: 28_000_000, t_end_us: 30_000_000 },
    ];
    const plan = planAudition(wide, PAD, CLIP, 0, { capUs: 13_000_000 });
    expect(plan.joins).toEqual([0, 1, 2]);
    // The two stretches between the three cores: 13.9→20.1 and 21.9→28.1.
    const between = (20_100_000 - 13_900_000) + (28_100_000 - 21_900_000);
    const total = plan.segments.reduce(
      (sum, s) => sum + (s.srcEndUs - s.srcStartUs),
      0,
    );
    // Both ends trimmed to half of what the cap left over the joins' own
    // material — under the second they would otherwise get — and the total
    // lands exactly on the cap.
    expect((13_000_000 - between) / 2).toBeLessThan(1_000_000);
    expect(total).toBe(13_000_000);
  });

  // The joins survive a cap they cannot fit under. An excerpt that dropped one
  // to obey the ceiling would answer a question nobody asked.
  it("keeps every chosen join even when their own material exceeds the cap", () => {
    const wide = [
      { t_start_us: 12_000_000, t_end_us: 13_000_000 },
      { t_start_us: 38_000_000, t_end_us: 39_000_000 },
    ];
    const plan = planAudition(wide, PAD, CLIP, 0, { capUs: 5_000_000 });
    expect(plan.joins).toEqual([0, 1]);
    // No lead and no tail: the cap is already spent on the stretch between.
    expect(plan.segments).toEqual([
      { srcStartUs: src(12_900_000), srcEndUs: src(38_100_000) },
    ]);
  });
});
