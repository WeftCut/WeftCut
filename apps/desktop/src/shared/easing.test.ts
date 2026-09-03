import { describe, expect, it } from 'vitest'
import {
  EASING_PRESETS,
  ELASTIC_DEFAULT_AMPLITUDE,
  ELASTIC_DEFAULT_PERIOD,
  applySegmentEasing,
  cloneInterp,
  interpEqExact,
  presetIdForInterp,
  presetIdForSegment,
  segmentEasing,
  type Interpolation,
} from './easing'
import { inIdentity, outIdentity, type Keyframe } from './keyframe'

describe('canonical preset table', () => {
  it('holds the full spec table (36 entries, unique ids)', () => {
    expect(EASING_PRESETS).toHaveLength(36)
    expect(new Set(EASING_PRESETS.map((p) => p.id)).size).toBe(36)
  })

  it('every labelKey follows the keyframe.interp_<id> convention', () => {
    for (const p of EASING_PRESETS) expect(p.labelKey).toBe(`keyframe.interp_${p.id}`)
  })

  // APPEND-ONLY guard for the pre-table presets: these params live in saved
  // projects; a retune would re-label or un-label them via reverse lookup.
  it('pins the pre-table entries to their exact historical params', () => {
    const byId = Object.fromEntries(EASING_PRESETS.map((p) => [p.id, p.interp]))
    expect(byId.linear).toEqual({ kind: 'Linear' })
    expect(byId.hold).toEqual({ kind: 'Hold' })
    expect(byId.ease).toEqual({ kind: 'Bezier', p1: [0.25, 0.1], p2: [0.25, 1] })
    expect(byId.ease_in).toEqual({ kind: 'Bezier', p1: [0.42, 0], p2: [1, 1] })
    expect(byId.ease_out).toEqual({ kind: 'Bezier', p1: [0, 0], p2: [0.58, 1] })
    expect(byId.ease_in_out).toEqual({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })
  })

  it('exact entries are the arithmetic expressions, not hand-rounded decimals', () => {
    const byId = Object.fromEntries(EASING_PRESETS.map((p) => [p.id, p.interp]))
    const quad = byId.ease_in_quad as Extract<Interpolation, { kind: 'Bezier' }>
    expect(quad.p1[0]).toBe(1 / 3)
    expect(quad.p2[0]).toBe(2 / 3)
    expect(quad.p2[1]).toBe(1 / 3)
    const back = byId.ease_in_back as Extract<Interpolation, { kind: 'Bezier' }>
    expect(back.p2[1]).toBe(-(1.70158 / 3))
    const backOut = byId.ease_out_back as Extract<Interpolation, { kind: 'Bezier' }>
    expect(backOut.p1[1]).toBe(1 + 1.70158 / 3)
  })

  it('elastic entries carry the spec defaults; bounce is parameterless', () => {
    const elastic = EASING_PRESETS.filter((p) => p.interp.kind === 'Elastic')
    expect(elastic.map((p) => p.id)).toEqual([
      'ease_in_elastic', 'ease_out_elastic', 'ease_in_out_elastic',
    ])
    for (const p of elastic) {
      expect(p.interp).toMatchObject({
        amplitude: ELASTIC_DEFAULT_AMPLITUDE,
        period: ELASTIC_DEFAULT_PERIOD,
      })
    }
    const bounce = EASING_PRESETS.filter((p) => p.interp.kind === 'Bounce')
    expect(bounce.map((p) => p.id)).toEqual([
      'ease_in_bounce', 'ease_out_bounce', 'ease_in_out_bounce',
    ])
  })
})

describe('presetIdForInterp (exact reverse lookup)', () => {
  it('round-trips every table entry: id → params → id', () => {
    for (const p of EASING_PRESETS) expect(presetIdForInterp(p.interp)).toBe(p.id)
  })

  it('round-trips through a JSON wire hop (f64 round-trips exactly)', () => {
    for (const p of EASING_PRESETS) {
      const hopped = JSON.parse(JSON.stringify(p.interp)) as Interpolation
      expect(presetIdForInterp(hopped)).toBe(p.id)
    }
  })

  it('a perturbed param returns undefined, never a nearest match', () => {
    expect(presetIdForInterp({ kind: 'Bezier', p1: [0.42 + 1e-9, 0], p2: [1, 1] })).toBeUndefined()
    expect(presetIdForInterp({ kind: 'Bezier', p1: [0.42, 0], p2: [1, 1 - 1e-12] })).toBeUndefined()
    expect(presetIdForInterp({ kind: 'Elastic', dir: 'Out', amplitude: 1.5, period: 0.3 })).toBeUndefined()
    expect(presetIdForInterp({ kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.45 })).toBeUndefined()
    expect(presetIdForInterp({ kind: 'Bezier', p1: [0.1, 0.2], p2: [0.3, 0.4] })).toBeUndefined()
  })
})

