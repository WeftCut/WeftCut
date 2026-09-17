// The planner's matrix: hand-built views, no actor, no project. Every case here
// is a statement about the arithmetic alone — that the hole is the footprint and
// not the length, that touching holes merge, and that each of the five refusals
// names the entity a user can act on.
//
// Times are built through `timeUsAtGridIndex` rather than multiplied out: at
// 30 fps a frame is 33333.33… µs, and a hand-written "two frames" is off grid
// often enough to make a landing assert lie about which side rounded.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  planRipple,
  planRippleGap,
  type RippleLayerView,
  type RippleMove,
  type RipplePlan,
  type RippleTrackView,
  type RippleView,
} from "./plan";
import {
  AUDIO_GRID,
  frameGrid,
  layerOverlapClass,
  snapOnGrid,
  timeUsAtGridIndex,
} from "../grid";
import type { CommandError } from "../../shared/commandErrors";

const FPS = { num: 30, den: 1 };
const FRAME = frameGrid(FPS);

/** Canonical µs of frame `i` / of second `n` / of 48 kHz sample `i`. */
const f = (i: number) => timeUsAtGridIndex(i, FRAME);
const sec = (n: number) => f(Math.round(n * 30));
const smp = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID);

function layerAt(id: string, kind: string, tStartUs: number, tEndUs: number, locked = false): RippleLayerView {
  return { id, kind, t_start_us: tStartUs, t_end_us: tEndUs, locked };
}
const vis = (id: string, a: number, b: number, locked = false) => layerAt(id, "Color", sec(a), sec(b), locked);
const aud = (id: string, a: number, b: number, locked = false) => layerAt(id, "Audio", sec(a), sec(b), locked);

function track(id: string, layers: readonly RippleLayerView[], locked = false): RippleTrackView {
  return { id, locked, layers };
}
function viewOf(
  tracks: readonly RippleTrackView[],
  extra: Partial<Pick<RippleView, "links" | "transitions">> = {},
): RippleView {
  return { fps: FPS, tracks, links: extra.links ?? [], transitions: extra.transitions ?? [] };
}

function accepted(plan: RipplePlan): { holes: { s: number; e: number }[]; moves: RippleMove[] } {
  if (!plan.ok) throw new Error(`expected an accepted plan, got ${plan.refusal.error}`);
  return plan;
}
function refused(plan: RipplePlan): CommandError {
  if (plan.ok) throw new Error(`expected a refusal, got ${plan.moves.length} moves`);
  return plan.refusal;
}
/** A move as `[layer, track, start, end]` — terser than four expectations. */
const shape = (m: RippleMove) => [m.layer, m.track, m.t_start_us, m.t_end_us];

describe("the hole is the deleted layer's own footprint", () => {
  it("pulls every downstream layer on every track left by the hole's length, and leaves upstream alone", () => {
    const view = viewOf([
      track("TV", [vis("A", 0, 2), vis("B", 2, 4), vis("C", 4, 6)]),
      track("TB", [vis("P", 0, 1), vis("Q", 5, 7)]),
      track("TA", [aud("R", 4, 6)]),
    ]);
    const plan = accepted(planRipple(view, ["B"]));
    expect(plan.holes).toEqual([{ s: sec(2), e: sec(4) }]);
    expect(plan.moves.map(shape)).toEqual([
      ["C", "TV", sec(2), sec(4)],
      ["Q", "TB", sec(3), sec(5)],
      ["R", "TA", sec(2), sec(4)],
    ]);
  });

  it("leaves a gap that already sat beside the deleted layer open — it moves left, it does not close", () => {
    // A ends at 2 s, B runs 3–5 s, C starts at 7 s: a 1 s gap before B and a 2 s
    // gap after it. Only B's own 2 s footprint goes.
    const view = viewOf([track("TV", [vis("A", 0, 2), vis("B", 3, 5), vis("C", 7, 9)])]);
    const plan = accepted(planRipple(view, ["B"]));
    expect(plan.holes).toEqual([{ s: sec(3), e: sec(5) }]);
    expect(plan.moves.map(shape)).toEqual([["C", "TV", sec(5), sec(7)]]);
  });

  it("is empty when a transition partner already covers the whole clip, so nothing moves", () => {
    // A [0,10) with B [8,10) under a 2 s transition: B's span is entirely inside
    // A's, so deleting B vacates nothing.
    const view = viewOf([track("TV", [vis("A", 0, 10), vis("B", 8, 10)])], {
      transitions: [{ from_layer: "A", to_layer: "B", duration_us: sec(2) }],
    });
    const plan = accepted(planRipple(view, ["B"]));
    expect(plan.holes).toEqual([]);
    expect(plan.moves).toEqual([]);
  });
});

