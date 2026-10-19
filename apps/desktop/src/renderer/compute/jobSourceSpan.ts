// A job's window in SOURCE time — the domain the Shots Panel's rows and the
// description cache share. A job carries its window on the timeline of the
// layer its first caller named, which need not be the clip a panel shows: an
// agent can describe the same source through another clip. Mapping through
// that layer's own timing is what lets a row light up for any job reading the
// stretch of the source it covers.

import { contentAtUs, type TimedParams } from "../layerTiming";
import type { ComputeJob, ComputeTool, LayerSummary } from "../ipc";
import type { ComputeJobsState } from "./computeJobsStore";

/// The source span `[srcStartUs, srcEndUs)` the job reads through `layer`.
export function jobSourceSpan(
  job: Pick<ComputeJob, "window">,
  layer: Pick<LayerSummary, "t_start_us" | "params">,
): { srcStartUs: number; srcEndUs: number } {
  const params = layer.params as TimedParams;
  const a = contentAtUs(params, job.window.t_start_us - layer.t_start_us);
  const b = contentAtUs(params, job.window.t_end_us - layer.t_start_us);
  return { srcStartUs: Math.min(a, b), srcEndUs: Math.max(a, b) };
}

/// The oldest running `tool` job on `mediaId` whose source span overlaps
/// `[srcStartUs, srcEndUs)` — the same half-open intersection the rows find
/// prose by. A job whose layer the summary no longer has is skipped: its span
/// cannot be placed.
export function jobOverSourceSpan(
  s: ComputeJobsState,
  layerById: ReadonlyMap<string, LayerSummary>,
  q: { tool: ComputeTool; mediaId: string; srcStartUs: number; srcEndUs: number },
): ComputeJob | null {
  let found: ComputeJob | null = null;
  for (const job of Object.values(s.jobs)) {
    if (job.tool !== q.tool || job.media_id !== q.mediaId) continue;
    const layer = layerById.get(job.layer_id);
    if (!layer) continue;
    const span = jobSourceSpan(job, layer);
    if (!(span.srcStartUs < q.srcEndUs && span.srcEndUs > q.srcStartUs)) continue;
    if (found === null || job.started_at < found.started_at) found = job;
  }
  return found;
}

/// The running `tool` jobs on `mediaId` that no span in `spans` would show —
/// the ones a panel listing per-span status has nowhere to put: a source never
/// scanned for shots has no rows at all, a scan may find none, and a job may
/// read a stretch outside every row. A job whose layer the summary no longer
/// has cannot be placed on any span, so it is listed too. Oldest first.
export function jobsOutsideSpans(
  s: ComputeJobsState,
  layerById: ReadonlyMap<string, LayerSummary>,
  q: { tool: ComputeTool; mediaId: string; spans: readonly { srcStartUs: number; srcEndUs: number }[] },
): ComputeJob[] {
  return Object.values(s.jobs)
    .filter((job) => {
      if (job.tool !== q.tool || job.media_id !== q.mediaId) return false;
      const layer = layerById.get(job.layer_id);
      if (!layer) return true;
      const span = jobSourceSpan(job, layer);
      return !q.spans.some((r) => span.srcStartUs < r.srcEndUs && span.srcEndUs > r.srcStartUs);
    })
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}
