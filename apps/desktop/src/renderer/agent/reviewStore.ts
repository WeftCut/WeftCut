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
import { REVIEW_CHANGED_EVENT, reviewActivityView, reviewApprove, reviewApproveAll, reviewView } from '../ipc'
import type { Change, ReviewApproveResult, ReviewVersion, ReviewView } from '../../shared/review'
import { tryMutate } from '../errors/tryMutate'
import { useProjectStore } from '../state/projectStore'
import { useAgentActivity } from './activityStore'
import type { AgentActivity } from '../../shared/agent-activity'
import { buildReviewHighlight, EMPTY_HIGHLIGHT, type ReviewClipMark, type ReviewCut, type ReviewGhost, type ReviewMarkerGhost, type ReviewHighlight, type ReviewRangeMark } from './reviewHighlight'

/** One activity row's own changes (spec Part B, per-activity highlight):
 *  what that call did, shown on the timelines in place of the unreviewed
 *  changes while its row is selected. */
export interface ActivityHighlight {
  activityId: string
  /** The ops asked about, and the row's effect then — a change to either
   *  (the call committed more, an undo reverted it) refetches. */
  historyIds: readonly string[]
  effect: AgentActivity['effect']
  /** `loading`: the first reply is pending (the review highlight still
   *  shows). `unavailable`: an op has left the history window — the row says
   *  so and nothing is highlighted. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Every op is undone; the highlight still shows what the call did. */
  reverted: boolean
  /** Number of entity differences, including ones without a timeline range. */
  count: number
  highlight: ReviewHighlight
}

