// What a person's own run is doing, for the tooltip of a command that is greyed
// BECAUSE that run is in flight. "A transcription is already running" says why
// the row is grey; "Waiting for memory to free up" also says what to do about
// it. The run's own tag finds its job (ADR 0121), so this is the phase of the
// job the run started or joined — and null before that job exists (the input
// preflight) or after it (between a sweep's shots), where the generic reason
// is still the honest answer.

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ComputeJob, ComputeTool } from "../ipc";
import { useDescriptionsStore } from "../describe/descriptionsStore";
import { useTranscribeRunStore } from "../speech/transcribeRun";
import { computePhaseText } from "./computeJobView";
import { useComputeJobForRequest } from "./computeJobsStore";

/// The phase line for a run: its job's phase, or the write-back after it.
/// Null when there is neither.
export function runPhaseHint(
  t: TFunction,
  tool: ComputeTool,
  job: Pick<ComputeJob, "phase"> | null,
  applying = false,
): string | null {
  if (job !== null) return computePhaseText(t, tool, job.phase, { detail: true });
  if (applying) return computePhaseText(t, tool, { kind: "applying" });
  return null;
}

/// This window's transcription run, as a phase line, or null.
export function useTranscribeRunPhaseHint(): string | null {
  const { t } = useTranslation();
  const requestId = useTranscribeRunStore((s) => s.requestId);
  const applying = useTranscribeRunStore((s) => s.applying !== null);
  const job = useComputeJobForRequest(requestId);
  return runPhaseHint(t, "transcribe_clip", job, applying);
}

/// This window's description run (a lone press or a sweep's current shot), as
/// a phase line, or null.
export function useDescribeRunPhaseHint(): string | null {
  const { t } = useTranslation();
  const requestId = useDescriptionsStore((s) => s.describing?.requestId ?? null);
  const job = useComputeJobForRequest(requestId);
  return runPhaseHint(t, "describe_clip", job);
}
