// The renderer's copy of the Review view (spec `.scratch/agent-review/spec.md`
// Part B; ADR 0115): unreviewed changes, the user's own, and the Group layers
// containing either. Main computes it lazily, so the renderer reads it only
// while a review surface is mounted — the Changes tab, the editor timeline under
// the Review overlay, the agent view's mini timeline, the status bar count.
//
// One owner: consumers `acquireReview()` (or `useReviewView()`); the first one
// subscribes to `review:changed` and to project publications and fetches, the
// last one to leave unsubscribes. Replies older than the view held — by project
// publication or by baseline revision — are dropped, so a fetch that started
// before an approval can never paint the approved changes back.
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { listen, type UnlistenFn } from '@/bridge/events'
import { REVIEW_CHANGED_EVENT, reviewApprove, reviewApproveAll, reviewView } from '../ipc'
import type { ReviewView } from '../../shared/review'
import { tryMutate } from '../errors/tryMutate'
import { useProjectStore } from '../state/projectStore'
import { useAgentActivity } from './activityStore'
import { buildReviewHighlight, EMPTY_HIGHLIGHT, type ReviewClipMark, type ReviewGhost, type ReviewHighlight, type ReviewRangeMark } from './reviewHighlight'

interface ReviewState {
  view: ReviewView | null
  /** What the timelines paint for the review: the unreviewed changes of
   *  `view`. Rebuilt only when the view is replaced, so per-clip selectors
   *  read a stable map. */
  highlight: ReviewHighlight
  /** The Changes tab's "show my changes" filter: user-only differences are
   *  listed too. Off by default; runtime only, like the review itself. */
  showUser: boolean
  /** Take `next` unless it is older than the held view. True when applied. */
  apply: (next: ReviewView) => boolean
}

/** Is `next` a strictly newer view than `held`? A view is identified by its
 *  project publication plus the baseline revision; within one session both
 *  only grow, so a reply behind on either was computed before the held one. A
 *  later session always wins (the project was replaced). */
export function isNewerReviewView(next: ReviewView['version'], held: ReviewView['version'] | null): boolean {
  if (held === null) return true
  if (next.session !== held.session) return next.session > held.session
  if (next.revision < held.revision || next.baseline_revision < held.baseline_revision) return false
  return next.revision > held.revision || next.baseline_revision > held.baseline_revision
}

export const useReview = create<ReviewState>((set, get) => ({
  view: null,
  highlight: EMPTY_HIGHLIGHT,
  showUser: false,
  apply: next => {
    if (!isNewerReviewView(next.version, get().view?.version ?? null)) return false
    set({ view: next, highlight: buildReviewHighlight(next.unreviewed, next.decorations) })
    return true
  },
}))

// ── Ownership ──────────────────────────────────────────────────────────────────

let consumers = 0
let teardown: (() => void) | null = null
let pending = false
let again = false

/** Fetch the view now (coalesced: one read in flight, at most one queued). A
 *  failed read keeps the last good view; the next event retries. */
export async function refreshReview(): Promise<void> {
  if (pending) { again = true; return }
  pending = true
  try {
    const next = await reviewView()
    if (consumers > 0) useReview.getState().apply(next)
  } catch { /* keep the last good view */ }
  finally {
    pending = false
    if (again && consumers > 0) { again = false; void refreshReview() }
    else again = false
  }
}

function wire(): () => void {
  let disposed = false
  let stopEvent: UnlistenFn | null = null
  listen(REVIEW_CHANGED_EVENT, () => { if (!disposed) void refreshReview() })
    .then(stop => { if (disposed) stop(); else stopEvent = stop })
    .catch(() => { /* no bridge (tests, closed window): publications still refetch */ })
  // A project edit changes the diff without touching the baseline; the review
  // follows every publication the project store applies.
  const stopProject = useProjectStore.subscribe((s, prev) => {
    if (s.summary !== prev.summary) void refreshReview()
  })
  void refreshReview()
  return () => { disposed = true; stopEvent?.(); stopProject() }
}

