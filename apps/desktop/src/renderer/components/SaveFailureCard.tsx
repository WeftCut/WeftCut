import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppIcon } from "@/components/AppIcon";
import type { SaveStatus } from "../ipc";
import { lastSavedText, saveFailureReason } from "./saveFailure";

export interface SaveFailureActions {
  /// The explicit save (`project_save`); rejects when it fails again.
  retry: () => Promise<void>;
  /// The app's Save As flow.
  saveAs: () => void;
  /// Opens the project folder in the file manager.
  openFolder: (dir: string) => Promise<void>;
}

interface Props {
  failure: Extract<SaveStatus, { state: "failing" }>;
  actions: SaveFailureActions;
}

/// The project-not-saved recovery card, above the capability notices in the
/// System panel. Not an AppNotice: its text and actions depend on the failure.
export function SaveFailureCard({ failure, actions }: Props) {
  const { t } = useTranslation();
  const [result, setResult] = useState<
    { kind: "retrying" } | { kind: "retry_failed" } | { kind: "folder_failed"; detail: string } | null
  >(null);
  const reason = saveFailureReason(t, failure.code);

  const retry = async () => {
    setResult({ kind: "retrying" });
    try {
      await actions.retry();
      // Success clears the failing state, and with it this card.
      setResult(null);
    } catch {
      setResult({ kind: "retry_failed" });
    }
  };
  const openFolder = async () => {
    try {
      await actions.openFolder(failure.dir);
    } catch (error) {
      setResult({ kind: "folder_failed", detail: String(error) });
    }
  };

  return (
    <section className="current-system-status save-failure-card" aria-labelledby="save-failure-title" data-testid="save-failure-card">
      <div className="system-status-header">
        <h2 id="save-failure-title" className="system-status-title">
          {t("save_status.card_title")}
        </h2>
      </div>
      <div className="system-status-item system-status-item-warn">
        <span className="system-status-item-icon">
          <AppIcon icon={AlertTriangleIcon} size="title" aria-hidden />
        </span>
        <div className="system-status-item-content">
          <strong>{reason}</strong>
          <p>{t("save_status.card_body")}</p>
          <dl className="save-failure-facts">
            <dt>{t("save_status.file_label")}</dt>
            <dd className="save-failure-path">{failure.path}</dd>
            <dt>{t("save_status.saved_label")}</dt>
            <dd>{lastSavedText(t, failure.last_saved_at)}</dd>
          </dl>
          {result !== null && (
            <p className="save-failure-result" role="status">
              {result.kind === "retrying"
                ? t("save_status.retrying")
                : result.kind === "retry_failed"
                  ? t("save_status.retry_failed")
                  : t("save_status.open_folder_failed", { detail: result.detail })}
            </p>
          )}
          <div className="save-failure-actions">
            <Button variant="ghost" size="xs" onClick={() => void retry()} disabled={result?.kind === "retrying"}>
              {t("save_status.retry")}
            </Button>
            <Button variant="ghost" size="xs" onClick={actions.saveAs}>
              {t("save_status.save_as")}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => void openFolder()}>
              {t("save_status.open_folder")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
