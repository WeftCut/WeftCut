// Which Text layer the preview's inline editor is open on — `pathEditingStore`'s
// shape, for the same reason it has one: the request to edit comes from more
// than one place. The gizmo's double-click lives beside the editor; the Text
// tool's click (`preview/TextToolOverlay.tsx`) does not, and it may name a
// layer whose gizmo has not mounted yet. A store the gizmo READS lets that
// request be made before there is a component to receive it.
//
// Session state, never persisted, never part of project history: a draft that
// has not been saved is not a project fact.

import { create } from "zustand";

interface State {
  layerId: string | null;
  /// `timeStamp` of the pointerdown that last closed an editor from outside it,
  /// or null. The Text tool reads it to tell "the click that closed the editor"
  /// from "a click on empty frame" — the same DOM event reaches both listeners,
  /// and the same event carries the same stamp. Read once and it is spent.
  closingPointerStamp: number | null;
}

export const useTextEditingStore = create<State>(() => ({
  layerId: null,
  closingPointerStamp: null,
}));

/// Open the inline editor on `layerId`. Idempotent for the layer already open.
export function beginTextEdit(layerId: string): void {
  if (useTextEditingStore.getState().layerId !== layerId) {
    useTextEditingStore.setState({ layerId });
  }
}

/// Close the editor — but only if it is still `layerId`'s. Identity-guarded
/// for the `clearGizmoProbe` reason: a stale unmount (the previous selection's
/// gizmo going away) must not close the editor a newer request just opened.
export function endTextEdit(layerId: string): void {
  if (useTextEditingStore.getState().layerId === layerId) {
    useTextEditingStore.setState({ layerId: null });
  }
}

/// Imperative read for event-time callers that must not subscribe.
export function textEditingLayerId(): string | null {
  return useTextEditingStore.getState().layerId;
}

/// Record that `event` — a pointerdown outside the editor — is what closed it.
export function markEditorClosedByPointer(event: { timeStamp: number }): void {
  useTextEditingStore.setState({ closingPointerStamp: event.timeStamp });
}

/// Whether `event` is the pointerdown that closed an editor. True at most once
/// per event: the stamp is cleared on the first true answer, so a later event
/// that happens to share a stamp (two synthetic events in one tick) is not
/// swallowed with it.
export function consumesPointerDown(event: { timeStamp: number }): boolean {
  const stamp = useTextEditingStore.getState().closingPointerStamp;
  if (stamp === null || stamp !== event.timeStamp) return false;
  useTextEditingStore.setState({ closingPointerStamp: null });
  return true;
}

export const useTextEditingLayerId = (): string | null =>
  useTextEditingStore((s) => s.layerId);
