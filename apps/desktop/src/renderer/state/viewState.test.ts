import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { viewStateDefaults, type ViewState } from "../../shared/view-state";
import {
  VIEW_SAVE_DEBOUNCE_MS,
  compositionTabIntent,
  loadViewState,
  noteTabScroll,
  noteTabZoom,
  noteTrackExpanded,
  noteTrackHeights,
  publishCompositionTabs,
  resetViewState,
  retainTrackViewState,
} from "./viewState";

const ipc = vi.hoisted(() => ({
  viewStateGet: vi.fn<() => Promise<ViewState>>(),
  viewStateSet: vi.fn<(state: ViewState) => Promise<void>>(),
}));
vi.mock("../ipc", () => ipc);

const ROOT = "comp-root";
const G1 = "comp-g1";
const G2 = "comp-g2";

/// Every composition the project carries, in the shape `publishCompositionTabs`
/// wants it: the set that separates a tab the user closed from one an undo took
/// away underneath it.
const alive = (...ids: string[]) => new Set(ids);

const tab = (
  composition_id: string,
  over: Partial<{ anchor_layer_id: string | null; px_per_sec: number; scroll_left_px: number }> = {},
) => ({
  composition_id,
  anchor_layer_id: null,
  px_per_sec: 80,
  scroll_left_px: 0,
  ...over,
});

/// Serve `view.json` and let the read land — every mutator is inert until it
/// has, so nothing below means anything before this.
async function open(document: Partial<ViewState> = {}): Promise<void> {
  ipc.viewStateGet.mockResolvedValue({ ...viewStateDefaults(), ...document });
  await loadViewState();
}

/// What the last debounced write put on disk.
function written(): ViewState | undefined {
  return ipc.viewStateSet.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  resetViewState();
  ipc.viewStateGet.mockReset();
  ipc.viewStateSet.mockReset();
  ipc.viewStateSet.mockResolvedValue(undefined);
});

afterEach(() => {
  resetViewState();
  vi.useRealTimers();
});

