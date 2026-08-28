// What was selected when a Group was made, so undoing the pre-compose gives it
// back.
//
// Undo restores the layers; nothing restores the SELECTION, and for this one op
// that leaves the user worse off than a plain undo does. Pre-compose is the only
// edit that can pull the view into a different composition: enter the Group,
// press Ctrl+Z, and the scope store falls back to the root (its
// `reconcileCompositionAnchors` — the open composition no longer exists) with the
// selection cleared, which is what every switch does. So the user asks for their
// layers back and lands on a timeline with nothing selected, unable to press
// Ctrl+G again without re-picking the clips.
//
// A module-level slot rather than history plumbing: exactly one pre-compose can
// be the most recent one, the fact is worth nothing after the project closes,
// and the alternative — a general "undo restores the selection it found" — is a
// far larger promise than this repair needs.
//
// Not a zustand store: nothing renders from it. Session state, never persisted.

import { setLayerSelection } from "./selectionStore";
import type { ProjectSummary } from "../ipc";

interface Precompose {
  compositionId: string;
  /// The layers that went in, and the one that was primary. Restored verbatim —
  /// a pre-compose refuses on a locked member, so every id in here was a live
  /// layer at the moment the Group was created.
  memberIds: readonly string[];
  primaryId: string | null;
  /// Whether the last summary still carried the composition. The restore fires
  /// on the present → absent edge only, so re-selecting cannot fight a
  /// selection the user made afterwards, and a redo re-arms it.
  compositionPresent: boolean;
}

let last: Precompose | null = null;

/// Called by the Group command right after `groups_create` returns.
export function rememberPrecompose(
  compositionId: string,
  memberIds: readonly string[],
  primaryId: string | null,
): void {
  last = { compositionId, memberIds: [...memberIds], primaryId, compositionPresent: true };
}

/// Called by `projectStore.apply` on every summary, AFTER the scope store has
/// reconciled — the switch it may run clears the selection, and this puts the
/// members back on top of that.
///
/// Silent no-op unless the remembered composition has just disappeared and every
/// member is back: a partially-restored selection would arm Delete over clips
/// the user cannot see.
export function restorePrecomposeSelection(summary: ProjectSummary | null): void {
  if (last === null) return;
  if (!summary) {
    last = null;
    return;
  }
  const present = last.compositionId in summary.compositions;
  if (present) {
    last = { ...last, compositionPresent: true };
    return;
  }
  if (!last.compositionPresent) return;
  const { memberIds, primaryId } = last;
  last = { ...last, compositionPresent: false };
  const live = new Set<string>();
  for (const comp of Object.values(summary.compositions)) {
    for (const track of comp.tracks) for (const layer of track.layers) live.add(layer.id);
  }
  if (memberIds.length === 0 || memberIds.some((id) => !live.has(id))) return;
  setLayerSelection(
    primaryId !== null && memberIds.includes(primaryId) ? primaryId : (memberIds[0] ?? null),
    [...memberIds],
  );
}

/// Test hook: drop the slot so one case cannot restore a selection in the next.
export function clearPrecomposeMemory(): void {
  last = null;
}
