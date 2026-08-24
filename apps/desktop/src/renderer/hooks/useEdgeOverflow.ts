// The DOM side of strip-overflow overlays: read a single-axis scroller, keep
// the two end states current, and act on them. All the geometry lives in
// `lib/edgeOverflow.ts`; this file only measures, subscribes, and writes
// `scrollLeft` / `scrollTop`.
//
// Shared by the dock tab strip and the Quick Actions strip. ADR 0050.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  edgeScrollTarget,
  edgeState,
  overlayClearTarget,
  type EdgeGeometry,
  type EdgeState,
  type ItemRange,
} from "../lib/edgeOverflow";

/// The width (or height) an end overlay covers. Single home for the number: the
/// overlay renders it inline and the geometry reads it from here, so the paint
/// and the maths cannot drift. Sized for a 28px strip — a 16px glyph in a 20px
/// hit box plus a short gradient tail.
export const EDGE_OVERLAY_PX = 24;

export type EdgeAxis = "horizontal" | "vertical";

export interface EdgeOverflowHandle extends EdgeState {
  /// Step one item toward an end; a no-op at that end stop.
  step(toward: "start" | "end"): void;
  /// Lift `item` out from under an end overlay if it has come to rest under one.
  /// A no-op when it already sits in the readable band.
  clearOverlay(item: HTMLElement): void;
}

/// A strip that has not laid out yet reads as "fits, nothing hidden", so an
/// overlay never flashes on during the first frame.
const SETTLED: EdgeState = { overflowing: false, atStart: true, atEnd: true };

function readGeometry(el: HTMLElement, axis: EdgeAxis): EdgeGeometry {
  return axis === "horizontal"
    ? {
        scrollStart: el.scrollLeft,
        viewportSize: el.clientWidth,
        contentSize: el.scrollWidth,
      }
    : {
        scrollStart: el.scrollTop,
        viewportSize: el.clientHeight,
        contentSize: el.scrollHeight,
      };
}

/// An item's extent in the scroller's own coordinates. `offsetLeft` is measured
/// from the nearest positioned ancestor, so this is only the right datum while
/// the scroller itself is that ancestor — which is why callers pass a selector
/// for DIRECT children of a positioned scroller. Dockview's own
/// scroll-into-view leans on the same equivalence.
function readItems(
  el: HTMLElement,
  selector: string,
  axis: EdgeAxis,
): ItemRange[] {
  const items: ItemRange[] = [];
  for (const node of el.querySelectorAll<HTMLElement>(selector)) {
    const start = axis === "horizontal" ? node.offsetLeft : node.offsetTop;
    const size = axis === "horizontal" ? node.offsetWidth : node.offsetHeight;
    items.push([start, start + size]);
  }
  return items;
}

function sameState(a: EdgeState, b: EdgeState): boolean {
  return (
    a.overflowing === b.overflowing &&
    a.atStart === b.atStart &&
    a.atEnd === b.atEnd
  );
}

/**
 * Track which ends of `ref`'s scroller still hide content.
 *
 * `itemSelector` matches the scroller's items and is what makes a step land on
 * an item boundary; a consumer that only paints gradients can omit it and gets
 * the end states alone.
 *
 * Three sources move the answer and all three are watched: the user scrolling,
 * the strip being resized, and its content changing (a Panel opening, a locale
 * switch relabelling every tab). The scroller's own `ResizeObserver` sees none
 * of the last one — adding a tab grows `scrollWidth` without touching the
 * scroller's box — so the mutation observer is load-bearing, not belt-and-braces.
 */
export function useEdgeOverflow(
  ref: RefObject<HTMLElement | null>,
  axis: EdgeAxis,
  itemSelector?: string,
): EdgeOverflowHandle {
  const [state, setState] = useState<EdgeState>(SETTLED);
  // Compared against before every `setState`: scroll fires at frame rate and
  // the answer changes a handful of times per gesture.
  const latest = useRef<EdgeState>(SETTLED);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const next = edgeState(readGeometry(el, axis));
      if (sameState(next, latest.current)) return;
      latest.current = next;
      setState(next);
    };

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(el);
    const mutation =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    mutation?.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      el.removeEventListener("scroll", measure);
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [ref, axis]);

  const scrollTo = useCallback(
    (el: HTMLElement, offset: number) => {
      if (axis === "horizontal") el.scrollLeft = offset;
      else el.scrollTop = offset;
    },
    [axis],
  );

  const step = useCallback(
    (toward: "start" | "end") => {
      const el = ref.current;
      if (!el || !itemSelector) return;
      const view = {
        ...readGeometry(el, axis),
        overlaySize: EDGE_OVERLAY_PX,
      };
      const target = edgeScrollTarget(
        view,
        readItems(el, itemSelector, axis),
        toward,
      );
      if (target !== null) scrollTo(el, target);
    },
    [ref, axis, itemSelector, scrollTo],
  );

  const clearOverlay = useCallback(
    (item: HTMLElement) => {
      const el = ref.current;
      if (!el) return;
      const start = axis === "horizontal" ? item.offsetLeft : item.offsetTop;
      const size = axis === "horizontal" ? item.offsetWidth : item.offsetHeight;
      const target = overlayClearTarget(
        { ...readGeometry(el, axis), overlaySize: EDGE_OVERLAY_PX },
        [start, start + size],
      );
      if (target !== null) scrollTo(el, target);
    },
    [ref, axis, scrollTo],
  );

  return { ...state, step, clearOverlay };
}
