// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "../i18n";
import type { ComputeJob, ComputeOrigin, ComputePhase } from "../ipc";
import type { AgentActivity } from "../../shared/agent-activity";
import { StatusBar } from "./StatusBar";
import type { Change } from "../../shared/review";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
// No backend under jsdom: IPC answers nothing (the review fetch keeps its last
// view; a command's log row goes nowhere).
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); });

it("shows the unreviewed change count while there is one; a click opens the agent panel's Changes tab", async () => {
  const { useReview, resetReviewForTests } = await import("../agent/reviewStore");
  const { useAgentActivity } = await import("../agent/activityStore");
  const { registerCommandProvider } = await import("../commands/registry");
  resetReviewForTests();
  const open = vi.fn();
  const unregister = registerCommandProvider(() => [{ id: "openAgentPanel", run: open } as never]);
  useAgentActivity.setState({ tab: "activity" });
  const { container } = render(<StatusBar />);
  await act(async () => {});
  expect(container.querySelector('[data-testid="status-bar-review"]')).toBeNull();
  const change = (id: `Layer:${string}`): Change => ({ id, class: "added", details: [], composition_id: "r", ranges: [] });
  act(() => { useReview.getState().apply({ version: { session: 1, revision: 1, baseline_revision: 1 }, content_revision: 1, has_baseline: true, unreviewed: [change("Layer:a"), change("Layer:b")], user: [], user_count: 0, decorations: [] }); });
  const badge = container.querySelector<HTMLElement>('[data-testid="status-bar-review"]')!;
  expect(badge.textContent).toBe("2 to review");
  act(() => badge.click());
  expect(useAgentActivity.getState().tab).toBe("changes");
  expect(open).toHaveBeenCalledTimes(1);
  act(() => { useReview.getState().apply({ version: { session: 1, revision: 1, baseline_revision: 2 }, content_revision: 1, has_baseline: true, unreviewed: [], user: [], user_count: 0, decorations: [] }); });
  expect(container.querySelector('[data-testid="status-bar-review"]')).toBeNull();
  unregister();
  resetReviewForTests();
});

