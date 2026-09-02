import { describe, expect, it } from 'vitest'
import {
  HOLD_EXTRAPOLATION,
  IN_IDENTITY,
  OUT_IDENTITY,
  cloneExtrapolation,
  cloneKeyframeShape,
  cloneSegment,
  cloneTangent,
  extrapolationEq,
  freeSide,
  inIdentity,
  keyframeShapeEqExact,
  outIdentity,
  segmentEqExact,
  tangentEqExact,
  type Keyframe,
  type Segment,
} from './keyframe'

const key = (over: Partial<Keyframe<number>> = {}): Keyframe<number> => ({
  id: 'k',
  t_us: 1_000,
  value: 2.5,
  in: freeSide(0.7, 1.2),
  out: { x: 0.2, y: -0.1, mode: 'Auto' },
  continuity: 'Smooth',
  segment: { kind: 'Elastic', dir: 'Out', amplitude: 1.5, period: 0.45 },
  ...over,
})

describe('identity sides', () => {
  it('are the arithmetic expressions 1/3 and 2/3, never rounded literals', () => {
    expect(OUT_IDENTITY).toEqual({ x: 1 / 3, y: 1 / 3 })
    expect(IN_IDENTITY).toEqual({ x: 2 / 3, y: 2 / 3 })
    expect(outIdentity()).toEqual({ x: 1 / 3, y: 1 / 3, mode: 'Free' })
    expect(inIdentity()).toEqual({ x: 2 / 3, y: 2 / 3, mode: 'Free' })
  })

  it('round-trip JSON exactly (the goldens compare them with ===)', () => {
    expect(JSON.parse(JSON.stringify(OUT_IDENTITY.x))).toBe(1 / 3)
    expect(JSON.parse(JSON.stringify(IN_IDENTITY.x))).toBe(2 / 3)
  })

  it('mint a fresh object per call so a caller can never alias two keys', () => {
    expect(outIdentity()).not.toBe(outIdentity())
    expect(inIdentity()).not.toBe(inIdentity())
  })
})

describe('HOLD_EXTRAPOLATION', () => {
  it('is the clamp on both sides and is frozen', () => {
    expect(HOLD_EXTRAPOLATION).toEqual({ before: 'Hold', after: 'Hold' })
    expect(Object.isFrozen(HOLD_EXTRAPOLATION)).toBe(true)
  })
})

describe('clone helpers', () => {
  it('cloneTangent / cloneSegment / cloneExtrapolation compare equal and share nothing', () => {
    const t = freeSide(0.1, 0.9)
    expect(cloneTangent(t)).toEqual(t)
    expect(cloneTangent(t)).not.toBe(t)
    const segs: Segment[] = [
      { kind: 'Spline' }, { kind: 'Hold' }, { kind: 'Linear' },
      { kind: 'Elastic', dir: 'InOut', amplitude: 2, period: 0.3 }, { kind: 'Bounce', dir: 'In' },
    ]
    for (const s of segs) {
      expect(cloneSegment(s)).toEqual(s)
      expect(cloneSegment(s)).not.toBe(s)
    }
    const e = cloneExtrapolation(HOLD_EXTRAPOLATION)
    expect(e).toEqual(HOLD_EXTRAPOLATION)
    expect(Object.isFrozen(e)).toBe(false)
  })

  it('cloneKeyframeShape drops the id, deep-copies both sides and the segment, and keeps canonical key order', () => {
    const k = key()
    const shape = cloneKeyframeShape(k)
    expect(Object.keys(shape)).toEqual(['t_us', 'value', 'in', 'out', 'continuity', 'segment'])
    expect(shape).toEqual({ t_us: k.t_us, value: k.value, in: k.in, out: k.out, continuity: k.continuity, segment: k.segment })
    expect(shape.in).not.toBe(k.in)
    expect(shape.out).not.toBe(k.out)
    expect(shape.segment).not.toBe(k.segment)
    expect(Object.keys({ id: 'fresh', ...shape })).toEqual(['id', 't_us', 'value', 'in', 'out', 'continuity', 'segment'])
  })
})

describe('exact equality', () => {
  it('tangentEqExact compares coords and mode with ===', () => {
    expect(tangentEqExact(freeSide(0.42, 0), freeSide(0.42, 0))).toBe(true)
    expect(tangentEqExact(freeSide(0.42, 0), freeSide(0.42 + 1e-12, 0))).toBe(false)
    expect(tangentEqExact(freeSide(0.42, 0), { x: 0.42, y: 0, mode: 'Auto' })).toBe(false)
  })

  it('segmentEqExact discriminates kinds and procedural params', () => {
    expect(segmentEqExact({ kind: 'Spline' }, { kind: 'Spline' })).toBe(true)
    expect(segmentEqExact({ kind: 'Spline' }, { kind: 'Linear' })).toBe(false)
    const e: Segment = { kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 }
    expect(segmentEqExact(e, { kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 })).toBe(true)
    expect(segmentEqExact(e, { kind: 'Elastic', dir: 'In', amplitude: 1, period: 0.3 })).toBe(false)
    expect(segmentEqExact(e, { kind: 'Elastic', dir: 'Out', amplitude: 1.5, period: 0.3 })).toBe(false)
    expect(segmentEqExact({ kind: 'Bounce', dir: 'In' }, { kind: 'Bounce', dir: 'Out' })).toBe(false)
  })

  it('extrapolationEq compares both sides', () => {
    expect(extrapolationEq({ before: 'Loop', after: 'Hold' }, { before: 'Loop', after: 'Hold' })).toBe(true)
    expect(extrapolationEq({ before: 'Loop', after: 'Hold' }, { before: 'Hold', after: 'Loop' })).toBe(false)
  })

  it('keyframeShapeEqExact ignores id and compares every other field exactly', () => {
    const a = key()
    expect(keyframeShapeEqExact(a, { ...a, id: 'other' })).toBe(true)
    expect(keyframeShapeEqExact(a, key({ t_us: 1_001 }))).toBe(false)
    expect(keyframeShapeEqExact(a, key({ value: 2.5000001 }))).toBe(false)
    expect(keyframeShapeEqExact(a, key({ in: freeSide(0.7, 1.2000001) }))).toBe(false)
    expect(keyframeShapeEqExact(a, key({ out: { x: 0.2, y: -0.1, mode: 'Free' } }))).toBe(false)
    expect(keyframeShapeEqExact(a, key({ continuity: 'Broken' }))).toBe(false)
    expect(keyframeShapeEqExact(a, key({ segment: { kind: 'Spline' } }))).toBe(false)
  })

  it('keyframeShapeEqExact takes a value comparator for non-scalar values', () => {
    const a: Keyframe<{ r: number }> = { ...key(), value: { r: 1 } }
    const b: Keyframe<{ r: number }> = { ...key(), value: { r: 1 } }
    expect(keyframeShapeEqExact(a, b)).toBe(false)
    expect(keyframeShapeEqExact(a, b, (x, y) => x.r === y.r)).toBe(true)
  })
})
