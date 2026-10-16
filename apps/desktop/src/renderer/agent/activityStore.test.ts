// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity, AgentActivitySnapshot, AgentWorkSession, TackView } from '../../shared/agent-activity'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (e: { payload: unknown }) => void>() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/bridge/events', () => ({ listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name) } }) }))
import { useAgentActivity, wireAgentActivity } from './activityStore'

const work: AgentWorkSession = { id: 'session', connection_id: 'c', client: 'Client', reason: 'Edit', started_at: '', ended_at: null, end_reason: null, checkpoint_id: 'cp' }
function snapshot(revision: number, session: AgentWorkSession | null = null): AgentActivitySnapshot {
  return { workspace_id: 'project', revision, session, sessions: session ? [session] : [], activities: [], evicted: 0, lock_reason: null, checkpoints: [], tacks: [] }
}
beforeEach(() => {
  useAgentActivity.setState({ snapshot: null, ready: false, mode: 'editor', seenSession: null, expanded: {}, filter: 'all', anchor: null, following: true, tab: 'activity' })
  mocks.invoke.mockReset(); mocks.listeners.clear()
})
describe('agent view and snapshot state', () => {
  it('enters for a new real session once, but never switches view on end or repeated begin', () => {
    const receive = useAgentActivity.getState().receive
    receive(snapshot(1, work))
    expect(useAgentActivity.getState().mode).toBe('agent')
    useAgentActivity.setState({ mode: 'editor', expanded: { entry: true }, filter: 'errors', following: false, anchor: { id: 'entry', offset: 2 } })
    receive(snapshot(2, work))
    expect(useAgentActivity.getState()).toMatchObject({ mode: 'editor', expanded: { entry: true }, filter: 'errors', following: false })
    receive(snapshot(3))
    expect(useAgentActivity.getState().mode).toBe('editor')
    useAgentActivity.setState({ mode: 'agent' })
    receive(snapshot(4))
    expect(useAgentActivity.getState().mode).toBe('agent')
  })
  it('rejects late snapshots and resets state on a new project opening', () => {
    const receive = useAgentActivity.getState().receive
    receive(snapshot(4, work)); receive(snapshot(2))
    expect(useAgentActivity.getState().snapshot?.revision).toBe(4)
    receive({ ...snapshot(5), workspace_id: 'reopened' })
    expect(useAgentActivity.getState()).toMatchObject({ mode: 'editor', expanded: {}, following: true })
  })
  it('settles what is expanded as each snapshot arrives: an emptied closed section forgets it was open', () => {
    const receive = useAgentActivity.getState().receive
    const tack = (status: TackView['status']) => ({ id: 't1', session_id: 'session', status }) as TackView
    receive({ ...snapshot(1, work), tacks: [tack('open'), { ...tack('resolved'), id: 't2' }] })
    useAgentActivity.setState({ expanded: { 'tacks-closed-session': true } })
    receive({ ...snapshot(2, work), tacks: [tack('open'), { ...tack('open'), id: 't2' }] })
    expect(useAgentActivity.getState().expanded).toEqual({})
  })
  it('repairs a dropped event through a new snapshot and unsubscribes', async () => {
    mocks.invoke.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(4))
    const stop = await wireAgentActivity()
    mocks.listeners.get('agent_activity:changed')?.({ payload: { ...snapshot(3), from_revision: 2, reset: false, removed_ids: [] } })
    await vi.waitFor(() => expect(useAgentActivity.getState().snapshot?.revision).toBe(4))
    stop()
    expect(mocks.listeners.size).toBe(0)
  })

  it('merges completion and eviction deltas without losing concurrent running work', async () => {
    const activity = (id: string): AgentActivity => ({ id, session_id: null, connection_id: 'c', client: 'Client',
      tool: 'analyze_clip', kind: 'read', started_at: '', ended_at: null, state: 'running', duration_ms: null,
      message: '', affected: [], entity_labels: [], history_ids: [], effect: null, args: {}, error: null })
    const a = activity('a'), b = activity('b')
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(1), activities: [a, b] })
    const stop = await wireAgentActivity()
    try {
      useAgentActivity.setState({ expanded: { a: true, b: true, connections: true }, following: false, anchor: { id: 'b', offset: 4 } })
      mocks.listeners.get('agent_activity:changed')?.({ payload: { ...snapshot(2), from_revision: 1, reset: false, removed_ids: [], activities: [{ ...a, state: 'done' }] } })
      expect(useAgentActivity.getState().snapshot?.activities.map(a => a.state)).toEqual(['done', 'running'])
      mocks.listeners.get('agent_activity:changed')?.({ payload: { ...snapshot(3), from_revision: 2, reset: false, removed_ids: ['a'], evicted: 1 } })
      expect(useAgentActivity.getState().snapshot?.activities).toEqual([b])
      expect(useAgentActivity.getState()).toMatchObject({ expanded: { b: true, connections: true }, following: false, anchor: { id: 'b', offset: 4 } })
      expect(useAgentActivity.getState().expanded.a).toBeUndefined()
    } finally { stop() }
  })

  it('merges tack deltas in creation order and drops them on a reset', async () => {
    const tack = (id: string, patch: Partial<TackView> = {}): TackView => ({ id, session_id: null, connection_id: 'c', client: 'Client',
      activity_id: 'a', kind: 'note', label: id, body: '', status: 'open', created_at: '',
      range: { composition_id: 'root', t_us: 0, end_t_us: null }, composition_id: 'root', t_us: 0, end_t_us: null,
      outdated: false, follows: null, ...patch })
    const delta = (revision: number, patch: Record<string, unknown>) => ({ payload: { ...snapshot(revision), from_revision: revision - 1, reset: false, removed_ids: [], removed_tack_ids: [], ...patch } })
    mocks.invoke.mockResolvedValueOnce({ ...snapshot(1), tacks: [tack('a'), tack('b')] })
    const stop = await wireAgentActivity()
    try {
      const changed = mocks.listeners.get('agent_activity:changed')!
      changed(delta(2, { tacks: [tack('a', { status: 'resolved' }), tack('c')] }))
      expect(useAgentActivity.getState().snapshot?.tacks.map(t => [t.id, t.status])).toEqual([['a', 'resolved'], ['b', 'open'], ['c', 'open']])
      changed(delta(3, { removed_tack_ids: ['b'] }))
      expect(useAgentActivity.getState().snapshot?.tacks.map(t => t.id)).toEqual(['a', 'c'])
      changed(delta(4, { tacks: [tack('b', { outdated: true })], removed_tack_ids: ['a'] }))
      expect(useAgentActivity.getState().snapshot?.tacks.map(t => [t.id, t.outdated])).toEqual([['c', false], ['b', true]])
      changed({ payload: { ...snapshot(5), workspace_id: 'reopened', from_revision: 0, reset: true, removed_ids: [], removed_tack_ids: [] } })
      expect(useAgentActivity.getState().snapshot?.tacks).toEqual([])
    } finally { stop() }
  })

  it('does not let an initial snapshot overwrite a newer reset notification', async () => {
    let resolve!: (s: AgentActivitySnapshot) => void
    mocks.invoke.mockReturnValue(new Promise<AgentActivitySnapshot>(r => { resolve = r }))
    const wiring = wireAgentActivity()
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
    mocks.listeners.get('agent_activity:changed')?.({ payload: { ...snapshot(5, work), reset: true, from_revision: 0, removed_ids: [] } })
    resolve(snapshot(1))
    const stop = await wiring
    expect(useAgentActivity.getState().snapshot?.revision).toBe(5)
    expect(useAgentActivity.getState().snapshot?.session?.id).toBe(work.id)
    stop()
  })
})
