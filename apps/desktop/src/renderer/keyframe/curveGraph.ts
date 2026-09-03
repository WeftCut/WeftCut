// Pure value-graph geometry for the inline keyframe curve editor. Maps a
// segment's stored shape — the left key's class and leaving tangent, the right
// key's arriving tangent — into the (time, value) pixel space of a timeline
// sub-lane, and back, for rendering and in-place tangent-handle editing.
// Curved segments and the track's extrapolated tails are sampled through the
// SAME wasm eval the preview runs (`resolveAnimated`), so the display shows
// exactly what the engine computes — including the procedural kinds
// (Elastic/Bounce) and the five extrapolation modes, which have no JS math at
// all. Scalar-only: a colour has no value axis to draw. DOM-free — all
// geometry is explicit args so it unit-tests headless.
import type { Keyframe, TangentMode } from "../ipc";
import { resolveAnimated, type AnimTrack } from "../render/animated";
import { HOLD_EXTRAPOLATION, inIdentity, outIdentity } from "../../shared/keyframe";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/// What a segment reads from its LEFT key: the class and the leaving tangent.
export type SegmentLeft = Pick<Keyframe<number>, "segment" | "out">;
/// What a segment reads from its RIGHT key: the arriving tangent.
export type SegmentRight = Pick<Keyframe<number>, "in">;

/// Two-key throwaway track for sampling one segment through the wasm eval.
/// Fresh array per call ⇒ fresh resident-buffer handle (render/animated.ts
/// keys its cache by array reference), so build ONE track per segment and
/// evaluate all its samples against it. Ids never cross the ABI — dummies.
/// Hold/Hold extrapolation: the samples stay inside the segment.
function segmentTrack(
  aTUs: number, aVal: number, bTUs: number, bVal: number, left: SegmentLeft, right: SegmentRight,
): AnimTrack<number> {
  return {
    mode: "Keyframed",
    value: [
      { id: "seg-a", t_us: aTUs, value: aVal, in: inIdentity(), out: { ...left.out }, continuity: "Broken", segment: left.segment },
      { id: "seg-b", t_us: bTUs, value: bVal, in: { ...right.in }, out: outIdentity(), continuity: "Broken", segment: { kind: "Linear" } },
    ],
    extrapolate: HOLD_EXTRAPOLATION,
  };
}

/// Segment value at progress `u` via the wasm eval. Fractional µs truncate at
/// the ABI (≤1 µs ≪ one display pixel); u=0/u=1 clamp AT the keys, so segment
/// endpoints reproduce the key values exactly.
function sampleTrack(track: AnimTrack<number>, aTUs: number, aVal: number, bTUs: number, u: number): number {
  return resolveAnimated(track, aTUs + (bTUs - aTUs) * u, aVal);
}

export interface CurveGeom {
  /// zoom: timeline pixels per second.
  pxPerSec: number;
  /// layer start on the ruler (µs); keyframe t_us is layer-local.
  layerTStartUs: number;
  /// drawable lane height (px); curve fills [0, height], y-down.
  height: number;
  /// value-axis range mapped onto [0, height].
  vmin: number;
  vmax: number;
}

export interface Pt { x: number; y: number; }

/// Absolute ruler x (px) of a layer-local time. Same formula as
/// geometry.ts::keyframeAbsoluteX (inlined to keep this module DOM-free).
export function timeToXPx(tUsLocal: number, g: CurveGeom): number {
  return ((g.layerTStartUs + tUsLocal) / 1_000_000) * g.pxPerSec;
}

/// Inverse of timeToXPx → layer-local µs.
export function xPxToTimeUs(px: number, g: CurveGeom): number {
  return (px / g.pxPerSec) * 1_000_000 - g.layerTStartUs;
}

/// value → y px (higher value → smaller y).
export function valueToY(v: number, g: CurveGeom): number {
  const span = g.vmax - g.vmin;
  if (span <= 0) return g.height / 2;
  return ((g.vmax - v) / span) * g.height;
}

