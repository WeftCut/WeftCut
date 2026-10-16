// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "../i18n";
import type { Change, ReviewView } from "../../shared/review";
import type { LayerSummary, TrackSummary } from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { useAgentActivity } from "../agent/activityStore";
import type { TackView } from "../../shared/agent-activity";
import { usePlayheadStore } from "../state/playheadStore";
import { resetReviewForTests, useReview } from "../agent/reviewStore";
import { buildReviewHighlight } from "../agent/reviewHighlight";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, layerIdsOf, currentSelection } from "../state/selectionStore";
import { ROOT_ID, compositionFixture, groupLayerFixture, summaryFixture } from "../testing/summaryFixture";
import { Timeline } from "./Timeline";
import { mergeCuts } from "./ReviewMarks";
import { uiPixels } from "../settings/layoutTheme";
import { UI_METRICS } from "../settings/uiMetrics";
import { selectChange, selectTack, setReviewFocus, setReviewHover, useReviewFocus } from "../agent/reviewFocus";

// The Review overlay's clip decorations (ADR 0115) are paint inside boxes that
// already exist: turning them on must not move or size a clip or a lane, and
// must not take a press from the clip under them.

const ipc = vi.hoisted(() => ({
  viewStateGet: vi.fn().mockResolvedValue({ composition_tabs: [], active_composition_id: null, track_heights: {}, expanded_tracks: [] }),
  viewStateSet: vi.fn().mockResolvedValue(undefined),
  logEmit: vi.fn().mockResolvedValue(undefined),
  getWaveformPeaks: vi.fn().mockRejectedValue("not_ready"),
  reviewView: vi.fn().mockRejectedValue(new Error("no backend")),
}));
vi.mock("../ipc", async (importOriginal) => ({ ...(await importOriginal<typeof import("../ipc")>()), ...ipc }));
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

const S = 1_000_000;
const clip = (id: string, s: number, e: number): LayerSummary => ({
  id, label: id, t_start_us: s, t_end_us: e, kind: "Color", color_hint: "#4488cc", enabled: true, locked: false,
  params: { kind: "Color", color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 1 } }, width: 1920, height: 1080 }, effects: [],
});
const group = groupLayerFixture({ id: "group-clip", compositionId: "grp", tStartUs: 6 * S, tEndUs: 8 * S });
const track: TrackSummary = {
  id: "track-1", kind: "Video", label: "V1", enabled: true, locked: false, muted: false, solo: false, role: "a-roll", transient: false,
  layers: [clip("added", 0, S), clip("edited", S, 2 * S), clip("moved", 2 * S, 3 * S), clip("shifted", 4 * S, 5 * S), group],
};
const other: TrackSummary = { ...track, id: "track-2", role: null, label: "V2", layers: [] };
const change = (patch: Partial<Change> & Pick<Change, 'id'>): Change => ({
  class: "added", details: [], composition_id: ROOT_ID, ranges: [], ...patch,
});
const view: ReviewView = {
  version: { session: 1, revision: 1, baseline_revision: 1 }, content_revision: 1, has_baseline: true, user: [], user_count: 0,
  unreviewed: [
    change({ id: "Layer:added" }),
    change({ id: "Layer:edited", class: "modified" }),
    change({ id: "Layer:moved", class: "modified" }),
    change({ id: "Layer:shifted", class: "modified" }),
    change({ id: "Layer:gone", class: "removed", before_ranges: [{ composition_id: ROOT_ID, track_id: "track-2", t_start_us: 3 * S, t_end_us: 4 * S }] }),
    change({ id: "Layer:inner", composition_id: "grp" }),
  ],
  decorations: [{ layer_id: "group-clip", composition_id: ROOT_ID, t_start_us: 6 * S, t_end_us: 8 * S, change_ids: ["Layer:inner"] }],
};

function renderTimeline() {
  return render(
    <Timeline compositionId={null} tracks={[track, other]} links={[]} transitions={[]} durationUs={10 * S} keybindings={{}}
      fpsNum={30} fpsDen={1} bladeMode={false} media={[]} readinessOf={() => ({ ready: true })}
      onExitBlade={vi.fn()} onSeek={vi.fn()} onMutated={vi.fn().mockResolvedValue(undefined)} />,
  );
}
const q = (c: HTMLElement, sel: string) => [...c.querySelectorAll<HTMLElement>(sel)];
/** Every clip block's and lane's box, as the overlay must leave them. */
const geometry = (c: HTMLElement) => ({
  blocks: q(c, "[data-layer-id]").map((b) => [b.dataset.layerId, b.style.left, b.style.top, b.style.width, b.style.height, b.className]),
  lanes: q(c, '[data-testid="track-lane"]').map((l) => [l.dataset.trackId, l.style.height, l.className]),
});

