import { describe, expect, it } from "vitest";

import {
  edgeScrollTarget,
  edgeState,
  overlayClearTarget,
  type EdgeGeometry,
  type EdgeScrollView,
  type ItemRange,
} from "./edgeOverflow";

/// Five 80 px items in a 300 px viewport: 400 px of content, so 100 px of
/// travel. The 20 px overlay leaves a 260 px readable band.
const ITEMS: readonly ItemRange[] = [
  [0, 80],
  [80, 160],
  [160, 240],
  [240, 320],
  [320, 400],
];

function view(over: Partial<EdgeScrollView> = {}): EdgeScrollView {
  return {
    scrollStart: 0,
    viewportSize: 300,
    contentSize: 400,
    overlaySize: 20,
    ...over,
  };
}

/// A strip with far more travel than one step can cover (500 px), so a target
/// never lands on an end stop by accident. Ten 80 px items.
const LONG_ITEMS: readonly ItemRange[] = Array.from(
  { length: 10 },
  (_, i) => [i * 80, i * 80 + 80] as ItemRange,
);

function longView(over: Partial<EdgeScrollView> = {}): EdgeScrollView {
  return { ...view({ contentSize: 800 }), ...over };
}

/// Every item fully inside the readable band, given where the scroller sits.
function readable(v: EdgeScrollView, item: ItemRange): boolean {
  const state = edgeState(v);
  const bandStart = v.scrollStart + (state.atStart ? 0 : v.overlaySize);
  const bandEnd =
    v.scrollStart + v.viewportSize - (state.atEnd ? 0 : v.overlaySize);
  return item[0] >= bandStart && item[1] <= bandEnd;
}

describe("edgeState", () => {
  it("reports a strip that fits as at both ends at once", () => {
    const state = edgeState({
      scrollStart: 0,
      viewportSize: 300,
      contentSize: 300,
    });
    expect(state).toEqual({ overflowing: false, atStart: true, atEnd: true });
  });

  // The reason the limit carries a tolerance: without it this strip paints both
  // overlays forever over content the user cannot scroll.
  it("treats an unreachable overflow as no overflow", () => {
    const fractional: EdgeGeometry = {
      scrollStart: 0,
      viewportSize: 300,
      contentSize: 301,
    };
    expect(edgeState(fractional).overflowing).toBe(false);
    expect(edgeState({ ...fractional, contentSize: 303 }).overflowing).toBe(
      true,
    );
  });

  it("names the end that still hides content", () => {
    expect(edgeState(view())).toMatchObject({ atStart: true, atEnd: false });
    expect(edgeState(view({ scrollStart: 50 }))).toMatchObject({
      atStart: false,
      atEnd: false,
    });
    expect(edgeState(view({ scrollStart: 100 }))).toMatchObject({
      atStart: false,
      atEnd: true,
    });
  });

  it("counts an unreachable remainder at an end stop as arrived", () => {
    expect(edgeState(view({ scrollStart: 98.6 })).atEnd).toBe(true);
    expect(edgeState(view({ scrollStart: 98.4 })).atEnd).toBe(false);
  });

  /* A real Group's tab strip, measured: six tabs whose fractional widths reach
   * 373.27 px in a 235.99 px strip. The DOM reports those as `scrollWidth` 374
   * and `clientWidth` 236, so the derived limit is 138 while the browser clamps
   * a scroll to 137.273 — the strip is parked as far right as it can go and the
   * numbers say it is not there yet.
   *
   * Both assertions are the bug this fixture exists for: the trailing overlay has
   * to retire, and its arrow has to admit it has nowhere left to go. Without the
   * second, a step target the browser clamps to the offset the strip already sits
   * at leaves an arrow that does nothing when clicked. */
  it("arrives at an end stop the derived limit overstates", () => {
    const parked = {
      scrollStart: 137.273,
      viewportSize: 236,
      contentSize: 374,
      overlaySize: 24,
    };
    const tabs: readonly ItemRange[] = [
      [0, 60],
      [60, 120],
      [120, 180],
      [180, 240],
      [240, 300],
      [300, 374],
    ];
    expect(edgeState(parked).atEnd).toBe(true);
    expect(edgeScrollTarget(parked, tabs, "end")).toBeNull();
  });
});

