import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { BellIcon } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { useStatusPopover } from "@/components/useStatusPopover";
import { openAgentTab } from "../agent/openAgentTab";
import { useUnreviewedCount } from "../agent/reviewStore";
import { useNoticedUpdate } from "../app/updateStatus";
import { UpdateDialog } from "../app/UpdateDialog";
import { setAppSettings, useDismissedNotices } from "../settings/appSettingsStore";
import { attentionView, type AttentionItem } from "./attentionView";
import {
  NOTICE_PAGE_LABEL,
  noticeSettingsPage,
  useAppNotices,
  type NoticeSettingsPage,
} from "./appNotices";

interface Props {
  onOpenSettings: (page: NoticeSettingsPage) => void;
  /// `down` in the agent-mode titlebar, where the bell sits at the top.
  placement?: "up" | "down";
}

/// The bell: what needs the user. Colour only — the dot is the most severe
/// item not dismissed, and it counts nothing. Its popover is the notification
/// center. Dismissing a row only takes it out of here: each state keeps its own
/// home (the settings page "Open settings" leads to, Help · Check for Updates),
/// and the dismiss link's tooltip names it. Layout and behaviour:
/// `docs/status-log.md` § Notification center.
export function NotificationBell({ onOpenSettings, placement = "up" }: Props) {
  const { t } = useTranslation();
  const notices = useAppNotices();
  const unreviewed = useUnreviewedCount();
  const update = useNoticedUpdate();
  const dismissedNotices = useDismissedNotices();
  const view = attentionView({ notices, dismissedNotices, unreviewed, update });
  const { open, close, rootRef, detailsId, triggerProps } = useStatusPopover();
  const [updateOpen, setUpdateOpen] = useState(false);

  const label = view.level
    ? t("notifications.bell", { level: t(`notifications.level_${view.level}`) })
    : t("notifications.bell_clear");

  const act = (item: AttentionItem) => {
    close();
    if (item.kind === "review") openAgentTab("changes");
    else if (item.kind === "update") setUpdateOpen(true);
    else onOpenSettings(noticeSettingsPage(item.code));
  };
  const dismiss = (item: AttentionItem) => {
    // Skipping is the update's one dismissal, as in the update dialog: no
    // reminder, download or install for this version; a newer one shows again.
    const patch = item.kind === "update"
      ? { skipped_update_version: item.update.version }
      : item.kind === "notice" ? { dismiss_notice: item.code } : null;
    if (patch) void setAppSettings(patch).catch((error) => console.warn("[notifications] dismiss", error));
  };

  return (
    <div className="status-popover-anchor" ref={rootRef}>
      <button
        {...triggerProps}
        type="button"
        className="status-bar-slot status-bell"
        data-testid="status-bar-bell"
        data-level={view.level ?? "none"}
        title={label}
        aria-label={label}
      >
        <span className="status-bell-icon" aria-hidden="true">
          <AppIcon icon={BellIcon} size="label" aria-hidden />
          {view.level && <span className={`status-bell-dot level-${view.level}`} />}
        </span>
      </button>
      {open && (
        <section
          id={detailsId}
          className={`status-popover attention-center${placement === "down" ? " is-below" : ""}`}
          aria-labelledby={`${detailsId}-title`}
          data-testid="attention-center"
        >
          <h2 id={`${detailsId}-title`} className="attention-title">{t("notifications.title")}</h2>
          {view.active.length === 0 ? (
            <p className="attention-empty">{t("notifications.empty")}</p>
          ) : (
            <ul className="attention-list">
              {view.active.map((item) => (
                <AttentionRow key={item.key} item={item} onAct={act} onDismiss={dismiss} />
              ))}
            </ul>
          )}
        </section>
      )}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
    </div>
  );
}

/// Severity dot · title · a description of at most two lines (the full text
/// in its tooltip). At its end the way to the fix is a link at the top; the
/// dismissal, second in rank, sits grey at the bottom and shows while the row is
/// hovered or holds focus, so a list at rest reads as what needs doing.
function AttentionRow({ item, onAct, onDismiss }: {
  item: AttentionItem;
  onAct: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
}) {
  const { t } = useTranslation();
  const text = rowText(t, item);
  return (
    <li className={`attention-row level-${item.level}`} data-attention={item.key}>
      <span className="attention-dot" aria-hidden="true" />
      <div className="attention-body">
        <div className="attention-row-title">{text.title}</div>
        {text.body && <div className="attention-row-body" title={text.body}>{text.body}</div>}
      </div>
      <div className="attention-actions">
        <button type="button" className="attention-link" onClick={() => onAct(item)}>
          {text.action}
        </button>
        {text.dismiss && (
          <button
            type="button"
            className="attention-link attention-dismiss"
            onClick={() => onDismiss(item)}
            title={text.dismissHint}
            aria-description={text.dismissHint}
          >
            {text.dismiss}
          </button>
        )}
      </div>
    </li>
  );
}

function rowText(t: TFunction, item: AttentionItem): {
  title: string;
  body?: string;
  action: string;
  dismiss?: string;
  /// Where the state stays once the row is dismissed.
  dismissHint?: string;
} {
  switch (item.kind) {
    case "review":
      return {
        title: t("notifications.review_title", { count: item.count }),
        body: t("notifications.review_body"),
        action: t("notifications.review_action"),
      };
    case "update": {
      const { phase, version, percent } = item.update;
      const title = phase === "downloading"
        ? t("updates.downloading", { version, percent: percent ?? 0 })
        : phase === "ready" || phase === "restarting"
          ? t("updates.indicator_ready", { version })
          : phase === "error"
            ? t("updates.indicator_error", { version })
            : t("updates.indicator_available", { version });
      const body = phase === "available" ? t("notifications.update_body_available")
        : phase === "ready" ? t("notifications.update_body_ready")
          : phase === "error" ? t("notifications.update_body_error")
            : undefined;
      return {
        title,
        ...(body ? { body } : {}),
        action: t("notifications.update_action"),
        // A restart already under way installs it; there is nothing to skip.
        ...(phase === "restarting" ? {} : {
          dismiss: t("updates.skip"),
          dismissHint: t("notifications.dismiss_hint_update"),
        }),
      };
    }
    case "notice":
      return {
        title: t(`app_notice.${item.code}.title`),
        body: t(`app_notice.${item.code}.body`),
        action: t("notifications.open_settings"),
        dismiss: t("app_notice.dismiss"),
        dismissHint: t("notifications.dismiss_hint_settings", {
          page: t(NOTICE_PAGE_LABEL[noticeSettingsPage(item.code)]),
        }),
      };
  }
}
