import { useTranslation } from "react-i18next";

import { AppDialog } from "../components/AppDialog";
import { Button } from "@/components/ui/button";
import { rendererOS, type RendererOS } from "@/platform";

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

export type ExportState =
  // `onCancel` is optional: the proxy-wait phase can abort its in-flight
  // wait, but the motif-bake phase has no cancellable step today, so it
  // omits the handler and the panel hides the Cancel button (rather than
  // showing one wired to a no-op).
  | { kind: "starting" }
  | { kind: "preparing"; labels: string[]; onCancel?: () => void }
  | { kind: "progress"; progress: ExportProgress }
  // The tail after the last frame is encoded: flush the native sink, render
  // audio, stream-copy mux. It used to be invisible — the panel sat frozen at
  // 100% with the Worker's stale fps for its whole duration, and an e2e
  // liveness probe watching the frame counter could not tell that tail apart
  // from a wedge (which is what `export_eos_tail` exists to catch). Naming the
  // step makes both the user's wait and the probe's stall budget honest.
  | { kind: "finalizing"; step: FinalizeStep }
  | { kind: "complete"; payload: ExportComplete }
  | { kind: "error"; detail: string };

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
}) {
  const { t } = useTranslation();
  // Modal during work: no dismiss/close affordance until complete/error (the
  // "preparing" wait has its own Cancel). This also blocks UI interaction.
  // Stated as the terminal set, not as "not running": a new running phase then
  // stays modal by default instead of silently becoming dismissable.
  const dismissable = state.kind === "complete" || state.kind === "error";

  let body: React.ReactNode;
  let percent = 0;
  switch (state.kind) {
    case "starting":
      body = <p className="export-progress-status">{t("export.starting")}</p>;
      break;
    case "preparing":
      body = (
        <p className="export-progress-status">
          {t("export.preparing", {
            labels: state.labels.join(", "),
            count: state.labels.length,
          })}
        </p>
      );
      break;
    case "progress": {
      percent = Math.round(state.progress.progress * 100);
      const detail = t("export.progress_label", {
        percent,
        frame: state.progress.frame,
        fps: state.progress.fps.toFixed(1),
        speed: state.progress.speed.toFixed(2),
      });
      body = (
        <p className="export-progress-status">
          <strong>{t("export.phase_encode")}</strong>
          <span className="export-progress-detail">{detail}</span>
        </p>
      );
      break;
    }
    case "finalizing":
      // The encode is done, so the bar is honestly full — what changes is the
      // label under it, which names the step instead of leaving the Worker's
      // last fps reading on screen as if frames were still moving.
      percent = 100;
      body = (
        <p className="export-progress-status">
          <strong>{t("export.phase_finalize")}</strong>
          <span className="export-progress-detail">
            {t(FINALIZE_STEP_KEY[state.step])}
          </span>
        </p>
      );
      break;
    case "complete":
      percent = 100;
      body = (
        <p className="export-progress-status">
          {t("export.complete", { path: state.payload.outputPath })}
        </p>
      );
      break;
    case "error":
      body = (
        <p className="export-progress-status error">
          {t("export.failed", { detail: state.detail })}
        </p>
      );
      break;
  }

  return (
    <AppDialog
      title={t("export.title")}
      onClose={dismissable ? onClose : undefined}
      panelClassName="settings-panel export-progress-panel"
    >
        <div className="settings-body">
          <div className="settings-card">
            {body}
            <div
              className={`progress-track ${
                state.kind === "error" ? "is-error" : ""
              }`}
            >
              <div
                className="progress-fill"
                style={{ width: `${state.kind === "error" ? 100 : percent}%` }}
              />
            </div>
            {((state.kind === "preparing" && state.onCancel) || dismissable) && (
              <div className="export-actions">
                {state.kind === "preparing" && state.onCancel && (
                  <Button size="lg" onClick={state.onCancel}>
                    {t("export.preparing_cancel")}
                  </Button>
                )}
                {state.kind === "complete" && onReveal && (
                  <Button
                    size="lg"
                    onClick={() => onReveal(state.payload.outputPath)}
                    title={t("export.reveal_hint")}
                  >
                    {t(REVEAL_KEY[rendererOS])}
                  </Button>
                )}
                {state.kind === "complete" && onPlay && (
                  <Button
                    size="lg"
                    onClick={() => onPlay(state.payload.outputPath)}
                    title={t("export.play_hint")}
                  >
                    {t("export.play")}
                  </Button>
                )}
                {dismissable && (
                  <Button variant="default" size="lg" onClick={onClose}>
                    {t("export.dismiss")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
    </AppDialog>
  );
}
