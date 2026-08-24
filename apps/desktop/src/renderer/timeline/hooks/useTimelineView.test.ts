// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PX_PER_SEC, HEADER_COL_PX, MAX_PX_PER_SEC } from "../geometry";
import { useTimelineView } from "./useTimelineView";

// The view-state load is the hook's one side effect on mount. Left permanently
// pending here: the zoom under test is then the DEFAULT (no loaded value to
// reason about), no state lands outside `act`, and — because `viewLoadedRef`
// never flips — the debounced save never arms either.
vi.mock("../../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc")>();
  return {
    ...actual,
    viewStateGet: vi.fn(() => new Promise(() => {})),
    viewStateSet: vi.fn().mockResolvedValue(undefined),
  };
});

/// A stand-in scroll root. jsdom lays nothing out, so a real element would
/// report `clientWidth` 0 and swallow every `scrollLeft` write; the hook only
/// needs those two properties plus the wheel listener's registration.
function root(laneWidthPx = 1000): {
  ref: React.RefObject<HTMLDivElement | null>;
  el: {
    clientWidth: number;
    scrollLeft: number;
    /// The captured wheel listener — the only way to exercise the pointer path,
    /// since a real dispatch would still need a laid-out node underneath.
    wheel: ((e: WheelEvent) => void) | null;
  };
} {
  const el = {
    clientWidth: laneWidthPx + HEADER_COL_PX,
    scrollLeft: 0,
    wheel: null as ((e: WheelEvent) => void) | null,
    addEventListener: (_t: string, fn: (e: WheelEvent) => void) => {
      el.wheel = fn;
    },
    removeEventListener: () => {
      el.wheel = null;
    },
    // The gesture measures the cursor from the scrolling body's left edge; a
    // lane flush with the viewport keeps that arithmetic readable.
    getBoundingClientRect: () => ({ left: 0, top: 0 }) as DOMRect,
  };
  return { ref: { current: el as unknown as HTMLDivElement }, el };
}

/// A 60 s project: at the mocked-away default of 80 px/s that is a 4800 px
/// canvas, so the 1000 px lane is a small window onto it and the fit-to-project
/// zoom-out stop sits at 1000/60 px/s.
const LONG = { tracks: [], durationUs: 60_000_000 };

/// The time showing at `anchorX` in the lane — the quantity a zoom must not
/// change.
const timeAtSec = (scrollLeft: number, anchorX: number, pxPerSec: number) =>
  (scrollLeft + anchorX) / pxPerSec;

