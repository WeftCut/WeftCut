// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import i18n from '../i18n'
import type { AgentActivity, AgentActivitySnapshot, TackView } from '../../shared/agent-activity'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), jump: vi.fn(), reveal: vi.fn(() => true), seekLocal: vi.fn() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('../state/navigation', async (importActual) => ({
  ...await importActual<typeof import('../state/navigation')>(), jumpToTimeUs: mocks.jump, revealLayerWithoutSeek: mocks.reveal,
}))
vi.mock('../state/playheadProjection', async (importActual) => ({
  ...await importActual<typeof import('../state/playheadProjection')>(), seekLocalUs: mocks.seekLocal,
}))
vi.mock('../settings/AgentSection', () => ({ AgentSection: () => <div>Connection configuration</div> }))
import { AgentPanel } from './AgentPanel'
import { useAgentActivity } from './activityStore'
import { resetReviewForTests, useReview } from './reviewStore'
import { useProjectStore } from '../state/projectStore'
import { ROOT_ID, summaryFixture } from '../testing/summaryFixture'
import type { LayerSummary } from '../ipc'
import { selectTack, useReviewFocus } from './reviewFocus'

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
  mocks.jump.mockReset(); mocks.reveal.mockReset().mockReturnValue(true); mocks.seekLocal.mockReset()
  useAgentActivity.setState({ snapshot: null, ready: false, mode: 'editor', seenSession: null, expanded: {}, filter: 'all', anchor: null, following: true, tab: 'activity' })
 
