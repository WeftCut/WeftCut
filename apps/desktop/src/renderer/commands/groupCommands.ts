// The Group gestures as commands: make one, dissolve one, enter one, add to
// one, and move a selection into any composition by name. None of them LEAVES a
// Group — under a tab strip, leaving is closing its tab or activating another
// (ADR 0053).
//
// Self-contained — each reads the stores it needs and commits through IPC — so
// App lends them a `HandlerMap` slot and nothing else. That is what puts them in
// App's catalogue rather than Timeline's provider: a command registered by
// Timeline vanishes with the Timeline Panel, and these belong in the Edit
// menu, which must not lose rows when a Panel is closed
// (`menu/contextMenuCommands.test.ts` states the rule).
//
// The `project:changed` subscription refreshes every view, so none of them needs
// App's `refresh`.

import {
  groupsAddMembers,
  groupsCreate,
  groupsUngroup,
  moveLayersToComposition,
} from "../ipc";
import { logMutationFailure } from "../errors/tryMutate";
import { openComposition } from "../state/compositionAnchorStore";
import { rememberPrecompose } from "../state/precomposeSelection";
import {
  clearLayerSelection,
  currentSelection,
  layerIdsOf,
  primaryLayerIdOf,
  setLayerSelection,
} from "../state/selectionStore";
import {
  addToGroupTarget,
  canAddToGroupSelection,
  canGroupSelection,
  canUngroupSelection,
  selectedGroupLayer,
} from "../timeline/groupEligibility";
import {
  canMoveSelectionToRoot,
  moveLandingUs,
  moveToCompositionSet,
  moveToRootTarget,
} from "../timeline/moveToCompositionEligibility";

/// Pre-compose the selection (`Mod+G`). The new Group layer becomes the
/// selection, which is what makes `Mod+Shift+G` immediately undo the act by hand
/// and what a following inspector edit acts on — AE and Premiere both leave the
/// new container selected.
///
/// The selection is read from the store, not from a captured value: the gate
/// (`groupEligibility.ts`) is evaluated live for the same reason, and App does
/// not re-render on a multi-select change.
export async function groupSelected(): Promise<void> {
  const selection = currentSelection();
  const layerIds = [...layerIdsOf(selection)];
  // Prevented by the command's `enabled`; a strip button built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (layerIds.length === 0) return;
  try {
    const { composition_id, layer_id } = await groupsCreate(layerIds);
    rememberPrecompose(composition_id, layerIds, primaryLayerIdOf(selection));
    setLayerSelection(layer_id, [layer_id]);
  } catch (err) {
    logMutationFailure(err, "groups_create");
  }
}

/// Ungroup the one selected Group layer (`Mod+Shift+G`). The gate greys the
/// command out for a non-plain Group and names the field; the actor still
/// refuses `blend_mode`, which is not on the wire, and that refusal surfaces as
/// its own status line.
export async function ungroupSelected(): Promise<void> {
  const layer = selectedGroupLayer();
  if (!layer) return;
  try {
    await groupsUngroup(layer.id);
  } catch (err) {
    logMutationFailure(err, "groups_ungroup");
  }
}

/// Move the rest of the selection into the one selected Group's composition —
/// the crossing reached by pointing at the destination clip, where the
/// `move_layers_to_composition` op is the one reached by naming a composition
/// and a time. The members keep their screen position; a destination that grows
/// shows as overhang rather than rewriting the Group's window.
///
/// The selection is read from the store rather than captured, for the sibling's
/// reason: App does not re-render on a multi-select change.
///
/// The Group clip becomes the selection afterwards BECAUSE the members have
/// left this composition — the old selection cannot survive as-is, and the
/// Group is what now represents them, sits under the cursor, and gives the
/// inspector something to show.
export async function addToGroupSelected(): Promise<void> {
  const group = addToGroupTarget();
  if (!group) return;
  const layerIds = [...layerIdsOf(currentSelection())].filter(
    (id) => id !== group.id,
  );
  // Same honest no-target answer `groupSelected` gives: the command's `enabled`
  // prevents this, but a menu row built before the selection changed can still
  // reach here.
  if (layerIds.length === 0) return;
  try {
    await groupsAddMembers(layerIds, group.id);
    setLayerSelection(group.id, [group.id]);
  } catch (err) {
    logMutationFailure(err, "groups_add_members");
  }
}

/// Move the selection into `destCompositionId` — the crossing reached by NAMING
/// a composition, where `addToGroupSelected` is the one reached by pointing at
/// a Group clip. The members land at the destination's own reading of the one
/// moment (`moveLandingUs`), on lanes that bounce, so the gesture needs neither
/// a second timeline nor a pointer.
///
/// The landing is resolved HERE and not when the menu was built: an open popup
/// does not re-render while the film plays under it, and a time read at
/// right-click would put the clips where the playhead used to be.
///
/// The selection is CLEARED afterwards and the source composition keeps focus.
/// The layers left this composition, so the old selection cannot survive as-is;
/// following them would move the view out from under a gesture that never left
/// this Panel — which is exactly what separates this from a drag, where the
/// user pointed at the destination themselves.
export async function moveSelectionToComposition(
  destCompositionId: string,
): Promise<void> {
  const set = moveToCompositionSet();
  // Same honest no-target answer `groupSelected` gives: the command's `enabled`
  // prevents this, but a menu row built before the selection changed can still
  // reach here.
  if (!set) return;
  try {
    await moveLayersToComposition(
      set.layerIds,
      destCompositionId,
      set.anchorLayerId,
      moveLandingUs(destCompositionId).tStartUs,
      null,
    );
    clearLayerSelection();
  } catch (err) {
    logMutationFailure(err, "move_layers_to_composition");
  }
}

/// The catalogued, destination-less form — the Edit menu row, the palette
/// entry, a key someone binds. It means the ROOT, which is what "put these back
/// into the film" asks for and the one destination a surface with no room for a
/// list can name unambiguously; `moveToRootTarget` greys it everywhere else
/// (`timeline/moveToCompositionEligibility.ts` says why it is not "the first
/// eligible row").
export async function moveSelectionToRoot(): Promise<void> {
  const rootId = moveToRootTarget();
  if (rootId === null) return;
  await moveSelectionToComposition(rootId);
}

/// Enter the selected Group — the keyboard/palette half of the double-click:
/// ensure the Group has a timeline Panel of its own, and make it the one the
/// keyboard acts on. Carries the Group LAYER through, so the Panel is anchored
/// on the placement the user reached it by rather than on a path reconstructed
/// from the root.
export function openSelectedGroup(): void {
  const layer = selectedGroupLayer();
  if (!layer || layer.params.kind !== "CompositionRef") return;
  openComposition(layer.params.composition_id, layer.id);
}

export {
  canAddToGroupSelection,
  canGroupSelection,
  canMoveSelectionToRoot,
  canUngroupSelection,
};

/// `openGroup` is enabled by what is reachable, not by what is selected:
/// entering needs a Group under the cursor's selection.
export function canOpenSelectedGroup(): boolean {
  return selectedGroupLayer() !== null;
}
