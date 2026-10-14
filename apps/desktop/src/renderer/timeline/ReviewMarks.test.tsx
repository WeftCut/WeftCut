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
const change = (patch: Partial<Change> & { id: string }): Change => ({
  class: "added", kind: "Layer", keys: [patch.id as Change["keys"][number]], aspects: [], details: [], composition_id: ROOT_ID, composition_ids: [ROOT_ID], ranges: [], ...patch,
});
const view: ReviewView = {
  version: { session: 1, revision: 1, baseline_revision: 1 }, has_baseline: true, user: [], user_count: 0,
  unreviewed: [
    change({ id: "Layer:added" }),
    change({ id: "Layer:edited", class: "modified", aspects: ["params"] }),
    change({ id: "Layer:moved", class: "modified", aspects: ["placement"], from: { composition_id: ROOT_ID, track_id: "track-2" }, to: { composition_id: ROOT_ID, track_id: "track-1" } }),
    change({ id: "Shift:x:5", class: "modified", aspects: ["timing"], keys: ["Layer:shifted"], delta_us: 5 }),
    change({ id: "Layer:gone", class: "removed", from: { composition_id: ROOT_ID, track_id: "track-2" }, ranges: [{ composition_id: ROOT_ID, t_start_us: 3 * S, t_end_us: 4 * S }] }),
    change({ id: "Layer:inner", composition_id: "grp", composition_ids: ["grp"] }),
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
    range: { kind: "edges", composition_id: ROOT_ID, t_us: S, end_t_us: 2 * S, start: { layer_id: "edited", src_us: 0 }, end: null }, created_at: "",
    composition_id: ROOT_ID, t_us: S, end_t_us: 2 * S, state: "visible", outdated: false, follows: { start: { layer_id: "edited" }, end: null }, ...patch,
  });
  beforeEach(() => {
    useAgentActivity.setState({
      snapshot: { workspace_id: "w", revision: 1, session: null, sessions: [], activities: [], evicted: 0, lock_reason: null, checkpoints: [], tacks: [tack()] },
      reviewFocus: null, reviewHover: null, tab: "activity",
    });
  });
  const washes = (c: HTMLElement) => q(c, '[data-testid="review-focus-wash"]');
  const outlines = (c: HTMLElement) => Object.fromEntries(q(c, '[data-testid="review-focus-outline"]').map((o) => [o.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId, o.dataset.focus]));

  it("a focused tack washes its range across every lane, over the clips, and rings the clip it follows", () => {
    const { container } = renderTimeline();
    const before = geometry(container);
    act(() => useAgentActivity.getState().selectTack("t1"));
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
    act(() => useAgentActivity.getState().selectTack("t1"));
    expect(washes(container).every((w) => w.dataset.point === "true" && w.style.width === "")).toBe(true);
    act(() => useAgentActivity.setState({ reviewOverlay: false }));
    expect(washes(container)).toHaveLength(0);
    expect(q(container, '[data-testid="review-focus-outline"]')).toHaveLength(0);
  });

  it("a focused change rings its clips and washes its range; the other marks step back", () => {
    useReview.getState().apply({ ...view, version: { ...view.version, revision: 2 },
      unreviewed: view.unreviewed.map((c) => (c.id === "Layer:edited" ? { ...c, ranges: [{ composition_id: ROOT_ID, t_start_us: S, t_end_us: 2 * S }] } : c)) });
    const { container } = renderTimeline();
    act(() => useAgentActivity.getState().selectChange("Layer:edited"));
    expect(outlines(container)).toEqual({ edited: "change" });
    expect(washes(container).map((w) => w.dataset.kind)).toEqual(["change", "change"]);
    const recede = Object.fromEntries(q(container, '[data-testid="review-clip-mark"]').map((m) => [m.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId, m.dataset.recede ?? null]));
    expect(recede).toEqual({ added: "true", edited: null, moved: "true", shifted: "true" });
    expect(q(container, '[data-testid="review-ghost"]')[0]!.dataset.recede).toBe("true");
  });

  it("a hovered change row rings its clips thinly; a focused removal rings its ghost", () => {
    const { container } = renderTimeline();
    act(() => useAgentActivity.getState().setReviewHover({ kind: "change", id: "Shift:x:5" }));
    expect(outlines(container)).toEqual({ shifted: "hover" });
    expect(washes(container)).toHaveLength(0);
    act(() => useAgentActivity.getState().selectChange("Layer:gone"));
    const ghost = q(container, '[data-testid="review-ghost"]')[0]!;
    expect([ghost.dataset.focus, ghost.dataset.recede]).toEqual(["change", undefined]);
  });

  it("a ghost click focuses its change; a clip click still only selects the clip", () => {
    const { container } = renderTimeline();
    fireEvent.click(q(container, '[data-testid="review-ghost"]')[0]!);
    expect(useAgentActivity.getState()).toMatchObject({ tab: "changes", reviewFocus: { kind: "change", id: "Layer:gone" } });
    const block = q(container, '[data-layer-id="added"]')[0]!;
    fireEvent.pointerDown(block, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(block, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(block);
    expect([...layerIdsOf(currentSelection())]).toEqual(["added"]);
    expect(useAgentActivity.getState().reviewFocus).toEqual({ kind: "change", id: "Layer:gone" });
  });

  it("brings a focused range into view by scrolling, never by moving the playhead", () => {
    const { container, getByTestId } = renderTimeline();
    const viewport = getByTestId("timeline-track-viewport");
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 300 });
    const playhead = usePlayheadStore.getState();
    act(() => useAgentActivity.getState().selectChange("Shift:x:5"));
    // The change has no range; nothing to reveal, nothing moved.
    expect(viewport.scrollLeft).toBe(0);
    act(() => useAgentActivity.getState().selectChange("Layer:gone"));
    const wash = washes(container)[0]!;
    const [left, width] = [parseFloat(wash.style.left), parseFloat(wash.style.width)];
    expect(viewport.scrollLeft).toBeGreaterThan(0);
    expect(viewport.scrollLeft).toBeLessThanOrEqual(left);
    expect(viewport.scrollLeft + viewport.clientWidth).toBeGreaterThan(left + width);
    expect(usePlayheadStore.getState()).toBe(playhead);
  });
});
