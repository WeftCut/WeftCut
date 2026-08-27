import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositionSummary, LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { compositionFixture, ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import {
  leaveComposition,
  leaveToCrumb,
  openComposition,
  openCompositionId,
  useCompositionScopeStore,
} from "./compositionScopeStore";
import { registerRevealCollapse } from "./navigation";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { compositionOrRoot, currentOpenComposition, useProjectStore } from "./projectStore";
import { clearRange, setRangeIn, useRangeStore } from "./rangeStore";
import { setLayerSelection, useSelectionStore } from "./selectionStore";

const stat = <T,>(value: T) => ({ mode: "Static" as const, value });

function colorLayer(id: string, tEndUs = 1_000_000): LayerSummary {
  return {
    id, label: null, t_start_us: 0, t_end_us: tEndUs, kind: "Color", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: { kind: "Color", color: stat({ r: 0, g: 0, b: 0, a: 255 }), width: 16, height: 9 },
  };
}

/// A Group layer placed `[0, 1 s)` whose source is `compositionId`.
function refLayer(id: string, compositionId: string): LayerSummary {
  return {
    id, label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "CompositionRef", color_hint: "#000000",
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

const scope = () => useCompositionScopeStore.getState();

beforeEach(() => {
  useProjectStore.getState().apply(null);
  setPlayheadTimeUs(0);
  clearRange();
  useProjectStore.getState().apply(nested());
});

afterEach(() => {
  useProjectStore.getState().apply(null);
});

describe("compositionScopeStore", () => {
  it("opens at the root when a project arrives, with nothing remembered", () => {
    expect(scope().openId).toBe(ROOT_ID);
    expect(scope().crumbs).toEqual([]);
    expect(scope().playheads.size).toBe(0);
    expect(openCompositionId()).toBe(ROOT_ID);
  });

  it("a switch clears the selection and the range and starts the Group at 0", () => {
    setLayerSelection("root-color", ["root-color"]);
    setRangeIn(1_000_000);
    setPlayheadTimeUs(3_000_000);

    expect(openComposition(G1, "ref-g1")).toBe(true);

    expect(scope().openId).toBe(G1);
    expect(scope().crumbs).toEqual([{ layerId: "ref-g1", compositionId: G1 }]);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
    expect(useRangeStore.getState()).toEqual({ inUs: null, outUs: null });
    expect(playheadTimeUs()).toBe(0);
    expect(currentOpenComposition()?.id).toBe(G1);
  });

  it("remembers the playhead per composition and restores it on return", () => {
    setPlayheadTimeUs(3_000_000);
    openComposition(G1, "ref-g1");
    setPlayheadTimeUs(500_000);

    leaveComposition();
    expect(scope().openId).toBe(ROOT_ID);
    expect(scope().crumbs).toEqual([]);
    expect(playheadTimeUs()).toBe(3_000_000);

    openComposition(G1, "ref-g1");
    expect(playheadTimeUs()).toBe(500_000);
  });

  it("clamps a remembered playhead to the composition it returns to", () => {
    // Remembered inside g1 at 500 ms; g1 then shrinks to 200 ms.
    openComposition(G1, "ref-g1");
    setPlayheadTimeUs(500_000);
    leaveComposition();
    const shrunk = nested();
    shrunk.compositions[G1]!.duration_us = 200_000;
    useProjectStore.getState().apply(shrunk);
    openComposition(G1, "ref-g1");
    // 200 ms @ 30 fps → last frame anchor is frame 5 at 166 667 µs.
    expect(playheadTimeUs()).toBe(166_667);
  });

  it("opening by id reconstructs the crumb path from the root", () => {
    expect(openComposition(G2, null)).toBe(true);
    expect(scope().crumbs).toEqual([
      { layerId: "ref-g1", compositionId: G1 },
      { layerId: "ref-g2", compositionId: G2 },
    ]);
    // Walking back one crumb lands on g1 with the path trimmed to match.
    leaveToCrumb(0);
    expect(scope().openId).toBe(G1);
    expect(scope().crumbs).toEqual([{ layerId: "ref-g1", compositionId: G1 }]);
    leaveToCrumb(-1);
    expect(scope().openId).toBe(ROOT_ID);
  });

  it("refuses an id the summary does not carry and changes nothing", () => {
    setLayerSelection("root-color", ["root-color"]);
    expect(openComposition("comp-nowhere", null)).toBe(false);
    expect(scope().openId).toBe(ROOT_ID);
    expect(useSelectionStore.getState().primaryLayerId).toBe("root-color");
  });

  it("falls back to the nearest surviving crumb when the open composition disappears", () => {
    openComposition(G1, "ref-g1");
    openComposition(G2, "ref-g2");
    setLayerSelection("inner-g2", ["inner-g2"]);

    useProjectStore.getState().apply(withoutG2());

    expect(scope().openId).toBe(G1);
    expect(scope().crumbs).toEqual([{ layerId: "ref-g1", compositionId: G1 }]);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
  });

  it("falls back to the root when no crumb survives", () => {
    openComposition(G1, "ref-g1");
    openComposition(G2, "ref-g2");

    const rootOnly = withoutG2();
    delete rootOnly.compositions[G1];
    rootOnly.compositions[ROOT_ID]!.tracks[0]!.layers = [colorLayer("root-color", 5_000_000)];
    useProjectStore.getState().apply(rootOnly);

    expect(scope().openId).toBe(ROOT_ID);
    expect(scope().crumbs).toEqual([]);
  });

  it("holds the open composition through an unrelated summary", () => {
    openComposition(G1, "ref-g1");
    setLayerSelection("inner-g1", ["inner-g1"]);
    useProjectStore.getState().apply(nested());
    expect(scope().openId).toBe(G1);
    expect(useSelectionStore.getState().primaryLayerId).toBe("inner-g1");
  });

  it("resets to the new root when the project changes", () => {
    openComposition(G1, "ref-g1");
    setPlayheadTimeUs(500_000);
    leaveComposition();
    // Both the root's and g1's positions are on file by now.
    expect(scope().playheads.size).toBe(2);

    useProjectStore.getState().apply(summaryFixture({ project_id: "p-other" }));

    expect(scope().openId).toBe(ROOT_ID);
    expect(scope().crumbs).toEqual([]);
    expect(scope().playheads.size).toBe(0);
  });

  it("clears entirely when the project closes", () => {
    openComposition(G1, "ref-g1");
    useProjectStore.getState().apply(null);
    expect(scope().openId).toBeNull();
    expect(openCompositionId()).toBeUndefined();
    expect(currentOpenComposition()).toBeNull();
  });

  it("collapses the inline reveal on every switch", () => {
    const collapse = vi.fn();
    const unregister = registerRevealCollapse(collapse);
    try {
      openComposition(G1, "ref-g1");
      expect(collapse).toHaveBeenCalledTimes(1);
      leaveComposition();
      expect(collapse).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
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
