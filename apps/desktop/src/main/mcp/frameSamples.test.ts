import { describe, expect, it } from 'vitest'
import { beatSamples, MAX_SAMPLES_PER_LAYER } from './frameSamples'
import { blankProject, type Layer, type LayerParams } from '../state/model'
import { uuidV7Gen } from '../state/ids'

const S = 1_000_000

function setup() {
  const idGen = uuidV7Gen()
  const p = blankProject(idGen, 'samples')
  const [aRoll, bRoll] = p.compositions[p.root_id]!.tracks
  aRoll!.role = 'ARoll'
  const put = (track: typeof aRoll, params: Partial<LayerParams> & { kind: string }, t0: number, t1: number): Layer => {
    const l = { id: idGen(), label: null, t_start_us: t0 * S, t_end_us: t1 * S, enabled: true, locked: false, metadata: {}, params: params as LayerParams, effects: [] } as Layer
    track!.layers.push(l)
    return l
  }
  return { p, aRoll: aRoll!, bRoll: bRoll!, put }
}

describe('beatSamples', () => {
  it('samples a beat settled, in the middle and in its exit', () => {
    const { p, bRoll, put } = setup()
    const title = put(bRoll, { kind: 'Motif' }, 0, 4)
    expect(beatSamples(p, [title.id], () => null).map((s) => [s.t_us / S, s.why])).toEqual([[0.4, 'settled'], [2, 'middle'], [3.75, 'exit']])
  })

  it('adds a look just after each cut and shot change under it', () => {
    const { p, aRoll, bRoll, put } = setup()
    put(aRoll, { kind: 'VideoClip', media: 'm', src_in_us: 0, src_out_us: 3 * S }, 0, 3)
    put(aRoll, { kind: 'VideoClip', media: 'm', src_in_us: 5 * S, src_out_us: 12 * S }, 3, 10)
    const title = put(bRoll, { kind: 'Motif' }, 0, 8)
    // The source cuts from a wide to a medium shot at 7 s: timeline 3 + (7 - 5) = 5 s.
    const got = beatSamples(p, [title.id], (m) => (m === 'm' ? [0, 7 * S] : null))
    expect(got.map((s) => [s.t_us / S, s.why])).toEqual([[0.4, 'settled'], [3.2, 'after cut'], [4, 'middle'], [5.2, 'after shot change'], [7.75, 'exit']])
  })

  it('caps the samples per layer and refuses a layer not on the root', () => {
    const { p, aRoll, bRoll, put } = setup()
    for (let i = 0; i < 20; i++) put(aRoll, { kind: 'VideoClip', media: 'm', src_in_us: i * 2 * S, src_out_us: (i * 2 + 1) * S }, i, i + 1)
    const long = put(bRoll, { kind: 'Motif' }, 0, 20)
    expect(beatSamples(p, [long.id], () => null)).toHaveLength(MAX_SAMPLES_PER_LAYER)
    expect(() => beatSamples(p, ['nope'], () => null)).toThrow(/no layer nope/)
  })
})
