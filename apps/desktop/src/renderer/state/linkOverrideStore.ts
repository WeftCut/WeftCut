// Link override — the one switch that stands in for a held `Alt`.
//
// While it is on, every timeline site that would fan an edit out across a
// link treats the link as absent (`linkFanoutActive` in
// `timeline/linkEligibility.ts` is the predicate they all read). Reaper's
// *Grouping enabled* toggle is the precedent: a long stretch of single-layer
// fine-tuning should not be a held key, and `Alt` is already two things on a
// clip (escape on a handle, duplicate on the body).
//
// Session state, never persisted and never recorded in history, for the same
// reason the in/out range isn't (`rangeStore.ts`): it is where the user is in
// a work session, not a property of the project. Links themselves are
// untouched — the project keeps every membership, and MCP callers are
// unaffected: an agent passes `escape_link` explicitly.
//
// Module-level store because its readers sit off App's props chain (the
// Quick Actions strip, the status bar, the drag hook). Subscribers use the
// atomic hook below (`feedback_zustand_composite_selector`).

import { create } from "zustand";

interface State {
  on: boolean;
}

export const useLinkOverrideStore = create<State>(() => ({ on: false }));

export function toggleLinkOverride(): void {
  useLinkOverrideStore.setState((s) => ({ on: !s.on }));
}

export function setLinkOverride(on: boolean): void {
  useLinkOverrideStore.setState({ on });
}

/// Imperative read for event-time callers — shortcut handlers, the drag
/// hook's seed, a context-menu row — that must not subscribe.
export function linkOverrideOn(): boolean {
  return useLinkOverrideStore.getState().on;
}

/// Subscription form, for the chip, the strip button and the accents that
/// must re-render when the switch flips.
export const useLinkOverride = (): boolean =>
  useLinkOverrideStore((s) => s.on);