beforeEach(() => {
  resetReviewForTests();
  clearLayerSelection();
  useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, display_mode: "AllTracks" } }));
  useProjectStore.getState().apply(summaryFixture({
    root: { tracks: [track, other], duration_us: 10 * S },
    groups: [compositionFixture({ id: "grp", duration_us: 2 * S })],
  }));
  useAgentActivity.setState({ reviewOverlay: true });
  useReview.getState().apply(view);
});
afterEach(() => { cleanup(); resetReviewForTests(); });

describe("Review overlay clip decorations", () => {
  it("marks added and modified clips — a move or a translation is a modification — ghosts the removed one on its surviving track, badges the Group", () => {
    const { container } = renderTimeline();
    const marks = Object.fromEntries(q(container, '[data-testid="review-clip-mark"]').map((m) => [m.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId, m.dataset.reviewMark]));
    expect(marks).toEqual({ added: "added", edited: "modified", moved: "modified", shifted: "modified" });
    const ghosts = q(container, '[data-testid="review-ghost"]');
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.closest<HTMLElement>('[data-testid="track-lane"]')!.dataset.trackId).toBe("track-2");
    // At its baseline place: starts at 3 s and lasts 1 s, whatever the zoom.
    const [left, width] = [parseFloat(ghosts[0]!.style.left), parseFloat(ghosts[0]!.style.width)];
    expect(width).toBeGreaterThan(0);
    expect(left).toBeCloseTo(3 * width);
    const badge = q(container, '[data-testid="review-group-badge"]');
    expect(badge).toHaveLength(1);
    expect(badge[0]!.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId).toBe("group-clip");
    expect(badge[0]!.textContent).toBe("1");
    expect(badge[0]!.getAttribute("aria-label")).toBe("Contains 1 unreviewed change(s)");
  });

  it("counting a selected activity's changes, the Group badge does not call them unreviewed", () => {
    const { container } = renderTimeline();
    act(() => useReview.setState({ activity: {
      activityId: "a", historyIds: ["op"], effect: "applied", status: "ready", reverted: false, count: 1,
      highlight: buildReviewHighlight([view.unreviewed[5]!], view.decorations),
    } }));
    const [badge] = q(container, '[data-testid="review-group-badge"]');
    expect(badge!.getAttribute("aria-label")).toBe("Contains 1 change(s)");
  });

  it("never takes pointer events and never changes clip or lane geometry", () => {
    const { container } = renderTimeline();
    const decorated = geometry(container);
    const paints = q(container, '[data-testid="review-clip-mark"], [data-testid="review-ghost"], [data-testid="review-group-badge"]');
    expect(paints.length).toBe(6);
    // A ghost takes the click (it focuses its change) and nothing else — see
    // "a ghost click focuses its change".
    for (const p of paints) if (p.dataset.testid !== "review-ghost") expect(p.className.split(/\s+/)).toContain("pointer-events-none");
    act(() => useAgentActivity.setState({ reviewOverlay: false }));
    expect(q(container, '[data-testid="review-clip-mark"], [data-testid="review-ghost"], [data-testid="review-group-badge"]')).toHaveLength(0);
    expect(geometry(container)).toEqual(decorated);
  });

  it("a press on a decorated clip still selects that clip", () => {
    const { container } = renderTimeline();
    const mark = q(container, '[data-testid="review-clip-mark"]').find((m) => m.dataset.reviewMark === "modified")!;
    fireEvent.pointerDown(mark, { button: 0, pointerId: 1, clientX: 150, clientY: 10 });
    fireEvent.pointerUp(mark, { button: 0, pointerId: 1, clientX: 150, clientY: 10 });
    expect([...layerIdsOf(currentSelection())]).toEqual(["edited"]);
  });

  it("approval removes every highlight in the same update", () => {
    const { container } = renderTimeline();
    act(() => { useReview.getState().apply({ ...view, version: { ...view.version, baseline_revision: 2 }, unreviewed: [] }); });
    expect(q(container, '[data-testid="review-clip-mark"], [data-testid="review-ghost"], [data-testid="review-group-badge"]')).toHaveLength(0);
  });
});

