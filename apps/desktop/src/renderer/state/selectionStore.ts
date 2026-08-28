import { create } from "zustand";

/// Renderer-global Layer selection. `primaryLayerId` drives contextual tools;
/// `selectedLayerIds` is the complete selection used by Timeline link
/// operations and every other selection-aware surface.
/// `selectedTransitionId` is the selected transition chip — mutually
/// exclusive with layer selection (selecting either deselects the other),
/// so Delete and the Attribute panel always have exactly one target.
export interface LayerSelectionState {
  primaryLayerId: string | null;
  selectedLayerIds: ReadonlySet<string>;
  selectedTransitionId: string | null;
  /// The composition selected in the media pool's Groups section — the one
  /// selectable entity with no presence on a timeline, which is what makes a
  /// composition inspectable while nothing references it. Mutually exclusive
  /// with the two above for the same reason they are with each other: the
  /// inspector shows one thing.
  selectedCompositionId: string | null;
}

const EMPTY_SELECTED_LAYER_IDS: ReadonlySet<string> = new Set();

export const useSelectionStore = create<LayerSelectionState>(() => ({
  primaryLayerId: null,
  selectedLayerIds: EMPTY_SELECTED_LAYER_IDS,
  selectedTransitionId: null,
  selectedCompositionId: null,
}));

function equalIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function commitSelection(
  requestedPrimaryId: string | null,
  requestedIds: Iterable<string>,
  requestedTransitionId: string | null,
  requestedCompositionId: string | null = null,
): void {
  const nextIds = new Set(requestedIds);
  if (requestedPrimaryId !== null) nextIds.add(requestedPrimaryId);

  const nextPrimaryId =
    nextIds.size === 0
      ? null
      : requestedPrimaryId !== null
        ? requestedPrimaryId
        : (nextIds.values().next().value ?? null);
  // Mutual exclusion: a non-empty layer selection always evicts the
  // transition chip and the pool's composition, whatever the caller passed.
  const nextTransitionId = nextIds.size > 0 ? null : requestedTransitionId;
  const nextCompositionId =
    nextIds.size > 0 || nextTransitionId !== null ? null : requestedCompositionId;
  const current = useSelectionStore.getState();
  if (
    current.primaryLayerId === nextPrimaryId &&
    current.selectedTransitionId === nextTransitionId &&
    current.selectedCompositionId === nextCompositionId &&
    equalIds(current.selectedLayerIds, nextIds)
  ) {
    return;
  }

  useSelectionStore.setState({
    primaryLayerId: nextPrimaryId,
    selectedLayerIds:
      nextIds.size === 0 ? EMPTY_SELECTED_LAYER_IDS : nextIds,
    selectedTransitionId: nextTransitionId,
    selectedCompositionId: nextCompositionId,
  });
}

/// Replace the complete selection atomically. A non-null requested primary is
/// included automatically; a non-empty set without a requested primary uses
/// its first Layer as primary. The resulting state therefore always satisfies
/// `primary === null ⇔ selected.size === 0` and `selected.has(primary)`.
/// Any transition chip selection is dropped (mutual exclusion).
export function setLayerSelection(
  primaryLayerId: string | null,
  selectedLayerIds: Iterable<string>,
): void {
  commitSelection(primaryLayerId, selectedLayerIds, null);
}

