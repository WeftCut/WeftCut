// Transient per-track previews: while a gesture is in flight — a menu row
// armed over a keyframe selection, an Elastic slider mid-drag, a batch retime
// before its release — the surfaces that draw a `(layerId, paramKey)` track
// (the curve graph with its dots and handles, the in-clip diamond row) draw
// the track stored here in place of the committed one, so the picture follows
// the gesture without a per-move actor commit (one commit per gesture). Keyed
// by `layerId|paramKey` — the same separator rule as `selectionStore` — so a
// preview over a selection spanning layers previews every group it holds.
// The gesture owns the lifecycle (set while armed, cleared on leave/unmount);
// surfaces only read. Not persisted, not undo.
//
// Selectors are atomic: `useTrackPreview` returns the stored track reference
// (or null), never an object built in the selector body, which under zustand
// re-renders forever (`feedback_zustand_composite_selector`).
import { create } from "zustand";
import type { AnimTrack, Rgba } from "../ipc";

export type PreviewTrack = AnimTrack<number | Rgba>;

interface State {
  previews: ReadonlyMap<string, PreviewTrack>;
}

/// Shared empty map so clearing an already-empty store writes an identical
/// reference and notifies nobody.
const EMPTY: ReadonlyMap<string, PreviewTrack> = new Map();

export const useTrackPreviewStore = create<State>(() => ({ previews: EMPTY }));

/// `|` occurs in no layer id or paramKey, so the pair never collides.
export function previewKey(layerId: string, paramKey: string): string {
  return `${layerId}|${paramKey}`;
}

export function setTrackPreview(layerId: string, paramKey: string, track: PreviewTrack): void {
  setTrackPreviews([[layerId, paramKey, track]]);
}

/// Several groups in ONE store write — a batch gesture previews every group of
/// the selection, and one notification is what keeps N surfaces to one render.
export function setTrackPreviews(
  entries: readonly (readonly [layerId: string, paramKey: string, track: PreviewTrack])[],
): void {
  if (entries.length === 0) return;
  const next = new Map(useTrackPreviewStore.getState().previews);
  for (const [layerId, paramKey, track] of entries) next.set(previewKey(layerId, paramKey), track);
  useTrackPreviewStore.setState({ previews: next });
}

/// Scoped clear: a gesture passes what it set so it can never wipe a preview a
/// newer gesture has already claimed. No arguments clears everything; a layer
/// alone clears every param of that layer.
export function clearTrackPreview(layerId?: string, paramKey?: string): void {
  const cur = useTrackPreviewStore.getState().previews;
  if (cur.size === 0) return;
  if (layerId === undefined) {
    useTrackPreviewStore.setState({ previews: EMPTY });
    return;
  }
  const next = new Map(cur);
  if (paramKey !== undefined) {
    next.delete(previewKey(layerId, paramKey));
  } else {
    for (const key of cur.keys()) if (key.startsWith(`${layerId}|`)) next.delete(key);
  }
  if (next.size === cur.size) return;
  useTrackPreviewStore.setState({ previews: next.size === 0 ? EMPTY : next });
}

export function getTrackPreview(layerId: string, paramKey: string): PreviewTrack | null {
  return useTrackPreviewStore.getState().previews.get(previewKey(layerId, paramKey)) ?? null;
}

/// The preview for one `(layerId, paramKey)`, or null. A null `paramKey` — a
/// clip with no focused property — takes the constant branch so those
/// subscribers are not re-rendered by previews they cannot draw.
export function useTrackPreview(layerId: string, paramKey: string | null): PreviewTrack | null {
  return useTrackPreviewStore((s) =>
    paramKey === null ? null : (s.previews.get(previewKey(layerId, paramKey)) ?? null),
  );
}

/// A value graph draws numbers; a preview whose values are not numbers cannot
/// be drawn on it and reads as no preview. The value type is decided by the
/// param, so a surface that shows a number track only ever meets a number
/// preview — the guard is what lets the type say so.
export function isNumberTrack(track: PreviewTrack): track is AnimTrack<number> {
  if (track.mode === "Static") return typeof track.value === "number";
  const first = track.value[0];
  return first === undefined || typeof first.value === "number";
}

export function useNumberTrackPreview(
  layerId: string,
  paramKey: string | null,
): AnimTrack<number> | null {
  const preview = useTrackPreview(layerId, paramKey);
  return preview !== null && isNumberTrack(preview) ? preview : null;
}
