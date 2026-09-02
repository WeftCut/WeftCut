import { describe, expect, it } from "vitest";
import {
  liftToKeyframed, collapseToStatic, upsertKeyframe, removeKeyframe,
  retimeKeyframe, setSegmentEasing, setSegmentCoeffs, setAuto, setTangent, setContinuity, setExtrapolation,
} from "./edits";
import type { AnimTrack } from "../ipc";
import { resolveAnimated } from "../render/animated";
import { solveAutoTangents } from "../../shared/tangents";

/// What main does on write: the marks `setAuto` leaves become numbers here, so
/// the engine assertions below read what the actor would store.
const solve = (t: AnimTrack<number>): AnimTrack<number> =>
  t.mode === "Keyframed" ? { ...t, value: solveAutoTangents(t.value, (v) => v) } : t;

// resolveAnimated is wasm-backed now; the wasm is loaded by the global test
// setup (vitest.config.ts setupFiles).

const kf = (id: string, t: number, value: number): AnimTrack<number> =>
  ({ mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [{ id, t_us: t, value, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }] });

describe("liftToKeyframed", () => {
  it("makes a single-key track at tUs", () => {
    const tr = liftToKeyframed(0.5, 1_000_000);
    expect(tr.mode).toBe("Keyframed");
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value).toHaveLength(1);
    expect(tr.value[0]!.t_us).toBe(1_000_000);
    expect(tr.value[0]!.value).toBe(0.5);
  });
});

describe("collapseToStatic", () => {
  it("evaluates the track at tUs and returns Static", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [
      { id: "a", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
      { id: "b", t_us: 10_000_000, value: 10, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
    ]};
    expect(collapseToStatic(tr, 5_000_000, 1)).toEqual({ mode: "Static", value: 5 });
  });
});

describe("upsertKeyframe", () => {
  it("lifts a Static track, keying current value at other times too", () => {
    const tr = upsertKeyframe({ mode: "Static", value: 0.2 }, 2_000_000, 0.9);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value.map((k) => [k.t_us, k.value])).toEqual([[2_000_000, 0.9]]);
  });
  it("updates the key when one already sits at tUs", () => {
    const tr = upsertKeyframe(kf("a", 1_000_000, 0.1), 1_000_000, 0.7);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value).toHaveLength(1);
    expect(tr.value[0]!.value).toBe(0.7);
  });
  it("inserts a new key sorted by t_us", () => {
    const tr = upsertKeyframe(kf("a", 2_000_000, 0.1), 1_000_000, 0.9);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value.map((k) => k.t_us)).toEqual([1_000_000, 2_000_000]);
  });
});

describe("removeKeyframe", () => {
  it("removes by id, staying Keyframed when keys remain", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [
      { id: "a", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
      { id: "b", t_us: 1_000_000, value: 1, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
    ]};
    const out = removeKeyframe(tr, "a", 1);
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value.map((k) => k.id)).toEqual(["b"]);
  });
  it("collapses to Static at the removed key's value when it was the last", () => {
    expect(removeKeyframe(kf("a", 0, 0.33), "a", 1)).toEqual({ mode: "Static", value: 0.33 });
  });
});

describe("retimeKeyframe", () => {
  it("moves a key and re-sorts", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [
      { id: "a", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
      { id: "b", t_us: 1_000_000, value: 1, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
    ]};
    const out = retimeKeyframe(tr, "a", 2_000_000);
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value.map((k) => k.id)).toEqual(["b", "a"]);
  });
});

