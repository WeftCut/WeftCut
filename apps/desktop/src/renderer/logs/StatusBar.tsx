import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangleIcon, InfoIcon, OctagonAlertIcon } from "lucide-react";
import { renderLogMessage } from "./renderMessage";
import { WorkPill } from "./WorkPill";
import { useAgentActivity } from "../agent/activityStore";
import { useUnreviewedCount } from "../agent/reviewStore";
import { getCommand } from "../commands/registry";
import { useLogStore } from "./store";
import type { LogEntry, LogLevel } from "../ipc";
import type { AppNotice } from "../../shared/ipc";
import { AppIcon } from "@/components/AppIcon";
import { UpdateIndicator } from "../app/UpdateIndicator";
import { ExportProgressPill } from "../panels/ExportProgressPill";
import type { ExportState } from "../panels/ExportPanel";
import { SaveStatusBadge } from "../components/SaveStatusBadge";
import { saveFailureReason } from "../components/saveFailure";
import { useSaveFailure } from "../state/saveStatusStore";
import { useDerivativeJobsStore } from "../state/derivativeJobsStore";

/// Persistent status bar pinned to the bottom of the editor view.
/// Shows a severity dot + time + truncated message + source pill on the
/// left; work and attention badges + the Logs toggle on the right. The
/// toggle opens the expanded console overlay and carries the error count.
///
/// Layout and behaviour: `docs/status-log.md`.
interface StatusBarProps {
  notices?: AppNotice[];
  onOpenSystemStatus?: () => void;
  /// Opens (never toggles) the System panel, whose card the badge points at.
  onOpenSaveStatus?: () => void;
  onToggleLogs?: () => void;
  /// A running export that leaves the editor usable (preview during export);
  /// a foreground export shows its own dialog instead.
  backgroundExport?: ExportState | undefined;
}

const EMPTY_NOTICES: AppNotice[] = [];

