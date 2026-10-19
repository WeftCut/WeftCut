// The in-app completion notice (`computeJobNotices.ts` decides when): a small
// non-modal card in the corner, the update notice's shape. It never takes
// focus, goes by itself after a few seconds, and can be dismissed sooner.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck, CircleSlash, X } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { Button } from "@/components/ui/button";
import { requestSettings } from "../settings/settingsRequest";
import { dismissComputeJobNotice, useComputeJobNoticeStore } from "./computeJobNotices";
import "./compute.css";

/// Long enough to read a sentence with a clip name in it; a failure stays
/// until dismissed, because its reason is the part worth acting on.
export const NOTICE_VISIBLE_MS = 8_000;

export function ComputeJobNotice() {
  const { t } = useTranslation();
  const notice = useComputeJobNoticeStore((s) => s.notice);
  const jobId = notice?.jobId ?? null;
  const sticky = notice?.outcome === "error";

  useEffect(() => {
    if (jobId === null || sticky) return;
    const timer = setTimeout(() => dismissComputeJobNotice(jobId), NOTICE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [jobId, sticky]);

  if (notice === null) return null;
  const icon = notice.outcome === "ok" ? CircleCheck : notice.outcome === "error" ? CircleAlert : CircleSlash;
  return (
    <aside className={`compute-notice outcome-${notice.outcome}`} data-testid="compute-notice" key={notice.jobId}>
      <AppIcon icon={icon} size="body" className="compute-notice-icon" aria-hidden />
      <div role="status" className="compute-notice-copy">
        <strong>{notice.title}</strong>
        <p>{notice.body}</p>
        {notice.settings && (
          <Button
            variant="secondary"
            size="sm"
            className="compute-notice-action"
            onClick={() => {
              requestSettings("performance");
              dismissComputeJobNotice(notice.jobId);
            }}
          >
            {t("compute.refusal.open_settings")}
          </Button>
        )}
      </div>
      <button
        type="button"
        className="compute-notice-dismiss"
        aria-label={t("compute.ui.notice_dismiss")}
        title={t("compute.ui.notice_dismiss")}
        onClick={() => dismissComputeJobNotice(notice.jobId)}
      >
        <AppIcon icon={X} size="label" aria-hidden />
      </button>
    </aside>
  );
}
