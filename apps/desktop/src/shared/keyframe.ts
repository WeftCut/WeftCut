// The keyframe record every twin speaks: per-key tangents, the segment class,
// the track-level extrapolation and the `Animated<T>` envelope. Lives in
// src/shared/ because main (state model, MCP), the renderer (IPC mirror, render
// resolver, editors) and the wasm bridge all author it — the same pattern as
// `easing.ts`. TWIN of the Rust record in `native/src/state/animated.rs`
// (serde): the wire JSON is identical, key order included. ADR 0058 is the
// decision record; docs/data-model.md § Animated values describes the wire.
import type { EaseDir } from "./easing";

/// Who owns a side's coordinates: `Auto` sides are re-solved by main's write
/// normalization (`tangents.ts`) on every track write; `Free` sides are
/// authored. Stored so every reader sees explicit numbers — the engine never
/// reads the mode.
export type TangentMode = "Auto" | "Free";

/// With both sides `Free`, whether the write normalization keeps their slopes
/// locked equal (`Smooth`) or lets them differ (`Broken`).
export type Continuity = "Smooth" | "Broken";

/// One side of a key: a control point in the owning segment's unit square
/// (`x` = fraction of the segment's time span, `y` = fraction of its value
/// span). The arriving side (`in`) is stored UN-MIRRORED — it is the cubic's
/// second control point as-is, so a segment evaluates as
/// `unit_bezier(left.out, right.in)` with no arithmetic on the stored numbers
/// (`1 − (1 − x)` is not exact in f64 and would break the exact-equality
/// preset lookup, the scale-link twin compare and the byte-identical goldens).
/// The handle the user drags is `in − (1, 1)` from the key — a presentation
/// convention, not the storage.
export interface Tangent {
  x: number;
  y: number;
  mode: TangentMode;
}

/// Class of the segment LEAVING a key. Only `Spline` reads the tangents; Hold /
/// Linear / Elastic / Bounce are exactly what they were as segment-level eases.
/// TWIN: `weftcut_eval::Segment` (serde tag "kind").
export type Segment =
  | { kind: "Spline" }
  | { kind: "Hold" }
  | { kind: "Linear" }
  /// `amplitude` ≥ 1 (engine clamps defensively), `period` > 0 (authoring
  /// enforces; the engine divides by it as given).
  | { kind: "Elastic"; dir: EaseDir; amplitude: number; period: number }
  | { kind: "Bounce"; dir: EaseDir };

/// What a track does strictly outside its key range; `period = last.t − first.t`,
/// a single-key track never extrapolates. `Loop` returns to `first.value` at
/// `last + period` (a visible jump when the ends differ — no bridging segment);
/// `PingPong` mirrors odd periods; `Offset` adds `n·(last − first)` per period
/// (colours in OkLab, clamped at u8); `Continue` extends the end segment's
/// slope (a Hold or procedural end gives slope 0).
export type Extrapolate = "Hold" | "Loop" | "PingPong" | "Offset" | "Continue";

export interface Extrapolation {
  before: Extrapolate;
  after: Extrapolate;
}

/// Field order is the wire order and is CANONICAL — `fixtures/projects/v1.json`
/// is compared byte-for-byte after a parse → serialize round trip. The first
/// key's `in` and the last key's `out` are stored but meaningless.
export interface Keyframe<T> {
  id: string;
  /// Relative to the owning layer's `t_start_us`.
  t_us: number;
  value: T;
  /// Shape of the segment ARRIVING at this key.
  in: Tangent;
  /// Shape of the segment LEAVING this key.
  out: Tangent;
  continuity: Continuity;
  /// Class of the segment LEAVING this key.
  segment: Segment;
}

/// Wire mirror of the Rust `Animated<T>` (`{"mode":"Static","value":v}` /
/// `{"mode":"Keyframed","value":[..],"extrapolate":{..}}`). `extrapolate` is
/// REQUIRED on the wire — `parseProject` refuses a Keyframed track without it.
export type Animated<T> =
  | { mode: "Static"; value: T }
  | { mode: "Keyframed"; value: Keyframe<T>[]; extrapolate: Extrapolation };

/// The coordinates a side holds when its segment does not read it (Hold /
/// Linear / procedural neighbours, the first key's `in`, the last key's `out`):
/// the linear parametrisation's own control points. ARITHMETIC EXPRESSIONS, not
/// decimal literals — the Rust twin (`weftcut_eval::OUT_IDENTITY` /
/// `IN_IDENTITY`) computes the same expressions, and the goldens compare the
/// coordinates exactly (same rule as `BACK_Y` in easing.ts).
export const OUT_IDENTITY: Readonly<{ x: number; y: number }> = { x: 1 / 3, y: 1 / 3 };
export const IN_IDENTITY: Readonly<{ x: number; y: number }> = { x: 2 / 3, y: 2 / 3 };

