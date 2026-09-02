import { describe, it, expect } from 'vitest'
import { isCommandFailure } from './errors'
import type { Animated } from './model'
import { authoredExtentPx, authoredValue, quantizeEffectTrack, quantizeTrack } from './quantize'
import { TRANSFORM_F64_KEYS } from './mutations/params'
// Reaching across into the renderer is the POINT of the two gates below: the
// precision table and the readout formatter have to agree, and only a test that
// sees both can prove it. `descriptors.ts` is pure data with type-only imports,
// so it pulls no DOM into the main-process test realm — the same argument
// `params.test.ts` makes for importing `animatableParams`.
import {
  EFFECT_PARAM_DECIMALS,
  PARAM_PRECISION,
  formatParam,
  paramDecimals,
  quantize,
  quantizeParam,
} from '../../renderer/keyframe/descriptors'

function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

/** Values chosen to hit every rounding edge at once: an exact tie on both signs,
 *  a value whose scaled product is not exactly representable, a legacy dirty
 *  value of the kind `w * 0.08` produces, and zero from each side. */
const ADVERSARIAL = [
  0, -0, 1, -1, 0.5, -0.5, 0.05, -0.05, 0.145, -0.145,
  993.5999999999999, 10.373737373737374, 1612.7999999999999,
  0.1 + 0.2, 1 / 3, -1 / 3, 1e-9, -1e-9, 1920, -1920,
]

describe('quantize', () => {
  it('records to the requested number of decimal places', () => {
    expect(quantize(993.5999999999999, 1)).toBe(993.6)
    expect(quantize(10.373737373737374, 1)).toBe(10.4)
    expect(quantize(1612.7999999999999, 0)).toBe(1613)
    expect(quantize(1.0004, 3)).toBe(1)
  })

  it('keeps a half-pixel expressible at d=1 — the reason x/y can never be integers', () => {
    // `compW / 2` on an odd-width composition, which is both a snap line and
    // where `centerInFrame` lands a layer. At d=0 centring would miss the centre.
    expect(quantize(960.5, 1)).toBe(960.5)
  })

  it('breaks ties away from zero, matching Intl and Rust rather than Math.round', () => {
    expect(quantize(0.05, 1)).toBe(0.1)
    expect(quantize(-0.05, 1)).toBe(-0.1) // Math.round would give -0
    expect(quantize(-1.5, 0)).toBe(-2)
  })

  it('normalizes negative zero, which would otherwise reach the project file', () => {
    expect(Object.is(quantize(-0.04, 1), 0)).toBe(true)
    expect(Object.is(quantize(-0, 1), 0)).toBe(true)
  })

  it('passes non-finite through — that is a refusal, not a rounding', () => {
    expect(quantize(NaN, 1)).toBeNaN()
    expect(quantize(Infinity, 1)).toBe(Infinity)
  })

  it('is idempotent, so re-writing an unchanged value cannot drift', () => {
    for (const v of ADVERSARIAL) {
      for (const d of [0, 1, 3, 4]) {
        expect(quantize(quantize(v, d), d)).toBe(quantize(v, d))
      }
    }
  })
})

// ── GATE 1 ────────────────────────────────────────────────────────────────
// Every f64 param the mutation layer can write has a declared precision. The
// authority for "every" is `TRANSFORM_F64_KEYS` plus the three keys `f64Lens`
// resolves outside the transform, so adding an eighth transform track without a
// `d` fails here rather than silently inheriting the effect-param fallback.
describe('precision table covers every writable f64 param', () => {
  const EXPECTED = new Set([...TRANSFORM_F64_KEYS, 'opacity', 'gain_db', 'pan'])

  it('declares exactly the keys f64Lens resolves — no gaps, no strays', () => {
    expect(new Set(Object.keys(PARAM_PRECISION))).toEqual(EXPECTED)
  })

  it('gives every key a non-negative integer place count', () => {
    for (const [key, spec] of Object.entries(PARAM_PRECISION)) {
      expect(Number.isInteger(spec.d), `${key}.d`).toBe(true)
      expect(spec.d, `${key}.d`).toBeGreaterThanOrEqual(0)
    }
  })

  it('gives every declared range a quantizable, correctly ordered pair', () => {
    for (const [key, spec] of Object.entries(PARAM_PRECISION)) {
      if (!spec.range) continue
      const [lo, hi] = spec.range
      expect(lo, `${key} range order`).toBeLessThan(hi)
      // A bound the field cannot express would refuse values that round onto it.
      expect(quantize(lo, spec.d), `${key} lo`).toBe(lo)
      expect(quantize(hi, spec.d), `${key} hi`).toBe(hi)
    }
  })

  it('falls back to the effect precision for an effect-param path', () => {
    expect(paramDecimals('effects[abc].params[feather]')).toBe(EFFECT_PARAM_DECIMALS)
  })
})

