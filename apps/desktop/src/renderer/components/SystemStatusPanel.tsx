import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import type { AppNotice } from "../../shared/ipc";
import { CurrentSystemStatus } from "./CurrentSystemStatus";
import { SaveFailureCard, type SaveFailureActions } from "./SaveFailureCard";
import { useSaveFailure } from "../state/saveStatusStore";
import type { SystemSettingsTarget } from "./systemStatus";
import { AppIcon } from "@/components/AppIcon";

interface Props {
  notices: AppNotice[];
  onClose: () => void;
  onOpenSettings: (target: SystemSettingsTarget) => void;
  saveActions: SaveFailureActions;
}

/// Dedicated capability-status surface. It is intentionally separate from
/// LogConsole: notices are interactive here, while their mirrored log entries
/// remain ordinary, non-interactive rows in the log history. A project that is
/// not being saved leads, as its own card (SaveFailureCard).
export function SystemStatusPanel({ notices, onClose, onOpenSettings, saveActions }: Props) {
  const { t } = useTranslation();
  const saveFailure = useSaveFailure();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <aside className="system-status-panel" aria-label={t("system_status.title")}>
      <button
        type="button"
        className="system-status-close"
        onClick={onClose}
        aria-label={t("log.close")}
      >
        <AppIcon icon={XIcon} size="title" aria-hidden />
      </button>
      {saveFailure && <SaveFailureCard failure={saveFailure} actions={saveActions} />}
      <CurrentSystemStatus
        notices={notices}
        onOpenSettings={onOpenSettings}
      />
    </aside>
  );
}
