// The one funnel every MULTI-target keyframe operation goes through: group a
// selection by (layerId, paramKey), fold each group's edit into one next
// `AnimTrack`, and hand the whole set to `updateParamTracksMulti` so a selection
// spanning layers still costs ONE undo entry. Batch Delete and batch easing are
// the same call with a different `edit`.
//
// Everything above `KeyframeBatchContext` is pure and takes measured/committed
// data as arguments; the context at the bottom carries only the commit itself.
import { createContext, useContext } from "react";

import type { AnimTrack, Interpolation, LayerSummary, TrackSummary } from "../ipc";
import { animatableParams, readParamTrack } from "../keyframe/descriptors";
import { setKeyframeInterp, smoothKeyframe } from "../keyframe/edits";
import type { SelectedKeyframe } from "../keyframe/selectionStore";

type KeyframedTrack = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

/// One `updateParamTracksMulti` entry — the layer names itself, which is what
/// lets a cross-layer batch stay one op.
export type ParamTrackEntry = [layerId: string, paramKey: string, track: AnimTrack<number>];

/// One group's whole edit: that group's committed track, every selected key id
/// on it, and the param descriptor's `fallback` for an edit that empties the
/// track. Returns the next track; never mutates the one it is given.
export type KeyframeGroupEdit = (
  track: KeyframedTrack,
  kfIds: readonly string[],
  fallback: number,
) => AnimTrack<number>;

/// Delete every selected key of a group in ONE pass over `track.value`.
/// `removeKeyframe` applied key by key would re-read a track the previous
/// removal already rewrote, while every caller here holds the ORIGINAL track.
///
/// Emptying the track collapses it to a Static the way `removeKeyframe`'s last
/// key does. It holds the value of the track's LAST key, chosen so the result
/// cannot depend on the order a box swept the selection in — no value preserves
/// the animation the removed keys drew, so determinism is what is left to pick
/// for. `fallback` is the answer for a Keyframed track that carried no keys at
/// all, and it is per param, so a batch emptying several tracks must reach each
/// one's own.
export const removeKeys: KeyframeGroupEdit = (track, kfIds, fallback) => {
  const drop = new Set(kfIds);
  const remaining = track.value.filter((k) => !drop.has(k.id));
  if (remaining.length > 0) return { mode: "Keyframed", value: remaining };
  return { mode: "Static", value: track.value[track.value.length - 1]?.value ?? fallback };
};

/// Set one interpolation on every selected key of a group. Folds the existing
/// per-key editor: unlike a removal, setting an interp cannot change which keys
/// the next step of the fold finds.
export function applyInterp(interp: Interpolation): KeyframeGroupEdit {
  return (track, kfIds) =>
    kfIds.reduce<AnimTrack<number>>((acc, id) => setKeyframeInterp(acc, id, interp), track);
}

/// Smooth every selected key of a group — `smoothTrack`'s fold narrowed to the
/// selection. Sequential ON PURPOSE: smoothing a key also rewrites its
/// PREVIOUS key's outgoing control point, so a later step has to see the
/// earlier one's result.
export const smoothKeys: KeyframeGroupEdit = (track, kfIds) =>
  kfIds.reduce<AnimTrack<number>>((acc, id) => smoothKeyframe(acc, id), track);

/// The selection's entries for `updateParamTracksMulti`, in the order the
/// groups first appear in `selected`. A group whose layer, param or track is
/// gone (Static, or a param this kind does not carry) contributes nothing —
/// there is no track for `edit` to fold into.
export function batchParamTrackEntries(args: {
  selected: readonly SelectedKeyframe[];
  tracks: readonly TrackSummary[];
  edit: KeyframeGroupEdit;
}): ParamTrackEntry[] {
  const layerById = new Map<string, LayerSummary>();
  for (const track of args.tracks) {
    for (const layer of track.layers) layerById.set(layer.id, layer);
  }
  const groups = new Map<string, { layerId: string; paramKey: string; kfIds: string[] }>();
  for (const sel of args.selected) {
    const key = `${sel.layerId}|${sel.paramKey}`;
    const group = groups.get(key);
    if (group) group.kfIds.push(sel.kfId);
    else groups.set(key, { layerId: sel.layerId, paramKey: sel.paramKey, kfIds: [sel.kfId] });
  }
  const entries: ParamTrackEntry[] = [];
  for (const group of groups.values()) {
    const layer = layerById.get(group.layerId);
    if (layer === undefined) continue;
    const track = readParamTrack(layer.params, group.paramKey);
    if (track === null || track.mode !== "Keyframed") continue;
    const fallback =
      animatableParams(layer.kind).find((d) => d.paramKey === group.paramKey)?.fallback ?? 0;
    entries.push([group.layerId, group.paramKey, args.edit(track, group.kfIds, fallback)]);
  }
  return entries;
}

/// Applies one edit to the whole keyframe selection, in one commit.
export type KeyframeBatchCommit = (edit: KeyframeGroupEdit) => void;

/// A context rather than a prop: the menus that raise these operations sit two
/// and three components below the Timeline that owns the project's tracks, and
/// `TrackLane` in between has no part in a keyframe operation — the same
/// argument `MarqueeAnchorContext` makes.
export const KeyframeBatchContext = createContext<KeyframeBatchCommit | null>(null);

const NO_COMMIT: KeyframeBatchCommit = () => {};

/// The commit for a consumer inside the Timeline's provider. Outside it these
/// operations are inert rather than a crash, so a keyframe menu still opens
/// where nothing owns the project — but it cannot write, so a surface that
/// means to edit must be under the provider.
export function useKeyframeBatchCommit(): KeyframeBatchCommit {
  return useContext(KeyframeBatchContext) ?? NO_COMMIT;
}
