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

/// One mounted card, and — when it is the newest — the one band the timeline
/// draws. Exactly one is drawable at a time: two visible bands would give a
/// drag on the clip two possible owners.
export interface RegionFocus {
  layerId: string;
  effectId: string;
}

interface State {
  /// Every mounted card, oldest first. A STACK rather than a single slot
  /// because one layer can have two expanded cards: collapsing the newer one
  /// must hand the band back to the older one that is still on screen, not
  /// blank it.
  mounted: readonly RegionFocus[];
}

export const useAudioRegionFocusStore = create<State>(() => ({ mounted: [] }));

function indexOf(
  mounted: readonly RegionFocus[],
  layerId: string,
  effectId: string,
): number {
  return mounted.findIndex(
    (entry) => entry.layerId === layerId && entry.effectId === effectId,
  );
}

const newest = (mounted: readonly RegionFocus[]): RegionFocus | null =>
  mounted.at(-1) ?? null;

/// Mount a card, or raise an already-mounted one to the top. Idempotent for a
/// pair that is already newest, so a card that republishes on every render
/// never notifies the timeline. Raising REUSES the stored entry, which is what
/// keeps `useRegionFocus`' identity stable across such a republish.
export function setRegionFocus(focus: RegionFocus): void {
  const { mounted } = useAudioRegionFocusStore.getState();
  const at = indexOf(mounted, focus.layerId, focus.effectId);
  if (at !== -1 && at === mounted.length - 1) return;
  const entry = at === -1 ? focus : mounted[at]!;
  const rest =
    at === -1
      ? mounted
      : [...mounted.slice(0, at), ...mounted.slice(at + 1)];
  useAudioRegionFocusStore.setState({ mounted: [...rest, entry] });
}

/// Unmount one card. The band falls to whichever card is next-newest, so a
/// collapse never blanks a sibling that is still open. A pair that is not
/// mounted is inert: a card's unmount cleanup can run AFTER the next card's
/// claim (layer switched, effect reordered).
export function clearRegionFocus(layerId: string, effectId: string): void {
  const { mounted } = useAudioRegionFocusStore.getState();
  const at = indexOf(mounted, layerId, effectId);
  if (at === -1) return;
  useAudioRegionFocusStore.setState({
    mounted: [...mounted.slice(0, at), ...mounted.slice(at + 1)],
  });
}

/// Subscribe. Returns the STORED object, never a fresh one, so this stays an
/// atomic selector despite handing back a pair.
export const useRegionFocus = (): RegionFocus | null =>
  useAudioRegionFocusStore((s) => newest(s.mounted));

/// Imperative read for event-time callers (the timeline's pointer handlers)
/// that must not subscribe.
export function regionFocus(): RegionFocus | null {
  return newest(useAudioRegionFocusStore.getState().mounted);
}
