import { useTranslation } from "react-i18next";
import { AlertTriangleIcon } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { useSaveFailure } from "../state/saveStatusStore";
import { lastSavedText, saveFailureReason } from "./saveFailure";

/// "Not saved": shown only while main reports the project failing to save
/// (shared/save-status.ts), so the bar's normal layout is unchanged. The
/// tooltip carries the reason and the last good save; the click opens the
/// System panel, whose card holds the recovery actions.
export function SaveStatusBadge({ onOpen }: { onOpen?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const failure = useSaveFailure();
  if (!failure) return null;
  const title = [saveFailureReason(t, failure.code), lastSavedText(t, failure.last_saved_at)].join("\n");
  return (
    <button
      type="button"
      className="status-bar-badge status-bar-badge-warn"
      data-testid="save-status-badge"
      onClick={onOpen}
      title={title}
      aria-label={`${t("save_status.badge")}. ${title}`}
    >
      <AppIcon icon={AlertTriangleIcon} size="label" aria-hidden />
      {t("save_status.badge")}
    </button>
  );
}
