// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change, ReviewView } from '../../shared/review'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (e: { payload: unknown }) => void>() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/bridge/events', () => ({ listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name) } }) }))
import { act, renderHook } from '@testing-library/react'
import { acquireReview, approveAllChanges, clearActivityChanges, isNewerReviewView, refreshReview, resetReviewForTests, revertAllChanges, selectHighlight, setShowUser, showActivityChanges, useCompositionChangeRanges, useLayerReviewMark, useReview } from './reviewStore'
import { useAgentActivity } from './activityStore'
import type { AgentActivity, AgentActivitySnapshot } from '../../shared/agent-activity'
import { buildReviewHighlight } from './reviewHighlight'
import { useProjectStore } from '../state/projectStore'
import { summaryFixture } from '../testing/summaryFixture'

const change = (patch: Partial<Change> = {}): Change => ({
  id: 'Layer:a', class: 'added', details: [], composition_id: 'root',
  ranges: [{ composition_id: 'root', track_id: null, t_start_us: 0, t_end_us: 1_000_000 }], ...patch,
})
const view = (revision: number, baseline: number, unreviewed: Change[] = [change()], session = 1): ReviewView => ({
  version: { session, revision, baseline_revision: baseline }, content_revision: revision, has_baseline: true, unreviewed, user: [], user_count: 0, decorations: [],
})
const approved = (v: ReviewView, applied = true) => ({ applied, view: v })
/** Resolve microtasks and the listen() promise. */
const flush = () => new Promise(r => setTimeout(r, 0))
const reviewCalls = () => mocks.invoke.mock.calls.filter(([c]) => c === 'review_view').length

beforeEach(() => { resetReviewForTests(); mocks.invoke.mockReset(); mocks.listeners.clear() })
afterEach(() => resetReviewForTests())

describe('review view versions', () => {
  it('orders by session, then by publication and baseline revision together', () => {
    expect(isNewerReviewView({ session: 1, revision: 2, baseline_revision: 1 }, null)).toBe(true)
    expect(isNewerReviewView({ session: 1, revision: 3, baseline_revision: 1 }, { session: 1, revision: 2, baseline_revision: 1 })).toBe(true)
    expect(isNewerReviewView({ session: 1, revision: 2, baseline_revision: 2 }, { session: 1, revision: 2, baseline_revision: 1 })).toBe(true)
    // Same view again, or behind on either axis: computed before the held one.
    expect(isNewerReviewView({ session: 1, revision: 2, baseline_revision: 1 }, { session: 1, revision: 2, baseline_revision: 1 })).toBe(false)
    expect(isNewerReviewView({ session: 1, revision: 5, baseline_revision: 1 }, { session: 1, revision: 4, baseline_revision: 2 })).toBe(false)
    expect(isNewerReviewView({ session: 1, revision: 9, baseline_revision: 9 }, { session: 2, revision: 0, baseline_revision: 0 })).toBe(false)
    expect(isNewerReviewView({ session: 2, revision: 0, baseline_revision: 0 }, { session: 1, revision: 9, baseline_revision: 9 })).toBe(true)
  })

  const unchanged = (revision: number, content: number, user_count = 0) =>
    ({ unchanged: true, version: { session: 1, revision, baseline_revision: 1 }, content_revision: content, has_baseline: true, user_count })

  it('sends the lists it holds, and keeps them and their highlight when main answers they are unchanged', async () => {
    let reads = 0
    mocks.invoke.mockImplementation(async () => (++reads === 1 ? view(1, 1) : unchanged(2, 1, 3)))
    const release = acquireReview()
    await flush()
    const { highlight, view: held } = useReview.getState()
    await refreshReview()
    expect(mocks.invoke).toHaveBeenLastCalledWith('review_view', { include_user: false, held_content: 1 })
    expect(useReview.getState().view).toEqual({ ...held, version: { session: 1, revision: 2, baseline_revision: 1 }, user_count: 3 })
    expect(useReview.getState().highlight).toBe(highlight)
    release()
  })

  it('reads the lists again when the view it held was replaced while an unchanged answer was out', async () => {
    let answer!: (v: unknown) => void
    let reads = 0
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel !== 'review_view') return Promise.resolve(approved(view(3, 2, [])))
      reads += 1
      return reads === 1 ? Promise.resolve(view(1, 1)) : reads === 2 ? new Promise(r => { answer = r }) : Promise.resolve(view(4, 2, []))
    })
    const release = acquireReview()
    await flush()
    void refreshReview()
    expect(await approveAllChanges()).toBe(true)
    // Unchanged against the lists of content 1, which are no longer held.
    answer(unchanged(2, 1))
    await flush()
    expect(reads).toBe(3)
    expect(useReview.getState().view).toMatchObject({ version: { revision: 4 }, content_revision: 4, unreviewed: [] })
    release()
  })

  it('drops a fetch that started before an approval and answered after it', async () => {
    let answer!: (v: ReviewView) => void
    let reads = 0
    mocks.invoke.mockImplementation((channel: string) => channel !== 'review_view' ? Promise.resolve(approved(view(2, 2, [])))
      : ++reads === 1 ? Promise.resolve(view(2, 1)) : new Promise<ReviewView>(r => { answer = r }))
    const release = acquireReview()
    await flush()
    void refreshReview()
    // The approval's reply lands first: the list empties at once.
    expect(await approveAllChanges()).toBe(true)
    expect(useReview.getState().view?.unreviewed).toEqual([])
    expect(useReview.getState().highlight.ranges).toEqual([])
    // The older fetch answers with the pre-approval list; it must not repaint.
    answer(view(2, 1))
    await flush()
    expect(useReview.getState().view?.version.baseline_revision).toBe(2)
    expect(useReview.getState().view?.unreviewed).toEqual([])
    release()
  })
})

