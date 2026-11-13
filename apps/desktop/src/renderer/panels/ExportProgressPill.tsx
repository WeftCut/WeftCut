import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatComputeDuration } from "../compute/computeJobView";
import { useNow } from "../hooks/useNow";
import { exportPhaseView, type ExportState } from "./ExportPanel";

/// A background export (preview during export) in the status bar: a ring with
/// the percent, and on click the details the foreground dialog would show,
/// with Cancel. The editor stays usable, so nothing here is modal.
export function ExportProgressPill({ state }: { state: ExportState }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  const [startedAt] = useState(() => Date.now());
  const { phase, percent } = exportPhaseView(state, t);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="export-pill" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="status-bar-badge export-pill-trigger"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        title={phase}
        onClick={() => setOpen(!open)}
      >
        <ProgressRing phase={phase} percent={percent} />
        {percent === undefined ? t("export.title") : t("export.pill", { percent })}
      </button>
      {open && (
        <section id={detailsId} className="export-pill-details" aria-label={t("export.title")}>
          <ExportPillDetails state={state} phase={phase} percent={percent} startedAt={startedAt} />
        </section>
      )}
    </div>
  );
}

/// The ring owns the accessible progress value; without a percent it spins,
/// as the dialog's spinner does.
function ProgressRing({ phase, percent }: { phase: string; percent: number | undefined }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  // The indeterminate arc: a short segment that the spin animation turns.
  const shown = percent ?? 30;
  return (
    <span role="progressbar" aria-label={phase} aria-valuemin={0} aria-valuemax={100}
      {...(percent === undefined ? {} : { "aria-valuenow": percent })}
      className={percent === undefined ? "export-pill-ring is-indeterminate" : "export-pill-ring"}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="export-pill-ring-track" cx="8" cy="8" r={radius} />
        <circle className="export-pill-ring-fill" cx="8" cy="8" r={radius} transform="rotate(-90 8 8)"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown / 100)} />
      </svg>
    </span>
  );
}

/// Split out so the one-second clock only runs while the details are open.
/// Measured figures only. No remaining-time estimate: by product decision an
/// export shows percent and elapsed time, never a prediction.
function ExportPillDetails({ state, phase, percent, startedAt }: {
  state: ExportState;
  phase: string;
  percent: number | undefined;
  startedAt: number;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const cancelling = state.job?.phase === "cancelling";
  const progress = state.kind === "progress" ? state.progress : undefined;

  return (
    <>
      <div className="export-phase-row">
        <p className="export-progress-status" role="status">{phase}</p>
        {percent !== undefined && <span className="export-percent">{percent}%</span>}
      </div>
      {percent !== undefined && (
        <div className="progress-track" aria-hidden="true">
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {state.job?.filename && <p className="export-output-name">{state.job.filename}</p>}
      <p className="export-pill-stats">
        {progress && <span>{t("export.pill_rate", { fps: Math.round(progress.fps), speed: progress.speed.toFixed(1) })}</span>}
        <span>{t("export.pill_elapsed", { time: formatComputeDuration(t, now - startedAt) })}</span>
      </p>
      {!cancelling && state.onCancel && (
        <div className="export-pill-actions">
          <Button variant="secondary" size="sm" onClick={state.onCancel}>{t("export.cancel_export")}</Button>
        </div>
      )}
    </>
  );
}
