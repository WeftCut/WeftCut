// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TackView } from '../../shared/agent-activity'
import type { Change, ReviewView } from '../../shared/review'
import { useAgentActivity } from './activityStore'
import { resetReviewForTests, useReview } from './reviewStore'
import { EMPTY_FOCUS_PAINT, buildFocusPaint, focusRevealScrollLeft, hitBand, useFocusPaint } from './reviewFocus'

const S = 1_000_000
const tack = (patch: Partial<TackView> = {}): TackView => ({
  id: 't', session_id: null, connection_id: 'c', client: 'C', activity_id: 'a', kind: 'note', label: 'L', body: '', status: 'open', created_at: '',
  range: { composition_id: 'root', t_us: 2 * S, end_t_us: 3 * S }, composition_id: 'root', t_us: 2 * S, end_t_us: 3 * S,
  outdated: false, follows: null, ...patch,
})
const change = (patch: Partial<Change> & { id: string }): Change => ({
  class: 'modified', kind: 'Layer', keys: [patch.id as Change['keys'][number]], aspects: [], details: [], composition_id: 'root', composition_ids: ['root'], ranges: [], ...patch,
})
const changes = [
  change({ id: 'Layer:a', ranges: [{ composition_id: 'root', t_start_us: 0, t_end_us: S }, { composition_id: 'grp', t_start_us: 5 * S, t_end_us: 6 * S }] }),
  change({ id: 'Layer:gone', class: 'removed', from: { composition_id: 'root', track_id: 'v1' }, ranges: [{ composition_id: 'root', t_start_us: 4 * S, t_end_us: 5 * S }] }),
  change({ id: 'Layer:b', class: 'modified', keys: ['Layer:b'], ranges: [{ composition_id: 'root', t_start_us: 7 * S, t_end_us: 9 * S }] }),
]

