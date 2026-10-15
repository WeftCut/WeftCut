// The review focus on the timelines (ADR 0115): what the one tack or change
// the agent panel and the timelines point at together — and the row under the
// pointer — paints, and the two pure rules the surfaces need around it: where
// to scroll an editor timeline so the focus is in view, and which item a click
// on the mini timeline's thin bands names.
//
// The focus itself lives in the agent panel's store (`reviewFocus`,
// `reviewHover`); the tacks in its snapshot, the changes in the Review view.
// `useFocusPaint` is their projection in one place, rebuilt only when one of
// those moves while something is focused or hovered, so a clip block reads its
// own entry with a selector on its id and re-renders only when that changes.
import { useMemo } from 'react'
import { create } from 'zustand'
import type { TackView } from '../../shared/agent-activity'
import type { Change } from '../../shared/review'
import { useProjectStore } from '../state/projectStore'
import { useAgentActivity, type ReviewItem } from './activityStore'
import { keyIds } from './changeModel'
import { listedChanges, useReview } from './reviewStore'

/** How a clip is outlined for the focus: the focused tack follows it, the
 *  focused change covers it, or the hovered change row does. */
export type FocusMark = 'tack' | 'change' | 'hover'

/** A stretch of a composition's clock the focused item covers, washed across
 *  the editor timeline's lanes. `endUs === startUs` for a point. */
export interface FocusWash { kind: ReviewItem['kind']; compositionId: string; startUs: number; endUs: number }

/** Historical baseline footprint of the focused entity on one track. */
export interface FocusWas { trackId: string; compositionId: string; startUs: number; endUs: number }

export interface FocusPaint {
  /** The focus this paint is for — the very object, so a fresh select of the
   *  same item still reads as a new one (a timeline reveals per select). */
  focus: ReviewItem | null
  /** Layer id → its outline. */
  layers: ReadonlyMap<string, FocusMark>
  /** Removed-change ghost (its change id) → its outline. */
  ghosts: ReadonlyMap<string, Exclude<FocusMark, 'tack'>>
  washes: readonly FocusWash[]
  /** Scroll targets; historical positions are used only without a current range. */
  reveal: readonly FocusWash[]
  /** The focused move's old places, clips only (a marker's has no lane). */
  was: readonly FocusWas[]
  /** A listed change is focused: the other review marks step back. */
  changeFocused: boolean
}

export const EMPTY_FOCUS_PAINT: FocusPaint = { focus: null, layers: new Map(), ghosts: new Map(), washes: [], reveal: [], was: [], changeFocused: false }

/** Where a tack is now, if it is anywhere: only a visible one has a place. */
function tackWash(t: TackView): FocusWash | null {
  if (t.state !== 'visible' || t.composition_id === null || t.t_us === null) return null
  const end = t.end_t_us !== null && t.end_t_us > t.t_us ? t.end_t_us : t.t_us
  return { kind: 'tack', compositionId: t.composition_id, startUs: t.t_us, endUs: end }
}

/** Project the focus and the hover onto what the editor timeline paints. A
 *  tack outlines the clips it follows (either end; an anchored tack's one
 *  clip) and washes its current range; a change outlines its clips — or its
 *  ghost, removed — and washes its current range. Historical footprints of a
 *  modified entity are shown as separate baseline frames. Other entities are
 *  never selected through spatial or causal relationships. */
