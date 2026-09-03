import { describe, expect, it } from "vitest";
import type { AnimTrack, Continuity, Extrapolate, Interpolation, Keyframe, Tangent } from "../ipc";
import {
  upsertKeyframe,
  removeKeyframe,
  retimeKeyframe,
  setSegmentEasing,
  setAuto,
  setTangent,
  setContinuity,
  setExtrapolation,
} from "./edits";
import { solveAutoTangents } from "../../shared/tangents";
import { extrapolationEq, segmentEqExact } from "../../shared/keyframe";
import fixture from "./keyframeEditsGolden.fixture.json";

type Track = AnimTrack<number>;
interface Case {
  name: string;
  op: string;
  args: Record<string, unknown>;
  input: Track;
  expect: Track;
}

/// The `solve` op runs the shared write-time solver the way main does — over
/// the track's keys with the identity scalar.
function solve(track: Track): Track {
  if (track.mode !== "Keyframed") return track;
  return { ...track, value: solveAutoTangents(track.value, (v) => v) };
}

function applyOp(track: Track, op: string, args: Record<string, unknown>): Track {
  switch (op) {
    case "upsert":
      return upsertKeyframe(track, args.t_us as number, args.value as number, args.easing as Interpolation | undefined);
    case "remove":
      return removeKeyframe(track, args.id as string, args.fallback as number);
    case "retime":
      return retimeKeyframe(track, args.id as string, args.new_t_us as number);
    case "set_segment_easing":
      return setSegmentEasing(track, args.id as string, args.easing as Interpolation);
    case "set_auto":
      return setAuto(track, args.ids as string[]);
    case "set_tangent":
      return setTangent(track, args.id as string, args.side as "in" | "out", { x: args.x as number, y: args.y as number });
    case "set_continuity":
      return setContinuity(track, args.id as string, args.continuity as Continuity);
    case "set_extrapolation":
      return setExtrapolation(track, { before: args.before as Extrapolate | undefined, after: args.after as Extrapolate | undefined });
    case "solve":
      return solve(track);
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const NEAR = 1e-9;
/// `x` exact (an identity expression or a fixture literal on both sides), `y`
/// within 1e-9 (a solved value), mode exact — the same rule the Rust runner
/// applies.
function tangentEq(got: Tangent, want: Tangent, what: string) {
  expect(got.x, `${what}.x`).toBe(want.x);
  expect(Math.abs(got.y - want.y), `${what}.y`).toBeLessThan(NEAR);
  expect(got.mode, `${what}.mode`).toBe(want.mode);
}

function assertTrackEqIgnoringIds(got: Track, want: Track) {
  expect(got.mode).toBe(want.mode);
  if (got.mode === "Static" && want.mode === "Static") {
    expect(Math.abs(got.value - want.value)).toBeLessThan(NEAR);
    return;
  }
  if (got.mode === "Keyframed" && want.mode === "Keyframed") {
    expect(extrapolationEq(got.extrapolate, want.extrapolate), "extrapolate").toBe(true);
    expect(got.value.length).toBe(want.value.length);
    got.value.forEach((g: Keyframe<number>, i: number) => {
      const w = want.value[i]!;
      const at = `key[${i}] t=${w.t_us}`;
      expect(g.t_us, at).toBe(w.t_us);
      expect(Math.abs(g.value - w.value), `${at}.value`).toBeLessThan(NEAR);
      tangentEq(g.in, w.in, `${at}.in`);
      tangentEq(g.out, w.out, `${at}.out`);
      expect(g.continuity, `${at}.continuity`).toBe(w.continuity);
      expect(segmentEqExact(g.segment, w.segment), `${at}.segment`).toBe(true);
    });
    return;
  }
  throw new Error("mode mismatch");
}

// Same fixture as `native/src/state/keyframe_edits.rs::golden_vectors_match_fixture`;
// a change that passes one language and fails the other is a Rust↔TS drift.
describe("keyframe edits golden", () => {
  for (const c of fixture.cases as unknown as Case[]) {
    it(c.name, () => {
      const got = applyOp(c.input, c.op, c.args);
      assertTrackEqIgnoringIds(got, c.expect);
    });
  }
});
