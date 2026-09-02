// Pure AnimTrack<number> transforms for the authoring UI. Each returns a NEW
// track to hand to `updateLayerParamTrack`; the actor re-normalizes
// (sort/snap/dedupe) and solves Auto / Smooth tangents on write
// (shared/tangents.ts), so these need only stay self-consistent and never
// solve. Times are layer-local microseconds (the keyframe `t_us` base).
// TWIN: native/src/state/keyframe_edits.rs, golden-locked through
// keyframeEditsGolden.fixture.json (edits.golden.test.ts on this side).
import type { AnimTrack, Continuity, Extrapolate, Interpolation, Keyframe, Tangent } from "../ipc";
import { applySegmentEasing } from "../../shared/easing";
import {
  HOLD_EXTRAPOLATION,
  cloneSegment,
  cloneTangent,
  freeSide,
  inIdentity,
  outIdentity,
} from "../../shared/keyframe";
import { inSlope, inYForSlope, outSlope, outYForSlope } from "../../shared/tangents";
import { resolveAnimated } from "../render/animated";

function newId(): string {
  return crypto.randomUUID();
}

/// A fresh key with identity sides, Broken, Linear — what every insert starts
/// from before it inherits or is given an easing.
function newKey(id: string, tUs: number, value: number): Keyframe<number> {
  return {
    id,
    t_us: tUs,
    value,
    in: inIdentity(),
    out: outIdentity(),
    continuity: "Broken",
    segment: { kind: "Linear" },
  };
}

/// One key; `easing` (when given) is written onto it as the segment leaving it
/// — a lone key has no right neighbour, so only its own side takes it.
export function liftToKeyframed(
  value: number,
  tUs: number,
  easing?: Interpolation,
  mkId: () => string = newId,
): AnimTrack<number> {
  let k = newKey(mkId(), tUs, value);
  if (easing !== undefined) k = applySegmentEasing(k, undefined, easing)[0];
  return { mode: "Keyframed", value: [k], extrapolate: { ...HOLD_EXTRAPOLATION } };
}

export function collapseToStatic(
  track: AnimTrack<number>,
  tUs: number,
  fallback: number,
): AnimTrack<number> {
  const value = track.mode === "Static" ? track.value : resolveAnimated(track, tUs, fallback);
  return { mode: "Static", value };
}

/// Insert-or-update a key at `tUs`. A Static track is lifted (the new key is
/// the only key). An existing key at exactly `tUs` is updated in place (value
/// always; easing only when given). Otherwise a new key K is inserted between
/// A (the preceding key) and B (the following): `K.segment = A.segment`,
/// `K.out = A.out`, `K.in = B.in` (identity when B is absent) — both halves
/// repeat the ease A→B had, which is what "inherit the preceding easing" meant
/// when the ease lived on one key; no A → Linear with identity sides. A given
/// `easing` is then applied to `(K, next)`. `mkId` is injected so the
/// main-process MCP path can mint deterministic keyframe ids from the actor's
/// seeded id generator (matching Rust `new_id()` order); the renderer keeps
/// the `crypto.randomUUID` default.
export function upsertKeyframe(
  track: AnimTrack<number>,
  tUs: number,
  value: number,
  easing?: Interpolation,
  mkId: () => string = newId,
): AnimTrack<number> {
  if (track.mode === "Static") return liftToKeyframed(value, tUs, easing, mkId);
  const keys = track.value.slice();
  let at = keys.findIndex((k) => k.t_us === tUs);
  if (at >= 0) {
    keys[at] = { ...keys[at]!, value };
  } else {
    const a = keys.filter((k) => k.t_us < tUs).pop();
    const b = keys.find((k) => k.t_us > tUs);
    const k = newKey(mkId(), tUs, value);
    if (a) {
      k.segment = cloneSegment(a.segment);
      k.out = cloneTangent(a.out);
      k.in = b ? cloneTangent(b.in) : inIdentity();
    }
    keys.push(k);
    keys.sort((x, y) => x.t_us - y.t_us);
    at = keys.findIndex((k) => k.t_us === tUs);
  }
  if (easing !== undefined) {
    const [l, r] = applySegmentEasing(keys[at]!, keys[at + 1], easing);
    keys[at] = l;
    if (r) keys[at + 1] = r;
  }
  return { ...track, value: keys };
}

/// Remove a key by id. When it was the last key, collapse to a Static holding
/// that key's value (so the property keeps its on-screen value).
export function removeKeyframe(
  track: AnimTrack<number>,
  id: string,
  fallback: number,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const remaining = track.value.filter((k) => k.id !== id);
  if (remaining.length === 0) {
    const removed = track.value.find((k) => k.id === id);
    return { mode: "Static", value: removed?.value ?? fallback };
  }
  return { ...track, value: remaining };
}

export function retimeKeyframe(
  track: AnimTrack<number>,
  id: string,
  newTUs: number,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value.map((k) => (k.id === id ? { ...k, t_us: newTUs } : k));
  keys.sort((a, b) => a.t_us - b.t_us);
  return { ...track, value: keys };
}

/// Set the easing of the segment LEAVING key `id`: `applySegmentEasing` on that
/// key and its successor (both sides Free).
export function setSegmentEasing(
  track: AnimTrack<number>,
  id: string,
  easing: Interpolation,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value.slice();
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) return track;
  const [l, r] = applySegmentEasing(keys[i]!, keys[i + 1], easing);
  keys[i] = l;
  if (r) keys[i + 1] = r;
  return { ...track, value: keys };
}