interface ReviewState {
  view: ReviewView | null
  /** What the timelines paint for the review: the unreviewed changes of
   *  `view`. Rebuilt only when the view is replaced, so per-clip selectors
   *  read a stable map. */
  highlight: ReviewHighlight
  /** The Changes tab's "show my changes" filter: user-only differences are
   *  listed too. Off by default; runtime only, like the review itself. Main
   *  sends that list only while it is on (`setShowUser`). */
  showUser: boolean
  /** Whether `view` was asked for with the user-only list. */
  viewListsUser: boolean
  /** The last approval was refused: the view it was made from had moved on
   *  (an agent committed meanwhile), so nothing was approved and the fresh
   *  list is on screen. Cleared by the next approval. */
  approvalStale: boolean
  /** The selected activity row's changes, preferred by every timeline surface
   *  over `highlight` once ready. Null when no row is selected. */
  activity: ActivityHighlight | null
  /** Take `next` unless it is older than the held view — or, at the same
   *  version, unless it adds nothing (`listsUser` where the held view had no
   *  user list). True when applied. */
  apply: (next: ReviewView, listsUser?: boolean) => boolean
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

/** The changes the Changes tab lists: the unreviewed ones, and the user's own
 *  while "show my changes" is on — what a review focus can name. */
export function listedChanges(s: Pick<ReviewState, 'view' | 'showUser'>): readonly Change[] {
  if (s.view === null) return []
  return s.showUser && s.view.user.length > 0 ? [...s.view.unreviewed, ...s.view.user] : s.view.unreviewed
}

const sameVersion = (a: ReviewVersion, b: ReviewVersion): boolean =>
  a.session === b.session && a.revision === b.revision && a.baseline_revision === b.baseline_revision

export const useReview = create<ReviewState>((set, get) => ({
  view: null,
  highlight: EMPTY_HIGHLIGHT,
  showUser: false,
  viewListsUser: false,
  approvalStale: false,
  activity: null,
  apply: (next, listsUser = false) => {
    const held = get()
    const fillsUser = listsUser && !held.viewListsUser && held.view !== null && sameVersion(next.version, held.view.version)
    if (!fillsUser && !isNewerReviewView(next.version, held.view?.version ?? null)) return false
    set({ view: next, viewListsUser: listsUser, highlight: fillsUser ? held.highlight : buildReviewHighlight(next.unreviewed, next.decorations) })
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
    const listsUser = useReview.getState().showUser
    const next = await reviewView({ include_user: listsUser })
    if (consumers > 0) useReview.getState().apply(next, listsUser)
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
  // So does a selected activity's highlight: it is drawn on the current
  // timeline (main's `carryChangesTo`), which the edit just moved.
  const stopProject = useProjectStore.subscribe((s, prev) => {
    if (s.summary === prev.summary) return
    void refreshReview()
    const held = useReview.getState().activity
    if (held !== null && held.status !== 'loading') void showActivityChanges({ id: held.activityId, history_ids: [...held.historyIds], effect: held.effect })
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

/** Turn "show my changes" on or off; turning it on fetches the user-only list
 *  unless the held view already has it. */
export function setShowUser(on: boolean): void {
  useReview.setState({ showUser: on })
  if (on && consumers > 0 && !useReview.getState().viewListsUser) void refreshReview()
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

/** The number of unreviewed entity differences. */
export function useUnreviewedCount(enabled = true): number {
  useReviewConsumer(enabled)
  return useReview(s => s.view?.unreviewed.length ?? 0)
}

// ── Highlight reads ───────────────────────────────────────────────────────────
//
// Every timeline surface reads the highlight through `selectHighlight`: the one
// place a different change set — the selected activity row's own changes —
// takes over from the unreviewed list.

export const selectHighlight = (s: Pick<ReviewState, 'highlight' | 'activity'>): ReviewHighlight =>
  s.activity?.status === 'ready' ? s.activity.highlight : s.highlight
const NO_GHOSTS: readonly ReviewGhost[] = []
const NO_CUTS: readonly ReviewCut[] = []
const NO_MARKER_GHOSTS: readonly ReviewMarkerGhost[] = []
const NO_RANGES: readonly ReviewRangeMark[] = []

/** The editor timeline paints review marks only under the Review overlay. */
const useOverlay = () => useAgentActivity(s => s.reviewOverlay)

/** A clip's review mark on the editor timeline, or null. */
export function useLayerReviewMark(layerId: string): ReviewClipMark | null {
  const overlay = useOverlay()
  return useReview(s => (overlay ? selectHighlight(s).layers.get(layerId) ?? null : null))
}

/** The change that marks a clip on the editor timeline, or null — what its
 *  tooltip words. Null `layerId` (a duplicate's in-flight clone) reads none. */
export function useLayerReviewChange(layerId: string | null): Change | null {
  const overlay = useOverlay()
  return useReview(s => {
    if (!overlay || layerId === null) return null
    const h = selectHighlight(s)
    const id = h.layerChanges.get(layerId)
    return id === undefined ? null : h.changes.get(id) ?? null
  })
}

/** A highlighted change by id — the words of a mark that names it. */
export function useHighlightedChanges(): ReadonlyMap<string, Change> {
  return useReview(s => selectHighlight(s).changes)
}

/** How many highlighted changes a Group clip contains (0: no badge). */
export function useGroupReviewCount(layerId: string): number {
  const overlay = useOverlay()
  return useReview(s => (overlay ? selectHighlight(s).groups.get(layerId) ?? 0 : 0))
}

/** Whether the timelines show a selected activity's own changes rather than
 *  the unreviewed ones — what a badge counting them calls them. */
export function useActivityHighlightShown(): boolean {
  return useReview(s => s.activity?.status === 'ready')
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

/** A marker's review mark on the editor's marker lane, or null. */
export function useMarkerReviewMark(markerId: string): ReviewClipMark | null {
  const overlay = useOverlay()
  return useReview(s => (overlay ? selectHighlight(s).markers.get(markerId) ?? null : null))
}

/** Removed markers to leave a trace of on one composition's marker lane. */
export function useCompositionMarkerGhosts(compositionId: string | null): readonly ReviewMarkerGhost[] {
  const overlay = useOverlay()
  const ghosts = useReview(s => selectHighlight(s).markerGhosts)
  return useMemo(() => {
    if (!overlay || compositionId === null || ghosts.length === 0) return NO_MARKER_GHOSTS
    const mine = ghosts.filter(g => g.compositionId === compositionId)
    return mine.length === 0 ? NO_MARKER_GHOSTS : mine
  }, [overlay, ghosts, compositionId])
}

/** Trim cut marks on the clip's current lane, in time order. */
export function useTrackReviewCuts(trackId: string): readonly ReviewCut[] {
  const overlay = useOverlay()
  const cuts = useReview(s => selectHighlight(s).cuts)
  const trackOf = useProjectStore(s => (cuts.length === 0 ? null : s.trackIdByLayerId))
  return useMemo(() => {
    if (!overlay || cuts.length === 0) return NO_CUTS
    const mine = cuts.filter(c => (c.trackId ?? trackOf?.get(c.layerId)) === trackId)
    return mine.length === 0 ? NO_CUTS : mine.sort((a, b) => a.tUs - b.tUs)
  }, [overlay, cuts, trackOf, trackId])
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

/** Run one approval against the held view. It names that view's version:
 *  main approves only while it is still current, so a change committed after
 *  the list on screen is never approved unseen. The reply is the fresh view
 *  either way and lands in the store straight away, so the tab updates and
 *  every highlight goes in the same render. True when the approval applied. */
async function approve(
  run: (version: ReviewVersion, includeUser: boolean) => Promise<ReviewApproveResult>,
  context: string,
): Promise<boolean> {
  let applied = false
  const ok = await tryMutate(async () => {
    const { view, showUser } = useReview.getState()
    if (view === null) return
    const r = await run(view.version, showUser)
    useReview.getState().apply(r.view, showUser)
    applied = r.applied
    useReview.setState({ approvalStale: !r.applied })
  }, context)
  return ok && applied
}

/** Approve every unreviewed change of the held view. */
export function approveAllChanges(): Promise<boolean> {
  return approve((version, include_user) => reviewApproveAll({ version, include_user }), 'review_approve_all')
}

/** Approve the given changes of the held view. */
export function approveChanges(changeIds: readonly string[]): Promise<boolean> {
  return approve((version, include_user) => reviewApprove({ version, include_user, change_ids: [...changeIds] }), 'review_approve')
}

// ── Per-activity highlight ────────────────────────────────────────────────────
//
// Selecting an activity row (expanding it) shows what that call did; the
// selection follows the agent panel's state: expanding another row replaces it
// (a row without history ops clears it), collapsing the row, switching tabs or
// a project change clears it. The editor timeline still paints only under the
// Review overlay; the agent view's mini timeline always does.

/** Bumped on every selection change; a reply for an older one is dropped. */
let activityToken = 0

/** Highlight what activity `a` did. Refetching the same row keeps its current
 *  highlight on screen until the reply lands. */
export async function showActivityChanges(a: Pick<AgentActivity, 'id' | 'history_ids' | 'effect'>): Promise<void> {
  if (a.history_ids.length === 0) { clearActivityChanges(); return }
  const token = ++activityToken
  const held = useReview.getState().activity
  const base = held?.activityId === a.id && held.status !== 'loading' ? held : { status: 'loading' as const, reverted: false, count: 0, highlight: EMPTY_HIGHLIGHT }
  useReview.setState({ activity: { ...base, activityId: a.id, historyIds: [...a.history_ids], effect: a.effect } })
  try {
    const v = await reviewActivityView(a.history_ids)
    if (token !== activityToken) return
    const cur = useReview.getState().activity!
    useReview.setState({ activity: v.available
      ? { ...cur, status: 'ready', reverted: v.reverted, count: v.changes.length, highlight: buildReviewHighlight(v.changes, v.decorations) }
      : { ...cur, status: 'unavailable', reverted: false, count: 0, highlight: EMPTY_HIGHLIGHT } })
  } catch {
    if (token === activityToken) useReview.setState({ activity: null })
  }
}

/** Back to the review highlight. */
export function clearActivityChanges(): void {
  activityToken += 1
  if (useReview.getState().activity !== null) useReview.setState({ activity: null })
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The selection rules, driven by the agent panel's store. */
useAgentActivity.subscribe((s, prev) => {
  if (s.snapshot?.workspace_id !== prev.snapshot?.workspace_id || s.tab !== prev.tab) { clearActivityChanges(); return }
  const activities = s.snapshot?.activities ?? []
  if (s.expanded !== prev.expanded) {
    const opened = activities.filter(a => s.expanded[a.id] && !prev.expanded[a.id])
    const pick = opened.at(-1)
    if (pick) { void showActivityChanges(pick); return }
  }
  const held = useReview.getState().activity
  if (held === null) return
  const a = activities.find(x => x.id === held.activityId)
  if (!a || !s.expanded[a.id]) { clearActivityChanges(); return }
  if (!sameIds(a.history_ids, held.historyIds) || a.effect !== held.effect) void showActivityChanges(a)
})

let activityHosts = 0
/** The agent panel hosts the selection: when the last one unmounts, nothing
 *  is left to show or clear it, so the highlight goes with it. */
export function useActivityHighlightHost(): void {
  useEffect(() => {
    activityHosts += 1
    return () => { activityHosts -= 1; if (activityHosts === 0) clearActivityChanges() }
  }, [])
}

/** Test hook: forget every consumer and the held view. */
export function resetReviewForTests(): void {
  teardown?.(); teardown = null; consumers = 0; pending = false; again = false
  activityToken += 1
  useReview.setState({ view: null, viewListsUser: false, approvalStale: false, highlight: EMPTY_HIGHLIGHT, showUser: false, activity: null })
}
