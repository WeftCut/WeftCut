// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hoverLink,
  resetLinkHover,
  unhoverLink,
  useLinkHoverStore,
} from "./linkHoverStore";

const hovered = () => useLinkHoverStore.getState().linkId;

describe("linkHoverStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLinkHover();
  });
  afterEach(() => {
    resetLinkHover();
    vi.useRealTimers();
  });

  it("publishes an enter at once and a leave only after a frame", () => {
    hoverLink("L1");
    expect(hovered()).toBe("L1");
    unhoverLink("L1");
    expect(hovered()).toBe("L1");
    vi.advanceTimersByTime(20);
    expect(hovered()).toBeNull();
  });

  it("crossing from one member of a link to another never publishes the null in between", () => {
    const seen: (string | null)[] = [];
    const unsub = useLinkHoverStore.subscribe((s) => seen.push(s.linkId));
    hoverLink("L1");
    unhoverLink("L1");
    hoverLink("L1");
    vi.advanceTimersByTime(40);
    unsub();
    expect(seen).toEqual(["L1"]);
    expect(hovered()).toBe("L1");
  });

  it("entering a different link replaces the hover immediately and drops the pending clear", () => {
    hoverLink("L1");
    unhoverLink("L1");
    hoverLink("L2");
    expect(hovered()).toBe("L2");
    vi.advanceTimersByTime(40);
    expect(hovered()).toBe("L2");
  });

  it("ignores a leave for a link that is not the hovered one", () => {
    hoverLink("L2");
    unhoverLink("L1");
    vi.advanceTimersByTime(40);
    expect(hovered()).toBe("L2");
  });
});
