// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import i18n from '../i18n'
import type { Change, ChangedRange, ReviewView } from '../../shared/review'
import type { LayerSummary, TrackSummary } from '../ipc'
import type { AgentActivitySnapshot } from '../../shared/agent-activity'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), jump: vi.fn(), reveal: vi.fn(() => true), listeners: new Map<string, (e: { payload: unknown }) => void>() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/bridge/events', () => ({ listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name) } }) }))
vi.mock('../state/navigation', async (importActual) => ({
  ...await importActual<typeof import('../state/navigation')>(), jumpToTimeUs: mocks.jump, revealLayerWithoutSeek: mocks.reveal,
}))
vi.mock('../settings/AgentSection', () => ({ AgentSection: () => null }))
import { AgentPanel } from './AgentPanel'
import { useAgentActivity } from './activityStore'
import { resetReviewForTests, useReview } from './reviewStore'
import { useProjectStore } from '../state/projectStore'
import { ROOT_ID, compositionFixture, summaryFixture } from '../testing/summaryFixture'
import { selectChange, selectRange, useReviewFocus } from './reviewFocus'

const S = 1_000_000
const clip = (id: string, label: string, s: number, e: number): LayerSummary => ({
  id, label, t_start_us: s, t_end_us: e, kind: 'Color', color_hint: '#448', enabled: true, locked: false,
  params: { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 1 } }, width: 1920, height: 1080 }, effects: [],
})
const track = (id: string, layers: LayerSummary[]): TrackSummary => ({ id, kind: 'Video', label: 'V1', enabled: true, locked: false, muted: false, solo: false, role: null, transient: true, layers })
const change = (patch: Partial<Change> & Pick<Change, 'id'>): Change => ({
  class: 'added', details: [], composition_id: ROOT_ID, ranges: [], ...patch,
})
const range = (s: number, e: number, composition_id = ROOT_ID) => [{ composition_id, track_id: null, t_start_us: s, t_end_us: e }]

const unreviewed: Change[] = [
  change({ id: 'Layer:late', class: 'modified', ranges: range(8 * S, 9 * S),
    details: [{ type: 'time', field: 'end', from_us: 3_200_000, to_us: 2 * S }, { type: 'params', keys: ['opacity', 'x'] }] }),
  change({ id: 'Layer:early', ranges: range(1 * S, 2 * S) }),
  change({ id: 'Layer:inner', class: 'removed', composition_id: 'grp', ranges: range(0, S, 'grp') }),
  change({ id: 'Layer:a', class: 'modified', ranges: range(3 * S, 7 * S),
    details: [{ type: 'time', field: 'start', from_us: 5_400_000, to_us: 3 * S }] }),
]
const mine: Change[] = [change({ id: 'Layer:mine', class: 'modified', ranges: range(5 * S, 6 * S) })]
const view = (baseline: number, list = unreviewed, user = mine): ReviewView => ({
  version: { session: 1, revision: 1, baseline_revision: baseline }, content_revision: 1, has_baseline: true, unreviewed: list, user, user_count: user.length, decorations: [], ranges: [],
})
/** Main sends the user-only list only when asked. */
const served = (v: ReviewView, args?: { include_user?: boolean }): ReviewView => (args?.include_user ? v : { ...v, user: [] })
const calls = (channel: string) => mocks.invoke.mock.calls.filter(([c]) => c === channel).map(([, args]) => args)
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  resetReviewForTests()
  mocks.listeners.clear(); mocks.jump.mockReset(); mocks.reveal.mockReset().mockReturnValue(true)
  mocks.invoke.mockReset().mockImplementation(async (channel: string, args?: { include_user?: boolean }) =>
    channel === 'review_view' ? served(view(1), args)
      : channel === 'review_approve_all' || channel === 'review_revert_all' ? { applied: true, view: served(view(2, []), args) } : { available: true, url: '', connections: [] })
  useProjectStore.getState().apply(summaryFixture({
    root: { tracks: [track('t1', [clip('late', 'Late clip', 8 * S, 9 * S), clip('early', 'Early clip', S, 2 * S)])] },
    groups: [compositionFixture({ id: 'grp', label: 'Intro', tracks: [track('gt', [])] })],
  }))
  useAgentActivity.setState({ snapshot: null, ready: true, tab: 'changes', expanded: {} })
 
