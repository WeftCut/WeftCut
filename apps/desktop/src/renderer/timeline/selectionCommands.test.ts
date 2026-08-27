import { afterEach, describe, expect, it } from "vitest";

import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import {
  clearKeyframeSelection,
  selectKeyframe,
} from "../keyframe/selectionStore";
import { useProjectStore } from "../state/projectStore";
import {
  clearLayerSelection,
  setLayerSelection,
  setTransitionSelection,
  useSelectionStore,
} from "../state/selectionStore";
import {
  canDeselectAll,
  canSelectAll,
  deselectAll,
  selectAllLayers,
  selectableLayerIds,
} from "./selectionCommands";
import { summaryFixture } from "../testing/summaryFixture";

function layer(partial: Partial<LayerSummary>): LayerSummary {
  return {
    id: "L",
    kind: "VideoClip",
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind: "VideoClip" } as LayerSummary["params"],
    effects: [],
    ...partial,
  };
}

function track(partial: Partial<TrackSummary>): TrackSummary {
  return {
    id: "T",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [],
    ...partial,
  };
}

/// Only `tracks` carries content — everything else is the shape
/// `ProjectSummary` demands.
function seed(tracks: TrackSummary[]): void {
  const summary: ProjectSummary = summaryFixture({
    project_id: "p",
    name: "p",
    media: [],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 0,
      tracks: tracks,
      markers: [],
      transitions: [],
      links: [],
    },
  });
  useProjectStore.getState().apply(summary);
}

afterEach(() => {
  clearLayerSelection();
  clearKeyframeSelection();
  useProjectStore.getState().apply(null);
});

describe("selectableLayerIds", () => {
  it("walks tracks in order and layers in track order", () => {
    expect(
      selectableLayerIds([
        track({ id: "t1", layers: [layer({ id: "a" }), layer({ id: "b" })] }),
        track({ id: "t2", layers: [layer({ id: "c" })] }),
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  // A locked clip cannot be reached by pointer at all (`LayerBlock`'s
  // pointerdown returns early), so a selection containing one is a selection
  // the mouse could not have produced.
  it("skips a locked layer", () => {
    expect(
      selectableLayerIds([
        track({
          layers: [layer({ id: "a" }), layer({ id: "b", locked: true })],
        }),
      ]),
    ).toEqual(["a"]);
  });

  it("skips every layer on a locked track", () => {
    expect(
      selectableLayerIds([
        track({
          id: "t1",
          locked: true,
          layers: [layer({ id: "a" }), layer({ id: "b" })],
        }),
        track({ id: "t2", layers: [layer({ id: "c" })] }),
      ]),
    ).toEqual(["c"]);
  });
});

describe("selectAllLayers", () => {
  it("selects every selectable layer in the tracks it is given", () => {
    selectAllLayers([
      track({ id: "t1", layers: [layer({ id: "a" }), layer({ id: "b" })] }),
      track({ id: "t2", locked: true, layers: [layer({ id: "c" })] }),
    ]);

    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([
      "a",
      "b",
    ]);
    expect(useSelectionStore.getState().primaryLayerId).toBe("a");
  });

  // The Attribute panel follows the primary, so Select All must not move it off
  // the clip the user was inspecting.
  it("keeps a primary that survives the new selection", () => {
    setLayerSelection("b", ["b"]);

    selectAllLayers([
      track({ layers: [layer({ id: "a" }), layer({ id: "b" })] }),
    ]);

    expect(useSelectionStore.getState().primaryLayerId).toBe("b");
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(2);
  });

  it("promotes the first selectable layer when the old primary is gone", () => {
    setLayerSelection("z", ["z"]);

    selectAllLayers([
      track({ layers: [layer({ id: "a" }), layer({ id: "b" })] }),
    ]);

    expect(useSelectionStore.getState().primaryLayerId).toBe("a");
  });

  // Nothing selectable ⇒ nothing written, so an existing selection is not
  // silently cleared by a command that promised to ADD to it.
  it("leaves the selection alone when nothing is selectable", () => {
    setLayerSelection("a", ["a"]);

    selectAllLayers([track({ locked: true, layers: [layer({ id: "b" })] })]);

    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([
      "a",
    ]);
  });

  it("evicts a selected transition chip, like any layer selection", () => {
    setTransitionSelection("tr-1");

    selectAllLayers([track({ layers: [layer({ id: "a" })] })]);

    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });
});

describe("deselectAll", () => {
  // All three arm Delete (`subSelectionDelete.ts`), so leaving any one standing
  // would leave Delete live with nothing visibly selected.
  it("clears layers, the transition chip and the keyframe diamond", () => {
    setLayerSelection("a", ["a", "b"]);
    selectKeyframe({ layerId: "a", paramKey: "x", kfId: "k1" });

    deselectAll();

    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(canDeselectAll()).toBe(false);

    setTransitionSelection("tr-1");
    deselectAll();
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });
});

describe("canSelectAll", () => {
  it("is false with no project and with nothing selectable", () => {
    expect(canSelectAll()).toBe(false);
    seed([track({ locked: true, layers: [layer({ id: "a" })] })]);
    expect(canSelectAll()).toBe(false);
  });

  it("is true once one unlocked layer exists on an unlocked track", () => {
    seed([track({ layers: [layer({ id: "a" })] })]);
    expect(canSelectAll()).toBe(true);
  });

  // Idempotence is not a reason to grey the row out: re-running Select All over
  // an already-complete selection is harmless, and Premiere/Resolve keep theirs
  // live too.
  it("stays true when everything is already selected", () => {
    seed([track({ layers: [layer({ id: "a" })] })]);
    setLayerSelection("a", ["a"]);
    expect(canSelectAll()).toBe(true);
  });
});

describe("canDeselectAll", () => {
  it("is false with nothing selected", () => {
    expect(canDeselectAll()).toBe(false);
  });

  it("is true for a layer selection", () => {
    setLayerSelection("a", ["a"]);
    expect(canDeselectAll()).toBe(true);
  });

  it("is true for a transition chip alone", () => {
    setTransitionSelection("tr-1");
    expect(canDeselectAll()).toBe(true);
  });

  it("is true for a keyframe diamond alone", () => {
    selectKeyframe({ layerId: "a", paramKey: "x", kfId: "k1" });
    expect(canDeselectAll()).toBe(true);
  });
});