export function buildFocusPaint(
  focus: ReviewItem | null,
  hover: ReviewItem | null,
  tacks: readonly TackView[],
  changes: readonly Change[],
): FocusPaint {
  if (focus === null && hover === null) return EMPTY_FOCUS_PAINT
  const layers = new Map<string, FocusMark>()
  const ghosts = new Map<string, Exclude<FocusMark, 'tack'>>()
  const washes: FocusWash[] = []
  const historical: FocusWash[] = []
  const was: FocusWas[] = []
  const outline = (c: Change, mark: Exclude<FocusMark, 'tack'>) => {
    if (c.class === 'removed') { ghosts.set(c.id, mark); return }
    for (const id of keyIds(c, 'Layer')) layers.set(id, mark)
  }
  // The hover first, so the focus's own outline wins on a clip both name.
  if (hover?.kind === 'change') {
    const c = changes.find(x => x.id === hover.id)
    if (c) outline(c, 'hover')
  }
  let changeFocused = false
  if (focus?.kind === 'tack') {
    const t = tacks.find(x => x.id === focus.id)
    if (t) {
      const wash = tackWash(t)
      if (wash) washes.push(wash)
      for (const end of [t.follows.start, t.follows.end]) if (end) layers.set(end.layer_id, 'tack')
    }
  } else if (focus?.kind === 'change') {
    const c = changes.find(x => x.id === focus.id)
    if (c) {
      changeFocused = true
      outline(c, 'change')
      for (const r of c.ranges) washes.push({ kind: 'change', compositionId: r.composition_id, startUs: r.t_start_us, endUs: Math.max(r.t_start_us, r.t_end_us) })
      for (const r of c.before_ranges ?? []) historical.push({ kind: 'change', compositionId: r.composition_id, startUs: r.t_start_us, endUs: r.t_end_us })
      for (const r of c.class === 'modified' ? c.before_ranges ?? [] : []) {
        if (!c.from && c.ranges.some(now => now.composition_id === r.composition_id && now.t_start_us === r.t_start_us && now.t_end_us === r.t_end_us)) continue
        if (r.track_id !== null) was.push({ trackId: r.track_id, compositionId: r.composition_id, startUs: r.t_start_us, endUs: Math.max(r.t_start_us, r.t_end_us) })
      }
    }
  }
  const reveal = [...washes, ...historical.filter(r => !washes.some(w => w.compositionId === r.compositionId))]
  return { focus, layers, ghosts, washes, reveal, was, changeFocused }
}

// ── The derived store ─────────────────────────────────────────────────────────

const sameMap = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
const sameWashes = (a: readonly FocusWash[], b: readonly FocusWash[]) =>
  a.length === b.length && a.every((w, i) => {
    const o = b[i]!
    return w.kind === o.kind && w.compositionId === o.compositionId && w.startUs === o.startUs && w.endUs === o.endUs
  })
const sameWas = (a: readonly FocusWas[], b: readonly FocusWas[]) =>
  a.length === b.length && a.every((w, i) => {
    const o = b[i]!
    return w.trackId === o.trackId && w.compositionId === o.compositionId && w.startUs === o.startUs && w.endUs === o.endUs
  })

export const useFocusPaint = create<FocusPaint>(() => EMPTY_FOCUS_PAINT)

const NO_TACKS: TackView[] = []
/** Rebuild, keeping every part that did not change by identity: an agent's
 *  delta re-reads the focused tack, and the clips' selectors and the lanes'
 *  washes should not hear about it unless it moved. */
function refreshFocusPaint(): void {
  const a = useAgentActivity.getState()
  const next = buildFocusPaint(a.reviewFocus, a.reviewHover, a.snapshot?.tacks ?? NO_TACKS, listedChanges(useReview.getState()))
  const held = useFocusPaint.getState()
  const merged: FocusPaint = {
    focus: next.focus,
    layers: sameMap(held.layers, next.layers) ? held.layers : next.layers,
    ghosts: sameMap(held.ghosts, next.ghosts) ? held.ghosts : next.ghosts,
    washes: sameWashes(held.washes, next.washes) ? held.washes : next.washes,
    reveal: sameWashes(held.reveal, next.reveal) ? held.reveal : next.reveal,
    was: sameWas(held.was, next.was) ? held.was : next.was,
    changeFocused: next.changeFocused,
  }
  const same = merged.focus === held.focus && merged.layers === held.layers && merged.ghosts === held.ghosts &&
    merged.washes === held.washes && merged.reveal === held.reveal && merged.was === held.was && merged.changeFocused === held.changeFocused
  if (!same) useFocusPaint.setState(merged, true)
}

useAgentActivity.subscribe((s, prev) => {
  const pointing = s.reviewFocus !== null || s.reviewHover !== null
  if (s.reviewFocus !== prev.reviewFocus || s.reviewHover !== prev.reviewHover || (pointing && s.snapshot?.tacks !== prev.snapshot?.tacks)) refreshFocusPaint()
})
useReview.subscribe((s, prev) => {
  const a = useAgentActivity.getState()
  if ((a.reviewFocus !== null || a.reviewHover !== null) && (s.view !== prev.view || s.showUser !== prev.showUser)) refreshFocusPaint()
})
refreshFocusPaint()

// ── Leaf reads (editor timeline, under the Review overlay) ────────────────────

const useOverlay = () => useAgentActivity(s => s.reviewOverlay)

