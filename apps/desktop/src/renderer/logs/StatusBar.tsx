import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangleIcon, Hourglass, InfoIcon, OctagonAlertIcon } from "lucide-react";
import type { TFunction } from "i18next";
import { listen, type UnlistenFn } from "@/bridge/events";
import { renderLogMessage } from "./renderMessage";
import { useAgentActivity } from "../agent/activityStore";
import { useUnreviewedCount } from "../agent/reviewStore";
import { getCommand } from "../commands/registry";
import { useLogStore } from "./store";
import { MEDIA_JOB_EVENTS, type MediaJobEvent, type LogEntry, type LogLevel } from "../ipc";
import type { AppNotice } from "../../shared/ipc";
import { AppIcon } from "@/components/AppIcon";
import { UpdateIndicator } from "../app/UpdateIndicator";
import { ExportProgressPill } from "../panels/ExportProgressPill";
import type { ExportState } from "../panels/ExportPanel";
import { SaveStatusBadge } from "../components/SaveStatusBadge";
import { saveFailureReason } from "../components/saveFailure";
import { useSaveFailure } from "../state/saveStatusStore";
import { useComputeJobsStore } from "../compute/computeJobsStore";
import {
  computePhaseText,
  computeToolLabel,
  formatComputeDuration,
  isWaiting,
  phaseAgeMs,
  stalledForMs,
} from "../compute/computeJobView";
import { useNow } from "../hooks/useNow";
import { useProjectStore } from "../state/projectStore";
import { layerDisplayName } from "../lib/layerName";
import type { ComputeJob, LayerSummary } from "../ipc";

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
  const runningCount = useLogStore((s) =>
    Object.keys(s.runningOps).length,
  );
  // Activity liveness survives diagnostic log clearing and eviction.
  const agentRunningCount = useAgentActivity(s =>
    s.snapshot?.activities.filter(a => a.state === "running").length ?? 0,
  );
  // Unreviewed agent changes (ADR 0115). The status bar is a review surface
  // of its own: it keeps the Review view fresh while the editor shows.
  const unreviewedCount = useUnreviewedCount();
  // Track identities: adopting a cached file emits completion without starting
  // processing, and must not decrement another media item's running job.
  const [derivativeJobs, setDerivativeJobs] = useState<ReadonlySet<string>>(() => new Set());
  const pendingDerivatives = derivativeJobs.size;
  // The visually-hidden live region is only updated on errors. Tracked
  // separately from `latest` so a flurry of low-severity entries
  // doesn't spam the screen reader.
  const [announce, setAnnounce] = useState("");
  // A clip job queued on the processing budget is usually waiting for the
  // derivatives this bar counts; their pill says so
  // (docs/performance-settings.md#admission-lanes).
  const budgetBlocked = useComputeJobsStore((s) =>
    Object.values(s.jobs).some((j) => j.phase.kind === "queued" && j.phase.reason === "budget"),
  );

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

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    const updateJob = (job: MediaJobEvent, started: boolean) => {
      const key = `${job.media_id}:${job.kind}`;
      setDerivativeJobs((jobs) => {
        if (jobs.has(key) === started) return jobs;
        const next = new Set(jobs);
        if (started) next.add(key);
        else next.delete(key);
        return next;
      });
    };
    (async () => {
      const [onStarted, onComplete, onError] = await Promise.all([
        listen<MediaJobEvent>(MEDIA_JOB_EVENTS.started, (e) => {
          updateJob(e.payload, true);
        }),
        listen<MediaJobEvent>(MEDIA_JOB_EVENTS.complete, (e) => {
          updateJob(e.payload, false);
        }),
        listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => {
          updateJob(e.payload, false);
        }),
      ]);
      if (cancelled) {
        onStarted();
        onComplete();
        onError();
        return;
      }
      unlisteners.push(onStarted, onComplete, onError);
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  const logsHint = errorCount > 0
    ? t("status_bar.toggle_hint_errors", { count: errorCount })
    : t("status_bar.toggle_hint");

  return (
    <footer
      className="status-bar"
      role="status"
      aria-label={t("status_bar.label")}
    >
      <div className="status-bar-left">
        {latest ? (
          <>
            <LevelDot level={latest.level} />
            <span className="status-bar-time">{formatTime(latest.ts)}</span>
            <span
              className="status-bar-message"
              title={renderLogMessage(latest, t)}
            >
              {renderLogMessage(latest, t)}
            </span>
            <SourcePill entry={latest} />
          </>
        ) : (
          <span className="status-bar-empty">{t("status_bar.empty")}</span>
        )}
      </div>
      <div className="status-bar-right">
        {backgroundExport && <ExportProgressPill state={backgroundExport} />}
        {pendingDerivatives > 0 && (
          <span
            className="derivatives-pill"
            title={budgetBlocked
              ? `${t("project.derivatives_pending_hint")}\n${t("compute.ui.derivatives_blocking")}`
              : t("project.derivatives_pending_hint")}
          >
            <span className="derivatives-pill-spinner" aria-hidden="true" />
            {t("project.derivatives_pending", { count: pendingDerivatives })}
          </span>
        )}
        <ComputeJobsPill onOpenLogs={onToggleLogs} />
        {agentRunningCount > 0 && (
          <span
            className="agent-running-pill"
            title={t("agent_mode.running_pill_hint")}
          >
            <span className="agent-running-spinner" aria-hidden="true" />
            {t("agent_mode.running_pill", { count: agentRunningCount })}
          </span>
        )}
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
        {runningCount > 0 && (
          <button
            type="button"
            className="status-bar-badge status-bar-badge-running"
            onClick={onToggleLogs}
            title={t("status_bar.running_badge_hint", { count: runningCount })}
            aria-label={t("status_bar.running_badge_hint", { count: runningCount })}
          >
            <span className="status-bar-spinner" aria-hidden="true" />
            {runningCount}
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
            {notices.length}
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

/// Running clip-compute jobs, human and agent (ADR 0121). Waiting is not
/// working: when every job is queued for admission the pill shows an
/// hourglass instead of the spinner. The title lists each job's clip and
/// phase; a click opens the agent panel when an agent's job is among them
/// (its Activity row has Cancel), else the log, where a person's run is.
function ComputeJobsPill({ onOpenLogs }: { onOpenLogs?: (() => void) | undefined }) {
  const jobsById = useComputeJobsStore((s) => s.jobs);
  const jobs = Object.values(jobsById);
  // The clock only runs while a job does.
  return jobs.length === 0 ? null : <ComputeJobsPillBody jobs={jobs} onOpenLogs={onOpenLogs} />;
}

function ComputeJobsPillBody({ jobs: unordered, onOpenLogs }: { jobs: ComputeJob[]; onOpenLogs?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const layers = useProjectStore((s) => s.layerById);
  const now = useNow();
  const jobs = [...unordered].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const waiting = jobs.every((j) => isWaiting(j.phase));
  const [only] = jobs;
  const text = waiting
    ? t("compute.ui.pill_waiting", { count: jobs.length })
    : jobs.length === 1 && only
      ? t(only.tool === "transcribe_clip" ? "compute.ui.pill_transcribing" : "compute.ui.pill_describing")
      : t("compute.ui.pill_many", { count: jobs.length });
  const lines = jobs.map((job) => jobLine(t, job, layers.get(job.layer_id), now));
  const agent = jobs.some((j) => j.origin.kind === "agent");
  const title = [...lines, t("compute.ui.pill_hint")].join("\n");
  return (
    <button
      type="button"
      className={`status-bar-badge compute-jobs-pill${waiting ? " is-waiting" : ""}`}
      data-testid="status-bar-compute"
      data-state={waiting ? "waiting" : "working"}
      title={title}
      aria-label={[text, ...lines].join(". ")}
      onClick={() => {
        if (agent) {
          useAgentActivity.setState({ tab: "activity" });
          void getCommand("openAgentPanel")?.run();
        } else onOpenLogs?.();
      }}
    >
      {waiting
        ? <AppIcon icon={Hourglass} size="label" aria-hidden />
        : <span className="status-bar-spinner" aria-hidden="true" />}
      {text}
    </button>
  );
}

/// One job in the pill's title: the tool, the clip, and what it is doing.
function jobLine(t: TFunction, job: ComputeJob, layer: LayerSummary | undefined, now: number): string {
  const tool = computeToolLabel(t, job.tool);
  const parts = [computePhaseText(t, job.tool, job.phase, { detail: true })];
  const age = phaseAgeMs(job, now);
  if (isWaiting(job.phase) && age >= 1000) parts.push(t("compute.ui.waited", { duration: formatComputeDuration(t, age) }));
  const stalled = stalledForMs(job, now);
  if (stalled !== null) parts.push(t("compute.ui.stalled", { duration: formatComputeDuration(t, stalled) }));
  if (job.caller_disconnected) parts.push(t("compute.ui.caller_disconnected"));
  const phase = parts.join(" · ");
  return layer
    ? t("compute.ui.pill_line", { tool, clip: layerDisplayName(layer, t), phase })
    : t("compute.ui.pill_line_unnamed", { tool, phase });
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
