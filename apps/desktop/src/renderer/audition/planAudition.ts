// What the result audition PLAYS: the kept audio around the joins a removal
// would make, as ranges on the subject's conform file.
//
// Boundary: pure arithmetic, no AudioContext and no IPC — `auditionPlayer.ts`
// reads and plays what this returns, and the section decides when. Spec
// `.scratch/pauses/spec.md` Decision 7.
//
// Axes: `pauses` and `clip` are TIMELINE µs in the subject's own composition
// clock (what `detect_pauses` returns); every number that leaves is SOURCE µs
// on the conform file, because that is the axis a range read takes.

/// One pause as the detector reports it — timeline-absolute, already clipped to
/// the subject's span.
export interface AuditionPause {
  t_start_us: number;
  t_end_us: number;
}

/// The subject's placement, in the two numbers that map its clocks plus the end
/// that bounds the context.
export interface AuditionClip {
  tStartUs: number;
  tEndUs: number;
  srcInUs: number;
}

/// One stretch of audio to play, on the conform file's own clock.
export interface AuditionSegment {
  srcStartUs: number;
  srcEndUs: number;
}

export interface AuditionPlan {
  /// In play order. Consecutive entries meet at a join, so a plan with N
  /// segments carries N − 1 joins.
  segments: AuditionSegment[];
  /// Indices into the `pauses` array the plan was built from, in play order —
  /// what the timeline draws brighter while this plays.
  joins: number[];
}

/// How many cuts one audition covers. Three is what a listener can hold: the
/// question being answered is "does this threshold sound right", and the fourth
/// join adds no evidence the first three did not.
export const MAX_JOINS = 3;

/// Context before the first join and after the last, µs. A second is the
/// smallest run of speech that carries a rhythm — anything shorter starts the
/// excerpt mid-word and gives the ear nothing to judge the cut against.
export const CONTEXT_US = 1_000_000;

/// The whole excerpt's ceiling, µs. Not a performance bound — a decode-free
/// range read is cheap — but an attention one: past ten seconds the user is
/// listening to the clip rather than to the edit.
export const AUDITION_CAP_US = 10_000_000;

/// The part of a pause a removal actually cuts: the range minus `padUs` on each
/// side, with the pad dropped on whichever side touches the clip's edge (there
/// is nothing outside to keep it against — the existing whole-trim rule). Null
/// when the core collapses, which is a pause the removal skips and therefore
/// not a join.
///
/// The TWIN of the pad math in main's `removePauses` hybrid. They disagree only
/// if one is changed alone, and the failure that produces is an audition of a
/// join the removal does not make.
export function pauseCore(
  pause: AuditionPause,
  padUs: number,
  clip: { tStartUs: number; tEndUs: number },
): { startUs: number; endUs: number } | null {
  const startUs =
    pause.t_start_us <= clip.tStartUs ? pause.t_start_us : pause.t_start_us + padUs;
  const endUs =
    pause.t_end_us >= clip.tEndUs ? pause.t_end_us : pause.t_end_us - padUs;
  return endUs > startUs ? { startUs, endUs } : null;
}

/// The kept audio around the joins nearest the playhead, as source ranges.
///
/// The playhead is READ and never moved (spec Decision 7): it says where the
/// user is looking, and an audition that seeked would cost them their place. A
/// playhead outside the clip means the user is looking somewhere else entirely,
/// so the excerpt starts at the clip instead of at nothing.
///
/// The cap trims CONTEXT and never a join: the joins are the evidence, and an
/// excerpt that dropped one to stay under ten seconds would answer a question
/// nobody asked. A talky clip whose three joins are more than the cap apart
/// therefore plays longer than the cap, with no lead-in and no tail.
export function planAudition(
  pauses: readonly AuditionPause[],
  padUs: number,
  clip: AuditionClip,
  playheadUs: number,
  opts: { maxJoins?: number; contextUs?: number; capUs?: number } = {},
): AuditionPlan {
  const maxJoins = opts.maxJoins ?? MAX_JOINS;
  const contextUs = opts.contextUs ?? CONTEXT_US;
  const capUs = opts.capUs ?? AUDITION_CAP_US;
  const toSource = (tUs: number): number => tUs - clip.tStartUs + clip.srcInUs;
  const anchorUs =
    playheadUs >= clip.tStartUs && playheadUs < clip.tEndUs
      ? playheadUs
      : clip.tStartUs;

  const chosen: { index: number; startUs: number; endUs: number }[] = [];
  for (let i = 0; i < pauses.length && chosen.length < maxJoins; i++) {
    const core = pauseCore(pauses[i]!, padUs, clip);
    if (core === null || core.startUs < anchorUs) continue;
    chosen.push({ index: i, ...core });
  }

  // Nothing to join at or after the anchor: play the anchor's own stretch, so
  // the button still answers "what does this sound like" instead of nothing.
  if (chosen.length === 0) {
    const endUs = Math.min(clip.tEndUs, anchorUs + capUs);
    return {
      segments:
        endUs > anchorUs
          ? [{ srcStartUs: toSource(anchorUs), srcEndUs: toSource(endUs) }]
          : [],
      joins: [],
    };
  }

  // The material BETWEEN the chosen joins is fixed — it is what the joins are
  // made of — so only the two ends compete for what the cap leaves.
  let betweenUs = 0;
  for (let i = 1; i < chosen.length; i++) {
    betweenUs += chosen[i]!.startUs - chosen[i - 1]!.endUs;
  }
  const first = chosen[0]!;
  const last = chosen[chosen.length - 1]!;
  const room = Math.max(0, (capUs - betweenUs) / 2);
  const leadUs = Math.min(contextUs, room, first.startUs - clip.tStartUs);
  const tailUs = Math.min(contextUs, room, clip.tEndUs - last.endUs);

  const segments: AuditionSegment[] = [];
  const push = (startUs: number, endUs: number): void => {
    if (endUs > startUs) {
      segments.push({ srcStartUs: toSource(startUs), srcEndUs: toSource(endUs) });
    }
  };
  push(first.startUs - leadUs, first.startUs);
  for (let i = 1; i < chosen.length; i++) {
    push(chosen[i - 1]!.endUs, chosen[i]!.startUs);
  }
  push(last.endUs, last.endUs + tailUs);
  return { segments, joins: chosen.map((c) => c.index) };
}