describe('buildFocusPaint', () => {
  it('paints nothing with nothing pointed at', () => {
    expect(buildFocusPaint(null, null, [tack()], changes)).toBe(EMPTY_FOCUS_PAINT)
  })

  it('a tack washes its current range and outlines the clip its range follows', () => {
    const focus = { kind: 'tack' as const, id: 't' }
    const p = buildFocusPaint(focus, null, [tack({ follows: { layer_id: 'x', src_us: 0, t_us: 2 * S } })], changes)
    expect(p.focus).toBe(focus)
    expect(p.washes).toEqual([{ kind: 'tack', compositionId: 'root', startUs: 2 * S, endUs: 3 * S }])
    expect([...p.layers]).toEqual([['x', 'tack']])
    expect(p.changeFocused).toBe(false)
  })

  it('a point tack washes one instant; a tack with no place washes nothing', () => {
    expect(buildFocusPaint({ kind: 'tack', id: 't' }, null, [tack({ end_t_us: null })], []).washes)
      .toEqual([{ kind: 'tack', compositionId: 'root', startUs: 2 * S, endUs: 2 * S }])
    const p = buildFocusPaint({ kind: 'tack', id: 't' }, null, [tack({ composition_id: null, t_us: null, end_t_us: null, outdated: true })], [])
    expect([p.washes, [...p.layers]]).toEqual([[], []])
  })

  it('a change washes every range it has, outlines its clips, and makes the rest recede', () => {
    const p = buildFocusPaint({ kind: 'change', id: 'Layer:b' }, null, [], changes)
    expect([...p.layers]).toEqual([['b', 'change']])
    expect(p.washes).toEqual([{ kind: 'change', compositionId: 'root', startUs: 7 * S, endUs: 9 * S }])
    expect(p.changeFocused).toBe(true)
    expect(buildFocusPaint({ kind: 'change', id: 'Layer:a' }, null, [], changes).washes.map(w => w.compositionId)).toEqual(['root', 'grp'])
  })

  it('a removed change outlines its ghost, not a clip', () => {
    const p = buildFocusPaint({ kind: 'change', id: 'Layer:gone' }, null, [], changes)
    expect([[...p.layers], [...p.ghosts]]).toEqual([[], [['Layer:gone', 'change']]])
  })

  it('a hovered change row only outlines, and the focus wins on a clip both name', () => {
    const hover = buildFocusPaint(null, { kind: 'change', id: 'Layer:a' }, [], changes)
    expect([[...hover.layers], hover.washes, hover.changeFocused]).toEqual([[['a', 'hover']], [], false])
    const both = buildFocusPaint({ kind: 'change', id: 'Layer:a' }, { kind: 'change', id: 'Layer:a' }, [], changes)
    expect([...both.layers]).toEqual([['a', 'change']])
    // A hovered tack row has no clip outline: its chip and mini mark read the hover.
    expect([...buildFocusPaint(null, { kind: 'tack', id: 't' }, [tack({ follows: { layer_id: 'x', src_us: 0, t_us: 2 * S } })], []).layers]).toEqual([])
  })

  it('a focused move frames where its clips were, on their tracks — only while focused, never a marker', () => {
    const moved = change({ id: 'Layer:m', aspects: ['placement'], ranges: [{ composition_id: 'root', t_start_us: 0, t_end_us: S }],
      before_ranges: [{ composition_id: 'root', track_id: 'v2', t_start_us: 3 * S, t_end_us: 4 * S }, { composition_id: 'root', track_id: null, t_start_us: 5 * S, t_end_us: 5 * S }] })
    const list = [...changes, moved]
    expect(buildFocusPaint({ kind: 'change', id: 'Layer:m' }, null, [], list).was)
      .toEqual([{ trackId: 'v2', compositionId: 'root', startUs: 3 * S, endUs: 4 * S }])
    expect(buildFocusPaint(null, { kind: 'change', id: 'Layer:m' }, [], list).was).toEqual([])
    expect(buildFocusPaint({ kind: 'change', id: 'Layer:a' }, null, [], list).was).toEqual([])
  })

  it('a focused removal washes its baseline footprint as historical — a marker\'s too, which has no ghost', () => {
    const gone = change({ id: 'Layer:ripple', class: 'removed', ranges: [],
      before_ranges: [{ composition_id: 'root', track_id: 'v1', t_start_us: 2 * S, t_end_us: 3 * S }] })
    const mark = change({ id: 'Marker:m', kind: 'Marker', class: 'removed', ranges: [],
      before_ranges: [{ composition_id: 'root', track_id: null, t_start_us: 6 * S, t_end_us: 6 * S }] })
    const p = buildFocusPaint({ kind: 'change', id: 'Layer:ripple' }, null, [], [gone, mark])
    // Held to the lane the clip was on.
    expect(p.washes).toEqual([{ kind: 'change', compositionId: 'root', startUs: 2 * S, endUs: 3 * S, historical: true, trackId: 'v1' }])
    expect(p.reveal).toEqual(p.washes)
    expect(p.was).toEqual([])
    const m = buildFocusPaint({ kind: 'change', id: 'Marker:m' }, null, [], [gone, mark])
    expect([m.washes, [...m.ghosts]]).toEqual([[{ kind: 'change', compositionId: 'root', startUs: 6 * S, endUs: 6 * S, historical: true }], [['Marker:m', 'change']]])
    // Hovering a removal's row outlines its ghost only; it washes nothing.
    expect(buildFocusPaint(null, { kind: 'change', id: 'Layer:ripple' }, [], [gone]).washes).toEqual([])
  })

  it('a modified change washes its current range only; its baseline place is a frame, never a historical wash', () => {
    const moved = change({ id: 'Layer:m', aspects: ['timing'], ranges: [{ composition_id: 'root', t_start_us: 0, t_end_us: S }],
      before_ranges: [{ composition_id: 'root', track_id: 'v1', t_start_us: 3 * S, t_end_us: 4 * S }] })
    const p = buildFocusPaint({ kind: 'change', id: 'Layer:m' }, null, [], [moved])
    expect(p.washes.some(w => w.historical)).toBe(false)
  })

  it('focusing a removal never outlines neighbouring changed clips', () => {
    const list = [...changes, change({ id: 'Layer:after' })]
    const focused = buildFocusPaint({ kind: 'change', id: 'Layer:gone' }, null, [], list)
    expect([...focused.layers]).toEqual([])
    expect([...focused.ghosts]).toEqual([['Layer:gone', 'change']])
  })

  it('an item no longer listed paints nothing and recedes nothing', () => {
    const p = buildFocusPaint({ kind: 'change', id: 'Layer:approved' }, null, [tack()], changes)
    expect([p.layers.size, p.ghosts.size, p.washes, p.changeFocused]).toEqual([0, 0, [], false])
  })
})

