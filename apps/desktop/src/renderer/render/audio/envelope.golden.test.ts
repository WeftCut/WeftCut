// Cross-language golden vectors for the sampled envelope contract. The SAME
// fixture is asserted by `native/src/audio/envelope.rs`; a change that
// passes one side and fails the other is engine drift — exactly what this
// test exists to catch.

import { describe, expect, it } from "vitest";
import fixture from "./audioEnvelopeGolden.fixture.json";
import { ENVELOPE_STEP_US, type Envelope, evalEnvelope, sampleGain, samplePan } from "./envelope";
import type { AnimTrack } from "../animated";
import { panCoeffsAt } from "./panGraph";
import { SAMPLE_RATE } from "./chunkSchedule";
import { crossfadeGain, panCoeff } from "../../eval";

interface Case {
  name: string;
  gain_db: AnimTrack<number>;
  fade_in_us: number;
  fade_out_us: number;
  span_us: number;
  samples: { t_us: number; expect: number }[];
}

describe("audio envelope golden vectors (cross-language)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      const e: Envelope = sampleGain(
        c.gain_db,
        c.fade_in_us,
        c.fade_out_us,
        c.span_us,
      );
      for (const s of c.samples) {
        expect(evalEnvelope(e, s.t_us)).toBeCloseTo(s.expect, 5);
      }
    });
  }
});

interface PanCase {
  name: string;
  pan: AnimTrack<number>;
  span_us: number;
  samples: { t_us: number; expect: number }[];
}
interface CoeffCase {
  name: string;
  pan: AnimTrack<number>;
  channels: number;
  span_us: number;
  samples: { t_us: number; expect: number[] }[];
}

const fx = fixture as unknown as { pan_cases?: PanCase[]; pan_coeff_env_cases?: CoeffCase[] };

describe("audio pan golden vectors (cross-language)", () => {
  for (const c of fx.pan_cases ?? []) {
    it(`pan: ${c.name}`, () => {
      const e = samplePan(c.pan, c.span_us);
      for (const s of c.samples) expect(evalEnvelope(e, s.t_us)).toBeCloseTo(s.expect, 5);
    });
  }
  for (const c of fx.pan_coeff_env_cases ?? []) {
    it(`pan coeff env: ${c.name}`, () => {
      const e = samplePan(c.pan, c.span_us);
      for (const s of c.samples) {
        const got = panCoeffsAt(e, c.channels, s.t_us);
        for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(s.expect[i]!, 5);
      }
    });
  }
});

it("multiplies user gain and fades with equal-power transitions", () => {
  const e = sampleGain({ mode: "Static", value: 0 }, 1_000_000, 0, 2_000_000,
    [{ startUs: 0, durationUs: 1_000_000, incoming: true }]);
  expect(evalEnvelope(e, 500_000)).toBeCloseTo(0.5 * Math.SQRT1_2, 6);
});

// Layer edges sit on frames, so the span rarely lands on the 10 ms grid.
// [frame, span] at 60 and 30 fps, a frame rounded to the µs as edges are.
const offGridSpans = [60, 30].map((fps) => {
  const frame = Math.round(1_000_000 / fps);
  const span = frame * (fps + 1);
  if (span % ENVELOPE_STEP_US === 0) throw new Error(`span ${span} must end off the grid`);
  return [frame, span] as const;
});

describe("the last segment runs to the layer end, not a full step", () => {
  it("reproduces a linear fade through a short last segment", () => {
    // A whole-layer fade-out is linear in time, so lerping its control points
    // must give 1 - t/span everywhere, including past the last grid point.
    for (const [, span] of offGridSpans) {
      const e = sampleGain({ mode: "Static", value: 0 }, 0, span, span);
      const lastGrid = Math.floor(span / ENVELOPE_STEP_US) * ENVELOPE_STEP_US;
      for (const t of [0, lastGrid / 2, lastGrid, (lastGrid + span) / 2, span - 1, span]) {
        expect(evalEnvelope(e, t), `span ${span} t ${t}`).toBeCloseTo(1 - t / span, 9);
      }
      expect(evalEnvelope(e, span)).toBe(e.values.at(-1));
      expect(evalEnvelope(e, span + ENVELOPE_STEP_US / 2)).toBe(e.values.at(-1));
    }
  });

  it("keeps a one-frame crossfade's outgoing gain under the equal-power curve", () => {
    // Between control points the envelope is a chord of the outgoing cos arc,
    // which is concave on [0, 1], so the chord never rises above the curve. At
    // the last mixed sample the curve is ≈ 0: the outgoing layer must be
    // (almost) silent there, not cut off mid-fade.
    for (const [durationUs, span] of offGridSpans) {
      const startUs = span - durationUs;
      const e = sampleGain({ mode: "Static", value: 0 }, 0, 0, span, [
        { startUs, durationUs, incoming: false },
      ]);
      const t = span - 1_000_000 / SAMPLE_RATE;
      const progress = (t - startUs) / durationUs;
      const curve = crossfadeGain(progress, false);
      const got = evalEnvelope(e, t);
      expect(got, `span ${span} progress ${progress}`).toBeGreaterThanOrEqual(0);
      expect(got, `span ${span} progress ${progress}`).toBeLessThanOrEqual(curve + 1e-9);
    }
  });

  it("lerps pan coefficients over the short last segment", () => {
    for (const [, span] of offGridSpans) {
      const kf = (id: number, tUs: number, value: number) => ({
        id: `00000000-0000-7000-8000-00000000000${id}`,
        t_us: tUs,
        value,
        in: { x: 2 / 3, y: 2 / 3, mode: "Free" },
        out: { x: 1 / 3, y: 1 / 3, mode: "Free" },
        continuity: "Broken",
        segment: { kind: "Linear" },
      });
      const e = samplePan({
        mode: "Keyframed",
        value: [kf(1, 0, -1), kf(2, span, 1)],
        extrapolate: { before: "Hold", after: "Hold" },
      } as AnimTrack<number>, span);
      const n = e.values.length;
      const lastGrid = (n - 2) * ENVELOPE_STEP_US;
      const coeffs = (p: number) => [0, 1, 2, 3].map((k) => panCoeff(p, 2, k));
      const a = coeffs(e.values[n - 2]!), b = coeffs(e.values[n - 1]!);
      const mid = panCoeffsAt(e, 2, (lastGrid + span) / 2);
      const end = panCoeffsAt(e, 2, span);
      for (let k = 0; k < 4; k++) {
        expect(mid[k], `span ${span} idx ${k} midpoint`).toBeCloseTo((a[k]! + b[k]!) / 2, 9);
        expect(end[k], `span ${span} idx ${k} end`).toBeCloseTo(b[k]!, 9);
      }
    }
  });
});
