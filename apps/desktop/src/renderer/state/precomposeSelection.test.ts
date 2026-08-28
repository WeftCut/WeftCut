import { afterEach, describe, expect, it } from "vitest";

import {
  clearPrecomposeMemory,
  rememberPrecompose,
  restorePrecomposeSelection,
} from "./precomposeSelection";
import { clearLayerSelection, useSelectionStore } from "./selectionStore";
import type { LayerSummary, TrackSummary } from "../ipc";
import {
  compositionFixture,
  groupLayerFixture,
  ROOT_ID,
  summaryFixture,
} from "../testing/summaryFixture";

function track(id: string, layers: LayerSummary[]): TrackSummary {
  return {
    id,
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
}

function colorLayer(id: string): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "Color",
    color_hint: "#334455",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind: "Color",
      color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 255 } },
      width: 640,
      height: 360,
    },
  };
}

/// The state right after a pre-compose: the root holds the Group layer, and the
/// composition holds the two members.
const grouped = () =>
  summaryFixture({
    root: { tracks: [track("t-root", [groupLayerFixture({ id: "g", compositionId: "c" })])] },
    groups: [
      compositionFixture({
        id: "c",
        tracks: [track("t-inner", [colorLayer("a"), colorLayer("b")])],
      }),
    ],
  });

/// The state after undoing it: no composition, the members back in the root.
const ungrouped = () =>
  summaryFixture({
    root: { tracks: [track("t-root", [colorLayer("a"), colorLayer("b")])] },
  });

const selected = (): string[] =>
  [...useSelectionStore.getState().selectedLayerIds].sort();

afterEach(() => {
  clearPrecomposeMemory();
  clearLayerSelection();
});

describe("restorePrecomposeSelection", () => {
  it("does nothing with no pre-compose remembered", () => {
    restorePrecomposeSelection(ungrouped());
    expect(selected()).toEqual([]);
  });

  // The repair: undo destroys the open composition, the scope store falls back
  // to the root and clears the selection on the way, and the layers the user
  // asked to get back are what they are left holding.
  it("re-selects the members when the composition disappears", () => {
    rememberPrecompose("c", ["a", "b"], "a");
    restorePrecomposeSelection(grouped());
    expect(selected()).toEqual([]);
    restorePrecomposeSelection(ungrouped());
    expect(selected()).toEqual(["a", "b"]);
    expect(useSelectionStore.getState().primaryLayerId).toBe("a");
  });

  // Fires on the present → absent EDGE only. A later summary must not re-apply
  // the selection over whatever the user has clicked since.
  it("fires once, not on every summary after", () => {
    rememberPrecompose("c", ["a", "b"], "a");
    restorePrecomposeSelection(grouped());
    restorePrecomposeSelection(ungrouped());
    clearLayerSelection();
    restorePrecomposeSelection(ungrouped());
    expect(selected()).toEqual([]);
  });

  // Redo puts the composition back, which re-arms the edge — so undo / redo /
  // undo restores the members every time round.
  it("re-arms when the composition comes back", () => {
    rememberPrecompose("c", ["a", "b"], "a");
    restorePrecomposeSelection(grouped());
    restorePrecomposeSelection(ungrouped());
    clearLayerSelection();
    restorePrecomposeSelection(grouped());
    restorePrecomposeSelection(ungrouped());
    expect(selected()).toEqual(["a", "b"]);
  });

  // A partially-restored selection would arm Delete over clips the user cannot
  // see, so a member the summary no longer carries cancels the whole repair.
  it("restores nothing when a member is gone too", () => {
    rememberPrecompose("c", ["a", "b", "vanished"], "a");
    restorePrecomposeSelection(grouped());
    restorePrecomposeSelection(ungrouped());
    expect(selected()).toEqual([]);
  });

  // The primary has to be one of the restored ids — `setLayerSelection` would
  // otherwise carry a primary outside its own set.
  it("falls back to the first member when the primary is not among them", () => {
    rememberPrecompose("c", ["a", "b"], "some-other-layer");
    restorePrecomposeSelection(grouped());
    restorePrecomposeSelection(ungrouped());
    expect(useSelectionStore.getState().primaryLayerId).toBe("a");
  });

  it("forgets the pre-compose when the project closes", () => {
    rememberPrecompose("c", ["a", "b"], "a");
    restorePrecomposeSelection(grouped());
    restorePrecomposeSelection(null);
    restorePrecomposeSelection(ungrouped());
    expect(selected()).toEqual([]);
  });

  // The root is never the remembered composition, but a summary that somehow
  // still carries it must not read as "gone".
  it("treats a still-present composition as no edge", () => {
    rememberPrecompose(ROOT_ID, ["a", "b"], "a");
    restorePrecomposeSelection(ungrouped());
    expect(selected()).toEqual([]);
  });
});
