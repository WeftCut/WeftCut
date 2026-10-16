// The review focus (ADR 0115): the one tack or change the agent panel and the
// timelines point at together, and the row under the pointer. This module owns
// both — what can be focused, how a surface focuses it, and when it lets go —
// and what they paint, plus the two pure rules the surfaces need around it:
// where to scroll an editor timeline so the focus is in view, and which item a
// click on the mini timeline's thin bands names.
//
// One rule decides when the focus and the hover go: an item stays only while
// the list it came from shows it — a tack in the Tacks tab, a change of the
// Review view in the Changes tab, a change of a selected call in the Activity
// tab while that call's highlight is up. Deleted, approved, undone, filtered
// out, another tab, another row, another project: each is that rule failing.
// Gestures that let go on purpose (Esc, a press on bare lanes) call
// `releaseFocus`.
//
// `useFocusPaint` is the projection of the focus onto the timelines, rebuilt
// only when something it reads moves while an item is focused or hovered, so a
// clip block reads its own entry with a selector on its id and re-renders only
// when that changes.
import { useMemo } from 'react'
import { create } from 'zustand'
import type { TackView } from '../../shared/agent-activity'
import type { Change } from '../../shared/review'
import { useProjectStore } from '../state/projectStore'
import { tackGroupKey, tackRowKey, useAgentActivity } from './activityStore'
import { keyIds } from './changeModel'
import { listedChanges, useReview } from './reviewStore'

/** Which change set a focused change belongs to: the Review view's (the
 *  Changes tab), or the selected activity row's own (what that call did). One
 *  entity is one change id in both, so the id alone cannot say which. */
export type ChangeSource = 'review' | 'activity'

/** One review item as the panel and the timelines point at it together. */
export type ReviewItem = { kind: 'tack'; id: string } | { kind: 'change'; source: ChangeSource; id: string }

/** What a surface that draws items of both kinds compares and reports. */
export type ReviewTarget = Pick<ReviewItem, 'kind' | 'id'>

interface ReviewFocusState {
  /** The focused item: its row highlighted, its chip solid, its range washed
   *  across the editor's lanes, its clips outlined. A fresh object on every
   *  select, even of the same item: the timelines bring it into view per
   *  select, not per id. */
  focus: ReviewItem | null
  /** The row under the pointer: outlines its chip, mini mark and clips without
   *  selecting anything. */
  hover: ReviewItem | null
}

export const useReviewFocus = create<ReviewFocusState>(() => ({ focus: null, hover: null }))

const sameItem = (a: ReviewItem | null, b: ReviewItem | null) =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id && (a.kind === 'tack' || a.source === (b as typeof a).source))

/** Whether the list `item` came from shows it now — the one rule for keeping
 *  a focus or a hover. A Review view not fetched yet names nothing either
 *  way, so it drops nothing. */
function shown(item: ReviewItem): boolean {
  const a = useAgentActivity.getState()
  if (item.kind === 'tack') return a.tab === 'tacks' && (a.snapshot?.tacks.some(t => t.id === item.id) ?? false)
  const r = useReview.getState()
  if (item.source === 'activity') return a.tab === 'activity' && r.activity !== null && (r.activity.status !== 'ready' || r.activity.highlight.changes.has(item.id))
  return a.tab === 'changes' && (r.view === null || listedChanges(r).some(c => c.id === item.id))
}

/** Focus `item` (null: none) — only while its list shows it, as ever after. */
export function setReviewFocus(item: ReviewItem | null): void {
  useReviewFocus.setState({ focus: item === null || !shown(item) ? null : { ...item } })
}

/** Let go of the focus on purpose — Esc, a press on bare lanes. */
export const releaseFocus = (): void => setReviewFocus(null)

/** Name the row under the pointer (null: none). */
export function setReviewHover(item: ReviewItem | null): void {
  const next = item !== null && shown(item) ? item : null
  if (!sameItem(useReviewFocus.getState().hover, next)) useReviewFocus.setState({ hover: next })
}

