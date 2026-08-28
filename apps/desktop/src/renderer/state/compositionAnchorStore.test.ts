import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositionSummary, LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { viewStateDefaults, type ViewState } from "../../shared/view-state";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import {
  anchorPath,
  compositionPlacements,
  focusComposition,
  focusedCompositionId,
  openComposition,
  pathToComposition,
  previewRenderTargetId,
  restoreCompositionTabs,
  setOrphanPlayheadUs,
  setPreviewRenderTarget,
  switchAnchor,
  syncOpenCompositions,
  useCompositionAnchorStore,
  wouldCycleInOpenComposition,
} from "./compositionAnchorStore";
import { compositionTabIntent, loadViewState, noteTabZoom } from "./viewState";

/// The tab intent is read off `view.json` and written back to it, so the two
/// IPC calls that reach that file are the seam these tests drive.
const ipcMocks = vi.hoisted(() => ({
  viewStateGet: vi.fn<() => Promise<ViewState>>(),
  viewStateSet: vi.fn<(state: ViewState) => Promise<void>>(),
}));
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  viewStateGet: ipcMocks.viewStateGet,
  viewStateSet: ipcMocks.viewStateSet,
}));
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
  ipcMocks.viewStateGet.mockReset().mockResolvedValue(viewStateDefaults());
  ipcMocks.viewStateSet.mockReset().mockResolvedValue(undefined);
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
    expect(anchors().orphanPlayheads.size).toBe(0);
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

  it("a switch of focus clears the selection and the range", () => {
    setLayerSelection("root-color", ["root-color"]);
    setRangeIn(1_000_000);

    openComposition(G1, "ref-g1");

    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
    expect(useRangeStore.getState()).toEqual({ inUs: null, outUs: null });
  });

  it("leaves the one moment where it is through every switch of focus", () => {
    // There is one playhead and it is the film's (ADR 0053): activating another
    // tab changes what the keyboard edits, never what frame is on screen.
    setPlayheadTimeUs(3_000_000);

    openComposition(G1, "ref-g1");
    expect(playheadTimeUs()).toBe(3_000_000);

    focusComposition(ROOT_ID);
    expect(playheadTimeUs()).toBe(3_000_000);
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
    setOrphanPlayheadUs(G1, 500_000);

    useProjectStore.getState().apply(summaryFixture({ project_id: "p-other" }));

    expect(anchors().focusedId).toBe(ROOT_ID);
    expect([...anchors().anchors.keys()]).toEqual([ROOT_ID]);
    expect(anchors().orphanPlayheads.size).toBe(0);
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

/// A stored tab, as `view.json` carries it.
const storedTab = (
  composition_id: string,
  anchor_layer_id: string | null = null,
  px_per_sec = 80,
) => ({ composition_id, anchor_layer_id, px_per_sec, scroll_left_px: 0 });

/// The intent is what `view.json` records; the Panels that exist are that
/// intersected with the compositions the summary carries (ADR 0053).
describe("tab intent", () => {
  it("records every open tab, in order, with the clip it was entered through", async () => {
    await loadViewState();
    openComposition(G1, "ref-g1");

    expect(compositionTabIntent()).toEqual([
      storedTab(ROOT_ID),
      storedTab(G1, "ref-g1"),
    ]);
  });

  it("re-points an entry when the tab switches to another placement", async () => {
    await loadViewState();
    const twice = nested();
    twice.compositions[ROOT_ID]!.tracks[0]!.layers.push(refLayer("ref-g1b", G1, 3_000_000));
    useProjectStore.getState().apply(twice);
    openComposition(G1, "ref-g1");

    switchAnchor(G1, "ref-g1b");

    expect(compositionTabIntent()).toContainEqual(storedTab(G1, "ref-g1b"));
  });

  it("drops the entry of a tab the user closed", async () => {
    await loadViewState();
    openComposition(G1, "ref-g1");

    syncOpenCompositions([ROOT_ID]);

    expect(compositionTabIntent()).toEqual([storedTab(ROOT_ID)]);
  });

  // Undo takes the composition, not the intent: the same uuid coming back is
  // the redo, and the tab has to come back with it.
  it("keeps the entry through an undo and reopens the Panel, at its zoom, on redo", async () => {
    await loadViewState();
    openComposition(G1, "ref-g1");
    openComposition(G2, "ref-g2");
    noteTabZoom(G2, 400);

    useProjectStore.getState().apply(withoutG2());
    expect(compositionTabIntent()).toContainEqual(storedTab(G2, "ref-g2", 400));
    expect(anchors().anchors.has(G2)).toBe(false);

    panels.open.mockClear();
    useProjectStore.getState().apply(nested());

    expect(panels.open).toHaveBeenCalledWith(G2);
    expect(anchorPath(G2)).toEqual([
      { layerId: "ref-g1", compositionId: G1 },
      { layerId: "ref-g2", compositionId: G2 },
    ]);
    expect(compositionTabIntent()).toContainEqual(storedTab(G2, "ref-g2", 400));
  });
});

/// The unfold that pairs with the fold on serialize: a layout snapshot names
/// one folded `timeline` slot, so every other tab comes back from `view.json`.
describe("restoreCompositionTabs", () => {
  const stored = (over: Partial<ViewState>): void => {
    ipcMocks.viewStateGet.mockResolvedValue({ ...viewStateDefaults(), ...over });
  };

  it("opens every remembered tab the project still carries", async () => {
    stored({
      composition_tabs: [storedTab(ROOT_ID), storedTab(G1, "ref-g1"), storedTab("comp-gone")],
      active_composition_id: G1,
    });

    await restoreCompositionTabs();

    expect(panels.open).toHaveBeenCalledWith(G1);
    expect(panels.open).not.toHaveBeenCalledWith("comp-gone");
    // The root's Panel comes from the layout snapshot, so its entry is a zoom
    // to restore, never a Panel to open.
    expect(panels.open).not.toHaveBeenCalledWith(ROOT_ID);
    expect(anchorPath(G1)).toEqual([{ layerId: "ref-g1", compositionId: G1 }]);
    expect(anchors().focusedId).toBe(G1);
  });

  it("anchors a tab stored without a clip from the root", async () => {
    stored({ composition_tabs: [storedTab(G2)] });

    await restoreCompositionTabs();

    expect(anchorPath(G2)).toEqual([
      { layerId: "ref-g1", compositionId: G1 },
      { layerId: "ref-g2", compositionId: G2 },
    ]);
  });

  // Every Dock rebuild replays this, and only the first is the fresh session
  // the stored focus belongs to.
  it("leaves the editing target alone on a later replay", async () => {
    stored({ composition_tabs: [storedTab(G1, "ref-g1")], active_composition_id: G1 });
    await restoreCompositionTabs();
    focusComposition(ROOT_ID);
    panels.open.mockClear();

    await restoreCompositionTabs();

    expect(anchors().focusedId).toBe(ROOT_ID);
    expect(panels.open).not.toHaveBeenCalled();
  });

  it("carries nothing across when the project changed while the read was in flight", async () => {
    stored({ composition_tabs: [storedTab(G1, "ref-g1")], active_composition_id: G1 });
    const restoring = restoreCompositionTabs();
    useProjectStore.getState().apply(summaryFixture({ project_id: "p-other" }));

    await restoring;

    expect(panels.open).not.toHaveBeenCalledWith(G1);
    expect(anchors().focusedId).toBe(ROOT_ID);
  });
});

/// The preview names its own render target (ADR 0053 decision 3) — the whole
/// point being that it need not be the composition the keyboard is editing.
describe("the preview's render target", () => {
  it("follows focus until a composition is named", () => {
    expect(previewRenderTargetId()).toBe(ROOT_ID);
    openComposition(G1, "ref-g1");
    expect(previewRenderTargetId()).toBe(G1);
  });

  it("holds the film while the keyboard goes into a Group", () => {
    setPreviewRenderTarget(ROOT_ID);
    openComposition(G1, "ref-g1");

    expect(focusedCompositionId()).toBe(G1);
    expect(previewRenderTargetId()).toBe(ROOT_ID);
  });

  // The screen can hold one Group's timeline and another composition's picture,
  // so a lock creates no tab and needs no anchor of its own.
  it("locks onto a composition with no timeline open at all", () => {
    setPreviewRenderTarget(G2);

    expect(previewRenderTargetId()).toBe(G2);
    expect(panels.open).not.toHaveBeenCalledWith(G2);
    expect(anchorPath(G2)).toBeNull();
    expect(pathToComposition(G2)).toEqual([
      { layerId: "ref-g1", compositionId: G1 },
      { layerId: "ref-g2", compositionId: G2 },
    ]);
  });

  it("reads an OPEN target through the anchor its own Panel holds", () => {
    openComposition(G2, "ref-g2");
    setPreviewRenderTarget(G2);

    expect(pathToComposition(G2)).toEqual(anchorPath(G2));
  });

  it("releases the lock when the composition it names disappears", () => {
    setPreviewRenderTarget(G2);
    useProjectStore.getState().apply(withoutG2());

    expect(anchors().previewTargetId).toBeNull();
    expect(previewRenderTargetId()).toBe(anchors().focusedId);
  });

  it("carries no lock across a project change", () => {
    setPreviewRenderTarget(G1);
    useProjectStore.getState().apply(summaryFixture({ project_id: "p-other" }));

    expect(anchors().previewTargetId).toBeNull();
  });

  it("restores the stored lock, and leaves it alone on a later replay", async () => {
    ipcMocks.viewStateGet.mockResolvedValue({
      ...viewStateDefaults(),
      preview_render_target_id: G1,
    });

    await restoreCompositionTabs();
    expect(anchors().previewTargetId).toBe(G1);

    setPreviewRenderTarget(null);
    await restoreCompositionTabs();
    expect(anchors().previewTargetId).toBeNull();
  });

  it("reads a stored lock the project no longer carries as follow focus", async () => {
    ipcMocks.viewStateGet.mockResolvedValue({
      ...viewStateDefaults(),
      preview_render_target_id: "comp-gone",
    });

    await restoreCompositionTabs();

    expect(anchors().previewTargetId).toBeNull();
    expect(previewRenderTargetId()).toBe(ROOT_ID);
  });
});