export function StatusBar({
  notices = EMPTY_NOTICES,
  onOpenSystemStatus,
  onOpenSaveStatus,
  onToggleLogs,
  backgroundExport,
}: StatusBarProps) {
  const { t } = useTranslation();
  // Atomic selectors — returning a composite object literal from one
  // selector triggers an infinite useSyncExternalStore loop because each
  // call yields a new reference. Primitive/store-owned references compare
  // stable under the default Object.is equality.
  const latest = useLogStore((s) => s.latest);
  const errorCount = useLogStore((s) => s.errorCount);
  // Unreviewed agent changes (ADR 0115). The status bar is a review surface
  // of its own: it keeps the Review view fresh while the editor shows.
  const unreviewedCount = useUnreviewedCount();
  // The visually-hidden live region is only updated on errors. Tracked
  // separately from `latest` so a flurry of low-severity entries
  // doesn't spam the screen reader.
  const [announce, setAnnounce] = useState("");
  // Bench scripts read the derivative queue here, not from the work pill:
  // the pill holds work back for its show delay.
  const derivativeJobs = useDerivativeJobsStore((s) => Object.keys(s.jobs).length);

  useEffect(() => {
    if (latest && latest.level === "error") {
      setAnnounce(
        `${t("status_bar.announce_error_prefix")}: ${renderLogMessage(latest, t)}`,
      );
    }
  }, [latest, t]);

  // Its log row is a Warn, which the effect above does not announce: the turn
  // to failing is announced here, once per turn — a new reason is not a turn.
  const saveFailure = useSaveFailure();
  const saveFailureAnnounced = useRef(false);
  useEffect(() => {
    if (saveFailure && !saveFailureAnnounced.current) {
      setAnnounce(t("save_status.announce", { reason: saveFailureReason(t, saveFailure.code) }));
    }
    saveFailureAnnounced.current = saveFailure !== null;
  }, [saveFailure, t]);

  const logsHint = errorCount > 0
    ? t("status_bar.toggle_hint_errors", { count: errorCount })
    : t("status_bar.toggle_hint");

  return (
    <footer
      className="status-bar"
      data-derivative-jobs={derivativeJobs}
      role="status"
      aria-label={t("status_bar.label")}
    >
      <div className="status-bar-left">
        {latest ? (
          <>
            <LevelDot level={latest.level} />
            <span className="status-bar-time">{formatTime(latest.ts)}</span>
            {/* Before the message, as the console row has it: after it, the
                message's flex pushed the pill against the right-side badges. */}
            <SourcePill entry={latest} />
            <span
              className="status-bar-message"
              title={renderLogMessage(latest, t)}
            >
              {renderLogMessage(latest, t)}
            </span>
          </>
        ) : (
          <span className="status-bar-empty">{t("status_bar.empty")}</span>
        )}
      </div>
      <div className="status-bar-right">
        {backgroundExport && <ExportProgressPill state={backgroundExport} />}
        <WorkPill />
        {unreviewedCount > 0 && (
          <button
            type="button"
            className="status-bar-badge status-bar-badge-review"
            data-testid="status-bar-review"
            onClick={() => {
              useAgentActivity.setState({ tab: "changes" });
              void getCommand("openAgentPanel")?.run();
            }}
            title={t("changes.status_hint", { count: unreviewedCount })}
            aria-label={t("changes.status_hint", { count: unreviewedCount })}
          >
            {t("changes.status", { count: unreviewedCount })}
          </button>
        )}
        <SaveStatusBadge onOpen={onOpenSaveStatus} />
        {notices.length > 0 && onOpenSystemStatus && (
          <button
            type="button"
            className={`system-status-trigger system-status-${highestNoticeLevel(notices)}`}
            onClick={onOpenSystemStatus}
            title={t("system_status.trigger_hint", { count: notices.length })}
            aria-label={t("system_status.trigger_hint", { count: notices.length })}
          >
            <SystemNoticeIcon level={highestNoticeLevel(notices)} />
            {t("system_status.trigger", { count: notices.length })}
          </button>
        )}
        <UpdateIndicator />
        {/* Errors open the log, so their count rides on its toggle rather
            than a badge of its own; it stays until the log is cleared. */}
        <button
          type="button"
          className="status-bar-logs-toggle"
          onClick={onToggleLogs}
          title={logsHint}
          aria-label={logsHint}
          disabled={!onToggleLogs}
        >
          {t("status_bar.toggle_label")}
          {errorCount > 0 && (
            <span className="status-bar-logs-errors" data-testid="status-bar-errors" aria-hidden="true">
              <AppIcon icon={OctagonAlertIcon} size="label" aria-hidden />
              {errorCount}
            </span>
          )}
        </button>
      </div>
      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        role="status"
      >
        {announce}
      </div>
    </footer>
  );
}

function highestNoticeLevel(notices: AppNotice[]): AppNotice["level"] {
  if (notices.some((notice) => notice.level === "error")) return "error";
  if (notices.some((notice) => notice.level === "warn")) return "warn";
  return "info";
}

function SystemNoticeIcon({ level }: { level: AppNotice["level"] }) {
  if (level === "error") return <AppIcon icon={OctagonAlertIcon} size="label" aria-hidden />;
  if (level === "warn") return <AppIcon icon={AlertTriangleIcon} size="label" aria-hidden />;
  return <AppIcon icon={InfoIcon} size="label" aria-hidden />;
}

function LevelDot({ level }: { level: LogLevel }) {
  return (
    <span
      className={`status-bar-level-dot level-${level}`}
      aria-hidden="true"
      title={level}
    />
  );
}

function SourcePill({ entry }: { entry: LogEntry }) {
  const { t } = useTranslation();
  const kind = entry.source.kind;
  let label: string;
  if (kind === "User") {
    label = t("status_bar.source_user");
  } else if (kind === "Agent") {
    label = t("status_bar.source_agent", { client: entry.source.client });
  } else {
    label = t("status_bar.source_system");
  }
  return (
    <span className={`status-bar-source source-${kind.toLowerCase()}`}>
      {label}
    </span>
  );
}

/// HH:MM:SS in the user's locale.
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
