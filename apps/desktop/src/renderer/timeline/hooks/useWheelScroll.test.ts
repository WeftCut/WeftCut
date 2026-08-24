// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineWheelAxis } from "../../ipc";
import { useWheelScroll } from "./useWheelScroll";

// The axis is a preference read imperatively per event; mocking the accessor
// keeps this test about the LISTENER (registration, preventDefault, which
// scroll offset moves) and leaves the mapping table to wheelScroll.test.ts.
let axis: TimelineWheelAxis = "horizontal";
vi.mock("../../settings/appSettingsStore", () => ({
  timelineWheelAxis: () => axis,
}));

/// A stand-in scroll root that captures the wheel listener. jsdom lays nothing
/// out, so a real element would swallow every `scrollLeft` write (same reason
/// `useFollowPlayhead.test.ts` fakes its root) and dispatching a real
/// WheelEvent would tell us nothing about what moved.
function root() {
  const el = {
    scrollLeft: 0,
    scrollTop: 0,
    listener: null as ((e: WheelEvent) => void) | null,
    addEventListener(_type: string, fn: (e: WheelEvent) => void) {
      el.listener = fn;
    },
    removeEventListener() {
      el.listener = null;
    },
  };
  return { ref: { current: el as unknown as HTMLDivElement }, el };
}

/// One pixel-mode notch down, with whatever modifiers the case needs.
function notch(over: Partial<WheelEvent> = {}) {
  const preventDefault = vi.fn();
  const event = {
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault,
    ...over,
  } as unknown as WheelEvent;
  return { event, preventDefault };
}

describe("useWheelScroll", () => {
  beforeEach(() => {
    axis = "horizontal";
  });
  afterEach(cleanup);

  it("walks time on a bare notch and claims the gesture", () => {
    const { ref, el } = root();
    renderHook(() => useWheelScroll(ref));
    const { event, preventDefault } = notch();

    el.listener?.(event);

    expect(el.scrollLeft).toBe(100);
    expect(el.scrollTop).toBe(0);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("walks tracks under Shift", () => {
    const { ref, el } = root();
    renderHook(() => useWheelScroll(ref));
    const { event, preventDefault } = notch({ shiftKey: true });

    el.listener?.(event);

    expect(el.scrollTop).toBe(100);
    expect(el.scrollLeft).toBe(0);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  // The zoom gesture in useTimelineView owns Ctrl and Alt. Nothing here may
  // touch those events — not the offsets, and not preventDefault, or the two
  // listeners on the same node would be fighting over one wheel tick.
  it("leaves the zoom modifiers to the zoom gesture", () => {
    const { ref, el } = root();
    renderHook(() => useWheelScroll(ref));
    for (const mod of [{ ctrlKey: true }, { altKey: true }]) {
      const { event, preventDefault } = notch(mod);
      el.listener?.(event);
      expect(el.scrollLeft).toBe(0);
      expect(el.scrollTop).toBe(0);
      expect(preventDefault).not.toHaveBeenCalled();
    }
  });

  // Vertical mode is Chromium's own mapping — the handler must stay out of the
  // way entirely rather than reimplement it and lose the platform's smoothing.
  it("touches nothing in vertical mode", () => {
    axis = "vertical";
    const { ref, el } = root();
    renderHook(() => useWheelScroll(ref));
    const { event, preventDefault } = notch();

    el.listener?.(event);

    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("unregisters on unmount", () => {
    const { ref, el } = root();
    const { unmount } = renderHook(() => useWheelScroll(ref));
    expect(el.listener).not.toBeNull();
    unmount();
    expect(el.listener).toBeNull();
  });
});
