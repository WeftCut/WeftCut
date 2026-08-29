import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLayerSelection,
  clearTransitionSelection,
  currentSelection,
  layerIdsOf,
  primaryLayerIdOf,
  retainCompositionSelection,
  retainLayerSelection,
  retainTransitionSelection,
  setCompositionSelection,
  setLayerSelection,
  setTransitionSelection,
  toggleLayerSelection,
  transitionIdOf,
  useSelectionStore,
} from "./selectionStore";

beforeEach(clearLayerSelection);

describe("selectionStore", () => {
  it("treats a single-select write as a complete replacement", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    setLayerSelection("layer-3", ["layer-3"]);

    expect(primaryLayerIdOf(currentSelection())).toBe("layer-3");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual(["layer-3"]);
    clearLayerSelection();
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });

  it("sets a complete range and its primary atomically", () => {
    const observed: Array<[string | null, string[]]> = [];
    const unsub = useSelectionStore.subscribe((state) => {
      observed.push([
        primaryLayerIdOf(state.selection),
        Array.from(layerIdsOf(state.selection)),
      ]);
    });

    setLayerSelection("layer-2", ["layer-1", "layer-2", "layer-3"]);

    expect(observed).toEqual([
      ["layer-2", ["layer-1", "layer-2", "layer-3"]],
    ]);
    unsub();
  });

  it("extends the set while making the additive target primary", () => {
    setLayerSelection("layer-1", ["layer-1"]);
    expect(toggleLayerSelection("layer-3", ["layer-2", "layer-3"])).toBe(true);

    expect(primaryLayerIdOf(currentSelection())).toBe("layer-3");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([
      "layer-1",
      "layer-2",
      "layer-3",
    ]);
  });

  it("removes the clicked Layer and its companions on a second additive click", () => {
    setLayerSelection("layer-1", ["layer-1"]);
    toggleLayerSelection("layer-3", ["layer-2", "layer-3"]);

    expect(toggleLayerSelection("layer-3", ["layer-2", "layer-3"])).toBe(false);

    // The primary went with them, so the surviving Layer inherits it.
    expect(primaryLayerIdOf(currentSelection())).toBe("layer-1");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([
      "layer-1",
    ]);
  });

  it("keeps a primary the removal did not touch", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);

    toggleLayerSelection("layer-2", ["layer-2"]);

    expect(primaryLayerIdOf(currentSelection())).toBe("layer-1");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual([
      "layer-1",
    ]);
  });

  it("removes the clicked Layer even when the companion list omits it", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);

    expect(toggleLayerSelection("layer-1", ["layer-2"])).toBe(false);

    // Both are gone: an id excluded from the companion list must not survive a
    // click that reports the clicked Layer as deselected.
    expect(layerIdsOf(currentSelection()).size).toBe(0);
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
  });

  it("empties the selection when the last member is toggled off", () => {
    setLayerSelection("layer-1", ["layer-1"]);

    expect(toggleLayerSelection("layer-1", ["layer-1"])).toBe(false);

    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });

  it("normalizes every write to the primary/set invariants", () => {
    setLayerSelection("primary", ["sibling"]);
    expect(layerIdsOf(currentSelection()).has("primary")).toBe(true);

    setLayerSelection(null, ["survivor"]);
    expect(primaryLayerIdOf(currentSelection())).toBe("survivor");
    expect(layerIdsOf(currentSelection()).has("survivor")).toBe(true);

    clearLayerSelection();
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });

  it("does not notify subscribers when primary and set membership are unchanged", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    const spy = vi.fn();
    const unsub = useSelectionStore.subscribe(spy);

    setLayerSelection("layer-1", ["layer-2", "layer-1", "layer-2"]);

    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it("retains valid Layers and promotes a survivor when the primary disappears", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2", "layer-3"]);
    retainLayerSelection(["layer-2", "layer-3"]);

    expect(primaryLayerIdOf(currentSelection())).toBe("layer-2");
    expect(Array.from(layerIdsOf(currentSelection()))).toEqual(["layer-2", "layer-3"]);

    retainLayerSelection([]);
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });
});

