// The one funnel every MULTI-target keyframe operation goes through: group a
// selection by (layerId, paramKey), fold each group's edit into one next
// `AnimTrack`, and hand the whole set to `updateParamTracksMulti` so a selection
// spanning layers still costs ONE undo entry. Batch Delete, batch easing, Auto
// and extrapolation are the same call with a different `edit`; a menu row's
// hover preview is the same fold without the commit.
//
// Everything above `KeyframeBatchContext` is pure and takes measured/committed
// data as arguments; the context at the bottom carries only what a consumer
// cannot compute for itself — the two commit shapes, the fold, and the
// composition a gesture measures against.
//
// The retime gestures' arithmetic is NOT here: they compute a whole next track
// per group rather than folding an edit, and that lives in
// `keyframe/batchRetime.ts`.
import { createContext, useContext, useMemo } from "react";

import type {
  AnimTrack,
  Extrapolate,
  Interpolation,
  Keyframe,
  LayerSummary,
  ProjectSummary,
  TrackSummary,
} from "../ipc";
import { updateParamTracksMulti } from "../ipc";
import { logMutationFailure } from "../errors/tryMutate";
import type { Grid } from "../keyframe/batchRetime";
import { animatableParams, readParamTrack, scaleFanOutFor } from "../keyframe/descriptors";
import { setAuto, setExtrapolation, setSegmentEasing, type TrackValue } from "../keyframe/edits";
import { fanOutEntries } from "../keyframe/fanOut";
import {
  clearKeyframeSelection,
  getSelectedKeyframes,
  type SelectedKeyframe,
} from "../keyframe/selectionStore";
import { useProjectStore } from "../state/projectStore";

export type KeyframedTrack<T extends TrackValue = TrackValue> = Extract<
  AnimTrack<T>,
  { mode: "Keyframed" }
>;

/// One `updateParamTracksMulti` entry — the layer names itself, which is what
/// lets a cross-layer batch stay one op. The value type follows the param.
export type ParamTrackEntry<T extends TrackValue = TrackValue> = [
  layerId: string,
  paramKey: string,
  track: AnimTrack<T>,
];

/// One group's whole edit: that group's committed track, every selected key id
/// on it, and the param descriptor's `fallback` for an edit that empties the
/// track. Returns the next track; never mutates the one it is given.
///
/// Polymorphic in the value type rather than fixed per edit: one batch folds
/// the SAME edit over a number group and a colour group, so an edit cannot
/// choose a `T` — it works for whichever the group holds and hands back a
/// track of that same type.
export type KeyframeGroupEdit = <T extends TrackValue>(
  track: KeyframedTrack<T>,
  kfIds: readonly string[],
  fallback: T,
) => AnimTrack<T>;

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
  if (remaining.length > 0) return { ...track, value: remaining };
  return { mode: "Static", value: track.value[track.value.length - 1]?.value ?? fallback };
};

/// Set one easing on the segment leaving every selected key of a group. Folds
/// the existing per-key editor: unlike a removal, setting an easing cannot
/// change which keys the next step of the fold finds.
export function applySegmentEasingKeys(easing: Interpolation): KeyframeGroupEdit {
  return function applyEasing<T extends TrackValue>(
    track: KeyframedTrack<T>,
    kfIds: readonly string[],
  ): AnimTrack<T> {
    return kfIds.reduce<AnimTrack<T>>((acc, id) => setSegmentEasing(acc, id, easing), track);
  };
}

/// Set Auto on every selected key of a group — one `setAuto` over the
/// selection (it marks the keys and splines their neighbouring segments; the
/// coordinates are solved when the actor stores the track).
export const setAutoKeys: KeyframeGroupEdit = (track, kfIds) => setAuto(track, kfIds);

/// Patch the group's extrapolation. A track-level write: the selected keys only
/// name the group, so the patch reaches the track however many of its keys are
/// selected.
export function setExtrapolationKeys(patch: {
  before?: Extrapolate | undefined;
  after?: Extrapolate | undefined;
}): KeyframeGroupEdit {
  return (track) => setExtrapolation(track, patch);
}

/// The fold with no edit: every group's COMMITTED track under its address — how
/// a menu reads the whole selection's keys, since the fold is the one place the
/// selection meets the tracks.
export const IDENTITY_EDIT: KeyframeGroupEdit = (track) => track;

