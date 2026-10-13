// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from '../i18n'
import type { AgentActivity, AgentActivitySnapshot, TackView } from '../../shared/agent-activity'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), jump: vi.fn(), reveal: vi.fn(() => true) }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('../state/navigation', async (importActual) => ({
  ...await importActual<typeof import('../state/navigation')>(), jumpToTimeUs: mocks.jump, revealLayerWithoutSeek: mocks.reveal,
}))
vi.mock('../settings/AgentSection', () => ({ AgentSection: () => <div>Connection configuration</div> }))
import { AgentPanel } from './AgentPanel'
import { useAgentActivity } from './activityStore'

function activity(patch: Partial<AgentActivity> = {}): AgentActivity {
  return { id: 'a', session_id: null, connection_id: 'c', client: 'Test client', tool: 'analyze_clip', kind: 'read',
    started_at: '2026-09-10T00:00:00Z', ended_at: '2026-09-10T00:00:01Z', state: 'done', duration_ms: 1000,
    message: 'Analyze clip', affected: [{ kind: 'Layer', id: 'gone' }], entity_labels: [{ text: 'Interview A' }],
    history_ids: [], effect: null, args: { layer_id: 'gone' }, error: null, ...patch }
}
function seed(activities: AgentActivity[], patch: Partial<AgentActivitySnapshot> = {}) {
  useAgentActivity.getState().receive({ workspace_id: 'project', revision: 1, session: null, sessions: [], activities, evicted: 0, lock_reason: null, checkpoints: [], tacks: [], ...patch })
}
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  mocks.invoke.mockReset().mockResolvedValue({ available: true, url: 'http://127.0.0.1:1234/mcp', connections: [] })
  mocks.jump.mockReset(); mocks.reveal.mockReset().mockReturnValue(true)
  useAgentActivity.setState({ snapshot: null, ready: false, mode: 'editor', seenSession: null, expanded: {}, filter: 'all', anchor: null, following: true, tab: 'activity', selectedTack: null })
})
afterEach(cleanup)

describe('AgentPanel', () => {
  it('shows readable objects, failures, and connection facts without navigation in agent mode', async () => {
    seed([activity({ state: 'error', error: 'The media file is unavailable' })])
    render(<AgentPanel />)
    expect(screen.getByText('Interview A')).toBeTruthy()
    expect(screen.getByText('The media file is unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Analyze clip/ }))
    expect(screen.queryByRole('button', { name: /Locate object|Object no longer exists/ })).toBeNull()
    await screen.findByText('MCP service ready')
    fireEvent.click(screen.getByRole('button', { name: 'MCP service ready' }))
    expect(screen.getByText('http://127.0.0.1:1234/mcp')).toBeTruthy()
  })

  it('keeps expansion when switching layouts and disables navigation for missing objects', () => {
    seed([activity()])
    const first = render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Analyze clip/ }))
    first.unmount()
    render(<AgentPanel editor />)
    expect(screen.getByRole('button', { name: 'Object no longer exists' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('analyze_clip')).toBeTruthy()
  })

  it('never offers a stale or locked checkpoint restore', () => {
    seed([activity({ kind: 'checkpoint', checkpoint_id: 'cp', message: 'Before edit' })], { checkpoints: [{ id: 'cp', label: 'Before edit' }], lock_reason: '' })
    const first = render(<AgentPanel />)
    expect(screen.getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Unlock undo' })).toBeTruthy()
    act(() => useAgentActivity.getState().receive({ ...useAgentActivity.getState().snapshot!, revision: 2, lock_reason: null, checkpoints: [] }))
    expect(screen.getByRole('button', { name: 'Checkpoint unavailable' }).hasAttribute('disabled')).toBe(true)
    first.unmount()
  })

  it('ends locally through IPC while retaining agent view', async () => {
    const session = { id: 'work', connection_id: 'c', client: 'Client', reason: 'Cut interview', started_at: '', ended_at: null, end_reason: null, checkpoint_id: 'cp' }
    seed([activity({ session_id: 'work' })], { session, sessions: [session] })
    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'End work session' }))
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('agent_session_end'))
    act(() => useAgentActivity.getState().receive({ ...useAgentActivity.getState().snapshot!, revision: 2, session: null, sessions: [{ ...session, ended_at: 'now', end_reason: 'user' }] }))
    expect(useAgentActivity.getState().mode).toBe('agent')
  })
})

