import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRegionFocus,
  regionFocus,
  setRegionFocus,
  useAudioRegionFocusStore,
} from "./audioRegionFocusStore";

describe("audioRegionFocusStore", () => {
  beforeEach(() => useAudioRegionFocusStore.setState({ mounted: [] }));

  it("starts with no focused card", () => {
    expect(regionFocus()).toBeNull();
  });

  it("claims and releases the band", () => {
    setRegionFocus({ layerId: "L1", effectId: "E1" });
    expect(regionFocus()).toEqual({ layerId: "L1", effectId: "E1" });
    clearRegionFocus("L1", "E1");
    expect(regionFocus()).toBeNull();
  });

  it("a second card takes the band from the first — only one is ever drawable", () => {
    setRegionFocus({ layerId: "L1", effectId: "E1" });
    setRegionFocus({ layerId: "L2", effectId: "E2" });
    expect(regionFocus()).toEqual({ layerId: "L2", effectId: "E2" });
  });

  // Two expanded cards on one layer: collapsing the newer one hands the band
  // back to the older card, which is still mounted and expanded.
  it("hands the band back to the next-newest card on release", () => {
    setRegionFocus({ layerId: "L1", effectId: "A" });
    setRegionFocus({ layerId: "L1", effectId: "B" });
    clearRegionFocus("L1", "B");
    expect(regionFocus()).toEqual({ layerId: "L1", effectId: "A" });
    clearRegionFocus("L1", "A");
    expect(regionFocus()).toBeNull();
  });

  it("re-claiming an older card raises it back to the band", () => {
    setRegionFocus({ layerId: "L1", effectId: "A" });
    setRegionFocus({ layerId: "L1", effectId: "B" });
    setRegionFocus({ layerId: "L1", effectId: "A" });
    expect(regionFocus()).toEqual({ layerId: "L1", effectId: "A" });
    clearRegionFocus("L1", "A");
    expect(regionFocus()).toEqual({ layerId: "L1", effectId: "B" });
  });

  // A card's unmount cleanup can run after the next card's claim (layer
  // switched, effect reordered), so a clear that matches nothing must be inert.
  it("a clear for an unmounted card leaves the band standing", () => {
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