// ── GATE 2 ────────────────────────────────────────────────────────────────
// The readout and the stored value are the same number. This is the invariant
// that makes an untouched field safe to press Enter on: the widget renders
// `format(stored)` and commits `Number(...)` of what it rendered, so if that
// round trip is not exact, confirming a value nobody edited rewrites it and logs
// an undo entry. It used to: the field formatted at Intl's default 3 digits while
// the store kept a full f64.
describe('readout round-trips to the stored value', () => {
  const keys = Object.keys(PARAM_PRECISION)

  it('parses a formatted quantized value back to itself, for every key', () => {
    for (const key of keys) {
      for (const v of ADVERSARIAL) {
        const stored = quantizeParam(key, v)
        expect(Number(formatParam(key, stored)), `${key} @ ${v}`).toBe(stored)
      }
    }
  })

  it('parses a formatted LEGACY dirty value back to its quantized form', () => {
    // Old projects are not migrated (quantization is an entry filter, not an
    // invariant), so a stored 993.5999999999999 survives until touched. Pressing
    // Enter on it must land on the value the table would have stored, never a
    // third number.
    for (const key of keys) {
      for (const v of ADVERSARIAL) {
        expect(Number(formatParam(key, v)), `${key} @ ${v}`).toBe(quantizeParam(key, v))
      }
    }
  })

  it('never renders a grouped thousand — a position is not 1,920', () => {
    expect(formatParam('x', 1920)).toBe('1920')
  })

  it('never renders a negative zero', () => {
    expect(formatParam('x', -0)).toBe('0')
    expect(formatParam('pan', -0.0001)).toBe('0')
  })
})

describe('authoredValue', () => {
  it('quantizes BEFORE the range check, so a value that rounds into range passes', () => {
    // An agent computing `1 - 4e-4` arrives at 1.0004 honestly; refusing it for
    // overshooting by less than the field can record would be hostile.
    expect(authoredValue('opacity', 1.0004)).toBe(1)
    expect(authoredValue('pan', -1.0004)).toBe(-1)
  })

  it('refuses a value that is still out of range once recorded', () => {
    expectCmd(() => authoredValue('opacity', 1.5), 'InvalidArgument')
    expectCmd(() => authoredValue('opacity', -0.01), 'InvalidArgument')
    expectCmd(() => authoredValue('pan', 2), 'InvalidArgument')
  })

  it('names the recorded value in the refusal — an agent has no other channel', () => {
    // Claude Code drops `error.data`, so everything actionable has to ride the
    // message text. A bare "out of range" would not tell an agent what it sent or
    // that nothing was clamped on its behalf.
    try {
      authoredValue('opacity', 1.5)
      throw new Error('expected a refusal')
    } catch (e) {
      if (!isCommandFailure(e) || e.err.error !== 'InvalidArgument') throw e
      expect(e.err.detail).toContain('1.5')
      expect(e.err.detail).toContain('not clamped')
    }
  })

  it('refuses non-finite on an UNBOUNDED key too — a NaN x is a vanished layer', () => {
    expectCmd(() => authoredValue('x', NaN), 'InvalidArgument')
    expectCmd(() => authoredValue('rotation_deg', Infinity), 'InvalidArgument')
  })

  it('leaves an unbounded key unbounded — off-screen and mirrored are legitimate', () => {
    expect(authoredValue('x', -5000)).toBe(-5000)
    expect(authoredValue('scale_x', -2)).toBe(-2)
    expect(authoredValue('rotation_deg', 3600)).toBe(3600)
    expect(authoredValue('anchor_x', 4)).toBe(4)
  })
})

