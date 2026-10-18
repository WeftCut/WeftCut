// The renderer's mirror of main's clip-compute job registry (ADR 0121): every
// running `transcribe_clip` / `describe_clip` job, human or agent, and the ones
// that ended lately. State and selectors only — what to draw from it is the
// panels' business.
//
// Every update carries the whole running set (it is small), so the mirror needs
// no gap repair: an update newer than what is held replaces it. `ended` and the
// request index outlive the job, because a run reads its job id AFTER its call
// returns, by when the job has left the running set.

import { create } from "zustand";
import { listen } from "@/bridge/events";
import {
  COMPUTE_JOBS_EVENT,
  computeJobsSnapshot,
  type ComputeJob,
  type ComputeJobEnded,
  type ComputeJobsSnapshot,
  type ComputeJobsUpdate,
  type ComputeTool,
} from "../ipc";

/// How many ended jobs (and request tags) are kept — enough for a completion
/// notice and a run's own late read, not a history.
export const ENDED_CAPACITY = 50;

export interface ComputeJobsState {
  revision: number;
  /// Running jobs by id.
  jobs: Record<string, ComputeJob>;
  /// The most recent ended jobs, oldest first.
  ended: ComputeJobEnded[];
  /// A human call's `request_id` → the job it started or joined.
  requests: Record<string, string>;
}

const EMPTY: ComputeJobsState = { revision: -1, jobs: {}, ended: [], requests: {} };

/// Pure: fold a snapshot or update into the mirror. A stale one (not newer
/// than what is held) is ignored, so a late initial snapshot cannot undo an
/// event that overtook it.
export function reduceComputeJobs(
  state: ComputeJobsState,
  update: ComputeJobsSnapshot | ComputeJobsUpdate,
): ComputeJobsState {
  if (update.revision <= state.revision) return state;
  const ended = "ended" in update ? update.ended : [];
  const jobs: Record<string, ComputeJob> = {};
  for (const job of update.jobs) jobs[job.job_id] = job;
  const requests = { ...state.requests };
  for (const job of [...update.jobs, ...ended.map((e) => e.job)]) {
    for (const id of job.request_ids) requests[id] = job.job_id;
  }
  const keptEnded = ended.length ? [...state.ended, ...ended].slice(-ENDED_CAPACITY) : state.ended;
  // The request index is bounded by the jobs it can still point at.
  const live = new Set([...Object.keys(jobs), ...keptEnded.map((e) => e.job.job_id)]);
  for (const [request, job] of Object.entries(requests)) if (!live.has(job)) delete requests[request];
  return { revision: update.revision, jobs, ended: keptEnded, requests };
}

export const useComputeJobsStore = create<ComputeJobsState>(() => EMPTY);

export function receiveComputeJobs(update: ComputeJobsSnapshot | ComputeJobsUpdate): void {
  useComputeJobsStore.setState((s) => reduceComputeJobs(s, update));
}

// ---- Selectors (pure over the state, so commands and hooks share them) ----

/// The running job a call tagged `requestId` started or joined, or null.
export function jobForRequest(s: ComputeJobsState, requestId: string): ComputeJob | null {
  const id = s.requests[requestId];
  return id === undefined ? null : s.jobs[id] ?? null;
}

/// The job id a tagged call ran under, running or ended — null when the call
/// never reached the registry (an unresolved clip runs as a plain call).
export function jobIdForRequest(s: ComputeJobsState, requestId: string): string | null {
  return s.requests[requestId] ?? null;
}

/// The running job over `layerId` — within `window` when one is given (any
/// overlap), any of its windows otherwise. `tool` narrows it. The first found
/// when several overlap.
export function jobForLayer(
  s: ComputeJobsState,
  layerId: string,
  opts: { tool?: ComputeTool; window?: { t_start_us: number; t_end_us: number } } = {},
): ComputeJob | null {
  for (const job of Object.values(s.jobs)) {
    if (job.layer_id !== layerId) continue;
    if (opts.tool !== undefined && job.tool !== opts.tool) continue;
    const w = opts.window;
    if (w && !(job.window.t_start_us < w.t_end_us && job.window.t_end_us > w.t_start_us)) continue;
    return job;
  }
  return null;
}

/// Every running job reading `mediaId`, oldest first.
export function jobsForMedia(s: ComputeJobsState, mediaId: string): ComputeJob[] {
  return Object.values(s.jobs)
    .filter((j) => j.media_id === mediaId)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/// Whether any `tool` job is running, whoever started it.
export function anyRunning(s: ComputeJobsState, tool: ComputeTool): boolean {
  return Object.values(s.jobs).some((j) => j.tool === tool);
}

// ---- Hooks: each yields one stable reference per change ----

export const useComputeJobForRequest = (requestId: string | null): ComputeJob | null =>
  useComputeJobsStore((s) => (requestId === null ? null : jobForRequest(s, requestId)));

export const useComputeJobForLayer = (
  layerId: string | null,
  tool?: ComputeTool,
): ComputeJob | null =>
  useComputeJobsStore((s) => (layerId === null ? null : jobForLayer(s, layerId, tool ? { tool } : {})));

export const useAnyComputeRunning = (tool: ComputeTool): boolean =>
  useComputeJobsStore((s) => anyRunning(s, tool));

/// Subscribe before the snapshot, so an event cannot fall between them; the
/// reducer's revision check keeps whichever is newer.
export async function wireComputeJobs(): Promise<() => void> {
  let disposed = false;
  const stop = await listen<ComputeJobsUpdate>(COMPUTE_JOBS_EVENT, (e) => {
    if (!disposed) receiveComputeJobs(e.payload);
  });
  try {
    const snapshot = await computeJobsSnapshot();
    if (!disposed) receiveComputeJobs(snapshot);
  } catch {
    /* the next event carries the whole running set anyway */
  }
  return () => {
    disposed = true;
    stop();
  };
}
