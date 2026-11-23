import { describe, expect, it, beforeEach } from "vitest";
import {
  selectKeyframe, setKeyframeSelection, clearKeyframeSelection,
  getSelectedKeyframes, hasKeyframeSelection, keyframeKey,
  useKeyframeSelectionStore,
} from "./selectionStore";
import {
  clearLayerSelection,
  setLayerSelection,
  setMediaSelection,
} from "../state/selectionStore";

beforeEach(() => {
  clearLayerSelection();
  clearKeyframeSelection();
});

/// What the render path does: membership by composite key.
const isSelected = (layerId: string, paramKey: string, kfId: string) =>
  useKeyframeSelectionStore.getState().selected.has(
    keyframeKey({ layerId, paramKey, kfId }),
  );

describe("keyframeSelectionStore", () => {
  it("selects and reads back a key", () => {
    selectKeyframe({ layerId: "L", paramKey: "opacity", kfId: "k1" });
    expect(getSelectedKeyframes()).toEqual([
      { layerId: "L", paramKey: "opacity", kfId: "k1" },
    ]);
  });
  it("clear() empties the selection", () => {
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k1" });
    clearKeyframeSelection();
    expect(getSelectedKeyframes()).toEqual([]);
    expect(hasKeyframeSelection()).toBe(false);
  });
  it("membership matches only the exact (layer,param,kf) triple", () => {
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k1" });
    expect(isSelected("L", "x", "k1")).toBe(true);
    expect(isSelected("L", "x", "k2")).toBe(false);
    expect(isSelected("L", "y", "k1")).toBe(false);
    expect(isSelected("M", "x", "k1")).toBe(false);
  });
  it("selectKeyframe REPLACES the whole selection, never adds to it", () => {
    setKeyframeSelection([
      { layerId: "L", paramKey: "x", kfId: "k1" },
      { layerId: "M", paramKey: "y", kfId: "k2" },
    ]);
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k9" });
    expect(getSelectedKeyframes()).toEqual([
      { layerId: "L", paramKey: "x", kfId: "k9" },
    ]);
  });
  it("holds keys across layers and properties at once", () => {
    setKeyframeSelection([
      { layerId: "L", paramKey: "x", kfId: "k1" },
      { layerId: "L", paramKey: "y", kfId: "k1" },
      { layerId: "M", paramKey: "x", kfId: "k1" },
    ]);
    expect(getSelectedKeyframes()).toHaveLength(3);
    expect(isSelected("L", "y", "k1")).toBe(true);
  });
  // The composite key is the identity: a triple offered twice is ONE entry.
  // Guards the key builder — collapse it to a constant and this is the test
  // that fails.
  it("de-duplicates the same triple", () => {
    setKeyframeSelection([
      { layerId: "L", paramKey: "x", kfId: "k1" },
      { layerId: "L", paramKey: "x", kfId: "k1" },
      { layerId: "L", paramKey: "x", kfId: "k2" },
    ]);
    expect(getSelectedKeyframes()).toEqual([
      { layerId: "L", paramKey: "x", kfId: "k1" },
      { layerId: "L", paramKey: "x", kfId: "k2" },
    ]);
  });
  it("setKeyframeSelection with nothing empties the selection", () => {
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k1" });
    setKeyframeSelection([]);
    expect(hasKeyframeSelection()).toBe(false);
  });
  // Clearing an already-empty selection must not write a new reference: a
  // fresh Map would re-render every diamond in the timeline.
  it("clearing twice keeps one reference", () => {
    const first = useKeyframeSelectionStore.getState().selected;
    clearKeyframeSelection();
    expect(useKeyframeSelectionStore.getState().selected).toBe(first);
  });
});

// Delete takes keyframes whenever any are selected, so keys must not outlive
// the clip the user was on.
describe("keyframe selection under a clip selection change", () => {
  const key = { layerId: "A", paramKey: "x", kfId: "k1" };

  it("is dropped when another clip becomes primary", () => {
    setLayerSelection("A", ["A"]);
    selectKeyframe(key);
    setLayerSelection("B", ["B"]);
    expect(hasKeyframeSelection()).toBe(false);
  });

  it("is dropped when the selection leaves clips altogether", () => {
    setLayerSelection("A", ["A"]);
    selectKeyframe(key);
    setMediaSelection("m1");
    expect(hasKeyframeSelection()).toBe(false);
  });

  it("survives a change to the set that keeps the primary", () => {
    setLayerSelection("A", ["A"]);
    selectKeyframe(key);
    setLayerSelection("A", ["A", "B"]);
    expect(getSelectedKeyframes()).toEqual([key]);
  });
});
