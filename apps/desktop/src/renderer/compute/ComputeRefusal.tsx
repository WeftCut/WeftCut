// A transcription or description failure, as a person reads it: for a
// resource refusal the localized summary, a way to the Performance pane when a
// setting there can help, and the native sentence folded away as technical
// detail (`computeRefusal.ts`). Any other failure is its own sentence, as before.

import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { ComputeTool } from "../ipc";
import { requestSettings } from "../settings/settingsRequest";
import { computeRefusalSummary, computeResourceReason, settingsCanHelp } from "./computeRefusal";

export function ComputeRefusal({
  text,
  tool,
  className,
  testId,
}: {
  text: string;
  tool: ComputeTool;
  /// The surface's own error styling, on the summary line.
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const reason = computeResourceReason(text);
  const summary = computeRefusalSummary(t, tool, text);
  if (reason === null || summary === null) {
    return <p className={className} data-testid={testId}>{text}</p>;
  }
  return (
    <div className="compute-refusal" data-testid={testId} data-reason={reason}>
      <p className={className}>{summary}</p>
      <div className="compute-refusal-actions">
        {settingsCanHelp(reason) && (
          <Button variant="secondary" size="sm" onClick={() => requestSettings("performance")}>
            {t("compute.refusal.open_settings")}
          </Button>
        )}
        <details className="compute-refusal-details">
          <summary>{t("compute.refusal.details")}</summary>
          <pre>{text}</pre>
        </details>
      </div>
    </div>
  );
}
