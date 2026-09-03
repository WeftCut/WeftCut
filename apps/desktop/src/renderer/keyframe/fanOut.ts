// Twin-write helper for composite (fan-out) descriptors: one authored track
// becomes the batch entries for every target key, in a single
// `update_layer_param_tracks` call (one commit, one undo). Pairs with the
// main-side twin invariant (main/state/mutations/scaleLink.ts): the batch
// result is twins, so a linked layer STAYS linked.
import type { AnimTrack } from "../ipc";
import { cloneExtrapolation, cloneKeyframeShape } from "../../shared/keyframe";

/// Structural copy with fresh keyframe ids. Ids are per-track identities (the
/// twin comparison ignores them) and the linked UI never surfaces the copy's
/// key, so re-minting on every fan-out orphans no selection. Generic in the
/// value type; `value` itself is copied by reference (`cloneKeyframeShape`).
export function twinTrackCopy<T>(track: AnimTrack<T>): AnimTrack<T> {
  if (track.mode === "Static") return { mode: "Static", value: track.value };
  return {
    mode: "Keyframed",
    value: track.value.map((k) => ({ id: crypto.randomUUID(), ...cloneKeyframeShape(k) })),
    extrapolate: cloneExtrapolation(track.extrapolate),
  };
}

/// Batch entries for a fan-out commit: the authored track under its own key,
/// a fresh-id twin under every other. `keys` is the descriptor's fanOutKeys.
export function fanOutEntries<T>(keys: string[], next: AnimTrack<T>): [string, AnimTrack<T>][] {
  return keys.map((key, i) => [key, i === 0 ? next : twinTrackCopy(next)]);
}
