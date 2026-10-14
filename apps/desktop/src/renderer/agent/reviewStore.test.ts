// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change, ReviewView } from '../../shared/review'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (e: { payload: unknown }) => void>() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/bridge/events', () => ({ listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name) } }) }))
import { act, renderHook } from '@testing-library/react'
import { acquireReview, approveAllChanges, approveChanges, clearActivityChanges, isNewerReviewView, refreshReview, resetReviewForTests, selectHighlight, setShowUser, showActivityChanges, useCompositionChangeRanges, useLayerReviewMark, useReview } from './reviewStore'
import { useAgentActivity } from './activityStore'
import type { AgentActivity, AgentActivitySnapshot } from '../../shared/agent-activity'
import { buildReviewHighlight } from './reviewHighlight'
import { useProjectStore } from '../state/projectStore'
import { summaryFixture } from '../testing/summaryFixture'

const change = (patch: Partial<Change> = {}): Change => ({
  id: 'Layer:a', class: 'added', kind: 'Layer', keys: ['Layer:a'], aspects: [], details: [], composition_id: 'root', composition_ids: ['root'],
  ranges: [{ composition_id: 'root', t_start_us: 0, t_end_us: 1_000_000 }], ...patch,
})
const view = (revision: number, baseline: number, unreviewed: Change[] = [change()], session = 1): ReviewView => ({
  version: { session, revision, baseline_revision: baseline }, has_baseline: true, unreviewed, user: [], user_count: 0, decorations: [],
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

  it('approves one change by id against the held view and applies the returned view', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve' ? approved(view(1, 3, [])) : view(1, 1))
    const release = acquireReview()
    await flush()
    expect(await approveChanges(['Shift:root:-2400000'])).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('review_approve', {
      version: { session: 1, revision: 1, baseline_revision: 1 }, include_user: false, change_ids: ['Shift:root:-2400000'],
    })
    expect(useReview.getState().view?.unreviewed).toEqual([])
    expect(useReview.getState().approvalStale).toBe(false)
    release()
  })

  it('a refused approval (the view moved on) shows the fresh list and says so', async () => {
    const fresh = view(2, 1, [change(), change({ id: 'Layer:new', keys: ['Layer:new'] })])
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve_all' ? approved(fresh, false) : view(1, 1))
    const release = acquireReview()
    await flush()
    expect(await approveAllChanges()).toBe(false)
    expect(useReview.getState().view).toBe(fresh)
    expect(useReview.getState().approvalStale).toBe(true)
    release()
  })

  it('asks for the user-only list only while "show my changes" is on', async () => {
    const mine = change({ id: 'Layer:mine', keys: ['Layer:mine'] })
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
  it('marks current clips, ghosts removed ones on their baseline track, counts Group contents', () => {
    const h = buildReviewHighlight([
      change(),
      change({ id: 'Layer:m', class: 'modified', keys: ['Layer:m'], aspects: ['params'] }),
      change({ id: 'Shift:root:5', class: 'modified', aspects: ['timing'], keys: ['Layer:s1', 'Layer:s2', 'Marker:k'], delta_us: 5 }),
      // Carried along by an edit: painted nowhere, counted nowhere.
      change({ id: 'Shift:root:-9', class: 'modified', aspects: ['timing'], keys: ['Layer:c1'], delta_us: -9, carried: true, ranges: [{ composition_id: 'root', t_start_us: 0, t_end_us: 2 }] }),
      change({ id: 'Layer:gone', class: 'removed', keys: ['Layer:gone'], from: { composition_id: 'root', track_id: 'track-1' },
        ranges: [{ composition_id: 'root', t_start_us: 3, t_end_us: 9 }] }),
      change({ id: 'Track:t', class: 'removed', kind: 'Track', keys: ['Track:t'], ranges: [] }),
    ], [
      { layer_id: 'group-1', composition_id: 'root', t_start_us: 4, t_end_us: 7, change_ids: ['Layer:m', 'User:only'] },
      { layer_id: 'group-2', composition_id: 'root', t_start_us: 0, t_end_us: 1, change_ids: ['User:only'] },
    ])
    expect([...h.layers]).toEqual([['a', 'added'], ['m', 'modified'], ['s1', 'modified'], ['s2', 'modified']])
    expect(h.ghosts).toEqual([{ changeId: 'Layer:gone', layerId: 'gone', compositionId: 'root', trackId: 'track-1', tStartUs: 3, tEndUs: 9 }])
    // Only changes in the given set count: a decoration of user changes alone gets no badge.
    expect([...h.groups]).toEqual([['group-1', 1]])
    expect(h.ranges.map(r => r.cls)).toEqual(['added', 'modified', 'modified', 'removed', 'modified'])
    // A Group containing changes bands its own footprint on the timeline holding it.
    expect(h.ranges.at(-1)).toEqual({ changeId: 'Group:group-1', cls: 'modified', compositionId: 'root', tStartUs: 4, tEndUs: 7 })
    // Each marked clip names its change, for its tooltip; carried ones are not painted.
    expect([...h.layerChanges]).toEqual([['a', 'Layer:a'], ['m', 'Layer:m'], ['s1', 'Shift:root:5'], ['s2', 'Shift:root:5']])
    expect([...h.changes.keys()]).toEqual(['Layer:a', 'Layer:m', 'Shift:root:5', 'Layer:gone', 'Track:t'])
  })

  describe('cut marks', () => {
    const removed = (id: string, start: number, end: number, patch: Partial<Change> = {}) => change({
      id, class: 'removed', keys: [id as Change['keys'][number]], from: { composition_id: 'root', track_id: 'track-1' },
      details: [{ type: 'length', duration_us: 4 }], ranges: [{ composition_id: 'root', t_start_us: start, t_end_us: end }], ...patch,
    })
    const trimmed = (side: 'start' | 'end', delta: number) => change({
      id: 'Layer:t', class: 'modified', keys: ['Layer:t'], aspects: ['timing'], details: [{ type: 'trim', side, delta_us: delta }],
      ranges: [{ composition_id: 'root', t_start_us: 10, t_end_us: 20 }],
    })

    it('a ripple delete is a seam on its baseline track, in place of a zero-width ghost', () => {
      const h = buildReviewHighlight([removed('Layer:r', 5, 5)], [])
      expect(h.ghosts).toEqual([])
      expect(h.cuts).toEqual([{ changeId: 'Layer:r', layerId: 'r', compositionId: 'root', trackId: 'track-1', tUs: 5, kind: 'seam' }])
    })

    it('a delete that left a gap keeps its ghost and has no cut', () => {
      const h = buildReviewHighlight([removed('Layer:g', 5, 9)], [])
      expect(h.ghosts).toHaveLength(1)
      expect(h.cuts).toEqual([])
    })

    it('a trim that cut material marks the end it cut back to, on the clip (its lane resolved where drawn)', () => {
      expect(buildReviewHighlight([trimmed('end', -3)], []).cuts)
        .toEqual([{ changeId: 'Layer:t', layerId: 't', compositionId: 'root', trackId: null, tUs: 20, kind: 'trim' }])
      expect(buildReviewHighlight([trimmed('start', -3)], []).cuts.map(c => c.tUs)).toEqual([10])
    })

    it('an extension has no cut', () => {
      expect(buildReviewHighlight([trimmed('end', 3)], []).cuts).toEqual([])
    })

    it('a carried change is never a cut, but its carrier says which way it moved the rest', () => {
      const carried = (by: string, delta: number) => change({
        id: `Shift:root:${delta}`, class: 'modified', aspects: ['timing'], keys: ['Layer:after'], delta_us: delta, carried: true, carried_by: by,
        details: [{ type: 'trim', side: 'end', delta_us: -1 }], ranges: [{ composition_id: 'root', t_start_us: 30, t_end_us: 40 }],
      })
      const h = buildReviewHighlight([removed('Layer:r', 5, 5), carried('Layer:r', -4)], [])
      expect(h.cuts).toEqual([{ changeId: 'Layer:r', layerId: 'r', compositionId: 'root', trackId: 'track-1', tUs: 5, kind: 'seam', carried: 'earlier' }])
      expect(buildReviewHighlight([trimmed('end', -3), carried('Layer:t', 3)], []).cuts.map(c => c.carried)).toEqual(['later'])
    })
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
  const mine = change({ id: 'Layer:mine', keys: ['Layer:mine'], class: 'modified' })
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

  it('counts what the call did as the Changes tab does: a carried translation is its edit\'s', async () => {
    const gone = change({ id: 'Layer:gone', keys: ['Layer:gone'], class: 'removed' })
    const carried = change({ id: 'Shift:root:-1', keys: ['Layer:next'], class: 'modified', delta_us: -1, carried: true, carried_by: 'Layer:gone' })
    mocks.invoke.mockImplementation(async (channel: string) =>
      channel === 'review_activity_view' ? { available: true, reverted: false, changes: [gone, carried], decorations: [] } : view(1, 1))
    act(() => useAgentActivity.getState().toggle('a'))
    await flush()
    expect(useReview.getState().activity).toMatchObject({ status: 'ready', count: 1 })
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
      r({ available: true, reverted: false, changes: [change({ id: `Layer:${args.history_ids[0]}`, keys: [`Layer:${args.history_ids[0]}`] })], decorations: [] }))))
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
