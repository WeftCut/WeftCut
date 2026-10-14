// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import type { AgentWorkSession, TackView } from "../../shared/agent-activity";
import type { AppSettings, MarkerSummary } from "../ipc";
import { ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import { useProjectStore } from "../state/projectStore";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { setTimelineScrollLeftPx } from "../state/timelineScrollStore";
import { UI_METRICS } from "../settings/uiMetrics";
import { useAgentActivity } from "../agent/activityStore";
import { MarkerLane, MarkerLaneHeader } from "./MarkerLane";
const actions = vi.hoisted(() => ({ locateTack: vi.fn(() => true) }));
vi.mock("../agent/tackActions", () => actions);
import { ReviewLane, ReviewLaneHeader } from "./ReviewLane";

// The Review lane (ADR 0115): tacks as chips in a row of their own under the
// marker lane. It exists by the overlay and the opening's review material,
// never by the open-tack count, and its one row never follows its contents.

const PX_PER_SEC = 100;
const REVIEW = UI_METRICS.timeline.review;
const tack = (patch: Partial<TackView> = {}): TackView => ({
  id: "t1", session_id: null, connection_id: "c", client: "C", activity_id: "a", kind: "issue", label: "Pause", body: "",
  status: "open", range: { kind: "free", composition_id: ROOT_ID, t_us: 2_000_000, end_t_us: 3_000_000 }, created_at: "",
  composition_id: ROOT_ID, t_us: 2_000_000, end_t_us: 3_000_000, state: "visible", outdated: false, follows: { start: null, end: null }, ...patch,
});
const session = { id: "s1", connection_id: "c", client: "C", reason: "Cut", started_at: "", ended_at: null, end_reason: null, checkpoint_id: "k" } satisfies AgentWorkSession;
const marker: MarkerSummary = {
  id: "m1", t_us: 2_500_000, end_t_us: null, label: "Mark", note: "", color_hint: "#ff8800",
  anchor_layer: null, anchor_src_us: null, hibernating: false,
};

function seed(tacks: TackView[], sessions: AgentWorkSession[] = []) {
  useProjectStore.getState().apply(summaryFixture({ root: { markers: [marker], duration_us: 10_000_000 } }));
  useAgentActivity.setState({
    snapshot: { workspace_id: "w", revision: 1, session: null, sessions, activities: [], evicted: 0, lock_reason: null, checkpoints: [], tacks },
    ready: true, tab: "activity", reviewFocus: null, reviewHover: null, reviewOverlay: true, expanded: {},
  });
}
const setTacks = (tacks: TackView[]) =>
  act(() => useAgentActivity.setState((s) => ({ snapshot: { ...s.snapshot!, revision: s.snapshot!.revision + 1, tacks } })));
const renderRows = () => render(<>
  <MarkerLaneHeader />
  <MarkerLane compositionId={null} pxPerSec={PX_PER_SEC} widthPx={1000} viewportWidthPx={1000} fpsNum={30} fpsDen={1} />
  <ReviewLaneHeader />
  <ReviewLane compositionId={null} pxPerSec={PX_PER_SEC} widthPx={1000} viewportWidthPx={1000} fpsNum={30} fpsDen={1} />
</>);
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const chips = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-testid="timeline-tack"]')];
const laneHeight = `${REVIEW.laneHeight}px`;

beforeEach(() => {
  setTimelineScrollLeftPx(null, 0);
  useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, markers_visible: true } as AppSettings }));
});
afterEach(cleanup);