describe("Review focus on the editor timeline", () => {
  const tack = (patch: Partial<TackView> = {}): TackView => ({
    id: "t1", session_id: null, connection_id: "c", client: "C", activity_id: "a", kind: "issue", label: "Pause", body: "", status: "open",
    range: { composition_id: ROOT_ID, t_us: S, end_t_us: 2 * S }, created_at: "",
    composition_id: ROOT_ID, t_us: S, end_t_us: 2 * S, outdated: false, follows: { layer_id: "edited", src_us: 0, t_us: S }, ...patch,
  });
  beforeEach(() => {
    useAgentActivity.setState({
      snapshot: { workspace_id: "w", revision: 1, session: null, sessions: [], activities: [], evicted: 0, lock_reason: null, checkpoints: [], tacks: [tack()] },
      tab: "activity",
    });
    useReviewFocus.setState({ focus: null, hover: null });
  });
  const washes = (c: HTMLElement) => q(c, '[data-testid="review-focus-wash"]');
  const outlines = (c: HTMLElement) => Object.fromEntries(q(c, '[data-testid="review-focus-outline"]').map((o) => [o.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId, o.dataset.focus]));

  it("a focused tack washes its range across every lane, over the clips, and rings the clip it follows", () => {
    const { container } = renderTimeline();
    const before = geometry(container);
    act(() => selectTack("t1"));
    const painted = washes(container);
    expect(painted.map((w) => [w.closest<HTMLElement>('[data-testid="track-lane"]')!.dataset.trackId, w.dataset.kind]).sort()).toEqual([["track-1", "tack"], ["track-2", "tack"]]);
    for (const w of painted) {
      expect(w.className.split(/\s+/)).toContain("pointer-events-none");
      // Over the blocks: after them in its lane, raised above a selected one.
      const lane = w.closest<HTMLElement>('[data-testid="track-lane"]')!;
      for (const block of lane.querySelectorAll("[data-layer-id]")) {
        expect(block.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(w.className.split(/\s+/)).toContain("z-[2]");
      expect(parseFloat(w.style.width)).toBeCloseTo(parseFloat(w.style.left));
    }
    expect(outlines(container)).toEqual({ edited: "tack" });
    expect(geometry(container)).toEqual(before);
  });

  it("a point tack is a line; the overlay switched off takes wash and ring with it", () => {
    useAgentActivity.setState((s) => ({ snapshot: { ...s.snapshot!, tacks: [tack({ end_t_us: null })] } }));
    const { container } = renderTimeline();
    act(() => selectTack("t1"));
    expect(washes(container).every((w) => w.dataset.point === "true" && w.style.width === "")).toBe(true);
    act(() => useAgentActivity.setState({ reviewOverlay: false }));
    expect(washes(container)).toHaveLength(0);
    expect(q(container, '[data-testid="review-focus-outline"]')).toHaveLength(0);
  });

  it("a focused change rings its clips and washes its range; the other marks step back", () => {
    useReview.getState().apply({ ...view, version: { ...view.version, revision: 2 },
      unreviewed: view.unreviewed.map((c) => (c.id === "Layer:edited" ? { ...c, ranges: [{ composition_id: ROOT_ID, track_id: null, t_start_us: S, t_end_us: 2 * S }] } : c)) });
    const { container } = renderTimeline();
    act(() => selectChange("Layer:edited"));
    expect(outlines(container)).toEqual({ edited: "change" });
    expect(washes(container).map((w) => w.dataset.kind)).toEqual(["change", "change"]);
    const recede = Object.fromEntries(q(container, '[data-testid="review-clip-mark"]').map((m) => [m.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId, m.dataset.recede ?? null]));
    expect(recede).toEqual({ added: "true", edited: null, moved: "true", shifted: "true" });
    expect(q(container, '[data-testid="review-ghost"]')[0]!.dataset.recede).toBe("true");
  });

  it("a hovered change row rings its clips thinly; a focused removal rings its ghost", () => {
    const { container } = renderTimeline();
    // The hovered row is in the Changes tab.
    act(() => useAgentActivity.setState({ tab: "changes" }));
    act(() => setReviewHover({ kind: "change", source: "review", id: "Layer:shifted" }));
    expect(outlines(container)).toEqual({ shifted: "hover" });
    expect(washes(container)).toHaveLength(0);
    act(() => selectChange("Layer:gone"));
    const ghost = q(container, '[data-testid="review-ghost"]')[0]!;
    expect([ghost.dataset.focus, ghost.dataset.recede]).toEqual(["change", undefined]);
  });

  it("a pointed-at ghost lifts over the clips as an edge that takes no press; otherwise it sits under them and takes the click", () => {
    // A ripple closed up over it: a current clip occupies its baseline place.
    const covered = { ...other, layers: [clip("closed-up", 3 * S, 4 * S)] };
    const { container } = render(
      <Timeline compositionId={null} tracks={[track, covered]} links={[]} transitions={[]} durationUs={10 * S} keybindings={{}}
        fpsNum={30} fpsDen={1} bladeMode={false} media={[]} readinessOf={() => ({ ready: true })}
        onExitBlade={vi.fn()} onSeek={vi.fn()} onMutated={vi.fn().mockResolvedValue(undefined)} />,
    );
    const ghost = () => q(container, '[data-testid="review-ghost"]')[0]!;
    expect(ghost().dataset.raised).toBeUndefined();
    expect(ghost().className.split(/\s+/)).toEqual(expect.arrayContaining(["cursor-pointer"]));
    expect(ghost().className).not.toContain("z-[3]");
    act(() => useAgentActivity.setState({ tab: "changes" }));
    act(() => setReviewHover({ kind: "change", source: "review", id: "Layer:gone" }));
    expect(ghost().dataset.raised).toBe("true");
    act(() => setReviewHover(null));
    act(() => selectChange("Layer:gone"));
    expect(ghost().dataset.raised).toBe("true");
    expect(ghost().className.split(/\s+/)).toEqual(expect.arrayContaining(["pointer-events-none", "z-[3]"]));
    // Focused, it is named in its corner — the removed twin of a move's "before" box —
    // and nothing washes over the clip now there: that would say it was removed.
    expect(ghost().textContent).toBe("Removed 3.0 – 4.0 s");
    expect(q(container, '[data-testid="review-focus-wash"]')).toHaveLength(0);
    act(() => setReviewHover({ kind: "change", source: "review", id: "Layer:gone" }));
    act(() => setReviewFocus(null));
    expect(ghost().textContent).toBe("");
    // The clip it lies over keeps its press.
    const block = q(container, '[data-layer-id="closed-up"]')[0]!;
    fireEvent.pointerDown(block, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(block, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(block);
    expect([...layerIdsOf(currentSelection())]).toEqual(["closed-up"]);
  });

  it("a removal shows a lane-top edge over the clips across its baseline stretch, but for while it is focused; it takes no press", () => {
    const { container } = renderTimeline();
    const [edge] = q(container, '[data-testid="review-ghost-edge"]');
    const ghost = q(container, '[data-testid="review-ghost"]')[0]!;
    expect(edge!.closest<HTMLElement>('[data-testid="track-lane"]')!.dataset.trackId).toBe("track-2");
    expect([edge!.style.left, edge!.style.width]).toEqual([ghost.style.left, ghost.style.width]);
    expect(edge!.className.split(/\s+/)).toEqual(expect.arrayContaining(["pointer-events-none", "top-0", "z-[3]"]));
    // Another change focused: it steps back with the other marks.
    act(() => selectChange("Layer:edited"));
    expect(edge!.dataset.recede).toBe("true");
    // Focused itself, its named box says it once.
    act(() => selectChange("Layer:gone"));
    expect(q(container, '[data-testid="review-ghost-edge"]')).toHaveLength(0);
    act(() => setReviewFocus(null));
    expect(q(container, '[data-testid="review-ghost-edge"]')).toHaveLength(1);
  });

  it("a removed clip's footprint washes no lane while its own lane shows its ghost; with that lane gone it washes them all", () => {
    const { container } = renderTimeline();
    act(() => selectChange("Layer:gone"));
    const lanesWashed = () => q(container, '[data-testid="track-lane"]')
      .filter((l) => l.querySelector('[data-testid="review-focus-wash"]')).map((l) => l.dataset.trackId);
    expect(lanesWashed()).toEqual([]);
    const gone = { ...view.unreviewed[4]!, before_ranges: [{ composition_id: ROOT_ID, track_id: "no-such-track", t_start_us: 3 * S, t_end_us: 4 * S }] };
    act(() => useReview.getState().apply({ ...view, version: { ...view.version, revision: 3 }, unreviewed: [gone] }));
    expect(lanesWashed().sort()).toEqual(["track-1", "track-2"]);
  });

  it("under an activity's highlight a ghost says where the clip was before that call", () => {
    const { container } = renderTimeline();
    expect(q(container, '[data-testid="review-ghost"]')[0]!.title).toContain("baseline position");
    act(() => useReview.setState({ activity: { activityId: "a", historyIds: [], effect: null, status: "ready", reverted: false, count: 1,
      highlight: buildReviewHighlight([view.unreviewed[4]!], []) } as never }));
    expect(q(container, '[data-testid="review-ghost"]')[0]!.title).toBe("Removed clip, position before this call 00:00:03:00 – 00:00:04:00");
  });

  it("a ghost click focuses its change; a clip click selects that clip and lets the focus go", () => {
    const { container } = renderTimeline();
    fireEvent.click(q(container, '[data-testid="review-ghost"]')[0]!);
    expect(useAgentActivity.getState().tab).toBe("changes");
    expect(useReviewFocus.getState().focus).toEqual({ kind: "change", source: "review", id: "Layer:gone" });
    const block = q(container, '[data-layer-id="added"]')[0]!;
    fireEvent.pointerDown(block, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(block, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(block);
    expect([...layerIdsOf(currentSelection())]).toEqual(["added"]);
    expect(useReviewFocus.getState().focus).toBeNull();
  });

  it("brings a focused range into view by scrolling, never by moving the playhead", () => {
    const { container, getByTestId } = renderTimeline();
    const viewport = getByTestId("timeline-track-viewport");
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 300 });
    const playhead = usePlayheadStore.getState();
    act(() => selectChange("Layer:shifted"));
    // The change has no range; nothing to reveal, nothing moved.
    expect(viewport.scrollLeft).toBe(0);
    act(() => selectChange("Layer:gone"));
    // A removal has no current range: what it reveals is its baseline footprint, its ghost.
    expect(washes(container)).toHaveLength(0);
    const wash = q(container, '[data-testid="review-ghost"]')[0]!;
    const [left, width] = [parseFloat(wash.style.left), parseFloat(wash.style.width)];
    expect(viewport.scrollLeft).toBeGreaterThan(0);
    expect(viewport.scrollLeft).toBeLessThanOrEqual(left);
    expect(viewport.scrollLeft + viewport.clientWidth).toBeGreaterThan(left + width);
    expect(usePlayheadStore.getState()).toBe(playhead);
  });
});

describe("Pure change marks", () => {
  it("retains the original lane-top trim placement, size, click focus and overlay lifecycle", () => {
    const trimmed = change({ id: "Layer:edited", class: "modified", ranges: [{ composition_id: ROOT_ID, track_id: "track-1", t_start_us: S, t_end_us: 2 * S }],
      details: [{ type: "trim", side: "start", delta_us: -S }, { type: "trim", side: "end", delta_us: -S }] });
    const extended = change({ id: "Layer:moved", class: "modified", details: [{ type: "trim", side: "end", delta_us: S }] });
    useReview.getState().apply({ ...view, version: { ...view.version, revision: 2 }, unreviewed: [trimmed, extended, view.unreviewed[4]!] });
    const { container } = renderTimeline();
    const before = geometry(container);
    const cuts = () => q(container, '[data-testid="review-cut"]');
    const marks = cuts();
    expect(marks).toHaveLength(2);
    const pxPerSec = parseFloat(q(container, '[data-layer-id="added"]')[0]!.style.width);
    const metrics = UI_METRICS.timeline.review.cutMark;
    marks.forEach((mark, i) => {
      expect(mark.closest('[data-layer-id]')).toBeNull();
      const lane = mark.closest<HTMLElement>('[data-testid="track-lane"]')!;
      expect(lane.dataset.trackId).toBe('track-1');
      expect(parseFloat(mark.style.left) + parseFloat(mark.style.width) / 2).toBeCloseTo((i + 1) * pxPerSec);
      expect([parseFloat(mark.style.width), parseFloat(mark.style.height)]).toEqual([uiPixels(metrics.width), uiPixels(metrics.height)]);
      expect(mark.className.split(/\s+/)).toEqual(expect.arrayContaining(['top-0', 'z-[3]', 'cursor-pointer']));
      expect(mark.title).toBe('Modified: Cut 1.0 s from the start · Cut 1.0 s from the end');
      expect(mark.getAttribute('aria-label')).toBe(mark.title);
      for (const block of lane.querySelectorAll('[data-layer-id]')) {
        expect(block.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });
    fireEvent.click(marks[0]!);
    expect(useAgentActivity.getState().tab).toBe('changes');
    expect(useReviewFocus.getState().focus).toEqual({ kind: 'change', source: 'review', id: 'Layer:edited' });
    act(() => selectChange('Layer:gone'));
    expect(cuts().every(m => m.dataset.recede === 'true')).toBe(true);
    act(() => useAgentActivity.setState({ reviewOverlay: false }));
    expect(cuts()).toHaveLength(0);
    expect(geometry(container)).toEqual(before);
    act(() => useAgentActivity.setState({ reviewOverlay: true }));
    expect(cuts()).toHaveLength(2);
    act(() => useReview.getState().apply({ ...view, version: { ...view.version, revision: 3 }, unreviewed: [] }));
    expect(cuts()).toHaveLength(0);
  });
  it("a focused change dims every other clip; a press elsewhere on the lanes ends the focus, one on its clip keeps it", () => {
    const { container } = renderTimeline();
    const dimmed = () => q(container, '[data-testid="review-spotlight-dim"]').map((d) => d.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId).sort();
    expect(dimmed()).toEqual([]);
    act(() => selectChange("Layer:moved"));
    expect(dimmed()).toEqual(["added", "edited", "group-clip", "shifted"]);
    // A tack's focus or a hover dims nothing.
    act(() => useReviewFocus.setState({ focus: null, hover: { kind: "change", source: "review", id: "Layer:moved" } }));
    expect(dimmed()).toEqual([]);
    act(() => useReviewFocus.setState({ hover: null }));
    act(() => selectChange("Layer:moved"));
    fireEvent.pointerDown(q(container, '[data-layer-id="moved"]')[0]!);
    expect(useReviewFocus.getState().focus).toEqual({ kind: "change", source: "review", id: "Layer:moved" });
    fireEvent.pointerDown(q(container, '[data-layer-id="added"]')[0]!);
    expect(useReviewFocus.getState().focus).toBeNull();
    expect(dimmed()).toEqual([]);
    act(() => selectChange("Layer:moved"));
    fireEvent.pointerDown(q(container, '[data-testid="track-lane"]')[0]!);
    expect(useReviewFocus.getState().focus).toBeNull();
  });
  it("keeps the original pixel clustering and midpoint at each zoom", () => {
    const at = (tUs: number) => ({ changeId: `c${tUs}`, layerId: 'l', compositionId: ROOT_ID, trackId: 'track-1', tUs, kind: 'trim' as const });
    const list = [at(0), at(0.05 * S), at(0.1 * S), at(S)];
    expect(mergeCuts(list, 100, 6).map(g => [g.px, g.cuts.length])).toEqual([[5, 3], [100, 1]]);
    expect(mergeCuts(list, 200, 6).map(g => g.cuts.length)).toEqual([1, 1, 1, 1]);
  });
  it("shows baseline frames only for the focused entity and never inferred cuts", () => {
    const moved = change({ id: "Layer:moved", class: "modified", details: [{ type: "time", field: "start", from_us: 4 * S, to_us: 2 * S }],
      ranges: [{ composition_id: ROOT_ID, track_id: null, t_start_us: 2 * S, t_end_us: 3 * S }],
      before_ranges: [{ composition_id: ROOT_ID, track_id: "track-2", t_start_us: 4 * S, t_end_us: 5 * S }] });
    useReview.getState().apply({ ...view, version: { ...view.version, revision: 2 }, unreviewed: [moved] });
    const { container } = renderTimeline();
    expect(q(container, '[data-testid="review-was"]')).toHaveLength(0);
    act(() => selectChange("Layer:moved"));
    const frames = q(container, '[data-testid="review-was"]');
    expect(frames).toHaveLength(1);
    // Over the clip now in its place, as paint only, named as the place it was.
    expect(frames[0]!.className.split(/\s+/)).toEqual(expect.arrayContaining(["pointer-events-none", "z-[3]"]));
    expect(frames[0]!.textContent).toBe("Before 4.0 – 5.0 s");
    expect(frames[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(frames[0]!.closest<HTMLElement>('[data-testid="track-lane"]')!.dataset.trackId).toBe("track-2");
    expect(q(container, '[data-testid="review-cut"]')).toHaveLength(0);
    expect(q(container, '[data-layer-id="moved"]')[0]!.title).toContain("Start 4.0 → 2.0 s");
    act(() => setReviewFocus(null));
    expect(q(container, '[data-testid="review-was"]')).toHaveLength(0);
  });
});