/** Focus one tack and show it in the Tacks tab: switch to it, expand its
 *  group and row. */
export function selectTack(id: string): void {
  const a = useAgentActivity.getState()
  const tack = a.snapshot?.tacks.find(t => t.id === id)
  if (!tack) return
  useAgentActivity.setState({ tab: 'tacks', expanded: { ...a.expanded, [tackGroupKey(tack.session_id)]: true, [tackRowKey(id)]: true } })
  setReviewFocus({ kind: 'tack', id })
}

/** Focus one change named on a timeline. While a selected call's highlight is
 *  up and draws that change, it is that call's change, focused where it is;
 *  otherwise it is the Review view's, shown in the Changes tab. */
export function selectChange(id: string): void {
  const activity = useReview.getState().activity
  if (useAgentActivity.getState().tab === 'activity' && activity?.status === 'ready' && activity.highlight.changes.has(id)) {
    setReviewFocus({ kind: 'change', source: 'activity', id })
    return
  }
  useAgentActivity.setState({ tab: 'changes' })
  setReviewFocus({ kind: 'change', source: 'review', id })
}

/** Apply the rule: drop a focus or hover its list no longer shows. A tab
 *  switch also drops the hover — its row unmounts under the pointer and never
 *  hears it leave. */
function reconcile(tabSwitched: boolean): void {
  const { focus, hover } = useReviewFocus.getState()
  const keepFocus = focus !== null && shown(focus) ? focus : null
  const keepHover = !tabSwitched && hover !== null && shown(hover) ? hover : null
  if (keepFocus !== focus || keepHover !== hover) useReviewFocus.setState({ focus: keepFocus, hover: keepHover })
}

useAgentActivity.subscribe((s, prev) => {
  if (s.snapshot?.workspace_id !== prev.snapshot?.workspace_id) { useReviewFocus.setState({ focus: null, hover: null }); return }
  if (s.tab !== prev.tab || s.snapshot?.tacks !== prev.snapshot?.tacks) reconcile(s.tab !== prev.tab)
})
useReview.subscribe((s, prev) => {
  if (s.view !== prev.view || s.showUser !== prev.showUser || s.activity !== prev.activity) reconcile(false)
})

/** How a clip is outlined for the focus: the focused tack follows it, the
 *  focused change covers it, or the hovered change row does. */
export type FocusMark = 'tack' | 'change' | 'hover'

/** A stretch of a composition's clock the focused item covers, washed across
 *  the editor timeline's lanes. `endUs === startUs` for a point. `historical`:
 *  a removed entity's baseline footprint, which no current content has to be
 *  under — washed in the removed hue, apart from a current range. `trackId`:
 *  the lane a removed clip's footprint was on — while that lane exists its
 *  raised ghost shows the footprint and nothing washes; once it is gone the
 *  footprint washes every lane, the one place left to show it. */
export interface FocusWash { kind: ReviewItem['kind']; compositionId: string; startUs: number; endUs: number; historical?: true; trackId?: string }

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
  if (t.composition_id === null || t.t_us === null) return null
  const end = t.end_t_us !== null && t.end_t_us > t.t_us ? t.end_t_us : t.t_us
  return { kind: 'tack', compositionId: t.composition_id, startUs: t.t_us, endUs: end }
}

/** Project the focus and the hover onto what the editor timeline paints. A
 *  tack outlines the clip its range follows and washes its current range; a
 *  change outlines its clips — or its ghost, removed — and washes its current
 *  range; a removed one, having none,
 *  washes its baseline footprint as historical. Historical footprints of a
 *  modified entity are shown as separate baseline frames. Other entities are
 *  never selected through spatial or causal relationships. */
