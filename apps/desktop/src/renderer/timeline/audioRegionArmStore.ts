// The one-shot arm for painting a denoise sample region on a clip. The card's
// "Select region" button arms it; the next drag on that clip draws the region,
// commits both bounds and disarms (spec Decision 12). The eyedropper is the
// precedent — a modal arm, not a persistent mode.
//
// Boundary: this module holds the arm and nothing else. The gesture, the px↔µs
// mapping and the commit belong to the timeline's drag hook; the band's
// visibility follows `state/audioRegionFocusStore`.
//
// Session state, deliberately NOT persisted. Same shape as `state/toolStore.ts`.

import { create } from "zustand";

/// Everything the gesture needs to commit without re-reading the catalog: which
/// effect on which layer, the two param keys its bounds live under, and the
/// shortest span the filter can learn from (the gesture expands to it around the
/// press point rather than committing a region that would read incomplete).
export interface ArmedRegionSelect {
  layerId: string;
  effectId: string;
  inKey: string;
  outKey: string;
  minUs: number;
}

interface State {
  armed: ArmedRegionSelect | null;
}

export const useAudioRegionArmStore = create<State>(() => ({ armed: null }));

/// Arm the next drag on `payload.layerId`'s clip. Re-arming replaces: the
/// button is the only way in, and pressing it twice means the same thing once.
export function armRegionSelect(payload: ArmedRegionSelect): void {
  useAudioRegionArmStore.setState({ armed: payload });
}

/// Disarm — on commit, on Escape, and on any pointerdown outside the target
/// clip. Idempotent so the timeline's broad disarm paths never notify a
/// subscriber for nothing.
export function disarmRegionSelect(): void {
  if (useAudioRegionArmStore.getState().armed === null) return;
  useAudioRegionArmStore.setState({ armed: null });
}

/// Subscribe. Returns the STORED payload, never a fresh object, so this stays
/// an atomic selector.
export const useArmedRegionSelect = (): ArmedRegionSelect | null =>
  useAudioRegionArmStore((s) => s.armed);

/// Imperative read for event-time callers (the timeline's pointerdown handler)
/// that must not subscribe.
export function armedRegionSelect(): ArmedRegionSelect | null {
  return useAudioRegionArmStore.getState().armed;
}
