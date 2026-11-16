// Walking and playing the changed ranges (ADR 0169): the keyboard's way
// through "where should I watch again". Both read the ranges of the
// composition the editor (or the agent view's mini timeline) shows, in the
// list its bands paint — the Review view's, or a selected call's — so a key
// walks what the user sees.
//
// A walk is an explicit move, so unlike a focus it seeks: it parks the
// playhead on the range and focuses it. A play runs the range with a little
// of the film either side and stops, by the transport's own bound
// (`playRootSpan`), which any later transport action drops.
import type { ChangedRange } from '../../shared/review'
import { displayedFrameStartUs } from '../frames'
import { focusedPlayheadUs, focusedRootUs, rootUsOf } from '../state/playheadProjection'
import { currentOpenComposition } from '../state/projectStore'
import { playRootSpan, seekToClamped } from '../state/navigation'
import { compositionChangeRanges, rangesShowUser, selectHighlight, useReview } from './reviewStore'
import { rangeKey, selectRange, useReviewFocus } from './reviewFocus'

/** How much of the film a play shows before a range and after it: enough
 *  to hear what leads in and to see it settle. */
export const PLAY_LEAD_IN_US = 1_000_000
export const PLAY_TAIL_US = 500_000
/** A cut point has no length of its own: a play shows this much either side
 *  of the cut, so both the outgoing and the incoming material are heard. */
export const PLAY_CUT_SIDE_US = 2_000_000

const byTime = (a: ChangedRange, b: ChangedRange) => a.t_start_us - b.t_start_us || a.t_end_us - b.t_end_us

/** The ranges a walk steps through: the open composition's, as its bands
 *  paint them, in time order. */
export function walkableRanges(): ChangedRange[] {
  const s = useReview.getState()
  const marks = compositionChangeRanges(selectHighlight(s).ranges, currentOpenComposition()?.id ?? null, rangesShowUser(s))
  return marks.map(m => m.range).sort(byTime)
}

/** Whether there is a range to walk to or play. */
export function hasChangedRanges(): boolean {
  return useReviewFocus.getState().focus?.kind === 'range' || walkableRanges().length > 0
}

/** The range one step `dir` from `from` among `ranges` (time order), or null
 *  past the end — no wrap, as the marker walk: the dead key is the end.
 *
 *  From a range in the list, its neighbour. From the playhead, the nearest
 *  range starting in a later or an earlier frame (`frameOf`); one starting in
 *  the frame on screen is behind in both directions, so a walk never lands
 *  where it already is. */
export function nextRange(
  ranges: readonly ChangedRange[],
  from: { range: ChangedRange } | { playheadUs: number },
  dir: 1 | -1,
  frameOf: (us: number) => number = (us) => us,
): ChangedRange | null {
  if ('range' in from) {
    const key = rangeKey(from.range)
    const i = ranges.findIndex(r => rangeKey(r) === key)
    if (i >= 0) return ranges[i + dir] ?? null
    return nextRange(ranges, { playheadUs: from.range.t_start_us }, dir, frameOf)
  }
  const at = frameOf(from.playheadUs)
  if (dir === 1) return ranges.find(r => frameOf(r.t_start_us) > at) ?? null
  let best: ChangedRange | null = null
  for (const r of ranges) if (frameOf(r.t_start_us) < at) best = r
  return best
}

/** Walk to the previous or next changed range: park the playhead on its
 *  start (a cut point: on the cut) and focus it. From the focused range when
 *  it is on this timeline, else from the playhead. */
export function walkChangedRange(dir: 1 | -1): void {
  const comp = currentOpenComposition()
  if (comp === null) return
  const { focus, range } = useReviewFocus.getState()
  const from = focus?.kind === 'range' && range !== null && range.composition_id === comp.id ? { range } : { playheadUs: focusedPlayheadUs() }
  const next = nextRange(walkableRanges(), from, dir, (us) => displayedFrameStartUs(us, comp.fps_num, comp.fps_den))
  if (next === null) return
  // Seek first: the focus's reveal then scrolls to the range the playhead is on.
  seekToClamped(focusedRootUs(next.t_start_us))
  selectRange(next)
}

/** What a play of `r` runs, on its composition's clock: from a lead-in before
 *  it (never before 0) to a tail after it, exclusive; a cut point, the same
 *  stretch either side of the cut. */
export function rangePlaySpan(r: ChangedRange): { fromUs: number; stopUs: number } {
  if (r.t_end_us <= r.t_start_us) return { fromUs: Math.max(0, r.t_start_us - PLAY_CUT_SIDE_US), stopUs: r.t_start_us + PLAY_CUT_SIDE_US }
  return { fromUs: Math.max(0, r.t_start_us - PLAY_LEAD_IN_US), stopUs: r.t_end_us + PLAY_TAIL_US }
}

/** The range under `tUs` or the first after it (`ranges` in time order): a
 *  range holds `tUs` before its end, a cut point at or after it. */
export function rangeAtOrAfter(ranges: readonly ChangedRange[], tUs: number): ChangedRange | null {
  return ranges.find(r => (r.t_end_us > r.t_start_us ? r.t_end_us > tUs : r.t_start_us >= tUs)) ?? null
}

/** Play the focused range — else the one under or after the playhead — and
 *  pause after it. The in and out points are left alone. */
export function playChangedRange(): void {
  const { focus, range } = useReviewFocus.getState()
  const target = focus?.kind === 'range' && range !== null ? range : rangeAtOrAfter(walkableRanges(), focusedPlayheadUs())
  if (target === null) return
  const span = rangePlaySpan(target)
  const from = rootUsOf(target.composition_id, span.fromUs)
  const stop = rootUsOf(target.composition_id, span.stopUs)
  if (from === null || stop === null) return
  playRootSpan(from, stop)
}