describe("a transition's participants", () => {
  it("deleting the INCOMING layer closes only the span past its predecessor's tail", () => {
    // A [0,10), B [9,12) sitting 1 s left under a transition, C [12,15). Shifting
    // C by B's 3 s length would land it on A's tail; the hole is [10,12).
    const view = viewOf([track("TV", [vis("A", 0, 10), vis("B", 9, 12), vis("C", 12, 15)])], {
      transitions: [{ from_layer: "A", to_layer: "B", duration_us: sec(1) }],
    });
    const plan = accepted(planRipple(view, ["B"]));
    expect(plan.holes).toEqual([{ s: sec(10), e: sec(12) }]);
    expect(plan.moves.map(shape)).toEqual([["C", "TV", sec(10), sec(13)]]);
  });

  it("deleting the OUTGOING layer stops the hole at its successor's overlapping start", () => {
    // B [10,20) with C [19,25) overlapping it by the transition's 1 s: the hole is
    // [10,19), so C lands where B began.
    const view = viewOf([track("TV", [vis("A", 0, 10), vis("B", 10, 20), vis("C", 19, 25)])], {
      transitions: [{ from_layer: "B", to_layer: "C", duration_us: sec(1) }],
    });
    const plan = accepted(planRipple(view, ["B"]));
    expect(plan.holes).toEqual([{ s: sec(10), e: sec(19) }]);
    expect(plan.moves.map(shape)).toEqual([["C", "TV", sec(10), sec(16)]]);
  });

  it("survives a shift that moves both its participants by the same amount", () => {
    // X [0,2) deleted; P [4,8) and Q [7,10) overlap by the transition's 1 s and
    // both shift 2 s left, so the overlap is unchanged and stays authorized.
    const tracks = [track("TV", [vis("X", 0, 2), vis("P", 4, 8), vis("Q", 7, 10)])];
    const withTransition = viewOf(tracks, {
      transitions: [{ from_layer: "P", to_layer: "Q", duration_us: sec(1) }],
    });
    const plan = accepted(planRipple(withTransition, ["X"]));
    expect(plan.holes).toEqual([{ s: 0, e: sec(2) }]);
    expect(plan.moves.map(shape)).toEqual([
      ["P", "TV", sec(2), sec(6)],
      ["Q", "TV", sec(5), sec(8)],
    ]);
    // Without the transition the very same overlap is an unauthorized collision —
    // which is what proves the authorization above is doing the work.
    expect(refused(planRipple(viewOf(tracks), ["X"]))).toEqual({
      error: "RippleCollision", moving: "Q", blocking: "P", track: "TV",
    });
  });

  it("stays authorized when the shift keeps the frame count but changes the microseconds by one", () => {
    // 30 fps frames fall at 0, 33333, 66667, 100000, 133333 µs: one frame is
    // 33333 or 33334 µs depending on where it sits. X [f0,f1) deleted; P [f1,f3)
    // and Q [f2,f4) overlap by one frame = 33333 µs. Both shift one frame left
    // and still overlap by one frame — now 33334 µs. Judged against the stored
    // duration that would read as a collision; judged against the landing it
    // is the same transition, one frame to the left.
    const X = layerAt("X", "Color", f(0), f(1));
    const P = layerAt("P", "Color", f(1), f(3));
    const Q = layerAt("Q", "Color", f(2), f(4));
    const storedDuration = f(3) - f(2);
    expect(storedDuration).toBe(33333);
    const view = viewOf([track("TV", [X, P, Q])], {
      transitions: [{ from_layer: "P", to_layer: "Q", duration_us: storedDuration }],
    });
    const plan = accepted(planRipple(view, ["X"]));
    expect(plan.moves.map(shape)).toEqual([
      ["P", "TV", f(0), f(2)],
      ["Q", "TV", f(1), f(3)],
    ]);
    const landedOverlap = f(2) - f(1);
    expect(landedOverlap).toBe(33334);
    expect(landedOverlap).not.toBe(storedDuration);
  });
});