describe("useTimelineView keyboard zoom", () => {
  afterEach(cleanup);

  it("doubles the zoom and holds the playhead where it sits", () => {
    const { ref, el } = root();
    el.scrollLeft = 1000;
    const { result } = renderHook(() => useTimelineView({ rootRef: ref, ...LONG }));

    // 15 s is 1200 px at 80 px/s — 200 px into the [1000, 2000) window.
    act(() => result.current.zoomBySteps(1, 15_000_000));

    expect(result.current.pxPerSec).toBe(DEFAULT_PX_PER_SEC * 2);
    expect(el.scrollLeft).toBe(2200);
    expect(timeAtSec(el.scrollLeft, 200, result.current.pxPerSec)).toBe(15);
  });

  it("halves the zoom on the way out, still holding the playhead", () => {
    const { ref, el } = root();
    el.scrollLeft = 1000;
    const { result } = renderHook(() => useTimelineView({ rootRef: ref, ...LONG }));

    act(() => result.current.zoomBySteps(-1, 15_000_000));

    expect(result.current.pxPerSec).toBe(DEFAULT_PX_PER_SEC / 2);
    expect(timeAtSec(el.scrollLeft, 200, result.current.pxPerSec)).toBe(15);
  });

  // A zoom is a magnification, not a seek: the view must widen around what the
  // user is looking at, not jump back to a playhead they scrolled away from.
  it("holds the lane's centre when the playhead is off screen", () => {
    const { ref, el } = root();
    el.scrollLeft = 1000;
    const { result } = renderHook(() => useTimelineView({ rootRef: ref, ...LONG }));
    const centreSec = timeAtSec(1000, 500, DEFAULT_PX_PER_SEC);

    act(() => result.current.zoomBySteps(1, 0)); // playhead at t=0, far left of the window

    expect(el.scrollLeft).toBe(2500);
    expect(timeAtSec(el.scrollLeft, 500, result.current.pxPerSec)).toBe(centreSec);
  });

  it("stops at the fit-to-project zoom rather than past it", () => {
    const { ref, el } = root();
    const { result } = renderHook(() => useTimelineView({ rootRef: ref, ...LONG }));

    act(() => result.current.zoomBySteps(-1, 0)); // 40
    act(() => result.current.zoomBySteps(-1, 0)); // 20
    act(() => result.current.zoomBySteps(-1, 0)); // 1000/60, not 10
    expect(result.current.pxPerSec).toBeCloseTo(1000 / 60, 10);

    // Parked against the stop: the press changes nothing, and must not move the
    // view either.
    const parked = { pxPerSec: result.current.pxPerSec, scrollLeft: el.scrollLeft };
    act(() => result.current.zoomBySteps(-1, 0));
    expect(result.current.pxPerSec).toBe(parked.pxPerSec);
    expect(el.scrollLeft).toBe(parked.scrollLeft);
  });

  it("stops at the hard ceiling on the way in", () => {
    const { ref } = root();
    const { result } = renderHook(() => useTimelineView({ rootRef: ref, ...LONG }));

    for (let i = 0; i < 10; i++) act(() => result.current.zoomBySteps(1, 0));
    expect(result.current.pxPerSec).toBe(MAX_PX_PER_SEC);
  });

  // The invariant the anchoring exists for: an on-screen playhead is still
  // on-screen afterwards, at every rung of the ladder and from either end of
  // the lane. Without it, zooming in at 25× would fling the marker off the edge.
  it("keeps an on-screen playhead on screen across the whole range", () => {
    for (const anchorX of [0, 1, 500, 999, 1000]) {
      const { ref, el } = root();
      el.scrollLeft = 1000;
      const { result, unmount } = renderHook(() =>
        useTimelineView({ rootRef: ref, ...LONG }),
      );
      const tUs = ((1000 + anchorX) / DEFAULT_PX_PER_SEC) * 1_000_000;

      for (let i = 0; i < 5; i++) {
        act(() => result.current.zoomBySteps(1, tUs));
        const x = (tUs / 1_000_000) * result.current.pxPerSec - el.scrollLeft;
        expect(x, `anchorX ${anchorX}, step ${i + 1}`).toBeGreaterThanOrEqual(0);
        expect(x, `anchorX ${anchorX}, step ${i + 1}`).toBeLessThanOrEqual(1000);
      }
      unmount();
    }
  });
});

describe("useTimelineView wheel zoom", () => {
  afterEach(cleanup);

  /// One notch of the wheel over the middle of the lane, with whatever modifier
  /// the case is about. Negative deltaY is "away from the user" = zoom in.
  function notch(over: Partial<WheelEvent>) {
    const preventDefault = vi.fn();
    const event = {
      deltaY: -100,
      deltaMode: 0,
      clientX: HEADER_COL_PX + 500,
      ctrlKey: false,
      altKey: false,
      preventDefault,
      ...over,
    } as unknown as WheelEvent;
    return { event, preventDefault };
  }

  // Ctrl is the web's zoom modifier and Resolve's; Alt is Premiere's. Both are
  // live, because the muscle memory a user arrives with is whichever NLE their
  // hands came from.
  it.each([["ctrlKey"], ["altKey"]])("zooms under %s", (mod) => {
    const { ref, el } = root();
    const { result } = renderHook(() => useTimelineView({ rootRef: ref, ...LONG }));
    const { event, preventDefault } = notch({ [mod]: true });

    act(() => el.wheel?.(event));

    expect(result.current.pxPerSec).toBeGreaterThan(DEFAULT_PX_PER_SEC);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  // The bare wheel and Shift belong to the scroll gesture
  // (`hooks/useWheelScroll.ts`). Precedence between the two listeners on this
  // node is decided by the modifier, never by which effect registered first —
  // so this handler must not even claim the event.
  it("leaves an unmodified wheel to the scroll gesture", () => {
    const { ref, el } = root();
    const { result } = renderHook(() => useTimelineView({ rootRef: ref, ...LONG }));
    const { event, preventDefault } = notch({ shiftKey: true });

    act(() => el.wheel?.(event));

    expect(result.current.pxPerSec).toBe(DEFAULT_PX_PER_SEC);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
