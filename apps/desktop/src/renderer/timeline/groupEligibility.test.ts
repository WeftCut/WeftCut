import { afterEach, describe, expect, it } from "vitest";

import { canDissolveSelection, canGroupSelection } from "./groupEligibility";
import type { GroupSummary, ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";

/// Only the two fields the predicates read carry any content — everything else
/// is the shape `ProjectSummary` demands.
function seed(groups: GroupSummary[]): void {
  const summary: ProjectSummary = {
    project_id: "p",
    name: "p",
    composition: {
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: 0,
    layer_count: 0,
    duration_us: 0,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [],
    markers: [],
    transitions: [],
    groups,
    audio_roles: [],
  };
  useProjectStore.getState().apply(summary);
}

afterEach(() => {
  clearLayerSelection();
  useProjectStore.getState().apply(null);
});

describe("canGroupSelection", () => {
  it("needs two layers", () => {
    seed([]);
    expect(canGroupSelection()).toBe(false);
    setLayerSelection("a", ["a"]);
    expect(canGroupSelection()).toBe(false);
    setLayerSelection("a", ["a", "b"]);
    expect(canGroupSelection()).toBe(true);
  });
});

describe("canDissolveSelection", () => {
  it("is false with nothing selected, whatever groups exist", () => {
    seed([{ id: "g1", label: null, layer_ids: ["a", "b"] }]);
    expect(canDissolveSelection()).toBe(false);
  });

  it("is false for a selection that touches no group", () => {
    seed([{ id: "g1", label: null, layer_ids: ["a", "b"] }]);
    setLayerSelection("z", ["z"]);
    expect(canDissolveSelection()).toBe(false);
  });

  // ONE member is enough: the command dissolves every group the selection
  // touches, and an `Alt`-click selects a single member out of a group.
  it("is true for one member of a group", () => {
    seed([{ id: "g1", label: null, layer_ids: ["a", "b"] }]);
    setLayerSelection("a", ["a"]);
    expect(canDissolveSelection()).toBe(true);
  });

  // Both stores are read LIVE — the same rule `appCommands.ts` states for
  // `clearRange`. Dissolving through some other surface must not leave the
  // button lit.
  it("follows the project store, not a snapshot", () => {
    seed([{ id: "g1", label: null, layer_ids: ["a", "b"] }]);
    setLayerSelection("a", ["a", "b"]);
    expect(canDissolveSelection()).toBe(true);
    seed([]);
    expect(canDissolveSelection()).toBe(false);
  });
});
