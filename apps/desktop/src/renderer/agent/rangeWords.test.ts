import { describe, expect, it } from 'vitest'
import type { ChangedRange } from '../../shared/review'
import type { Translate } from './changeWords'
import { rangesTotal } from './rangeWords'

const S = 1_000_000
/** Echoes the key and its values, so a test reads what was asked for. */
const t: Translate = (key, values) => `${key}${JSON.stringify(values)}`
const at = (s: number, e: number): ChangedRange => ({
  composition_id: 'root', class: 'modified', t_start_us: s, t_end_us: e, before_start_us: s, before_end_us: e, source: 'review', change_ids: [],
})

describe('rangesTotal', () => {
  it('counts every range and sums how long they run; a cut point adds no time', () => {
    expect(rangesTotal([at(0, 2 * S), at(5 * S, 5 * S)], t).short).toBe('changes.range_bar.total{"count":2,"duration":"changes.range.seconds{\\"value\\":\\"2.0\\"}"}')
  })

  it('tells a minute or more as m:ss, where a decimal stops being read', () => {
    expect(rangesTotal([at(0, 65 * S)], t).short).toContain('"duration":"1:05"')
  })

  it('with nothing but cut points, names them and no length', () => {
    expect(rangesTotal([at(5 * S, 5 * S)], t)).toEqual({ short: 'changes.range_bar.total_cuts{"count":1}', full: 'changes.range_bar.total_cuts{"count":1}' })
  })
})
