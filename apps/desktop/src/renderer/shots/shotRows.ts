// The Shots Panel's row view model: one row per shot of the REDUCE's output,
// with the reviewer's own two decisions folded in.
//
// Boundary: this module never decides where a shot begins. Spans come from
// `reduce_shot_report`, which is the single producer of the canonical cut list
// (`main/state/hybrids.ts` consumes the same one), and everything here is
// either a projection of a span into the layer's timeline or a concatenation of
// spans the reviewer joined. Re-deriving boundaries in TypeScript would
// manufacture a Rust/TS twin of `build_shots`, and the invariant that twin
// would carry — markers land on exactly the frames splits land on — is the one
// the Rust tests already pin.

import { approxFrameDurUs } from "../frames";
import type { LayerSummary, Shot, ShotFlag, ShotReport } from "../ipc";

/// A shot's three measurements, together or not at all. `Shot` carries them as
/// three independent optionals, but a scan either sampled the span or it did
/// not, so a row shows one cell group or none — and `null` is that "none". Zero
/// is a measurement, and rendering an unmeasured span as `0` would report a
/// black, motionless, out-of-focus shot.
export interface ShotStats {
  brightness: number;
  motion: number;
  sharpness: number;
}

/// The candidate cut a shot OPENS on: the detector's own confidence at that
/// frame, plus the two source times whose frames make the before/after pair.
///
/// `beforeSrcUs` is one NOMINAL frame earlier — the layer's composition rate,
/// because the renderer's media summary carries no source frame rate at all
/// (`MediaSummary` has duration and dimensions and no fps). A pair a frame off
/// still answers "is this a real cut": the question is whether the image
/// changes across the boundary, not which exact source frame the decoder picks.
export interface ShotCandidate {
  srcUs: number;
  score: number;
  beforeSrcUs: number;
}

/// One reviewable shot. Source times are the report's own domain; `tStartUs` /
/// `tEndUs` are the same span seen on the layer's composition clock, for
/// display only — unsnapped, because the apply path snaps its own cuts
/// (`cutsToTimeline`) and a second snap here would show times an apply might
/// not produce.
export interface ShotRow {
  /// Position in the reviewed list, from 0. Not `Shot.index`: a merge changes
  /// which ordinal a span holds, and the row is numbered as the user sees it.
  index: number;
  srcStartUs: number;
  /// Exclusive, like every span in this project.
  srcEndUs: number;
  tStartUs: number;
  tEndUs: number;
  durationUs: number;
  /// The cover frame's source time — what `getMediaFrame` takes for this row.
  keyframeTUs: number;
  stats: ShotStats | null;
  flags: readonly ShotFlag[];
  /// `null` on the first row and only there: the window edge is a hard boundary
  /// in `build_shots`, so there is no candidate to weigh and no score control to
  /// draw.
  openingCandidate: ShotCandidate | null;
  /// The boundaries this row absorbed because the reviewer cleared them, in
  /// time order. They stay on the row so a merge is REVERSIBLE: a control that
  /// disappears the moment it is used is a decision with no way back, and
  /// re-accepting one splits the span again exactly where it was.
  mergedCandidates: readonly ShotCandidate[];
  /// False once the reviewer has marked this span for discard. Every row starts
  /// kept, so the plain apply is "split here" and discarding is opted into.
  keep: boolean;
}

/// All three or none — mirrors how a scan fills them in.
function statsOf(shot: Shot): ShotStats | null {
  const { brightness, motion, sharpness } = shot;
  if (
    typeof brightness !== "number" ||
    typeof motion !== "number" ||
    typeof sharpness !== "number"
  ) {
    return null;
  }
  return { brightness, motion, sharpness };
}

/// A span after the reviewer's vetoes, still in source time.
interface ReviewedSpan {
  srcStartUs: number;
  srcEndUs: number;
  keyframeTUs: number;
  stats: ShotStats | null;
  flags: readonly ShotFlag[];
  /// Source times of the boundaries folded into this span, ascending.
  vetoedSrcUs: number[];
}