describe("a selection of more than one layer", () => {
  it("merges a linked video and audio pair into one hole, so each partner track shifts once", () => {
    const view = viewOf(
      [
        track("TV", [vis("V0", 0, 2), vis("V1", 2, 4), vis("V2", 4, 6)]),
        track("TA", [aud("A1", 2, 4), aud("A2", 4, 6)]),
      ],
      { links: [{ id: "L", members: ["V1", "A1"] }] },
    );
    const plan = accepted(planRipple(view, ["V1", "A1"]));
    expect(plan.holes).toEqual([{ s: sec(2), e: sec(4) }]);
    expect(plan.moves.map(shape)).toEqual([
      ["V2", "TV", sec(2), sec(4)],
      ["A2", "TA", sec(2), sec(4)],
    ]);
  });

  it("applies two non-adjacent holes on one track cumulatively, right to left", () => {
    const view = viewOf([
      track("TV", [vis("L0", 0, 2), vis("D1", 2, 4), vis("M", 4, 6), vis("D2", 6, 9), vis("N", 9, 11)]),
    ]);
    const plan = accepted(planRipple(view, ["D1", "D2"]));
    expect(plan.holes).toEqual([{ s: sec(2), e: sec(4) }, { s: sec(6), e: sec(9) }]);
    // M clears one hole (2 s), N clears both (5 s).
    expect(plan.moves.map(shape)).toEqual([
      ["M", "TV", sec(2), sec(4)],
      ["N", "TV", sec(4), sec(6)],
    ]);
  });

  it("deduplicates a repeated id instead of measuring its hole twice", () => {
    const view = viewOf([track("TV", [vis("A", 0, 2), vis("B", 2, 4), vis("C", 4, 6)])]);
    expect(planRipple(view, ["B", "B", "B"])).toEqual(planRipple(view, ["B"]));
  });

  it("refuses an id that names no layer in the view", () => {
    const view = viewOf([track("TV", [vis("A", 0, 2)])]);
    expect(refused(planRipple(view, ["A", "ghost"]))).toEqual({ error: "LayerNotFound", layer: "ghost" });
  });
});

describe("a layer that starts inside the span", () => {
  it("refuses and names the co-starting audio when only its linked video is deleted", () => {
    const view = viewOf(
      [
        track("TV", [vis("V0", 0, 2), vis("V1", 2, 4), vis("V2", 4, 6)]),
        track("TA", [aud("A1", 2, 4), aud("A2", 4, 6)]),
      ],
      { links: [{ id: "L", members: ["V1", "A1"] }] },
    );
    expect(refused(planRipple(view, ["V1"]))).toEqual({
      error: "RippleInsideHole", layer: "A1", hole: { s: sec(2), e: sec(4) },
    });
  });

  it("refuses a B-roll cut inside the clip, and accepts once that cut joins the selection", () => {
    const view = viewOf([
      track("TV", [vis("V1", 0, 4), vis("V2", 4, 6)]),
      track("TB", [vis("B1", 1, 3)]),
    ]);
    expect(refused(planRipple(view, ["V1"]))).toEqual({
      error: "RippleInsideHole", layer: "B1", hole: { s: 0, e: sec(4) },
    });
    // B1's own hole [1,3) merges into V1's [0,4): one ripple, one shift.
    const plan = accepted(planRipple(view, ["V1", "B1"]));
    expect(plan.holes).toEqual([{ s: 0, e: sec(4) }]);
    expect(plan.moves.map(shape)).toEqual([["V2", "TV", 0, sec(2)]]);
  });
});

