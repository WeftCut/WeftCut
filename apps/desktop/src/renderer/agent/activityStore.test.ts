// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity, AgentActivitySnapshot, AgentWorkSession, TackView } from '../../shared/agent-activity'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (e: { payload: unknown }) => void>() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/bridge/events', () => ({ listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name) } }) }))
import { tackGroupKey, tackRowKey, useAgentActivity, wireAgentActivity } from './activityStore'

const tackView = (id: string, patch: Partial<TackView> = {}): TackView => ({ id, session_id: 'session', connection_id: 'c', client: 'Client',
  activity_id: 'a', kind: 'note', label: id, body: '', status: 'open', created_at: '',
  range: { composition_id: 'root', t_us: 0, end_t_us: null }, composition_id: 'root', t_us: 0, end_t_us: null,
  outdated: false, follows: null, ...patch })
const work: AgentWorkSession = { id: 'session', connection_id: 'c', client: 'Client', reason: 'Edit', started_at: '', ended_at: null, end_reason: null, checkpoint_id: 'cp' }
function snapshot(revision: number, session: AgentWorkSession | null = null): AgentActivitySnapshot {
  return { workspace_id: 'project', revision, session, sessions: session ? [session] : [], activities: [], evicted: 0, lock_reason: null, checkpoints: [], tacks: [] }
}
beforeEach(() => {
  useAgentActivity.setState({ snapshot: null, ready: false, mode: 'editor', seenSession: null, expanded: {}, filter: 'all', anchor: null, following: true, tab: 'activity', reviewFocus: null, reviewHover: null })
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

describe('review focus', () => {
  const seed = (tacks: TackView[]) => useAgentActivity.getState().receive({ ...snapshot(1, work), tacks })
  const state = () => useAgentActivity.getState()

  it('is one focus for tacks and changes: choosing one kind lets the other go', () => {
    seed([tackView('t1')])
    state().selectTack('t1')
    expect(state()).toMatchObject({ tab: 'tacks', reviewFocus: { kind: 'tack', id: 't1' } })
    expect(state().expanded).toMatchObject({ [tackGroupKey('session')]: true, [tackRowKey('t1')]: true })
    state().selectChange('Layer:x')
    expect(state()).toMatchObject({ tab: 'changes', reviewFocus: { kind: 'change', id: 'Layer:x' } })
    state().setReviewFocus({ kind: 'tack', id: 't1' })
    expect(state().reviewFocus).toEqual({ kind: 'tack', id: 't1' })
  })

  it('makes a fresh focus per select, even of the same item, so surfaces can reveal it again', () => {
    seed([tackView('t1')])
    state().selectTack('t1')
    const first = state().reviewFocus
    state().selectTack('t1')
    expect(state().reviewFocus).toEqual(first)
    expect(state().reviewFocus).not.toBe(first)
  })

  it('keeps the hover object while it names the same row', () => {
    state().setReviewHover({ kind: 'change', id: 'c' })
    const held = state().reviewHover
    state().setReviewHover({ kind: 'change', id: 'c' })
    expect(state().reviewHover).toBe(held)
    state().setReviewHover(null)
    expect(state().reviewHover).toBeNull()
  })

  it('goes with its tack: a snapshot without it clears focus and hover, one with it keeps them', () => {
    seed([tackView('t1'), tackView('t2')])
    useAgentActivity.setState({ reviewFocus: { kind: 'tack', id: 't1' }, reviewHover: { kind: 'tack', id: 't2' } })
    state().receive({ ...snapshot(2, work), tacks: [tackView('t1', { status: 'resolved' }), tackView('t2')] })
    expect(state()).toMatchObject({ reviewFocus: { kind: 'tack', id: 't1' }, reviewHover: { kind: 'tack', id: 't2' } })
    state().receive({ ...snapshot(3, work), tacks: [tackView('t2')] })
    expect(state()).toMatchObject({ reviewFocus: null, reviewHover: { kind: 'tack', id: 't2' } })
    state().receive({ ...snapshot(4, work), tacks: [] })
    expect(state().reviewHover).toBeNull()
  })

  it('a change focus is not the snapshot\'s to drop; a new project opening drops any focus', () => {
    seed([])
    useAgentActivity.setState({ reviewFocus: { kind: 'change', id: 'Layer:x' } })
    state().receive({ ...snapshot(2, work), tacks: [] })
    expect(state().reviewFocus).toEqual({ kind: 'change', id: 'Layer:x' })
    state().receive({ ...snapshot(3), workspace_id: 'reopened' })
    expect(state()).toMatchObject({ reviewFocus: null, reviewHover: null })
  })

  it('lets go on a tab that does not list its kind, and drops the hover on any tab switch', () => {
    seed([tackView('t1')])
    state().selectTack('t1')
    useAgentActivity.setState({ reviewHover: { kind: 'tack', id: 't1' } })
    useAgentActivity.setState({ tab: 'tacks' })
    expect(state().reviewHover).not.toBeNull()
    useAgentActivity.setState({ tab: 'activity' })
    expect(state()).toMatchObject({ reviewFocus: null, reviewHover: null })
    state().selectChange('Layer:x')
    useAgentActivity.setState({ tab: 'tacks' })
    expect(state().reviewFocus).toBeNull()
  })
})
