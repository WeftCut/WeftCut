// Whether the two group commands have anything to act on.
//
// Lifted out of Timeline because the Quick Actions strip has to render the same
// gate it dispatches: the strip is a Dock Panel, so it cannot read Timeline's
// locals, and `CommandDef.enabled` is evaluated during the strip's own render
// (`quickActions.ts`). Without a gate both buttons would look live and do
// nothing — the commands themselves already return early on an empty target.
//
// Each predicate comes in an imperative and a hook form, for the reason
// `applyTransition.ts`'s `hasTransitionCut` pair does: the command's gate runs
// inside `listCommands()` where there is no React, and a button that renders
// greyed-out needs a SUBSCRIPTION or it never re-evaluates.

import type { GroupSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { useSelectionStore } from "../state/selectionStore";

/// Stable empty reference. A fresh `[]` per selector call would defeat the
/// reference-equality bail-out the hooks below rely on.
const NO_GROUPS: readonly GroupSummary[] = [];

/// Grouping needs ≥2 layers — `handleGroupSelected` returns early on fewer,
/// and `groups_create` refuses them.
function canGroup(selected: ReadonlySet<string>): boolean {
  return selected.size >= 2;
}

/// Dissolving needs one selected layer that is IN a group. The command
/// dissolves every group the selection touches, so a single member is enough
/// — including the whole-group selection a plain click produces.
function canDissolve(
  selected: ReadonlySet<string>,
  groups: readonly GroupSummary[],
): boolean {
  if (selected.size === 0) return false;
  return groups.some((group) => group.layer_ids.some((id) => selected.has(id)));
}

export function canGroupSelection(): boolean {
  return canGroup(useSelectionStore.getState().selectedLayerIds);
}

export function canDissolveSelection(): boolean {
  return canDissolve(
    useSelectionStore.getState().selectedLayerIds,
    useProjectStore.getState().summary?.groups ?? NO_GROUPS,
  );
}

/// Subscription form. One selector, returning a boolean, so a selection change
/// that doesn't cross the ≥2 line costs the subscriber nothing.
export const useCanGroupSelection = (): boolean =>
  useSelectionStore((s) => canGroup(s.selectedLayerIds));

/**
 * Subscription form of `canDissolveSelection` — two stores, two subscriptions,
 * neither of them a composite selector (`feedback_zustand_composite_selector`).
 *
 * The selection subscription yields the Set's own reference, which is stable
 * between selection changes; the project subscription closes over it and
 * yields a BOOLEAN, so an unrelated project mutation re-runs the predicate and
 * then bails out instead of re-rendering. Doing it the other way round — one
 * selector reading both stores — would subscribe to neither properly.
 */
export const useCanDissolveSelection = (): boolean => {
  const selected = useSelectionStore((s) => s.selectedLayerIds);
  return useProjectStore((s) =>
    canDissolve(selected, s.summary?.groups ?? NO_GROUPS),
  );
};
