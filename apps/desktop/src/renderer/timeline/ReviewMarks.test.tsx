// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "../i18n";
import type { Change, ReviewView } from "../../shared/review";
import type { LayerSummary, TrackSummary } from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { useAgentActivity } from "../agent/activityStore";
import { resetReviewForTests, useReview } from "../agent/reviewStore";
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
  class: "added", kind: "Layer", keys: [patch.id as Change["keys"][number]], aspects: [], composition_id: ROOT_ID, composition_ids: [ROOT_ID], ranges: [], ...patch,
});
const view: ReviewView = {
  version: { session: 1, revision: 1, baseline_revision: 1 }, has_baseline: true, user: [],
  unreviewed: [
    change({ id: "Layer:added" }),
    change({ id: "Layer:edited", class: "modified", aspects: ["params"] }),
    change({ id: "Layer:moved", class: "moved", aspects: ["placement"], from: { composition_id: ROOT_ID, track_id: "track-2" }, to: { composition_id: ROOT_ID, track_id: "track-1" } }),
    change({ id: "Shift:x:5", class: "shifted", keys: ["Layer:shifted"], delta_us: 5 }),
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
  it("marks added, modified, moved and shifted clips, ghosts the removed one on its surviving track, badges the Group", () => {
    const { container } = renderTimeline();
    const marks = Object.fromEntries(q(container, '[data-testid="review-clip-mark"]').map((m) => [m.closest<HTMLElement>("[data-layer-id]")!.dataset.layerId, m.dataset.reviewMark]));
    expect(marks).toEqual({ added: "added", edited: "modified", moved: "moved", shifted: "shifted" });
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
  });

  it("never takes pointer events and never changes clip or lane geometry", () => {
    const { container } = renderTimeline();
    const decorated = geometry(container);
    const paints = q(container, '[data-testid="review-clip-mark"], [data-testid="review-ghost"], [data-testid="review-group-badge"]');
    expect(paints.length).toBe(6);
    for (const p of paints) expect(p.className.split(/\s+/)).toContain("pointer-events-none");
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
