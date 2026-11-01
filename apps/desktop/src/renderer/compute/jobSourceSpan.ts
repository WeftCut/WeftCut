// A job's window in SOURCE time — the domain the Shots Panel's rows and the
// description cache share. A job carries its window on the timeline of the
// layer its first caller named, which need not be the clip a panel shows: an
// agent can describe the same source through another clip. Mapping through
// that layer's own timing is what lets a row light up for any job reading the
// stretch of the source it covers.

import { contentAtUs, type TimedParams } from "../layerTiming";
import type { ComputeJob, LayerSummary } from "../ipc";
import type { DescriptionPurpose } from "../../shared/description";
import type { ComputeJobsState } from "./computeJobsStore";

// A description consumer must name its purpose; tool + span is insufficient.
type SourceJobFilter =
  | { tool: "describe_clip"; purpose: DescriptionPurpose }
  | { tool: "transcribe_clip" };

function matchesJob(job: ComputeJob, filter: SourceJobFilter): boolean {
  return job.tool === filter.tool &&
    (filter.tool !== "describe_clip" || (job.purpose ?? "clip") === filter.purpose);
}

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

/// A job's source span: its own `src_window` when it carries one (a
/// description, layer-addressed or not), else read through its layer; null
/// when neither places it.
function placedSpan(
  job: ComputeJob,
  layerById: ReadonlyMap<string, LayerSummary>,
): { srcStartUs: number; srcEndUs: number } | null {
  if (job.src_window) return { srcStartUs: job.src_window.src_start_us, srcEndUs: job.src_window.src_end_us };
  const layer = layerById.get(job.layer_id);
  return layer ? jobSourceSpan(job, layer) : null;
}

/// The oldest running `tool` job on `mediaId` whose source span overlaps
/// `[srcStartUs, srcEndUs)` — the same half-open intersection the rows find
/// prose by. A job whose layer the summary no longer has is skipped: its span
/// cannot be placed.
export function jobOverSourceSpan(
  s: ComputeJobsState,
  layerById: ReadonlyMap<string, LayerSummary>,
  q: SourceJobFilter & { mediaId: string; srcStartUs: number; srcEndUs: number },
): ComputeJob | null {
  let found: ComputeJob | null = null;
  for (const job of Object.values(s.jobs)) {
    if (!matchesJob(job, q) || job.media_id !== q.mediaId) continue;
    const span = placedSpan(job, layerById);
    if (!span) continue;
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
  q: SourceJobFilter & { mediaId: string; spans: readonly { srcStartUs: number; srcEndUs: number }[] },
): ComputeJob[] {
  return Object.values(s.jobs)
    .filter((job) => {
      if (!matchesJob(job, q) || job.media_id !== q.mediaId) return false;
      const span = placedSpan(job, layerById);
      if (!span) return true;
      return !q.spans.some((r) => span.srcStartUs < r.srcEndUs && span.srcEndUs > r.srcStartUs);
    })
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}