describe('interpEqExact / cloneInterp', () => {
  const all: Interpolation[] = [
    { kind: 'Hold' },
    { kind: 'Linear' },
    { kind: 'Bezier', p1: [0.2, -0.3], p2: [0.7, 1.4] },
    { kind: 'Elastic', dir: 'InOut', amplitude: 1.25, period: 0.4 },
    { kind: 'Bounce', dir: 'In' },
  ]

  it('clones compare equal, share no mutable state, and cross-kind never matches', () => {
    for (const a of all) {
      const c = cloneInterp(a)
      expect(interpEqExact(a, c)).toBe(true)
      expect(c).not.toBe(a)
      if (a.kind === 'Bezier' && c.kind === 'Bezier') {
        expect(c.p1).not.toBe(a.p1)
        expect(c.p2).not.toBe(a.p2)
      }
      for (const b of all) if (b !== a) expect(interpEqExact(a, b)).toBe(false)
    }
  })

  it('discriminates procedural params, not just kinds', () => {
    const e: Interpolation = { kind: 'Elastic', dir: 'In', amplitude: 1, period: 0.3 }
    expect(interpEqExact(e, { kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 })).toBe(false)
    expect(interpEqExact(e, { kind: 'Elastic', dir: 'In', amplitude: 1.5, period: 0.3 })).toBe(false)
    expect(interpEqExact(e, { kind: 'Elastic', dir: 'In', amplitude: 1, period: 0.45 })).toBe(false)
    expect(interpEqExact({ kind: 'Bounce', dir: 'In' }, { kind: 'Bounce', dir: 'InOut' })).toBe(false)
  })
})

describe('segment-easing bridges (segmentEasing / applySegmentEasing / presetIdForSegment)', () => {
  const base = (id: string, t_us: number, value: number): Keyframe<number> => ({
    id, t_us, value, in: inIdentity(), out: outIdentity(), continuity: 'Broken', segment: { kind: 'Linear' },
  })
  const pair = (e: Interpolation): [Keyframe<number>, Keyframe<number>] => {
    const [a, b] = applySegmentEasing(base('a', 0, 0), base('b', 1_000_000, 1), e)
    return [a, b!]
  }

  // The property the un-mirrored `in` exists for: a preset written onto two keys
  // reads back as the SAME id with no arithmetic in between, so exact f64 equality
  // holds for every table entry.
  it('applying every preset to a two-key track reads back as the same id, exactly', () => {
    for (const p of EASING_PRESETS) {
      const [a, b] = pair(p.interp)
      expect(segmentEasing(a, b), p.id).toEqual(p.interp)
      expect(presetIdForSegment(a, b), p.id).toBe(p.id)
    }
  })

  it('still reads back after a JSON wire hop (f64 round-trips exactly)', () => {
    for (const p of EASING_PRESETS) {
      const [a, b] = pair(p.interp).map((k) => JSON.parse(JSON.stringify(k)) as Keyframe<number>) as [Keyframe<number>, Keyframe<number>]
      expect(presetIdForSegment(a, b), p.id).toBe(p.id)
    }
  })

  it('a Bezier lands as Spline + out = p1 on the left key and in = p2 on the right, both Free', () => {
    const [a, b] = pair({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })
    expect(a.segment).toEqual({ kind: 'Spline' })
    expect(a.out).toEqual({ x: 0.42, y: 0, mode: 'Free' })
    expect(a.in).toEqual(inIdentity())
    expect(b.in).toEqual({ x: 0.58, y: 1, mode: 'Free' })
    expect(b.out).toEqual(outIdentity())
    expect(b.segment).toEqual({ kind: 'Linear' })
  })

  it('a non-Spline easing lands as the class on the left key with identity sides on both', () => {
    for (const e of [
      { kind: 'Hold' }, { kind: 'Linear' },
      { kind: 'Elastic', dir: 'InOut', amplitude: 1.25, period: 0.4 }, { kind: 'Bounce', dir: 'In' },
    ] as Interpolation[]) {
      const auto = { ...base('a', 0, 0), out: { x: 0.9, y: 0.1, mode: 'Auto' as const } }
      const [a, b] = applySegmentEasing(auto, { ...base('b', 1_000_000, 1), in: { x: 0.1, y: 0.9, mode: 'Auto' } }, e)
      expect(a.segment, e.kind).toEqual(e)
      expect(a.out, e.kind).toEqual(outIdentity())
      expect(b!.in, e.kind).toEqual(inIdentity())
    }
  })

  it('with no right key only the left key is written', () => {
    const [a, b] = applySegmentEasing(base('a', 0, 0), undefined, { kind: 'Bezier', p1: [0.2, 0.8], p2: [0.8, 0.2] })
    expect(b).toBeUndefined()
    expect(a.segment).toEqual({ kind: 'Spline' })
    expect(a.out).toEqual({ x: 0.2, y: 0.8, mode: 'Free' })
  })

  it('returns new key objects, leaves the inputs untouched and keeps canonical key order', () => {
    const left = base('a', 0, 0)
    const right = base('b', 1_000_000, 1)
    const [a, b] = applySegmentEasing(left, right, { kind: 'Hold' })
    expect(a).not.toBe(left)
    expect(b).not.toBe(right)
    expect(left.segment).toEqual({ kind: 'Linear' })
    expect(Object.keys(a)).toEqual(['id', 't_us', 'value', 'in', 'out', 'continuity', 'segment'])
    expect(Object.keys(b!)).toEqual(['id', 't_us', 'value', 'in', 'out', 'continuity', 'segment'])
  })

  it('segmentEasing reports a hand-tuned Spline as a Bezier no preset names', () => {
    const [a, b] = pair({ kind: 'Bezier', p1: [0.42, 0.001], p2: [1, 1] })
    expect(segmentEasing(a, b)).toEqual({ kind: 'Bezier', p1: [0.42, 0.001], p2: [1, 1] })
    expect(presetIdForSegment(a, b)).toBeUndefined()
  })
})