/** A clip's focus outline, or null. */
export function useLayerFocusMark(layerId: string): FocusMark | null {
  const overlay = useOverlay()
  return useFocusPaint(s => (overlay ? s.layers.get(layerId) ?? null : null))
}

/** Whether review marks not of the focused change step back. */
export function useReviewMarksRecede(): boolean {
  const overlay = useOverlay()
  return useFocusPaint(s => overlay && s.changeFocused)
}

/** The ghosts' outlines and whether the rest step back. */
export function useGhostFocus(): { ghosts: FocusPaint['ghosts']; recede: boolean } {
  const recede = useReviewMarksRecede()
  return { ghosts: useFocusPaint(s => s.ghosts), recede }
}

/** The focused change's id, or null — a cut mark of it does not step back. */
export function useFocusedChangeId(): string | null {
  const overlay = useOverlay()
  return useFocusPaint(s => (overlay && s.focus?.kind === 'change' && s.changeFocused ? s.focus.id : null))
}

const NO_WAS: readonly FocusWas[] = []
/** The focused move's old places on one track. */
export function useTrackFocusWas(trackId: string): readonly FocusWas[] {
  const overlay = useOverlay()
  const was = useFocusPaint(s => s.was)
  return useMemo(() => {
    if (!overlay || was.length === 0) return NO_WAS
    const mine = was.filter(w => w.trackId === trackId)
    return mine.length === 0 ? NO_WAS : mine
  }, [overlay, was, trackId])
}

const NO_WASHES: readonly FocusWash[] = []
/** The focus's washes on one timeline. `compositionId` null names the root, as
 *  everywhere on the timeline. */
export function useCompositionFocusWashes(compositionId: string | null): readonly FocusWash[] {
  const overlay = useOverlay()
  const washes = useFocusPaint(s => s.washes)
  const resolved = useProjectStore(s => compositionId ?? s.summary?.root_id ?? null)
  return useMemo(() => {
    if (!overlay || washes.length === 0 || resolved === null) return NO_WASHES
    const mine = washes.filter(w => w.compositionId === resolved)
    return mine.length === 0 ? NO_WASHES : mine
  }, [overlay, washes, resolved])
}

// ── Reveal: scroll an editor timeline to the focus, never seeking ─────────────

/** The `scrollLeft` that brings `[startPx, endPx]` (lane x, not counting the
 *  header column) into a viewport `viewportPx` wide now scrolled to
 *  `scrollLeftPx` — or null when it is in view already. A range that fits is
 *  centred; one wider than the view keeps its start a margin in from the left
 *  edge, and counts as in view while that start is on screen. */
export function focusRevealScrollLeft(
  span: { startPx: number; endPx: number },
  view: { scrollLeftPx: number; viewportPx: number },
): number | null {
  const { startPx, endPx } = span
  const { scrollLeftPx: left, viewportPx: width } = view
  if (width <= 0) return null
  const right = left + width
  if (startPx >= left && endPx <= right) return null
  const margin = Math.min(48, width / 10)
  const fits = endPx - startPx <= width - 2 * margin
  if (!fits && startPx >= left && startPx <= right - margin) return null
  const target = fits ? (startPx + endPx) / 2 - width / 2 : startPx - margin
  const next = Math.max(0, Math.round(target))
  return next === Math.round(left) ? null : next
}

// ── Mini timeline bands: which item a click names ─────────────────────────────

/** One item of a mini timeline band, on its composition's clock. */
export interface BandItem { id: string; startUs: number; endUs: number }

/** The item a click at `tUs` on a band names: of the ranges containing it the
 *  shortest — the most specific one, since a band paints their union and the
 *  long one is reachable everywhere else — else the nearest point within
 *  `slopUs` (a few pixels' worth). Null on bare band: the click seeks. */
export function hitBand(items: readonly BandItem[], tUs: number, slopUs: number): string | null {
  let best: string | null = null
  let bestLength = Infinity
  for (const it of items) {
    const length = it.endUs - it.startUs
    if (length > 0 && it.startUs <= tUs && tUs <= it.endUs && length < bestLength) { best = it.id; bestLength = length }
  }
  if (best !== null) return best
  let nearest: string | null = null
  let distance = Infinity
  for (const it of items) {
    if (it.endUs > it.startUs) continue
    const d = Math.abs(tUs - it.startUs)
    if (d <= slopUs && d < distance) { nearest = it.id; distance = d }
  }
  return nearest
}