/// The value types a track can carry: a number for every scalar param, the wire
/// `Rgba` for a colour. Which one a param key takes is `isColorParam`'s call.
export type TrackValue = number | { r: number; g: number; b: number; a: number };

/// The ONE home of "which value type this param key carries": `color` — the
/// Text and Color layers' colour — carries `Rgba`; every other key (transform,
/// opacity, the audio pair, effect params) carries a number. Main's lenses, the
/// MCP parsers and the renderer's descriptors all read this one predicate.
export function isColorParam(paramKey: string): boolean {
  return paramKey === "color";
}

/// The default extrapolation — the end-key clamp on both sides. Frozen: a site
/// that mints a track with the default may share it by reference (the curve
/// graph's sampling tracks do), so an in-place write throws instead of silently
/// changing every such track.
export const HOLD_EXTRAPOLATION: Readonly<Extrapolation> = Object.freeze({
  before: "Hold",
  after: "Hold",
});

export function freeSide(x: number, y: number): Tangent {
  return { x, y, mode: "Free" };
}

/// The identity leaving side, `Free`.
export function outIdentity(): Tangent {
  return freeSide(OUT_IDENTITY.x, OUT_IDENTITY.y);
}

/// The identity arriving side, `Free`.
export function inIdentity(): Tangent {
  return freeSide(IN_IDENTITY.x, IN_IDENTITY.y);
}

export function cloneTangent(t: Tangent): Tangent {
  return { x: t.x, y: t.y, mode: t.mode };
}

/// Structural deep copy (never aliased). Exhaustive — a new kind is a compile
/// error here rather than a silently shared object.
export function cloneSegment(s: Segment): Segment {
  switch (s.kind) {
    case "Spline":
    case "Hold":
    case "Linear":
      return { kind: s.kind };
    case "Elastic":
      return { kind: "Elastic", dir: s.dir, amplitude: s.amplitude, period: s.period };
    case "Bounce":
      return { kind: "Bounce", dir: s.dir };
  }
}

export function cloneExtrapolation(e: Extrapolation): Extrapolation {
  return { before: e.before, after: e.after };
}

/// Everything about a key except its identity, deep-copied, in canonical key
/// order — the fan-out twin writers spread it under a fresh `id`. `value` is
/// copied by reference (a number today; a colour caller passes its own copy).
export function cloneKeyframeShape<T>(k: Keyframe<T>): Omit<Keyframe<T>, "id"> {
  return {
    t_us: k.t_us,
    value: k.value,
    in: cloneTangent(k.in),
    out: cloneTangent(k.out),
    continuity: k.continuity,
    segment: cloneSegment(k.segment),
  };
}

/// Exact `===` on purpose (the same argument as `interpEqExact`): the app is the
/// only writer of these numbers and JSON round-trips f64 exactly, so a tolerance
/// could only invent false identities.
export function tangentEqExact(a: Tangent, b: Tangent): boolean {
  return a.x === b.x && a.y === b.y && a.mode === b.mode;
}

export function segmentEqExact(a: Segment, b: Segment): boolean {
  switch (a.kind) {
    case "Spline":
    case "Hold":
    case "Linear":
      return a.kind === b.kind;
    case "Elastic":
      return (
        b.kind === "Elastic" &&
        a.dir === b.dir && a.amplitude === b.amplitude && a.period === b.period
      );
    case "Bounce":
      return b.kind === "Bounce" && a.dir === b.dir;
  }
}

export function extrapolationEq(a: Extrapolation, b: Extrapolation): boolean {
  return a.before === b.before && a.after === b.after;
}

/// Structural twin test for two keys — `t_us`, `value`, both sides,
/// `continuity`, `segment`; NOT `id` (ids are per-track identities and
/// legitimately differ between twins). `valueEq` defaults to `===`.
export function keyframeShapeEqExact<T>(
  a: Keyframe<T>,
  b: Keyframe<T>,
  valueEq: (x: T, y: T) => boolean = (x, y) => x === y,
): boolean {
  return (
    a.t_us === b.t_us &&
    valueEq(a.value, b.value) &&
    tangentEqExact(a.in, b.in) &&
    tangentEqExact(a.out, b.out) &&
    a.continuity === b.continuity &&
    segmentEqExact(a.segment, b.segment)
  );
}