/// y px → value.
export function yToValue(py: number, g: CurveGeom): number {
  const span = g.vmax - g.vmin;
  if (span <= 0) return g.vmin;
  return g.vmax - (py / g.height) * span;
}

/// Min/max of the *rendered* value curve across all segments (samples eased
/// values so overshoot y∉[0,1] is included), padded so extremes aren't flush
/// to the lane edge. `also` widens the range with values drawn beside the keys
/// — the extrapolated tails, whose Offset / Continue modes leave the key range
/// and would otherwise run off the lane. Degenerate all-equal → a nominal ± band.
export function computeValueRange(
  keys: Pick<Keyframe<number>, "t_us" | "value" | "segment" | "out" | "in">[],
  padFrac = 0.1,
  samplesPerSeg = 32,
  also: readonly number[] = [],
): { vmin: number; vmax: number } {
  if (keys.length === 0) return { vmin: 0, vmax: 1 };
  let lo = Infinity;
  let hi = -Infinity;
  const note = (v: number) => {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (let i = 0; i < keys.length; i++) {
    note(keys[i]!.value);
    if (i < keys.length - 1) {
      const a = keys[i]!;
      const b = keys[i + 1]!;
      const dv = b.value - a.value;
      const curved = a.segment.kind !== "Hold" && a.segment.kind !== "Linear";
      // Δv==0 skips: eased or not, the lerp of equal endpoints is flat.
      if (curved && dv !== 0) {
        const track = segmentTrack(a.t_us, a.value, b.t_us, b.value, a, b);
        for (let s = 1; s < samplesPerSeg; s++) {
          note(sampleTrack(track, a.t_us, a.value, b.t_us, s / samplesPerSeg));
        }
      }
    }
  }
  for (const v of also) note(v);
  if (!isFinite(lo) || !isFinite(hi)) return { vmin: 0, vmax: 1 };
  if (hi === lo) {
    const half = Math.max(1, Math.abs(hi) * 0.1);
    return { vmin: lo - half, vmax: hi + half };
  }
  const pad = (hi - lo) * padFrac;
  return { vmin: lo - pad, vmax: hi + pad };
}

export interface Seg {
  aTUs: number;
  aVal: number;
  bTUs: number;
  bVal: number;
}

/// Per-segment sample density of the drawn curve.
export const SEGMENT_SAMPLES = 24;

/// Pixel polyline for one segment's value curve. Hold → flat then vertical
/// step; Linear → straight; curved (Spline/Elastic/Bounce) → sampled through
/// the wasm eval.
export function segmentPolyline(
  seg: Seg,
  left: SegmentLeft,
  right: SegmentRight,
  g: CurveGeom,
  samples = SEGMENT_SAMPLES,
): Pt[] {
  const xa = timeToXPx(seg.aTUs, g);
  const xb = timeToXPx(seg.bTUs, g);
  const ya = valueToY(seg.aVal, g);
  const yb = valueToY(seg.bVal, g);
  if (left.segment.kind === "Hold") return [{ x: xa, y: ya }, { x: xb, y: ya }, { x: xb, y: yb }];
  if (left.segment.kind === "Linear") return [{ x: xa, y: ya }, { x: xb, y: yb }];
  const track = segmentTrack(seg.aTUs, seg.aVal, seg.bTUs, seg.bVal, left, right);
  const out: Pt[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = s / samples;
    const v = sampleTrack(track, seg.aTUs, seg.aVal, seg.bTUs, u);
    out.push({ x: xa + (xb - xa) * u, y: valueToY(v, g) });
  }
  return out;
}

/// One extrapolated sample: layer-local time and the engine's value there.
export interface TimeValue { tUs: number; v: number; }

/// Ceiling on one tail's samples: an Offset tail over a long clip is many
/// periods, and past this the polyline is denser than the pixels it fills.
const EXTRAPOLATION_SAMPLES_MAX = 512;

/// How many samples a tail of `spanUs` gets: the per-segment density carried
/// over, i.e. `SEGMENT_SAMPLES` per average segment length of the key range
/// (`periodUs / segments`), clamped to `[2, EXTRAPOLATION_SAMPLES_MAX]`.
export function extrapolationSampleCount(spanUs: number, periodUs: number, segments: number): number {
  if (spanUs <= 0 || periodUs <= 0 || segments <= 0) return 2;
  const perSeg = periodUs / segments;
  const n = Math.ceil((spanUs / perSeg) * SEGMENT_SAMPLES);
  return Math.max(2, Math.min(EXTRAPOLATION_SAMPLES_MAX, n));
}

/// The track's value over `[fromUs, toUs]` OUTSIDE its key range, sampled
/// through the same `resolveAnimated` the preview runs — the wasm eval owns
/// the extrapolation math, so Loop's jump, PingPong's mirror, Offset's climb
/// and Continue's line are drawn as the engine will play them. The track is
/// the real one (its own `extrapolate`), never a throwaway. Inclusive of both
/// ends, so the tail meets the end key exactly.
export function sampleExtrapolation(
  track: AnimTrack<number>,
  fromUs: number,
  toUs: number,
  fallback: number,
  samples: number,
): TimeValue[] {
  const out: TimeValue[] = [];
  if (toUs <= fromUs || samples < 1) return out;
  for (let s = 0; s <= samples; s++) {
    const tUs = fromUs + ((toUs - fromUs) * s) / samples;
    out.push({ tUs, v: resolveAnimated(track, tUs, fallback) });
  }
  return out;
}

export function samplesToPolyline(samples: readonly TimeValue[], g: CurveGeom): Pt[] {
  return samples.map(({ tUs, v }) => ({ x: timeToXPx(tUs, g), y: valueToY(v, g) }));
}

/// A tangent handle's pixel position plus the mode of the side it draws, so
/// the graph can grey an Auto side.
export interface HandlePt extends Pt { mode: TangentMode; }

/// Tangent-handle control points (px) for a Spline segment, else null:
/// Hold/Linear have nothing to edit, and procedural segments (Elastic/Bounce)
/// have no coefficient representation — they render sampled-only. `out` is the
/// left key's leaving side, `in` the right key's arriving side (un-mirrored,
/// as stored): `x = xa + (xb − xa)·side.x`, `y = valueToY(aVal + side.y·Δv)`.
export function segmentHandles(
  seg: Seg,
  left: SegmentLeft,
  right: SegmentRight,
  g: CurveGeom,
): { out: HandlePt; in: HandlePt } | null {
  if (left.segment.kind !== "Spline") return null;
  const xa = timeToXPx(seg.aTUs, g);
  const xb = timeToXPx(seg.bTUs, g);
  const dv = seg.bVal - seg.aVal;
  return {
    out: { x: xa + (xb - xa) * left.out.x, y: valueToY(seg.aVal + left.out.y * dv, g), mode: left.out.mode },
    in: { x: xa + (xb - xa) * right.in.x, y: valueToY(seg.aVal + right.in.y * dv, g), mode: right.in.mode },
  };
}

/// New full coeffs after dragging one control point to (pointerXPx, pointerYPx).
/// `p1` is the left key's `out`, `p2` the right key's `in`. `x` clamps to [0,1]
/// (time stays monotone → bezier solver single-valued); `y` is free (overshoot
/// allowed). On a flat segment (Δv==0) the y cannot be inferred from value, so
/// keep the dragged point's current y.
export function handleDragToCoeff(
  which: "p1" | "p2",
  pointerXPx: number,
  pointerYPx: number,
  seg: Seg,
  g: CurveGeom,
  current: [number, number, number, number],
): [number, number, number, number] {
  const dt = seg.bTUs - seg.aTUs;
  const dv = seg.bVal - seg.aVal;
  const tLocal = xPxToTimeUs(pointerXPx, g);
  const cx = dt === 0
    ? (which === "p1" ? current[0] : current[2])
    : clamp01((tLocal - seg.aTUs) / dt);
  const curY = which === "p1" ? current[1] : current[3];
  const cy = dv === 0 ? curY : (yToValue(pointerYPx, g) - seg.aVal) / dv;
  return which === "p1"
    ? [cx, cy, current[2], current[3]]
    : [current[0], current[1], cx, cy];
}
