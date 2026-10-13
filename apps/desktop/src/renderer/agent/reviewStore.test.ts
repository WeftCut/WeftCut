// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change, ReviewView } from '../../shared/review'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (e: { payload: unknown }) => void>() }))
vi.mock('@/bridge/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/bridge/events', () => ({ listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => { mocks.listeners.set(name, fn); return () => { mocks.listeners.delete(name) } }) }))
import { acquireReview, approveAllChanges, approveChanges, isNewerReviewView, refreshReview, resetReviewForTests, useReview } from './reviewStore'
import { buildReviewHighlight } from './reviewHighlight'
import { useProjectStore } from '../state/projectStore'
import { summaryFixture } from '../testing/summaryFixture'

const change = (patch: Partial<Change> = {}): Change => ({
  id: 'Layer:a', class: 'added', kind: 'Layer', keys: ['Layer:a'], aspects: [], composition_id: 'root', composition_ids: ['root'],
  ranges: [{ composition_id: 'root', t_start_us: 0, t_end_us: 1_000_000 }], ...patch,
})
const view = (revision: number, baseline: number, unreviewed: Change[] = [change()], session = 1): ReviewView => ({
  version: { session, revision, baseline_revision: baseline }, has_baseline: true, unreviewed, user: [], decorations: [],
})
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
    mocks.invoke.mockImplementation((channel: string) => channel === 'review_view'
      ? new Promise<ReviewView>(r => { answer = r })
      : Promise.resolve(view(2, 2, [])))
    const release = acquireReview()
    await flush()
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

  it('approves one change by id and applies the returned view', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'review_approve' ? view(1, 3, []) : view(1, 1))
    const release = acquireReview()
    await flush()
    await approveChanges(['Shift:root:-2400000'])
    expect(mocks.invoke).toHaveBeenCalledWith('review_approve', { change_ids: ['Shift:root:-2400000'] })
    expect(useReview.getState().view?.unreviewed).toEqual([])
    release()
  })
})

describe('buildReviewHighlight', () => {
  it('marks current clips, ghosts removed ones on their baseline track, counts Group contents', () => {
    const h = buildReviewHighlight([
      change(),
      change({ id: 'Layer:m', class: 'modified', keys: ['Layer:m'], aspects: ['params'] }),
      change({ id: 'Shift:root:5', class: 'shifted', keys: ['Layer:s1', 'Layer:s2', 'Marker:k'], delta_us: 5 }),
      change({ id: 'Layer:gone', class: 'removed', keys: ['Layer:gone'], from: { composition_id: 'root', track_id: 'track-1' },
        ranges: [{ composition_id: 'root', t_start_us: 3, t_end_us: 9 }] }),
      change({ id: 'Track:t', class: 'removed', kind: 'Track', keys: ['Track:t'], ranges: [] }),
    ], [
      { layer_id: 'group-1', composition_id: 'root', t_start_us: 0, t_end_us: 1, change_ids: ['Layer:m', 'User:only'] },
      { layer_id: 'group-2', composition_id: 'root', t_start_us: 0, t_end_us: 1, change_ids: ['User:only'] },
    ])
    expect([...h.layers]).toEqual([['a', 'added'], ['m', 'modified'], ['s1', 'shifted'], ['s2', 'shifted']])
    expect(h.ghosts).toEqual([{ changeId: 'Layer:gone', layerId: 'gone', compositionId: 'root', trackId: 'track-1', tStartUs: 3, tEndUs: 9 }])
    // Only changes in the given set count: a decoration of user changes alone gets no badge.
    expect([...h.groups]).toEqual([['group-1', 1]])
    expect(h.ranges.map(r => r.cls)).toEqual(['added', 'modified', 'shifted', 'removed'])
  })
})
