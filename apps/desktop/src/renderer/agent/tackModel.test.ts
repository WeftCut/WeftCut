import { describe, expect, it } from 'vitest'
import type { AgentWorkSession, TackView } from '../../shared/agent-activity'
import { groupTacks, paintableTacks, reviewLaneExists, tackCoverage, tackMarkerArgs, tackUnplacedReason } from './tackModel'

const tack = (patch: Partial<TackView>): TackView => ({
  id: 't', session_id: null, connection_id: 'c', client: 'C', activity_id: 'a', kind: 'note', label: 'L', body: 'B', status: 'open',
  range: { kind: 'free', composition_id: 'root', t_us: 0, end_t_us: null }, created_at: '',
  composition_id: 'root', t_us: 0, end_t_us: null, state: 'visible', outdated: false, follows: { start: null, end: null }, ...patch,
})

describe('tack model', () => {
  it('groups by work session in order of first tack, rows in timeline order with unplaced ones last', () => {
    const groups = groupTacks([
      tack({ id: 'b', session_id: 's', t_us: 5 }), tack({ id: 'x', session_id: null }),
      tack({ id: 'gone', session_id: 's', state: 'stale', t_us: null }), tack({ id: 'a', session_id: 's', t_us: 1 }),
    ], [], (s) => `g-${s}`)
    expect(groups.map((g) => [g.key, g.tacks.map((t) => t.id)])).toEqual([['g-s', ['a', 'b', 'gone']], ['g-null', ['x']]])
  })

  it('paints only open, visible tacks of the composition', () => {
    const ids = paintableTacks([
      tack({ id: 'ok' }), tack({ id: 'resolved', status: 'resolved' }), tack({ id: 'asleep', state: 'hibernating', t_us: null }),
      tack({ id: 'elsewhere', composition_id: 'group' }),
    ], 'root').map((t) => t.id)
    expect(ids).toEqual(['ok'])
  })

  it('converts free tacks freely and anchored ones on their source instant; never an unplaced one', () => {
    expect(tackMarkerArgs(tack({ t_us: 10, end_t_us: 20 }))).toEqual({ compositionId: 'root', tUs: 10, endTUs: 20, label: 'L', note: 'B', anchor: null })
    expect(tackMarkerArgs(tack({ range: { kind: 'anchored', layer_id: 'clip', src_us: 7, src_end_us: null } }))?.anchor).toEqual({ layer: 'clip', src_us: 7 })
    const edges = (start: { layer_id: string; src_us: number; src_fraction?: { num: number; den: number } } | null) =>
      tack({ t_us: 10, end_t_us: 20, range: { kind: 'edges', composition_id: 'root', t_us: 4, end_t_us: 14, start, end: { layer_id: 'next', src_us: 9 } } })
    // An edge-anchored tack becomes a marker on its START's instant, the region
    // end staying where the tack is placed now; with no start anchor it is free.
    expect(tackMarkerArgs(edges({ layer_id: 'clip', src_us: 7, src_fraction: { num: 1, den: 3 } })))
      .toEqual({ compositionId: 'root', tUs: 10, endTUs: 20, label: 'L', note: 'B', anchor: { layer: 'clip', src_us: 7, src_fraction: { num: 1, den: 3 } } })
    expect(tackMarkerArgs(edges(null))?.anchor).toBeNull()
    expect(tackMarkerArgs(tack({ state: 'hibernating', t_us: null }))).toBeNull()
    expect(tackUnplacedReason(tack({ state: 'stale' }))).toBe('tacks.stale_hint')
    expect(tackUnplacedReason(tack({}))).toBeNull()
  })

  it('holds the Review lane on the overlay and any review material, never on the open count', () => {
    const session = { id: 's' } as AgentWorkSession
    expect(reviewLaneExists(true, null)).toBe(false)
    expect(reviewLaneExists(true, { sessions: [], tacks: [] })).toBe(false)
    expect(reviewLaneExists(true, { sessions: [session], tacks: [] })).toBe(true)
    // A closed or unplaced tack is still material: resolving the last open one
    // must not take the row away under the user.
    expect(reviewLaneExists(true, { sessions: [], tacks: [tack({ status: 'resolved' })] })).toBe(true)
    expect(reviewLaneExists(true, { sessions: [], tacks: [tack({ state: 'stale', t_us: null })] })).toBe(true)
    expect(reviewLaneExists(false, { sessions: [session], tacks: [tack({})] })).toBe(false)
  })

  it('merges tack ranges into disjoint spans and keeps only uncovered points', () => {
    expect(tackCoverage([
      tack({ t_us: 50, end_t_us: 60 }), tack({ t_us: 10, end_t_us: 20 }), tack({ t_us: 15, end_t_us: 30 }),
      tack({ t_us: 30, end_t_us: 40 }), tack({ t_us: 25, end_t_us: null }), tack({ t_us: 45, end_t_us: 45 }),
      tack({ t_us: 45, end_t_us: null }), tack({ t_us: null, end_t_us: null }),
    ])).toEqual({ spans: [[10, 40], [50, 60]], points: [45] })
  })
})
