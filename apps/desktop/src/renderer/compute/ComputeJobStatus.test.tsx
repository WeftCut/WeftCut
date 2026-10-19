// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/bridge/ipc", () => ({ invoke: mocks.invoke }));

import { ComputeJobStatus } from "./ComputeJobStatus";
import { STALL_AFTER_MS, type ComputeJobSubject } from "./computeJobView";
import type { ComputePhase, ComputeTool } from "../ipc";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
function job(phase: ComputePhase, patch: Partial<ComputeJobSubject> & { tool?: ComputeTool } = {}): ComputeJobSubject {
  return { job_id: "job-1", tool: "describe_clip", phase, phase_since: ago(0), ...patch };
}
const status = () => document.querySelector<HTMLElement>(".compute-job-status")!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  await i18n.changeLanguage("en-US");
  mocks.invoke.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ComputeJobStatus — waiting", () => {
  it.each([
    [null, "Waiting to start"],
    ["memory", "Waiting for memory to free up"],
    ["finalization", "Waiting for an export to finish"],
    ["budget", "Waiting for processing capacity — background work such as proxy generation is using it"],
  ] as const)("a job queued on %s shows an hourglass and its reason, never the spinner", (reason, text) => {
    render(<ComputeJobStatus job={job({ kind: "queued", reason }, { phase_since: ago(65_000) })} />);
    expect(status().classList.contains("state-waiting")).toBe(true);
    expect(status().querySelector(".lucide-hourglass")).not.toBeNull();
    expect(status().querySelector(".compute-job-spin")).toBeNull();
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText("waiting 1m 5s")).toBeTruthy();
    // A wait is not a stall: it already says how long.
    expect(status().querySelector(".compute-job-stalled")).toBeNull();
  });

  it("counts the wait up on the shared clock", () => {
    render(<ComputeJobStatus job={job({ kind: "queued", reason: "memory" }, { phase_since: ago(0) })} />);
    expect(screen.queryByText(/^waiting/)).toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("waiting 3s")).toBeTruthy();
  });

  it("compact says it waits for resources and keeps the reason in its title", () => {
    render(<ComputeJobStatus variant="compact" job={job({ kind: "queued", reason: "budget" })} />);
    expect(screen.getByText("Waiting for resources")).toBeTruthy();
    expect(status().title).toContain("background work such as proxy generation");
  });
});

describe("ComputeJobStatus — working", () => {
  it.each([
    ["describe_clip", { kind: "extracting", done: 12, total: 25 }, "Sampling frames 12/25"],
    ["transcribe_clip", { kind: "extracting", done: 0, total: 1 }, "Extracting audio"],
    ["transcribe_clip", { kind: "normalizing" }, "Normalizing audio"],
    ["describe_clip", { kind: "loading_model" }, "Loading model"],
    ["transcribe_clip", { kind: "inferring", done: 42, total: 100 }, "Transcribing 42%"],
    ["transcribe_clip", { kind: "inferring" }, "Transcribing"],
    ["describe_clip", { kind: "inferring", done: 3, total: 8 }, "Describing 3/8"],
    ["describe_clip", { kind: "inferring" }, "Describing"],
    ["transcribe_clip", { kind: "applying" }, "Adding captions"],
  ] as const)("%s %j reads “%s” beside a spinner", (tool, phase, text) => {
    render(<ComputeJobStatus job={job(phase as ComputePhase, { tool })} />);
    expect(status().classList.contains("state-working")).toBe(true);
    expect(status().querySelector(".compute-job-spin")).not.toBeNull();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("says when a working phase has made no progress for longer than the stall threshold", () => {
    const { rerender } = render(<ComputeJobStatus job={job({ kind: "loading_model" }, { phase_since: ago(STALL_AFTER_MS - 2000) })} />);
    expect(status().querySelector(".compute-job-stalled")).toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(status().classList.contains("is-stalled")).toBe(true);
    expect(screen.getByText("No progress for 1m 31s")).toBeTruthy();
    // A count change moves phase_since: progress again.
    rerender(<ComputeJobStatus job={job({ kind: "loading_model" }, { phase_since: new Date(Date.now()).toISOString() })} />);
    expect(status().querySelector(".compute-job-stalled")).toBeNull();
  });

  it("badges a caller that disconnected", () => {
    render(<ComputeJobStatus variant="inline" job={job({ kind: "inferring" }, { caller_disconnected: true })} />);
    expect(screen.getByText("Caller disconnected — still running")).toBeTruthy();
  });

  it("can leave the leading icon to its host", () => {
    render(<ComputeJobStatus showIcon={false} job={job({ kind: "queued", reason: "memory" })} />);
    expect(status().querySelector(".compute-job-icon")).toBeNull();
  });
});

describe("ComputeJobStatus — cancel", () => {
  it("force-cancels the job through IPC and stays pending until the job goes", async () => {
    let answer!: (v: boolean) => void;
    mocks.invoke.mockImplementation(() => new Promise<boolean>((r) => { answer = r; }));
    render(<ComputeJobStatus job={job({ kind: "inferring" }, { tool: "transcribe_clip" })} />);
    const button = screen.getByRole("button", { name: "Cancel transcription" });
    fireEvent.click(button);
    expect(mocks.invoke).toHaveBeenCalledWith("compute_job_cancel", { job_id: "job-1" });
    expect(screen.getByRole("button", { name: "Cancelling…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { answer(true); });
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeTruthy();
  });

  it("comes back when the job had already ended", async () => {
    mocks.invoke.mockResolvedValue(false);
    render(<ComputeJobStatus job={job({ kind: "inferring" })} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel description" })); });
    expect(screen.getByRole("button", { name: "Cancel description" }).hasAttribute("disabled")).toBe(false);
  });

  it("says why a cancel failed and offers it again", async () => {
    const onCancel = vi.fn().mockRejectedValue(new Error("The app is shutting down"));
    render(<ComputeJobStatus job={job({ kind: "inferring" })} onCancel={onCancel} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel description" })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("The app is shutting down");
    expect(screen.getByRole("button", { name: "Cancel description" }).hasAttribute("disabled")).toBe(false);
  });

  it("compact keeps an icon-only button with an accessible name; hideCancel drops it", () => {
    const { rerender } = render(<ComputeJobStatus variant="compact" job={job({ kind: "inferring" })} />);
    const button = screen.getByRole("button", { name: "Cancel description" });
    expect(button.textContent).toBe("");
    rerender(<ComputeJobStatus variant="compact" hideCancel job={job({ kind: "inferring" })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ComputeJobStatus — Chinese", () => {
  it("words the phases in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<ComputeJobStatus job={job({ kind: "queued", reason: "memory" }, { phase_since: ago(130_000) })} />);
    expect(screen.getByText("等待内存释放")).toBeTruthy();
    expect(screen.getByText("已等待 2 分 10 秒")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消描述" })).toBeTruthy();
  });
});
