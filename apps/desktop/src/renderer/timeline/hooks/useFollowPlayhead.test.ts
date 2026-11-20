// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePlaybackStore } from "../../state/playbackStore";
import {
  seekPlayheadTimeUs,
  setPlayheadTimeUs,
  usePlayheadStore,
} from "../../state/playheadStore";
import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
} from "../../state/timelineScrollStore";
import { useFollowPlayhead } from "./useFollowPlayhead";

/// A stand-in scroll root. The hook only ever WRITES `scrollLeft` (it reads the
/// offset from the scroll store), so a plain object suffices — and jsdom would
/// clamp a real element's `scrollLeft` to 0 anyway, since it never lays out.
function root(): { current: HTMLDivElement | null; el: { scrollLeft: number } } {
  const el = { scrollLeft: 0 };
  return { current: el as unknown as HTMLDivElement, el };
}

/// A scroll root whose `scrollLeft` snaps on write, the way the DOM snaps an
/// offset to device pixels.
function snappingRoot(): { current: HTMLDivElement | null; el: { scrollLeft: number } } {
  let v = 0;
  const el = {
    get scrollLeft() { return v; },
    set scrollLeft(px: number) { v = Math.round(px); },
  };
  return { current: el as unknown as HTMLDivElement, el };
}

/// A scroll the hook did not make, landing the way the Timeline's scroll
/// listener lands it: on the node, then published.
function userScroll(el: { scrollLeft: number }, px: number): void {
  act(() => {
    el.scrollLeft = px;
    setTimelineScrollLeftPx(null, px);
  });
}

/// The root's own anchor: offset 0, on screen at every moment, so the Panel's
/// reading of the one moment is the moment itself.
const ROOT_FRAME = {
  offsetUs: 0,
  windowStartUs: Number.NEGATIVE_INFINITY,
  windowEndUs: Number.POSITIVE_INFINITY,
  fpsNum: 30,
  fpsDen: 1,
};

/// 100 px/s over a 1000 px viewport: one screenful is 10 s of content.
const VIEW = {
  pxPerSec: 100,
  viewportWidthPx: 1000,
  contentWidthPx: 10_000,
  enabled: true,
  anchorFrame: ROOT_FRAME,
};

