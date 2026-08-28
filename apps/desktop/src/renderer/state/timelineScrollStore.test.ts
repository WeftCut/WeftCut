import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
  useTimelineScrollStore,
} from "./timelineScrollStore";

beforeEach(() => useTimelineScrollStore.setState({ scrollLeftPx: {} }));

describe("timelineScrollStore", () => {
  // Two timeline Panels scroll independently (ADR 0053), and each one's ruler
  // builds its tick window from its OWN offset — one shared number would have
  // every ruler follow whichever Panel was scrolled last.
  it("keeps one offset per composition", () => {
    setTimelineScrollLeftPx("comp-root", 900);
    setTimelineScrollLeftPx("comp-group", 40);

    expect(timelineScrollLeftPx("comp-root")).toBe(900);
    expect(timelineScrollLeftPx("comp-group")).toBe(40);
  });

  it("reads a composition with no timeline mounted as the start of the row", () => {
    expect(timelineScrollLeftPx("comp-never-opened")).toBe(0);
  });

  it("gives the unbound row a key no composition can collide with", () => {
    setTimelineScrollLeftPx(null, 120);
    expect(timelineScrollLeftPx(null)).toBe(120);
    expect(timelineScrollLeftPx("comp-root")).toBe(0);
  });

  it("clamps a negative or non-finite offset rather than publishing it", () => {
    setTimelineScrollLeftPx("comp-root", -20);
    expect(timelineScrollLeftPx("comp-root")).toBe(0);
    setTimelineScrollLeftPx("comp-root", Number.NaN);
    expect(timelineScrollLeftPx("comp-root")).toBe(0);
  });

  it("is not a store write when the offset has not moved", () => {
    const listener = vi.fn();
    setTimelineScrollLeftPx("comp-root", 300);
    const unsubscribe = useTimelineScrollStore.subscribe(listener);
    try {
      setTimelineScrollLeftPx("comp-root", 300);
      expect(listener).not.toHaveBeenCalled();
      setTimelineScrollLeftPx("comp-root", 301);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
});