useReviewFocus.setState({ focus: null, hover: null })
})
afterEach(() => { cleanup(); resetReviewForTests() })

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

  it('shows a cancelled call as Cancelled, never as a failure', () => {
    seed([activity({ state: 'cancelled', error: null })])
    const { container } = render(<AgentPanel />)
    expect(screen.getByText('Cancelled')).toBeTruthy()
    expect(screen.queryByText('Failed')).toBeNull()
    expect(container.querySelector('.agent-activity.state-cancelled')).toBeTruthy()
    expect(container.querySelector('.agent-activity-error')).toBeNull()
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
    // One status row: the session's reason stands in for the running count.
    const row = document.querySelector<HTMLElement>('.agent-status-row')!
    const live = within(row).getByRole('status')
    expect(live.textContent).toBe('Cut interview')
    expect(live.title).toBe('Client · Cut interview')
    expect(within(row).getByRole('button', { name: 'MCP status unavailable' })).toBeTruthy()
    expect(document.querySelectorAll('.agent-session-header, .agent-connection-header')).toHaveLength(0)
    fireEvent.click(within(row).getByRole('button', { name: 'End work session' }))
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('agent_session_end'))
    act(() => useAgentActivity.getState().receive({ ...useAgentActivity.getState().snapshot!, revision: 2, session: null, sessions: [{ ...session, ended_at: 'now', end_reason: 'user' }] }))
    expect(useAgentActivity.getState().mode).toBe('agent')
    expect(within(row).getByRole('status').textContent).toBe('No operations running')
    expect(within(row).queryByRole('button', { name: 'End work session' })).toBeNull()
  })

  it('outside a work session the status row says what is running', () => {
    seed([activity({ state: 'running', ended_at: null, duration_ms: null }), activity({ id: 'b', state: 'running', ended_at: null, duration_ms: null })])
    render(<AgentPanel />)
    const live = within(document.querySelector<HTMLElement>('.agent-status-row')!).getByRole('status')
    expect(live.textContent).toBe('2 operations running')
    expect(live.title).toBe('')
  })

  it('keeps the lock on one line: reason, its title, Unlock', () => {
    seed([], { lock_reason: 'Rough cut batch' })
    render(<AgentPanel />)
    const lock = document.querySelector<HTMLElement>('.agent-history-lock')!
    expect(within(lock).getByText('Rough cut batch').title).toBe('Rough cut batch')
    expect(within(lock).getByRole('button', { name: 'Unlock undo' })).toBeTruthy()
  })

  it('a running clip-compute row shows its job: waiting with an hourglass, the live phase, Cancel, and a disconnected caller', async () => {
    const { receiveComputeJobs } = await import('../compute/computeJobsStore')
    const since = new Date(Date.now() - 5000).toISOString()
    seed([activity({ tool: 'describe_clip', state: 'running', ended_at: null, duration_ms: null, caller_disconnected: true,
      compute: { job_id: 'job-9', phase: { kind: 'queued', reason: 'memory' }, phase_since: since } })])
    render(<AgentPanel />)
    const row = document.querySelector<HTMLElement>('.agent-activity')!
    expect(row.classList.contains('is-waiting')).toBe(true)
    expect(row.querySelector('.agent-spin')).toBeNull()
    expect(within(row).getByText('Waiting for memory to free up')).toBeTruthy()
    expect(within(row).getByText('Caller disconnected — still running')).toBeTruthy()
    expect(row.querySelector('.agent-activity-status')).toBeNull()
    // The mirror's live job is fresher than the row's copy.
    act(() => receiveComputeJobs({ revision: 1_000_000, jobs: [{ job_id: 'job-9', tool: 'describe_clip', layer_id: 'gone', media_id: 'm',
      window: { t_start_us: 0, t_end_us: 1 }, phase: { kind: 'extracting', done: 4, total: 10 }, phase_since: new Date().toISOString(),
      started_at: since, origin: { kind: 'agent', client: 'Test client' }, callers: 0, caller_disconnected: false, request_ids: [] }] }))
    expect(within(row).getByText('Sampling frames 4/10')).toBeTruthy()
    expect(row.classList.contains('is-waiting')).toBe(false)
    expect(row.querySelector('.agent-spin')).not.toBeNull()
    mocks.invoke.mockResolvedValue(true)
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel description' }))
    expect(mocks.invoke).toHaveBeenCalledWith('compute_job_cancel', { job_id: 'job-9' })
    act(() => receiveComputeJobs({ revision: 1_000_001, jobs: [] }))
  })

  it('an ended clip-compute row reads as any other', () => {
    seed([activity({ tool: 'transcribe_clip', compute: { job_id: 'job-1', phase: { kind: 'inferring' }, phase_since: '2026-09-10T00:00:00Z' } })])
    render(<AgentPanel />)
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(document.querySelector('.compute-job-status')).toBeNull()
  })

  it('a running non-compute row whose caller went away says so', () => {
    seed([activity({ state: 'running', ended_at: null, duration_ms: null, caller_disconnected: true })])
    render(<AgentPanel />)
    expect(screen.getByText('Caller disconnected — still running')).toBeTruthy()
  })

  it('closes the activity list with the retention note, inside the list', () => {
    seed([activity()])
    render(<AgentPanel />)
    const list = document.querySelector('.agent-activity-list')!
    expect(list.lastElementChild?.textContent).toBe('Recent activity from this project opening. Not restored after reopening.')
    expect(document.querySelector('.agent-activity-panel > footer')).toBeNull()
  })
})

describe('AgentPanel — per-activity highlight', () => {
  const edit = (patch: Partial<AgentActivity> = {}) => activity({ kind: 'operation', tool: 'add_video_layer', message: 'Add media clip', history_ids: ['op1'], effect: 'applied', ...patch })
  const reply = (available: boolean) => mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_activity_view'
    ? { available, reverted: false, decorations: [], changes: available ? [{ id: 'Layer:x', class: 'added', details: [], composition_id: 'root', ranges: [] }] : [] }
    : { available: true, url: '', connections: [] })

  it('selecting an operation row says the timeline shows its changes, with a way back', async () => {
    reply(true)
    seed([edit()])
    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Add media clip/ }))
    expect(await screen.findByText("Timeline shows this call's changes · 1")).toBeTruthy()
    expect(mocks.invoke).toHaveBeenCalledWith('review_activity_view', { history_ids: ['op1'] })
    fireEvent.click(screen.getByRole('button', { name: 'Back to unreviewed changes' }))
    expect(screen.queryByText(/Timeline shows this call's changes/)).toBeNull()
    // The expanded row offers it again.
    fireEvent.click(screen.getByRole('button', { name: 'Show its changes on the timeline' }))
    expect(await screen.findByText("Timeline shows this call's changes · 1")).toBeTruthy()
    // Another tab clears it.
    fireEvent.click(screen.getByRole('tab', { name: /Changes/ }))
    expect(useReview.getState().activity).toBeNull()
  })

  it('an op that left the history says the detail is no longer available and highlights nothing', async () => {
    reply(false)
    seed([edit()])
    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Add media clip/ }))
    expect(await screen.findByText('Change detail is no longer available: this call has left the undo history.')).toBeTruthy()
    expect(screen.queryByText(/Timeline shows this call's changes/)).toBeNull()
    expect(useReview.getState().activity?.status).toBe('unavailable')
  })

  it('a read row has no changes to show', () => {
    seed([activity()])
    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Analyze clip/ }))
    expect(screen.queryByRole('button', { name: 'Show its changes on the timeline' })).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalledWith('review_activity_view', expect.anything())
  })
})

