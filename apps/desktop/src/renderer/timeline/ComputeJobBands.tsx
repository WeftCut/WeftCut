// A clip-compute job drawn on the clip it reads (ADR 0121): a striped band over
// exactly the job's window, clipped to the clip as drawn, with the job's
// status in a chip — or, where the band is too small to hold one, a glyph whose
// tooltip says it. Waiting and working differ here as everywhere else: a queued
// job's band is muted and still, with an hourglass. The captions a finished
// transcription is writing draw the same way, as "Adding captions".
//
// Boundary: paint plus one press. The band takes no pointer, so a press on
// the clip under it still selects, drags and trims; the chip's Cancel is the
// only control, and keeps its press from reaching the clip.
//
// Cheap on purpose: one subscription per clip whose answer is the SAME empty
// list for every clip without a job, so a phase tick re-renders the clips that
// carry one and nothing else. The shared clock (`useNow`) only runs inside a
// chip, which only exists where a job does.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Hourglass, Loader2 } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import { ComputeJobStatus } from "../compute/ComputeJobStatus";
import { computePhaseText, isWaiting, type ComputeJobSubject } from "../compute/computeJobView";
import { jobsForLayer, useComputeJobsStore } from "../compute/computeJobsStore";
import { useTranscribeRunStore } from "../speech/transcribeRun";
import { uiPixels } from "../settings/layoutTheme";
import { UI_METRICS } from "../settings/uiMetrics";
import { headerColumnPx } from "./geometry";

/// Least band, in baseline px, that holds the compact chip: an icon, a few
/// words and the Cancel glyph. Narrower bands show the glyph alone.
export const BAND_CHIP_MIN_WIDTH = 96;
/// Least slice height that holds the chip above the clip's centred name.
export const BAND_CHIP_MIN_HEIGHT = 40;
/// Least band that still holds the glyph; below it the stripes say enough.
export const BAND_GLYPH_MIN_WIDTH = 12;

type Span = { t_start_us: number; t_end_us: number };

/// Where a timeline window draws on a block whose left edge is `loUs`, clipped
/// to the block's live span `[loUs, hiUs)`. Null when none of it is on the
/// clip. A one-pixel floor, so a short window on a zoomed-out timeline still
/// shows.
export function jobBandRect(
  window: Span,
  loUs: number,
  hiUs: number,
  pxPerSec: number,
): { left: number; width: number } | null {
  const from = Math.max(window.t_start_us, loUs);
  const to = Math.min(window.t_end_us, hiUs);
  if (to <= from) return null;
  return {
    left: ((from - loUs) / 1_000_000) * pxPerSec,
    width: Math.max(1, ((to - from) / 1_000_000) * pxPerSec),
  };
}

export function ComputeJobBands({
  layerId,
  pxPerSec,
  blockLoUs,
  blockHiUs,
  heightPx,
}: {
  layerId: string;
  pxPerSec: number;
  /// The block's LIVE span in composition µs — its left edge is `blockLoUs`.
  blockLoUs: number;
  blockHiUs: number;
  /// The slice's drawn height: a half-height A/V slice has no room for a chip.
  heightPx: number;
}) {
  const jobs = useComputeJobsStore(useShallow((s) => jobsForLayer(s, layerId)));
  const applying = useTranscribeRunStore((s) => s.applying?.includes(layerId) ?? false);
  if (jobs.length === 0 && !applying) return null;
  const geometry = { pxPerSec, loUs: blockLoUs, hiUs: blockHiUs, heightPx };
  return (
    <>
      {jobs.map((job) => (
        <JobBand key={job.job_id} job={job} window={job.window} geometry={geometry} />
      ))}
      {applying && <ApplyingBand layerId={layerId} geometry={geometry} />}
    </>
  );
}

interface BandGeometry {
  pxPerSec: number;
  loUs: number;
  hiUs: number;
  heightPx: number;
}

/// The write-back after a transcription: not a job (it runs after every job
/// has ended), so its subject is made up here, from when the write began. It
/// cannot be cancelled.
function ApplyingBand({ layerId, geometry }: { layerId: string; geometry: BandGeometry }) {
  const [since] = useState(() => new Date().toISOString());
  const subject: ComputeJobSubject = {
    job_id: `applying:${layerId}`,
    tool: "transcribe_clip",
    phase: { kind: "applying" },
    phase_since: since,
  };
  return (
    <JobBand
      job={subject}
      window={{ t_start_us: geometry.loUs, t_end_us: geometry.hiUs }}
      geometry={geometry}
      cancellable={false}
    />
  );
}

function JobBand({
  job,
  window,
  geometry,
  cancellable = true,
}: {
  job: ComputeJobSubject;
  window: Span;
  geometry: BandGeometry;
  cancellable?: boolean;
}) {
  const { t } = useTranslation();
  const rect = jobBandRect(window, geometry.loUs, geometry.hiUs, geometry.pxPerSec);
  if (rect === null) return null;
  const waiting = isWaiting(job.phase);
  const state = waiting ? "waiting" : "working";
  const range = t(job.tool === "transcribe_clip" ? "compute.ui.transcribing_range" : "compute.ui.describing_range");
  const title = job.phase.kind === "applying"
    ? computePhaseText(t, job.tool, job.phase, { detail: true })
    : `${range}\n${computePhaseText(t, job.tool, job.phase, { detail: true })}`;
  const chip = rect.width >= uiPixels(BAND_CHIP_MIN_WIDTH) && geometry.heightPx >= uiPixels(BAND_CHIP_MIN_HEIGHT);
  const glyph = !chip && rect.width >= uiPixels(BAND_GLYPH_MIN_WIDTH);
  // Pinned just past the sticky track header, where the clip's own name pins.
  const stickyLeft = headerColumnPx() + uiPixels(UI_METRICS.timeline.clipLabel.headerInset);
  return (
    <div
      className={`compute-job-band state-${state}`}
      data-testid="compute-job-band"
      data-job-id={job.job_id}
      data-phase={job.phase.kind}
      data-state={state}
      style={{ left: rect.left, width: rect.width }}
    >
      {chip && (
        <div
          className="compute-job-band-chip"
          style={{ left: stickyLeft }}
          title={title}
          // The chip sits on the clip: a press on Cancel must not also select
          // or start dragging it. Anywhere else on the chip is the clip's.
          onPointerDown={(e) => {
            if ((e.target as Element).closest("button")) e.stopPropagation();
          }}
          onDoubleClick={(e) => {
            if ((e.target as Element).closest("button")) e.stopPropagation();
          }}
        >
          <ComputeJobStatus job={job} variant="compact" hideCancel={!cancellable} />
        </div>
      )}
      {glyph && (
        <span
          className="compute-job-band-glyph"
          data-testid="compute-job-band-glyph"
          style={{ left: stickyLeft }}
          title={title}
          aria-label={title}
          role="img"
        >
          {waiting
            ? <AppIcon icon={Hourglass} size="micro" aria-hidden />
            : <AppIcon icon={Loader2} size="micro" className="compute-job-spin" aria-hidden />}
        </span>
      )}
    </div>
  );
}