describe("work pill", () => {
  let revision = 2_000_000;
  const LONG_AGO = new Date(Date.now() - 70_000).toISOString();
  const jobFixture = (id: string, phase: ComputePhase, origin: ComputeOrigin = { kind: "user" }): ComputeJob => ({
    job_id: id, tool: "transcribe_clip", layer_id: `layer-${id}`, media_id: "m", window: { t_start_us: 0, t_end_us: 1 },
    phase, phase_since: LONG_AGO, started_at: LONG_AGO, origin, callers: 1, caller_disconnected: false, request_ids: [],
  });
  const agentCall = (id: string, jobId?: string): AgentActivity => ({
    id, session_id: null, connection_id: null, client: "Claude", tool: "split_layers", kind: "operation",
    started_at: LONG_AGO, ended_at: null, state: "running", duration_ms: null, message: "split_layers",
    affected: [], entity_labels: [], history_ids: [], effect: null, args: {}, error: null,
    ...(jobId ? { compute: { job_id: jobId, phase: { kind: "loading_model" as const }, phase_since: LONG_AGO } } : {}),
  });
  const publish = async (jobs: ComputeJob[]) => {
    const { receiveComputeJobs } = await import("../compute/computeJobsStore");
    act(() => receiveComputeJobs({ revision: ++revision, jobs }));
  };
  const setCalls = async (activities: AgentActivity[]) => {
    const { useAgentActivity } = await import("../agent/activityStore");
    act(() => useAgentActivity.setState({ snapshot: { activities } as never }));
  };
  const startDerivative = async (media_id: string, kind: string) => {
    const { derivativeJobStarted } = await import("../state/derivativeJobsStore");
    act(() => derivativeJobStarted({ media_id, kind }, Date.now() - 70_000));
  };
  const pill = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-testid="status-bar-work"]');
  afterEach(async () => {
    await publish([]);
    await setCalls([]);
    const { resetDerivativeJobsForTests } = await import("../state/derivativeJobsStore");
    resetDerivativeJobsForTests();
  });

  it("is absent with nothing running, names one piece of work, and counts several", async () => {
    const { container } = render(<StatusBar />);
    await act(async () => {});
    expect(pill(container)).toBeNull();
    await publish([jobFixture("a", { kind: "inferring", done: 30, total: 100 })]);
    expect(pill(container)!.textContent).toBe("Transcribing");
    expect(pill(container)!.dataset.state).toBe("working");
    expect(pill(container)!.querySelector(".status-bar-spinner")).not.toBeNull();
    await startDerivative("media-1", "proxy");
    await setCalls([agentCall("call-1")]);
    expect(pill(container)!.textContent).toBe("3 in progress");
  });

  it("shows an hourglass, not the spinner, while every piece of work waits", async () => {
    const { container } = render(<StatusBar />);
    await act(async () => {});
    await publish([jobFixture("a", { kind: "queued", reason: "budget" }), jobFixture("bb", { kind: "queued", reason: "memory" })]);
    expect(pill(container)!.dataset.state).toBe("waiting");
    expect(pill(container)!.textContent).toBe("2 waiting");
    expect(pill(container)!.querySelector(".lucide-hourglass")).not.toBeNull();
    expect(pill(container)!.querySelector(".status-bar-spinner")).toBeNull();
  });

  it("counts an agent call running a clip job once, as that job tagged with the agent", async () => {
    const { container } = render(<StatusBar />);
    await act(async () => {});
    await publish([jobFixture("j1", { kind: "loading_model" }, { kind: "agent", client: "Claude" })]);
    await setCalls([agentCall("call-1", "j1")]);
    expect(pill(container)!.textContent).toBe("Transcribing");
    act(() => pill(container)!.click());
    const details = container.querySelector<HTMLElement>(".work-pill-details")!;
    expect(details.querySelectorAll('[data-work="compute"]')).toHaveLength(1);
    expect(details.querySelectorAll('[data-work="agent"]')).toHaveLength(0);
    expect(details.querySelector(".work-row-client")!.textContent).toBe("Claude");
  });

  it("opens its details grouped by owner, with Cancel on a clip job; Escape closes them", async () => {
    const { container } = render(<StatusBar />);
    await act(async () => {});
    await publish([jobFixture("a", { kind: "inferring", done: 1, total: 2 })]);
    await setCalls([agentCall("call-1")]);
    await startDerivative("media-1", "proxy");
    await startDerivative("media-1", "quick_proxy");
    await startDerivative("media-1", "waveform");
    const trigger = pill(container)!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const details = container.querySelector<HTMLElement>(".work-pill-details")!;
    expect([...details.querySelectorAll(".work-group-header > span:first-child")].map((h) => h.textContent))
      .toEqual(["Clip jobs", "Agent", "Derivatives"]);
    expect(details.querySelector('[data-work="compute"] .compute-job-cancel')).not.toBeNull();
    expect(details.querySelector('[data-work="agent"] .work-row-name')!.textContent).toBe("Claude · split_layers");
    // Both proxy variants read as one kind.
    expect(details.querySelector('[data-work="derivatives"] .work-row-detail')!.textContent).toBe("Proxy · Waveform");
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(container.querySelector(".work-pill-details")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens the agent panel's Activity tab from the agent group, closing the details", async () => {
    const { useAgentActivity } = await import("../agent/activityStore");
    const { registerCommandProvider } = await import("../commands/registry");
    const open = vi.fn();
    const unregister = registerCommandProvider(() => [{ id: "openAgentPanel", run: open } as never]);
    useAgentActivity.setState({ tab: "changes" });
    const { container } = render(<StatusBar />);
    await act(async () => {});
    await setCalls([agentCall("call-1")]);
    act(() => pill(container)!.click());
    act(() => container.querySelector<HTMLElement>(".work-group-link")!.click());
    expect(useAgentActivity.getState().tab).toBe("activity");
    expect(open).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".work-pill-details")).toBeNull();
    unregister();
  });

  it("closes its details with the last piece of work", async () => {
    const { container } = render(<StatusBar />);
    await act(async () => {});
    await publish([jobFixture("a", { kind: "inferring", done: 1, total: 2 })]);
    act(() => pill(container)!.click());
    expect(container.querySelector(".work-pill-details")).not.toBeNull();
    await publish([]);
    expect(pill(container)).toBeNull();
    await publish([jobFixture("b", { kind: "inferring", done: 1, total: 2 })]);
    expect(container.querySelector(".work-pill-details")).toBeNull();
  });

  it("carries the derivative count on the bar at once, ahead of the pill's show delay", async () => {
    const { derivativeJobStarted } = await import("../state/derivativeJobsStore");
    const { container } = render(<StatusBar />);
    await act(async () => {});
    act(() => derivativeJobStarted({ media_id: "fresh", kind: "thumbnails" }));
    expect(container.querySelector(".status-bar")!.getAttribute("data-derivative-jobs")).toBe("1");
    expect(pill(container)).toBeNull();
  });
});

