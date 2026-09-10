// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from '../i18n'
import type { AgentActivity, AgentActivitySnapshot } from '../../shared/agent-activity'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
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
  useAgentActivity.getState().receive({ workspace_id: 'project', revision: 1, session: null, sessions: [], activities, evicted: 0, lock_reason: null, checkpoints: [], ...patch })
}
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  mocks.invoke.mockReset().mockResolvedValue({ available: true, url: 'http://127.0.0.1:1234/mcp', connections: [] })
  useAgentActivity.setState({ snapshot: null, ready: false, mode: 'editor', seenSession: null, expanded: {}, filter: 'all', anchor: null, following: true })
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
