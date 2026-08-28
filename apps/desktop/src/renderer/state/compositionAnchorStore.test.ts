import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositionSummary, LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import {
  anchorPath,
  compositionPlacements,
  focusComposition,
  focusedCompositionId,
  openComposition,
  switchAnchor,
  syncOpenCompositions,
  useCompositionAnchorStore,
  wouldCycleInOpenComposition,
} from "./compositionAnchorStore";
import { registerRevealCollapse } from "./navigation";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { compositionOrRoot, currentOpenComposition, useProjectStore } from "./projectStore";
import { clearRange, setRangeIn, useRangeStore } from "./rangeStore";
import { setLayerSelection, useSelectionStore } from "./selectionStore";
import { registerTimelinePanels } from "../workspace/timelinePanels";

const stat = <T,>(value: T) => ({ mode: "Static" as const, value });

function colorLayer(id: string, tEndUs = 1_000_000): LayerSummary {
  return {
    id, label: null, t_start_us: 0, t_end_us: tEndUs, kind: "Color", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: { kind: "Color", color: stat({ r: 0, g: 0, b: 0, a: 255 }), width: 16, height: 9 },
  };
}

/// A Group layer placed at `tStartUs` whose source is `compositionId`.
function refLayer(id: string, compositionId: string, tStartUs = 0): LayerSummary {
  return {
    id, label: null, t_start_us: tStartUs, t_end_us: tStartUs + 1_000_000,
    kind: "CompositionRef", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: {
      kind: "CompositionRef", composition_id: compositionId, composition_label: null,
      src_in_us: 0, src_out_us: 1_000_000,
      x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), scale_linked: true,
      rotation_deg: stat(0), opacity: stat(1), anchor_x: stat(0.5), anchor_y: stat(0.5),
    },
  };
}

function track(id: string, layers: LayerSummary[]): TrackSummary {
  return {
    id, kind: "Video", label: null, enabled: true, locked: false, muted: false, solo: false,
    role: null, transient: true, layers,
  };
}

/// root ─(ref-g1)→ g1 ─(ref-g2)→ g2. Every composition holds one Color layer of
/// its own so each has a duration to clamp against.
const G1 = "comp-g1";
const G2 = "comp-g2";
function nested(): ProjectSummary {
  const g2: CompositionSummary = compositionFixture({
    id: G2, label: "Deep", duration_us: 2_000_000,
    tracks: [track("t-g2", [colorLayer("inner-g2", 2_000_000)])],
  });
  const g1: CompositionSummary = compositionFixture({
    id: G1, label: "Lower third", duration_us: 1_000_000,
    tracks: [track("t-g1", [colorLayer("inner-g1"), refLayer("ref-g2", G2)])],
  });
  return summaryFixture({
    project_id: "p-nested",
    root: { duration_us: 5_000_000, tracks: [track("t-root", [colorLayer("root-color", 5_000_000), refLayer("ref-g1", G1)])] },
    groups: [g1, g2],
  });
}

/// The same project without `g2` (its pre-compose undone): the reference is
/// gone from g1 and the composition from the table.
function withoutG2(): ProjectSummary {
  const s = nested();
  delete s.compositions[G2];
  s.compositions[G1]!.tracks[0]!.layers = [colorLayer("inner-g1")];
  return s;
}

const anchors = () => useCompositionAnchorStore.getState();

/// The Dock's side of the seam, so a test can assert what the store ASKED the
/// Workspace for without mounting one.
const panels = { open: vi.fn<(id: string) => void>(), close: vi.fn<(id: string) => void>() };
let releasePanels: (() => void) | null = null;

beforeEach(() => {
  panels.open.mockClear();
  panels.close.mockClear();
  releasePanels = registerTimelinePanels(panels);
  useProjectStore.getState().apply(null);
  setPlayheadTimeUs(0);
  clearRange();
  useProjectStore.getState().apply(nested());
});

afterEach(() => {
  releasePanels?.();
  releasePanels = null;
  useProjectStore.getState().apply(null);
});

