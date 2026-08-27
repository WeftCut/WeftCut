// Select All / Deselect All, and the one rule they both rest on: which Layers a
// selection can legitimately contain.
//
// Lifted out of Timeline for the reason `linkEligibility.ts` gives — a
// command's `enabled` gate is evaluated inside `listCommands()` by whichever
// surface draws the row, where there is no React and no reach into Timeline's
// locals — and because "which Layers can a click reach" is a rule worth stating
// once, in one place, with a test on it.

import type { TrackSummary } from "../ipc";
import {
  clearKeyframeSelection,
  hasKeyframeSelection,
} from "../keyframe/selectionStore";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  setLayerSelection,
  useSelectionStore,
} from "../state/selectionStore";

/// Every Layer in `tracks` a click could select, in the order the tracks arrive
/// and the Layers sit inside them.
///
/// Locks are the whole filter, and excluding them is not a courtesy:
/// `LayerBlock`'s pointerdown returns early on `layer.locked || trackLocked`, so
/// a locked clip CANNOT be reached by pointer at all. Including them here would
/// let Select All build a selection the mouse can't, and the next Delete would
/// fan out into N `TrackLocked` refusals for clips the user never chose.
export function selectableLayerIds(tracks: readonly TrackSummary[]): string[] {
  const ids: string[] = [];
  for (const track of tracks) {
    if (track.locked) continue;
    for (const layer of track.layers) {
      if (!layer.locked) ids.push(layer.id);
    }
  }
  return ids;
}

/// Select every selectable Layer in `tracks` — which the caller passes as the
/// tracks the timeline is currently RENDERING, not the project's full list. A/B
/// Roll display mode filters role-less tracks out of the view entirely
/// (`Timeline`'s `orderedTracks`), and a Select All that reached them would arm
/// a Delete for clips that are not on screen.
///
/// A surviving primary is KEPT, so Select All does not move the Attribute panel
/// off the clip being inspected; otherwise the first selectable Layer takes it.
export function selectAllLayers(tracks: readonly TrackSummary[]): void {
  const ids = selectableLayerIds(tracks);
  if (ids.length === 0) return;
  const primary = useSelectionStore.getState().primaryLayerId;
  setLayerSelection(
    primary !== null && ids.includes(primary) ? primary : null,
    ids,
  );
}

/// Drop every selection the timeline can hold: Layers and the transition chip
/// (`clearLayerSelection` owns both), plus the keyframe diamond. All three arm
/// Delete (`subSelectionDelete.ts`), so a Deselect All that left one standing
/// would leave Delete live with nothing visibly selected.
export function deselectAll(): void {
  clearLayerSelection();
  clearKeyframeSelection();
}

/// Live-read gate for Select All: has the project anything selectable at all?
///
/// Deliberately OPTIMISTIC about the display filter — it asks the project, which
/// has no notion of which tracks are on screen, so in A/B Roll mode it can offer
/// the command when every unlocked clip happens to sit on a hidden track. That
/// is the safe direction: the command then selects nothing. A pessimistic gate
/// would grey out a row the user could legitimately run.
///
/// Builds the id list rather than short-circuiting on `some()` so the lock rule
/// has exactly one definition; the list is bounded by the project's clip count
/// and this runs once per surface render.
export function canSelectAll(): boolean {
  const tracks = useProjectStore.getState().summary?.tracks ?? [];
  return selectableLayerIds(tracks).length > 0;
}

/// Live-read gate for Deselect All: is anything selected? Asks all three
/// selections `deselectAll` clears, so the row is live exactly when it has work.
export function canDeselectAll(): boolean {
  const selection = useSelectionStore.getState();
  return (
    selection.selectedLayerIds.size > 0 ||
    selection.selectedTransitionId !== null ||
    hasKeyframeSelection()
  );
}