/// Additive click: add `layerIds` and make `clickedLayerId` primary — or, when
/// the clicked Layer is ALREADY selected, remove them again. Returns whether
/// the clicked Layer is selected afterwards, which is what tells `LayerBlock`
/// that a deselecting click must not also arm a drag.
///
/// A TOGGLE rather than a union because that is what the additive modifier does
/// in Resolve, FCP and Premiere alike, and because a union-only gesture leaves
/// no way back from an over-wide selection except starting over with a plain
/// click.
///
/// The direction is decided by the CLICKED Layer, not by "are all `layerIds`
/// already selected": with a link the members arrive together, and the clip the
/// user pointed at is the one whose highlight they can see.
export function toggleLayerSelection(
  clickedLayerId: string,
  layerIds: Iterable<string>,
): boolean {
  const current = useSelectionStore.getState();
  const nextIds = new Set(current.selectedLayerIds);
  if (nextIds.has(clickedLayerId)) {
    for (const id of layerIds) nextIds.delete(id);
    // Belt and braces, mirroring `commitSelection`'s forced ADD of the primary:
    // a caller whose `layerIds` omitted the clicked Layer would otherwise leave
    // it selected while this returns `false`.
    nextIds.delete(clickedLayerId);
    // A removed primary cannot stay primary. `null` lets `commitSelection`
    // promote the first survivor — the same rule `retainLayerSelection` applies
    // when an edit deletes the primary out from under the selection.
    const survivingPrimary =
      current.primaryLayerId !== null && nextIds.has(current.primaryLayerId)
        ? current.primaryLayerId
        : null;
    commitSelection(survivingPrimary, nextIds, null);
    return false;
  }
  for (const id of layerIds) nextIds.add(id);
  commitSelection(clickedLayerId, nextIds, null);
  return true;
}

/// Deselect everything — layers, the transition chip AND the pool's composition
/// (background-click / project-switch semantics).
export function clearLayerSelection(): void {
  commitSelection(null, EMPTY_SELECTED_LAYER_IDS, null, null);
}

/// Select a composition from the media pool's Groups section. Deselects layers
/// and the transition chip in the same store update — one selected entity kind
/// at a time.
export function setCompositionSelection(compositionId: string): void {
  commitSelection(null, EMPTY_SELECTED_LAYER_IDS, null, compositionId);
}

/// Select a transition chip. Deselects all layers in the same store update
/// (the app's selection idiom: one selected entity kind at a time).
export function setTransitionSelection(transitionId: string): void {
  commitSelection(null, EMPTY_SELECTED_LAYER_IDS, transitionId);
}

export function clearTransitionSelection(): void {
  const current = useSelectionStore.getState();
  commitSelection(current.primaryLayerId, current.selectedLayerIds, null, current.selectedCompositionId);
}

/// Drop selections that no longer resolve in the current Project snapshot.
/// If the former primary disappeared while another selected Layer remains,
/// the first surviving Layer becomes primary. The transition selection is
/// preserved — `retainTransitionSelection` owns its lifecycle.
export function retainLayerSelection(validLayerIds: Iterable<string>): void {
  const valid = new Set(validLayerIds);
  const current = useSelectionStore.getState();
  const retained = new Set<string>();
  for (const id of current.selectedLayerIds) {
    if (valid.has(id)) retained.add(id);
  }
  const retainedPrimary =
    current.primaryLayerId !== null && retained.has(current.primaryLayerId)
      ? current.primaryLayerId
      : null;
  commitSelection(retainedPrimary, retained, current.selectedTransitionId, current.selectedCompositionId);
}

/// Drop a pool composition selection whose composition left the project — the
/// Delete the pool's own menu just ran, or an undo that took it away. Without
/// this the inspector would hold a composition nothing can resolve.
export function retainCompositionSelection(
  validCompositionIds: Iterable<string>,
): void {
  const current = useSelectionStore.getState();
  if (current.selectedCompositionId === null) return;
  for (const id of validCompositionIds) {
    if (id === current.selectedCompositionId) return;
  }
  commitSelection(null, EMPTY_SELECTED_LAYER_IDS, null, null);
}

/// Drop a transition selection whose id vanished from the snapshot (removed,
/// reconcile-dropped, or undone away).
export function retainTransitionSelection(
  validTransitionIds: Iterable<string>,
): void {
  const current = useSelectionStore.getState();
  if (current.selectedTransitionId === null) return;
  for (const id of validTransitionIds) {
    if (id === current.selectedTransitionId) return;
  }
  clearTransitionSelection();
}

export const usePrimaryLayerId = (): string | null =>
  useSelectionStore((state) => state.primaryLayerId);

export const useSelectedLayerIds = (): ReadonlySet<string> =>
  useSelectionStore((state) => state.selectedLayerIds);

export const useSelectedTransitionId = (): string | null =>
  useSelectionStore((state) => state.selectedTransitionId);

export const useSelectedCompositionId = (): string | null =>
  useSelectionStore((state) => state.selectedCompositionId);