describe("transition selection (mutually exclusive with layer selection)", () => {
  it("selecting a transition deselects all layers", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    setTransitionSelection("tr-1");

    expect(transitionIdOf(currentSelection())).toBe("tr-1");
    expect(primaryLayerIdOf(currentSelection())).toBeNull();
    expect(layerIdsOf(currentSelection()).size).toBe(0);
  });

  it("selecting layers deselects the transition", () => {
    setTransitionSelection("tr-1");
    setLayerSelection("layer-1", ["layer-1"]);

    expect(transitionIdOf(currentSelection())).toBeNull();
    expect(primaryLayerIdOf(currentSelection())).toBe("layer-1");
  });

  it("toggleLayerSelection also evicts the transition", () => {
    setTransitionSelection("tr-1");
    toggleLayerSelection("layer-1", ["layer-1"]);
    expect(transitionIdOf(currentSelection())).toBeNull();
  });

  it("clearLayerSelection clears the transition too (background-click semantics)", () => {
    setTransitionSelection("tr-1");
    clearLayerSelection();
    expect(transitionIdOf(currentSelection())).toBeNull();
  });

  it("clearTransitionSelection clears only the transition", () => {
    setTransitionSelection("tr-1");
    clearTransitionSelection();
    expect(transitionIdOf(currentSelection())).toBeNull();
  });

  it("retainTransitionSelection drops a vanished id and keeps a surviving one", () => {
    setTransitionSelection("tr-1");
    retainTransitionSelection(["tr-1", "tr-2"]);
    expect(transitionIdOf(currentSelection())).toBe("tr-1");

    retainTransitionSelection(["tr-2"]);
    expect(transitionIdOf(currentSelection())).toBeNull();
  });

  it("retainLayerSelection preserves a selected transition (layers were empty by invariant)", () => {
    setTransitionSelection("tr-1");
    retainLayerSelection(["layer-1", "layer-2"]);
    expect(transitionIdOf(currentSelection())).toBe("tr-1");
  });

  it("does not notify subscribers when the transition selection is unchanged", () => {
    setTransitionSelection("tr-1");
    const spy = vi.fn();
    const unsub = useSelectionStore.subscribe(spy);

    setTransitionSelection("tr-1");

    expect(spy).not.toHaveBeenCalled();
    unsub();
  });
});

// The pool's kind is the one with no presence on a timeline, so nothing in the
// timeline's own suites exercises its side of the exclusion.
describe("pool selection (mutually exclusive with the timeline's kinds)", () => {
  it("evicts layers and the transition chip, and is evicted by both", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    setCompositionSelection("comp-1");
    expect(currentSelection()).toEqual({ kind: "group", id: "comp-1" });

    setTransitionSelection("tr-1");
    expect(currentSelection().kind).toBe("transition");

    setCompositionSelection("comp-1");
    setLayerSelection("layer-1", ["layer-1"]);
    expect(currentSelection().kind).toBe("layers");
  });

  // The retains run in sequence on EVERY summary, so each must ignore a
  // selection of a kind it does not own rather than clearing it.
  it("survives the retains that belong to the other kinds", () => {
    setCompositionSelection("comp-1");

    retainLayerSelection([]);
    retainTransitionSelection([]);

    expect(currentSelection()).toEqual({ kind: "group", id: "comp-1" });
  });

  it("drops a composition that left the project and keeps one that stayed", () => {
    setCompositionSelection("comp-1");
    retainCompositionSelection(["comp-1", "comp-2"]);
    expect(currentSelection()).toEqual({ kind: "group", id: "comp-1" });

    retainCompositionSelection(["comp-2"]);
    expect(currentSelection().kind).toBe("none");
  });

  it("does not notify subscribers when the composition is unchanged", () => {
    setCompositionSelection("comp-1");
    const spy = vi.fn();
    const unsub = useSelectionStore.subscribe(spy);

    setCompositionSelection("comp-1");

    expect(spy).not.toHaveBeenCalled();
    unsub();
  });
});