describe("useFollowPlayhead", () => {
  // Both stores are module-global, and an un-unmounted hook stays subscribed to
  // the playhead — a leaked one from an earlier case would scroll this one's
  // view. Reset the state, drop the subscribers.
  beforeEach(() => {
    usePlayheadStore.setState({ timeUs: 0 });
    usePlaybackStore.setState({ playing: false });
    setTimelineScrollLeftPx(null, 0);
  });
  afterEach(cleanup);

  it("pages the view when playback walks the playhead off the right edge", () => {
    const rootRef = root();
    renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));

    act(() => setPlayheadTimeUs(5_000_000)); // 500 px — still in view
    expect(rootRef.el.scrollLeft).toBe(0);

    act(() => setPlayheadTimeUs(10_000_000)); // 1000 px — past the edge
    expect(rootRef.el.scrollLeft).toBe(920);
    // Published eagerly so the ruler's tick window lands with the jump rather
    // than one frame later.
    expect(timelineScrollLeftPx(null)).toBe(920);
  });

  it("brings the playhead back after a backward jump", () => {
    const rootRef = root();
    setTimelineScrollLeftPx(null, 5000);
    renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));

    act(() => setPlayheadTimeUs(2_000_000)); // 200 px, far left of the window
    expect(rootRef.el.scrollLeft).toBe(0);
  });

  it("holds the view still while the ruler is being scrubbed", () => {
    const rootRef = root();
    const { result } = renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));

    act(() => result.current.setScrubbing(true));
    act(() => setPlayheadTimeUs(30_000_000));
    expect(rootRef.el.scrollLeft).toBe(0);
    expect(timelineScrollLeftPx(null)).toBe(0);

    // Released: the next playhead move follows again.
    act(() => result.current.setScrubbing(false));
    act(() => setPlayheadTimeUs(31_000_000));
    expect(rootRef.el.scrollLeft).toBe(3020);
  });

  it("does nothing while disabled, and catches up when switched on", () => {
    const rootRef = root();
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useFollowPlayhead({ compositionId: null, rootRef, ...VIEW, enabled: props.enabled }),
      { initialProps: { enabled: false } },
    );

    act(() => setPlayheadTimeUs(40_000_000));
    expect(rootRef.el.scrollLeft).toBe(0);

    rerender({ enabled: true });
    expect(rootRef.el.scrollLeft).toBe(3920);
  });

  // Zoom picks its own anchor (`timeline/zoom.ts`). Re-anchoring on a pxPerSec
  // change would silently override that on every wheel tick.
  it("does not re-anchor when only the zoom changes", () => {
    const rootRef = root();
    const { rerender } = renderHook(
      (props: { pxPerSec: number }) =>
        useFollowPlayhead({ compositionId: null, rootRef, ...VIEW, pxPerSec: props.pxPerSec }),
      { initialProps: { pxPerSec: 100 } },
    );

    act(() => setPlayheadTimeUs(3_000_000)); // 300 px @ 100 px/s — in view
    expect(rootRef.el.scrollLeft).toBe(0);

    // At 500 px/s the playhead sits at 1500 px, well outside the window.
    rerender({ pxPerSec: 500 });
    expect(rootRef.el.scrollLeft).toBe(0);

    // …but the zoom IS picked up by the next real playhead move.
    act(() => setPlayheadTimeUs(3_100_000));
    expect(rootRef.el.scrollLeft).toBe(1470);
  });

  // A mount's first commit has no measurement (the layout effect that takes it
  // has not run yet), so the catch-up has to survive until one lands.
  it("catches up when the viewport is first measured", () => {
    const rootRef = root();
    setTimelineScrollLeftPx(null, 0);
    usePlayheadStore.setState({ timeUs: 40_000_000 });
    const { rerender } = renderHook(
      (props: { viewportWidthPx: number }) =>
        useFollowPlayhead({ compositionId: null, rootRef, ...VIEW, ...props }),
      { initialProps: { viewportWidthPx: 0 } },
    );
    expect(rootRef.el.scrollLeft).toBe(0);

    rerender({ viewportWidthPx: 1000 });
    expect(rootRef.el.scrollLeft).toBe(3920);
  });

  it("stops following once unmounted", () => {
    const rootRef = root();
    const { unmount } = renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
    unmount();

    act(() => setPlayheadTimeUs(50_000_000));
    expect(rootRef.el.scrollLeft).toBe(0);
  });

  it("preserves manual scrolling when a track edit refreshes an unchanged clock, and still follows a seek", () => {
    const rootRef = root();
    const { rerender } = renderHook(
      ({ anchorFrame }) => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW, anchorFrame }),
      { initialProps: { anchorFrame: ROOT_FRAME } },
    );
    userScroll(rootRef.el, 2000);
    rerender({ anchorFrame: { ...ROOT_FRAME } });
    expect(rootRef.el.scrollLeft).toBe(2000);
    act(() => seekPlayheadTimeUs(40_000_000));
    expect(rootRef.el.scrollLeft).toBe(3920);
  });

  it("reprojects when the composition's actual clock changes", () => {
    const rootRef = root();
    const { rerender } = renderHook(
      ({ anchorFrame }) => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW, anchorFrame }),
      { initialProps: { anchorFrame: ROOT_FRAME } },
    );
    act(() => setPlayheadTimeUs(5_000_000));
    rerender({ anchorFrame: { ...ROOT_FRAME, offsetUs: -20_000_000 } });
    expect(rootRef.el.scrollLeft).toBe(2420);
  });

  describe("yielding to the user's view", () => {
    it("leaves a view scrolled ahead of the playhead where the user put it", () => {
      const rootRef = root();
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
      act(() => setPlayheadTimeUs(5_000_000)); // 500 px

      userScroll(rootRef.el, 3000); // playhead now off the left edge
      act(() => setPlayheadTimeUs(5_100_000));
      act(() => setPlayheadTimeUs(5_200_000));
      expect(rootRef.el.scrollLeft).toBe(3000);
      expect(timelineScrollLeftPx(null)).toBe(3000);
    });

    it("leaves a view scrolled back behind the playhead where the user put it", () => {
      const rootRef = root();
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
      act(() => setPlayheadTimeUs(50_000_000));
      expect(rootRef.el.scrollLeft).toBe(4920);

      userScroll(rootRef.el, 0); // playhead now off the right edge
      act(() => setPlayheadTimeUs(50_100_000));
      expect(rootRef.el.scrollLeft).toBe(0);
    });

    it("pages again once the playhead has played into the held view", () => {
      const rootRef = root();
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
      act(() => setPlayheadTimeUs(5_000_000));

      userScroll(rootRef.el, 600); // the playhead (500 px) is behind the view
      act(() => setPlayheadTimeUs(6_050_000)); // inside the left edge's pad
      act(() => setPlayheadTimeUs(7_000_000)); // comfortably inside
      expect(rootRef.el.scrollLeft).toBe(600);

      act(() => setPlayheadTimeUs(16_000_000)); // the right edge
      expect(rootRef.el.scrollLeft).toBe(1520);
    });

    it("does not re-arm on a frame where the view is still moving", () => {
      const rootRef = root();
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
      act(() => setPlayheadTimeUs(5_000_000));

      // Each frame of the gesture sees the playhead comfortably inside a view
      // that has just moved; the frame after lands it off the edge.
      userScroll(rootRef.el, 100);
      act(() => setPlayheadTimeUs(5_100_000));
      userScroll(rootRef.el, 3000);
      act(() => setPlayheadTimeUs(5_200_000));
      expect(rootRef.el.scrollLeft).toBe(3000);
    });

    it("brings the view to the playhead on a seek", () => {
      const rootRef = root();
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
      act(() => setPlayheadTimeUs(5_000_000));
      userScroll(rootRef.el, 3000);
      act(() => setPlayheadTimeUs(5_100_000));

      act(() => seekPlayheadTimeUs(40_000_000));
      expect(rootRef.el.scrollLeft).toBe(3920);
    });

    // Behind the view, but running forward: it lands on the lead with the
    // screen ahead of it in view, not near the right edge as a step back would.
    it("brings the view to the playhead when playback starts, with the screen ahead in view", () => {
      const rootRef = root();
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
      act(() => seekPlayheadTimeUs(35_000_000));
      expect(rootRef.el.scrollLeft).toBe(3420);
      userScroll(rootRef.el, 5000); // the playhead (3500 px) is behind the view
      act(() => setPlayheadTimeUs(35_100_000));
      expect(rootRef.el.scrollLeft).toBe(5000);

      act(() => usePlaybackStore.setState({ playing: true }));
      act(() => setPlayheadTimeUs(35_200_000));
      expect(rootRef.el.scrollLeft).toBeCloseTo(3440);
    });

    it("lands a seek back near the right edge, so the next step back stays in view", () => {
      const rootRef = root();
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW }));
      act(() => seekPlayheadTimeUs(50_000_000));
      expect(rootRef.el.scrollLeft).toBe(4920);

      act(() => seekPlayheadTimeUs(45_000_000)); // 4500 px, off the left edge
      expect(rootRef.el.scrollLeft).toBe(3580);
    });

    it("does not take its own snapped page for a user scroll", () => {
      const rootRef = snappingRoot();
      // A zoom that puts frames on fractional pixels.
      renderHook(() => useFollowPlayhead({ compositionId: null, rootRef, ...VIEW, pxPerSec: 100.05 }));

      act(() => setPlayheadTimeUs(10_000_000)); // pages to 920.5, snapped
      expect(rootRef.el.scrollLeft).toBe(921);
      // The scroll event lands and publishes the snapped offset.
      act(() => setTimelineScrollLeftPx(null, rootRef.el.scrollLeft));

      act(() => setPlayheadTimeUs(19_500_000)); // the next right edge
      expect(rootRef.el.scrollLeft).toBe(1871);
    });
  });
});
