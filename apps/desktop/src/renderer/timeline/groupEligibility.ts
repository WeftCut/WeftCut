// What Group / Ungroup would do to the current selection, and why not when
// not.
//
// The sibling of `linkEligibility.ts`, for the other half of ADR 0052: a Link
// propagates, a Group encapsulates. Same three shapes for the same two reasons
// — the Quick Actions strip is a Dock Panel, so it cannot read Timeline's
// locals and has to render the gate it dispatches; and `CommandDef.enabled` is
// evaluated during the strip's own render, so a subscribed form is the only one
// that re-evaluates.
//
// Two commands, not one toggle. Ctrl+L can be a toggle because a link's two
// directions are exact inverses over the same selection; Ctrl+G and
// Ctrl+Shift+G are not — pre-compose takes any number of layers, ungroup takes
// exactly one Group layer, and their preconditions overlap only on the case
// where both are impossible. Premiere, Resolve and AE all ship them as two
// keys, so two commands it is.
//
// Every disabled state is its own string BECAUSE the tooltip has to name which
// condition failed: "unlock the clips" and "reset the opacity" are different
// instructions, and a single "can't group that" would send the user looking.

import type { AnimTrack, LayerSummary, TrackSummary } from "../ipc";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import {
  compositionOrRoot,
  currentOpenComposition,
  useProjectStore,
} from "../state/projectStore";
import { useSelectionStore } from "../state/selectionStore";

/// Stable empty reference — a fresh `[]` per selector call would defeat the
/// reference-equality bail-out the hooks below rely on.
const NO_TRACKS: readonly TrackSummary[] = [];

/// `group` is the live direction; the rest are the disabled reasons, one per
/// tooltip string.
export type GroupState = "group" | "needs_selection" | "locked";

/// `ungroup` is the live direction. `needs_one_group` covers every shape
/// failure at once — nothing selected, two clips, one clip that is not a Group
/// — because they share one instruction ("select exactly one group clip"), and
/// three strings saying it would not help anyone. The `not_plain_*` trio does
/// NOT collapse the same way: each names a different field to reset.
export type UngroupState =
  | "ungroup"
  | "needs_one_group"
  | "locked"
  | "not_plain_transform"
  | "not_plain_opacity"
  | "not_plain_effects";

/// `add_to_group` is the live direction. Unlike Ungroup's `needs_one_group`,
/// the shape failures do NOT collapse: "select a group clip to add to" and
/// "select something to put in it" are two different things to go and do, and a
/// selection that has one is usually one step from having both.
export type AddToGroupState =
  | "add_to_group"
  | "needs_selection"
  | "needs_one_group"
  | "needs_member"
  | "locked"
  | "starts_before_group";

/// The reasons a Group layer is not plain that the WIRE can answer.
///
/// Twin of `main/state/mutations/groups.ts`'s `groupNotPlainReason`, minus its
/// fourth arm: `blend_mode` is not on the summary (`CompositionRefView` carries
/// the transform, the opacity and nothing else), so a non-Normal blend — which
/// only MCP can set — reaches the actor's own refusal instead of this gate.
/// That is the prevent-at-the-gesture / refuse-in-state split ADR 0052 §6
/// states for overhang, applied to the one field the renderer cannot see.
///
/// LANDMINE: the identity values are duplicated from main's `defaultTransform`
/// and nothing enforces the agreement. A drift here does not throw — it greys
/// Ungroup out on a plain Group, or offers it on one the actor will refuse.
export type GroupNotPlainReason = "transform" | "opacity" | "effects";

/// Null for a layer that is not a Group at all: there is nothing to expand, so
/// there is no reason to name. Every caller gates on the kind first.
export function groupNotPlainReason(
  layer: LayerSummary,
): GroupNotPlainReason | null {
  const p = layer.params;
  if (p.kind !== "CompositionRef") return null;
  const identity: Array<[AnimTrack<number>, number]> = [
    [p.x, 0],
    [p.y, 0],
    [p.scale_x, 1],
    [p.scale_y, 1],
    [p.rotation_deg, 0],
    [p.anchor_x, 0.5],
    [p.anchor_y, 0.5],
  ];
  for (const [track, value] of identity) {
    if (track.mode !== "Static" || track.value !== value) return "transform";
  }
  // The linked-scale default is part of the identity main compares against, so
  // a Group whose axes were unlinked is not plain even at scale 1 — unlinking is
  // an authored intent, and the members have no pair to carry it onto.
  if (!p.scale_linked) return "transform";
  if (p.opacity.mode !== "Static" || p.opacity.value !== 1) return "opacity";
  if (layer.effects.length > 0) return "effects";
  return null;
}