describe('review consumers', () => {
  it('fetch on first acquire, refetch on review:changed and on a project publication, stop when the last leaves', async () => {
    let n = 0
    mocks.invoke.mockImplementation(async () => view(++n, 1))
    const a = acquireReview(), b = acquireReview()
    await flush()
    expect(reviewCalls()).toBe(1)
    expect(useReview.getState().view?.version.revision).toBe(1)
    mocks.listeners.get('review:changed')!({ payload: { baseline_revision: 2 } })
    await flush()
    expect(reviewCalls()).toBe(2)
    useProjectStore.getState().apply(summaryFixture())
    await flush()
    expect(reviewCalls()).toBe(3)
    expect(useReview.getState().view?.version.revision).toBe(3)
    a(); b()
    expect(mocks.listeners.has('review:changed')).toBe(false)
    useProjectStore.getState().apply(summaryFixture())
    await flush()
    expect(reviewCalls()).toBe(3)
  })

  it('coalesces a burst into one read in flight and one queued', async () => {
    let answer: Array<() => void> = []
    let n = 0
    mocks.invoke.mockImplementation(() => new Promise<ReviewView>(r => { const v = view(++n, 1); answer.push(() => r(v)) }))
    const release = acquireReview()
    await flush()
    for (let i = 0; i < 5; i++) void refreshReview()
    expect(reviewCalls()).toBe(1)
    answer.shift()!()
    await flush()
    expect(reviewCalls()).toBe(2)
    answer.shift()!()
    await flush()
    expect(reviewCalls()).toBe(2)
    expect(useReview.getState().view?.version.revision).toBe(2)
    release()
  })

  it('reverts all against the held view and applies the returned view', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_revert_all' ? approved(view(2, 1, [])) : view(1, 1))
    const release = acquireReview()
    await flush()
    expect(await revertAllChanges()).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('review_revert_all', {
      version: { session: 1, revision: 1, baseline_revision: 1 }, include_user: false,
    })
    expect(useReview.getState().view?.unreviewed).toEqual([])
    expect(useReview.getState().actionStale).toBeNull()
    release()
  })

  it('a refused action (the view moved on) shows the fresh list and names what did not happen', async () => {
    const fresh = view(2, 1, [change(), change({ id: 'Layer:new' })])
    mocks.invoke.mockImplementation(async (channel: string) => channel.startsWith('review_') && channel.endsWith('_all') ? approved(fresh, false) : view(1, 1))
    const release = acquireReview()
    await flush()
    expect(await approveAllChanges()).toBe(false)
    expect(useReview.getState().view).toBe(fresh)
    expect(useReview.getState().actionStale).toBe('approve')
    expect(await revertAllChanges()).toBe(false)
    expect(useReview.getState().actionStale).toBe('revert')
    release()
  })

  it('asks for the user-only list only while "show my changes" is on', async () => {
    const mine = change({ id: 'Layer:mine' })
    mocks.invoke.mockImplementation(async (_: string, args: { include_user?: boolean }) =>
      ({ ...view(1, 1), user: args.include_user ? [mine] : [], user_count: 1 }))
    const release = acquireReview()
    await flush()
    expect(mocks.invoke).toHaveBeenLastCalledWith('review_view', { include_user: false })
    expect(useReview.getState().view?.user).toEqual([])
    // Same version, now with the list: taken although it is not newer.
    setShowUser(true)
    await flush()
    expect(mocks.invoke).toHaveBeenLastCalledWith('review_view', { include_user: true })
    expect(useReview.getState().view?.user).toEqual([mine])
    release()
  })
})