/// Join each run of shots whose opening boundary the reviewer vetoed onto its
/// predecessor. Span concatenation and nothing else: the survivors are the
/// spans between consecutive ACCEPTED boundaries, which is exactly the set the
/// reduce yields at a threshold that excludes those candidates.
///
/// A joined span's stats AND flags go absent, for the reduce's own reason: it is
/// a different shot from any the scan measured, so a neighbour's average is not
/// its average and a neighbour's flags are not its flags. A union of the parts'
/// flags would be defensible on its own — a flag is existential — but it would
/// make this the one place a row says more than `reduce` does about the same
/// span, and a later stats pass over the merged span would then have to
/// overwrite a value the Panel had invented. One rule, stated once, in Rust.
///
/// The first shot is never joinable: it opens on the window edge, so no
/// candidate of its own exists to veto. A veto set naming that time is ignored
/// rather than trusted.
function reviewedSpans(
  shots: readonly Shot[],
  vetoedCandidateSrcUs: ReadonlySet<number>,
): ReviewedSpan[] {
  const spans: ReviewedSpan[] = [];
  for (const [i, shot] of shots.entries()) {
    const open = spans[spans.length - 1];
    if (i === 0 || open === undefined || !vetoedCandidateSrcUs.has(shot.t_start_us)) {
      spans.push({
        srcStartUs: shot.t_start_us,
        srcEndUs: shot.t_end_us,
        keyframeTUs: shot.keyframe_t_us,
        stats: statsOf(shot),
        flags: shot.flags,
        vetoedSrcUs: [],
      });
      continue;
    }
    open.vetoedSrcUs.push(shot.t_start_us);
    open.srcEndUs = shot.t_end_us;
    open.stats = null;
    open.flags = [];
    // The span midpoint, which is what the reduce picks for a span it did not
    // measure — so a merged row's cover frame is the same frame either path
    // would name.
    open.keyframeTUs =
      open.srcStartUs + Math.floor((open.srcEndUs - open.srcStartUs) / 2);
  }
  return spans;
}

/// Build the Panel's rows from a reduced report and the layer it is reviewed
/// against.
///
/// `layer` supplies the projection into composition time and nothing else; the
/// report is source-scoped, and only the layer knows where its own source
/// window sits on a timeline. Speed is not applied: the apply path's
/// `cutsToTimeline` maps at 1:1 too, and a row that disagreed with the cut it
/// produces would be worse than one that ignores a re-time.
export function shotRows(
  reduced: ShotReport,
  layer: LayerSummary,
  compositionFps: { num: number; den: number },
  vetoedCandidateSrcUs: ReadonlySet<number>,
  discardedSrcStartUs: ReadonlySet<number>,
): ShotRow[] {
  // The kind gate is what narrows `src_in_us` into scope; the Panel's subject
  // is a VideoClip by construction, so no row is ever lost to it.
  if (layer.params.kind !== "VideoClip") return [];
  const srcInUs = layer.params.src_in_us;
  const frameDurUs = approxFrameDurUs(compositionFps.num, compositionFps.den);
  const scoreAt = new Map(reduced.cut_scores.map((c) => [c.t_us, c.score]));
  const toTimeline = (srcUs: number): number =>
    layer.t_start_us + (srcUs - srcInUs);
  const candidateAt = (srcUs: number): ShotCandidate | null => {
    const score = scoreAt.get(srcUs);
    return score === undefined
      ? null
      : { srcUs, score, beforeSrcUs: Math.max(0, srcUs - frameDurUs) };
  };
  return reviewedSpans(reduced.shots, vetoedCandidateSrcUs).map(
    (span, index): ShotRow => {
      return {
        index,
        srcStartUs: span.srcStartUs,
        srcEndUs: span.srcEndUs,
        tStartUs: toTimeline(span.srcStartUs),
        tEndUs: toTimeline(span.srcEndUs),
        durationUs: span.srcEndUs - span.srcStartUs,
        keyframeTUs: span.keyframeTUs,
        stats: span.stats,
        flags: span.flags,
        openingCandidate: index === 0 ? null : candidateAt(span.srcStartUs),
        mergedCandidates: span.vetoedSrcUs.flatMap((srcUs) => {
          const candidate = candidateAt(srcUs);
          return candidate === null ? [] : [candidate];
        }),
        keep: !discardedSrcStartUs.has(span.srcStartUs),
      };
    },
  );
}

/// The canonical cut list an apply consumes: every row's opening candidate,
/// whether the row is kept or not. Ascending, and interior by construction —
/// the first row has no candidate, so the window edge can never enter the list.
///
/// The keep flag is deliberately not a filter here. A discard cuts at every
/// accepted boundary and then deletes named segments, so dropping an unchecked
/// row's opening boundary would fuse it into its predecessor instead — which is
/// what clearing the CANDIDATE means, a different decision the reviewer makes
/// with a different box.
export function acceptedCutsSrcUs(rows: readonly ShotRow[]): number[] {
  return rows.flatMap((row) =>
    row.openingCandidate ? [row.openingCandidate.srcUs] : [],
  );
}
