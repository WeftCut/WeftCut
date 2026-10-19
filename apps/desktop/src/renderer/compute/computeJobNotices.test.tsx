// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TFunction } from "i18next";
import i18n from "../i18n";

const mocks = vi.hoisted(() => ({ cancelComputeJob: vi.fn<(id: string) => Promise<boolean>>() }));
vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  cancelComputeJob: mocks.cancelComputeJob,
}));

import type { ComputeJob, ComputeJobEnded, ComputeOutcome } from "../ipc";
import { receiveComputeJobs } from "./computeJobsStore";
import {
  NOTICE_MIN_RUN_MS,
  cancelComputeJobHere,
  computeJobNotice,
  dismissComputeJobNotice,
  useComputeJobNoticeStore,
  wasCancelledHere,
  wireComputeJobNotices,
} from "./computeJobNotices";
import { ComputeJobNotice, NOTICE_VISIBLE_MS } from "./ComputeJobNotice";
import { useProjectStore } from "../state/projectStore";

const T0 = Date.parse("2026-10-19T10:00:00Z");
const t = i18n.t.bind(i18n) as TFunction;

let seq = 0;
const job = (over: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: `job-${++seq}`,
  tool: "transcribe_clip",
  layer_id: "gone",
  media_id: "m1",
  window: { t_start_us: 0, t_end_us: 1 },
  phase: { kind: "inferring" },
  phase_since: new Date(T0).toISOString(),
  started_at: new Date(T0).toISOString(),
  origin: { kind: "user" },
  callers: 1,
  caller_disconnected: false,
  request_ids: ["r1"],
  ...over,
});
const ended = (j: ComputeJob, outcome: ComputeOutcome, ranMs: number, error: string | null = null): ComputeJobEnded => ({
  job: j,
  outcome,
  error,
  ended_at: new Date(Date.parse(j.started_at) + ranMs).toISOString(),
});

