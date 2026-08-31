import { create } from "zustand";

/// Renderer-global selection: what the Attribute panel inspects, what Delete
/// acts on, what the on-canvas gizmo boxes.
///
/// Does not own the keyframe diamond selection (`keyframe/selectionStore.ts`)
/// nor the marquee box in flight (`timeline/marqueeStore.ts`); both are
/// separate stores with their own lifecycles.

/// The one thing the renderer has selected. Kinds are branches, not parallel
/// slots — "a Layer set and a transition chip are never both live" is what the
/// union says, so no surface has to enforce it and no commit has to evict.
///
/// `layers` carries the whole set plus the PRIMARY that contextual tools follow.
/// Only `layerSelection` builds it, and it guarantees both `ids.has(primary)`
/// and a non-empty `ids` — an empty Layer selection is spelled `none`.
///
/// `media` and `group` are siblings rather than one `pool` branch: the inspector
/// dispatches to a different component for each, so a shared tag would only be
/// unwrapped again at every read.
export type Selection =
  | { kind: "none" }
  | { kind: "layers"; primary: string; ids: ReadonlySet<string> }
  | { kind: "transition"; id: string }
  | { kind: "media"; id: string }
  | { kind: "group"; id: string };

export interface SelectionState {
  selection: Selection;
}

const NONE: Selection = { kind: "none" };

/// Shared so the derived reads below hand back ONE reference for every
/// selection that holds no Layers. A fresh `new Set()` per call would spin
/// `useSyncExternalStore` forever (`feedback_zustand_composite_selector`).
const EMPTY_SELECTED_LAYER_IDS: ReadonlySet<string> = new Set();

export const useSelectionStore = create<SelectionState>(() => ({
  selection: NONE,
}));

/// Live read for the command gates and gesture handlers that run outside React
/// — `CommandDef.enabled`, evaluated at palette render time; a pointerdown
/// snapshot; an `App` key handler. A value closed over instead would answer for
/// whichever selection was up when the closure was made.
export function currentSelection(): Selection {
  return useSelectionStore.getState().selection;
}

/// The Layers a selection holds — empty for every kind but `layers`.
export function layerIdsOf(selection: Selection): ReadonlySet<string> {
  return selection.kind === "layers" ? selection.ids : EMPTY_SELECTED_LAYER_IDS;
}

/// The Layer contextual tools act on — the Attribute panel's subject and the
/// gizmo's box. Null unless a Layer selection is up.
export function primaryLayerIdOf(selection: Selection): string | null {
  return selection.kind === "layers" ? selection.primary : null;
}

export function transitionIdOf(selection: Selection): string | null {
  return selection.kind === "transition" ? selection.id : null;
}

function equalIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind === "layers" || b.kind === "layers") {
    return (
      a.kind === "layers" &&
      b.kind === "layers" &&
      a.primary === b.primary &&
      equalIds(a.ids, b.ids)
    );
  }
  if (a.kind === "none" || b.kind === "none") return a.kind === b.kind;
  return a.kind === b.kind && a.id === b.id;
}

/// Publish `next`, unless it says the same thing the store already holds.
///
/// The equality check is load-bearing, not a micro-optimisation: the three
/// `retain*` passes run on EVERY project summary, and a new state object per
/// tick would re-render every selection-aware surface in the timeline.
function commit(next: Selection): void {
  if (sameSelection(currentSelection(), next)) return;
  useSelectionStore.setState({ selection: next });
}

/// Build the `layers` branch from a caller's request, or `none` when nothing
/// survives: a non-null requested primary joins the set, and a set without one
/// takes its first Layer. The single construction site is what makes "a primary
/// outside its set" and "an empty Layer selection" unrepresentable rather than
/// merely maintained.
function layerSelection(
  requestedPrimaryId: string | null,
  requestedIds: Iterable<string>,
): Selection {
  const ids = new Set(requestedIds);
  if (requestedPrimaryId !== null) ids.add(requestedPrimaryId);
  const primary = requestedPrimaryId ?? ids.values().next().value ?? null;
  return primary === null ? NONE : { kind: "layers", primary, ids };
}

