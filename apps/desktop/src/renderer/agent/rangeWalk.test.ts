// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangedRange, EntityKey, ReviewView } from '../../shared/review'
import { registerTransport, releaseTransport, type TransportHandle } from '../state/playbackStore'
import { playheadTimeUs, setPlayheadTimeUs } from '../state/playheadStore'
import { useProjectStore } from '../state/projectStore'
import { setRangeIn, setRangeOut, useRangeStore } from '../state/rangeStore'
import { ROOT_ID, summaryFixture } from '../testing/summaryFixture'
import { useAgentActivity } from './activityStore'
import { rangeKey, releaseFocus, selectRange, useReviewFocus } from './reviewFocus'
import { resetReviewForTests, useReview } from './reviewStore'
import {
  PLAY_CUT_SIDE_US, PLAY_LEAD_IN_US, PLAY_TAIL_US, nextRange, playChangedRange, rangeAtOrAfter, rangePlaySpan, walkChangedRange,
} from './rangeWalk'

const S = 1_000_000
const R = (start: number, end: number, ids: EntityKey[] = ['Layer:x']): ChangedRange => ({
  composition_id: ROOT_ID, class: end > start ? 'modified' : 'removed', t_start_us: start, t_end_us: end,
  before_start_us: start, before_end_us: end > start ? end : start + S, source: 'review', change_ids: ids,
})
// A stretch, a cut point, a stretch — in time order.
const a = R(2 * S, 3 * S, ['Layer:a'])
const cut = R(5 * S, 5 * S, ['Layer:c'])
const b = R(7 * S, 8 * S, ['Layer:b'])
const ranges = [a, cut, b]

describe('nextRange', () => {
  it('steps to the neighbour of a range in the list, and stops at either end', () => {
    expect(nextRange(ranges, { range: a }, 1)).toBe(cut)
    expect(nextRange(ranges, { range: cut }, -1)).toBe(a)
    expect(nextRange(ranges, { range: b }, 1)).toBeNull()
    expect(nextRange(ranges, { range: a }, -1)).toBeNull()
  })

  it('from the playhead, a range starting in the frame on screen is behind in both directions', () => {
    const frameOf = (us: number) => Math.floor(us / S) * S
    expect(nextRange(ranges, { playheadUs: 2 * S + 10 }, 1, frameOf)).toBe(cut)
    expect(nextRange(ranges, { playheadUs: 2 * S + 10 }, -1, frameOf)).toBeNull()
    expect(nextRange(ranges, { playheadUs: 6 * S }, -1, frameOf)).toBe(cut)
  })
})

describe('what a play runs', () => {
  it('a lead-in before the range and a tail after it, never before the film starts', () => {
    expect(rangePlaySpan(a)).toEqual({ fromUs: a.t_start_us - PLAY_LEAD_IN_US, stopUs: a.t_end_us + PLAY_TAIL_US })
    expect(rangePlaySpan(R(0, S)).fromUs).toBe(0)
  })

  it('a cut point, the same stretch either side of the cut', () => {
    expect(rangePlaySpan(cut)).toEqual({ fromUs: cut.t_start_us - PLAY_CUT_SIDE_US, stopUs: cut.t_start_us + PLAY_CUT_SIDE_US })
  })

  it('without a focus, the range under the playhead or the first after it', () => {
    expect(rangeAtOrAfter(ranges, 2.5 * S)).toBe(a)
    expect(rangeAtOrAfter(ranges, 3 * S)).toBe(cut)
    expect(rangeAtOrAfter(ranges, 5 * S)).toBe(cut)
    expect(rangeAtOrAfter(ranges, 9 * S)).toBeNull()
  })
})

describe('walking and playing on the open timeline', () => {
  const log: string[] = []
  const transport: TransportHandle = {
    play: (untilUs?: number) => { log.push(`play:${untilUs ?? 'end'}`) },
    pause: () => { log.push('pause') },
    seek: (tUs: number) => { log.push(`seek:${tUs}`) },
    isPlaying: () => false,
  }
  const view: ReviewView = {
    version: { session: 1, revision: 1, baseline_revision: 1 }, content_revision: 1, has_baseline: true,
    unreviewed: [], user: [], user_count: 0, decorations: [], ranges: [b, a, cut],
  }
  const focused = () => useReviewFocus.getState().focus
  beforeEach(() => {
    log.length = 0
    resetReviewForTests()
    useProjectStore.getState().apply(summaryFixture({ root: { duration_us: 10 * S } }))
    useAgentActivity.setState({ snapshot: null, tab: 'changes', expanded: {} })
    useReviewFocus.setState({ focus: null, hover: null, range: null })
    useReview.getState().apply(view)
    registerTransport(transport)
    setPlayheadTimeUs(0)
  })
  afterEach(() => { releaseTransport(transport); resetReviewForTests(); vi.restoreAllMocks() })

  it('walks the ranges in time order, parking on each and focusing it, and stops at the end', () => {
    const walk = (dir: 1 | -1) => { walkChangedRange(dir); return [playheadTimeUs(), focused()?.id] }
    expect(walk(1)).toEqual([a.t_start_us, rangeKey(a)])
    expect(walk(1)).toEqual([cut.t_start_us, rangeKey(cut)])
    expect(walk(1)).toEqual([b.t_start_us, rangeKey(b)])
    log.length = 0
    expect(walk(1)).toEqual([b.t_start_us, rangeKey(b)])
    expect(log).toEqual([])
    expect(walk(-1)).toEqual([cut.t_start_us, rangeKey(cut)])
  })

  it('says where it landed for the status line, and that there is nothing further at an end', () => {
    expect(walkChangedRange(1)).toMatchObject({ i18n_key: 'log.changed_range_at', i18n_args: { index: 1, count: 3 } })
    walkChangedRange(1)
    expect(walkChangedRange(1)).toMatchObject({ i18n_args: { index: 3, count: 3 } })
    expect(walkChangedRange(1)).toMatchObject({ i18n_key: 'log.changed_range_last' })
    selectRange(a)
    expect(walkChangedRange(-1)).toMatchObject({ i18n_key: 'log.changed_range_first' })
  })

  it('walks from the playhead when nothing is focused', () => {
    releaseFocus()
    setPlayheadTimeUs(6 * S)
    walkChangedRange(-1)
    expect([playheadTimeUs(), focused()?.id]).toEqual([cut.t_start_us, rangeKey(cut)])
  })

  it('plays the focused range and bounds the play on the transport, leaving in and out alone', () => {
    setRangeIn(S)
    setRangeOut(9 * S)
    selectRange(a)
    playChangedRange()
    const span = rangePlaySpan(a)
    expect(log).toEqual([`seek:${span.fromUs}`, `play:${span.stopUs}`])
    expect(useRangeStore.getState()).toMatchObject({ inUs: S, outUs: 9 * S })
  })

  it('without a focus, plays the range under or after the playhead', () => {
    setPlayheadTimeUs(4 * S)
    playChangedRange()
    const span = rangePlaySpan(cut)
    expect(log).toEqual([`seek:${span.fromUs}`, `play:${span.stopUs}`])
  })
})
