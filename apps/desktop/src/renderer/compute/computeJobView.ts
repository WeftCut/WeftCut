// What a clip-compute job looks like to a person: its phase in words, whether
// it is waiting or working, how long it has waited, and whether it has gone
// quiet. Pure over a job and a clock, so the Activity row, the status bar and
// the in-context indicators all say the same thing.

import type { TFunction } from "i18next";
import type { ComputeJob, ComputePhase, ComputeTool } from "../ipc";

/// A working phase that has not changed for this long reads as stalled.
/// Ninety seconds: longer than any step takes on a short clip, shorter than a
/// person's patience on a long one. `phase_since` moves on every count change
/// too (extracted frames, inference percent), so a phase that reports counts
/// is only stalled when its counts stop.
export const STALL_AFTER_MS = 90_000;

/// The part of a job its status needs — what an Activity row's
/// `activity.compute` can also supply when the live job is not mirrored.
export type ComputeJobSubject = Pick<ComputeJob, "job_id" | "tool" | "phase" | "phase_since"> & {
  caller_disconnected?: boolean;
};

/// Queued: admission has not let the job start. Waiting is not working, and
/// nothing a person sees should spin for it.
export const isWaiting = (phase: ComputePhase): boolean => phase.kind === "queued";

/// How long the job has been in its current phase (counts included), ≥ 0.
export function phaseAgeMs(job: Pick<ComputeJob, "phase_since">, now: number): number {
  const since = Date.parse(job.phase_since);
  return Number.isNaN(since) ? 0 : Math.max(0, now - since);
}

/// How long a working job has gone without progress, or null while it is
/// moving (or waiting: a queued job already shows its wait).
export function stalledForMs(job: Pick<ComputeJob, "phase" | "phase_since">, now: number): number | null {
  if (isWaiting(job.phase)) return null;
  const age = phaseAgeMs(job, now);
  return age > STALL_AFTER_MS ? age : null;
}

/// "42s", "2m 10s", "1h 3m" — the coarsest units that still say it.
export function formatComputeDuration(t: TFunction, ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h > 0) return t("compute.ui.duration_hours", { h, m });
  if (m > 0) return t("compute.ui.duration_minutes", { m, s });
  return t("compute.ui.duration_seconds", { s });
}

export interface PhaseTextOptions {
  /// The budget wait's long form, naming what holds the capacity. Off where
  /// the text must stay short.
  detail?: boolean;
}

/// The phase in words for this tool: frames for a description, audio and a
/// percentage for a transcription.
export function computePhaseText(t: TFunction, tool: ComputeTool, phase: ComputePhase, opts: PhaseTextOptions = {}): string {
  const transcribe = tool === "transcribe_clip";
  switch (phase.kind) {
    case "queued":
      if (phase.reason === null) return t("compute.phase.queued");
      if (phase.reason === "budget" && opts.detail) return t("compute.ui.queued_budget_detail");
      return t(`compute.phase.queued_${phase.reason}`);
    case "extracting":
      return transcribe
        ? t("compute.ui.extracting_audio")
        : t("compute.ui.sampling_frames", { done: phase.done, total: phase.total });
    case "normalizing":
      return t("compute.phase.normalizing");
    case "loading_model":
      return t("compute.phase.loading_model");
    case "inferring": {
      const counted = phase.done !== undefined && phase.total !== undefined && phase.total > 0;
      if (transcribe) {
        return counted
          ? t("compute.ui.transcribing_percent", { percent: Math.min(100, Math.round((phase.done! / phase.total!) * 100)) })
          : t("compute.ui.transcribing");
      }
      return counted
        ? t("compute.ui.describing_counted", { done: phase.done, total: phase.total })
        : t("compute.ui.describing");
    }
    case "applying":
      return transcribe ? t("compute.ui.applying_captions") : t("compute.phase.applying");
  }
}

/// "Transcribe" / "Describe" — the tool as a verb, for a line that names the clip.
export const computeToolLabel = (t: TFunction, tool: ComputeTool): string =>
  t(tool === "transcribe_clip" ? "compute.ui.tool_transcribe" : "compute.ui.tool_describe");