/// Replace the complete selection atomically. The request is normalized by
/// `layerSelection`, so an empty one deselects rather than leaving an empty
/// Layer selection behind.
export function setLayerSelection(
  primaryLayerId: string | null,
  selectedLayerIds: Iterable<string>,
): void {
  commit(layerSelection(primaryLayerId, selectedLayerIds));
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
  const current = currentSelection();
  const nextIds = new Set(layerIdsOf(current));
  if (nextIds.has(clickedLayerId)) {
    for (const id of layerIds) nextIds.delete(id);
    // Belt and braces, mirroring `layerSelection`'s forced ADD of the primary:
    // a caller whose `layerIds` omitted the clicked Layer would otherwise leave
    // it selected while this returns `false`.
    nextIds.delete(clickedLayerId);
    // A removed primary cannot stay primary. `null` lets `layerSelection`
    // promote the first survivor — the same rule `retainLayerSelection` applies
    // when an edit deletes the primary out from under the selection.
    const primary = primaryLayerIdOf(current);
    commit(
      layerSelection(
        primary !== null && nextIds.has(primary) ? primary : null,
        nextIds,
      ),
    );
    return false;
  }
  for (const id of layerIds) nextIds.add(id);
  commit(layerSelection(clickedLayerId, nextIds));
  return true;
}

/// Deselect whatever is selected, of any kind (background-click /
/// project-switch semantics).
export function clearLayerSelection(): void {
  commit(NONE);
}

/// Select a composition from the media pool's Groups section — the one
/// selectable entity with no presence on a timeline, which is what makes a
/// composition inspectable while nothing references it.
export function setCompositionSelection(compositionId: string): void {
  commit({ kind: "group", id: compositionId });
}

/// Select a media item from the pool — the pool's other card, and the other
/// entity that is inspectable while no timeline shows it.
///
/// One id, never a set: the inspector is this selection's only consumer and it
/// can only have one subject — pool selection is single.
export function setMediaSelection(mediaId: string): void {
  commit({ kind: "media", id: mediaId });
}

/// Select a transition chip.
export function setTransitionSelection(transitionId: string): void {
  commit({ kind: "transition", id: transitionId });
}

/// Drop the transition chip and nothing else — a selection of another kind was
/// never the chip's to clear.
export function clearTransitionSelection(): void {
  if (currentSelection().kind === "transition") commit(NONE);
}

/// Drop selected Layers that no longer resolve in the current Project snapshot.
/// If the former primary disappeared while another selected Layer remains, the
/// first survivor becomes primary. Other kinds are left to their own `retain*`
/// below — a `layers` selection cannot be carrying one.
export function retainLayerSelection(validLayerIds: Iterable<string>): void {
  const current = currentSelection();
  if (current.kind !== "layers") return;
  const valid = new Set(validLayerIds);
  const retained = new Set<string>();
  for (const id of current.ids) {
    if (valid.has(id)) retained.add(id);
  }
  const primary = retained.has(current.primary) ? current.primary : null;
  commit(layerSelection(primary, retained));
}

/// Drop a pool composition selection whose composition left the project — the
/// Delete the pool's own menu just ran, or an undo that took it away. Without
/// this the inspector would hold a composition nothing can resolve.
export function retainCompositionSelection(
  validCompositionIds: Iterable<string>,
): void {
  const current = currentSelection();
  if (current.kind !== "group") return;
  for (const id of validCompositionIds) {
    if (id === current.id) return;
  }
  commit(NONE);
}

/// Drop a pool media selection whose item left the pool — Remove from media
/// pool, or an undo/redo that takes it away. Without this the inspector would
/// describe a media item nothing can resolve.
export function retainMediaSelection(validMediaIds: Iterable<string>): void {
  const current = currentSelection();
  if (current.kind !== "media") return;
  for (const id of validMediaIds) {
    if (id === current.id) return;
  }
  commit(NONE);
}

/// Drop a transition selection whose id vanished from the snapshot (removed,
/// reconcile-dropped, or undone away).
export function retainTransitionSelection(
  validTransitionIds: Iterable<string>,
): void {
  const current = currentSelection();
  if (current.kind !== "transition") return;
  for (const id of validTransitionIds) {
    if (id === current.id) return;
  }
  commit(NONE);
}

// ===== Atomic selector helpers ============================================
// One derived value per hook, each backed by a reference that only changes when
// the selection does — the rule `projectStore.ts` states for the same reason.

export const usePrimaryLayerId = (): string | null =>
  useSelectionStore((state) => primaryLayerIdOf(state.selection));

export const useSelectedLayerIds = (): ReadonlySet<string> =>
  useSelectionStore((state) => layerIdsOf(state.selection));

export const useSelectedTransitionId = (): string | null =>
  useSelectionStore((state) => transitionIdOf(state.selection));

/// The Group picked in the media pool. "Composition" is the project's word for
/// the entity the pool calls a Group; they are the same thing.
export const useSelectedCompositionId = (): string | null =>
  useSelectionStore((state) =>
    state.selection.kind === "group" ? state.selection.id : null,
  );

/// The media item picked in the media pool.
export const useSelectedMediaId = (): string | null =>
  useSelectionStore((state) =>
    state.selection.kind === "media" ? state.selection.id : null,
  );
