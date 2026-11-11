// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "../i18n";
import { MEDIA_JOB_EVENTS, type ComputeJob, type ComputeOrigin, type ComputePhase, type MediaJobEvent } from "../ipc";
import { StatusBar } from "./StatusBar";
import type { Change } from "../../shared/review";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: MediaJobEvent }) => void>());
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (name, handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
// No backend under jsdom: IPC answers nothing (the review fetch keeps its last
// view; a command's log row goes nowhere).
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); handlers.clear(); });

it("cached completions do not hide another media item's running generation", async () => {
  const { container } = render(<StatusBar />);
  await act(async () => {});
  const emit = (name: string, payload: MediaJobEvent) => act(() => handlers.get(name)!({ payload }));
  const active = { media_id: "generating-audio", kind: "waveform" };
  emit(MEDIA_JOB_EVENTS.started, active);
  emit(MEDIA_JOB_EVENTS.complete, { media_id: "cached-audio", kind: "conform" });
  expect(container.querySelector(".derivatives-pill")?.textContent).toContain("1");
  emit(MEDIA_JOB_EVENTS.complete, active);
  expect(container.querySelector(".derivatives-pill")).toBeNull();
});

it("duplicate starts and terminal events cannot leave a phantom derivative", async () => {
  const { container } = render(<StatusBar />);
  await act(async () => {});
  const payload = { media_id: "source", kind: "thumbnails" };
  act(() => {
    handlers.get(MEDIA_JOB_EVENTS.started)!({ payload });
    handlers.get(MEDIA_JOB_EVENTS.started)!({ payload });
    handlers.get(MEDIA_JOB_EVENTS.error)!({ payload });
  });
  expect(container.querySelector(".derivatives-pill")).toBeNull();
});

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

describe("clip-compute pill", () => {
  let revision = 2_000_000;
  const jobFixture = (id: string, phase: ComputePhase, origin: ComputeOrigin = { kind: "user" }): ComputeJob => ({
    job_id: id, tool: "transcribe_clip", layer_id: `layer-${id}`, media_id: "m", window: { t_start_us: 0, t_end_us: 1 },
    phase, phase_since: new Date(Date.now() - 70_000).toISOString(), started_at: `2026-10-18T00:00:0${id.length}Z`,
    origin, callers: 1, caller_disconnected: false, request_ids: [],
  });
  const publish = async (jobs: ComputeJob[]) => {
    const { receiveComputeJobs } = await import("../compute/computeJobsStore");
    act(() => receiveComputeJobs({ revision: ++revision, jobs }));
  };
  afterEach(async () => { await publish([]); });

  it("shows an hourglass while every job waits, lists each job's reason, and links a budget wait to the derivatives pill", async () => {
    const { container } = render(<StatusBar />);
    await act(async () => {});
    expect(container.querySelector('[data-testid="status-bar-compute"]')).toBeNull();
    act(() => handlers.get(MEDIA_JOB_EVENTS.started)!({ payload: { media_id: "long", kind: "proxy" } }));
    expect(container.querySelector<HTMLElement>(".derivatives-pill")!.title).not.toContain("waiting for these");
    await publish([jobFixture("a", { kind: "queued", reason: "budget" }), jobFixture("bb", { kind: "queued", reason: "memory" })]);
    const pill = container.querySelector<HTMLElement>('[data-testid="status-bar-compute"]')!;
    expect(pill.dataset.state).toBe("waiting");
    expect(pill.textContent).toBe("2 clip jobs waiting");
    expect(pill.querySelector(".lucide-hourglass")).not.toBeNull();
    expect(pill.querySelector(".status-bar-spinner")).toBeNull();
    expect(pill.title).toContain("Transcribe: Waiting for processing capacity — background work such as proxy generation is using it · waiting 1m 10s");
    expect(pill.title).toContain("Transcribe: Waiting for memory to free up");
    expect(container.querySelector<HTMLElement>(".derivatives-pill")!.title).toContain("A transcription or description is waiting for these to finish.");
  });

  it("spins once any job works, names a single job by what it does, and opens the log for a person's job", async () => {
    const onToggleLogs = vi.fn();
    const { container } = render(<StatusBar onToggleLogs={onToggleLogs} />);
    await act(async () => {});
    await publish([jobFixture("a", { kind: "inferring", done: 30, total: 100 })]);
    const pill = container.querySelector<HTMLElement>('[data-testid="status-bar-compute"]')!;
    expect(pill.dataset.state).toBe("working");
    expect(pill.textContent).toBe("Transcribing");
    expect(pill.querySelector(".status-bar-spinner")).not.toBeNull();
    expect(pill.title).toContain("Transcribe: Transcribing 30%");
    act(() => pill.click());
    expect(onToggleLogs).toHaveBeenCalledTimes(1);
  });

  it("opens the agent panel's Activity tab when an agent's job is running", async () => {
    const { useAgentActivity } = await import("../agent/activityStore");
    const { registerCommandProvider } = await import("../commands/registry");
    const open = vi.fn();
    const unregister = registerCommandProvider(() => [{ id: "openAgentPanel", run: open } as never]);
    useAgentActivity.setState({ tab: "changes" });
    const { container } = render(<StatusBar />);
    await act(async () => {});
    await publish([jobFixture("a", { kind: "queued", reason: null }), jobFixture("bb", { kind: "loading_model" }, { kind: "agent", client: "claude" })]);
    const pill = container.querySelector<HTMLElement>('[data-testid="status-bar-compute"]')!;
    expect(pill.textContent).toBe("2 clip jobs");
    act(() => pill.click());
    expect(useAgentActivity.getState().tab).toBe("activity");
    expect(open).toHaveBeenCalledTimes(1);
    unregister();
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
