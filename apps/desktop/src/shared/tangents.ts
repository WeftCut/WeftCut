// The write-time tangent solver — the ONE place `Auto` sides and `Smooth` pairs
// are turned into numbers. main calls it from `applyUpdateLayerParamTrack`
// after frame-snap / sort / dedupe and before the track is stored, so every
// reader (curve graph, MCP `get_param_track`, wasm preview, native export)
// sees the same explicit coordinates and the engine never solves. Trim / split
// / move do NOT re-solve: explicit numbers keep the motion byte-identical
// across a cut. Lives in src/shared/ because the renderer's editors preview the
// same numbers main will store.
// TWIN: `native/src/state/keyframe_edits.rs::solve_auto_tangents`, golden-locked
// through keyframeEditsGolden.fixture.json (the `solve` cases). ADR 0058.
import {
  IN_IDENTITY,
  OUT_IDENTITY,
  tangentEqExact,
  type Keyframe,
  type Tangent,
} from "./keyframe";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/// Monotone-clamped tangent (scalar per microsecond) at key `i` over the scalar
/// projections `s` and times `t`: 0 at an endpoint, at a local extremum, or when
/// a neighbour delta is 0 — Blender "Auto Clamped", so an Auto key never
/// overshoots.
export function tangentAt(s: readonly number[], t: readonly number[], i: number): number {
  if (i === 0 || i + 1 >= s.length) return 0;
  const dPrev = s[i]! - s[i - 1]!;
  const dNext = s[i + 1]! - s[i]!;
  if (dPrev === 0 || dNext === 0 || Math.sign(dPrev) !== Math.sign(dNext)) return 0;
  const dt = t[i + 1]! - t[i - 1]!;
  if (dt <= 0) return 0;
  return (s[i + 1]! - s[i - 1]!) / dt;
}

/// Resolve every `Auto` side and every `Smooth` pair of `Free` sides over SORTED
/// keys. Returns a new array whose entries are the input objects except where a
/// side changed. `scalar` projects a value onto the axis the slopes are measured
/// on; `null` (a non-scalar `T`) sends Auto sides to the identity coordinates
/// with their mode kept and skips the Smooth rule. A side adjacent to a
/// non-Spline segment is left alone: the engine ignores it.
///
/// Auto out / Auto in reproduce the monotone Smooth numbers split across the two
/// keys: `out = (1/3, m·dt/(3·dv))`, `in = (2/3, 1 − m·dt/(3·dv))`, each over
/// its own segment's `dt`/`dv`, degenerate (`dv = 0` or `dt ≤ 0`) → identity.
///
/// Smooth over two Free sides is "OUT WINS": the arriving handle is re-aimed so
/// its slope `(1 − in.y)·dvPrev / ((1 − in.x)·dtPrev)` equals the leaving
/// handle's `out.y·dvNext / (out.x·dtNext)`, keeping `in.x`. Deterministic
/// because main cannot know which handle was dragged; the renderer writes both
/// sides itself when the user drags the in-handle, so this fires only when a
/// NEIGHBOUR edit changed Δv/Δt.
export function solveAutoTangents<T>(
  keys: readonly Keyframe<T>[],
  scalar: ((v: T) => number) | null,
): Keyframe<T>[] {
  const n = keys.length;
  const s = scalar === null ? null : keys.map((k) => scalar(k.value));
  const t = keys.map((k) => k.t_us);
  const out: Keyframe<T>[] = keys.slice();
  for (let i = 0; i < n; i++) {
    const k = keys[i]!;
    const outSpline = i + 1 < n && k.segment.kind === "Spline";
    const inSpline = i > 0 && keys[i - 1]!.segment.kind === "Spline";
    let nextIn: Tangent = k.in;
    let nextOut: Tangent = k.out;

    if (k.out.mode === "Auto" && outSpline) {
      if (s === null) {
        nextOut = { x: OUT_IDENTITY.x, y: OUT_IDENTITY.y, mode: "Auto" };
      } else {
        const m = tangentAt(s, t, i);
        const dt = t[i + 1]! - t[i]!;
        const dv = s[i + 1]! - s[i]!;
        nextOut = dv === 0 || dt <= 0
          ? { x: OUT_IDENTITY.x, y: OUT_IDENTITY.y, mode: "Auto" }
          : { x: 1 / 3, y: clamp01((m * dt) / (3 * dv)), mode: "Auto" };
      }
    }

    if (k.in.mode === "Auto" && inSpline) {
      if (s === null) {
        nextIn = { x: IN_IDENTITY.x, y: IN_IDENTITY.y, mode: "Auto" };
      } else {
        const m = tangentAt(s, t, i);
        const dt = t[i]! - t[i - 1]!;
        const dv = s[i]! - s[i - 1]!;
        nextIn = dv === 0 || dt <= 0
          ? { x: IN_IDENTITY.x, y: IN_IDENTITY.y, mode: "Auto" }
          : { x: 2 / 3, y: clamp01(1 - (m * dt) / (3 * dv)), mode: "Auto" };
      }
    }

    if (
      s !== null &&
      k.continuity === "Smooth" &&
      k.in.mode === "Free" &&
      k.out.mode === "Free" &&
      outSpline &&
      inSpline
    ) {
      const dtNext = t[i + 1]! - t[i]!;
      const dvNext = s[i + 1]! - s[i]!;
      const dtPrev = t[i]! - t[i - 1]!;
      const dvPrev = s[i]! - s[i - 1]!;
      if (k.out.x !== 0 && dvPrev !== 0 && dtPrev > 0 && k.in.x !== 1) {
        const m = (k.out.y / k.out.x) * (dvNext / dtNext);
        nextIn = { x: k.in.x, y: 1 - (m * (1 - k.in.x) * dtPrev) / dvPrev, mode: "Free" };
      }
    }

    if (!tangentEqExact(nextIn, k.in) || !tangentEqExact(nextOut, k.out)) {
      out[i] = { ...k, in: nextIn, out: nextOut };
    }
  }
  return out;
}