/** Register a review consumer; the returned function releases it. */
export function acquireReview(): () => void {
  consumers += 1
  if (consumers === 1) teardown = wire()
  let released = false
  return () => {
    if (released) return
    released = true
    consumers -= 1
    if (consumers === 0) { teardown?.(); teardown = null }
  }
}

/** Keep the Review view fresh while the calling component is mounted (and
 *  `enabled`), without reading it — for a large surface whose leaves read
 *  their own slice (the editor timeline). */
export function useReviewConsumer(enabled = true): void {
  useEffect(() => (enabled ? acquireReview() : undefined), [enabled])
}

/** Keep the Review view fresh while mounted, and read it. */
export function useReviewView(enabled = true): ReviewView | null {
  useReviewConsumer(enabled)
  return useReview(s => s.view)
}

/** The number of unreviewed changes, as a consumer. */
export function useUnreviewedCount(enabled = true): number {
  useReviewConsumer(enabled)
  return useReview(s => s.view?.unreviewed.length ?? 0)
}

// ── Highlight reads ───────────────────────────────────────────────────────────
//
// Every timeline surface reads the highlight through `selectHighlight`: the one
// place a different change set (one activity's diff, ticket 07) takes over
// from the unreviewed list.

const selectHighlight = (s: ReviewState): ReviewHighlight => s.highlight
const NO_GHOSTS: readonly ReviewGhost[] = []
const NO_RANGES: readonly ReviewRangeMark[] = []

/** The editor timeline paints review marks only under the Review overlay. */
const useOverlay = () => useAgentActivity(s => s.reviewOverlay)

/** A clip's review mark on the editor timeline, or null. */
export function useLayerReviewMark(layerId: string): ReviewClipMark | null {
  const overlay = useOverlay()
  return useReview(s => (overlay ? selectHighlight(s).layers.get(layerId) ?? null : null))
}

/** How many highlighted changes a Group clip contains (0: no badge). */
export function useGroupReviewCount(layerId: string): number {
  const overlay = useOverlay()
  return useReview(s => (overlay ? selectHighlight(s).groups.get(layerId) ?? 0 : 0))
}

/** Removed layers to outline on one track of the editor timeline. */
export function useTrackReviewGhosts(trackId: string): readonly ReviewGhost[] {
  const overlay = useOverlay()
  const ghosts = useReview(s => selectHighlight(s).ghosts)
  return useMemo(() => {
    if (!overlay || ghosts.length === 0) return NO_GHOSTS
    const mine = ghosts.filter(g => g.trackId === trackId)
    return mine.length === 0 ? NO_GHOSTS : mine
  }, [overlay, ghosts, trackId])
}

/** Change ranges on one composition — the mini timeline's change band. Not
 *  gated by the overlay: the agent view has no overlay switch. */
export function useCompositionChangeRanges(compositionId: string | null): readonly ReviewRangeMark[] {
  const ranges = useReview(s => selectHighlight(s).ranges)
  return useMemo(() => {
    if (compositionId === null || ranges.length === 0) return NO_RANGES
    return ranges.filter(r => r.compositionId === compositionId)
  }, [ranges, compositionId])
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** Approve every unreviewed change. The reply is the fresh view and lands in
 *  the store straight away, so the tab empties and every highlight goes in the
 *  same render. */
export function approveAllChanges(): Promise<boolean> {
  return tryMutate(async () => { useReview.getState().apply(await reviewApproveAll()) }, 'review_approve_all')
}

/** Approve the given changes (a shift group approves as one). */
export function approveChanges(changeIds: readonly string[]): Promise<boolean> {
  return tryMutate(async () => { useReview.getState().apply(await reviewApprove({ change_ids: [...changeIds] })) }, 'review_approve')
}

/** Test hook: forget every consumer and the held view. */
export function resetReviewForTests(): void {
  teardown?.(); teardown = null; consumers = 0; pending = false; again = false
  useReview.setState({ view: null, highlight: EMPTY_HIGHLIGHT, showUser: false })
}
