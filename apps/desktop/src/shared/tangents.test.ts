import { describe, expect, it } from 'vitest'
import { freeSide, inIdentity, outIdentity, type Keyframe, type Tangent } from './keyframe'
import { solveAutoTangents, tangentAt } from './tangents'

const S = 1_000_000
const key = (id: string, tUs: number, value: number, over: Partial<Keyframe<number>> = {}): Keyframe<number> => ({
  id, t_us: tUs, value,
  in: inIdentity(), out: outIdentity(), continuity: 'Broken', segment: { kind: 'Linear' },
  ...over,
})
const auto = (x: number, y: number): Tangent => ({ x, y, mode: 'Auto' })
/** A key marked the way `setAuto` marks it: both sides Auto, Smooth, Spline leaving. */
const autoKey = (id: string, tUs: number, value: number, last = false): Keyframe<number> =>
  key(id, tUs, value, {
    in: { ...inIdentity(), mode: 'Auto' }, out: { ...outIdentity(), mode: 'Auto' },
    continuity: 'Smooth', segment: { kind: last ? 'Linear' : 'Spline' },
  })
const identity = (v: number) => v

describe('tangentAt (monotone, clamped)', () => {
  const t = [0, S, 2 * S]
  it('is 0 at both endpoints', () => {
    expect(tangentAt([0, 1, 2], t, 0)).toBe(0)
    expect(tangentAt([0, 1, 2], t, 2)).toBe(0)
  })
  it('is the secant slope through the neighbours on a monotone run', () => {
    expect(tangentAt([0, 1, 2], t, 1)).toBe(2 / (2 * S))
    expect(tangentAt([0, 1, 4], t, 1)).toBe(4 / (2 * S))
  })
  it('is 0 at a local extremum or beside a flat step', () => {
    expect(tangentAt([0, 1, 0], t, 1)).toBe(0)
    expect(tangentAt([1, 0, 1], t, 1)).toBe(0)
    expect(tangentAt([0, 0, 1], t, 1)).toBe(0)
    expect(tangentAt([0, 1, 1], t, 1)).toBe(0)
  })
})