/// Curve-graph handle drag: the segment leaving `leftId` becomes the cubic
/// `[x1, y1, x2, y2]` (both sides Free).
export function setSegmentCoeffs(
  track: AnimTrack<number>,
  leftId: string,
  [x1, y1, x2, y2]: [number, number, number, number],
): AnimTrack<number> {
  return setSegmentEasing(track, leftId, { kind: "Bezier", p1: [x1, y1], p2: [x2, y2] });
}

/// Mark keys `ids` Auto on both sides with Smooth continuity, and make the
/// segments on either side of each `Spline` so the solved tangents are read.
/// Coordinates are untouched — main's write step (shared/tangents.ts) produces
/// them, so the numbers the curve shows are the numbers the actor stored.
export function setAuto(track: AnimTrack<number>, ids: readonly string[]): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const want = new Set(ids);
  const keys = track.value.slice();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (!want.has(k.id)) continue;
    keys[i] = {
      ...k,
      in: { ...k.in, mode: "Auto" },
      out: { ...k.out, mode: "Auto" },
      continuity: "Smooth",
      ...(i + 1 < keys.length ? { segment: { kind: "Spline" } as const } : {}),
    };
    if (i > 0) keys[i - 1] = { ...keys[i - 1]!, segment: { kind: "Spline" } };
  }
  return { ...track, value: keys };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/// Write one side of key `id` as `Free {x, y}` — the curve graph's handle drag
/// and MCP `set_keyframe_tangents`. `x` is clamped to `[0, 1]` (time is
/// monotone inside a segment), `y` is free. Grabbing either handle of an Auto
/// key converts the key to Free: the other side keeps its stored numbers with
/// mode Free. The segment the written side shapes becomes Spline so the number
/// is read. With `Smooth` continuity, when the OPPOSITE side's segment is
/// Spline, that side is rotated to the same value slope in the same returned
/// track, keeping its x (the slope helpers in shared/tangents.ts; skipped when
/// no finite y does it — a flat neighbour or an x at its degenerate bound).
/// Main's "out wins" solve then finds the pair already consistent — exactly
/// when `out` was written, and up to f64 rounding when `in` was, since main
/// re-derives `in.y` from the `out` computed here.
export function setTangent(
  track: AnimTrack<number>,
  id: string,
  side: "in" | "out",
  xy: { x: number; y: number },
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value.slice();
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) return track;
  const k = keys[i]!;
  const prev = keys[i - 1];
  const next = keys[i + 1];
  const written = freeSide(clamp01(xy.x), xy.y);
  const other = side === "in" ? k.out : k.in;
  const otherFree: Tangent = other.mode === "Free" ? other : { ...other, mode: "Free" };
  let inSide = side === "in" ? written : otherFree;
  let outSide = side === "out" ? written : otherFree;

  if (k.continuity === "Smooth") {
    const dtPrev = prev ? k.t_us - prev.t_us : 0;
    const dvPrev = prev ? k.value - prev.value : 0;
    const dtNext = next ? next.t_us - k.t_us : 0;
    const dvNext = next ? next.value - k.value : 0;
    if (side === "out" && prev && prev.segment.kind === "Spline") {
      const m = outSlope(written, dtNext, dvNext);
      const y = m === null ? null : inYForSlope(otherFree.x, m, dtPrev, dvPrev);
      if (y !== null) inSide = freeSide(otherFree.x, y);
    }
    if (side === "in" && next && k.segment.kind === "Spline") {
      const m = inSlope(written, dtPrev, dvPrev);
      const y = m === null ? null : outYForSlope(otherFree.x, m, dtNext, dvNext);
      if (y !== null) outSide = freeSide(otherFree.x, y);
    }
  }

  keys[i] = {
    ...k,
    in: inSide,
    out: outSide,
    ...(side === "out" && next ? { segment: { kind: "Spline" } as const } : {}),
  };
  if (side === "in" && prev) keys[i - 1] = { ...prev, segment: { kind: "Spline" } };
  return { ...track, value: keys };
}

/// Set key `id`'s continuity. Switching to `Smooth` with both sides Free and
/// both adjacent segments Spline rotates `in` to `out`'s slope at once ("out
/// wins", the same rule main's solve applies), so the curve the user sees is
/// the curve that will be stored. `Broken` changes no number.
export function setContinuity(
  track: AnimTrack<number>,
  id: string,
  continuity: Continuity,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value.slice();
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) return track;
  const k = keys[i]!;
  const prev = keys[i - 1];
  const next = keys[i + 1];
  let inSide = k.in;
  if (
    continuity === "Smooth" &&
    k.in.mode === "Free" &&
    k.out.mode === "Free" &&
    prev && prev.segment.kind === "Spline" &&
    next && k.segment.kind === "Spline"
  ) {
    const m = outSlope(k.out, next.t_us - k.t_us, next.value - k.value);
    const y = m === null ? null : inYForSlope(k.in.x, m, k.t_us - prev.t_us, k.value - prev.value);
    if (y !== null) inSide = freeSide(k.in.x, y);
  }
  keys[i] = { ...k, in: inSide, continuity };
  return { ...track, value: keys };
}

/// Patch the track's extrapolation, one side or both; a Static track has none
/// and is returned as is.
export function setExtrapolation(
  track: AnimTrack<number>,
  patch: { before?: Extrapolate | undefined; after?: Extrapolate | undefined },
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  return {
    ...track,
    extrapolate: {
      before: patch.before ?? track.extrapolate.before,
      after: patch.after ?? track.extrapolate.after,
    },
  };
}

export type { Keyframe };
