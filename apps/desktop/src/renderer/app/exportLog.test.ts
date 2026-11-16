// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({ logEmit: vi.fn(() => Promise.resolve()) }));

import { logEmit } from "../ipc";
import type { LogEntryInput } from "../ipc";
import { createExportLogMirror } from "./exportLog";
import type { ExportJob } from "../../shared/exportJob";

const rows = (): LogEntryInput[] =>
  vi.mocked(logEmit).mock.calls.map((c) => c[0]);

const CTX = { output: "C:/out/final.mp4", codec: "h264" };
const JOB = { job_id: "job-1", state: "preparing", output_path: CTX.output, settings: { codec: CTX.codec } } as ExportJob;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(logEmit).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createExportLogMirror", () => {
  it("slow run: Started at 250 ms, then Ok under the same op_id", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "starting", job: JOB });
    expect(logEmit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    m.observe({
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 2_000_000 },
    });

    const [started, ok] = rows();
    expect(started).toMatchObject({
      level: "info",
      category: { kind: "Export" },
      source: { kind: "User" },
      message: `Exporting ${CTX.output}`,
      op_state: { state: "Started" },
    });
    expect(ok).toMatchObject({
      level: "info",
      message: `Exported ${CTX.output}`,
      op_state: { state: "Ok" },
      details: { duration_us: 2_000_000 },
    });
    expect(ok!.op_id).toBe(started!.op_id);
    expect(rows()).toHaveLength(2);
  });

  it("fast failure: one Error row, no op_id, no late Started", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "starting", job: JOB });
    m.observe({ kind: "error", detail: "boom" });
    vi.advanceTimersByTime(1000);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      level: "error",
      message: "Export failed: boom",
      details: { output: CTX.output, error: "boom" },
    });
    expect(rows()[0]!.op_id).toBeUndefined();
  });

  it("refused before it began (idle → error) logs one standalone Error row", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "error", detail: "no video material" });
    vi.advanceTimersByTime(1000);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      level: "error",
      message: "Export failed: no video material",
    });
    expect(rows()[0]!.op_id).toBeUndefined();
  });

  it("cancel (running → null) closes a Started op as Ok", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "preparing", labels: ["clip"], job: JOB });
    vi.advanceTimersByTime(250);
    m.observe(null);

    const [started, cancelled] = rows();
    expect(started).toMatchObject({ op_state: { state: "Started" } });
    expect(cancelled).toMatchObject({
      level: "info",
      message: "Export cancelled",
      op_state: { state: "Ok" },
    });
    expect(cancelled!.op_id).toBe(started!.op_id);
  });

  // Main announces a job before it names its file, and before the renderer
  // runs it; a run never borrows the file of the run before it.
  it("names each run's own file, learned after its first state", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "starting", job: JOB });
    m.observe({ kind: "complete", payload: { outputPath: CTX.output, durationUs: 1 } });
    vi.mocked(logEmit).mockClear();
    const next = { ...JOB, job_id: "job-2", output_path: "" } as ExportJob;
    m.job(next);
    m.observe({ kind: "starting", job: next });
    m.job({ ...next, output_path: "C:/out/second.mp4" });
    vi.advanceTimersByTime(250);
    m.observe(null);
    expect(rows().map((r) => r.details)).toEqual([
      { output: "C:/out/second.mp4", codec: "h264" },
      { output: "C:/out/second.mp4" },
    ]);
  });

  it.each([
    [{ kind: "user" }, { kind: "User" }],
    [{ kind: "agent", client: "Claude" }, { kind: "Agent", client: "Claude" }],
    [{ kind: "app" }, { kind: "System" }],
  ] as const)("a cancel row's source is who cancelled: %o", (by, source) => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "preparing", labels: ["clip"], job: JOB });
    vi.advanceTimersByTime(250);
    m.job({ ...JOB, phase: "cancelling", cancelled_by: by });
    m.observe(null);
    const cancelled = rows().at(-1)!;
    expect(cancelled).toMatchObject({ i18n_key: "log.export_cancelled", source, details: { output: CTX.output, cancelled_by: by } });
  });

  // The failure that left the job awaiting retry closed its op; discarding it
  // is the job's end, and the log says so, once, standing alone.
  it.each([
    [{ kind: "user" }, { kind: "User" }],
    [{ kind: "agent", client: "Claude" }, { kind: "Agent", client: "Claude" }],
  ] as const)("a discarded retry logs one cancel row by its canceller: %o", (by, source) => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "finalizing", step: "mux", job: JOB });
    vi.advanceTimersByTime(250);
    m.observe({ kind: "error", detail: "disk full", job: JOB });
    const awaiting = { ...JOB, state: "awaiting_retry" } as ExportJob;
    m.job(awaiting);
    m.job({ ...awaiting, phase: "cancelling", cancelled_by: by });
    m.observe(null);
    m.job({ ...awaiting, state: "cancelled", phase: "cancelled", cancelled_by: by });
    m.job({ ...awaiting, state: "cancelled", phase: "cancelled", cancelled_by: by });
    const failed = rows().find((r) => r.i18n_key === "log.export_failed")!;
    const cancelled = rows().filter((r) => r.i18n_key === "log.export_cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ source, details: { output: CTX.output, cancelled_by: by } });
    expect(cancelled[0]!.op_id).toBeUndefined();
    expect(failed.op_state).toEqual({ state: "Err" });
  });

  it("a cancel the run observes is logged once, not again when main confirms it", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "finalizing", step: "mux", job: JOB });
    m.observe({ kind: "error", detail: "disk full", job: JOB });
    const awaiting = { ...JOB, state: "awaiting_retry" } as ExportJob;
    m.job(awaiting);
    // Retried, then cancelled while the retry runs: the retry's run owns it.
    const retrying = { ...JOB, state: "finalizing" } as ExportJob;
    m.job(retrying);
    m.observe({ kind: "finalizing", step: "mux", job: retrying });
    m.job({ ...retrying, phase: "cancelling", cancelled_by: { kind: "user" } });
    m.observe(null);
    m.job({ ...retrying, state: "cancelled", cancelled_by: { kind: "user" } });
    expect(rows().filter((r) => r.i18n_key === "log.export_cancelled")).toHaveLength(1);
  });

  it("progress: flushes Started, then one row per tenth, never per update", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "starting", job: JOB });
    const at = (progress: number) =>
      m.observe({
        kind: "progress",
        progress: { progress, currentTimeUs: 0, frame: 0, fps: 0, speed: 0 },
      });

    at(0.01); // flushes Started (before the 250 ms timer) + step 0
    at(0.05); // same tenth — silent
    at(0.12); // step 1
    at(0.13); // same tenth — silent
    m.observe({
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 1 },
    });

    const states = rows().map((r) => r.op_state?.state);
    expect(states).toEqual(["Started", "Progress", "Progress", "Ok"]);
    // Every row of one run shares the op.
    expect(new Set(rows().map((r) => r.op_id)).size).toBe(1);
  });

  it("dismissing a terminal panel (terminal → null) emits nothing", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    m.observe({ kind: "starting", job: JOB });
    m.observe({
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 1 },
    });
    vi.mocked(logEmit).mockClear();
    m.observe(null);
    vi.advanceTimersByTime(1000);
    expect(logEmit).not.toHaveBeenCalled();
  });

  it("re-observing the same state reference is a no-op (StrictMode re-run)", () => {
    const m = createExportLogMirror();
    m.job(JOB);
    const state = {
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 1 },
    } as const;
    m.observe({ kind: "starting", job: JOB });
    m.observe(state);
    const count = rows().length;
    m.observe(state);
    expect(rows()).toHaveLength(count);
  });
});
