// Sampled envelope contract (docs/audio.md §The envelope contract). The
// drift-prone MATH — dB→linear and keyframe interpolation — now runs the shared
// weftcut-eval wasm (dbToLinear below + resolveAnimated; ADR 0025), so it can't
// diverge from Rust. The SAMPLER STRUCTURE here (the 10 ms grid loop, fade
// ramps, envelopeSegment lerp) is still parallel to native/src/audio/envelope.rs —
// keep those in step; the golden (audioEnvelopeGolden.fixture.json) guards them.

import { type AnimTrack, resolveAnimated } from "../animated";
import { crossfadeGain, dbToLinear, fadeMul } from "../../eval";

export const ENVELOPE_STEP_US = 10_000;

/// `values[k]` sits at `min(k * stepUs, spanUs)`, so the last segment is
/// usually shorter than a step.
export interface Envelope {
  stepUs: number;
  spanUs: number;
  /// length 1 ⇔ constant
  values: number[];
}

// dbToLinear (10^(db/20)) comes from the shared weftcut-eval wasm — ONE
// formula across renderer preview, the actor, and export. Re-exported so the
// role-gate twin and docs/audio.md's envelope contract keep a single source.
export { dbToLinear };

/// Fade multiplier at layer-local `tUs` — now the leaf `fade_mul` (wasm), the
/// single source shared with `audio/mix.rs`. Kept as a named export so callers
/// and docs/audio.md's envelope contract keep one entry point.
export function fadeMultiplier(
  tUs: number,
  spanUs: number,
  fadeInUs: number,
  fadeOutUs: number,
): number {
  return fadeMul(tUs, spanUs, fadeInUs, fadeOutUs);
}

function isAnimated(track: AnimTrack<number>): boolean {
  return track.mode === "Keyframed" && track.value.length > 1;
}

export interface AudioCrossfade {
  startUs: number;
  durationUs: number;
  incoming: boolean;
}

/// Gain envelope for one audio layer: linear(resolveAnimated(gainDb)) ×
/// fades. Static gain + no fades short-circuits to a single point.
export function sampleGain(
  gainDb: AnimTrack<number>,
  fadeInUs: number,
  fadeOutUs: number,
  spanUs: number,
  crossfades: readonly AudioCrossfade[] = [],
): Envelope {
  if (!isAnimated(gainDb) && fadeInUs === 0 && fadeOutUs === 0 && crossfades.length === 0) {
    return {
      stepUs: ENVELOPE_STEP_US,
      spanUs,
      values: [dbToLinear(resolveAnimated(gainDb, 0, 0))],
    };
  }
  const values: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.min(k * ENVELOPE_STEP_US, spanUs);
    values.push(
      dbToLinear(resolveAnimated(gainDb, t, 0)) *
        fadeMultiplier(t, spanUs, fadeInUs, fadeOutUs) *
        crossfades.reduce((gain, fade) => gain * crossfadeGain((t - fade.startUs) / fade.durationUs, fade.incoming), 1),
    );
    if (t >= spanUs) break;
  }
  return { stepUs: ENVELOPE_STEP_US, spanUs, values };
}

/// Pan envelope: plain sampling of the Animated pan, clamped to [-1, 1].
export function samplePan(pan: AnimTrack<number>, spanUs: number): Envelope {
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  if (!isAnimated(pan)) {
    return {
      stepUs: ENVELOPE_STEP_US,
      spanUs,
      values: [clamp(resolveAnimated(pan, 0, 0))],
    };
  }
  const values: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.min(k * ENVELOPE_STEP_US, spanUs);
    values.push(clamp(resolveAnimated(pan, t, 0)));
    if (t >= spanUs) break;
  }
  return { stepUs: ENVELOPE_STEP_US, spanUs, values };
}

/// Linear interp between grid points — mirrors `Envelope::eval`. The preview
/// scheduler uses this to cut per-chunk curve windows for
/// `setValueCurveAtTime` (which lerps between array entries natively).
export function evalEnvelope(e: Envelope, tUs: number): number {
  if (e.values.length === 0) return 1;
  if (e.values.length === 1) return e.values[0]!;
  const [i, j, u] = envelopeSegment(e, tUs);
  return e.values[i]! + (e.values[j]! - e.values[i]!) * u;
}

/// The control points straddling layer-local `tUs` and the fraction between
/// them; both indices name the same point outside the span. The last segment is
/// interpolated over its real length, not a full step, or a fade ending on a
/// frame edge stops short of its end value there. Twin of `Envelope::locate`;
/// needs two or more points.
export function envelopeSegment(e: Envelope, tUs: number): [number, number, number] {
  const last = e.values.length - 1;
  if (tUs <= 0) return [0, 0, 0];
  if (tUs >= e.spanUs) return [last, last, 0];
  const i = Math.min(Math.floor(tUs / e.stepUs), last - 1);
  const start = i * e.stepUs;
  const len = i + 1 === last ? e.spanUs - start : e.stepUs;
  return [i, i + 1, Math.min((tUs - start) / Math.max(len, 1), 1)];
}
