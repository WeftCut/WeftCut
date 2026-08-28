// Timeline horizontal-scroll fan-out. `scrollLeftPx` moves at wheel/drag rate,
// so it follows the same rule as the playhead time (see playheadStore.ts):
// NOTHING at event rate may live in React state above a leaf. A
// `useState(scrollLeft)` on the timeline root would re-render every track lane,
// keyframe sub-lane and layer chip on every wheel tick — the regression class
// e2e/scripts/memory-ratchet.mjs exists to catch.
//
// Timeline's scroll container publishes here (rAF-coalesced); TimelineRuler is
// the only subscriber and re-renders alone, which is what lets its tick set
// follow the viewport instead of spanning the whole project.
//
// Keyed by composition, because a timeline Panel is one composition (ADR 0053)
// and two of them scroll independently: one shared offset would have every
// ruler paint the tick window of whichever Panel was scrolled last.

import { create } from "zustand";

import { noteTabScroll } from "./viewState";

interface State {
  /// `composition → row-local px offset of the visible lane area's left edge`,
  /// i.e. that timeline's scroll root's `scrollLeft`. A composition with no
  /// entry has no timeline mounted, which reads as 0.
  scrollLeftPx: Readonly<Record<string, number>>;
}

export const useTimelineScrollStore = create<State>(() => ({
  scrollLeftPx: {},
}));

/// The record key for a timeline Panel. The unbound row the Dock builds before
/// a summary names a root has no composition, and gets the empty key — no real
/// composition id can collide with it.
export function timelineScrollKey(compositionId: string | null): string {
  return compositionId ?? "";
}

/// Publish one timeline's scroll offset. Guarded so a repeated value (a scroll
/// event that only moved vertically, a remount seeding the same offset) is not
/// a store write, and so a subscriber never has to defend against NaN.
///
/// The offset is also where the tab is left, so the same call tells the
/// `view.json` owner to remember it (`viewState.ts`). Persisting it from here
/// rather than from each publishing site is what keeps the two facts — "the
/// ruler needs this now" and "restore to this next time" — from drifting apart.
export function setTimelineScrollLeftPx(
  compositionId: string | null,
  px: number,
): void {
  const key = timelineScrollKey(compositionId);
  const next = Number.isFinite(px) ? Math.max(0, px) : 0;
  const current = useTimelineScrollStore.getState().scrollLeftPx;
  if (current[key] === next) return;
  useTimelineScrollStore.setState({ scrollLeftPx: { ...current, [key]: next } });
  noteTabScroll(compositionId, next);
}

/// Imperative read, for mount-time seeding and event-time consumers.
export function timelineScrollLeftPx(compositionId: string | null): number {
  return (
    useTimelineScrollStore.getState().scrollLeftPx[
      timelineScrollKey(compositionId)
    ] ?? 0
  );
}
