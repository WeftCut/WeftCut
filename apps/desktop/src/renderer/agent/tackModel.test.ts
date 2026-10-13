import { describe, expect, it } from 'vitest'
import type { TackView } from '../../shared/agent-activity'
import { groupTacks, paintableTacks, tackMarkerArgs, tackUnplacedReason } from './tackModel'

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
})
