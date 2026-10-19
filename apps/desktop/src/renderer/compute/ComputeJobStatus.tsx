// One clip-compute job's status, wherever a job is shown: the Activity row,
// the status bar, an indicator on the clip it reads. Waiting and working look
// different — a queued job shows an hourglass and what it waits for, never the
// spinner — a working phase that stops moving says so, and the job can be
// cancelled from here. Presentational: the caller hands over the job (live
// from `computeJobsStore`, or an Activity row's last copy).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Hourglass, Loader2, TriangleAlert, Unplug, X } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { refusalText } from "../errors/tryMutate";
import { useNow } from "../hooks/useNow";
import { cancelComputeJobHere } from "./computeJobNotices";
import {
  computePhaseText,
  formatComputeDuration,
  isWaiting,
  phaseAgeMs,
  stalledForMs,
  type ComputeJobSubject,
} from "./computeJobView";
import "./compute.css";

export type ComputeJobStatusVariant = "row" | "inline" | "compact";

export interface ComputeJobStatusProps {
  job: ComputeJobSubject;
  /// `row`: the phase on one line, its notes and Cancel below (the Activity
  /// list). `inline`: one line with a labelled Cancel (a panel row). `compact`:
  /// icon, short text and an icon-only Cancel; the reason and notes go in the
  /// title (an overlay on a clip).
  variant?: ComputeJobStatusVariant;
  /// Replaces the default force-cancel (`cancelComputeJobHere`). Its promise holds
  /// the button in its pending state.
  onCancel?: () => Promise<unknown> | void;
  /// No Cancel at all — a surface that only reports.
  hideCancel?: boolean;
  /// Off where the host already draws the state's icon (the Activity row's
  /// own leading glyph follows waiting / working).
  showIcon?: boolean;
  className?: string;
}

export function ComputeJobStatus({ job, variant = "row", onCancel, hideCancel = false, showIcon = true, className }: ComputeJobStatusProps) {
  const { t } = useTranslation();
  const now = useNow();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const waiting = isWaiting(job.phase);
  const compact = variant === "compact";
  const text = compact && waiting
    ? t("compute.ui.waiting_short")
    : computePhaseText(t, job.tool, job.phase, { detail: !compact });
  const reason = computePhaseText(t, job.tool, job.phase, { detail: true });
  const age = phaseAgeMs(job, now);
  // A wait under a second is the normal hand-off, not worth a number.
  const waited = waiting && age >= 1000 ? t("compute.ui.waited", { duration: formatComputeDuration(t, age) }) : null;
  const stalledMs = stalledForMs(job, now);
  const stalled = stalledMs === null ? null : t("compute.ui.stalled", { duration: formatComputeDuration(t, stalledMs) });
  const disconnected = job.caller_disconnected ? t("compute.ui.caller_disconnected") : null;
  const cancelName = t(job.tool === "transcribe_clip" ? "compute.ui.cancel_transcribe" : "compute.ui.cancel_describe");

  const cancel = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await (onCancel ? onCancel() : cancelComputeJobHere(job.job_id));
      // Cancelled: the job ends and this status goes with it, so the button
      // stays pending until then. `false` = it had already ended — nothing
      // to report, and nothing left to wait for.
      if (result === false && mounted.current) setPending(false);
    } catch (err) {
      if (!mounted.current) return;
      setPending(false);
      setError(t("compute.ui.cancel_failed", { reason: refusalText(err) }));
    }
  };

  const title = [reason, waited, stalled, disconnected, error].filter(Boolean).join("\n");
  const state = waiting ? "waiting" : "working";
  const icon = !showIcon ? null : waiting
    ? <AppIcon icon={Hourglass} size={compact ? "label" : "body"} className="compute-job-icon" aria-hidden />
    : <AppIcon icon={Loader2} size={compact ? "label" : "body"} className="compute-job-icon compute-job-spin" aria-hidden />;
  const button = hideCancel ? null : (
    <button
      type="button"
      className="compute-job-cancel"
      disabled={pending}
      aria-busy={pending || undefined}
      aria-label={pending ? t("compute.ui.cancelling") : cancelName}
      title={pending ? t("compute.ui.cancelling") : cancelName}
      onClick={(e) => { e.stopPropagation(); void cancel(); }}
    >
      {pending
        ? <AppIcon icon={Loader2} size="label" className="compute-job-spin" aria-hidden />
        : <AppIcon icon={X} size="label" aria-hidden />}
      {!compact && <span>{pending ? t("compute.ui.cancelling") : t("compute.ui.cancel")}</span>}
    </button>
  );
  const notes = <>
    {waited && !compact && <span className="compute-job-waited">{waited}</span>}
    {stalled && !compact && <span className="compute-job-stalled" title={t("compute.ui.stalled_hint")}><AppIcon icon={TriangleAlert} size="label" aria-hidden />{stalled}</span>}
    {disconnected && !compact && <span className="compute-job-disconnected" title={t("compute.ui.caller_disconnected_hint")}><AppIcon icon={Unplug} size="label" aria-hidden />{disconnected}</span>}
    {error && !compact && <span className="compute-job-error" role="alert">{error}</span>}
  </>;

  const classes = ["compute-job-status", `variant-${variant}`, `state-${state}`, stalled ? "is-stalled" : "", showIcon ? "" : "no-icon", className ?? ""].filter(Boolean).join(" ");
  if (variant === "row") {
    return <div className={classes} data-phase={job.phase.kind} title={title}>
      <div className="compute-job-line">{icon}<span className="compute-job-text">{text}</span></div>
      <div className="compute-job-notes">{notes}{button}</div>
    </div>;
  }
  return <div className={classes} data-phase={job.phase.kind} title={title}>
    {icon}<span className="compute-job-text">{text}</span>
    {compact && (stalled || disconnected || error) && <AppIcon icon={TriangleAlert} size="label" className="compute-job-flag" aria-label={[stalled, disconnected, error].filter(Boolean).join(" · ")} />}
    {notes}{button}
  </div>;
}