function tack(patch: Partial<TackView> = {}): TackView {
  return { id: 't1', session_id: 'work', connection_id: 'c', client: 'Test client', activity_id: 'a', kind: 'issue', label: 'Long pause',
    body: 'Keep the breath?', status: 'open', range: { kind: 'free', composition_id: 'root', t_us: 2_000_000, end_t_us: 3_000_000 },
    created_at: '', composition_id: 'root', t_us: 2_000_000, end_t_us: 3_000_000, state: 'visible', ...patch }
}
const work = { id: 'work', connection_id: 'c', client: 'Client', reason: 'Review pauses', started_at: '', ended_at: null, end_reason: null, checkpoint_id: 'cp' }
const calls = (channel: string) => mocks.invoke.mock.calls.filter(([c]) => c === channel).map(([, args]) => args)
const openTacks = () => fireEvent.click(screen.getByRole('tab', { name: /Tacks/ }))

describe('AgentPanel Tacks tab', () => {
  it('is a second tab beside Activity, with the subtitle and an open count, grouped by work session', () => {
    seed([], { sessions: [work], tacks: [tack(), tack({ id: 't2', session_id: null, label: 'Loose end', status: 'resolved' })] })
    render(<AgentPanel />)
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /Tacks/ }).textContent).toBe('Tacks1')
    openTacks()
    expect(screen.getByText('Notes the agent tacked on for your review')).toBeTruthy()
    expect(screen.getByText('Review pauses')).toBeTruthy()
    expect(screen.getByText('Long pause')).toBeTruthy()
    // A group with nothing open starts collapsed; its heading still says why.
    expect(screen.getByText('Outside a work session')).toBeTruthy()
    expect(screen.queryByText('Loose end')).toBeNull()
    expect(useAgentActivity.getState().tab).toBe('tacks')
  })

  it('resolves, dismisses, reopens and clears through the tack channels', async () => {
    seed([], { sessions: [work], tacks: [tack(), tack({ id: 't2', status: 'dismissed', label: 'Done' })] })
    render(<AgentPanel />)
    openTacks()
    fireEvent.click(screen.getAllByRole('button', { name: 'Resolve' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await vi.waitFor(() => expect(calls('agent_tacks_set_status')).toEqual([{ tack_ids: ['t1'], status: 'resolved' }, { tack_ids: ['t2'], status: 'open' }]))
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!)
    await vi.waitFor(() => expect(calls('agent_tacks_set_status')).toContainEqual({ tack_ids: ['t1'], status: 'dismissed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear resolved & dismissed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await vi.waitFor(() => expect(calls('agent_tacks_delete')).toEqual([{ statuses: ['resolved', 'dismissed'] }, { session_id: 'work' }]))
  })

  it('converts into one recorded marker carrying label, note and anchor, then removes the tack', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'add_marker' ? 'marker-1' : channel === 'agent_tacks_delete' ? { deleted_tack_ids: ['t1'] } : { available: true, url: '', connections: [] })
    const anchored = tack({ range: { kind: 'anchored', layer_id: 'clip', src_us: 5_000_000, src_end_us: 6_000_000, src_fraction: { num: 1, den: 3 } } })
    seed([], { sessions: [work], tacks: [anchored] })
    render(<AgentPanel />)
    openTacks()
    fireEvent.click(screen.getByRole('button', { name: /Long pause/ }))
    expect(screen.getByText('Keep the breath?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Convert to marker' }))
    await vi.waitFor(() => expect(calls('agent_tacks_delete')).toEqual([{ tack_ids: ['t1'] }]))
    expect(calls('add_marker')).toEqual([{ tUs: 2_000_000, endTUs: 3_000_000, label: 'Long pause', note: 'Keep the breath?', compositionId: 'root',
      anchor: { layer: 'clip', src_us: 5_000_000, src_fraction: { num: 1, den: 3 } } }])
    const order = mocks.invoke.mock.calls.map(([c]) => c).filter(c => c === 'add_marker' || c === 'agent_tacks_delete')
    expect(order).toEqual(['add_marker', 'agent_tacks_delete'])
  })

  it('keeps the tack when the marker is refused, and converts a free tack without an anchor', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => { if (channel === 'add_marker') throw new Error('refused'); return null })
    seed([], { sessions: [work], tacks: [tack()] })
    render(<AgentPanel />)
    openTacks()
    fireEvent.click(screen.getByRole('button', { name: /Long pause/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Convert to marker' }))
    await vi.waitFor(() => expect(calls('add_marker')).toHaveLength(1))
    expect(calls('add_marker')[0]).toMatchObject({ anchor: null })
    await new Promise(r => setTimeout(r, 0))
    expect(calls('agent_tacks_delete')).toEqual([])
  })

  it('lists stale and hibernating tacks with their state, refusing locate and convert with the reason', () => {
    seed([], { sessions: [work], tacks: [
      tack({ id: 's', label: 'Gone', state: 'stale', composition_id: null, t_us: null, end_t_us: null }),
      tack({ id: 'h', label: 'Asleep', state: 'hibernating', t_us: null, end_t_us: null }),
    ] })
    render(<AgentPanel editor />)
    openTacks()
    expect(screen.getByText('No longer on the timeline')).toBeTruthy()
    expect(screen.getByText('Hibernating')).toBeTruthy()
    const locates = screen.getAllByRole('button', { name: 'Locate on the timeline' })
    expect(locates.every(b => b.hasAttribute('disabled'))).toBe(true)
    expect(locates[1]!.getAttribute('title')).toMatch(/^Hibernating: its clip no longer shows/)
    fireEvent.click(screen.getByRole('button', { name: /Gone/ }))
    const convert = screen.getByRole('button', { name: 'Convert to marker' })
    expect(convert.hasAttribute('disabled')).toBe(true)
    expect(convert.getAttribute('title')).toMatch(/no longer exists/)
  })

  it('locates in the editor only: seek, and reveal the anchor clip', () => {
    const anchored = tack({ range: { kind: 'anchored', layer_id: 'clip', src_us: 5_000_000, src_end_us: null } })
    seed([], { sessions: [work], tacks: [anchored] })
    const agentView = render(<AgentPanel />)
    openTacks()
    expect(screen.queryByRole('button', { name: 'Locate on the timeline' })).toBeNull()
    agentView.unmount()
    render(<AgentPanel editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Locate on the timeline' }))
    expect(mocks.reveal).toHaveBeenCalledWith('clip')
    expect(mocks.jump).toHaveBeenCalledWith(2_000_000)
    expect(useAgentActivity.getState().selectedTack).toBe('t1')
  })

  it('selectTack opens the tab, its group and its row', () => {
    seed([], { sessions: [work], tacks: [tack({ status: 'dismissed' })] })
    render(<AgentPanel />)
    act(() => useAgentActivity.getState().selectTack('t1'))
    expect(screen.getByRole('tab', { name: /Tacks/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Keep the breath?')).toBeTruthy()
    expect(document.querySelector('[data-tack-id="t1"]')?.getAttribute('data-selected')).toBe('true')
  })

  it('names tacks 批注 in Chinese and never shows Tack', async () => {
    await i18n.changeLanguage('zh-CN')
    seed([], { sessions: [work], tacks: [tack()] })
    const { container } = render(<AgentPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /批注/ }))
    expect(screen.getByText('代理留下、供你审阅的批注')).toBeTruthy()
    expect(container.textContent).not.toMatch(/tack/i)
  })
})
