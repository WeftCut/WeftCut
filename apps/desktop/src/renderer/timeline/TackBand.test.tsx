// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../i18n";
import type { TackView } from "../../shared/agent-activity";
import type { AppSettings, MarkerSummary } from "../ipc";
import { ROOT_ID, summaryFixture } from "../testing/summaryFixture";
import { useProjectStore } from "../state/projectStore";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { setTimelineScrollLeftPx } from "../state/timelineScrollStore";
import { UI_METRICS } from "../settings/uiMetrics";
import { useAgentActivity } from "../agent/activityStore";
import { MarkerLane, MarkerLaneHeader } from "./MarkerLane";

// The Review overlay's tack bands live INSIDE the marker lane (ADR 0115,
// CONTEXT.md *Marker lane*): toggling them must never add a row, change the
// lane's height or reflow anything below it.

const PX_PER_SEC = 100;
const tack = (patch: Partial<TackView> = {}): TackView => ({
  id: "t1", session_id: null, connection_id: "c", client: "C", activity_id: "a", kind: "issue", label: "Pause", body: "",
  status: "open", range: { kind: "free", composition_id: ROOT_ID, t_us: 2_000_000, end_t_us: 3_000_000 }, created_at: "",
  composition_id: ROOT_ID, t_us: 2_000_000, end_t_us: 3_000_000, state: "visible", ...patch,
});
const marker: MarkerSummary = {
  id: "m1", t_us: 2_500_000, end_t_us: null, label: "Mark", note: "", color_hint: "#ff8800",
  anchor_layer: null, anchor_src_us: null, hibernating: false,
};

function seed(tacks: TackView[]) {
  useProjectStore.getState().apply(summaryFixture({ root: { markers: [marker], duration_us: 10_000_000 } }));
  useAgentActivity.setState({
    snapshot: { workspace_id: "w", revision: 1, session: null, sessions: [], activities: [], evicted: 0, lock_reason: null, checkpoints: [], tacks },
    ready: true, tab: "activity", selectedTack: null, reviewOverlay: true, expanded: {},
  });
}
const renderRow = () => render(<>
  <MarkerLaneHeader />
  <MarkerLane compositionId={null} pxPerSec={PX_PER_SEC} widthPx={1000} viewportWidthPx={1000} fpsNum={30} fpsDen={1} />
</>);
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const bands = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-testid="timeline-tack"]')];

beforeEach(() => {
  setTimelineScrollLeftPx(null, 0);
  useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, markers_visible: true } as AppSettings }));
});
afterEach(cleanup);

describe("Review overlay tack band", () => {
  it("paints open tacks inside the lane, behind the markers", () => {
    seed([tack(), tack({ id: "done", status: "resolved" }), tack({ id: "asleep", state: "hibernating", t_us: null, end_t_us: null })]);
    const { container } = renderRow();
    expect(bands(container).map((b) => [b.dataset.tackId, b.style.left, b.style.width])).toEqual([["t1", "200px", "100px"]]);
    const tackLayer = q(container, "timeline-tack-layer")!;
    const markerLayer = q(container, "timeline-marker-layer")!;
    expect(tackLayer.parentElement).toBe(q(container, "timeline-marker-lane"));
    // Earlier sibling = lower in the stacking order: the marker glyph stays on top.
    expect(tackLayer.compareDocumentPosition(markerLayer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("toggling the overlay never changes the lane's or its header's height", () => {
    seed([tack()]);
    const { container } = renderRow();
    const laneHeight = `${UI_METRICS.timeline.marker.laneHeight}px`;
    const heights = () => [q(container, "timeline-marker-lane")!.style.height, q(container, "timeline-marker-lane-header")!.style.height];
    const children = () => container.childElementCount;
    expect(heights()).toEqual([laneHeight, laneHeight]);
    const before = children();
    const toggle = q(container, "timeline-review-overlay-toggle")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(useAgentActivity.getState().reviewOverlay).toBe(false);
    expect(bands(container)).toHaveLength(0);
    expect(heights()).toEqual([laneHeight, laneHeight]);
    expect(children()).toBe(before);
    fireEvent.click(toggle);
    expect(bands(container)).toHaveLength(1);
    expect(heights()).toEqual([laneHeight, laneHeight]);
  });

  it("offers the toggle only while there is review material", () => {
    seed([]);
    const { container } = renderRow();
    expect(q(container, "timeline-review-overlay-toggle")).toBeNull();
    act(() => useAgentActivity.setState((s) => ({ snapshot: { ...s.snapshot!, revision: 2, tacks: [tack()] } })));
    expect(q(container, "timeline-review-overlay-toggle")).not.toBeNull();
  });

  it("a band click selects the tack in the panel's Tacks tab", () => {
    seed([tack()]);
    const { container } = renderRow();
    fireEvent.click(bands(container)[0]!);
    expect(useAgentActivity.getState()).toMatchObject({ tab: "tacks", selectedTack: "t1" });
    expect(bands(container)[0]!.dataset.selected).toBe("true");
  });
});