export function buildFocusPaint(
  focus: ReviewItem | null,
  hover: ReviewItem | null,
  tacks: readonly TackView[],
  changeOf: (item: Extract<ReviewItem, { kind: 'change' }>) => Change | undefined,
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
    const c = changeOf(hover)
    if (c) outline(c, 'hover')
  }
  let changeFocused = false
  if (focus?.kind === 'tack') {
    const t = tacks.find(x => x.id === focus.id)
    if (t) {
      const wash = tackWash(t)
      if (wash) washes.push(wash)
      if (t.follows) layers.set(t.follows.layer_id, 'tack')
    }
  } else if (focus?.kind === 'change') {
    const c = changeOf(focus)
    if (c) {
      changeFocused = true
      outline(c, 'change')
      for (const r of c.ranges) washes.push({ kind: 'change', compositionId: r.composition_id, startUs: r.t_start_us, endUs: Math.max(r.t_start_us, r.t_end_us) })
      for (const r of c.before_ranges ?? []) {
        const wash: FocusWash = { kind: 'change', compositionId: r.composition_id, startUs: r.t_start_us, endUs: Math.max(r.t_start_us, r.t_end_us), historical: true }
        if (c.class === 'removed') washes.push(r.track_id === null ? wash : { ...wash, trackId: r.track_id })
        else historical.push(wash)
      }
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
    return w.kind === o.kind && w.compositionId === o.compositionId && w.startUs === o.startUs && w.endUs === o.endUs &&
      w.historical === o.historical && w.trackId === o.trackId
  })
const sameWas = (a: readonly FocusWas[], b: readonly FocusWas[]) =>
  a.length === b.length && a.every((w, i) => {
    const o = b[i]!
    return w.trackId === o.trackId && w.compositionId === o.compositionId && w.startUs === o.startUs && w.endUs === o.endUs
  })

export const useFocusPaint = create<FocusPaint>(() => EMPTY_FOCUS_PAINT)

const NO_TACKS: TackView[] = []
/** The change a focused or hovered item names, in the set it came from. */
function changeOf(item: Extract<ReviewItem, { kind: 'change' }>): Change | undefined {
  const r = useReview.getState()
  return item.source === 'activity' ? r.activity?.highlight.changes.get(item.id) : listedChanges(r).find(c => c.id === item.id)
}

/** Rebuild, keeping every part that did not change by identity: an agent's
 *  delta re-reads the focused tack, and the clips' selectors and the lanes'
 *  washes should not hear about it unless it moved. */
function refreshFocusPaint(): void {
  const { focus, hover } = useReviewFocus.getState()
  const next = buildFocusPaint(focus, hover, useAgentActivity.getState().snapshot?.tacks ?? NO_TACKS, changeOf)
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

const pointing = () => { const f = useReviewFocus.getState(); return f.focus !== null || f.hover !== null }
useReviewFocus.subscribe(refreshFocusPaint)
useAgentActivity.subscribe((s, prev) => { if (pointing() && s.snapshot?.tacks !== prev.snapshot?.tacks) refreshFocusPaint() })
useReview.subscribe((s, prev) => {
  if (pointing() && (s.view !== prev.view || s.showUser !== prev.showUser || s.activity !== prev.activity)) refreshFocusPaint()
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
/** The focus's washes on the lanes of a timeline. `compositionId` null names
 *  the root, as everywhere on the timeline. */
export function useCompositionFocusWashes(compositionId: string | null): readonly FocusWash[] {
  const overlay = useOverlay()
  const washes = useFocusPaint(s => s.washes)
  const resolved = useProjectStore(s => compositionId ?? s.summary?.root_id ?? null)
  const lanes = useProjectStore(s => (washes.some(w => w.trackId !== undefined) ? s.compositionIdByTrackId : null))
  return useMemo(() => {
    if (!overlay || washes.length === 0 || resolved === null) return NO_WASHES
    // A removed clip whose lane survives is shown by its raised ghost there;
    // only once that lane is gone does its footprint wash every lane.
    const mine = washes.filter(w => w.compositionId === resolved &&
      (w.trackId === undefined || !lanes?.has(w.trackId)))
    return mine.length === 0 ? NO_WASHES : mine
  }, [overlay, washes, resolved, lanes])
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
