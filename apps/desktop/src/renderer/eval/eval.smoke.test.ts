import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  initEval,
  snapFrameRound,
  dbToLinear,
  roleAudible,
  loadTrack,
  evalTrack,
  MAX_KEYFRAMES,
} from './index'
import snap from '../snapFrameGolden.fixture.json'
import type { Segment } from '../../shared/keyframe'

/// A key with identity sides — what every non-Spline segment carries.
const key = (t_us: number, value: number, segment: Segment) => ({
  t_us,
  value,
  in: { x: 2 / 3, y: 2 / 3 },
  out: { x: 1 / 3, y: 1 / 3 },
  segment,
})

beforeAll(async () => {
  await initEval()
})

describe('eval wasm smoke', () => {
  it('snap matches the snap golden', () => {
    const fx = snap as {
      cases: { fps_num: number; fps_den: number; samples: { t_us: number; expect: number }[] }[]
    }
    for (const c of fx.cases)
      for (const s of c.samples) expect(snapFrameRound(s.t_us, c.fps_num, c.fps_den)).toBe(s.expect)
  })

  it('dbToLinear ~ 2.0 at +6.0206 dB, 1.0 at 0 dB', () => {
    expect(dbToLinear(6.0206)).toBeCloseTo(2.0, 4)
    expect(dbToLinear(0)).toBeCloseTo(1.0, 6)
  })

  it('role gate: mute wins over solo', () => {
    expect(roleAudible(true, true, true)).toBe(false)
    expect(roleAudible(false, false, true)).toBe(false)
    expect(roleAudible(false, true, true)).toBe(true)
  })

  it('evalTrack linear midpoint + hold', () => {
    loadTrack(1, [key(0, 0, { kind: 'Linear' }), key(1_000_000, 100, { kind: 'Linear' })])
    expect(evalTrack(500_000, 0)).toBeCloseTo(50, 6)
    loadTrack(2, [key(0, 3, { kind: 'Hold' }), key(1_000_000, 8, { kind: 'Hold' })])
    expect(evalTrack(500_000, 0)).toBeCloseTo(3, 6)
  })

  it('a Spline segment crosses the ABI through the tangent slots', () => {
    // CSS ease-in: out = (0.42, 0) on the left key, in = (1, 1) on the right —
    // the same value the animated golden pins at the half-way point.
    loadTrack(7, [
      { t_us: 0, value: 0, in: { x: 2 / 3, y: 2 / 3 }, out: { x: 0.42, y: 0 }, segment: { kind: 'Spline' } },
      { t_us: 1_000_000, value: 10, in: { x: 1, y: 1 }, out: { x: 1 / 3, y: 1 / 3 }, segment: { kind: 'Linear' } },
    ])
    expect(evalTrack(500_000, 0)).toBeCloseTo(3.153568, 5)
  })

  it('extrapolation codes ride on set_n, and a same-handle change re-issues only them', () => {
    const ramp = [key(0, 0, { kind: 'Linear' }), key(10_000_000, 10, { kind: 'Linear' })]
    loadTrack(8, ramp, { before: 'Loop', after: 'Offset' })
    expect(evalTrack(-2_000_000, 0)).toBeCloseTo(8, 9)
    expect(evalTrack(12_000_000, 0)).toBeCloseTo(12, 9)
    // Same handle, different codes: the keys stay resident, the clamp returns.
    loadTrack(8, ramp, { before: 'Hold', after: 'Hold' })
    expect(evalTrack(-2_000_000, 0)).toBe(0)
    expect(evalTrack(12_000_000, 0)).toBe(10)
    // Omitting the extrapolation means Hold/Hold.
    loadTrack(9, ramp)
    expect(evalTrack(12_000_000, 0)).toBe(10)
  })

  it('Elastic and Bounce cross the ABI on their explicit codes', () => {
    // Pinned closed-form values (independent CPython derivation, spec formulas).
    loadTrack(3, [
      key(0, 0, { kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 }),
      key(1_000_000, 10, { kind: 'Linear' }),
    ])
    expect(evalTrack(250_000, 0)).toBeCloseTo(9.116116523516816, 9)
    loadTrack(4, [key(0, 0, { kind: 'Bounce', dir: 'In' }), key(1_000_000, 10, { kind: 'Linear' })])
    expect(evalTrack(500_000, 0)).toBeCloseTo(2.34375, 9)
  })

  it('an unknown segment kind falls back to Linear — deliberate, no spline catch-all', () => {
    const assertSpy = vi.spyOn(console, 'assert').mockImplementation(() => {})
    loadTrack(5, [
      key(0, 0, { kind: 'Wobble' } as unknown as Segment),
      key(1_000_000, 10, { kind: 'Linear' }),
    ])
    expect(evalTrack(500_000, 0)).toBeCloseTo(5, 9)
    expect(assertSpy).toHaveBeenCalledWith(false, expect.stringContaining('unknown segment kind'), expect.anything())
    assertSpy.mockRestore()
  })

  it('truncates an over-capacity property to MAX_KEYFRAMES and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Linear 0..N-1 over 1ms steps; only the first MAX_KEYFRAMES are evaluated.
    const big = Array.from({ length: MAX_KEYFRAMES + 50 }, (_, i) => ({
      t_us: i * 1_000,
      value: i,
      in: { x: 2 / 3, y: 2 / 3, mode: 'Free' as const }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' as const }, continuity: 'Broken' as const, segment: { kind: 'Linear' as const },
    }))
    loadTrack(100, big) // first oversized upload → warns
    loadTrack(101, big) // second → no further warning (once per session)
    expect(warn).toHaveBeenCalledTimes(1)
    // Still evaluates without throwing (truncated to the first MAX_KEYFRAMES keys);
    // at/after the last RESIDENT key it clamps to that key's value (= cap - 1).
    expect(evalTrack(MAX_KEYFRAMES * 1_000, 0)).toBe(MAX_KEYFRAMES - 1)
    warn.mockRestore()
  })
})
