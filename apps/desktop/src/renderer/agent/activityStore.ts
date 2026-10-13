import { create } from 'zustand'
import { listen } from '@/bridge/events'
import { invoke } from '@/bridge/ipc'
import { AGENT_ACTIVITY_EVENT, AGENT_VIEW_EVENT, type AgentActivitySnapshot, type AgentActivityUpdate } from '../../shared/agent-activity'

/** The agent panel's tabs, in display order: Activity · Tacks · Changes. */
export const AGENT_PANEL_TABS = ['activity', 'tacks', 'changes'] as const
export type AgentPanelTab = (typeof AGENT_PANEL_TABS)[number]

/** Expansion key of a tack row and of a tack group (work session, or `none`
 *  for tacks created outside one). Prefixed so activity eviction keeps them. */
export const tackRowKey = (id: string) => `tack-${id}`
export const tackGroupKey = (sessionId: string | null) => `tacks-session-${sessionId ?? 'none'}`

/** One review item — a tack or an unreviewed (or the user's own) change — as
 *  the panel and the timelines point at it together (the review focus). */
export interface ReviewItem { kind: 'tack' | 'change'; id: string }

/** The tab that lists a review item's kind. */
const TAB_OF: Record<ReviewItem['kind'], AgentPanelTab> = { tack: 'tacks', change: 'changes' }

const sameItem = (a: ReviewItem | null, b: ReviewItem | null) => a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id)

interface AgentPanelState {
  snapshot: AgentActivitySnapshot | null
  ready: boolean
  mode: 'editor' | 'agent'
  seenSession: string | null
  filter: 'all' | 'errors'
  expanded: Record<string, boolean>
  anchor: { id: string; offset: number } | null
  following: boolean
  tab: AgentPanelTab
  /** The review focus: the one tack or change the panel and the timelines
   *  point at together — its row highlighted, its chip solid, its range washed
   *  across the editor's lanes, its clips outlined. One for both kinds, so
   *  choosing a change lets go of a tack. A fresh object on every select, even
   *  of the same item: the timelines bring it into view per select, not per id.
   *  Cleared when the item goes (deleted, approved), when a tab not listing its
   *  kind opens, and with the project opening. */
  reviewFocus: ReviewItem | null
  /** The row under the pointer: outlines its chip, mini mark and clips without
   *  selecting anything. Transient, and cleared with its row. */
  reviewHover: ReviewItem | null
  /** The editor timeline's Review overlay (the Review lane of tack chips; the
   *  Changes decorations on clips and lanes, `timeline/ReviewMarks.tsx`).
   *  Runtime-only like the material it shows: on by default, kept across
   *  project openings within one app run, not persisted. */
  reviewOverlay: boolean
  receive: (snapshot: AgentActivitySnapshot) => void
  toggle: (id: string, defaultValue?: boolean) => void
  setReviewFocus: (item: ReviewItem | null) => void
  setReviewHover: (item: ReviewItem | null) => void
  /** Focus one tack and show it in the Tacks tab: switch to it, expand its
   *  group and row. */
  selectTack: (id: string) => void
  /** Focus one change and show it in the Changes tab. */
  selectChange: (id: string) => void
}