describe("compositionAnchorStore", () => {
  it("focuses the root when a project arrives, anchored at the root itself", () => {
    expect(anchors().focusedId).toBe(ROOT_ID);
    expect(anchorPath(ROOT_ID)).toEqual([]);
    expect(anchors().playheads.size).toBe(0);
    expect(focusedCompositionId()).toBe(ROOT_ID);
  });

  it("opening a Group asks the Dock for its Panel and anchors it on the clip", () => {
    expect(openComposition(G1, "ref-g1")).toBe(true);

    expect(panels.open).toHaveBeenCalledWith(G1);
    expect(anchorPath(G1)).toEqual([{ layerId: "ref-g1", compositionId: G1 }]);
    expect(anchors().focusedId).toBe(G1);
    expect(currentOpenComposition()?.id).toBe(G1);
  });

  it("the root keeps its own anchor when a Group opens beside it", () => {
    openComposition(G1, "ref-g1");
    expect(anchorPath(ROOT_ID)).toEqual([]);
    expect([...anchors().anchors.keys()]).toEqual([ROOT_ID, G1]);
  });

  it("a switch of focus clears the selection and the range and starts the Group at 0", () => {
    setLayerSelection("root-color", ["root-color"]);
    setRangeIn(1_000_000);
    setPlayheadTimeUs(3_000_000);

    openComposition(G1, "ref-g1");

    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
    expect(useRangeStore.getState()).toEqual({ inUs: null, outUs: null });
    expect(playheadTimeUs()).toBe(0);
  });

  it("remembers the playhead per composition and restores it on return", () => {
    setPlayheadTimeUs(3_000_000);
    openComposition(G1, "ref-g1");
    setPlayheadTimeUs(500_000);

    focusComposition(ROOT_ID);
    expect(anchors().focusedId).toBe(ROOT_ID);
    expect(playheadTimeUs()).toBe(3_000_000);

    focusComposition(G1);
    expect(playheadTimeUs()).toBe(500_000);
  });

  it("clamps a remembered playhead to the composition it returns to", () => {
    // Remembered inside g1 at 500 ms; g1 then shrinks to 200 ms.
    openComposition(G1, "ref-g1");
    setPlayheadTimeUs(500_000);
    focusComposition(ROOT_ID);
    const shrunk = nested();
    shrunk.compositions[G1]!.duration_us = 200_000;
    useProjectStore.getState().apply(shrunk);
    focusComposition(G1);
    // 200 ms @ 30 fps → last frame anchor is frame 5 at 166 667 µs.
    expect(playheadTimeUs()).toBe(166_667);
  });

  it("opening by id anchors on the shortest path from the root", () => {
    expect(openComposition(G2, null)).toBe(true);
    expect(anchorPath(G2)).toEqual([
      { layerId: "ref-g1", compositionId: G1 },
      { layerId: "ref-g2", compositionId: G2 },
    ]);
  });

  it("opening through a clip extends the PARENT's anchor, not the focused one", () => {
    // Stand in g2, then open g1 from its clip in the root: the anchor reads as
    // the route through the root, not as one hung off wherever focus was.
    openComposition(G2, null);
    openComposition(G1, "ref-g1");
    expect(anchorPath(G1)).toEqual([{ layerId: "ref-g1", compositionId: G1 }]);
  });

  it("refuses an id the summary does not carry and changes nothing", () => {
    setLayerSelection("root-color", ["root-color"]);
    expect(openComposition("comp-nowhere", null)).toBe(false);
    expect(anchors().focusedId).toBe(ROOT_ID);
    expect(panels.open).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().primaryLayerId).toBe("root-color");
  });

  it("focus follows a Panel and ignores one bound to a dead composition", () => {
    openComposition(G1, "ref-g1");
    focusComposition("comp-nowhere");
    expect(anchors().focusedId).toBe(G1);
  });

  it("focusing a Panel nothing opened anchors it from the root", () => {
    focusComposition(G2);
    expect(anchors().focusedId).toBe(G2);
    expect(anchorPath(G2)).toEqual([
      { layerId: "ref-g1", compositionId: G1 },
      { layerId: "ref-g2", compositionId: G2 },
    ]);
  });

  describe("when a composition disappears", () => {
    it("closes its Panel and falls back to the nearest surviving step", () => {
      openComposition(G1, "ref-g1");
      openComposition(G2, "ref-g2");
      setLayerSelection("inner-g2", ["inner-g2"]);
      panels.close.mockClear();

      useProjectStore.getState().apply(withoutG2());

      expect(panels.close).toHaveBeenCalledWith(G2);
      expect(anchors().focusedId).toBe(G1);
      expect(anchors().anchors.has(G2)).toBe(false);
      expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    });

    it("falls back to the root when no step survives", () => {
      openComposition(G1, "ref-g1");
      openComposition(G2, "ref-g2");

      const rootOnly = withoutG2();
      delete rootOnly.compositions[G1];
      rootOnly.compositions[ROOT_ID]!.tracks[0]!.layers = [colorLayer("root-color", 5_000_000)];
      useProjectStore.getState().apply(rootOnly);

      expect(anchors().focusedId).toBe(ROOT_ID);
      expect(anchorPath(ROOT_ID)).toEqual([]);
    });

    it("leaves a still-focused composition alone through an unrelated summary", () => {
      openComposition(G1, "ref-g1");
      setLayerSelection("inner-g1", ["inner-g1"]);
      useProjectStore.getState().apply(nested());
      expect(anchors().focusedId).toBe(G1);
      expect(useSelectionStore.getState().primaryLayerId).toBe("inner-g1");
    });
  });

  it("resets to the new root when the project changes", () => {
    openComposition(G1, "ref-g1");
    setPlayheadTimeUs(500_000);
    focusComposition(ROOT_ID);
    // Both the root's and g1's positions are on file by now.
    expect(anchors().playheads.size).toBe(2);

    useProjectStore.getState().apply(summaryFixture({ project_id: "p-other" }));

    expect(anchors().focusedId).toBe(ROOT_ID);
    expect([...anchors().anchors.keys()]).toEqual([ROOT_ID]);
    expect(anchors().playheads.size).toBe(0);
  });

  it("clears entirely when the project closes", () => {
    openComposition(G1, "ref-g1");
    useProjectStore.getState().apply(null);
    expect(anchors().focusedId).toBeNull();
    expect(focusedCompositionId()).toBeUndefined();
    expect(currentOpenComposition()).toBeNull();
  });

  it("collapses the inline reveal on every switch", () => {
    const collapse = vi.fn();
    const unregister = registerRevealCollapse(collapse);
    try {
      openComposition(G1, "ref-g1");
      expect(collapse).toHaveBeenCalledTimes(1);
      focusComposition(ROOT_ID);
      expect(collapse).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });
});