/// The selected keys of one folded group, in the track's order.
export function selectedKeysOf<T extends TrackValue>(
  entry: ParamTrackEntry<T>,
  selected: readonly SelectedKeyframe[],
): Keyframe<T>[] {
  const [layerId, paramKey, track] = entry;
  if (track.mode !== "Keyframed") return [];
  const ids = new Set(
    selected.filter((s) => s.layerId === layerId && s.paramKey === paramKey).map((s) => s.kfId),
  );
  return track.value.filter((k) => ids.has(k.id));
}

/// One (layerId, paramKey) group of a selection, resolved against the project:
/// the layer it addresses, that layer's committed track, the selected key ids
/// on it, and the param's `fallback`. The step every batch operation shares —
/// an `edit` fold, a retime that needs the layer's own geometry, a menu reading
/// what the selection holds.
export interface SelectionGroup {
  layerId: string;
  paramKey: string;
  layer: LayerSummary;
  track: KeyframedTrack;
  fallback: TrackValue;
  kfIds: string[];
}

/// The selection's groups, in the order they first appear in `selected`. A
/// group whose layer, param or track is gone (Static, or a param this kind does
/// not carry) is dropped — there is no track for an operation to act on.
export function selectionGroups(args: {
  selected: readonly SelectedKeyframe[];
  tracks: readonly TrackSummary[];
}): SelectionGroup[] {
  const layerById = new Map<string, LayerSummary>();
  for (const track of args.tracks) {
    for (const layer of track.layers) layerById.set(layer.id, layer);
  }
  const byAddress = new Map<string, { layerId: string; paramKey: string; kfIds: string[] }>();
  for (const sel of args.selected) {
    const key = `${sel.layerId}|${sel.paramKey}`;
    const group = byAddress.get(key);
    if (group) group.kfIds.push(sel.kfId);
    else byAddress.set(key, { layerId: sel.layerId, paramKey: sel.paramKey, kfIds: [sel.kfId] });
  }
  const groups: SelectionGroup[] = [];
  for (const group of byAddress.values()) {
    const layer = layerById.get(group.layerId);
    if (layer === undefined) continue;
    const track = readParamTrack(layer.params, group.paramKey);
    if (track === null || track.mode !== "Keyframed") continue;
    const fallback =
      animatableParams(layer.kind).find((d) => d.paramKey === group.paramKey)?.fallback ?? 0;
    groups.push({ ...group, layer, track, fallback });
  }
  return groups;
}

/// The selection's entries for `updateParamTracksMulti`, one per group.
export function batchParamTrackEntries(args: {
  selected: readonly SelectedKeyframe[];
  tracks: readonly TrackSummary[];
  edit: KeyframeGroupEdit;
}): ParamTrackEntry[] {
  return selectionGroups(args).map((g) => [
    g.layerId,
    g.paramKey,
    args.edit(g.track, g.kfIds, g.fallback),
  ]);
}

/// Every composition's tracks, flattened. A keyframe selection is addressed by
/// layer id alone and layer ids are unique project-wide, so an operation raised
/// from the keyboard has to look wherever the selection actually lives — the
/// focused timeline's tracks are not necessarily it.
export function projectTracks(summary: ProjectSummary | null): TrackSummary[] {
  if (summary === null) return [];
  return Object.values(summary.compositions).flatMap((c) => c.tracks);
}

/// Delete the whole keyframe selection, wherever in the project it lives, in
/// ONE op. `false` when there was nothing to delete — the caller's signal not
/// to refresh.
///
/// Project-wide rather than per-Panel because the keyboard raises it: layer ids
/// are unique across compositions, and the selected keys need not sit in the
/// timeline that happens to hold focus.
///
/// The selection is cleared whatever the commit does. A failed write leaves the
/// keys standing but their SELECTION is a transient the user cannot see failed,
/// and keeping it armed would aim the next Delete at keys the user believes are
/// already gone.
export async function deleteSelectedKeyframes(): Promise<boolean> {
  const { summary, layerById } = useProjectStore.getState();
  const entries = expandScaleFanOut(
    batchParamTrackEntries({
      selected: getSelectedKeyframes(),
      tracks: projectTracks(summary),
      edit: removeKeys,
    }),
    (id) => layerById.get(id) ?? null,
  );
  clearKeyframeSelection();
  if (entries.length === 0) return false;
  try {
    await updateParamTracksMulti(entries);
  } catch (e) {
    logMutationFailure(e, "Delete keyframes");
    return false;
  }
  return true;
}