export const useAgentActivity = create<AgentPanelState>((set) => ({
  snapshot: null, ready: false, mode: 'editor', seenSession: null,
  filter: 'all', expanded: {}, anchor: null, following: true,
  tab: 'activity', reviewFocus: null, reviewHover: null, reviewOverlay: true,
  receive: snapshot => set(s => {
    // Revisions are monotonically increasing across project-open instances.
    if (s.snapshot && snapshot.revision <= s.snapshot.revision) return s
    const changedProject = s.snapshot?.workspace_id !== snapshot.workspace_id
    const newSession = snapshot.session && snapshot.session.id !== s.seenSession
    const retained = snapshot.evicted !== s.snapshot?.evicted ? new Set(snapshot.activities.flatMap(a => [a.id, `reads-${a.id}`, `session-${a.id}`])) : null
    // A deleted tack takes the focus and the hover with it; changes are the
    // Review view's to drop (`reviewStore.ts`).
    const gone = (item: ReviewItem | null) => item?.kind === 'tack' && !snapshot.tacks.some(t => t.id === item.id)
    return {
      ...(gone(s.reviewFocus) ? { reviewFocus: null } : {}),
      ...(gone(s.reviewHover) ? { reviewHover: null } : {}),
      snapshot, ready: true,
      mode: newSession ? 'agent' : changedProject ? 'editor' : s.mode,
      seenSession: snapshot.session?.id ?? (changedProject ? null : s.seenSession),
      ...(retained ? { expanded: Object.fromEntries(Object.entries(s.expanded).filter(([key]) => key === 'connections' || key.startsWith('tack') || retained.has(key))) } : {}),
      ...(changedProject ? { filter: 'all' as const, expanded: {}, anchor: null, following: true, reviewFocus: null, reviewHover: null } : {}),
    }
  }),
  toggle: (id, defaultValue = false) => set(s => ({ expanded: { ...s.expanded, [id]: !(s.expanded[id] ?? defaultValue) } })),
  setReviewFocus: item => set({ reviewFocus: item === null ? null : { kind: item.kind, id: item.id } }),
  setReviewHover: item => set(s => (sameItem(s.reviewHover, item) ? s : { reviewHover: item })),
  selectTack: id => set(s => {
    const tack = s.snapshot?.tacks.find(t => t.id === id)
    if (!tack) return s
    return { tab: 'tacks', reviewFocus: { kind: 'tack', id }, expanded: { ...s.expanded, [tackGroupKey(tack.session_id)]: true, [tackRowKey(id)]: true } }
  }),
  selectChange: id => set({ tab: 'changes', reviewFocus: { kind: 'change', id } }),
}))

/** The focused tack's id, or null. */
export const selectFocusedTack = (s: Pick<AgentPanelState, 'reviewFocus'>): string | null =>
  s.reviewFocus?.kind === 'tack' ? s.reviewFocus.id : null

// A tab shows one kind of review item: opening one that does not list the
// focused item's kind lets go of it, rather than leave a wash on the timeline
// for a row nobody can see. The hover goes with any switch — its row unmounts
// under the pointer and never hears the pointer leave.
useAgentActivity.subscribe((s, prev) => {
  if (s.tab === prev.tab) return
  const focus = s.reviewFocus !== null && TAB_OF[s.reviewFocus.kind] !== s.tab ? null : s.reviewFocus
  if (focus !== s.reviewFocus || s.reviewHover !== null) useAgentActivity.setState({ reviewFocus: focus, reviewHover: null })
})

/** Subscribe before snapshot; late snapshots cannot overwrite newer events.
 * A low-frequency reconciliation also repairs dropped IPC notifications. */
export async function wireAgentActivity(): Promise<() => void> {
  let disposed = false
  let pending = false
  let again = false
  const refresh = async () => {
    if (pending) { again = true; return }
    pending = true
    try {
      const snapshot = await invoke<AgentActivitySnapshot>('agent_activity_snapshot')
      if (!disposed) useAgentActivity.getState().receive(snapshot)
    } catch { /* next reconciliation retries; don't invent an empty snapshot */ }
    finally {
      pending = false
      if (again && !disposed) { again = false; void refresh() }
    }
  }
  const stop = await listen<AgentActivityUpdate>(AGENT_ACTIVITY_EVENT, e => {
    if (disposed) return
    const current = useAgentActivity.getState().snapshot, update = e.payload
    if (current && update.revision <= current.revision) return
    if (!update.reset && (!current || current.revision !== update.from_revision)) { void refresh(); return }
    const activities = new Map((update.reset ? [] : current?.activities ?? []).map(a => [a.id, a]))
    for (const id of update.removed_ids) activities.delete(id)
    for (const a of update.activities) activities.set(a.id, a)
    // Tacks ride the same delta: changed records replace in place, new ones
    // append, so the merged list stays in creation order.
    const tacks = new Map((update.reset ? [] : current?.tacks ?? []).map(t => [t.id, t]))
    for (const id of update.removed_tack_ids ?? []) tacks.delete(id)
    for (const t of update.tacks ?? []) tacks.set(t.id, t)
    useAgentActivity.getState().receive({ ...update, activities: [...activities.values()], tacks: [...tacks.values()] })
  })
  const stopView = await listen<{ workspace_id: string }>(AGENT_VIEW_EVENT, e => {
    if (!disposed && e.payload.workspace_id === useAgentActivity.getState().snapshot?.workspace_id) {
      useAgentActivity.setState({ mode: 'agent' })
    }
  })
  await refresh()
  const timer = setInterval(() => void refresh(), 3000)
  return () => { disposed = true; clearInterval(timer); stop(); stopView() }
}