describe('buildReviewHighlight', () => {
  it('marks each current entity and uses only explicit baseline footprints for removal ghosts', () => {
    const gone = change({ id: 'Layer:gone', class: 'removed', ranges: [],
      before_ranges: [{ composition_id: 'root', track_id: 'track-1', t_start_us: 3, t_end_us: 9 }] })
    const moved = change({ id: 'Layer:moved', class: 'modified' })
    const h = buildReviewHighlight([change(), moved, gone], [
      { layer_id: 'group', composition_id: 'root', t_start_us: 4, t_end_us: 7, change_ids: ['Layer:moved', 'Layer:user'] },
    ])
    expect([...h.layers]).toEqual([['a', 'added'], ['moved', 'modified']])
    expect(h.ghosts).toEqual([{ changeId: 'Layer:gone', layerId: 'gone', compositionId: 'root', trackId: 'track-1', tStartUs: 3, tEndUs: 9 }])
    expect([...h.groups]).toEqual([['group', 1]])
    // Its baseline footprint reaches the mini timeline as historical only.
    expect(h.ranges.filter(r => r.changeId === 'Layer:gone')).toEqual([{ changeId: 'Layer:gone', cls: 'removed', compositionId: 'root', tStartUs: 3, tEndUs: 9, historical: true }])
    expect(h.ranges.filter(r => r.historical).map(r => r.changeId)).toEqual(['Layer:gone'])
    expect([...h.layerChanges]).toEqual([['a', 'Layer:a'], ['moved', 'Layer:moved']])
    expect(buildReviewHighlight([{ ...gone, before_ranges: [] }], []).ghosts).toEqual([])
  })

  it('paints a Group\'s "contains changes" stretch under the changes, and its badge counts only the changes given', () => {
    const group = change({ id: 'Layer:group', class: 'added', ranges: [{ composition_id: 'root', track_id: 'v1', t_start_us: 2, t_end_us: 6 }] })
    const inner = change({ id: 'Layer:inner', class: 'modified', composition_id: 'grp', ranges: [{ composition_id: 'grp', track_id: 'g1', t_start_us: 0, t_end_us: 1 }] })
    // The decoration also names a change of the other list, not on screen.
    const h = buildReviewHighlight([group, inner], [
      { layer_id: 'group', composition_id: 'root', t_start_us: 2, t_end_us: 6, change_ids: ['Layer:inner', 'Layer:mine'] },
    ])
    expect(h.ranges.filter(r => r.compositionId === 'root').map(r => r.changeId)).toEqual(['Group:group', 'Layer:group'])
    expect([...h.groups]).toEqual([['group', 1]])
  })

  it('gives a removed marker or transition, which has no ghost, its baseline footprint on the mini timeline', () => {
    const marker = change({ id: 'Marker:m', class: 'removed', ranges: [],
      before_ranges: [{ composition_id: 'root', track_id: null, t_start_us: 5, t_end_us: 5 }] })
    const h = buildReviewHighlight([marker], [])
    expect(h.ghosts).toEqual([])
    expect(h.ranges).toEqual([{ changeId: 'Marker:m', cls: 'removed', compositionId: 'root', tStartUs: 5, tEndUs: 5, historical: true }])
    // On the marker lane: a trace at its baseline place, named by its baseline label.
    expect(h.markerGhosts).toEqual([{ changeId: 'Marker:m', markerId: 'm', compositionId: 'root', tUs: 5, endUs: null, label: '' }])
  })

  it('marks a live marker by its class and traces a removed region marker with its baseline name', () => {
    const added = change({ id: 'Marker:a', class: 'added' })
    const edited = change({ id: 'Marker:e', class: 'modified' })
    const gone = change({ id: 'Marker:g', class: 'removed', ranges: [], before_name: 'Beat',
      before_ranges: [{ composition_id: 'root', track_id: null, t_start_us: 2, t_end_us: 4 }] })
    const h = buildReviewHighlight([added, edited, gone], [])
    expect([...h.markers]).toEqual([['a', 'added'], ['e', 'modified']])
    expect(h.markerGhosts).toEqual([{ changeId: 'Marker:g', markerId: 'g', compositionId: 'root', tUs: 2, endUs: 4, label: 'Beat' }])
    expect(h.layers.size).toBe(0)
  })
})