describe("syncOpenCompositions", () => {
  it("drops the anchor of a tab that was closed", () => {
    openComposition(G1, "ref-g1");
    syncOpenCompositions([ROOT_ID]);
    expect(anchors().anchors.has(G1)).toBe(false);
    expect(anchors().focusedId).toBe(ROOT_ID);
  });

  it("hands the keyboard to the leftmost survivor when the focused tab closes", () => {
    openComposition(G1, "ref-g1");
    openComposition(G2, "ref-g2");
    syncOpenCompositions([ROOT_ID, G1]);
    expect(anchors().focusedId).toBe(ROOT_ID);
  });

  it("leaves everything alone while the Dock reports no timeline at all", () => {
    openComposition(G1, "ref-g1");
    syncOpenCompositions([]);
    expect(anchors().focusedId).toBe(G1);
    expect(anchors().anchors.has(G1)).toBe(true);
  });

  it("is not a store write when the tab set has not changed", () => {
    openComposition(G1, "ref-g1");
    const listener = vi.fn();
    const unsubscribe = useCompositionAnchorStore.subscribe(listener);
    try {
      // Every Dock layout change lands here, a splitter drag frame included.
      syncOpenCompositions([ROOT_ID, G1]);
      syncOpenCompositions([ROOT_ID, G1]);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

/// The placement a Panel is anchored on is the one its times are read against,
/// so a Group placed twice has to be re-pointable without reopening it.
describe("switchAnchor", () => {
  function twicePlaced(): ProjectSummary {
    const g1: CompositionSummary = compositionFixture({
      id: G1, label: "Lower third", duration_us: 1_000_000,
      tracks: [track("t-g1", [colorLayer("inner-g1")])],
    });
    return summaryFixture({
      project_id: "p-nested",
      root: {
        duration_us: 5_000_000,
        tracks: [
          track("t-root", [
            refLayer("ref-a", G1, 0),
            refLayer("ref-b", G1, 2_000_000),
          ]),
        ],
      },
      groups: [g1],
    });
  }

  beforeEach(() => useProjectStore.getState().apply(twicePlaced()));

  it("re-points the anchor at another placement without touching focus", () => {
    openComposition(G1, "ref-a");
    panels.open.mockClear();

    expect(switchAnchor(G1, "ref-b")).toBe(true);

    expect(anchorPath(G1)).toEqual([{ layerId: "ref-b", compositionId: G1 }]);
    expect(anchors().focusedId).toBe(G1);
    expect(panels.open).not.toHaveBeenCalled();
  });

  it("refuses a layer that is not a Group clip on this composition", () => {
    openComposition(G1, "ref-a");
    expect(switchAnchor(G1, "inner-g1")).toBe(false);
    expect(switchAnchor(G1, "no-such-layer")).toBe(false);
    expect(anchorPath(G1)).toEqual([{ layerId: "ref-a", compositionId: G1 }]);
  });

  it("names every placement by where it starts on the root's clock", () => {
    const summary = useProjectStore.getState().summary!;
    expect(compositionPlacements(summary, G1)).toEqual([
      { layerId: "ref-a", crumbs: [{ layerId: "ref-a", compositionId: G1 }], rootStartUs: 0 },
      { layerId: "ref-b", crumbs: [{ layerId: "ref-b", compositionId: G1 }], rootStartUs: 2_000_000 },
    ]);
  });

  it("measures a nested placement from its own parent's origin", () => {
    // root ─(ref-g1 @ 1 s)→ g1 ─(ref-g2 @ 0.5 s)→ g2, so g2 starts at 1.5 s.
    const g2 = compositionFixture({ id: G2, duration_us: 1_000_000, tracks: [] });
    const g1 = compositionFixture({
      id: G1, duration_us: 1_000_000,
      tracks: [track("t-g1", [refLayer("ref-g2", G2, 500_000)])],
    });
    const summary = summaryFixture({
      root: { duration_us: 5_000_000, tracks: [track("t-root", [refLayer("ref-g1", G1, 1_000_000)])] },
      groups: [g1, g2],
    });
    expect(compositionPlacements(summary, G2)).toEqual([
      {
        layerId: "ref-g2",
        crumbs: [
          { layerId: "ref-g1", compositionId: G1 },
          { layerId: "ref-g2", compositionId: G2 },
        ],
        rootStartUs: 1_500_000,
      },
    ]);
  });
});

describe("wouldCycleInOpenComposition", () => {
  it("refuses the focused composition and every composition it sits inside", () => {
    openComposition(G2, null);
    expect(wouldCycleInOpenComposition(G2)).toBe(true);
    expect(wouldCycleInOpenComposition(G1)).toBe(true);
    expect(wouldCycleInOpenComposition("comp-elsewhere")).toBe(false);
  });

  it("reads the FOCUSED Panel's path, not whichever tab was opened last", () => {
    openComposition(G2, null);
    focusComposition(ROOT_ID);
    expect(wouldCycleInOpenComposition(G1)).toBe(false);
  });
});

describe("compositionOrRoot", () => {
  it("is the summary's own sub-object, so the reference is stable between reads", () => {
    const s = nested();
    expect(compositionOrRoot(s, G1)).toBe(s.compositions[G1]);
    expect(compositionOrRoot(s, null)).toBe(s.compositions[ROOT_ID]);
  });

  it("falls back to the root for a missing id, and to null with no project", () => {
    const s = nested();
    expect(compositionOrRoot(s, "comp-nowhere")).toBe(s.compositions[ROOT_ID]);
    expect(compositionOrRoot(null, G1)).toBeNull();
  });
});