describe("not-saved badge", () => {
  let revision = 0;
  const failing = (code: string | null, last_saved_at: string | null = null) => ({
    state: "failing" as const, revision: ++revision, since: "2026-01-02T03:04:05.000Z", last_saved_at,
    code, path: "/home/u/Demo/project.json", dir: "/home/u/Demo",
  });
  afterEach(async () => {
    const { useSaveStatusStore } = await import("../state/saveStatusStore");
    useSaveStatusStore.setState({ status: { state: "ok", revision: 0 } });
    revision = 0;
  });

  it("shows only while saving fails, says why in its tooltip, opens the System panel, and is announced once", async () => {
    const { receiveSaveStatus } = await import("../state/saveStatusStore");
    const onOpenSaveStatus = vi.fn();
    const { container } = render(<StatusBar onOpenSaveStatus={onOpenSaveStatus} />);
    await act(async () => {});
    const badge = () => container.querySelector<HTMLElement>('[data-testid="save-status-badge"]');
    const announced = () => container.querySelector('[aria-live="polite"]')!.textContent;
    expect(badge()).toBeNull();

    act(() => receiveSaveStatus(failing("ENOSPC")));
    expect(badge()!.textContent).toBe("Not saved");
    expect(badge()!.closest(".status-bar-right")).not.toBeNull();
    expect(badge()!.title).toBe("The disk is full.\nNot saved since the project was opened");
    expect(announced()).toBe("Project not saved: The disk is full.");
    act(() => badge()!.click());
    expect(onOpenSaveStatus).toHaveBeenCalledTimes(1);

    // A new reason updates the tooltip but is not a second announcement.
    act(() => receiveSaveStatus(failing("EROFS", "2026-01-02T03:00:00.000Z")));
    expect(badge()!.title).toMatch(/^The project folder is on a read-only drive\.\nLast saved at /);
    expect(announced()).toBe("Project not saved: The disk is full.");

    act(() => receiveSaveStatus({ state: "ok", revision: ++revision }));
    expect(badge()).toBeNull();
    act(() => receiveSaveStatus(failing("EACCES")));
    expect(announced()).toBe("Project not saved: WeftCut is not allowed to write to the project folder.");
  });
});

describe("attention counts", () => {
  afterEach(async () => {
    const { useLogStore } = await import("./store");
    useLogStore.setState({ errorCount: 0 });
  });

  it("carries the error count on the Logs toggle, which opens the log, and drops it when the log has none", async () => {
    const { useLogStore } = await import("./store");
    const onToggleLogs = vi.fn();
    const { container } = render(<StatusBar onToggleLogs={onToggleLogs} />);
    await act(async () => {});
    const toggle = container.querySelector<HTMLElement>(".status-bar-logs-toggle")!;
    expect(container.querySelector('[data-testid="status-bar-errors"]')).toBeNull();
    expect(toggle.getAttribute("aria-label")).toBe("Show / hide activity log");

    act(() => useLogStore.setState({ errorCount: 3 }));
    const errors = container.querySelector<HTMLElement>('[data-testid="status-bar-errors"]')!;
    expect(errors.closest(".status-bar-logs-toggle")).toBe(toggle);
    expect(errors.textContent).toBe("3");
    expect(toggle.getAttribute("aria-label")).toBe("Show / hide activity log — 3 error(s)");
    act(() => toggle.click());
    expect(onToggleLogs).toHaveBeenCalledTimes(1);

    act(() => useLogStore.setState({ errorCount: 0 }));
    expect(container.querySelector('[data-testid="status-bar-errors"]')).toBeNull();
  });

  it("names system notices with the highest level's icon and their count", async () => {
    const onOpenSystemStatus = vi.fn();
    const { container } = render(
      <StatusBar
        notices={[{ level: "info", code: "native_decode_unavailable" }, { level: "warn", code: "keyring_unavailable" }]}
        onOpenSystemStatus={onOpenSystemStatus}
      />,
    );
    await act(async () => {});
    const trigger = container.querySelector<HTMLElement>(".system-status-trigger")!;
    expect(trigger.classList).toContain("system-status-warn");
    expect(trigger.textContent).toBe("System 2");
    expect(trigger.getAttribute("aria-label")).toBe("2 system status item(s) need attention");
    act(() => trigger.click());
    expect(onOpenSystemStatus).toHaveBeenCalledTimes(1);
  });
});