/// Every selected layer with the lane that holds it — the pair both predicates
/// need, since a lock lives on either.
function selectedWithTracks(
  selected: ReadonlySet<string>,
  tracks: readonly TrackSummary[],
): Array<{ layer: LayerSummary; track: TrackSummary }> {
  const out: Array<{ layer: LayerSummary; track: TrackSummary }> = [];
  for (const track of tracks) {
    for (const layer of track.layers) {
      if (selected.has(layer.id)) out.push({ layer, track });
    }
  }
  return out;
}

/// Pre-compose takes ONE OR MORE layers (AE allows one — a single layer wrapped
/// in a Group is how you give it a transform of its own).
///
/// The lock check mirrors the actor's, which refuses the whole set on any locked
/// member or lane rather than grouping the rest: a partial Group would be a
/// silent edit to a selection the user made deliberately. Gating here rather
/// than letting the refusal land is the prevent-at-the-gesture half of the same
/// rule.
export function groupState(
  selected: ReadonlySet<string>,
  tracks: readonly TrackSummary[],
): GroupState {
  const found = selectedWithTracks(selected, tracks);
  if (found.length === 0) return "needs_selection";
  if (found.some(({ layer, track }) => layer.locked || track.locked)) return "locked";
  return "group";
}

/// Ungroup takes exactly one selected Group layer, and only a plain one. The
/// order of the checks is the order the instructions get harder: pick the right
/// clip, unlock it, then reset whatever the expansion could not carry.
export function ungroupState(
  selected: ReadonlySet<string>,
  tracks: readonly TrackSummary[],
): UngroupState {
  const found = selectedWithTracks(selected, tracks);
  if (found.length !== 1) return "needs_one_group";
  const only = found[0]!;
  if (only.layer.params.kind !== "CompositionRef") return "needs_one_group";
  if (only.layer.locked || only.track.locked) return "locked";
  const reason = groupNotPlainReason(only.layer);
  if (reason !== null) return `not_plain_${reason}` as UngroupState;
  return "ungroup";
}

/// Add to Group takes the ONE selected Group clip as the destination and
/// everything else selected as the members. The order of the checks is the
/// order the instructions get harder: select something, name a destination,
/// give it something to carry, unlock what is moving, then move a clip the
/// destination has no room for.
///
/// "All in one composition" — the actor's first refusal — is enforced
/// STRUCTURALLY here, not checked. `selectedWithTracks` walks only the focused
/// composition's tracks, so a layer selected in another composition is simply
/// not found, exactly as `groupState` and `ungroupState` already behave. A
/// check would have nothing left to read.
///
/// There is no `cycle` state, and that is a consequence of the exactly-one
/// rule: the selection's only Group clip is spoken for as the destination, so
/// no MEMBER can be a Group, and the actor's `CompositionCycle` is reachable
/// only through MCP — as is its `RootComposition`, since no gesture makes a
/// Group clip that points at the root. That is the prevent-at-the-gesture /
/// refuse-in-state split this file already states for `blend_mode`. Loosening
/// exactly-one — nesting one Group inside another — is what would make a cycle
/// state necessary.
export function addToGroupState(
  selected: ReadonlySet<string>,
  tracks: readonly TrackSummary[],
): AddToGroupState {
  const found = selectedWithTracks(selected, tracks);
  if (found.length === 0) return "needs_selection";
  // The destination's own zero, expressed on THIS composition's clock: the
  // moment the Group clip's `src_in_us` points at. Computed inside the walk
  // because that is where the `CompositionRef` params are narrowed.
  let destination: { id: string; originUs: number } | null = null;
  let groupCount = 0;
  for (const { layer } of found) {
    const p = layer.params;
    if (p.kind !== "CompositionRef") continue;
    groupCount += 1;
    destination = { id: layer.id, originUs: layer.t_start_us - p.src_in_us };
  }
  // Zero, or two and more: with two, nothing in the selection says which is the
  // destination and which is moving.
  if (groupCount !== 1 || !destination) return "needs_one_group";
  const target = destination;
  const members = found.filter(({ layer }) => layer.id !== target.id);
  if (members.length === 0) return "needs_member";
  // MEMBERS only. The destination's own lock is deliberately not consulted —
  // the actor does not consult it either, because this op never writes the
  // Group clip, and a lock protects a layer from being edited, not the
  // composition it happens to point at. Widening this to `found` would grey the
  // row out on a gesture the actor would have accepted.
  if (members.some(({ layer, track }) => layer.locked || track.locked)) {
    return "locked";
  }
  // The gesture-side half of the actor's `InvalidArgument`: a member that would
  // land before the destination's zero has nowhere in composition time to go.
  if (members.some(({ layer }) => layer.t_start_us < target.originUs)) {
    return "starts_before_group";
  }
  return "add_to_group";
}

