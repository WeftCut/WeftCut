// The live marquee rectangle. `MarqueeOverlay.tsx` is its only subscriber and
// `hooks/useMarqueeAnchor.ts` its only writer; what the box SELECTS is not here
// — the hit-test reads the box and writes the selection stores.
//
// A module-level store for the reason `state/timelineScrollStore.ts` states:
// nothing at event rate may live in React state above a leaf, because one
// `useState` on the timeline root re-renders every lane, sub-lane and chip per
// pointermove. React subscribers use the ATOMIC selectors below (per
// `feedback_zustand_composite_selector` — never select a composite object).

import { create } from "zustand";

/// Which of the timeline's two interleaved selectable populations the box
/// takes. Fixed at pointerdown from the SURFACE the pointer went down on, and
/// never reconsidered mid-gesture: the box's extent decides which members it
/// takes, never which population.
export type MarqueeKind = "clip" | "keyframe";

/// Canvas-relative px — the `timeline-canvas` coordinate space, so the anchor
/// stays pinned to the content while the view scrolls under it. `(x0, y0)` is
/// the anchor and `(x1, y1)` the live corner, in either order: the box is
/// deliberately unnormalized so a reader that needs min/max says so.
export interface MarqueeBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface State {
  /// null when nothing is drawn — no gesture, or one still under the arm
  /// threshold.
  box: MarqueeBox | null;
  kind: MarqueeKind | null;
}

export const useMarqueeStore = create<State>(() => ({ box: null, kind: null }));

/// Publish the live box. Guarded on VALUE, not identity: a pointermove that
/// lands on the same pixel, or an auto-scroll frame that could not move the
/// host, must not re-render the overlay.
export function setMarqueeBox(box: MarqueeBox, kind: MarqueeKind): void {
  const prev = useMarqueeStore.getState();
  if (
    prev.kind === kind &&
    prev.box !== null &&
    prev.box.x0 === box.x0 &&
    prev.box.y0 === box.y0 &&
    prev.box.x1 === box.x1 &&
    prev.box.y1 === box.y1
  ) {
    return;
  }
  useMarqueeStore.setState({ box, kind });
}

/// Drop the rectangle — release, Escape, or a browser-aborted gesture. Safe to
/// call on a gesture that never armed; that is a no-op, not a write.
export function clearMarquee(): void {
  const prev = useMarqueeStore.getState();
  if (prev.box === null && prev.kind === null) return;
  useMarqueeStore.setState({ box: null, kind: null });
}

export const useMarqueeBox = (): MarqueeBox | null =>
  useMarqueeStore((s) => s.box);

export const useMarqueeKind = (): MarqueeKind | null =>
  useMarqueeStore((s) => s.kind);
