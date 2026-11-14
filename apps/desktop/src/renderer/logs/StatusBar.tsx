import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { renderLogMessage } from "./renderMessage";
import { WorkPill } from "./WorkPill";
import { useLogStore } from "./store";
import type { LogEntry, LogLevel } from "../ipc";
import { AppIcon } from "@/components/AppIcon";
import type { ExportState } from "../panels/ExportPanel";
import { NotSavedPill, type SaveFailureActions } from "../components/NotSavedPill";
import { saveFailureReason } from "../components/saveFailure";
import type { NoticeSettingsPage } from "../notifications/appNotices";
import { NotificationBell } from "../notifications/NotificationBell";
import { useSaveFailure } from "../state/saveStatusStore";

/// Persistent status bar pinned to the bottom of the editor view. It answers
/// three questions, one element each: what just happened (the log line, whose
/// leading segment opens the console), what is running (the work pill), what needs me (the
/// bell). Not saved is the one problem with a place of its own.
///
/// Layout and behaviour: `docs/status-log.md`.
interface StatusBarProps {
  onToggleLogs: () => void;
  logsOpen: boolean;
  onOpenSettings: (page: NoticeSettingsPage) => void;
  saveActions: SaveFailureActions;
  /// A running export that leaves the editor usable (preview during export);
  /// a foreground export shows its own dialog instead.
  backgroundExport?: ExportState | undefined;
}

export function StatusBar({
  onToggleLogs,
  logsOpen,
  onOpenSettings,
  saveActions,
  backgroundExport,
}: StatusBarProps) {
  const { t } = useTranslation();
  // Atomic selectors — returning a composite object literal from one
  // selector triggers an infinite useSyncExternalStore loop because each
  // call yields a new reference. Primitive/store-owned references compare
  // stable under the default Object.is equality.
  const latest = useLogStore((s) => s.latest);
  const unseenErrors = useLogStore((s) => s.unseenErrors);
  // The visually-hidden live region is only updated on errors. Tracked
  // separately from `latest` so a flurry of low-severity entries
  // doesn't spam the screen reader.
  const [announce, setAnnounce] = useState("");

  // The unseen count rises with each error; the announcement names the error
  // and the count the log line now shows.
  useEffect(() => {
    if (latest && latest.level === "error") {
      const { unseenErrors: count } = useLogStore.getState();
      const message = `${t("status_bar.announce_error_prefix")}: ${renderLogMessage(latest, t)}`;
      setAnnounce(count > 0 ? `${message}. ${t("status_bar.unseen_errors", { count })}` : message);
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

  const message = latest ? renderLogMessage(latest, t) : t("status_bar.empty");
  const logLabel = [
    unseenErrors > 0 ? t("status_bar.unseen_errors", { count: unseenErrors }) : null,
    message,
    t(logsOpen ? "status_bar.close_log" : "status_bar.open_log"),
  ].filter(Boolean).join(" — ");

  return (
    <footer className="status-bar" aria-label={t("status_bar.label")}>
      <div className="status-bar-left">
        {/* The line's leading segment opens the log: a target whose width
            does not follow the message. The message itself only reads. */}
        <button
          type="button"
          className="status-bar-log"
          data-testid="status-bar-log"
          onClick={onToggleLogs}
          aria-expanded={logsOpen}
          aria-label={logLabel}
          title={t(logsOpen ? "status_bar.close_log" : "status_bar.open_log")}
        >
          {unseenErrors > 0 ? (
            <span className="status-bar-errors" data-testid="status-bar-errors" aria-hidden="true">
              {unseenErrors}
            </span>
          ) : latest ? (
            <LevelDot level={latest.level} />
          ) : null}
          {latest && (
            <>
              <span className="status-bar-time">{formatTime(latest.ts)}</span>
              {/* Before the message, as the console row has it. */}
              <SourcePill entry={latest} />
            </>
          )}
          <AppIcon
            icon={logsOpen ? ChevronDownIcon : ChevronUpIcon}
            size="caption"
            className="status-bar-log-chevron"
            aria-hidden
          />
        </button>
        <span
          className={latest ? "status-bar-message" : "status-bar-message status-bar-empty"}
          title={message}
        >
          {message}
        </span>
      </div>
      <div className="status-bar-right">
        <WorkPill backgroundExport={backgroundExport} />
        <NotSavedPill actions={saveActions} />
        <span className="status-bar-divider" aria-hidden="true" />
        <NotificationBell onOpenSettings={onOpenSettings} />
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

function LevelDot({ level }: { level: LogLevel }) {
  return (
    <span
      className={`status-bar-level-dot level-${level}`}
      aria-hidden="true"
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