function currentTracks(): readonly TrackSummary[] {
  return currentOpenComposition()?.tracks ?? NO_TRACKS;
}

/// Imperative forms, for `CommandDef.enabled` and the App handlers — both run
/// where there is no React.
export function groupForSelection(): GroupState {
  return groupState(useSelectionStore.getState().selectedLayerIds, currentTracks());
}

export function ungroupForSelection(): UngroupState {
  return ungroupState(useSelectionStore.getState().selectedLayerIds, currentTracks());
}

export function addToGroupForSelection(): AddToGroupState {
  return addToGroupState(
    useSelectionStore.getState().selectedLayerIds,
    currentTracks(),
  );
}

export function canGroupSelection(): boolean {
  return groupForSelection() === "group";
}

export function canUngroupSelection(): boolean {
  return ungroupForSelection() === "ungroup";
}

export function canAddToGroupSelection(): boolean {
  return addToGroupForSelection() === "add_to_group";
}

/// The Group layer the selection is, or null — what `openGroup` acts on, and
/// the inspector's own answer to "is this clip a Group". Read imperatively for
/// the same reason the predicates above are.
export function selectedGroupLayer(): LayerSummary | null {
  const selected = useSelectionStore.getState().selectedLayerIds;
  if (selected.size !== 1) return null;
  const found = selectedWithTracks(selected, currentTracks());
  const only = found[0];
  return only && only.layer.params.kind === "CompositionRef" ? only.layer : null;
}

/// The Group clip the selection would add TO — its one `CompositionRef`, or
/// null. Distinct from `selectedGroupLayer`, which insists the Group is the
/// WHOLE selection: here the rest of the selection is exactly what moves, so it
/// is the thing being tolerated rather than the thing ruling the answer.
///
/// Answers a destination even when the gesture is not live, so a greyed row can
/// still name the Group it would have added to.
export function addToGroupTarget(): LayerSummary | null {
  const selected = useSelectionStore.getState().selectedLayerIds;
  const groups = selectedWithTracks(selected, currentTracks()).filter(
    ({ layer }) => layer.params.kind === "CompositionRef",
  );
  return groups.length === 1 ? groups[0]!.layer : null;
}

/**
 * Subscription forms — two stores, two subscriptions, neither of them a
 * composite selector (`feedback_zustand_composite_selector`), exactly as
 * `useLinkToggleState` does it.
 *
 * The selection subscription yields the Set's own reference, which is stable
 * between selection changes; the project subscription closes over it and yields
 * a STRING, so an unrelated project mutation re-runs the predicate and then
 * bails out instead of re-rendering.
 */
export const useGroupState = (): GroupState => {
  const selected = useSelectionStore((s) => s.selectedLayerIds);
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) =>
    groupState(selected, compositionOrRoot(s.summary, focusedId)?.tracks ?? NO_TRACKS),
  );
};

export const useUngroupState = (): UngroupState => {
  const selected = useSelectionStore((s) => s.selectedLayerIds);
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) =>
    ungroupState(selected, compositionOrRoot(s.summary, focusedId)?.tracks ?? NO_TRACKS),
  );
};

export const useAddToGroupState = (): AddToGroupState => {
  const selected = useSelectionStore((s) => s.selectedLayerIds);
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  return useProjectStore((s) =>
    addToGroupState(
      selected,
      compositionOrRoot(s.summary, focusedId)?.tracks ?? NO_TRACKS,
    ),
  );
};
