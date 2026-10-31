import { useEffect, useId, useMemo, useState } from "react";
import { AppInput } from "../components/AppInput";
import { AppIcon } from "../components/AppIcon";
import { LoaderCircle } from "lucide-react";
import { resourceFailureReason } from '../../shared/export-resources';
import { useTranslation } from "react-i18next";

import { AppDialog } from "../components/AppDialog";
import { Button } from "@/components/ui/button";
import { rendererOS, type RendererOS } from "@/platform";
import { isResourceCapacityError } from "../../shared/resource-policy";

export interface ExportProgress {
  progress: number;
  currentTimeUs: number;
  frame: number;
  fps: number;
  speed: number;
}

export interface ExportComplete {
  outputPath: string;
  durationUs: number;
}

export type ExportState = ExportPhase & { job?: import('../../shared/exportJob').ExportJob; onCancel?: () => void };
type ExportPhase =
  // Readiness waits and frame export provide their own cancellation handler.
  | { kind: "starting" }
  | { kind: "preparing"; labels: string[]; message?: string; onCancel?: () => void }
  | { kind: "progress"; progress: ExportProgress; onCancel?: () => void }
  // The tail after the last frame is encoded: flush the native sink, render
  // audio, stream-copy mux. It used to be invisible — the panel sat frozen at
  // 100% with the Worker's stale fps for its whole duration, and an e2e
  // liveness probe watching the frame counter could not tell that tail apart
  // from a wedge (which is what `export_eos_tail` exists to catch). Naming the
  // step makes both the user's wait and the probe's stall budget honest.
  | { kind: "finalizing"; step: FinalizeStep }
  | { kind: "complete"; payload: ExportComplete }
  | { kind: "error"; detail: string; onRetry?: (filename?: string) => Promise<void>; onDiscard?: () => Promise<void> };

/// Ordered as they run. `sink` only occurs on the native-encode path.
export type FinalizeStep = "sink" | "audio" | "mux";

/// Spelled out rather than built as `export.finalize_${step}` so adding a step
/// to the union is a compile error here, not a missing-key string at runtime.
const FINALIZE_STEP_KEY: Record<FinalizeStep, string> = {
  sink: "export.finalize_sink",
  audio: "export.finalize_audio",
  mux: "export.finalize_mux",
};

/// The reveal button names the file manager per OS ("Reveal in Finder",
/// "Reveal in Explorer"), the way Premiere and Resolve label it. Spelled out
/// for the same reason as FINALIZE_STEP_KEY: a new RendererOS is a compile
/// error here, not a missing-key string at runtime.
const REVEAL_KEY: Record<RendererOS, string> = {
  windows: "export.reveal_windows",
  mac: "export.reveal_mac",
  linux: "export.reveal_linux",
};

