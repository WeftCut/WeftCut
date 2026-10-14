// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import i18n from '../i18n'
import type { Change, ReviewView } from '../../shared/review'
import type { LayerSummary, TrackSummary } from '../ipc'
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

const S = 1_000_000
const clip = (id: string, label: string, s: number, e: number): LayerSummary => ({
  id, label, t_start_us: s, t_end_us: e, kind: 'Color', color_hint: '#448', enabled: true, locked: false,
  params: { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 1 } }, width: 1920, height: 1080 }, effects: [],
})
const track = (id: string, layers: LayerSummary[]): TrackSummary => ({ id, kind: 'Video', label: 'V1', enabled: true, locked: false, muted: false, solo: false, role: null, transient: true, layers })
const change = (patch: Partial<Change> & { id: string }): Change => ({
  class: 'added', kind: 'Layer', keys: [patch.id as Change['keys'][number]], aspects: [], composition_id: ROOT_ID, composition_ids: [ROOT_ID], ranges: [], ...patch,
})
const range = (s: number, e: number, composition_id = ROOT_ID) => [{ composition_id, t_start_us: s, t_end_us: e }]

const unreviewed: Change[] = [
  change({ id: 'Layer:late', class: 'modified', aspects: ['timing', 'params'], ranges: range(8 * S, 9 * S) }),
  change({ id: 'Layer:early', ranges: range(1 * S, 2 * S) }),
  change({ id: 'Layer:inner', class: 'removed', composition_id: 'grp', composition_ids: ['grp'], from: { composition_id: 'grp', track_id: 'gt' }, ranges: range(0, S, 'grp') }),
  change({ id: 'Shift:comp-root:-2400000', class: 'modified', aspects: ['timing'], keys: ['Layer:a', 'Layer:b', 'Layer:c'], delta_us: -2_400_000, ranges: range(3 * S, 7 * S) }),
]
const mine: Change[] = [change({ id: 'Layer:mine', class: 'modified', aspects: ['label'], ranges: range(5 * S, 6 * S) })]
const view = (baseline: number, list = unreviewed, user = mine): ReviewView => ({
  version: { session: 1, revision: 1, baseline_revision: baseline }, has_baseline: true, unreviewed: list, user, user_count: user.length, decorations: [],
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
      : channel.startsWith('review_approve') ? { applied: true, view: served(view(2, []), args) } : { available: true, url: '', connections: [] })
  useProjectStore.getState().apply(summaryFixture({
    root: { tracks: [track('t1', [clip('late', 'Late clip', 8 * S, 9 * S), clip('early', 'Early clip', S, 2 * S)])] },
    groups: [compositionFixture({ id: 'grp', label: 'Intro', tracks: [track('gt', [])] })],
  }))
  useAgentActivity.setState({ snapshot: null, ready: true, tab: 'changes', expanded: {}, reviewFocus: null, reviewHover: null })
})
afterEach(() => { cleanup(); resetReviewForTests() })

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-change-id]')]