describe("view-state owner", () => {
  // The trap this guards: a Panel mounts and the Dock reports its tabs before
  // the read lands, and taking those for the truth writes a one-tab document
  // over the one being loaded.
  it("ignores every patch until the document has been read", async () => {
    noteTabZoom(ROOT, 200);
    publishCompositionTabs([{ compositionId: ROOT, anchorLayerId: null }], alive(ROOT), ROOT);
    noteTrackHeights({ t1: 64 });
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);
    expect(ipc.viewStateSet).not.toHaveBeenCalled();

    await open({ composition_tabs: [tab(ROOT, { px_per_sec: 120 })] });
    expect(compositionTabIntent()).toEqual([tab(ROOT, { px_per_sec: 120 })]);
  });

  // The reason this module exists: N Panels sharing one file would each save
  // the whole document, and the last writer would revert the others.
  it("coalesces every Panel's patch into one write", async () => {
    await open();
    publishCompositionTabs(
      [
        { compositionId: ROOT, anchorLayerId: null },
        { compositionId: G1, anchorLayerId: "ref-g1" },
      ],
      alive(ROOT, G1),
      G1,
    );
    noteTabZoom(ROOT, 200);
    noteTabZoom(G1, 40);
    noteTabScroll(G1, 640);
    noteTrackHeights({ "t-root": 96 });
    noteTrackExpanded("t-g1", true);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);

    expect(ipc.viewStateSet).toHaveBeenCalledOnce();
    expect(written()).toEqual({
      composition_tabs: [
        tab(ROOT, { px_per_sec: 200 }),
        tab(G1, { anchor_layer_id: "ref-g1", px_per_sec: 40, scroll_left_px: 640 }),
      ],
      active_composition_id: G1,
      track_heights: { "t-root": 96 },
      expanded_tracks: ["t-g1"],
    });
  });

  it("remembers each tab's zoom and scroll separately", async () => {
    await open();
    publishCompositionTabs(
      [
        { compositionId: ROOT, anchorLayerId: null },
        { compositionId: G1, anchorLayerId: "ref-g1" },
      ],
      alive(ROOT, G1),
      ROOT,
    );
    noteTabScroll(ROOT, 900);
    noteTabScroll(G1, 40);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);

    expect(written()?.composition_tabs.map((entry) => entry.scroll_left_px)).toEqual([900, 40]);
  });

  // The two ways a tab leaves the Dock look identical from the Dock's side and
  // mean opposite things (ADR 0053).
  it("keeps the entry of a composition that was undone away, and drops one that was closed", async () => {
    await open();
    publishCompositionTabs(
      [
        { compositionId: ROOT, anchorLayerId: null },
        { compositionId: G1, anchorLayerId: "ref-g1" },
        { compositionId: G2, anchorLayerId: "ref-g2" },
      ],
      alive(ROOT, G1, G2),
      G2,
    );
    noteTabZoom(G2, 400);

    // G1's tab closed; G2's composition is gone from the project entirely.
    publishCompositionTabs([{ compositionId: ROOT, anchorLayerId: null }], alive(ROOT, G1), ROOT);

    expect(compositionTabIntent()).toEqual([
      tab(ROOT),
      tab(G2, { anchor_layer_id: "ref-g2", px_per_sec: 400 }),
    ]);
  });

  it("re-adopts a retained entry, with its zoom, when its composition comes back", async () => {
    await open({ composition_tabs: [tab(ROOT), tab(G2, { anchor_layer_id: "ref-g2", px_per_sec: 400 })] });
    publishCompositionTabs(
      [
        { compositionId: ROOT, anchorLayerId: null },
        { compositionId: G2, anchorLayerId: "ref-g2" },
      ],
      alive(ROOT, G2),
      G2,
    );

    expect(compositionTabIntent()).toEqual([
      tab(ROOT),
      tab(G2, { anchor_layer_id: "ref-g2", px_per_sec: 400 }),
    ]);
  });

  // Every Dock layout change publishes, a splitter-drag frame included.
  it("does not arm the writer for a publication that says nothing new", async () => {
    await open();
    const open1 = [{ compositionId: ROOT, anchorLayerId: null }];
    publishCompositionTabs(open1, alive(ROOT), ROOT);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);
    expect(ipc.viewStateSet).toHaveBeenCalledOnce();

    publishCompositionTabs(open1, alive(ROOT), ROOT);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);
    expect(ipc.viewStateSet).toHaveBeenCalledOnce();
  });

  it("merges row heights so one Panel's report cannot revert another's", async () => {
    await open({ track_heights: { "t-root": 96, "t-g1": 40 } });
    // The root's Panel reports its own row; the Group's Panel had already
    // resized one of its own, which the root's copy of the map predates.
    noteTrackHeights({ "t-g1": 120 });
    noteTrackHeights({ "t-root": 56 });
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);

    expect(written()?.track_heights).toEqual({ "t-root": 56, "t-g1": 120 });
  });

  it("collapses one row without touching the rest", async () => {
    await open({ expanded_tracks: ["t-root", "t-g1"] });
    noteTrackExpanded("t-g1", false);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);

    expect(written()?.expanded_tracks).toEqual(["t-root"]);
  });

  it("forgets the rows the project no longer has", async () => {
    await open({ track_heights: { "t-root": 96, "t-gone": 40 }, expanded_tracks: ["t-gone"] });
    retainTrackViewState(["t-root"]);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);

    expect(written()?.track_heights).toEqual({ "t-root": 96 });
    expect(written()?.expanded_tracks).toEqual([]);
  });

  it("is not a write when nothing was pruned", async () => {
    await open({ track_heights: { "t-root": 96 } });
    retainTrackViewState(["t-root"]);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);
    expect(ipc.viewStateSet).not.toHaveBeenCalled();
  });

  // Main resolves `<workspace>/view.json` when it handles the call, so a write
  // still in flight for the project being left would land in the one opening.
  it("cancels a pending write when the project changes", async () => {
    await open();
    noteTabZoom(ROOT, 200);
    resetViewState();
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);

    expect(ipc.viewStateSet).not.toHaveBeenCalled();
    expect(compositionTabIntent()).toEqual([]);
  });

  it("does not seed the incoming project from a read the outgoing one started", async () => {
    let settle: (state: ViewState) => void = () => {};
    ipc.viewStateGet.mockReturnValue(new Promise<ViewState>((resolve) => { settle = resolve; }));
    const inFlight = loadViewState();
    resetViewState();
    settle({ ...viewStateDefaults(), composition_tabs: [tab(G1)] });
    await inFlight;

    expect(compositionTabIntent()).toEqual([]);
  });

  it("falls back to defaults rather than rejecting when the read fails", async () => {
    ipc.viewStateGet.mockRejectedValue(new Error("no workspace"));
    await expect(loadViewState()).resolves.toEqual(viewStateDefaults());
  });

  it("serves one read to every Panel that mounts", async () => {
    ipc.viewStateGet.mockResolvedValue(viewStateDefaults());
    await Promise.all([loadViewState(), loadViewState(), loadViewState()]);
    expect(ipc.viewStateGet).toHaveBeenCalledOnce();
  });

  it("has nothing to say about a timeline row bound to no composition", async () => {
    await open();
    noteTabZoom(null, 200);
    noteTabScroll(null, 300);
    vi.advanceTimersByTime(VIEW_SAVE_DEBOUNCE_MS);

    expect(ipc.viewStateSet).not.toHaveBeenCalled();
    expect(compositionTabIntent()).toEqual([]);
  });
});
