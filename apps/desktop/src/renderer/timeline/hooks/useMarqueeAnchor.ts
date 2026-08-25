// The marquee gesture: one pointerdown handler that four timeline surfaces opt
// into explicitly. A whitelist rather than a root-level funnel, so a future
// clickable child does not have to remember to `stopPropagation` out of it.
//
// Owns the box's whole lifecycle — arm, track, edge auto-scroll, cancel — and
// knows nothing about what the box selects: that leaves through `onBox`. The
// rectangle itself lives in `../marqueeStore.ts`, which also defines what a
// `MarqueeKind` means.

import {
  createContext,
  useCallback,
  useContext,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { HEADER_COL_PX } from "../geometry";
import { activeTool } from "../../state/toolStore";
import {
  clearMarquee,
  setMarqueeBox,
  type MarqueeBox,
  type MarqueeKind,
} from "../marqueeStore";

/// Pointer travel that turns a press into a box. Below it the gesture is a
/// background click and each anchor surface's own click semantics stand.
///
/// Displacement, not a delay like `useLayerDrag`'s
/// `UNSELECTED_CLIP_DRAG_ARM_MS`: nothing sits under the pointer that a wobble
/// could move, so there is nothing for a timer to protect.
const ARM_TRAVEL_PX = 3;

// Edge auto-scroll band and speed, matching `hooks/usePointerReorder.ts` so a
// drag that reaches a scroll host's edge behaves the same everywhere.
const EDGE_BAND_PX = 28;
const EDGE_SPEED_PX = 12;

/// The three things the gesture needs and no anchor surface has.
export interface MarqueeAnchor {
  /// `timeline-canvas` — the element the box's coordinates are relative to.
  canvasRef: RefObject<HTMLElement | null>;
  /// The timeline's scroll root, the canvas's scrolling ancestor.
  scrollRootRef: RefObject<HTMLElement | null>;
  /// Every box the gesture publishes. The hit-test lives on the far side of
  /// this seam, so the gesture's lifecycle is provable without it.
  onBox: (box: MarqueeBox, kind: MarqueeKind) => void;
}

/// A context rather than props: the anchor surfaces are up to three components
/// away from the Timeline that owns all three values, and threading two refs
/// plus a callback down each chain would put marquee plumbing into the
/// signature of every component in between. The provider MUST memoize its
/// value — an object rebuilt per render re-renders every consumer.
export const MarqueeAnchorContext = createContext<MarqueeAnchor | null>(null);

/// Start a marquee from `e`. Exported for the Timeline, which provides the
/// context and so cannot consume it; every other surface goes through
/// `useMarqueeAnchor`.
export function beginMarquee(
  anchor: MarqueeAnchor,
  kind: MarqueeKind,
  e: ReactPointerEvent,
): void {
  if (e.button !== 0) return;
  // Event-time read, deliberately not a subscription: blade mode hijacks the
  // timeline's pointer surface, and `useActiveTool()` here would re-render all
  // four anchor surfaces on every tool switch (`state/toolStore.ts`).
  if (activeTool() === "blade") return;
  const canvas = anchor.canvasRef.current;
  if (canvas === null) return;
  // So a lane's anchor does not also fire the scroll body's.
  e.stopPropagation();
  // A sweep must not also start a native text selection. Focus is unaffected:
  // `focus/useFocusRegions.ts` runs its pointerdown listener in the capture
  // phase at `window` precisely because gestures cancel the default action.
  e.preventDefault();

  const startRect = canvas.getBoundingClientRect();
  const x0 = e.clientX - startRect.left;
  const y0 = e.clientY - startRect.top;
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const host = anchor.scrollRootRef.current;

  let armed = false;
  let lastClientX = startClientX;
  let lastClientY = startClientY;
  let speed = 0;
  let raf = 0;

  // The canvas rect is re-read per publish, never cached: it moves with the
  // host's scroll, which is what makes the box keep growing under a pointer
  // held still in the edge band.
  const publish = () => {
    const rect = canvas.getBoundingClientRect();
    const box: MarqueeBox = {
      x0,
      y0,
      x1: lastClientX - rect.left,
      y1: lastClientY - rect.top,
    };
    setMarqueeBox(box, kind);
    anchor.onBox(box, kind);
  };

  // A rAF pump so holding the pointer at the edge keeps scrolling, instead of
  // advancing one step per pointermove event.
  const pump = () => {
    raf = 0;
    if (host === null || speed === 0) return;
    const before = host.scrollLeft;
    host.scrollLeft += speed;
    if (host.scrollLeft !== before) publish();
    raf = requestAnimationFrame(pump);
  };
  // Horizontal only. The timeline's vertical extent is a handful of lanes,
  // while `computeTimelineExtent` leaves the horizontal one unbounded.
  const updateAutoScroll = () => {
    if (host === null) return;
    const rect = host.getBoundingClientRect();
    // The left band starts after the sticky header column, which overlays the
    // host's left edge: measured from `rect.left` it would sit under chrome the
    // pointer never reaches while it is over a lane.
    if (lastClientX < rect.left + HEADER_COL_PX + EDGE_BAND_PX) {
      speed = -EDGE_SPEED_PX;
    } else if (lastClientX > rect.right - EDGE_BAND_PX) {
      speed = EDGE_SPEED_PX;
    } else {
      speed = 0;
    }
    if (speed !== 0 && raf === 0) raf = requestAnimationFrame(pump);
  };

  const onMove = (ev: PointerEvent) => {
    lastClientX = ev.clientX;
    lastClientY = ev.clientY;
    if (!armed) {
      const travel = Math.hypot(
        ev.clientX - startClientX,
        ev.clientY - startClientY,
      );
      if (travel < ARM_TRAVEL_PX) return;
      armed = true;
    }
    publish();
    updateAutoScroll();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") end();
  };
  const end = () => {
    speed = 0;
    if (raf !== 0) cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("keydown", onKey);
    clearMarquee();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", end);
  // A browser-aborted gesture must not stay armed, or the next unrelated
  // pointerup reads as this one's release.
  window.addEventListener("pointercancel", end);
  window.addEventListener("keydown", onKey);
}

/// Arms one anchor surface. `kind` is the surface's own answer to "which
/// population does a box started here take" — never re-derived from geometry.
export function useMarqueeAnchor({ kind }: { kind: MarqueeKind }): {
  onPointerDown: (e: ReactPointerEvent) => void;
} {
  const anchor = useContext(MarqueeAnchorContext);
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (anchor === null) return;
      beginMarquee(anchor, kind, e);
    },
    [anchor, kind],
  );
  return { onPointerDown };
}
