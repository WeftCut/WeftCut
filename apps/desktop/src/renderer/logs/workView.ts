// What the status bar's work pill shows: background work grouped by what owns
// it — clip-compute jobs, agent calls, derivative jobs per media item. Pure, so
// counting, de-duplication and the show delay are tested without a renderer.
//
// One piece of work is one row. An agent call that runs a clip-compute job is
// that job's row (tagged with the agent), never a second row under the agent.

import type { AgentActivity } from "../../shared/agent-activity";
import type { ComputeJob } from "../../shared/compute-jobs";
import { isWaiting } from "../compute/computeJobView";
import type { DerivativeJob } from "../state/derivativeJobsStore";

/// Work shows once it has run this long, the log's own threshold for "worth a
/// row" (docs/status-log.md § Producers): an agent's quick reads never flash.
export const WORK_SHOW_AFTER_MS = 250;

export interface MediaWork {
  media_id: string;
  /// The derivative kinds running for this item, in start order.
  kinds: string[];
}

export interface WorkView {
  compute: ComputeJob[];
  agent: AgentActivity[];
  derivatives: MediaWork[];
  /// Rows across the groups.
  count: number;
  /// Every row is queued for admission: the pill shows waiting, not work.
  waiting: boolean;
  /// When the next hidden piece of work comes due, for one re-render then;
  /// `null` when nothing is held back.
  nextDueAt: number | null;
}

export interface WorkInput {
  jobs: readonly ComputeJob[];
  activities: readonly AgentActivity[];
  derivatives: readonly DerivativeJob[];
  now: number;
}

/// An unparsable stamp shows at once: holding back work forever is worse than
/// a flash.
const startOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

export function workView({ jobs, activities, derivatives, now }: WorkInput): WorkView {
  let nextDueAt: number | null = null;
  const due = (since: number): boolean => {
    const at = since + WORK_SHOW_AFTER_MS;
    if (at <= now) return true;
    nextDueAt = nextDueAt === null ? at : Math.min(nextDueAt, at);
    return false;
  };

  const compute = jobs
    .filter((job) => due(startOf(job.started_at)))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  // A call whose job is live is that job's row. Its job id is checked against
  // every live job, shown or not, so a call never surfaces under the agent
  // while its job waits out the delay.
  const liveJobs = new Set(jobs.map((job) => job.job_id));
  const agent = activities
    .filter((a) => a.state === "running" && !(a.compute && liveJobs.has(a.compute.job_id)))
    .filter((a) => due(startOf(a.started_at)))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  // One row per media item, shown once its oldest job is due.
  const byMedia = new Map<string, DerivativeJob[]>();
  for (const job of [...derivatives].sort((a, b) => a.since - b.since)) {
    const list = byMedia.get(job.media_id);
    if (list) list.push(job);
    else byMedia.set(job.media_id, [job]);
  }
  const derivativeRows: MediaWork[] = [];
  for (const [media_id, list] of byMedia) {
    if (due(list[0]!.since)) derivativeRows.push({ media_id, kinds: list.map((job) => job.kind) });
  }

  const count = compute.length + agent.length + derivativeRows.length;
  const waiting = count > 0 && agent.length === 0 && derivativeRows.length === 0
    && compute.every((job) => isWaiting(job.phase));
  return { compute, agent, derivatives: derivativeRows, count, waiting, nextDueAt };
}
