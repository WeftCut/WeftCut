// The four Group gestures as commands: make one, dissolve one, enter one, add
// to one. None of them LEAVES a Group — under a tab strip, leaving is closing
// its tab or activating another (ADR 0053).
//
// Self-contained — each reads the stores it needs and commits through IPC — so
// App lends them a `HandlerMap` slot and nothing else. That is what puts them in
// App's catalogue rather than Timeline's provider: a command registered by
// Timeline vanishes with the Timeline Panel, and these four belong in the Edit
// menu, which must not lose rows when a Panel is closed
// (`menu/contextMenuCommands.test.ts` states the rule).
//
// The `project:changed` subscription refreshes every view, so none of them needs
// App's `refresh`.

import { groupsAddMembers, groupsCreate, groupsUngroup } from "../ipc";
import { logMutationFailure } from "../errors/tryMutate";
import { openComposition } from "../state/compositionAnchorStore";
import { rememberPrecompose } from "../state/precomposeSelection";
import { setLayerSelection, useSelectionStore } from "../state/selectionStore";
import {
  addToGroupTarget,
  canAddToGroupSelection,
  canGroupSelection,
  canUngroupSelection,
  selectedGroupLayer,
} from "../timeline/groupEligibility";

/// Pre-compose the selection (`Mod+G`). The new Group layer becomes the
/// selection, which is what makes `Mod+Shift+G` immediately undo the act by hand
/// and what a following inspector edit acts on — AE and Premiere both leave the
/// new container selected.
///
/// The selection is read from the store, not from a captured value: the gate
/// (`groupEligibility.ts`) is evaluated live for the same reason, and App does
/// not re-render on a multi-select change.
export async function groupSelected(): Promise<void> {
  const selection = useSelectionStore.getState();
  const layerIds = [...selection.selectedLayerIds];
  // Prevented by the command's `enabled`; a strip button built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (layerIds.length === 0) return;
  try {
    const { composition_id, layer_id } = await groupsCreate(layerIds);
    rememberPrecompose(composition_id, layerIds, selection.primaryLayerId);
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
  const layerIds = [...useSelectionStore.getState().selectedLayerIds].filter(
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

export { canAddToGroupSelection, canGroupSelection, canUngroupSelection };

/// `openGroup` is enabled by what is reachable, not by what is selected:
/// entering needs a Group under the cursor's selection.
export function canOpenSelectedGroup(): boolean {
  return selectedGroupLayer() !== null;
}