useReviewFocus.setState({ focus: null, hover: null })
})
afterEach(() => { cleanup(); resetReviewForTests() })

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-change-id]')]
/** The switch in the note under the list that lists the user's own changes. */
const userSwitch = () => document.querySelector<HTMLButtonElement>('.agent-changes-user-note button')!
/** The toolbar's text past its diff stat: the notes and the actions. */
const toolbarControls = () => [...document.querySelector('.agent-changes .agent-activity-toolbar')!.children]
  .filter(e => !e.classList.contains('agent-changes-stats')).map(e => e.textContent).join('')

describe('AgentPanel Changes tab', () => {
  it('is the third tab with an unreviewed badge; groups by composition, root first, in timeline order', async () => {
    render(<AgentPanel editor />)
    await flush()
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Activity', 'Tacks', 'Changes4'])
    // The badge is the count; the toolbar opens with its diff stat, then what acts. The
    // subtitle (the tab's title) does not repeat over the list.
    expect(document.querySelector('.agent-changes .agent-activity-toolbar')!.firstElementChild!.classList.contains('agent-changes-stats')).toBe(true)
    expect(toolbarControls()).toBe('Revert allApprove all')
    // The user's own changes are a note after the list, before its footnote: they need no review.
    const note = document.querySelector<HTMLElement>('.agent-changes-user-note')!
    expect(note.textContent).toBe('Plus 1 user change · Show')
    expect(note.nextElementSibling!.classList.contains('agent-list-footnote')).toBe(true)
    expect(screen.queryByText('What agents changed since you last approved')).toBeNull()
    expect(screen.getByRole('tab', { name: /Changes/ }).title).toBe('What agents changed since you last approved')
    const groups = [...document.querySelectorAll('.agent-change-group-heading > span')].map(e => e.textContent)
    expect(groups).toEqual(['Main timeline', 'Intro'])
    expect(rows().map(r => r.dataset.changeId)).toEqual(['Layer:early', 'Layer:a', 'Layer:late', 'Layer:inner'])
    const [early, shift, late, inner] = rows()
    expect(within(early!).getByText('Added')).toBeTruthy()
    expect(within(early!).getByText('Early clip')).toBeTruthy()
    expect(within(shift!).getByText('Clip')).toBeTruthy()
    expect(shift!.textContent).toContain('Start 5.4 → 3.0 s')
    expect(late!.textContent).toContain('End 3.2 → 2.0 s · Opacity, Position X')
    // A removed clip has no current name: its kind stands in.
    expect(within(inner!).getByText('Removed')).toBeTruthy()
    expect(within(inner!).getAllByText(/^Clip/).length).toBeGreaterThan(0)
  })

  it('settles the list as a whole: rows carry no approve; approve-all empties the tab in one update', async () => {
    render(<AgentPanel editor />)
    await flush()
    expect(rows().every(r => within(r).queryByRole('button', { name: /Approve/ }) === null)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await flush()
    expect(calls('review_approve_all')).toEqual([{ version: { session: 1, revision: 1, baseline_revision: 1 }, include_user: false }])
    expect(rows()).toHaveLength(0)
    expect(useReview.getState().highlight.layers.size).toBe(0)
    const empty = document.querySelector<HTMLElement>('.agent-changes .agent-empty')!
    expect(within(empty).getByText('Nothing to review.')).toBeTruthy()
    // Empty, the list is one block: the message, then the retention note — no footnote below it.
    expect(within(empty).getByText('Approving records nothing in history; reverting is one step you can undo. To drop a single change, undo it or edit it back.')).toBeTruthy()
    expect(within(empty).queryByText('What agents changed since you last approved')).toBeNull()
    expect(document.querySelector('.agent-changes .agent-list-footnote')).toBeNull()
    // Nothing awaits review: the toolbar leaves; the user's note stays under the message while they have changes.
    expect(document.querySelector('.agent-changes .agent-activity-toolbar')).toBeNull()
    expect(within(empty).getByText('Plus 1 user change')).toBeTruthy()
    act(() => { useReview.getState().apply(view(5, [], [])) })
    expect(document.querySelector('.agent-changes-user-note')).toBeNull()
  })

  it('revert all names the held view and empties the tab; it waits while history is locked', async () => {
    render(<AgentPanel editor />)
    await flush()
    const revert = screen.getByRole('button', { name: 'Revert all' })
    expect(revert.title).toBe('Restore the project to the review baseline, your own changes since included. Undo brings it all back.')
    act(() => useAgentActivity.setState({ snapshot: {
      workspace_id: 'w', revision: 1, session: null, sessions: [], activities: [], evicted: 0, lock_reason: 'agent at work', checkpoints: [], tacks: [],
    } as AgentActivitySnapshot }))
    expect(revert).toHaveProperty('disabled', true)
    expect(revert.title).toBe('History is locked — unlock it to revert')
    act(() => useAgentActivity.setState({ snapshot: { ...useAgentActivity.getState().snapshot!, lock_reason: null } }))
    expect(revert).toHaveProperty('disabled', false)
    fireEvent.click(revert)
    await flush()
    expect(calls('review_revert_all')).toEqual([{ version: { session: 1, revision: 1, baseline_revision: 1 }, include_user: false }])
    expect(rows()).toHaveLength(0)
  })

  it('the user-changes note lists user-only changes, marked as the user\'s', async () => {
    render(<AgentPanel editor />)
    await flush()
    expect(userSwitch().getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[data-source="user"]')).toBeNull()
    fireEvent.click(userSwitch())
    await flush()
    expect(userSwitch().getAttribute('aria-pressed')).toBe('true')
    expect(userSwitch().textContent).toBe('Hide')
    expect(calls('review_view').at(-1)).toEqual({ include_user: true })
    const user = document.querySelector<HTMLElement>('[data-source="user"]')!
    expect(user.dataset.changeId).toBe('Layer:mine')
    expect(within(user).getByText('You')).toBeTruthy()
    // Interleaved by time within its composition; the unreviewed count is unchanged.
    expect(rows().map(r => r.dataset.changeId).slice(0, 4)).toEqual(['Layer:early', 'Layer:a', 'Layer:mine', 'Layer:late'])
    expect(screen.getByRole('tab', { name: /Changes/ }).textContent).toBe('Changes4')
  })

  it('heads the list with a diff stat of the unreviewed changes alone, gone once nothing awaits review', async () => {
    const stat = () => [...document.querySelectorAll<HTMLElement>('.agent-changes-stats .agent-changes-stat')]
      .map(s => [s.querySelector('[aria-hidden="true"]')!.textContent, s.title])
    render(<AgentPanel editor />)
    await flush()
    const expected = [['+1', '1 added'], ['−1', '1 removed'], ['~2', '2 modified']]
    expect(stat()).toEqual(expected)
    // The user's own change is listed under the filter but needs no review, so it is not counted.
    fireEvent.click(userSwitch())
    await flush()
    expect(document.querySelector('[data-source="user"]')).not.toBeNull()
    expect(stat()).toEqual(expected)
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await flush()
    expect(document.querySelector('.agent-changes-stats')).toBeNull()
  })

  it('the user-changes switch turns itself off once an undo takes the user\'s changes back', async () => {
    render(<AgentPanel editor />)
    await flush()
    fireEvent.click(userSwitch())
    await flush()
    expect(useReview.getState().showUser).toBe(true)
    act(() => { useReview.getState().apply(view(5, unreviewed, []), true) })
    expect(useReview.getState().showUser).toBe(false)
    expect(document.querySelector('.agent-changes-user-note')).toBeNull()
    expect(document.querySelector('[data-source="user"]')).toBeNull()
    // Revert all and Approve all still have their row, alone.
    expect(toolbarControls()).toBe('Revert allApprove all')
  })

  it('an approval made after the list changed approves nothing and says so in the toolbar', async () => {
    render(<AgentPanel editor />)
    await flush()
    const fresh = { ...view(1, [...unreviewed, change({ id: 'Layer:new', ranges: range(0, S) })], []), version: { session: 1, revision: 2, baseline_revision: 1 } }
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve_all' ? { applied: false, view: fresh } : fresh)
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await flush()
    expect(rows()).toHaveLength(5)
    const note = screen.getByText('Nothing approved: the list changed')
    expect(note.getAttribute('role')).toBe('status')
    expect(note.title).toBe('The changes were updated — review again. Nothing was approved.')
    expect(note.parentElement!.classList.contains('agent-activity-toolbar')).toBe(true)
    expect(note.nextElementSibling?.textContent).toBe('Revert allApprove all')
    // An approval that applies clears it.
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve_all' ? { applied: true, view: view(4, []) } : fresh)
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await flush()
    expect(screen.queryByText('Nothing approved: the list changed')).toBeNull()
  })

  it('locates in the editor only: reveals the clip and seeks to its footprint', async () => {
    const first = render(<AgentPanel />)
    await flush()
    expect(screen.queryByRole('button', { name: 'Locate on the timeline' })).toBeNull()
    first.unmount()
    render(<AgentPanel editor />)
    await flush()
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Locate on the timeline' }))
    expect(mocks.reveal).toHaveBeenCalledWith('early')
    expect(mocks.jump).toHaveBeenCalledWith(S)
  })

  it('labels and locates a removed entity at its baseline position without claiming a current range', async () => {
    const removed = change({ id: 'Layer:gone', class: 'removed', ranges: [],
      before_ranges: [{ composition_id: ROOT_ID, track_id: 'v1', t_start_us: 4 * S, t_end_us: 5 * S }] })
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_view' ? view(1, [removed], []) : { available: true, url: '', connections: [] })
    render(<AgentPanel editor />)
    await flush()
    const line = rows()[0]!.querySelector<HTMLElement>('.agent-change-copy > small')!
    expect(line.textContent).toContain('Baseline position 4.0 – 5.0 s')
    expect(line.title).toBe('00:00:04:00 – 00:00:05:00')
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Locate on the timeline' }))
    expect(mocks.jump).toHaveBeenCalledWith(4 * S)
    expect(mocks.reveal).not.toHaveBeenCalled()
  })

  it('names a removed entity by its baseline name, says a track is one, and gives no second notation for both edges', async () => {
    const list = [
      change({ id: 'Layer:gone', class: 'removed', ranges: [], before_name: 'Interview take 3',
        before_ranges: [{ composition_id: ROOT_ID, track_id: 't1', t_start_us: 4 * S, t_end_us: 5 * S }] }),
      change({ id: 'Layer:nameless', class: 'removed', ranges: [] }),
      change({ id: 'Track:gt', composition_id: 'grp' }),
      change({ id: 'Layer:early', class: 'modified', ranges: range(S, 2 * S),
        details: [{ type: 'time', field: 'start', from_us: 3 * S, to_us: S }, { type: 'time', field: 'end', from_us: 4 * S, to_us: 2 * S }] }),
      change({ id: 'Layer:trimmed', class: 'modified', ranges: range(2.5 * S, 4 * S),
        details: [{ type: 'time', field: 'start', from_us: 2 * S, to_us: 2.5 * S }, { type: 'trim', side: 'start', delta_us: -0.5 * S }] }),
    ]
    // Both edited clips play differently: their lines carry no weight note.
    const plays: ChangedRange = { composition_id: ROOT_ID, class: 'modified', t_start_us: S, t_end_us: 4 * S, before_start_us: 2 * S, before_end_us: 4 * S,
      source: 'review', change_ids: ['Layer:early', 'Layer:trimmed'] }
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_view' ? { ...view(1, list, []), ranges: [plays] } : { available: true, url: '', connections: [] })
    render(<AgentPanel editor />)
    await flush()
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-change-id="${id}"]`)!
    const title = (id: string) => row(id).querySelector('.agent-change-copy > span')!.textContent
    expect(title('Layer:gone')).toBe('Interview take 3')
    expect(title('Layer:nameless')).toBe('Clip')
    expect(title('Track:gt')).toBe('Track “V1”')
    expect(row('Layer:early').querySelector('.agent-change-copy > small')!.textContent).toBe('Start 3.0 → 1.0 s · End 4.0 → 2.0 s')
    // One edge told: the place in the same seconds, the timecode only as the tooltip.
    const trimmed = row('Layer:trimmed').querySelector<HTMLElement>('.agent-change-copy > small')!
    expect(trimmed.textContent).toBe('Cut 0.5 s from the start · Now 2.5 – 4.0 s')
    expect(trimmed.title).toBe('00:00:02:15 – 00:00:04:00')
  })

  it('a row click focuses its change without seeking; a second click lets it go; hover names it', async () => {
    render(<AgentPanel editor />)
    await flush()
    const early = rows()[0]!
    fireEvent.mouseEnter(early)
    expect(useReviewFocus.getState().hover).toEqual({ kind: 'change', source: 'review', id: 'Layer:early' })
    fireEvent.mouseLeave(early)
    expect(useReviewFocus.getState().hover).toBeNull()
    const main = within(early).getByRole('button', { name: /Early clip/ })
    fireEvent.click(main)
    expect(useReviewFocus.getState().focus).toEqual({ kind: 'change', source: 'review', id: 'Layer:early' })
    expect([early.dataset.selected, main.getAttribute('aria-pressed')]).toEqual(['true', 'true'])
    expect(mocks.jump).not.toHaveBeenCalled()
    expect(mocks.reveal).not.toHaveBeenCalled()
    fireEvent.click(main)
    expect(useReviewFocus.getState().focus).toBeNull()
  })

  it('an approved change takes the focus and the hover with it; one still listed keeps them', async () => {
    render(<AgentPanel editor />)
    await flush()
    act(() => useReviewFocus.setState({ focus: { kind: 'change', source: 'review', id: 'Layer:early' }, hover: { kind: 'change', source: 'review', id: 'Layer:late' } }))
    act(() => { useReview.getState().apply(view(2, unreviewed.filter(c => c.id !== 'Layer:late'))) })
    expect(useReviewFocus.getState()).toMatchObject({ focus: { kind: 'change', source: 'review', id: 'Layer:early' }, hover: null })
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve_all' ? { applied: true, view: view(3, []) } : view(2))
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await flush()
    expect(useReviewFocus.getState().focus).toBeNull()
  })

  it('a user change stays focusable only while the user-changes switch lists it', async () => {
    useReview.setState({ showUser: true })
    render(<AgentPanel editor />)
    await flush()
    act(() => selectChange('Layer:mine'))
    act(() => { useReview.getState().apply(view(2), true) })
    expect(useReviewFocus.getState().focus).toEqual({ kind: 'change', source: 'review', id: 'Layer:mine' })
    fireEvent.click(userSwitch())
    expect(useReviewFocus.getState().focus).toBeNull()
  })

  it('lists each changed entity independently', async () => {
    const moved = change({ id: 'Layer:next', class: 'modified',       details: [{ type: 'time', field: 'start', from_us: 4 * S, to_us: 3 * S }], ranges: range(3 * S, 4 * S) })
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_view' ? view(1, [...unreviewed, moved], []) : { available: true, url: '', connections: [] })
    render(<AgentPanel editor />)
    await flush()
    expect(rows().map(r => r.dataset.changeId)).toContain('Layer:next')
    expect(rows().find(r => r.dataset.changeId === 'Layer:next')!.textContent).toContain('Start 4.0 → 3.0 s')
  })


  it('a row the film shows less loudly says so after its line, in the entity diff\'s order', async () => {
    const changed = (ids: string[], only?: 'sync'): ChangedRange => ({ composition_id: ROOT_ID, class: 'modified', t_start_us: 0, t_end_us: 9 * S,
      before_start_us: 0, before_end_us: 9 * S, source: 'review', change_ids: ids as ChangedRange['change_ids'], ...(only ? { only, sync_offset_us: 2 * S } : {}) })
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_view'
      ? { ...view(1, unreviewed, []), ranges: [changed(['Layer:early', 'Layer:inner']), changed(['Layer:late'], 'sync')] }
      : { available: true, url: '', connections: [] })
    render(<AgentPanel editor />)
    await flush()
    expect(rows().map(r => r.dataset.changeId)).toEqual(['Layer:early', 'Layer:a', 'Layer:late', 'Layer:inner'])
    const notes = Object.fromEntries(rows().map(r => [r.dataset.changeId, [r.dataset.reviewWeight, r.querySelector('.agent-change-weight')?.textContent ?? null]]))
    expect(notes).toEqual({
      'Layer:early': ['full', null], 'Layer:inner': ['full', null],
      'Layer:a': ['quiet', ' · plays the same'], 'Layer:late': ['soft', ' · out of sync only'],
    })
  })

  it('an agent row names the work session that last edited it; a user row does not', async () => {
    useReview.setState({ showUser: true })
    const op = (id: string, session_id: string, started_at: string, ids: string[]) => ({
      id, session_id, kind: 'operation', started_at, affected: ids.map(x => ({ kind: 'Layer', id: x })),
    })
    useAgentActivity.setState({ snapshot: {
      workspace_id: 'w', revision: 1, session: null, evicted: 0, lock_reason: null, checkpoints: [], tacks: [],
      sessions: [{ id: 's1', reason: 'Tighten the intro' }, { id: 's2', reason: 'Fix the outro' }],
      activities: [op('a1', 's1', '2026-10-14T10:00:00Z', ['early', 'mine']), op('a2', 's2', '2026-10-14T11:00:00Z', ['late'])],
    } as unknown as AgentActivitySnapshot })
    render(<AgentPanel editor />)
    await flush()
    const from = (id: string) => rows().find(r => r.dataset.changeId === id)!.querySelector('.agent-change-from')?.textContent ?? null
    expect(from('Layer:early')).toBe('From: Tighten the intro')
    expect(from('Layer:late')).toBe('From: Fix the outro')
    expect(from('Layer:inner')).toBeNull()
    expect(from('Layer:mine')).toBeNull()
  })

  it('a change focused elsewhere (a ghost, the mini timeline) opens the tab and scrolls its row into view', async () => {
    useAgentActivity.setState({ tab: 'activity' })
    const scrolled: string[] = []
    // jsdom lays nothing out and has no scrollIntoView; record who asked.
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.changeId ?? '') }
    try {
      render(<AgentPanel editor />)
      await flush()
      act(() => selectChange('Layer:late'))
      await flush()
      expect(screen.getByRole('tab', { name: /Changes/ }).getAttribute('aria-selected')).toBe('true')
      expect(scrolled).toContain('Layer:late')
    } finally { delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView }
  })

  it('a focused range frames its rows under a bar that steps through them; Esc steps back, then lets go', async () => {
    const pair: ChangedRange = { composition_id: ROOT_ID, class: 'modified', t_start_us: S, t_end_us: 9 * S, before_start_us: S, before_end_us: 9 * S,
      source: 'review', change_ids: ['Layer:late', 'Layer:early'] }
    mocks.invoke.mockImplementation(async (channel: string, args?: { include_user?: boolean }) =>
      channel === 'review_view' ? served({ ...view(1), ranges: [pair] }, args) : { available: true, url: '', connections: [] })
    const scrolled: string[] = []
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.changeId ?? '') }
    try {
      render(<AgentPanel editor />)
      await flush()
      act(() => selectRange(pair))
      const framed = () => rows().filter(r => r.dataset.inRange).map(r => r.dataset.changeId)
      expect(framed()).toEqual(['Layer:early', 'Layer:late'])
      expect(scrolled.at(-1)).toBe('Layer:early')
      const bar = screen.getByRole('group', { name: 'Changed range' })
      expect(bar.textContent).toContain('All 2')
      // Steps follow the rows, top to bottom.
      fireEvent.click(within(bar).getByRole('button', { name: 'Next change in this range' }))
      expect(useReviewFocus.getState().focus).toMatchObject({ kind: 'range', step: 'Layer:early' })
      expect(bar.textContent).toContain('1 / 2')
      expect(rows().find(r => r.dataset.changeId === 'Layer:early')!.dataset.selected).toBe('true')
      // A framed row's click steps to it, keeping the range.
      fireEvent.click(within(rows().find(r => r.dataset.changeId === 'Layer:late')!).getByRole('button', { name: /Late clip/ }))
      expect(useReviewFocus.getState().focus).toMatchObject({ kind: 'range', step: 'Layer:late' })
      fireEvent.keyDown(within(bar).getByRole('button', { name: 'Next change in this range' }), { key: 'Escape' })
      expect(useReviewFocus.getState().focus).toMatchObject({ kind: 'range', step: null })
      fireEvent.keyDown(within(bar).getByRole('button', { name: 'Next change in this range' }), { key: 'Escape' })
      expect(useReviewFocus.getState().focus).toBeNull()
      expect(screen.queryByRole('group', { name: 'Changed range' })).toBeNull()
      expect(framed()).toEqual([])
    } finally { delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView }
  })
})