let revision = 7_000_000;
const end = (...entries: ComputeJobEnded[]) =>
  act(() => receiveComputeJobs({ revision: ++revision, jobs: [], ended: entries }));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.cancelComputeJob.mockReset().mockResolvedValue(true);
  useComputeJobNoticeStore.setState({ notice: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("computeJobNotice", () => {
  const ctx = { clip: "Interview", cancelledHere: false };

  it("announces a person's job that ran past the threshold, and not one under it", () => {
    expect(computeJobNotice(t, ended(job(), "ok", NOTICE_MIN_RUN_MS), ctx)).toMatchObject({
      outcome: "ok",
      title: "Transcription finished",
      body: "“Interview” is transcribed.",
    });
    expect(computeJobNotice(t, ended(job(), "ok", NOTICE_MIN_RUN_MS - 1), ctx)).toBeNull();
  });

  it("says why a job failed, by tool", () => {
    expect(computeJobNotice(t, ended(job({ tool: "describe_clip" }), "error", 60_000, "no model"), ctx)).toMatchObject({
      title: "Description failed",
      body: "Describing “Interview” failed: no model",
    });
  });

  it("summarizes a resource refusal instead of the native sentence, and offers Performance settings", () => {
    const raw = "audio extract: resource-capacity-exceeded: Waited 60 s before extracting clip audio: memory is under pressure. Close other work or wait for memory to recover, then retry";
    const notice = computeJobNotice(t, ended(job(), "error", 60_000, raw), ctx)!;
    expect(notice.body).toContain("short of memory");
    expect(notice.body).not.toContain("resource-capacity-exceeded");
    expect(notice.settings).toBe(true);
    // Any other failure keeps its own sentence and offers nothing.
    expect(computeJobNotice(t, ended(job(), "error", 60_000, "no model"), ctx)!.settings).toBeUndefined();
  });

  it("announces a cancel someone else made, but not one pressed in this window", () => {
    const j = job();
    expect(computeJobNotice(t, ended(j, "cancelled", 60_000), ctx)).toMatchObject({
      title: "Transcription cancelled",
      body: "Transcribing “Interview” was cancelled.",
    });
    expect(computeJobNotice(t, ended(j, "cancelled", 60_000), { ...ctx, cancelledHere: true })).toBeNull();
  });

  it("leaves an agent-only job to its agent, but announces one a person's press joined", () => {
    const agent = { kind: "agent", client: "claude" } as const;
    expect(computeJobNotice(t, ended(job({ origin: agent, request_ids: [] }), "ok", 60_000), ctx)).toBeNull();
    expect(computeJobNotice(t, ended(job({ origin: agent, request_ids: ["r9"] }), "ok", 60_000), ctx)).not.toBeNull();
  });
});

describe("wireComputeJobNotices", () => {
  it("puts a long job's end in the in-app slot while focused, naming the clip as the rows do", () => {
    const before = ended(job(), "ok", 60_000);
    end(before);
    const stop = wireComputeJobNotices({ isFocused: () => true, notifyOs: vi.fn(), t });
    // Ended before wiring: never announced.
    expect(useComputeJobNoticeStore.getState().notice).toBeNull();
    const media = useProjectStore.getState().mediaById;
    useProjectStore.setState({ mediaById: new Map([["m1", { id: "m1", label: "reel.mp4" } as never]]) });
    const done = ended(job(), "ok", 45_000);
    end(done);
    expect(useComputeJobNoticeStore.getState().notice).toMatchObject({
      jobId: done.job.job_id,
      title: "Transcription finished",
      // The layer is gone, so the source's name.
      body: "“reel.mp4” is transcribed.",
    });
    // A layer the summary still has: its display name.
    const layers = useProjectStore.getState().layerById;
    useProjectStore.setState({
      layerById: new Map([["L1", { id: "L1", label: "Interview", kind: "VideoClip", params: { kind: "VideoClip", media_label: "reel.mp4" } } as never]]),
    });
    end(ended(job({ layer_id: "L1" }), "ok", 45_000));
    expect(useComputeJobNoticeStore.getState().notice?.body).toBe("“Interview” is transcribed.");
    useProjectStore.setState({ mediaById: media, layerById: layers });
    stop();
  });

  it("posts an OS notification instead while the window is unfocused", () => {
    const notifyOs = vi.fn();
    const stop = wireComputeJobNotices({ isFocused: () => false, notifyOs, t });
    end(ended(job({ tool: "describe_clip" }), "error", 30_000, "engine crashed"));
    expect(notifyOs).toHaveBeenCalledWith({
      title: "Description failed",
      body: expect.stringContaining("failed: engine crashed"),
    });
    expect(useComputeJobNoticeStore.getState().notice).toBeNull();
    stop();
  });

  it("stays quiet for a short job and for a cancel pressed here", async () => {
    const notifyOs = vi.fn();
    const stop = wireComputeJobNotices({ isFocused: () => false, notifyOs, t });
    end(ended(job(), "ok", 5_000));
    const mine = job();
    await cancelComputeJobHere(mine.job_id);
    expect(mocks.cancelComputeJob).toHaveBeenCalledWith(mine.job_id);
    expect(wasCancelledHere(mine.job_id)).toBe(true);
    end(ended(mine, "cancelled", 90_000));
    expect(notifyOs).not.toHaveBeenCalled();
    // Decided once: the mark goes with the job.
    expect(wasCancelledHere(mine.job_id)).toBe(false);
    stop();
  });

  it("forgets a press whose job had already ended, so its end is still announced", async () => {
    mocks.cancelComputeJob.mockResolvedValue(false);
    const j = job();
    await cancelComputeJobHere(j.job_id);
    expect(wasCancelledHere(j.job_id)).toBe(false);
  });
});

describe("ComputeJobNotice", () => {
  const show = (outcome: ComputeOutcome) =>
    act(() => useComputeJobNoticeStore.setState({ notice: { jobId: "j", outcome, title: "Transcription finished", body: "“A” is transcribed." } }));

  it("shows the latest notice and goes by itself", () => {
    vi.useFakeTimers();
    render(<ComputeJobNotice />);
    expect(screen.queryByTestId("compute-notice")).toBeNull();
    show("ok");
    expect(screen.getByRole("status").textContent).toContain("“A” is transcribed.");
    act(() => vi.advanceTimersByTime(NOTICE_VISIBLE_MS));
    expect(screen.queryByTestId("compute-notice")).toBeNull();
  });

  it("keeps a failure until dismissed", () => {
    vi.useFakeTimers();
    render(<ComputeJobNotice />);
    show("error");
    act(() => vi.advanceTimersByTime(NOTICE_VISIBLE_MS * 3));
    expect(screen.getByTestId("compute-notice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("compute-notice")).toBeNull();
  });

  it("dismisses only the notice it names", () => {
    show("ok");
    dismissComputeJobNotice("other");
    expect(useComputeJobNoticeStore.getState().notice).not.toBeNull();
    dismissComputeJobNotice("j");
    expect(useComputeJobNoticeStore.getState().notice).toBeNull();
  });
});