describe("Review lane", () => {
  it("is a row of its own after the marker lane, which paints no tack", () => {
    seed([tack()]);
    const { container } = renderRows();
    const lane = q(container, "timeline-review-lane")!;
    expect(chips(container).map((b) => b.closest('[data-testid="timeline-review-lane"]'))).toEqual([lane]);
    expect(q(container, "timeline-marker-lane")!.querySelector('[data-testid="timeline-tack"]')).toBeNull();
    expect(q(container, "timeline-marker-lane")!.compareDocumentPosition(lane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Neither header carries the overlay switch: it lives where it outlasts the
    // row it removes (Quick Actions, the View menu, the palette).
    expect(container.querySelector('[data-testid="timeline-review-overlay-toggle"]')).toBeNull();
    expect(q(container, "timeline-review-lane-header")!.textContent).toBe("Tacks");
  });

  it("stays with markers hidden — markers_visible does not govern tacks", () => {
    seed([tack()]);
    useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, markers_visible: false } as AppSettings }));
    const { container } = renderRows();
    expect(q(container, "timeline-marker-lane")).toBeNull();
    expect(q(container, "timeline-review-lane")).not.toBeNull();
    expect(chips(container)).toHaveLength(1);
  });

  it("exists once the opening has review material, and the open-tack count never moves it", () => {
    seed([]);
    const { container } = renderRows();
    expect(q(container, "timeline-review-lane")).toBeNull();
    expect(q(container, "timeline-review-lane-header")).toBeNull();
    // A work session alone is material: the row appears before the first tack.
    act(() => useAgentActivity.setState((s) => ({ snapshot: { ...s.snapshot!, revision: 2, sessions: [session] } })));
    const heights = () => [q(container, "timeline-review-lane")?.style.height, q(container, "timeline-review-lane-header")?.style.height];
    expect(heights()).toEqual([laneHeight, laneHeight]);
    for (const set of [
      [tack()],
      [1, 2, 3, 4, 5].map((i) => tack({ id: `t${i}` })),
      [tack({ status: "resolved" })],
      [],
    ]) {
      setTacks(set);
      expect(heights()).toEqual([laneHeight, laneHeight]);
    }
  });

  it("the overlay command turns the row off and back on", () => {
    seed([tack()]);
    const { container } = renderRows();
    act(() => useAgentActivity.setState({ reviewOverlay: false }));
    expect(q(container, "timeline-review-lane")).toBeNull();
    expect(q(container, "timeline-review-lane-header")).toBeNull();
    act(() => useAgentActivity.setState({ reviewOverlay: true }));
    expect(chips(container)).toHaveLength(1);
  });

  it("paints open visible tacks as chips: start, painted width, kind and label", () => {
    seed([
      tack(),
      tack({ id: "point", kind: "note", label: "Check", t_us: 5_000_000, end_t_us: null }),
      tack({ id: "done", status: "resolved" }),
      tack({ id: "asleep", state: "hibernating", t_us: null, end_t_us: null }),
    ]);
    const { container } = renderRows();
    expect(chips(container).map((b) => [b.dataset.tackId, b.dataset.kind, b.style.left, b.style.width, b.textContent])).toEqual([
      ["t1", "issue", "200px", "100px", "Pause"],
      // A point gets the icon's width, not a hairline.
      ["point", "note", "500px", `${REVIEW.chipMinWidth}px`, "Check"],
    ]);
    // One row, centred in a lane the marker lane's height.
    expect(REVIEW.laneHeight).toBe(UI_METRICS.timeline.marker.laneHeight);
    expect([chips(container)[0]!.style.height, chips(container)[0]!.style.top]).toEqual([
      `${REVIEW.chipHeight}px`, `${(REVIEW.laneHeight - REVIEW.chipHeight) / 2}px`,
    ]);
    expect(chips(container)[0]!.title).toMatch(/Pause/);
  });

  it("draws overlapping tacks as one group chip whose menu focuses the one chosen", () => {
    seed([
      tack({ id: "a", kind: "note", label: "Whole take" }),
      tack({ id: "b", kind: "issue", label: "Jump cut", t_us: 2_500_000, end_t_us: 2_800_000 }),
      tack({ id: "c", kind: "question", label: "", t_us: 2_900_000, end_t_us: 3_500_000 }),
      tack({ id: "apart", t_us: 6_000_000, end_t_us: 7_000_000 }),
    ]);
    const { container } = renderRows();
    expect(chips(container).map((b) => b.dataset.tackId)).toEqual(["apart"]);
    const group = q(container, "timeline-tack-group")!;
    // The union, the most pressing kind, the count, and what is there.
    expect([group.dataset.tackIds, group.dataset.kind, group.style.left, group.style.width, group.textContent]).toEqual([
      "a b c", "issue", "200px", "150px", "3Whole take · Jump cut",
    ]);
    expect(group.title.split("\n")).toHaveLength(4);
    fireEvent.click(group);
    const items = () => [...document.querySelectorAll<HTMLElement>('[data-testid="timeline-tack-group-item"]')];
    expect(items().map((i) => i.textContent)).toEqual(["Note · Whole take", "Issue · Jump cut", "Question"]);
    fireEvent.click(items()[1]!);
    expect(useAgentActivity.getState()).toMatchObject({ tab: "tacks", reviewFocus: { kind: "tack", id: "b" } });
    expect(group.dataset.selected).toBe("true");
    expect(q(container, "timeline-review-lane")!.dataset.selecting).toBe("true");
    // Reopened, the menu says which of its tacks is the focused one.
    fireEvent.click(group);
    expect(items().map((i) => i.querySelector(".app-menu-item-check")!.childElementCount)).toEqual([0, 1, 0]);
  });

  it("rings a group when the hovered Tacks tab row is one of its tacks", () => {
    seed([tack({ id: "a" }), tack({ id: "b" })]);
    const { container } = renderRows();
    act(() => useAgentActivity.getState().setReviewHover({ kind: "tack", id: "b" }));
    expect(q(container, "timeline-tack-group")!.dataset.hovered).toBe("true");
  });

  it("a chip click selects the tack; the rest dim only while the selection is on this lane", () => {
    seed([tack(), tack({ id: "t2", t_us: 6_000_000, end_t_us: 7_000_000 }), tack({ id: "done", status: "resolved" })]);
    const { container } = renderRows();
    fireEvent.click(chips(container)[0]!);
    expect(useAgentActivity.getState()).toMatchObject({ tab: "tacks", reviewFocus: { kind: "tack", id: "t1" } });
    expect(chips(container).map((b) => b.dataset.selected)).toEqual(["true", undefined]);
    expect(q(container, "timeline-review-lane")!.dataset.selecting).toBe("true");
    act(() => useAgentActivity.getState().selectTack("done"));
    expect(chips(container).map((b) => b.dataset.selected)).toEqual([undefined, undefined]);
    expect(q(container, "timeline-review-lane")!.dataset.selecting).toBeUndefined();
  });

  it("a chip click expands the tack's row in its group; a double-click also locates it", () => {
    seed([tack({ session_id: "s1" })], [session]);
    actions.locateTack.mockClear();
    const { container } = renderRows();
    fireEvent.click(chips(container)[0]!);
    expect(useAgentActivity.getState().expanded).toMatchObject({ "tacks-session-s1": true, "tack-t1": true });
    expect(actions.locateTack).not.toHaveBeenCalled();
    fireEvent.doubleClick(chips(container)[0]!);
    expect(actions.locateTack).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });

  it("a click on bare lane lets the focus go; one on a chip's contents keeps it", () => {
    seed([tack()]);
    const { container } = renderRows();
    fireEvent.click(chips(container)[0]!.querySelector(".review-tack-label")!);
    expect(useAgentActivity.getState().reviewFocus).toEqual({ kind: "tack", id: "t1" });
    fireEvent.click(q(container, "timeline-review-lane")!);
    expect(useAgentActivity.getState().reviewFocus).toBeNull();
    expect(chips(container)[0]!.dataset.selected).toBeUndefined();
  });

  it("rings the chip whose Tacks tab row is under the pointer", () => {
    seed([tack(), tack({ id: "t2", t_us: 6_000_000, end_t_us: 7_000_000 })]);
    const { container } = renderRows();
    act(() => useAgentActivity.getState().setReviewHover({ kind: "tack", id: "t2" }));
    expect(chips(container).map((b) => b.dataset.hovered)).toEqual([undefined, "true"]);
    // A hovered change names no chip.
    act(() => useAgentActivity.getState().setReviewHover({ kind: "change", id: "t1" }));
    expect(chips(container).map((b) => b.dataset.hovered)).toEqual([undefined, undefined]);
  });
});