// Per-activity highlight (ticket 07): one call's own changes take over every
// timeline surface while its row is selected.
describe('activity highlight', () => {
  const op = (id: string, patch: Partial<AgentActivity> = {}): AgentActivity => ({
    id, session_id: null, connection_id: 'c', client: 'agent', tool: 'add_layer', kind: 'operation', started_at: '', ended_at: '', state: 'done',
    duration_ms: 1, message: '', affected: [], entity_labels: [], history_ids: [`op-${id}`], effect: 'applied', args: {}, error: null, ...patch,
  })
  const seed = (activities: AgentActivity[], patch: Partial<AgentActivitySnapshot> = {}) => useAgentActivity.setState({
    snapshot: { workspace_id: 'w', revision: 1, session: null, sessions: [], activities, evicted: 0, lock_reason: null, checkpoints: [], tacks: [], ...patch },
    expanded: {}, tab: 'activity', reviewOverlay: true,
  })
  const mine = change({ id: 'Layer:mine', class: 'modified' })
  const answer = (available = true, reverted = false) => mocks.invoke.mockImplementation(async (channel: string) =>
    channel === 'review_activity_view' ? { available, reverted, changes: available ? [mine] : [], decorations: [] } : view(1, 1))
  beforeEach(() => { useReview.getState().apply(view(1, 1)); seed([op('a'), op('b'), op('read', { kind: 'read', history_ids: [], effect: null })]) })
  afterEach(() => clearActivityChanges())

  it('expanding a row highlights its changes in place of the unreviewed ones; collapsing restores them', async () => {
    answer()
    act(() => useAgentActivity.getState().toggle('a'))
    expect(mocks.invoke).toHaveBeenCalledWith('review_activity_view', { history_ids: ['op-a'] })
    await flush()
    expect(useReview.getState().activity).toMatchObject({ activityId: 'a', status: 'ready', count: 1 })
    expect(selectHighlight(useReview.getState()).layers.get('mine')).toBe('modified')
    expect(selectHighlight(useReview.getState()).layers.has('a')).toBe(false)
    act(() => useAgentActivity.getState().toggle('a'))
    expect(useReview.getState().activity).toBeNull()
    expect(selectHighlight(useReview.getState()).layers.get('a')).toBe('added')
  })

  it('counts each changed entity in the activity', async () => {
    const gone = change({ id: 'Layer:gone', class: 'removed' })
    const moved = change({ id: 'Layer:next', class: 'modified' })
    mocks.invoke.mockImplementation(async (channel: string) =>
      channel === 'review_activity_view' ? { available: true, reverted: false, changes: [gone, moved], decorations: [] } : view(1, 1))
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    expect(useReview.getState().activity).toMatchObject({ status: 'ready', count: 2 })
  })

  it('another row replaces it; a row without history ops, a tab switch or a project change clears it', async () => {
    answer()
    act(() => useAgentActivity.getState().toggle('a'))
    act(() => useAgentActivity.getState().toggle('b'))
    await flush()
    expect(useReview.getState().activity).toMatchObject({ activityId: 'b', status: 'ready' })
    expect(mocks.invoke.mock.calls.filter(([c]) => c === 'review_activity_view')).toHaveLength(2)
    act(() => useAgentActivity.getState().toggle('read'))
    expect(useReview.getState().activity).toBeNull()
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    act(() => useAgentActivity.setState({ tab: 'changes' }))
    expect(useReview.getState().activity).toBeNull()
    act(() => useAgentActivity.setState({ tab: 'activity', expanded: {} }))
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    act(() => useAgentActivity.setState({ snapshot: { ...useAgentActivity.getState().snapshot!, workspace_id: 'other' } }))
    expect(useReview.getState().activity).toBeNull()
  })

  it('a stale reply for a replaced selection is dropped', async () => {
    const replies: Array<() => void> = []
    mocks.invoke.mockImplementation((_channel: string, args: { history_ids: string[] }) => new Promise(r => replies.push(() =>
      r({ available: true, reverted: false, changes: [change({ id: `Layer:${args.history_ids[0]}` })], decorations: [] }))))
    act(() => useAgentActivity.getState().toggle('a'))
    act(() => useAgentActivity.getState().toggle('b'))
    replies[1]!(); await flush()
    replies[0]!(); await flush()
    expect([...selectHighlight(useReview.getState()).layers.keys()]).toEqual(['op-b'])
  })

  it('the row\'s own button re-selects it after a clear; it holds only while the row is expanded', async () => {
    answer()
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    clearActivityChanges()
    expect(useReview.getState().activity).toBeNull()
    await showActivityChanges(op('a'))
    expect(useReview.getState().activity).toMatchObject({ activityId: 'a', status: 'ready' })
  })

  it('an op outside the history window: the row is marked unavailable and nothing is highlighted', async () => {
    answer(false)
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    expect(useReview.getState().activity).toMatchObject({ activityId: 'a', status: 'unavailable' })
    expect(selectHighlight(useReview.getState())).toBe(useReview.getState().highlight)
  })

  it('refetches when the selected call commits more or is undone', async () => {
    answer()
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    answer(true, true)
    const snap = useAgentActivity.getState().snapshot!
    act(() => useAgentActivity.setState({ snapshot: { ...snap, revision: 2, activities: snap.activities.map(x => x.id === 'a' ? { ...x, effect: 'reverted' as const } : x) } }))
    // The held highlight stays on screen until the reply lands.
    expect(useReview.getState().activity).toMatchObject({ status: 'ready', reverted: false })
    await flush()
    expect(useReview.getState().activity).toMatchObject({ status: 'ready', reverted: true })
  })

  it('the editor timeline respects the Review overlay; the mini timeline band always shows it', async () => {
    answer()
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    useAgentActivity.setState({ reviewOverlay: false })
    const mark = renderHook(() => useLayerReviewMark('mine'))
    const band = renderHook(() => useCompositionChangeRanges('root'))
    expect(mark.result.current).toBeNull()
    expect(band.result.current.map(r => r.changeId)).toEqual(['Layer:mine'])
    act(() => useAgentActivity.setState({ reviewOverlay: true }))
    expect(mark.result.current).toBe('modified')
  })
})