describe('solveAutoTangents', () => {
  it('Auto out / in reproduce the former Smooth numbers split across the two keys', () => {
    // 0 → 1 → 2 over 1 s steps; m = 2 / 2 s; out.y = m·dt/(3·dv) = 1/3, in.y = 1 − 1/3.
    const keys = [key('a', 0, 0, { segment: { kind: 'Spline' } }), autoKey('b', S, 1), key('c', 2 * S, 2)]
    const out = solveAutoTangents(keys, identity)
    expect(out[1]!.out.x).toBe(1 / 3)
    expect(out[1]!.out.y).toBeCloseTo(1 / 3, 9)
    expect(out[1]!.out.mode).toBe('Auto')
    expect(out[1]!.in.x).toBe(2 / 3)
    expect(out[1]!.in.y).toBeCloseTo(2 / 3, 9)
    expect(out[1]!.in.mode).toBe('Auto')
    expect(out[0]).toBe(keys[0])
    expect(out[2]).toBe(keys[2])
  })

  it('an Auto key at a peak is a flat extremum: out.y = 0, in.y = 1', () => {
    const keys = [key('a', 0, 0, { segment: { kind: 'Spline' } }), autoKey('b', S, 1), key('c', 2 * S, 0)]
    const out = solveAutoTangents(keys, identity)
    // m·dt/(3·dv) with m = 0 over a falling segment is IEEE −0: equal to 0 for
    // every consumer (=== and JSON alike), so compare the magnitude.
    expect(out[1]!.out.x).toBe(1 / 3)
    expect(Math.abs(out[1]!.out.y)).toBe(0)
    expect(out[1]!.out.mode).toBe('Auto')
    expect(out[1]!.in).toEqual(auto(2 / 3, 1))
  })

  it('endpoint Auto keys get m = 0 (out.y = 0 on the first, in.y = 1 on the last)', () => {
    const keys = [autoKey('a', 0, 0), autoKey('b', S, 1), autoKey('c', 2 * S, 0, true)]
    const out = solveAutoTangents(keys, identity)
    expect(out[0]!.out).toEqual(auto(1 / 3, 0))
    expect(out[0]!.in).toEqual({ ...inIdentity(), mode: 'Auto' }) // no segment arrives: untouched
    expect(out[2]!.in).toEqual(auto(2 / 3, 1))
    expect(out[2]!.out).toEqual({ ...outIdentity(), mode: 'Auto' }) // no segment leaves: untouched
  })

  it('a degenerate segment (Δv = 0 or Δt ≤ 0) sends the Auto side to the identity, mode kept', () => {
    const flat = [autoKey('a', 0, 5), key('b', S, 5)]
    const out = solveAutoTangents(flat, identity)
    expect(out[0]!.out).toEqual({ x: 1 / 3, y: 1 / 3, mode: 'Auto' })
    const stacked = [key('a', 0, 0, { segment: { kind: 'Spline' } }), autoKey('b', 0, 1), key('c', S, 2)]
    expect(solveAutoTangents(stacked, identity)[1]!.in).toEqual({ x: 2 / 3, y: 2 / 3, mode: 'Auto' })
  })

  it('with no scalar, Auto sides resolve to the identity coords and Smooth is skipped', () => {
    const keys = [key('a', 0, 0, { segment: { kind: 'Spline' } }), autoKey('b', S, 1), key('c', 2 * S, 2)]
    const out = solveAutoTangents(keys, null)
    expect(out[1]!.out).toEqual({ x: 1 / 3, y: 1 / 3, mode: 'Auto' })
    expect(out[1]!.in).toEqual({ x: 2 / 3, y: 2 / 3, mode: 'Auto' })
    const smooth = [
      key('a', 0, 0, { out: freeSide(0, 0), segment: { kind: 'Spline' } }),
      key('b', S, 1, { in: freeSide(2 / 3, 0), continuity: 'Smooth', segment: { kind: 'Spline' } }),
      key('c', 2 * S, 2),
    ]
    expect(solveAutoTangents(smooth, null)[1]).toBe(smooth[1])
  })

  it('leaves an Auto side next to a non-Spline segment untouched (the engine ignores it)', () => {
    const keys = [
      key('a', 0, 0, { out: auto(0.9, 0.1), segment: { kind: 'Hold' } }),
      key('b', S, 1, { in: auto(0.1, 0.9) }),
    ]
    const out = solveAutoTangents(keys, identity)
    expect(out[0]).toBe(keys[0])
    expect(out[1]).toBe(keys[1])
  })

  it('Smooth with two Free sides: out wins and the in-handle is re-aimed, keeping in.x', () => {
    // out = (1/3, 1/3) on 0→1 over 1 s → slope 1 per s; in.y = 1 − 1·(1 − 2/3)·1/1 = 2/3.
    const keys = [
      key('a', 0, 0, { out: freeSide(0, 0), segment: { kind: 'Spline' } }),
      key('b', S, 1, { in: freeSide(2 / 3, 0), continuity: 'Smooth', segment: { kind: 'Spline' } }),
      key('c', 2 * S, 2),
    ]
    const out = solveAutoTangents(keys, identity)
    expect(out[1]!.in.x).toBe(2 / 3)
    expect(out[1]!.in.y).toBeCloseTo(2 / 3, 12)
    expect(out[1]!.in.mode).toBe('Free')
    expect(out[1]!.out).toBe(keys[1]!.out)
  })

  it('Smooth leaves the in-handle alone when out.x is 0, in.x is 1, or the arriving segment is degenerate', () => {
    const mk = (over: Partial<Keyframe<number>>, prevValue = 0) => [
      key('a', 0, prevValue, { segment: { kind: 'Spline' } }),
      key('b', S, 1, { in: freeSide(0.5, 0.2), continuity: 'Smooth', segment: { kind: 'Spline' }, ...over }),
      key('c', 2 * S, 2),
    ]
    expect(solveAutoTangents(mk({ out: freeSide(0, 0.5) }), identity)[1]!.in).toEqual(freeSide(0.5, 0.2))
    expect(solveAutoTangents(mk({ in: freeSide(1, 0.2) }), identity)[1]!.in).toEqual(freeSide(1, 0.2))
    expect(solveAutoTangents(mk({}, 1), identity)[1]!.in).toEqual(freeSide(0.5, 0.2)) // dvPrev = 0
  })

  it('Smooth does not fire when either side is Auto or either segment is not Spline', () => {
    const autoIn = [
      key('a', 0, 0, { segment: { kind: 'Spline' } }),
      key('b', S, 1, { in: auto(0.5, 0.2), continuity: 'Smooth', segment: { kind: 'Hold' } }),
      key('c', 2 * S, 2),
    ]
    const out = solveAutoTangents(autoIn, identity)
    // Auto in solved on the arriving Spline; Hold leaving → no Smooth rule.
    expect(out[1]!.in.x).toBe(2 / 3)
    expect(out[1]!.in.y).toBeCloseTo(2 / 3, 9)
    expect(out[1]!.in.mode).toBe('Auto')
  })

  it('returns the same object for keys whose sides did not change', () => {
    const keys = [key('a', 0, 0), key('b', S, 1)]
    const out = solveAutoTangents(keys, identity)
    expect(out).not.toBe(keys)
    expect(out[0]).toBe(keys[0])
    expect(out[1]).toBe(keys[1])
  })
})