function tack(patch: Partial<TackView> = {}): TackView {
  return { id: 't1', session_id: 'work', connection_id: 'c', client: 'Test client', activity_id: 'a', kind: 'issue', label: 'Long pause',
    body: 'Keep the breath?', status: 'open', range: { composition_id: 'root', t_us: 2_000_000, end_t_us: 3_000_000 },
    created_at: '', composition_id: 'root', t_us: 2_000_000, end_t_us: 3_000_000,
    outdated: false, follows: null, ...patch }
}
const work = { id: 'work', connection_id: 'c', client: 'Client', reason: 'Review pauses', started_at: '', ended_at: null, end_reason: null, checkpoint_id: 'cp' }
const calls = (channel: string) => mocks.invoke.mock.calls.filter(([c]) => c === channel).map(([, args]) => args)
const openTacks = () => fireEvent.click(screen.getByRole('tab', { name: /Tacks/ }))
const tackRow = (id: string) => document.querySelector<HTMLElement>(`[data-tack-id="${id}"]`)!

describe('AgentPanel Tacks tab', () => {
  it('is a second tab beside Activity, its open count on the badge, grouped by work session', () => {
    seed([], { sessions: [work], tacks: [tack(), tack({ id: 't2', session_id: null, label: 'Loose end', status: 'resolved' })] })
    render(<AgentPanel />)
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
    const tab = screen.getByRole('tab', { name: /Tacks/ })
    expect(tab.textContent).toBe('Tacks1')
    expect(tab.title).toBe('Notes the agent tacked on for your review')
    openTacks()
    // The badge holds the count and the tab's title the subtitle: neither repeats above a list.
    expect(screen.queryByText('Notes the agent tacked on for your review')).toBeNull()
    // Clearing is tidying up inside a group, not a tab-wide last step: no toolbar.
    expect(document.querySelector('.agent-tacks .agent-activity-toolbar')).toBeNull()
    expect(screen.getByText('Review pauses')).toBeTruthy()
    expect(screen.getByText('Long pause')).toBeTruthy()
    // A group with nothing open starts collapsed; its heading still says why.
    expect(screen.getByText('Outside a work session')).toBeTruthy()
    expect(screen.queryByText('Loose end')).toBeNull()
    expect(useAgentActivity.getState().tab).toBe('tacks')
  })

  it('shows the empty message with the retention note beneath it, and closes a list with it', () => {
    seed([], { sessions: [work], tacks: [] })
    const view = render(<AgentPanel />)
    openTacks()
    const empty = document.querySelector<HTMLElement>('.agent-tacks .agent-empty')!
    expect(within(empty).getByText('Tacks an agent leaves for your review will appear here.')).toBeTruthy()
    expect(within(empty).queryByText('Notes the agent tacked on for your review')).toBeNull()
    expect(within(empty).getByText('Tacks last for this project opening only. They are never saved or exported.')).toBeTruthy()
    expect(document.querySelector('.agent-tacks .agent-list-footnote')).toBeNull()
    expect(document.querySelector('.agent-tacks footer')).toBeNull()
    view.unmount()
    seed([], { revision: 2, sessions: [work], tacks: [tack()] })
    render(<AgentPanel />)
    expect(screen.queryByText('Notes the agent tacked on for your review')).toBeNull()
    expect(document.querySelector('.agent-tacks .agent-activity-list')!.lastElementChild?.classList.contains('agent-list-footnote')).toBe(true)
  })

  it('resolves and dismisses as decisions; a closed tack waits in its group\'s closed section to be reopened or cleared', async () => {
    seed([], { sessions: [work], tacks: [tack(), tack({ id: 't2', status: 'dismissed', label: 'Done' })] })
    render(<AgentPanel />)
    openTacks()
    const open = tackRow('t1')
    // An open row has actions, not toggles, and no status word.
    expect(open.querySelector('[aria-pressed]')).toBeNull()
    expect(open.querySelector('.agent-tack-status')).toBeNull()
    expect(within(open).queryByRole('button', { name: 'Reopen' })).toBeNull()
    // The group still has an open tack: its closed section starts collapsed.
    const toggle = screen.getByRole('button', { name: 'Closed 1' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-tack-id="t2"]')).toBeNull()
    fireEvent.click(within(open).getByRole('button', { name: 'Resolve' }))
    fireEvent.click(within(open).getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(toggle)
    const closed = tackRow('t2')
    expect(closed.querySelector('.agent-tack-status')!.textContent).toBe('Dismissed')
    expect(within(closed).queryByRole('button', { name: 'Resolve' })).toBeNull()
    fireEvent.click(within(closed).getByRole('button', { name: 'Reopen' }))
    await vi.waitFor(() => expect(calls('agent_tacks_set_status')).toEqual([
      { tack_ids: ['t1'], status: 'resolved' }, { tack_ids: ['t1'], status: 'dismissed' }, { tack_ids: ['t2'], status: 'open' }]))
    // The group resolves its open tacks at once, and clears only its closed ones.
    fireEvent.click(screen.getByRole('button', { name: 'Resolve all' }))
    await vi.waitFor(() => expect(calls('agent_tacks_set_status')).toContainEqual({ tack_ids: ['t1'], status: 'resolved' }))
    expect(calls('agent_tacks_set_status')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await vi.waitFor(() => expect(calls('agent_tacks_delete')).toEqual([{ tack_ids: ['t2'] }]))
  })

  it('a group with nothing open shows its closed tacks once expanded, without Resolve all', () => {
    seed([], { sessions: [work], tacks: [tack({ status: 'resolved' })] })
    useAgentActivity.setState({ expanded: { 'tacks-session-work': true } })
    render(<AgentPanel />)
    openTacks()
    expect(screen.getByRole('button', { name: 'Closed 1' }).getAttribute('aria-expanded')).toBe('true')
    expect(tackRow('t1').querySelector('.agent-tack-status')!.textContent).toBe('Resolved')
    expect(screen.queryByRole('button', { name: 'Resolve all' })).toBeNull()
  })

  it('converts into one recorded marker carrying label, note and anchor, then removes the tack', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'add_marker' ? 'marker-1' : channel === 'agent_tacks_delete' ? { deleted_tack_ids: ['t1'] } : { available: true, url: '', connections: [] })
    const anchored = tack({ follows: { layer_id: 'clip', src_us: 5_000_000, src_fraction: { num: 1, den: 3 }, t_us: 2_000_000 } })
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

  it('lists a tack whose composition is gone, refusing locate and convert with the reason', () => {
    seed([], { sessions: [work], tacks: [
      tack({ id: 's', label: 'Gone', composition_id: null, t_us: null, end_t_us: null, outdated: true }),
    ] })
    render(<AgentPanel editor />)
    openTacks()
    expect(screen.getByText('Its composition no longer exists')).toBeTruthy()
    const locate = screen.getByRole('button', { name: 'Locate on the timeline' })
    expect(locate.hasAttribute('disabled')).toBe(true)
    expect(locate.getAttribute('title')).toMatch(/so it cannot be located or converted/)
    fireEvent.click(screen.getByRole('button', { name: /Gone/ }))
    const convert = screen.getByRole('button', { name: 'Convert to marker' })
    expect(convert.hasAttribute('disabled')).toBe(true)
    expect(convert.getAttribute('title')).toMatch(/no longer exists/)
  })

  it('locates in the editor only: seek, and reveal the followed clip', () => {
    const anchored = tack({ follows: { layer_id: 'clip', src_us: 5_000_000, t_us: 2_000_000 } })
    const clip: LayerSummary = { id: 'clip', label: 'Clip', t_start_us: 0, t_end_us: 4_000_000, kind: 'Color', color_hint: '#448', enabled: true, locked: false,
      params: { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 1 } }, width: 1920, height: 1080 }, effects: [] }
    useProjectStore.getState().apply(summaryFixture({ root: { id: 'root', tracks: [{ id: 'v1', kind: 'Video', label: 'V1', enabled: true, locked: false,
      muted: false, solo: false, role: null, transient: false, layers: [clip] }] } }))
    seed([], { sessions: [work], tacks: [anchored] })
    const agentView = render(<AgentPanel />)
    openTacks()
    expect(screen.queryByRole('button', { name: 'Locate on the timeline' })).toBeNull()
    agentView.unmount()
    render(<AgentPanel editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Locate on the timeline' }))
    expect(mocks.reveal).toHaveBeenCalledWith('clip')
    expect(mocks.jump).toHaveBeenCalledWith(2_000_000)
    expect(useReviewFocus.getState().focus).toEqual({ kind: 'tack', id: 't1' })
  })

  it('jumps the preview in the agent view: its time only, no clip revealed', () => {
    useProjectStore.getState().apply(summaryFixture({ root: { id: 'root' } }))
    seed([], { sessions: [work], tacks: [tack(), tack({ id: 't2', label: 'Elsewhere', composition_id: 'grp' })] })
    render(<AgentPanel />)
    openTacks()
    const [here, elsewhere] = screen.getAllByRole('button', { name: 'Jump the preview here' })
    expect(elsewhere!.hasAttribute('disabled')).toBe(true)
    expect(elsewhere!.getAttribute('title')).toBe('Not on the timeline the preview shows — locate it in the editor')
    fireEvent.click(here!)
    expect(mocks.seekLocal).toHaveBeenCalledWith('root', 2_000_000)
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(useReviewFocus.getState().focus).toEqual({ kind: 'tack', id: 't1' })
  })

  it('selectTack opens the tab, its group, a closed tack\'s section and its row', () => {
    seed([], { sessions: [work], tacks: [tack({ id: 't0', label: 'Still open' }), tack({ status: 'dismissed' })] })
    render(<AgentPanel />)
    act(() => selectTack('t1'))
    expect(screen.getByRole('tab', { name: /Tacks/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Keep the breath?')).toBeTruthy()
    expect(document.querySelector('[data-tack-id="t1"]')?.getAttribute('data-selected')).toBe('true')
  })

  it('names tacks 批注 in Chinese and never shows Tack', async () => {
    await i18n.changeLanguage('zh-CN')
    seed([], { sessions: [work], tacks: [tack()] })
    const { container } = render(<AgentPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /批注/ }))
    expect(screen.getByRole('tab', { name: /批注/ }).title).toBe('代理留下、供你审阅的批注')
    expect(screen.getByText('批注只保留在本次打开的项目中，不会保存或导出。')).toBeTruthy()
    expect(container.textContent).not.toMatch(/tack/i)
  })
})

describe('AgentPanel Tacks tab — states and the review focus', () => {
  const S = 1_000_000
  const clip = (id: string, label: string): LayerSummary => ({
    id, label, t_start_us: 0, t_end_us: 4 * S, kind: 'Color', color_hint: '#448', enabled: true, locked: false,
    params: { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 1 } }, width: 1920, height: 1080 }, effects: [],
  })
  beforeEach(() => {
    useProjectStore.getState().apply(summaryFixture({ root: { duration_us: 10 * S, tracks: [{ id: 'v1', kind: 'Video', label: 'V1', enabled: true, locked: false,
      muted: false, solo: false, role: null, transient: false, layers: [clip('interview', 'Interview'), clip('broll', 'B-roll')] }] } }))
  })
  const placed = (patch: Partial<TackView> = {}) => tack({ composition_id: ROOT_ID, range: { composition_id: ROOT_ID, t_us: 2 * S, end_t_us: 3 * S }, ...patch })
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-tack-id="${id}"]`)!

  it('badges an open outdated tack, explaining why, and only while it is open', () => {
    seed([], { sessions: [work], tacks: [placed({ outdated: true }), placed({ id: 't2', label: 'Closed', outdated: true, status: 'resolved' })] })
    useAgentActivity.setState({ expanded: { 'tacks-session-work': true, 'tacks-closed-work': true } })
    render(<AgentPanel />)
    openTacks()
    const badge = row('t1').querySelector<HTMLElement>('.agent-tack-outdated')!
    expect(badge.textContent).toBe('Content changed')
    expect(badge.title).toMatch(/What plays in its range changed after the agent wrote it/)
    expect(row('t2').querySelector('.agent-tack-outdated')).toBeNull()
  })

  it('sorts a tack whose composition is gone to the foot of its group, and lists an outdated one in place', () => {
    seed([], { sessions: [work], tacks: [
      placed({ id: 'gone', label: 'Gone', composition_id: null, t_us: null, end_t_us: null, outdated: true }),
      placed({ id: 'outdated', label: 'Outdated', t_us: 5 * S, end_t_us: 6 * S, outdated: true }),
      placed({ id: 'here', label: 'Here' }),
    ] })
    render(<AgentPanel editor />)
    openTacks()
    const ids = [...document.querySelectorAll<HTMLElement>('[data-tack-id]')].map(r => r.dataset.tackId)
    expect(ids).toEqual(['here', 'outdated', 'gone'])
    expect(row('outdated').textContent).toContain('00:00:05:00 – 00:00:06:00')
    expect(row('outdated').querySelector<HTMLButtonElement>('[aria-label="Locate on the timeline"]')!.disabled).toBe(false)
    expect(row('gone').textContent).toContain('Its composition no longer exists')
    // Not locatable, but still closable.
    expect(row('gone').querySelector<HTMLButtonElement>('[aria-label="Locate on the timeline"]')!.disabled).toBe(true)
    fireEvent.click(row('gone').querySelector<HTMLButtonElement>('[aria-label="Resolve"]')!)
    expect(calls('agent_tacks_set_status')).toEqual([{ tack_ids: ['gone'], status: 'resolved' }])
  })

  it('a row click focuses its tack, a hover names it, Esc in the panel lets the focus go', () => {
    seed([], { sessions: [work], tacks: [placed()] })
    render(<AgentPanel />)
    openTacks()
    fireEvent.mouseEnter(row('t1'))
    expect(useReviewFocus.getState().hover).toEqual({ kind: 'tack', id: 't1' })
    fireEvent.mouseLeave(row('t1'))
    expect(useReviewFocus.getState().hover).toBeNull()
    const main = screen.getByRole('button', { name: /Long pause/ })
    fireEvent.click(main)
    expect(useReviewFocus.getState().focus).toEqual({ kind: 'tack', id: 't1' })
    expect(row('t1').dataset.selected).toBe('true')
    expect(main.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(main, { key: 'Escape' })
    expect(useReviewFocus.getState().focus).toBeNull()
    expect(row('t1').dataset.selected).toBeUndefined()
  })

  it('a tab that does not list tacks lets the tack focus go', () => {
    seed([], { sessions: [work], tacks: [placed()] })
    render(<AgentPanel />)
    act(() => selectTack('t1'))
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }))
    expect(useReviewFocus.getState().focus).toBeNull()
  })
})

describe('Tack terms', () => {
  it('names the tack states in Chinese with the agreed words', async () => {
    await i18n.changeLanguage('zh-CN')
    expect([i18n.t('tacks.outdated'), i18n.t('tacks.state_unplaced')])
      .toEqual(['内容已修改', '所在的合成已不存在'])
    await i18n.changeLanguage('en-US')
  })
})