describe("a layer at the origin", () => {
  // Time 0 is a boundary nothing crosses, so a layer starting there is anchored
  // ahead of any cut that also starts there: it stays, and what closes up lands
  // beneath it. Before this rule a title at 0 refused every leading-pause cut.
  it("stays put when the hole starts at 0, and everything behind the hole closes up under it", () => {
    const view = viewOf([
      track("TV", [vis("V1", 0, 4), vis("V2", 4, 6)]),
      track("TB", [vis("T0", 0, 1)]),
    ]);
    const plan = accepted(planRipple(view, ["V1"]));
    expect(plan.holes).toEqual([{ s: 0, e: sec(4) }]);
    expect(plan.moves.map(shape)).toEqual([["V2", "TV", 0, sec(2)]]);
  });

  it("is still named when it is the linked partner of what is being deleted", () => {
    const view = viewOf(
      [
        track("TV", [vis("V1", 0, 4), vis("V2", 4, 6)]),
        track("TA", [aud("A1", 0, 4), aud("A2", 4, 6)]),
      ],
      { links: [{ id: "L", members: ["V1", "A1"] }] },
    );
    expect(refused(planRipple(view, ["V1"]))).toEqual({
      error: "RippleInsideHole", layer: "A1", hole: { s: 0, e: sec(4) },
    });
  });

  it("gets no pass away from the origin — a layer starting exactly at an interior hole's start is inside it", () => {
    const view = viewOf([
      track("TV", [vis("V0", 0, 2), vis("V1", 2, 4), vis("V2", 4, 6)]),
      track("TB", [vis("T2", 2, 3)]),
    ]);
    expect(refused(planRipple(view, ["V1"]))).toEqual({
      error: "RippleInsideHole", layer: "T2", hole: { s: sec(2), e: sec(4) },
    });
  });
});

describe("landings that are already occupied", () => {
  it("refuses when a downstream layer would slide under a title that spans the cut", () => {
    // The title starts before the hole, so it is anchored and stays; D shifts 2 s
    // left onto its tail.
    const view = viewOf([
      track("TV", [vis("W", 0, 4), vis("X", 4, 6), vis("Y", 6, 8)]),
      track("TT", [vis("Title", 0, 10), vis("D", 11, 14)]),
    ]);
    expect(refused(planRipple(view, ["X"]))).toEqual({
      error: "RippleCollision", moving: "D", blocking: "Title", track: "TT",
    });
  });
});