describe("edgeScrollTarget", () => {
  it("declines the end it has already reached", () => {
    expect(edgeScrollTarget(view(), ITEMS, "start")).toBeNull();
    expect(edgeScrollTarget(view({ scrollStart: 100 }), ITEMS, "end")).toBeNull();
  });

  it("steps forward far enough to fully reveal the clipped item", () => {
    // [240,320] is the first item reaching past the readable band's 280.
    const target = edgeScrollTarget(view(), ITEMS, "end");
    expect(target).toBe(40);
    expect(readable(view({ scrollStart: target! }), [240, 320])).toBe(true);
  });

  it("steps back far enough to fully reveal the clipped item", () => {
    // At 100 the band opens at 120, so [80,160] is the last item still short of
    // it.
    const target = edgeScrollTarget(view({ scrollStart: 100 }), ITEMS, "start");
    expect(target).toBe(60);
    expect(readable(view({ scrollStart: target! }), [80, 160])).toBe(true);
  });

  it("never overshoots an end stop", () => {
    expect(edgeScrollTarget(view({ scrollStart: 40 }), ITEMS, "end")).toBe(100);
    expect(edgeScrollTarget(view({ scrollStart: 60 }), ITEMS, "start")).toBe(0);
  });

  it("walks the whole strip in single steps and terminates", () => {
    let at = 0;
    const stops: number[] = [at];
    for (let guard = 0; guard < 10; guard += 1) {
      const next = edgeScrollTarget(
        longView({ scrollStart: at }),
        LONG_ITEMS,
        "end",
      );
      if (next === null) break;
      expect(next).toBeGreaterThan(at);
      at = next;
      stops.push(at);
    }
    expect(at).toBe(500);
    // Back down the same strip, and home again.
    for (let guard = 0; guard < 10; guard += 1) {
      const next = edgeScrollTarget(
        longView({ scrollStart: at }),
        LONG_ITEMS,
        "start",
      );
      if (next === null) break;
      expect(next).toBeLessThan(at);
      at = next;
    }
    expect(at).toBe(0);
    expect(stops.length).toBeGreaterThan(2);
  });

  it("goes to the end stop when only the scroller's own padding is left", () => {
    // Items stop at 240 but the content runs to 400 — the strip's own trailing
    // padding. Nothing straddles the overlay, yet there is still travel.
    const padded: readonly ItemRange[] = ITEMS.slice(0, 3);
    expect(edgeScrollTarget(view(), padded, "end")).toBe(100);
  });

  it("goes to the start stop when only leading padding is left", () => {
    const padded: readonly ItemRange[] = [[100, 180]];
    expect(
      edgeScrollTarget(
        view({ scrollStart: 50, viewportSize: 200 }),
        padded,
        "start",
      ),
    ).toBe(0);
  });

  it("handles an empty strip without moving", () => {
    expect(edgeScrollTarget(view(), [], "end")).toBe(100);
    expect(edgeScrollTarget(view({ scrollStart: 100 }), [], "start")).toBe(0);
  });
});

describe("overlayClearTarget", () => {
  it("leaves an item that already rests in the readable band", () => {
    expect(overlayClearTarget(view({ scrollStart: 40 }), [240, 320])).toBeNull();
    expect(overlayClearTarget(view(), [0, 80])).toBeNull();
  });

  // Dockview's own scroll-into-view: `scrollStart = item.start`, flush with the
  // scrollport edge, which is exactly where the leading overlay sits.
  it("lifts a flush-aligned item out from under the leading overlay", () => {
    const flush = longView({ scrollStart: 240 });
    const target = overlayClearTarget(flush, [240, 320]);
    expect(target).toBe(220);
    expect(readable(longView({ scrollStart: target! }), [240, 320])).toBe(true);
  });

  it("pulls an item back from under the trailing overlay", () => {
    const target = overlayClearTarget(longView(), [720, 800]);
    expect(target).toBe(500);
    expect(readable(longView({ scrollStart: target! }), [720, 800])).toBe(true);
  });

  it("needs no second pass after a correction", () => {
    const target = overlayClearTarget(longView({ scrollStart: 240 }), [
      240, 320,
    ])!;
    expect(
      overlayClearTarget(longView({ scrollStart: target }), [240, 320]),
    ).toBeNull();
  });

  // The guarded case: correcting an over-wide item's trailing edge would shove
  // its start under the leading overlay, and the next correction would shove it
  // back. Pinning the start settles in one move and stays settled.
  it("pins an over-wide item's start instead of ping-ponging", () => {
    const wide: ItemRange = [0, 400];
    const first = overlayClearTarget(longView({ scrollStart: 100 }), wide);
    expect(first).toBe(0);
    expect(overlayClearTarget(longView({ scrollStart: first! }), wide)).toBeNull();
  });

  it("declines a correction that would not move the scroller", () => {
    expect(overlayClearTarget(longView({ scrollStart: 220 }), [240, 320])).toBeNull();
  });

  it("stays inside the scroller's travel", () => {
    // An item at the very end of a barely-overflowing strip: the honest
    // correction is the end stop, not past it.
    expect(overlayClearTarget(view({ scrollStart: 0 }), [320, 400])).toBe(100);
  });
});