describe("setSegmentEasing", () => {
  it("writes the class and leaving side on the key and the arriving side on its successor, both Free", () => {
    const tr: AnimTrack<number> = {
      mode: "Keyframed", value: [mkKf("a", 0, 0), mkKf("b", 1_000_000, 1)],
      extrapolate: { before: "Loop", after: "Hold" },
    };
    const out = setSegmentEasing(tr, "a", { kind: "Bezier", p1: [0.42, 0], p2: [1, 1] });
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value[0]!.segment).toEqual({ kind: "Spline" });
    expect(out.value[0]!.out).toEqual({ x: 0.42, y: 0, mode: "Free" });
    expect(out.value[1]!.in).toEqual({ x: 1, y: 1, mode: "Free" });
    expect(out.value[1]!.segment).toEqual({ kind: "Linear" });
    expect(out.extrapolate).toEqual({ before: "Loop", after: "Hold" });
  });
  it("a non-Spline easing resets both sides to the identity", () => {
    const out = setSegmentEasing(kf("a", 0, 0), "a", { kind: "Hold" });
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value[0]!.segment).toEqual({ kind: "Hold" });
    expect(out.value[0]!.out).toEqual({ x: 1 / 3, y: 1 / 3, mode: "Free" });
  });
  it("setSegmentCoeffs is the cubic form the curve-graph handles commit", () => {
    const tr: AnimTrack<number> = {
      mode: "Keyframed", value: [mkKf("a", 0, 0), mkKf("b", 1_000_000, 1)],
      extrapolate: { before: "Hold", after: "Hold" },
    };
    const out = setSegmentCoeffs(tr, "a", [0.2, 0.8, 0.8, 0.2]);
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value[0]!.out).toEqual({ x: 0.2, y: 0.8, mode: "Free" });
    expect(out.value[1]!.in).toEqual({ x: 0.8, y: 0.2, mode: "Free" });
  });
});

