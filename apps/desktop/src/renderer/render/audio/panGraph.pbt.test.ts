// Twin-PBT: pins the TS coefficient-lerp outer loop (panCoeffsAt) to an
// independent reference re-derived from the spec in docs/audio.md. The Rust twin
// pan_coeffs_at is pinned to the SAME spec by a proptest in
// native/src/audio/envelope.rs — together they guarantee cross-language parity
// without an in-process bridge. The leaf law (panCoeff) is shared WASM and cannot
// drift, so only the outer loop is fuzzed here.
import { describe, it } from 'vitest'
import fc from 'fast-check'
import { panCoeffsAt } from './panGraph'
import { type Envelope } from './envelope'
import { panCoeff } from '../../eval'

const PBT_SEED = 0x5747_4354
const RUNS = Number(process.env.WEFTCUT_PBT_RUNS ?? 200)

// Control points sit at min(k * stepUs, spanUs): the last segment runs from the
// last grid point to the layer end, usually shorter than a step.
function reference(values: number[], stepUs: number, spanUs: number, channels: number, tUs: number): number[] {
  const coeff = (p: number) => [0, 1, 2, 3].map((k) => panCoeff(p, channels, k))
  const last = values.length - 1
  if (last <= 0) return coeff(values[0] ?? 0)
  if (tUs <= 0) return coeff(values[0]!)
  if (tUs >= spanUs) return coeff(values[last]!)
  const knot = (k: number) => Math.min(k * stepUs, spanUs)
  let i = 0
  while (knot(i + 1) <= tUs) i++
  const a = coeff(values[i]!), b = coeff(values[i + 1]!)
  const frac = (tUs - knot(i)) / (knot(i + 1) - knot(i))
  return a.map((av, k) => av + (b[k]! - av) * frac)
}

describe('twin-PBT: panCoeffsAt matches the independent reference', () => {
  it('agrees for all envelopes / channels / query times', () => {
    fc.assert(fc.property(
      // Distinct values: equal neighbours have no slope, so a wrong lerp
      // fraction between them cannot show (biased doubles repeat often).
      fc.uniqueArray(fc.integer({ min: -100, max: 100 }).map((v) => v / 100), { minLength: 1, maxLength: 8 }),
      fc.constantFrom(10_000, 20_000),
      fc.constantFrom(1, 2),
      // Query time as a fraction of the span, so it lands in every segment
      // (the short last one included) and before/after the ends. Fractional µs
      // exercise lerp fractions near 0/1, where interpolation-direction drift
      // would hide.
      fc.double({ min: -0.2, max: 1.2, noNaN: true }),
      // Length of the last segment in µs: layer ends rarely land on the grid.
      fc.integer({ min: 1, max: 20_000 }),
      (values, stepUs, channels, tFrac, lastUs) => {
        const spanUs = values.length < 2 ? 0 : stepUs * (values.length - 2) + Math.min(lastUs, stepUs)
        const tUs = tFrac * Math.max(spanUs, stepUs)
        const got = panCoeffsAt({ values, stepUs, spanUs } as Envelope, channels, tUs)
        const exp = reference(values, stepUs, spanUs, channels, tUs)
        for (let k = 0; k < 4; k++) if (Math.abs((got[k] ?? 0) - (exp[k] ?? 0)) > 1e-6) return false
        return true
      },
    ), { seed: PBT_SEED, numRuns: RUNS })
  })
})
