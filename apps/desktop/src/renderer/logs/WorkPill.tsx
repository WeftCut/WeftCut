import { useEffect, useReducer, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Hourglass } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { useStatusPopover } from "@/components/useStatusPopover";
import { useAgentActivity } from "../agent/activityStore";
import { getCommand } from "../commands/registry";
import { ComputeJobStatus } from "../compute/ComputeJobStatus";
import { computeToolLabel, formatComputeDuration } from "../compute/computeJobView";
import { useComputeJobsStore } from "../compute/computeJobsStore";
import { useNow } from "../hooks/useNow";
import { layerDisplayName } from "../lib/layerName";
import { useDerivativeJobsStore } from "../state/derivativeJobsStore";
import { useProjectStore } from "../state/projectStore";
import type { AgentActivity } from "../../shared/agent-activity";
import type { ComputeJob } from "../../shared/compute-jobs";
import { workView, type MediaWork, type WorkView } from "./workView";

/// Background work in the status bar: clip-compute jobs, agent calls and
/// derivative jobs as one pill, its details in a popover grouped by owner. The
/// export keeps its own pill. Layout and behaviour: `docs/status-log.md`.
export function WorkPill() {
  const { t } = useTranslation();
  const jobsById = useComputeJobsStore((s) => s.jobs);
  const activities = useAgentActivity((s) => s.snapshot?.activities);
  const derivativeJobs = useDerivativeJobsStore((s) => s.jobs);
  // Work held back by the show delay comes due without a store change: one
  // re-render at that moment, no standing clock.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const view = workView({
    jobs: Object.values(jobsById),
    activities: activities ?? [],
    derivatives: Object.values(derivativeJobs),
    now: Date.now(),
  });
  useEffect(() => {
    if (view.nextDueAt === null) return;
    const timer = setTimeout(rerender, Math.max(0, view.nextDueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [view.nextDueAt]);

  const { open, close, rootRef, detailsId, triggerProps } = useStatusPopover();
  // The popover goes with the last piece of work, and does not come back open.
  useEffect(() => {
    if (view.count === 0) close();
  }, [view.count, close]);
  if (view.count === 0) return null;

  const label = pillLabel(t, view);
  return (
    <div className="status-popover-anchor" ref={rootRef}>
      <button
        {...triggerProps}
        type="button"
        className={`status-bar-badge work-pill-trigger${view.waiting ? " is-waiting" : ""}`}
        data-testid="status-bar-work"
        data-state={view.waiting ? "waiting" : "working"}
        title={label}
      >
        {view.waiting
          ? <AppIcon icon={Hourglass} size="label" aria-hidden />
          : <span className="status-bar-spinner" aria-hidden="true" />}
        {label}
      </button>
      {open && (
        <section id={detailsId} className="status-popover work-pill-details" aria-label={t("status_bar.work.title")}>
          <WorkDetails view={view} onLeave={close} />
        </section>
      )}
    </div>
  );
}

/// One piece of work is named by what it does; several are counted.
function pillLabel(t: TFunction, view: WorkView): string {
  if (view.waiting) return t("status_bar.work.waiting", { count: view.count });
  if (view.count > 1) return t("status_bar.work.many", { count: view.count });
  const [job] = view.compute;
  if (job) return t(job.tool === "transcribe_clip" ? "status_bar.work.transcribing" : "status_bar.work.describing");
  return t(view.agent.length > 0 ? "status_bar.work.agent" : "status_bar.work.derivatives");
}

/// Split out so the one-second clock only runs while the popover is open.
function WorkDetails({ view, onLeave }: { view: WorkView; onLeave: () => void }) {
  const { t } = useTranslation();
  const openActivity = () => {
    onLeave();
    useAgentActivity.setState({ tab: "activity" });
    void getCommand("openAgentPanel")?.run();
  };
  return (
    <>
      {view.compute.length > 0 && (
        <WorkGroup title={t("status_bar.work.group_compute")}>
          {view.compute.map((job) => <ComputeRow key={job.job_id} job={job} />)}
        </WorkGroup>
      )}
      {view.agent.length > 0 && (
        <WorkGroup
          title={t("status_bar.work.group_agent")}
          action={<button type="button" className="work-group-link" onClick={openActivity}>{t("status_bar.work.open_agent_panel")}</button>}
        >
          {view.agent.map((activity) => <AgentRow key={activity.id} activity={activity} />)}
        </WorkGroup>
      )}
      {view.derivatives.length > 0 && (
        <WorkGroup title={t("status_bar.work.group_derivatives")}>
          {view.derivatives.map((media) => <MediaRow key={media.media_id} media={media} />)}
        </WorkGroup>
      )}
    </>
  );
}

/// The header names the kind of work, so rows carry no icon of their own; the
/// one icon in a row is a clip job's state (working or waiting).
function WorkGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="work-group" role="group" aria-label={title}>
      <h3 className="work-group-header"><span>{title}</span>{action}</h3>
      <ul className="work-rows">{children}</ul>
    </div>
  );
}

/// The job's clip and tool, the agent that asked when one did, then its live
/// status with Cancel, the same control the Activity row and the clip carry.
function ComputeRow({ job }: { job: ComputeJob }) {
  const { t } = useTranslation();
  const layer = useProjectStore((s) => s.layerById.get(job.layer_id));
  const media = useProjectStore((s) => s.mediaById.get(job.media_id));
  const clip = layer ? layerDisplayName(layer, t) : media?.label ?? t("status_bar.work.media_unnamed");
  return (
    <li className="work-row" data-work="compute">
      <div className="work-row-line">
        <span className="work-row-name">{t("status_bar.work.job_name", { tool: computeToolLabel(t, job.tool), clip })}</span>
        {job.origin.kind === "agent" && <span className="work-row-client">{job.origin.client}</span>}
      </div>
      <ComputeJobStatus job={job} variant="inline" />
    </li>
  );
}

function AgentRow({ activity }: { activity: AgentActivity }) {
  const { t } = useTranslation();
  const now = useNow();
  const started = Date.parse(activity.started_at);
  return (
    <li className="work-row" data-work="agent">
      <div className="work-row-line">
        <span className="work-row-name">{`${activity.client} · ${activity.tool}`}</span>
        {!Number.isNaN(started) && (
          <span className="work-row-elapsed">{formatComputeDuration(t, Math.max(0, now - started))}</span>
        )}
      </div>
    </li>
  );
}

function MediaRow({ media }: { media: MediaWork }) {
  const { t } = useTranslation();
  const item = useProjectStore((s) => s.mediaById.get(media.media_id));
  const kinds = [...new Set(media.kinds.map((kind) => derivativeKindLabel(t, kind)))].join(" · ");
  return (
    <li className="work-row" data-work="derivatives">
      <div className="work-row-line">
        <span className="work-row-name">{item?.label ?? t("status_bar.work.media_unnamed")}</span>
      </div>
      <div className="work-row-detail">{kinds}</div>
    </li>
  );
}

/// The proxy variants read as one kind, as the export's wait copy names them
/// (`app/exportRunner.ts`). A kind this build does not know shows as sent.
function derivativeKindLabel(t: TFunction, kind: string): string {
  switch (kind) {
    case "proxy":
    case "quick_proxy":
    case "proxy_bypass": return t("status_bar.work.kind_proxy");
    case "thumbnails": return t("status_bar.work.kind_thumbnails");
    case "waveform": return t("status_bar.work.kind_waveform");
    case "conform": return t("status_bar.work.kind_conform");
    case "audio_fx": return t("status_bar.work.kind_audio_fx");
    default: return kind;
  }
}
