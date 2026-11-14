// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import type { ComputeJob, ComputeOrigin, ComputePhase } from "../ipc";
import type { AgentActivity } from "../../shared/agent-activity";
import type { ExportJob } from "../../shared/exportJob";
import type { ExportProgress, ExportState } from "../panels/ExportPanel";
import { formatComputeDuration } from "../compute/computeJobView";
import { WorkPill } from "./WorkPill";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

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
  cleanup();
  vi.useRealTimers();
  await publish([]);
  await setCalls([]);
  const { resetDerivativeJobsForTests } = await import("../state/derivativeJobsStore");
  resetDerivativeJobsForTests();
});

describe("work pill", () => {
  it("is absent with nothing running, names one piece of work, and counts several", async () => {
    const { container } = render(<WorkPill />);
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
    const { container } = render(<WorkPill />);
    await act(async () => {});
    await publish([jobFixture("a", { kind: "queued", reason: "budget" }), jobFixture("bb", { kind: "queued", reason: "memory" })]);
    expect(pill(container)!.dataset.state).toBe("waiting");
    expect(pill(container)!.textContent).toBe("2 waiting");
    expect(pill(container)!.querySelector(".lucide-hourglass")).not.toBeNull();
    expect(pill(container)!.querySelector(".status-bar-spinner")).toBeNull();
  });

  it("counts an agent call running a clip job once, as that job tagged with the agent", async () => {
    const { container } = render(<WorkPill />);
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
    const { container } = render(<WorkPill />);
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
    const { container } = render(<WorkPill />);
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
    const { container } = render(<WorkPill />);
    await act(async () => {});
    await publish([jobFixture("a", { kind: "inferring", done: 1, total: 2 })]);
    act(() => pill(container)!.click());
    expect(container.querySelector(".work-pill-details")).not.toBeNull();
    await publish([]);
    expect(pill(container)).toBeNull();
    await publish([jobFixture("b", { kind: "inferring", done: 1, total: 2 })]);
    expect(container.querySelector(".work-pill-details")).toBeNull();
  });
});

describe("background export in the work pill", () => {
  const JOB = { job_id: "j1", filename: "final.mp4", output_path: "/home/u/Videos/final.mp4" } as ExportJob;
  const encoding = (progress: number, opts: { onCancel?: () => void; job?: ExportJob } = {}): ExportState => ({
    kind: "progress",
    background: true,
    job: opts.job ?? JOB,
    progress: { progress, currentTimeUs: 0, frame: 90, fps: 30, speed: 1 } satisfies ExportProgress,
    ...(opts.onCancel ? { onCancel: opts.onCancel } : {}),
  });
  const exportRegion = () => screen.queryByRole("group", { name: "Export" });

  it("shows the percent in a ring at once, with no dialog, leaving the editor usable", async () => {
    const onPlay = vi.fn();
    render(
      <>
        <button onClick={onPlay}>Play timeline</button>
        <WorkPill backgroundExport={encoding(0.5)} />
      </>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Encoding" }).getAttribute("aria-valuenow")).toBe("50");
    // The ring's value does not leak into the pill's name.
    expect(screen.getByRole("button", { name: "Export 50%" })).toBe(screen.getByTestId("status-bar-work"));
    fireEvent.click(screen.getByRole("button", { name: "Play timeline" }));
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it("spins without a value before frames encode", () => {
    render(<WorkPill backgroundExport={{ kind: "starting", background: true }} />);
    const ring = screen.getByRole("progressbar", { name: "Starting export…" });
    expect(ring.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("leads the label and counts the other work after it", async () => {
    render(<WorkPill backgroundExport={encoding(0.42)} />);
    await publish([jobFixture("a", { kind: "queued", reason: "budget" }), jobFixture("b", { kind: "queued", reason: "memory" })]);
    const trigger = screen.getByTestId("status-bar-work");
    expect(trigger.textContent).toBe("Export 42% · +2");
    // A running export is work, not a wait, while everything else queues.
    expect(trigger.dataset.state).toBe("working");
    expect(trigger.querySelector(".lucide-hourglass")).toBeNull();
  });

  it("puts the export group first in the details, and Cancel is only reachable there", async () => {
    const onCancel = vi.fn();
    render(<WorkPill backgroundExport={encoding(0.5, { onCancel })} />);
    await publish([jobFixture("a", { kind: "inferring", done: 1, total: 2 })]);
    expect(screen.queryByRole("button", { name: "Cancel export" })).toBeNull();

    fireEvent.click(screen.getByTestId("status-bar-work"));
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Export", "Clip jobs"]);
    const details = exportRegion()!;
    expect(details.textContent).toContain("final.mp4");
    // The trigger right below says "Export" and the percent; the group repeats neither.
    expect(details.querySelector(".work-group-header")).toBeNull();
    expect(details.textContent).not.toContain("50%");
    expect(details.textContent).toContain("30 fps · 1.0×");
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("offers no cancel once the export is cancelling", () => {
    render(<WorkPill backgroundExport={encoding(0.5, { onCancel: vi.fn(), job: { ...JOB, phase: "cancelling" } })} />);
    fireEvent.click(screen.getByTestId("status-bar-work"));
    expect(exportRegion()!.textContent).toContain("Cancelling export…");
    expect(screen.queryByRole("button", { name: "Cancel export" })).toBeNull();
  });

  it("counts elapsed time from when the export appeared, not from when the details open, per job", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const elapsed = (ms: number) => i18n.t("export.pill_elapsed", { time: formatComputeDuration(i18n.t, ms) });
    const elapsedShown = () => exportRegion()!.querySelector(".work-row-elapsed")!.textContent;
    const { rerender } = render(<WorkPill backgroundExport={encoding(0.1)} />);
    act(() => { vi.advanceTimersByTime(65_000); });
    rerender(<WorkPill backgroundExport={encoding(0.2)} />);

    fireEvent.click(screen.getByTestId("status-bar-work"));
    expect(elapsedShown()).toBe(elapsed(65_000));
    // Closing and opening again keeps the clock.
    fireEvent.click(screen.getByTestId("status-bar-work"));
    fireEvent.click(screen.getByTestId("status-bar-work"));
    expect(elapsedShown()).toBe(elapsed(65_000));

    // A new export starts its own clock.
    rerender(<WorkPill backgroundExport={encoding(0.01, { job: { ...JOB, job_id: "j2" } })} />);
    expect(elapsedShown()).toBe(elapsed(0));
  });
});
