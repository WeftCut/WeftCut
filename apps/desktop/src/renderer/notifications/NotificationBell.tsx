import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { BellIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { useStatusPopover } from "@/components/useStatusPopover";
import { useAgentActivity } from "../agent/activityStore";
import { useUnreviewedCount } from "../agent/reviewStore";
import { useNoticedUpdate } from "../app/updateStatus";
import { UpdateDialog } from "../app/UpdateDialog";
import { getCommand } from "../commands/registry";
import { systemSettingsTarget, type SystemSettingsTarget } from "../components/systemStatus";
import {
  setAppSettings,
  useDismissedNotices,
  useDismissedUpdateVersion,
} from "../settings/appSettingsStore";
import type { AppNotice } from "../../shared/ipc";
import { attentionView, type AttentionItem } from "./attentionView";

interface Props {
  notices: readonly AppNotice[];
  onOpenSettings: (target: SystemSettingsTarget) => void;
  /// `down` in the agent-mode titlebar, where the bell sits at the top.
  placement?: "up" | "down";
}

/// The bell: what needs the user. Colour only — the dot is the most severe
/// item not dismissed, and it counts nothing. Its popover is the notification
/// center. Layout and behaviour: `docs/status-log.md` § Notification center.
export function NotificationBell({ notices, onOpenSettings, placement = "up" }: Props) {
  const { t } = useTranslation();
  const unreviewed = useUnreviewedCount();
  const update = useNoticedUpdate();
  const dismissedNotices = useDismissedNotices();
  const dismissedUpdateVersion = useDismissedUpdateVersion();
  const view = attentionView({ notices, dismissedNotices, unreviewed, update, dismissedUpdateVersion });
  const { open, close, rootRef, detailsId, triggerProps } = useStatusPopover();
  const [updateOpen, setUpdateOpen] = useState(false);

  const label = view.level
    ? t("notifications.bell", { level: t(`notifications.level_${view.level}`) })
    : t("notifications.bell_clear");

  const act = (item: AttentionItem) => {
    close();
    if (item.kind === "review") {
      useAgentActivity.setState({ tab: "changes" });
      void getCommand("openAgentPanel")?.run();
    } else if (item.kind === "update") {
      setUpdateOpen(true);
    } else {
      const target = systemSettingsTarget(item.code);
      if (target) onOpenSettings(target);
    }
  };
  const dismiss = (item: AttentionItem) => {
    const patch = item.kind === "update"
      ? { dismissed_update_version: item.update.version }
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
          {view.active.length === 0 && view.dismissed.length === 0 ? (
            <p className="attention-empty">{t("notifications.empty")}</p>
          ) : (
            <>
              {view.active.length > 0 && (
                <ul className="attention-list">
                  {view.active.map((item) => (
                    <AttentionRow key={item.key} item={item} onAct={act} onDismiss={dismiss} />
                  ))}
                </ul>
              )}
              {view.dismissed.length > 0 && <DismissedFold items={view.dismissed} onAct={act} />}
            </>
          )}
        </section>
      )}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
    </div>
  );
}

function DismissedFold({ items, onAct }: { items: AttentionItem[]; onAct: (item: AttentionItem) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="attention-fold">
      <button
        type="button"
        className="attention-fold-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((was) => !was)}
      >
        {t("notifications.dismissed", { count: items.length })}
        <AppIcon icon={expanded ? ChevronUpIcon : ChevronDownIcon} size="caption" aria-hidden />
      </button>
      {expanded && (
        <ul className="attention-list is-dismissed">
          {items.map((item) => <AttentionRow key={item.key} item={item} onAct={onAct} />)}
        </ul>
      )}
    </div>
  );
}

/// Severity dot · title · one-line description; the primary action is a link
/// at the row's end, dismissal sits under the description. A dismissed row
/// keeps its primary action and loses the dismissal.
function AttentionRow({ item, onAct, onDismiss }: {
  item: AttentionItem;
  onAct: (item: AttentionItem) => void;
  onDismiss?: (item: AttentionItem) => void;
}) {
  const { t } = useTranslation();
  const text = rowText(t, item);
  return (
    <li className={`attention-row level-${item.level}`} data-attention={item.key}>
      <span className="attention-dot" aria-hidden="true" />
      <div className="attention-body">
        <div className="attention-row-title">{text.title}</div>
        {text.body && <div className="attention-row-body">{text.body}</div>}
        {onDismiss && text.dismiss && (
          <div className="attention-row-more">
            <button type="button" className="attention-link is-quiet" onClick={() => onDismiss(item)}>
              {text.dismiss}
            </button>
          </div>
        )}
      </div>
      {text.action && (
        <button type="button" className="attention-link attention-primary" onClick={() => onAct(item)}>
          {text.action}
        </button>
      )}
    </li>
  );
}

function rowText(t: TFunction, item: AttentionItem): {
  title: string;
  body?: string;
  action?: string;
  dismiss?: string;
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
        dismiss: t("updates.later"),
      };
    }
    case "notice":
      return {
        title: t(`app_notice.${item.code}.title`),
        body: t(`app_notice.${item.code}.body`),
        ...(systemSettingsTarget(item.code) ? { action: t("notifications.open_settings") } : {}),
        dismiss: t("app_notice.dismiss"),
      };
  }
}