describe('quantizeTrack', () => {
  it('quantizes a Static track in place', () => {
    const t: Animated<number> = { mode: 'Static', value: 10.373737373737374 }
    quantizeTrack('x', t)
    expect(t).toEqual({ mode: 'Static', value: 10.4 })
  })

  it('quantizes EVERY keyframe, not just the first', () => {
    const t: Animated<number> = { mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' }, value: [
      { id: 'a', t_us: 0, value: 10.373737, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } },
      { id: 'b', t_us: 1000, value: 20.982, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } },
    ] }
    quantizeTrack('x', t)
    expect((t.value as Array<{ value: number }>).map((k) => k.value)).toEqual([10.4, 21])
  })

  it('refuses when ANY keyframe is out of range — a track is not partly valid', () => {
    const t: Animated<number> = { mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' }, value: [
      { id: 'a', t_us: 0, value: 0.5, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } },
      { id: 'b', t_us: 1000, value: 1.5, in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } },
    ] }
    expectCmd(() => quantizeTrack('opacity', t), 'InvalidArgument')
  })

  it('quantizes an unrecognized key at the effect fallback and never refuses it', () => {
    // An unknown key reaches here before `f64Lens` has had its say; the fallback
    // carries no range, so the refusal it deserves (UnknownKeyframeParam) is
    // still the one it gets.
    const t: Animated<number> = { mode: 'Static', value: 0.12345678 }
    quantizeTrack('effects[e1].params[feather]', t)
    expect(t).toEqual({ mode: 'Static', value: 0.123 })
  })
})

describe('authoredExtentPx', () => {
  it('rounds an extent to whole pixels', () => {
    expect(authoredExtentPx('width', 1612.8)).toBe(1613)
    expect(authoredExtentPx('box_w', 640.4)).toBe(640)
  })

  it('refuses a positive value that ROUNDS AWAY to zero', () => {
    // The whole reason the check follows the rounding: 0.4 passes any raw `> 0`
    // test and then records as the zero extent that test exists to refuse.
    expectCmd(() => authoredExtentPx('width', 0.4), 'InvalidArgument')
    expectCmd(() => authoredExtentPx('box_w', 0), 'InvalidArgument')
    expectCmd(() => authoredExtentPx('height', -5), 'InvalidArgument')
    expectCmd(() => authoredExtentPx('width', NaN), 'InvalidArgument')
  })

  it('names both the sent and the recorded value, and carries the field hint', () => {
    try {
      authoredExtentPx('box_w', 0.4, ', or null for auto')
      throw new Error('expected a refusal')
    } catch (e) {
      if (!isCommandFailure(e) || e.err.error !== 'InvalidArgument') throw e
      expect(e.err.detail).toContain('0.4')
      expect(e.err.detail).toContain('records as 0')
      // Without the escape hatch spelled out, an agent cannot tell that dropping
      // the fixed width is even an option.
      expect(e.err.detail).toContain('null for auto')
    }
  })

  it('omits the hint where there is no escape — a Color layer has no auto size', () => {
    try {
      authoredExtentPx('width', 0)
      throw new Error('expected a refusal')
    } catch (e) {
      if (!isCommandFailure(e) || e.err.error !== 'InvalidArgument') throw e
      expect(e.err.detail).not.toContain('null')
    }
  })
})

describe('quantizeEffectTrack', () => {
  it('uses the effect precision even for a name that shadows a layer param', () => {
    // An effect is free to call a param `opacity` with a [0,100] range of its own.
    // Going through the param-key table would hand it the layer param's [0,1].
    const t: Animated<number> = { mode: 'Static', value: 55.55555 }
    quantizeEffectTrack(t)
    expect(t).toEqual({ mode: 'Static', value: 55.556 })
  })
})
