import { create } from 'zustand'
import { listen } from '@/bridge/events'
import { invoke } from '@/bridge/ipc'
import { AGENT_ACTIVITY_EVENT, AGENT_VIEW_EVENT, type AgentActivitySnapshot, type AgentActivityUpdate } from '../../shared/agent-activity'

interface AgentPanelState {
  snapshot: AgentActivitySnapshot | null
  ready: boolean
  mode: 'editor' | 'agent'
  seenSession: string | null
  filter: 'all' | 'errors'
  expanded: Record<string, boolean>
  anchor: { id: string; offset: number } | null
  following: boolean
  receive: (snapshot: AgentActivitySnapshot) => void
  toggle: (id: string, defaultValue?: boolean) => void
}

export const useAgentActivity = create<AgentPanelState>((set) => ({
  snapshot: null, ready: false, mode: 'editor', seenSession: null,
  filter: 'all', expanded: {}, anchor: null, following: true,
  receive: snapshot => set(s => {
    // Revisions are monotonically increasing across project-open instances.
    if (s.snapshot && snapshot.revision <= s.snapshot.revision) return s
    const changedProject = s.snapshot?.workspace_id !== snapshot.workspace_id
    const newSession = snapshot.session && snapshot.session.id !== s.seenSession
    const retained = snapshot.evicted !== s.snapshot?.evicted ? new Set(snapshot.activities.flatMap(a => [a.id, `reads-${a.id}`, `session-${a.id}`])) : null
    return {
      snapshot, ready: true,
      mode: newSession ? 'agent' : changedProject ? 'editor' : s.mode,
      seenSession: snapshot.session?.id ?? (changedProject ? null : s.seenSession),
      ...(retained ? { expanded: Object.fromEntries(Object.entries(s.expanded).filter(([key]) => key === 'connections' || retained.has(key))) } : {}),
      ...(changedProject ? { filter: 'all' as const, expanded: {}, anchor: null, following: true } : {}),
    }
  }),
  toggle: (id, defaultValue = false) => set(s => ({ expanded: { ...s.expanded, [id]: !(s.expanded[id] ?? defaultValue) } })),
}))

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
    useAgentActivity.getState().receive({ ...update, activities: [...activities.values()] })
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
