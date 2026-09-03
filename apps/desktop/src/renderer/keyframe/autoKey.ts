// The shared read and write rules for one animatable param, used by the
// inspector rows and the timeline sub-lane surfaces alike. The write half
// (`autoKeyTrack`) pairs with `displayValue` in components/AnimatableField.tsx,
// which is the typed read; `resolveParamTrack` below is the read for a surface
// that is handed a param key and a fallback instead of a descriptor.
import type { AnimTrack, Rgba } from "../ipc";
import { resolveAnimated, resolveAnimatedColor } from "../render/animated";
import { upsertKeyframe, type TrackValue } from "./edits";

/// Generic over the value the param carries: a number for the transform axes,
/// opacity and the audio pair, an `Rgba` for a colour. The rule is the same for
/// both — a keyed track takes a key at the playhead, an unkeyed one just takes
/// the value — and only the type changes.
export function autoKeyTrack<T extends TrackValue>(
  track: AnimTrack<T>,
  tInLayerUs: number,
  val: T,
): AnimTrack<T> {
  return track.mode === "Keyframed"
    ? upsertKeyframe(track, tInLayerUs, val)
    : { mode: "Static", value: val };
}

/// A param track's value at a time, through the engine its value type belongs
/// to — `resolveAnimated` for a number, the OkLab colour leaf for an `Rgba`.
///
/// The FALLBACK is the witness for which one: a surface holding a param key and
/// a fallback (the timeline navigator, the sub-lane header) knows the value type
/// from that alone, and the descriptor it came from is what made them agree.
export function resolveParamTrack(
  track: AnimTrack<TrackValue>,
  tUs: number,
  fallback: TrackValue,
): TrackValue {
  return typeof fallback === "number"
    ? resolveAnimated(track as AnimTrack<number>, tUs, fallback)
    : resolveAnimatedColor(track as AnimTrack<Rgba>, tUs, fallback);
}