describe("links and locks", () => {
  it("refuses a link with a member reaching across the cut and one after it", () => {
    // A J-cut: the audio Z runs [0,5) under the cut at 4 s, its picture Y sits
    // downstream. Closing [4,6) would move Y and not Z, and the pair drifts.
    const view = viewOf(
      [track("TV", [vis("W", 0, 4), vis("X", 4, 6)]), track("TB", [vis("Y", 6, 8)]), track("TA", [aud("Z", 0, 5)])],
      { links: [{ id: "L", members: ["Z", "Y"] }] },
    );
    expect(refused(planRipple(view, ["X"]))).toEqual({
      error: "RippleLinkStraddles", link: "L", hole: { s: sec(4), e: sec(6) },
    });
  });

  it("lets a link whose upstream member ends at the cut close the gap — a split clip's own pieces", () => {
    // Splitting a linked clip leaves every piece in one link. W [0,4) ends
    // exactly where X's span begins, so it is wholly upstream: bringing Y up to
    // it is the ripple's purpose, not a link torn apart.
    const view = viewOf(
      [track("TV", [vis("W", 0, 4), vis("X", 4, 6)]), track("TB", [vis("Y", 6, 8)])],
      { links: [{ id: "L", members: ["W", "Y"] }] },
    );
    const plan = accepted(planRipple(view, ["X"]));
    expect(plan.moves.map(shape)).toEqual([["Y", "TB", sec(4), sec(6)]]);
  });

  it("refuses a locked track only when something on it would have to move", () => {
    const lane = (z: RippleLayerView, locked: boolean) =>
      viewOf([track("TV", [vis("W", 0, 2), vis("X", 2, 4), vis("Y", 4, 6)]), track("TL", [z], locked)]);

    expect(refused(planRipple(lane(vis("Z", 6, 8), true), ["X"]))).toEqual({ error: "TrackLocked", track: "TL" });
    // The same locked lane with its content ahead of the cut blocks nothing —
    // locking a logo at the head must not disable ripple for the whole film.
    const plan = accepted(planRipple(lane(vis("Z", 0, 2), true), ["X"]));
    expect(plan.moves.map(shape)).toEqual([["Y", "TV", sec(2), sec(4)]]);
  });

  it("refuses a locked layer that would have to move, naming the layer rather than its lane", () => {
    const view = viewOf([
      track("TV", [vis("W", 0, 2), vis("X", 2, 4), vis("Y", 4, 6)]),
      track("TL", [vis("Z", 6, 8, true)]),
    ]);
    expect(refused(planRipple(view, ["X"]))).toEqual({ error: "RippleLockedLayer", layer: "Z" });
  });
});

describe("two lattices in one ripple", () => {
  it("lands audio movers exactly and visual movers on the nearest frame when the hole is sample-sized", () => {
    // The deleted audio ends one sample past a whole second: canonical at 48 kHz,
    // 21 µs off the 30 fps frame grid.
    const cut = smp(48_001);
    const view = viewOf([
      track("TA", [layerAt("A1", "Audio", 0, cut), layerAt("A2", "Audio", cut, smp(96_002))]),
      track("TV", [vis("V1", 2, 3)]),
    ]);
    const plan = accepted(planRipple(view, ["A1"]));
    expect(plan.holes).toEqual([{ s: 0, e: cut }]);

    const [audio, visual] = plan.moves;
    // The audio partner lands on the sample it was authored on, to the µs.
    expect(shape(audio!)).toEqual(["A2", "TA", 0, smp(48_001)]);
    // The visual mover cannot: `t_start − cut` is off the frame grid, so it snaps —
    // the same drift budget a link move across two lattices already accepts.
    expect(sec(2) - cut).not.toBe(snapOnGrid(sec(2) - cut, FRAME));
    expect(shape(visual!)).toEqual(["V1", "TV", snapOnGrid(sec(2) - cut, FRAME), snapOnGrid(sec(3) - cut, FRAME)]);
    expect(visual!.t_start_us).toBe(sec(1));
  });
});

// ── Property: an accepted plan leaves a layout that still validates ──────────
// The planner's own refusals are its other correct answer, so the property only
// constrains the accepted ones: applied to a copy they must leave no same-class
// overlap, no negative time, and every track's order exactly as it was.

const PBT_SEED = 0x5249_5050;
const RUNS = Number(process.env.WEFTCUT_PBT_RUNS ?? 300);

interface SpanSpec { gap: number; len: number }
const spanArb = fc.record({ gap: fc.integer({ min: 0, max: 3 }), len: fc.integer({ min: 1, max: 5 }) });

/** A lane of non-overlapping spans laid out on its own lattice, gaps and lengths
 *  counted in lattice steps so every edge is canonical by construction. */
function lane(id: string, kind: "Color" | "Audio", specs: readonly SpanSpec[]): RippleTrackView {
  const grid = kind === "Audio" ? AUDIO_GRID : FRAME;
  const step = kind === "Audio" ? 1200 : 1; // 25 ms of samples, or one frame
  const layers: RippleLayerView[] = [];
  let cursor = 0;
  specs.forEach((sp, i) => {
    cursor += sp.gap * step;
    const start = cursor;
    cursor += sp.len * step;
    layers.push(layerAt(`${id}-${i}`, kind, timeUsAtGridIndex(start, grid), timeUsAtGridIndex(cursor, grid)));
  });
  return track(id, layers);
}

