// Single source of truth for keyframe SELECTION — the collapsed chip diamonds
// and the expanded sub-lane diamonds share it. Transient: not persisted, not
// undoable. FOCUS — which sub-lane is expanded and editable — is a different
// thing and lives in `focusStore.ts`.
//
// A Map keyed by `layerId|paramKey|kfId` rather than a Set of objects: every
// diamond asks "am I selected?" in its render path and needs O(1), and a
// multi-key operation groups the selection by (layerId, paramKey) to reach the
// per-property editors, so the triple has to be readable off the entry rather
// than parsed back out of the key.
//
// No `primary`. Every candidate consumer was checked and none needs one:
// `KeyframeValueField` reads the value at the PLAYHEAD, not at a selected key;
// `EasingMenu` applies to the whole selection; and "which sub-lane is editable"
// is focus. A `primary` with no consumer is dead state, and dead state gets
// "used" by the next refactor in a way nobody specified.
//
// Selectors must be atomic (per feedback_zustand_composite_selector): subscribe
// to `selected` itself — a stable reference between writes — or to a primitive
// derived from it, never to an object built inside the selector.
import { useCallback } from "react";
import { create } from "zustand";

export interface SelectedKeyframe {
  layerId: string;
  paramKey: string;
  kfId: string;
}

/// The Map key for one diamond. `|` occurs in no layer id, paramKey or keyframe
/// id, so the three components can never run together into a colliding key.
export function keyframeKey(k: SelectedKeyframe): string {
  return `${k.layerId}|${k.paramKey}|${k.kfId}`;
}

interface State {
  selected: ReadonlyMap<string, SelectedKeyframe>;
}

// Shared so clearing an already-empty selection writes an identical reference
// and notifies nobody — `LayerBlock` clears from an effect that runs once per
// non-primary clip, and a fresh Map each time would re-render every diamond.
const EMPTY: ReadonlyMap<string, SelectedKeyframe> = new Map();

export const useKeyframeSelectionStore = create<State>(() => ({ selected: EMPTY }));

/// Replace the whole selection with one key — clicking a diamond.
export function selectKeyframe(key: SelectedKeyframe): void {
  useKeyframeSelectionStore.setState({
    selected: new Map([[keyframeKey(key), key]]),
  });
}

/// Replace the whole selection with `keys` — the marquee's commit point, from
/// the `keyframe`-kind resolver behind `useMarqueeAnchor`'s `onBox`. Replace,
/// not add, because the gesture recomputes its result from the snapshot on
/// every pointermove so shrinking the box gives the over-reached keys back.
export function setKeyframeSelection(keys: Iterable<SelectedKeyframe>): void {
  const next = new Map<string, SelectedKeyframe>();
  for (const key of keys) next.set(keyframeKey(key), key);
  useKeyframeSelectionStore.setState({ selected: next.size === 0 ? EMPTY : next });
}

export function clearKeyframeSelection(): void {
  useKeyframeSelectionStore.setState({ selected: EMPTY });
}

/// The whole selection, in insertion order.
export function getSelectedKeyframes(): readonly SelectedKeyframe[] {
  return [...useKeyframeSelectionStore.getState().selected.values()];
}

/// Is anything selected? Cheaper than `getSelectedKeyframes().length`, which
/// materializes the whole selection to answer it.
export function hasKeyframeSelection(): boolean {
  return useKeyframeSelectionStore.getState().selected.size > 0;
}

/// Membership test for the diamonds of one (layerId, paramKey), for their render
/// path. A null `paramKey` — the clip has no focused property, which is every
/// clip but one — reads as nothing selected, and takes the constant branch so
/// those subscribers are not re-rendered by a selection they cannot draw.
export function useIsKeyframeSelected(
  layerId: string,
  paramKey: string | null,
): (kfId: string) => boolean {
  const selected = useKeyframeSelectionStore((s) => (paramKey === null ? EMPTY : s.selected));
  return useCallback(
    (kfId: string) =>
      paramKey !== null && selected.has(keyframeKey({ layerId, paramKey, kfId })),
    [selected, layerId, paramKey],
  );
}

/// The first selected key on one (layerId, paramKey), or null. A primitive, so
/// an effect gated on it re-arms when the selection changes.
export function useSelectedKfIdFor(
  layerId: string,
  paramKey: string | null,
): string | null {
  return useKeyframeSelectionStore((s) => {
    if (paramKey === null) return null;
    for (const key of s.selected.values()) {
      if (key.layerId === layerId && key.paramKey === paramKey) return key.kfId;
    }
    return null;
  });
}