describe('AgentPanel Changes tab', () => {
  it('is the third tab with an unreviewed badge; groups by composition, root first, in timeline order', async () => {
    render(<AgentPanel editor />)
    await flush()
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Activity', 'Tacks', 'Changes4'])
    expect(screen.getByText('4 unreviewed')).toBeTruthy()
    const groups = [...document.querySelectorAll('.agent-change-group-heading > span')].map(e => e.textContent)
    expect(groups).toEqual(['Main timeline', 'Intro'])
    expect(rows().map(r => r.dataset.changeId)).toEqual(['Layer:early', 'Shift:comp-root:-2400000', 'Layer:late', 'Layer:inner'])
    const [early, shift, late, inner] = rows()
    expect(within(early!).getByText('Added')).toBeTruthy()
    expect(within(early!).getByText('Early clip')).toBeTruthy()
    expect(within(shift!).getByText('3 clips')).toBeTruthy()
    expect(shift!.textContent).toContain('Moved −2.4 s')
    expect(late!.textContent).toContain('Timing · Properties')
    // A removed clip has no current name: its kind stands in.
    expect(within(inner!).getByText('Removed')).toBeTruthy()
    expect(within(inner!).getAllByText(/^Clip/).length).toBeGreaterThan(0)
  })

  it('approves one change by id, and approve-all empties the tab in one update', async () => {
    render(<AgentPanel editor />)
    await flush()
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Approve' }))
    await flush()
    expect(calls('review_approve')).toEqual([{ version: { session: 1, revision: 1, baseline_revision: 1 }, include_user: false, change_ids: ['Layer:early'] }])
    // That reply was the empty view; reseed and approve all.
    act(() => { useReview.getState().apply(view(3)) })
    expect(rows()).toHaveLength(4)
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve_all' ? { applied: true, view: view(4, []) } : view(1))
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await flush()
    expect(calls('review_approve_all')).toEqual([{ version: { session: 1, revision: 1, baseline_revision: 3 }, include_user: false }])
    expect(rows()).toHaveLength(0)
    expect(useReview.getState().highlight.layers.size).toBe(0)
    expect(screen.getByText('Nothing to review. Every agent change is approved.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Approve all' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('"show my changes" lists user-only changes, marked and without approve', async () => {
    render(<AgentPanel editor />)
    await flush()
    const filter = screen.getByRole('button', { name: 'Show my changes (1)' })
    expect(filter.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[data-source="user"]')).toBeNull()
    fireEvent.click(filter)
    await flush()
    expect(calls('review_view').at(-1)).toEqual({ include_user: true })
    const user = document.querySelector<HTMLElement>('[data-source="user"]')!
    expect(user.dataset.changeId).toBe('Layer:mine')
    expect(within(user).getByText('You')).toBeTruthy()
    expect(within(user).queryByRole('button', { name: 'Approve' })).toBeNull()
    // Interleaved by time within its composition; the unreviewed count is unchanged.
    expect(rows().map(r => r.dataset.changeId).slice(0, 4)).toEqual(['Layer:early', 'Shift:comp-root:-2400000', 'Layer:mine', 'Layer:late'])
    expect(screen.getByText('4 unreviewed')).toBeTruthy()
  })

  it('an approval made after the list changed approves nothing and says so above the fresh list', async () => {
    render(<AgentPanel editor />)
    await flush()
    const fresh = { ...view(1, [...unreviewed, change({ id: 'Layer:new', ranges: range(0, S) })], []), version: { session: 1, revision: 2, baseline_revision: 1 } }
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve_all' ? { applied: false, view: fresh } : fresh)
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    await flush()
    expect(rows()).toHaveLength(5)
    expect(screen.getByText('The changes were updated — review again. Nothing was approved.').getAttribute('role')).toBe('status')
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

  it('a row click focuses its change without seeking; a second click lets it go; hover names it', async () => {
    render(<AgentPanel editor />)
    await flush()
    const early = rows()[0]!
    fireEvent.mouseEnter(early)
    expect(useAgentActivity.getState().reviewHover).toEqual({ kind: 'change', id: 'Layer:early' })
    fireEvent.mouseLeave(early)
    expect(useAgentActivity.getState().reviewHover).toBeNull()
    const main = within(early).getByRole('button', { name: /Early clip/ })
    fireEvent.click(main)
    expect(useAgentActivity.getState().reviewFocus).toEqual({ kind: 'change', id: 'Layer:early' })
    expect([early.dataset.selected, main.getAttribute('aria-pressed')]).toEqual(['true', 'true'])
    expect(mocks.jump).not.toHaveBeenCalled()
    expect(mocks.reveal).not.toHaveBeenCalled()
    fireEvent.click(main)
    expect(useAgentActivity.getState().reviewFocus).toBeNull()
  })

  it('an approved change takes the focus and the hover with it; one still listed keeps them', async () => {
    render(<AgentPanel editor />)
    await flush()
    act(() => useAgentActivity.setState({ reviewFocus: { kind: 'change', id: 'Layer:early' }, reviewHover: { kind: 'change', id: 'Layer:late' } }))
    act(() => { useReview.getState().apply(view(2, unreviewed.filter(c => c.id !== 'Layer:late'))) })
    expect(useAgentActivity.getState()).toMatchObject({ reviewFocus: { kind: 'change', id: 'Layer:early' }, reviewHover: null })
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve' ? { applied: true, view: view(3, []) } : view(2))
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Approve' }))
    await flush()
    expect(useAgentActivity.getState().reviewFocus).toBeNull()
  })

  it('a user change stays focusable only while "show my changes" lists it', async () => {
    useReview.setState({ showUser: true })
    render(<AgentPanel editor />)
    await flush()
    act(() => useAgentActivity.getState().selectChange('Layer:mine'))
    act(() => { useReview.getState().apply(view(2), true) })
    expect(useAgentActivity.getState().reviewFocus).toEqual({ kind: 'change', id: 'Layer:mine' })
    fireEvent.click(screen.getByRole('button', { name: 'Show my changes (1)' }))
    expect(useAgentActivity.getState().reviewFocus).toBeNull()
  })

  it('a change focused elsewhere (a ghost, the mini timeline) opens the tab and scrolls its row into view', async () => {
    useAgentActivity.setState({ tab: 'activity' })
    const scrolled: string[] = []
    // jsdom lays nothing out and has no scrollIntoView; record who asked.
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.changeId ?? '') }
    try {
      render(<AgentPanel editor />)
      await flush()
      act(() => useAgentActivity.getState().selectChange('Layer:late'))
      await flush()
      expect(screen.getByRole('tab', { name: /Changes/ }).getAttribute('aria-selected')).toBe('true')
      expect(scrolled).toContain('Layer:late')
    } finally { delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView }
  })
})