const layoutArb = fc
  .record({
    // At least one layer somewhere, so the deleted subset below is never empty.
    v0: fc.array(spanArb, { minLength: 1, maxLength: 4 }),
    v1: fc.array(spanArb, { maxLength: 3 }),
    v2: fc.array(spanArb, { maxLength: 3 }),
    a0: fc.array(spanArb, { maxLength: 3 }),
  })
  .map((s) =>
    viewOf([lane("V0", "Color", s.v0), lane("V1", "Color", s.v1), lane("V2", "Color", s.v2), lane("A0", "Audio", s.a0)]),
  );

const caseArb = layoutArb.chain((view) => {
  const ids = view.tracks.flatMap((t) => t.layers.map((l) => l.id));
  return fc.record({ view: fc.constant(view), deleted: fc.subarray(ids, { minLength: 1 }) });
});

describe("property: applying an accepted plan keeps the layout legal", () => {
  it("leaves no same-class overlap, no negative time, and every track's order untouched", () => {
    let acceptedRuns = 0;
    let movedRuns = 0;
    fc.assert(
      fc.property(caseArb, ({ view, deleted }) => {
        const plan = planRipple(view, deleted);
        if (!plan.ok) return true;
        acceptedRuns += 1;
        if (plan.moves.length > 0) movedRuns += 1;
        const gone = new Set(deleted);
        const landing = new Map(plan.moves.map((m) => [m.layer, m]));
        for (const t of view.tracks) {
          const before = t.layers.filter((l) => !gone.has(l.id));
          const after = before.map((l) => {
            const m = landing.get(l.id);
            return {
              id: l.id,
              cls: layerOverlapClass(l),
              start: m?.t_start_us ?? l.t_start_us,
              end: m?.t_end_us ?? l.t_end_us,
            };
          });
          for (const l of after) if (l.start < 0) return false;
          // `before` is ascending by construction, so re-sorting must be identity.
          const resorted = [...after].sort((x, y) => x.start - y.start).map((x) => x.id);
          expect(resorted).toEqual(after.map((x) => x.id));
          const reach = new Map<string, number>();
          for (const l of after) {
            const prev = reach.get(l.cls);
            if (prev !== undefined && l.start < prev) return false;
            reach.set(l.cls, Math.max(prev ?? 0, l.end));
          }
        }
        return true;
      }),
      { seed: PBT_SEED, numRuns: RUNS },
    );
    // Guard against a vacuous pass: a planner that refused everything, or one
    // that only ever accepted a tail deletion with nothing downstream, would
    // satisfy the property above without the landing arithmetic ever running.
    expect(acceptedRuns).toBeGreaterThan(RUNS / 10);
    expect(movedRuns).toBeGreaterThan(RUNS / 20);
  });
});

// ── a selected gap as the hole (ADR 0069) ────────────────────────────────────

