import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppIcon } from "../components/AppIcon";
import { Button } from "@/components/ui/button";
import { FINALIZE_STEP_KEY, type ExportState } from "./ExportPanel";

export function BackgroundExportProgress({ state }: { state: ExportState }) {
  const { t } = useTranslation();
  const cancelling = state.job?.phase === "cancelling";
  const percent = !cancelling && state.kind === "progress"
    ? Math.max(0, Math.min(100, Math.round(state.progress.progress * 100)))
    : undefined;
  const phase = cancelling ? t("export.cancelling") : state.kind === "progress" ? t("export.phase_encode")
    : state.kind === "finalizing" ? t(FINALIZE_STEP_KEY[state.step])
      : state.kind === "preparing" ? state.message ?? t("export.phase_prepare") : t("export.starting");

  return (
    <section className="export-progress-panel export-background-progress" aria-label={t("export.title")}>
      <div className="export-background-state">
        <span className="export-progress-status" role="status">
          {percent === undefined && (
            <span role="progressbar" aria-label={phase}>
              <AppIcon icon={LoaderCircle} size="body" className="export-spinner" aria-hidden />
            </span>
          )}
          {phase}
        </span>
        {percent !== undefined && (
          <>
            <progress value={percent} max={100} aria-label={phase}>{percent}%</progress>
            <span className="export-percent">{percent}%</span>
          </>
        )}
        <span className="export-timeline-locked">{t("export.timeline_locked")}</span>
      </div>
      {!cancelling && state.onCancel && (
        <Button variant="secondary" size="sm" onClick={state.onCancel}>{t("export.preparing_cancel")}</Button>
      )}
    </section>
  );
}
