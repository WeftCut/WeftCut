// Which link the pointer is resting on, for the hull (`LinkHull.tsx`, its only
// subscriber). `LayerBlock` is the only writer, from its own enter/leave.
//
// A module-level store for the reason `marqueeStore.ts` states: hover is event
// rate, and one `useState` on the timeline root would re-render every lane per
// crossing. Atomic selectors only (`feedback_zustand_composite_selector`).

import { create } from "zustand";

interface State {
  linkId: string | null;
}

export const useLinkHoverStore = create<State>(() => ({ linkId: null }));

/// The clear scheduled by the last leave, or 0. Deferred by ONE FRAME so that
/// crossing from one member of a link straight onto another — leave A, enter
/// B, same event turn — never publishes the null in between and the hull does
/// not flicker. Entering a member of a DIFFERENT link publishes immediately.
let pendingClear = 0;

// Resolved per call, not at load: a test's fake clock replaces the globals
// after this module is imported.
const schedule = (cb: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
const cancel = (id: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
};

export function hoverLink(linkId: string): void {
  if (pendingClear !== 0) {
    cancel(pendingClear);
    pendingClear = 0;
  }
  if (useLinkHoverStore.getState().linkId === linkId) return;
  useLinkHoverStore.setState({ linkId });
}

/// Leave one member. Ignored when a different link has the hover — a leave that
/// arrives after the next link's enter must not clear the newer hover.
export function unhoverLink(linkId: string): void {
  if (useLinkHoverStore.getState().linkId !== linkId) return;
  if (pendingClear !== 0) return;
  pendingClear = schedule(() => {
    pendingClear = 0;
    if (useLinkHoverStore.getState().linkId === linkId) {
      useLinkHoverStore.setState({ linkId: null });
    }
  });
}

/// Drop the hover and any pending clear at once — test teardown.
export function resetLinkHover(): void {
  if (pendingClear !== 0) {
    cancel(pendingClear);
    pendingClear = 0;
  }
  if (useLinkHoverStore.getState().linkId !== null) {
    useLinkHoverStore.setState({ linkId: null });
  }
}

export const useHoveredLinkId = (): string | null =>
  useLinkHoverStore((s) => s.linkId);