function mkKf(id: string, t_us: number, value: number) {
  return { id, t_us, value, in: { x: 2 / 3, y: 2 / 3, mode: "Free" as const }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" as const }, continuity: "Broken" as const, segment: { kind: "Linear" as const } };
}

describe("setAuto (+ the write-time solve)", () => {
  it("is a no-op on Static", () => {
    const s = { mode: "Static" as const, value: 3 };
    expect(setAuto(s, ["x"])).toBe(s);
  });

  it("marks both sides Auto with Smooth continuity and splines the segments on either side, coords untouched", () => {
    const track = {
      mode: "Keyframed" as const, extrapolate: { before: "Hold" as const, after: "Hold" as const },
      value: [mkKf("a", 0, 0), mkKf("b", 1_000_000, 10), mkKf("c", 2_000_000, 0)],
    };
    const out = setAuto(track, ["b"]);
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    expect(out.value[0]!.segment).toEqual({ kind: "Spline" });
    expect(out.value[0]!.out).toEqual(track.value[0]!.out);
    expect(out.value[1]!.in.mode).toBe("Auto");
    expect(out.value[1]!.out.mode).toBe("Auto");
    expect(out.value[1]!.in.x).toBe(2 / 3);
    expect(out.value[1]!.continuity).toBe("Smooth");
    expect(out.value[1]!.segment).toEqual({ kind: "Spline" });
    expect(out.value[2]).toBe(track.value[2]);
  });

  it("does not overshoot at a peak (extremum → flat tangent)", () => {
    // values 0, 10, 0 — middle is a local max; the solved curve must never exceed 10.
    const track = {
      mode: "Keyframed" as const, extrapolate: { before: "Hold" as const, after: "Hold" as const },
      value: [mkKf("a", 0, 0), mkKf("b", 1_000_000, 10), mkKf("c", 2_000_000, 0)],
    };
    const out = solve(setAuto(track, ["a", "b", "c"]));
    for (let t = 0; t <= 2_000_000; t += 50_000) {
      expect(resolveAnimated(out, t, 0)).toBeLessThanOrEqual(10 + 1e-6);
      expect(resolveAnimated(out, t, 0)).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("does not undershoot at a valley (symmetric to the peak case)", () => {
    // values 10, 0, 10 — middle is a local min; the solved curve must never drop below 0.
    const track = {
      mode: "Keyframed" as const, extrapolate: { before: "Hold" as const, after: "Hold" as const },
      value: [mkKf("a", 0, 10), mkKf("b", 1_000_000, 0), mkKf("c", 2_000_000, 10)],
    };
    const out = solve(setAuto(track, ["a", "b", "c"]));
    for (let t = 0; t <= 2_000_000; t += 50_000) {
      expect(resolveAnimated(out, t, 0)).toBeGreaterThanOrEqual(-1e-6);
      expect(resolveAnimated(out, t, 0)).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it("leaves a single-keyframe track's segment class alone (no segment to shape)", () => {
    const track = { mode: "Keyframed" as const, extrapolate: { before: "Hold" as const, after: "Hold" as const }, value: [mkKf("a", 0, 4)] };
    const out = solve(setAuto(track, ["a"]));
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    expect(out.value[0]!.segment).toEqual({ kind: "Linear" });
    expect(out.value[0]!.in.mode).toBe("Auto");
    expect(out.value[0]!.out).toEqual({ x: 1 / 3, y: 1 / 3, mode: "Auto" }); // coords untouched
  });

  it("solves a flat (equal-value) segment to the identity handle", () => {
    const track = {
      mode: "Keyframed" as const, extrapolate: { before: "Hold" as const, after: "Hold" as const },
      value: [mkKf("a", 0, 5), mkKf("b", 1_000_000, 5), mkKf("c", 2_000_000, 9)],
    };
    const out = solve(setAuto(track, ["a"]));
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    expect(out.value[0]!.segment).toEqual({ kind: "Spline" });
    expect(out.value[0]!.out).toEqual({ x: 1 / 3, y: 1 / 3, mode: "Auto" }); // a→b is flat (Δv=0)
    for (let t = 0; t <= 1_000_000; t += 100_000) expect(resolveAnimated(out, t, 0)).toBeCloseTo(5, 9);
  });

  it("produces in-range leaving-handle y on a monotone ramp", () => {
    const track = {
      mode: "Keyframed" as const, extrapolate: { before: "Hold" as const, after: "Hold" as const },
      value: [mkKf("a", 0, 0), mkKf("b", 1_000_000, 5), mkKf("c", 2_000_000, 10)],
    };
    const out = solve(setAuto(track, ["b"]));
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    const b = out.value[1]!;
    expect(b.segment).toEqual({ kind: "Spline" });
    expect(b.out.y).toBeGreaterThanOrEqual(0);
    expect(b.out.y).toBeLessThanOrEqual(1);
    expect(b.in.y).toBeGreaterThanOrEqual(0);
    expect(b.in.y).toBeLessThanOrEqual(1);
  });
});

describe("setTangent / setContinuity / setExtrapolation (the golden holds the numbers)", () => {
  const ramp: AnimTrack<number> = { mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" }, value: [
    { id: "a", t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Spline" } },
    { id: "b", t_us: 1_000_000, value: 1, in: { x: 2 / 3, y: 2 / 3, mode: "Auto" }, out: { x: 1 / 3, y: 1 / 3, mode: "Auto" }, continuity: "Smooth", segment: { kind: "Spline" } },
    { id: "c", t_us: 2_000_000, value: 2, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } },
  ]};
  it("returns the same track for a Static track or an unknown id", () => {
    const st: AnimTrack<number> = { mode: "Static", value: 1 };
    expect(setTangent(st, "a", "out", { x: 0.5, y: 0.5 })).toBe(st);
    expect(setContinuity(st, "a", "Smooth")).toBe(st);
    expect(setExtrapolation(st, { before: "Loop" })).toBe(st);
    expect(setTangent(ramp, "zzz", "out", { x: 0.5, y: 0.5 })).toBe(ramp);
    expect(setContinuity(ramp, "zzz", "Broken")).toBe(ramp);
  });
  it("does not mutate the input track", () => {
    const before = JSON.stringify(ramp);
    setTangent(ramp, "b", "in", { x: 0.5, y: 0.5 });
    setContinuity(ramp, "b", "Broken");
    setExtrapolation(ramp, { after: "PingPong" });
    expect(JSON.stringify(ramp)).toBe(before);
  });
  it("grabbing a handle of an Auto key frees both sides and keeps the untouched side's numbers", () => {
    const out = setTangent(ramp, "b", "in", { x: 0.5, y: 0.25 });
    if (out.mode !== "Keyframed") throw new Error();
    const b = out.value[1]!;
    expect(b.in).toEqual({ x: 0.5, y: 0.25, mode: "Free" });
    expect(b.out.mode).toBe("Free");
    expect(b.out.x).toBe(1 / 3);
  });
  it("an empty extrapolation patch is the identity", () => {
    const out = setExtrapolation(ramp, {});
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.extrapolate).toEqual({ before: "Hold", after: "Hold" });
  });
});
