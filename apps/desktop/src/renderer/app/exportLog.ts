import { logEmit } from "../ipc";
import type { LogEntryInput } from "../ipc";
import type { ExportState } from "../panels/ExportPanel";
import type { ExportCanceller, ExportJob } from "../../shared/exportJob";

/// LogBus mirror for the export lifecycle — the log-row sibling of the
/// taskbar-progress and native-notification mirrors in `useExportFlow`. All
/// three observe `ExportState` transitions instead of instrumenting the
/// pipeline's ~two dozen `setExportState` sites, so every path (video,
/// audio-only, readiness aborts, future stages) is covered by construction.
/// The `ExportPanel` stays the live progress UI; these rows are the record.
///
/// Row shape is the house three-state (`runCommandWithLogging`): a run that
/// settles inside `STARTED_AFTER_MS` is one row with no `op_id`; a slower one
/// is `Started` + `Ok`/`Err` under one `op_id`. A cancel (running → null)
/// closes the op as `Ok`, not `Err` — same convention as the content-download
/// op in `src/main/index.ts` — with the canceller as the row's source.

/// House slow-op threshold. Keep equal to `runCommandWithLogging`'s — the
/// 250 ms line is one project-wide definition of "the user is waiting".
const STARTED_AFTER_MS = 250;

/// Progress rows land once per 1/PROGRESS_STEPS of the encode, not per frame
/// or per second: a multi-hour export must not spend the 1000-entry ring on
/// its own progress (each op state-change is one ring entry, however the UI
/// collapses them).
const PROGRESS_STEPS = 10;

interface RunningOp {
  id: string;
  /// The job this run is; its record names the output and the canceller.
  jobId: string | null;
  startedOut: boolean;
  timer: number;
  lastStep: number;
}

const CATEGORY = { kind: "Export" } as const;
const SOURCE = { kind: "User" } as const;

const cancelDetails = (output: string, by: ExportCanceller | undefined) =>
  ({ output, ...(by ? { cancelled_by: by } : {}) });

function cancelSource(by: ExportCanceller | undefined): LogEntryInput["source"] {
  if (by?.kind === "agent") return { kind: "Agent", client: by.client };
  if (by?.kind === "app") return { kind: "System" };
  return SOURCE;
}

export function createExportLogMirror(): {
  /// Feed every job record main publishes. Rows read the output and the
  /// canceller from it, by job id: the run's first state can precede the
  /// record that names its file.
  job(job: ExportJob): void;
  /// Feed every committed `exportState`. Re-observing the same reference is a
  /// no-op (StrictMode re-runs the effect with an unchanged state).
  observe(state: ExportState | null): void;
} {
  let latest: ExportJob | null = null;
  let last: ExportState | null = null;
  let op: RunningOp | null = null;

  const jobOf = (jobId: string | null | undefined) =>
    jobId && latest?.job_id === jobId ? latest : null;
  const outputOf = (run: RunningOp) => jobOf(run.jobId)?.output_path ?? "";

  const emitStarted = () => {
    if (!op || op.startedOut) return;
    op.startedOut = true;
    window.clearTimeout(op.timer);
    const output = outputOf(op);
    void logEmit({
      level: "info",
      category: CATEGORY,
      source: SOURCE,
      message: `Exporting ${output}`,
      i18n_key: "log.export_started",
      i18n_args: { path: output },
      op_id: op.id,
      op_state: { state: "Started" },
      details: { output, codec: jobOf(op.jobId)?.settings.codec ?? "" },
    });
  };

  const endOp = (
    level: "info" | "error",
    state: "Ok" | "Err",
    message: string,
    i18nKey: string,
    i18nArgs: Record<string, unknown>,
    details: Record<string, unknown>,
    source: LogEntryInput["source"] = SOURCE,
  ) => {
    if (!op) return;
    window.clearTimeout(op.timer);
    void logEmit({
      level,
      category: CATEGORY,
      source,
      message,
      i18n_key: i18nKey,
      i18n_args: i18nArgs,
      // Fast runs never got a Started, so the terminal row stands alone, with
      // no op to close (the house three-state above).
      ...(op.startedOut ? { op_id: op.id, op_state: { state } } : {}),
      details,
    });
    op = null;
  };

  return {
    job(job: ExportJob) {
      // Discarding a finalization that awaits retry ends the job with no run
      // left to observe: its op closed on the failure. The cancel stands alone,
      // never under that op, which would read as having ended Ok.
      const discarded = latest?.job_id === job.job_id && latest.state === "awaiting_retry"
        && job.state === "cancelled" && op?.jobId !== job.job_id;
      latest = job;
      if (discarded) {
        void logEmit({
          level: "info",
          category: CATEGORY,
          source: cancelSource(job.cancelled_by),
          message: "Export cancelled",
          i18n_key: "log.export_cancelled",
          i18n_args: {},
          details: cancelDetails(job.output_path, job.cancelled_by),
        });
      }
    },

    observe(state: ExportState | null) {
      if (state === last) return;
      last = state;
      const kind = state === null ? null : state.kind;
      const running =
        kind === "starting" ||
        kind === "preparing" ||
        kind === "progress" ||
        kind === "finalizing";

      if (running && !op) {
        op = {
          id: crypto.randomUUID(),
          jobId: state?.job?.job_id ?? null,
          startedOut: false,
          timer: window.setTimeout(emitStarted, STARTED_AFTER_MS),
          lastStep: -1,
        };
      }

      if (op) {
        op.jobId ??= state?.job?.job_id ?? null;
        if (state !== null && state.kind === "progress") {
          // Encode progress means the user is visibly waiting: flush the
          // Started row now so no Progress row can precede it.
          emitStarted();
          const step = Math.floor(state.progress.progress * PROGRESS_STEPS);
          if (step > op.lastStep) {
            op.lastStep = step;
            const output = outputOf(op);
            void logEmit({
              level: "info",
              category: CATEGORY,
              source: SOURCE,
              message: `Exporting ${output}`,
              i18n_key: "log.export_started",
              i18n_args: { path: output },
              op_id: op.id,
              op_state: { state: "Progress", progress: state.progress.progress },
            });
          }
        } else if (state !== null && state.kind === "complete") {
          endOp(
            "info",
            "Ok",
            `Exported ${state.payload.outputPath}`,
            "log.export_ok",
            { path: state.payload.outputPath },
            {
              output: state.payload.outputPath,
              duration_us: state.payload.durationUs,
            },
          );
        } else if (state !== null && state.kind === "error") {
          endOp(
            "error",
            "Err",
            `Export failed: ${state.detail}`,
            "log.export_failed",
            { error: state.detail },
            { output: outputOf(op), error: state.detail },
          );
        } else if (state === null) {
          // Running → null is the cancel path (readiness aborts); dismissing
          // a terminal panel also lands here but the op is already closed.
          const by = jobOf(op.jobId)?.cancelled_by;
          endOp(
            "info",
            "Ok",
            "Export cancelled",
            "log.export_cancelled",
            {},
            cancelDetails(outputOf(op), by),
            cancelSource(by),
          );
        }
        return;
      }

      // No op open: an export refused before it began (e.g. the no-material
      // guard errors straight from idle). One row, no op — same shape as a
      // fast failure.
      if (state !== null && state.kind === "error") {
        const output = state.job?.output_path;
        void logEmit({
          level: "error",
          category: CATEGORY,
          source: SOURCE,
          message: `Export failed: ${state.detail}`,
          i18n_key: "log.export_failed",
          i18n_args: { error: state.detail },
          details: { ...(output ? { output } : {}), error: state.detail },
        });
      }
    },
  };
}
