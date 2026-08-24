import { useEffect } from "react";

import { timelineWheelAxis } from "../../settings/appSettingsStore";
import { wheelScrollPlan } from "../wheelScroll";

/// Maps the bare wheel onto the timeline's dominant axis, the way Premiere and
/// Resolve do: time under the bare wheel, tracks under Shift. The axis is a
/// preference (`app_settings.timeline_wheel_axis`), and `vertical` opts back
/// into Chromium's own mapping — the mapping table itself is `wheelScroll.ts`.
///
/// The axis is read imperatively per event rather than through a selector hook:
/// this hook is mounted by `Timeline`, the whole timeline tree, and subscribing
/// that to a settings field would re-render it — and re-register this listener —
/// on every unrelated settings write.
export function useWheelScroll(
  rootRef: React.RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      const plan = wheelScrollPlan(e, timelineWheelAxis());
      if (plan === null) return;
      // Claimed even when the axis is already at its end stop, rather than
      // falling through to a default action that would scroll the OTHER axis
      // instead: "pressing into a stop is a no-op, not a nudge" is the rule the
      // zoom gesture already follows (docs/features.md, Timeline zoom). The
      // Quick Actions strip makes the opposite call for the opposite reason —
      // it is a small control inside a scrolling panel, so its overflow has
      // somewhere to go.
      e.preventDefault();
      if (plan.dx !== 0) root.scrollLeft += plan.dx;
      if (plan.dy !== 0) root.scrollTop += plan.dy;
      // No store write here: the assignments above fire a `scroll` event, and
      // Timeline's rAF-coalesced publisher is the one writer of
      // `timelineScrollStore` (which is also why this must never become React
      // state — see that store's header).
    };
    // Not passive: the handler calls preventDefault whenever it claims the
    // gesture, and React's JSX `onWheel` is registered passive in modern React,
    // where preventDefault silently fails.
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [rootRef]);
}
