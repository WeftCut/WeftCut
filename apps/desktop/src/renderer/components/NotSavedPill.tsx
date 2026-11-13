import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppIcon } from "@/components/AppIcon";
import { useStatusPopover } from "@/components/useStatusPopover";
import type { SaveStatus } from "../ipc";
import { useSaveFailure } from "../state/saveStatusStore";
import { lastSavedText, saveFailureReason } from "./saveFailure";

export interface SaveFailureActions {
  /// The explicit save (`project_save`); rejects when it fails again.
  retry: () => Promise<void>;
  /// The app's Save As flow.
  saveAs: () => void;
  /// Opens the project folder in the file manager.
  openFolder: (dir: string) => Promise<void>;
}

/// "Not saved": shown only while main reports the project failing to save
/// (shared/save-status.ts). The one problem with its own place in the bar —
/// it must never be missed, so it is not one row among the bell's. Its popover
/// is the recovery in place: the reason, then Retry, Save As and the folder.
/// `down` in the agent-mode titlebar.
export function NotSavedPill({ actions, placement = "up" }: {
  actions: SaveFailureActions;
  placement?: "up" | "down";
}) {
  const { t } = useTranslation();
  const failure = useSaveFailure();
  const { open, close, rootRef, detailsId, triggerProps } = useStatusPopover();
  if (!failure) return null;
  const reason = saveFailureReason(t, failure.code);
  return (
    <div className="status-popover-anchor" ref={rootRef}>
      <button
        {...triggerProps}
        type="button"
        className="status-bar-slot not-saved-pill"
        data-testid="not-saved-pill"
        aria-label={`${t("save_status.badge")}: ${reason}`}
      >
        <AppIcon icon={AlertTriangleIcon} size="label" aria-hidden />
        {t("save_status.badge")}
      </button>
      {open && (
        <section
          id={detailsId}
          className={`status-popover not-saved-details${placement === "down" ? " is-below" : ""}`}
          aria-label={t("save_status.badge")}
          data-testid="not-saved-details"
        >
          <NotSavedDetails failure={failure} reason={reason} actions={actions} onLeave={close} />
        </section>
      )}
    </div>
  );
}

/// Split out so the retry outcome resets with each opening.
function NotSavedDetails({ failure, reason, actions, onLeave }: {
  failure: Extract<SaveStatus, { state: "failing" }>;
  reason: string;
  actions: SaveFailureActions;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<
    { kind: "retrying" } | { kind: "retry_failed" } | { kind: "folder_failed"; detail: string } | null
  >(null);

  const retry = async () => {
    setResult({ kind: "retrying" });
    try {
      await actions.retry();
      // Success clears the failing state, and with it the pill and this popover.
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
    <>
      <p className="not-saved-reason">{reason}</p>
      <p className="not-saved-body">
        {t("save_status.card_body")} {lastSavedText(t, failure.last_saved_at)}
      </p>
      <p className="not-saved-folder">{t("save_status.folder", { dir: failure.dir })}</p>
      {result !== null && (
        <p className="not-saved-result" role="status">
          {result.kind === "retrying"
            ? t("save_status.retrying")
            : result.kind === "retry_failed"
              ? t("save_status.retry_failed")
              : t("save_status.open_folder_failed", { detail: result.detail })}
        </p>
      )}
      <div className="not-saved-actions">
        <Button variant="default" size="xs" onClick={() => void retry()} disabled={result?.kind === "retrying"}>
          {t("save_status.retry")}
        </Button>
        <Button variant="secondary" size="xs" onClick={() => { onLeave(); actions.saveAs(); }}>
          {t("save_status.save_as")}
        </Button>
        <Button variant="secondary" size="xs" onClick={() => void openFolder()}>
          {t("save_status.open_folder")}
        </Button>
      </div>
    </>
  );
}