/// Expand a linked layer's scale write into both axes.
///
/// LANDMINE: main's twin invariant reads a lone `scale_x` write as divergence
/// and silently unlinks the layer, so every commit path — not just the one that
/// authored the track — has to fan out.
export function expandScaleFanOut(
  entries: readonly ParamTrackEntry[],
  layerOf: (layerId: string) => LayerSummary | null,
): ParamTrackEntry[] {
  return entries.flatMap<ParamTrackEntry>(([layerId, paramKey, next]) => {
    const fanOut = scaleFanOutFor(paramKey, layerOf(layerId)?.params ?? null);
    if (fanOut === null) return [[layerId, paramKey, next]];
    return fanOutEntries(fanOut, next).map(([key, track]) => [layerId, key, track]);
  });
}

/// Applies one edit to the whole keyframe selection, in one commit.
export type KeyframeBatchCommit = (edit: KeyframeGroupEdit) => void;

/// The same fold WITHOUT the commit: what the selection's tracks would become.
/// A menu previews its armed row through it (`easingPreviewStore`), and reads
/// the selection's committed keys through it with `IDENTITY_EDIT`.
export type KeyframeBatchFold = (edit: KeyframeGroupEdit) => ParamTrackEntry[];

/// Commit precomputed entries. The retime gestures compute a whole next track
/// per group from measured pointer travel, so they have nothing for the group
/// fold to apply — same scale fan-out, same single undo entry.
export type KeyframeEntriesCommit = (entries: readonly ParamTrackEntry[]) => void;

export interface KeyframeBatch {
  commit: KeyframeBatchCommit;
  fold: KeyframeBatchFold;
  /// The three below are what a GESTURE needs on top of the fold: its own
  /// commit shape, the composition's layers (for the geometry a group retime
  /// meets every group on) and the grid it snaps to. Optional so a surface can
  /// still mount over a bare fold — a menu previewing an easing needs none of
  /// them — and `useKeyframeOps` supplies inert stand-ins when they are absent.
  commitEntries?: KeyframeEntriesCommit;
  tracks?: readonly TrackSummary[];
  fps?: Grid;
}

/// The whole gesture surface, with every optional member resolved.
export interface KeyframeOps {
  commit: KeyframeBatchCommit;
  commitEntries: KeyframeEntriesCommit;
  tracks: readonly TrackSummary[];
  fps: Grid;
}

/// A context rather than a prop: the menus that raise these operations sit two
/// and three components below the Timeline that owns the project's tracks, and
/// `TrackLane` in between has no part in a keyframe operation — the same
/// argument `MarqueeAnchorContext` makes.
export const KeyframeBatchContext = createContext<KeyframeBatch | null>(null);

const NO_COMMIT: KeyframeBatchCommit = () => {};
const NO_FOLD: KeyframeBatchFold = () => [];

/// The commit for a consumer inside the Timeline's provider. Outside it these
/// operations are inert rather than a crash, so a keyframe menu still opens
/// where nothing owns the project — but it cannot write, so a surface that
/// means to edit must be under the provider.
export function useKeyframeBatchCommit(): KeyframeBatchCommit {
  return useContext(KeyframeBatchContext)?.commit ?? NO_COMMIT;
}

/// The fold for a consumer inside the provider; outside it the selection folds
/// to nothing, so a preview shows nothing rather than a wrong track.
export function useKeyframeBatchFold(): KeyframeBatchFold {
  return useContext(KeyframeBatchContext)?.fold ?? NO_FOLD;
}

const NO_ENTRIES_COMMIT: KeyframeEntriesCommit = () => {};
const NO_TRACKS: readonly TrackSummary[] = [];
/// A degenerate rate the snap primitives pass through untouched, so a gesture
/// raised outside the provider measures nothing rather than snapping to a rate
/// nobody named.
const NO_GRID: Grid = { num: 0, den: 0 };

/// The gesture surface for a consumer inside the provider. Outside it every
/// member is inert, which is the same bargain `useKeyframeBatchCommit` makes:
/// a surface that means to edit must sit under the Timeline that owns the
/// project, and one that does not still renders.
export function useKeyframeOps(): KeyframeOps {
  const ctx = useContext(KeyframeBatchContext);
  // Memoized on the context value, which the provider already keeps stable
  // between edits: a gesture handler takes this as a dependency, and a fresh
  // object every render would rebuild every diamond's handler with it.
  return useMemo(
    () => ({
      commit: ctx?.commit ?? NO_COMMIT,
      commitEntries: ctx?.commitEntries ?? NO_ENTRIES_COMMIT,
      tracks: ctx?.tracks ?? NO_TRACKS,
      fps: ctx?.fps ?? NO_GRID,
    }),
    [ctx],
  );
}