describe('useFocusPaint', () => {
  const view = (unreviewed: Change[], baseline = 1): ReviewView => ({
    version: { session: 1, revision: 1, baseline_revision: baseline }, has_baseline: true, unreviewed, user: [], user_count: 0, decorations: [],
  })
  beforeEach(() => {
    resetReviewForTests()
    useAgentActivity.setState({ snapshot: null, reviewFocus: null, reviewHover: null, tab: 'changes' })
  })
  afterEach(() => resetReviewForTests())

  it('follows the focus and the Review view, keeping unchanged parts by identity', () => {
    useReview.getState().apply(view(changes))
    useAgentActivity.getState().selectChange('Layer:a')
    const first = useFocusPaint.getState()
    expect([...first.layers]).toEqual([['a', 'change']])
    // A view that still lists it with the same footprint: same maps, same washes.
    useReview.getState().apply(view([...changes, change({ id: 'Layer:z' })], 2))
    expect(useFocusPaint.getState().layers).toBe(first.layers)
    expect(useFocusPaint.getState().washes).toBe(first.washes)
    // Approved: the focus goes, and the paint with it.
    useReview.getState().apply(view([], 3))
    expect(useAgentActivity.getState().reviewFocus).toBeNull()
    expect(useFocusPaint.getState().layers.size).toBe(0)
  })

  it('carries a fresh focus per select, so a timeline can reveal the same item again', () => {
    useReview.getState().apply(view(changes))
    useAgentActivity.getState().selectChange('Layer:a')
    const first = useFocusPaint.getState().focus
    useAgentActivity.getState().selectChange('Layer:a')
    expect(useFocusPaint.getState().focus).not.toBe(first)
    expect(useFocusPaint.getState().focus).toEqual(first)
  })
})

describe('focusRevealScrollLeft', () => {
  const view = { scrollLeftPx: 1000, viewportPx: 600 }
  it('leaves a range already in view alone', () => {
    expect(focusRevealScrollLeft({ startPx: 1100, endPx: 1500 }, view)).toBeNull()
    expect(focusRevealScrollLeft({ startPx: 1000, endPx: 1600 }, view)).toBeNull()
  })
  it('centres a range that fits, from either side, never past the start', () => {
    expect(focusRevealScrollLeft({ startPx: 3000, endPx: 3200 }, view)).toBe(2800)
    expect(focusRevealScrollLeft({ startPx: 200, endPx: 400 }, view)).toBe(0)
    // Half in view still counts as out: the whole range is what was asked for.
    expect(focusRevealScrollLeft({ startPx: 900, endPx: 1100 }, view)).toBe(700)
  })
  it('shows the start of a range wider than the view, unless the start is on screen', () => {
    expect(focusRevealScrollLeft({ startPx: 3000, endPx: 5000 }, view)).toBe(3000 - 48)
    expect(focusRevealScrollLeft({ startPx: 1200, endPx: 5000 }, view)).toBeNull()
  })
  it('a point is a zero-width range', () => {
    expect(focusRevealScrollLeft({ startPx: 2000, endPx: 2000 }, view)).toBe(1700)
  })
  it('does nothing without a viewport', () => {
    expect(focusRevealScrollLeft({ startPx: 3000, endPx: 3200 }, { scrollLeftPx: 0, viewportPx: 0 })).toBeNull()
  })
})

describe('hitBand', () => {
  const items = [
    { id: 'long', startUs: 0, endUs: 10 * S },
    { id: 'short', startUs: 4 * S, endUs: 6 * S },
    { id: 'point', startUs: 12 * S, endUs: 12 * S },
    { id: 'near', startUs: 12.5 * S, endUs: 12.5 * S },
  ]
  it('names the shortest range holding the moment', () => {
    expect(hitBand(items, 5 * S, 0.2 * S)).toBe('short')
    expect(hitBand(items, 2 * S, 0.2 * S)).toBe('long')
    expect(hitBand(items, 6 * S, 0.2 * S)).toBe('short')
  })
  it('else the nearest point within the slop, else nothing', () => {
    expect(hitBand(items, 12.1 * S, 0.2 * S)).toBe('point')
    expect(hitBand(items, 12.4 * S, 0.2 * S)).toBe('near')
    expect(hitBand(items, 11 * S, 0.2 * S)).toBeNull()
    expect(hitBand([], 0, S)).toBeNull()
  })
})
