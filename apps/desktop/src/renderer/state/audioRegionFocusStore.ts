// Which denoise card's sample region the timeline should draw. The band and its
// two edge handles exist only while the card that owns them is on screen and
// expanded (spec Decision 12) — visibility follows the user's already-open
// card, so there is no separate toggle to explain.
//
// Boundary: the card publishes, the timeline's band reads. Neither the arm
// state (`timeline/audioRegionArmStore`) nor the region values (they live in the
// effect's params) belong here. See ADR 0063.
//
// Session state, deliberately NOT persisted: which card is open is where you
// are in a work session, not a property of the project.

import { create } from "zustand";

/// The one card whose region is drawable. Exactly one: two visible bands would
/// give a drag on the clip two possible owners.
export interface RegionFocus {
  layerId: string;
  effectId: string;
}

interface State {
  focus: RegionFocus | null;
}

export const useAudioRegionFocusStore = create<State>(() => ({ focus: null }));

/// Claim the band. Idempotent for an unchanged pair, so a card that republishes
/// on every render never notifies the timeline.
export function setRegionFocus(focus: RegionFocus): void {
  const current = useAudioRegionFocusStore.getState().focus;
  if (current?.layerId === focus.layerId && current.effectId === focus.effectId) return;
  useAudioRegionFocusStore.setState({ focus });
}

/// Release the band, but only if this pair still holds it. A card's unmount
/// cleanup can run AFTER the next card's claim (layer switched, effect
/// reordered), and an unconditional clear would then blank the band that just
/// legitimately opened.
export function clearRegionFocus(layerId: string, effectId: string): void {
  const current = useAudioRegionFocusStore.getState().focus;
  if (!current || current.layerId !== layerId || current.effectId !== effectId) return;
  useAudioRegionFocusStore.setState({ focus: null });
}

/// Subscribe. Returns the STORED object, never a fresh one, so this stays an
/// atomic selector despite handing back a pair.
export const useRegionFocus = (): RegionFocus | null =>
  useAudioRegionFocusStore((s) => s.focus);

/// Imperative read for event-time callers (the timeline's pointer handlers)
/// that must not subscribe.
export function regionFocus(): RegionFocus | null {
  return useAudioRegionFocusStore.getState().focus;
}