describe("planRippleGap closes a selected gap with the ripple's own closing", () => {
  it("shifts every layer at or after the gap's end left by its length, on every track", () => {
    const view = viewOf([
      track("TV", [vis("A", 0, 2), vis("B", 4, 6)]),
      track("TB", [vis("P", 0, 1), vis("Q", 5, 7)]),
      track("TA", [aud("R", 4, 6)]),
    ]);
    const plan = accepted(planRippleGap(view, { track: "TV", s: sec(2), e: sec(4) }));
    expect(plan.holes).toEqual([{ s: sec(2), e: sec(4) }]);
    expect(plan.moves.map(shape)).toEqual([
      ["B", "TV", sec(2), sec(4)],
      ["Q", "TB", sec(3), sec(5)],
      ["R", "TA", sec(2), sec(4)],
    ]);
  });

  it("closes the space before the first clip from composition time 0", () => {
    const view = viewOf([track("TV", [vis("A", 1, 3), vis("B", 3, 5)])]);
    const plan = accepted(planRippleGap(view, { track: "TV", s: 0, e: sec(1) }));
    expect(plan.moves.map(shape)).toEqual([
      ["A", "TV", sec(0), sec(2)],
      ["B", "TV", sec(2), sec(4)],
    ]);
  });

  it("refuses a span that is not a gap — a piece of one, one a clip reaches into, trailing space — naming the span", () => {
    const view = viewOf([track("TV", [vis("A", 0, 2), vis("B", 4, 6)])]);
    const spans: ReadonlyArray<readonly [number, number]> = [
      [sec(2), sec(3)],
      [sec(1), sec(4)],
      [sec(6), sec(8)],
    ];
    for (const [s, e] of spans) {
      expect(refused(planRippleGap(view, { track: "TV", s, e }))).toEqual({
        error: "GapNotFound",
        track: "TV",
        s,
        e,
      });
    }
    expect(refused(planRippleGap(view, { track: "nope", s: sec(2), e: sec(4) }))).toEqual({
      error: "TrackNotFound",
      track: "nope",
    });
  });

  it("inherits the ripple's refusals: a clip starting inside the gap on another lane, and a locked lane that must move", () => {
    const inside = viewOf([
      track("TV", [vis("A", 0, 2), vis("B", 4, 6)]),
      track("TB", [vis("Title", 3, 5)]),
    ]);
    expect(refused(planRippleGap(inside, { track: "TV", s: sec(2), e: sec(4) }))).toEqual({
      error: "RippleInsideHole",
      layer: "Title",
      hole: { s: sec(2), e: sec(4) },
    });
    // The gap's own lane always holds a mover (the clip at its right edge), so
    // a gap on a locked lane can never close.
    const locked = viewOf([track("TV", [vis("A", 0, 2), vis("B", 4, 6)], true)]);
    expect(refused(planRippleGap(locked, { track: "TV", s: sec(2), e: sec(4) }))).toEqual({
      error: "TrackLocked",
      track: "TV",
    });
  });

  it("leaves a layer that starts before the gap where it is, and refuses when a mover would land on it", () => {
    // A spanning title on TB starts before the gap and stays; the mover on TV
    // lands next to A with nothing in the way.
    const spanning = viewOf([
      track("TV", [vis("A", 0, 2), vis("B", 4, 6)]),
      track("TB", [vis("Title", 1, 5)]),
    ]);
    const plan = accepted(planRippleGap(spanning, { track: "TV", s: sec(2), e: sec(4) }));
    expect(plan.moves.map(shape)).toEqual([["B", "TV", sec(2), sec(4)]]);
    // The same shape with a clip downstream of the title on ITS lane: that
    // clip moves 2 s left, into the title.
    const collides = viewOf([
      track("TV", [vis("A", 0, 2), vis("B", 4, 6)]),
      track("TB", [vis("Long", 1, 5), vis("Next", 5, 6)]),
    ]);
    expect(refused(planRippleGap(collides, { track: "TV", s: sec(2), e: sec(4) }))).toEqual({
      error: "RippleCollision",
      moving: "Next",
      blocking: "Long",
      track: "TB",
    });
  });

  it("agrees with planRipple: deleting a clip and closing the gap it leaves land everything identically", () => {
    const view = viewOf([
      track("TV", [vis("A", 0, 2), vis("B", 2, 4), vis("C", 4, 6)]),
      track("TB", [vis("Q", 5, 7)]),
      track("TA", [aud("R", 4, 6)]),
    ]);
    const viaDelete = accepted(planRipple(view, ["B"]));
    const withoutB = viewOf([
      track("TV", [vis("A", 0, 2), vis("C", 4, 6)]),
      track("TB", [vis("Q", 5, 7)]),
      track("TA", [aud("R", 4, 6)]),
    ]);
    const viaGap = accepted(planRippleGap(withoutB, { track: "TV", s: sec(2), e: sec(4) }));
    expect(viaGap.holes).toEqual(viaDelete.holes);
    expect(viaGap.moves).toEqual(viaDelete.moves);
  });
});
