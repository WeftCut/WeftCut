// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity, AgentActivitySnapshot, AgentWorkSession } from '../../shared/agent-activity'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (e: { payload: unknown }) => void>() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/bridge/events', () => ({ listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name) } }) }))
import { useAgentActivity, wireAgentActivity } from './activityStore'

const work: AgentWorkSession = { id: 'session', connection_id: 'c', client: 'Client', reason: 'Edit', started_at: '', ended_at: null, end_reason: null, checkpoint_id: 'cp' }
function snapshot(revision: number, session: AgentWorkSession | null = null): AgentActivitySnapshot {
  return { workspace_id: 'project', revision, session, sessions: session ? [session] : [], activities: [], evicted: 0, lock_reason: null, checkpoints: [] }
}
beforeEach(() => {
  useAgentActivity.setState({ snapshot: null, ready: false, mode: 'editor', seenSession: null, expanded: {}, filter: 'all', anchor: null, following: true })
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
