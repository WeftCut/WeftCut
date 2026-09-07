import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRegionFocus,
  regionFocus,
  setRegionFocus,
  useAudioRegionFocusStore,
} from "./audioRegionFocusStore";

describe("audioRegionFocusStore", () => {
  beforeEach(() => useAudioRegionFocusStore.setState({ focus: null }));

  it("starts with no focused card", () => {
    expect(regionFocus()).toBeNull();
  });

  it("claims and releases the band", () => {
    setRegionFocus({ layerId: "L1", effectId: "E1" });
    expect(regionFocus()).toEqual({ layerId: "L1", effectId: "E1" });
    clearRegionFocus("L1", "E1");
    expect(regionFocus()).toBeNull();
  });

  it("a second card replaces the first — only one band is ever drawable", () => {
    setRegionFocus({ layerId: "L1", effectId: "E1" });
    setRegionFocus({ layerId: "L2", effectId: "E2" });
    expect(regionFocus()).toEqual({ layerId: "L2", effectId: "E2" });
  });

  // A card's unmount cleanup can run after the next card's claim (layer
  // switched, effect reordered), so a clear that does not match must be inert.
  it("a stale clear leaves another card's focus standing", () => {
    setRegionFocus({ layerId: "L2", effectId: "E2" });
    clearRegionFocus("L1", "E1");
    expect(regionFocus()).toEqual({ layerId: "L2", effectId: "E2" });
    clearRegionFocus("L2", "E1");
    expect(regionFocus()).toEqual({ layerId: "L2", effectId: "E2" });
  });

  it("re-claiming the same card notifies nobody", () => {
    setRegionFocus({ layerId: "L1", effectId: "E1" });
    let notifications = 0;
    const unsubscribe = useAudioRegionFocusStore.subscribe(() => {
      notifications += 1;
    });
    setRegionFocus({ layerId: "L1", effectId: "E1" });
    expect(notifications).toBe(0);
    setRegionFocus({ layerId: "L1", effectId: "E2" });
    expect(notifications).toBe(1);
    unsubscribe();
  });
});