export function ExportPanel({
  state,
  onClose,
  onPlay,
  onReveal,
  onOpenSettings,
}: {
  state: ExportState;
  onClose: () => void;
  /// When set, the panel renders a "Play" button next to the dismiss
  /// button on the complete state. Clicking opens a popup window
  /// playing the just-exported file.
  onPlay?: (path: string) => void;
  /// When set, the complete state also offers to reveal the exported file
  /// in the OS file manager (label per OS, see REVEAL_KEY).
  onReveal?: (path: string) => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const renameId = useId();
  const [renaming, setRenaming] = useState(false);
  const [retryFilename, setRetryFilename] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState(false);
  const cancelling = state.job?.phase === "cancelling";
  const dismissable = !cancelling && (state.kind === "complete" || state.kind === "error");
  const retryable = !cancelling && state.kind === "error" && !!state.onRetry;
  const resourceError = state.kind === "error" && isResourceCapacityError(state.detail);
  const resourceReason = state.kind === "error" ? resourceFailureReason(state.detail) : undefined;
  const resourceMessage = resourceReason === "budget-too-small" ? "export.resource_budget"
    : resourceReason === "host-pressure" || resourceReason === "pressure" ? "export.resource_pressure" : "export.resource_unavailable";
  // Publication can choose a new name. Completion always shows the saved path.
  const outputPath = state.kind === "complete" ? state.payload.outputPath : state.job?.output_path;
  const separator = outputPath ? Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\")) : -1;
  const filename = outputPath?.slice(separator + 1) || state.job?.filename;
  const directory = outputPath?.slice(0, separator + 1);
  const encoderLoad = state.kind === 'progress' && !cancelling ? state.job?.encoder_load : undefined;
  const deviceLabel = encoderLoad ? t(encoderLoad.device === 'gpu' ? 'export.device_gpu' : 'export.device_cpu') : null;
  const load = encoderLoad?.utilization_percent;
  const loadLabel = typeof load === 'number' && Number.isFinite(load) && load >= 0 && load <= 100
    ? `${Math.round(load)}%` : t('export.load_unavailable');
  const percent = !cancelling && state.kind === "progress" ? Math.max(0, Math.min(100, Math.round(state.progress.progress * 100))) : undefined;
  const progressValue = state.kind === 'progress' ? state.progress.progress : null;
  const estimateReceivedAt = useMemo(() => performance.now(), [state.job?.job_id, progressValue]);
  const [estimateClock, setEstimateClock] = useState(0);
  useEffect(() => {
    if (state.kind !== 'progress') return;
    const timer = setTimeout(() => setEstimateClock(performance.now()), 30_000);
    return () => clearTimeout(timer);
  }, [estimateReceivedAt, state.kind]);
  const remainingMs = state.job?.estimated_remaining_ms;
  const remainingSeconds = estimateClock < estimateReceivedAt + 30_000
    && typeof remainingMs === 'number' && Number.isFinite(remainingMs) && remainingMs > 0
    ? Math.ceil(remainingMs / 1_000) : null;
  const remainingTime = remainingSeconds === null ? null : remainingSeconds >= 3_600
    ? t('export.time_hours_minutes', { hours: Math.floor(remainingSeconds / 3_600), minutes: Math.floor(remainingSeconds % 3_600 / 60) })
    : remainingSeconds >= 60
      ? t('export.time_minutes_seconds', { minutes: Math.floor(remainingSeconds / 60), seconds: remainingSeconds % 60 })
      : t('export.time_seconds', { seconds: remainingSeconds });
  const title = cancelling ? t("export.title") : state.kind === "complete" ? t("export.notify_done_title")
    : state.kind === "error" ? t(retryable ? "export.pending_title" : "export.notify_failed_title")
      : deviceLabel ? `${t('export.title')} · ${deviceLabel}` : t("export.title");
  const phase = cancelling ? t("export.cancelling") : state.kind === "progress" ? t("export.phase_encode")
    : state.kind === "finalizing" ? t(FINALIZE_STEP_KEY[state.step])
      : state.kind === "preparing" ? state.message ?? t("export.phase_prepare") : t("export.starting");

  const runAction = async (action: () => Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(true);
    setActionError("");
    try { await action(); }
    catch (error) { setActionError(String(error)); }
    finally { setPendingAction(false); }
  };

  return (
    <AppDialog title={title} onClose={dismissable && !retryable ? onClose : undefined}
      panelClassName="settings-panel export-progress-panel">
      <div className="export-progress-body">
        {!dismissable && (
          <section className="export-work" aria-label={phase}>
            {encoderLoad && <p className="export-progress-detail" title={t(encoderLoad.device === 'gpu' ? 'export.load_gpu_hint' : 'export.load_cpu_hint')}>
              {encoderLoad.encoder} · {t(encoderLoad.device === 'gpu' ? 'export.load_gpu_label' : 'export.load_cpu_label')} {loadLabel}
            </p>}
            <div className="export-phase-row">
              <p className="export-progress-status" role="status">
                {percent === undefined && <span className="export-wait" role="progressbar" aria-label={phase}>
                  <AppIcon icon={LoaderCircle} size="body" className="export-spinner" aria-hidden />
                </span>}
                {phase}
              </p>
              {percent !== undefined && <span className="export-percent">{percent}%</span>}
            </div>
            {percent !== undefined && <div className="progress-track"
              role="progressbar" aria-label={phase} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="progress-fill" style={percent === undefined ? undefined : { width: `${percent}%` }} />
            </div>}
            {percent !== undefined && state.kind === 'progress' && <p className="export-progress-detail export-time-estimate">
              {state.progress.progress >= 1 ? t('export.time_frames_done')
                : remainingTime === null ? t('export.time_calculating')
                  : t('export.time_remaining', { time: remainingTime })}
            </p>}
          </section>
        )}
        {!cancelling && state.kind === "error" && (
          <div className="export-failure" role="alert">
            <p className="export-progress-status">{resourceError ? t(resourceMessage) : t(retryable ? "export.retry_hint" : "export.failure_hint")}</p>
            {resourceError && retryable && <p className="export-progress-detail">{t("export.retry_hint")}</p>}
          </div>
        )}
        {filename && (
          <div className="export-destination">
            <p className="export-output-name">{filename}</p>
            {directory && <p className="export-output-directory">{directory}</p>}
            {retryable && (
              <div className="export-rename">
                <Button variant="ghost" size="sm" aria-expanded={renaming} aria-controls={renameId}
                  disabled={pendingAction} onClick={() => { setRenaming(!renaming); setRetryFilename(filename); }}>
                  {t(renaming ? "export.keep_filename" : "export.change_filename")}
                </Button>
                {renaming && <div id={renameId} className="export-rename-field">
                  <label htmlFor={`${renameId}-input`}>{t("export.new_filename")}</label>
                  <AppInput id={`${renameId}-input`} value={retryFilename} onValueChange={setRetryFilename}
                    disabled={pendingAction} aria-describedby={`${renameId}-hint`} autoFocus />
                  <p id={`${renameId}-hint`}>{t("export.filename_hint")}</p>
                </div>}
              </div>
            )}
          </div>
        )}
        {!cancelling && state.kind === "error" && (
          <details className="export-error-details">
            <summary>{t("export.technical_details")}</summary>
            <pre>{actionError || state.detail}</pre>
          </details>
        )}
        {!cancelling && actionError && <p className="export-action-error" role="alert">{t("export.action_failed")}</p>}
      </div>
      {!cancelling && (state.onCancel || dismissable) && (
        <div className="export-actions export-progress-footer">
          {state.kind === "error" && state.onDiscard && (
            <Button variant="ghost" size="lg" disabled={pendingAction} onClick={() => { void runAction(() => state.onDiscard!()); }}>{t("export.discard_pending")}</Button>
          )}
          {!dismissable && state.onCancel && (
            <Button variant="secondary" size="lg" onClick={state.onCancel}>{t("export.preparing_cancel")}</Button>
          )}
          {dismissable && !retryable && (
            <Button variant={state.kind === "complete" && !onReveal && !onPlay || state.kind === "error" && !(resourceError && onOpenSettings) ? "default" : "secondary"}
              size="lg" onClick={onClose}>{t("export.dismiss")}</Button>
          )}
          {state.kind === "complete" && onPlay && (
            <Button variant={onReveal ? "secondary" : "default"} size="lg"
              onClick={() => onPlay(state.payload.outputPath)} title={t("export.play_hint")}>{t("export.play")}</Button>
          )}
          {state.kind === "complete" && onReveal && (
            <Button variant="default" size="lg" onClick={() => onReveal(state.payload.outputPath)}
              title={t("export.reveal_hint")}>{t(REVEAL_KEY[rendererOS])}</Button>
          )}
          {resourceError && onOpenSettings && (
            <Button variant={retryable ? "secondary" : "default"} size="lg" disabled={pendingAction} onClick={onOpenSettings}>{t("export.open_settings")}</Button>
          )}
          {state.kind === "error" && state.onRetry && (
            <Button variant="default" size="lg" disabled={pendingAction || renaming && !retryFilename.trim()}
              onClick={() => { void runAction(() => state.onRetry!(renaming ? retryFilename.trim() : undefined)); }}>{t("export.retry_finalize")}</Button>
          )}
        </div>
      )}
    </AppDialog>
  );
}
