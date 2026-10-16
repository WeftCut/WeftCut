import { describe, expect, it } from 'vitest'
import type { TackView } from '../../shared/agent-activity'
import type { Change } from '../../shared/review'
import { ROOT_ID, compositionFixture, summaryFixture } from '../testing/summaryFixture'
import { locateTarget, placeOn, type LocateIndex } from './locate'

const S = 1_000_000
/** The root and Group `grp`; clip `v` on the root, `inner` in `grp`; track `t1` on the root. */
const index: LocateIndex = {
  summary: summaryFixture({ groups: [compositionFixture({ id: 'grp', tracks: [] })] }),
  compositionIdByLayerId: new Map([['v', ROOT_ID], ['inner', 'grp']]),
  compositionIdByTrackId: new Map([['t1', ROOT_ID]]),
}
const change = (patch: Partial<Change> & Pick<Change, 'id'>): Change => ({ class: 'modified', details: [], composition_id: ROOT_ID, ranges: [], ...patch })
const at = (composition_id: string, t: number) => [{ composition_id, track_id: null, t_start_us: t, t_end_us: t + S }]
const tack = (patch: Partial<TackView> = {}): TackView => ({
  id: 't', session_id: null, connection_id: 'c', client: 'C', activity_id: 'a', kind: 'note', label: 'L', body: 'B', status: 'open',
  range: { composition_id: ROOT_ID, t_us: 0, end_t_us: null }, created_at: '',
  composition_id: ROOT_ID, t_us: 2 * S, end_t_us: null, outdated: false, follows: null, ...patch,
})
const of = (item: Change | TackView) => locateTarget('class' in item ? { kind: 'change', change: item } : { kind: 'tack', tack: item }, index)

describe('locateTarget — a change', () => {
  it('is its clip while it exists, at its footprint on the clip’s composition', () => {
    expect(of(change({ id: 'Layer:v', ranges: at(ROOT_ID, 3 * S) }))).toEqual({ kind: 'layer', layer_id: 'v', t_us: 3 * S })
    // A footprint elsewhere is no place on the clip's timeline: reveal, no seek.
    expect(of(change({ id: 'Layer:inner', ranges: at(ROOT_ID, 3 * S) }))).toEqual({ kind: 'layer', layer_id: 'inner', t_us: null })
  })

  it('is a removed clip’s baseline footprint on a composition that still exists', () => {
    expect(of(change({ id: 'Layer:gone', class: 'removed', before_ranges: at('grp', S) }))).toEqual({ kind: 'time', composition_id: 'grp', t_us: S })
    expect(of(change({ id: 'Layer:gone', class: 'removed', before_ranges: at('deleted', S) }))).toBeNull()
  })

  it('without a place in time, is its track or its composition while it exists', () => {
    expect(of(change({ id: 'Track:t1' }))).toEqual({ kind: 'track', track_id: 't1' })
    expect(of(change({ id: 'Composition:grp', composition_id: null }))).toEqual({ kind: 'composition', composition_id: 'grp' })
    expect(of(change({ id: 'Track:gone' }))).toBeNull()
    expect(of(change({ id: 'Link:l' }))).toBeNull()
  })
})

describe('locateTarget — a tack', () => {
  it('is the clip it follows, at its start; else its start on its composition', () => {
    expect(of(tack({ follows: { layer_id: 'v', t_us: 2 * S } }))).toEqual({ kind: 'layer', layer_id: 'v', t_us: 2 * S })
    expect(of(tack())).toEqual({ kind: 'time', composition_id: ROOT_ID, t_us: 2 * S })
    // A followed clip this view no longer has: its place still is.
    expect(of(tack({ follows: { layer_id: 'gone', t_us: 2 * S } }))).toEqual({ kind: 'time', composition_id: ROOT_ID, t_us: 2 * S })
  })

  it('is nowhere without a place, or with its composition gone', () => {
    expect(of(tack({ composition_id: null, t_us: null }))).toBeNull()
    expect(of(tack({ composition_id: 'deleted' }))).toBeNull()
  })
})

describe('placeOn — where the agent view jumps', () => {
  const on = (item: Change | TackView, composition: string) =>
    placeOn('class' in item ? { kind: 'change', change: item } : { kind: 'tack', tack: item }, index, composition)
  it('is the item’s time on the composition shown, and nothing elsewhere', () => {
    expect(on(tack({ follows: { layer_id: 'v', t_us: 2 * S } }), ROOT_ID)).toBe(2 * S)
    expect(on(tack(), 'grp')).toBeNull()
    expect(on(change({ id: 'Layer:v', ranges: at(ROOT_ID, 3 * S) }), ROOT_ID)).toBe(3 * S)
    // Its clip lives in the Group: no place on the root, though a footprint names it.
    expect(on(change({ id: 'Layer:inner', ranges: at(ROOT_ID, 3 * S) }), ROOT_ID)).toBeNull()
    expect(on(change({ id: 'Layer:gone', class: 'removed', before_ranges: at(ROOT_ID, S) }), ROOT_ID)).toBe(S)
  })
  it('has no time for a track or a composition as a whole', () => {
    expect(on(change({ id: 'Track:t1' }), ROOT_ID)).toBeNull()
    expect(on(change({ id: 'Composition:grp', composition_id: null }), 'grp')).toBeNull()
  })
})

it('nothing is anywhere before a project is open', () => {
  expect(locateTarget({ kind: 'tack', tack: tack() }, { ...index, summary: null })).toBeNull()
})
