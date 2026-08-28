import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  setTimelineScrollLeftPx,
  timelineScrollLeftPx,
  useTimelineScrollStore,
} from "./timelineScrollStore";

const owner = vi.hoisted(() => ({ noteTabScroll: vi.fn() }));
vi.mock("./viewState", () => owner);

beforeEach(() => {
  owner.noteTabScroll.mockClear();
  useTimelineScrollStore.setState({ scrollLeftPx: {} });
});

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

  // Where the tab was left is also what `view.json` restores it to next
  // session, so the one publisher tells the owner too — and the guard below
  // covers both: a repeated offset is neither a store write nor a disk write.
  it("hands each new offset to the view-state owner", () => {
    setTimelineScrollLeftPx("comp-g1", 640);
    expect(owner.noteTabScroll).toHaveBeenCalledWith("comp-g1", 640);

    owner.noteTabScroll.mockClear();
    setTimelineScrollLeftPx("comp-g1", 640);
    expect(owner.noteTabScroll).not.toHaveBeenCalled();
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
