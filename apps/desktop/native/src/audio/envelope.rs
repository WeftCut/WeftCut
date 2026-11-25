//! Sampled envelope contract — docs/audio.md §The envelope contract.
//!
//! `sample_gain` composes Animated gain_db (collected once via `eval_kfs` and
//! evaluated through `weftcut_eval::eval_f64_ext` with the track's stored
//! extrapolation) with the layer's linear fade ramps, on a 10 ms grid closed
//! at the layer end, in LINEAR gain (10^(dB/20)). Both renderers
//! linearly interpolate between the same points: Web Audio
//! `setValueCurveAtTime` on the TS side, `Envelope::eval` per sample on this
//! side. The TS twin is `apps/desktop/src/renderer/render/audio/envelope.ts`;
//! the shared fixture is `audioEnvelopeGolden.fixture.json` — keep all three in
//! lockstep.

use crate::state::animated::Animated;

pub const ENVELOPE_STEP_US: i64 = 10_000; // 10 ms grid

/// Control points on the implicit grid: `values[k]` sits at
/// `t = min(k * step_us, span_us)`, so the last segment is usually shorter than
/// a step. len()==1 ⇔ effectively static.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub step_us: i64,
    pub span_us: i64,
    pub values: Vec<f32>,
}

impl Envelope {
    pub fn constant(v: f32, span_us: i64) -> Self {
        Self {
            step_us: ENVELOPE_STEP_US,
            span_us,
            values: vec![v],
        }
    }

    pub fn is_constant(&self) -> bool {
        self.values.len() == 1
    }

    /// Linear interpolation between grid points, clamped at the ends.
    /// `t_us` is layer-local.
    pub fn eval(&self, t_us: i64) -> f32 {
        match self.values.len() {
            0 => 1.0,
            1 => self.values[0],
            _ => {
                let (i, j, u) = self.locate(t_us);
                let (a, b) = (self.values[i], self.values[j]);
                a + (b - a) * u
            }
        }
    }

    /// The control points straddling layer-local `t_us` and the fraction
    /// between them; both indices name the same point outside the span. The
    /// last segment is interpolated over its real length, not a full step, or
    /// a fade ending on a frame edge stops short of its end value there.
    /// Twin of `envelopeSegment` in render/audio/envelope.ts. Needs two or
    /// more points.
    fn locate(&self, t_us: i64) -> (usize, usize, f32) {
        let last = self.values.len() - 1;
        if t_us <= 0 {
            return (0, 0, 0.0);
        }
        if t_us >= self.span_us {
            return (last, last, 0.0);
        }
        let i = ((t_us / self.step_us) as usize).min(last - 1);
        let start = i as i64 * self.step_us;
        let len = if i + 1 == last {
            self.span_us - start
        } else {
            self.step_us
        };
        let u = ((t_us - start) as f64 / len.max(1) as f64).min(1.0) as f32;
        (i, i + 1, u)
    }

    /// Multiply every control point by `factor`. Used to fold a role's
    /// linear gain into a layer's gain envelope (v1 role-bus realization).
    pub fn scale(&mut self, factor: f32) {
        for v in self.values.iter_mut() {
            *v *= factor;
        }
    }
}

// dB→linear and the fade ramp live in the weftcut-eval leaf (shared with the
// renderer's audio preview via wasm). Re-exported so `crate::audio::envelope`
// callers and the golden tests keep resolving against one source.
pub use weftcut_eval::db_to_linear;

pub use weftcut_eval::fade_multiplier;

/// Gain envelope for one audio layer: linear(gain_db at t) × fades.
/// Static gain + no fades short-circuits to a single point.
pub fn sample_gain(
    gain_db: &Animated<f64>,
    fade_in_us: i64,
    fade_out_us: i64,
    span_us: i64,
) -> Envelope {
    let animated = gain_db.is_animated();
    if !animated && fade_in_us == 0 && fade_out_us == 0 {
        return Envelope::constant(db_to_linear(gain_db.value_at(0, 0.0)), span_us);
    }
    // Collect keyframes ONCE (not per sample): the per-sample `value_at` would
    // re-materialize the Kf slice on every 10 ms step. `static_v` short-circuits
    // the Static case (empty kfs ⇒ eval_f64 would return the default, not v).
    let kfs = gain_db.eval_kfs();
    let ex = gain_db.extrapolation();
    let static_v = if let Animated::Static(v) = gain_db {
        Some(*v)
    } else {
        None
    };
    let base = |t: i64| -> f64 {
        match static_v {
            Some(v) => v,
            None => weftcut_eval::eval_f64_ext(&kfs, ex, t, 0.0),
        }
    };
    let mut values = Vec::with_capacity((span_us / ENVELOPE_STEP_US) as usize + 2);
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        let g = db_to_linear(base(t)) * fade_multiplier(t, span_us, fade_in_us, fade_out_us) as f32;
        values.push(g);
        if t >= span_us {
            break;
        }
        k += 1;
    }
    Envelope {
        step_us: ENVELOPE_STEP_US,
        span_us,
        values,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AudioCrossfade {
    pub start_us: i64,
    pub duration_us: i64,
    pub incoming: bool,
}

pub fn crossfades_for_layer(
    comp: &crate::state::Composition,
    layer: &crate::state::layer::Layer,
) -> Vec<AudioCrossfade> {
    comp.transitions
        .iter()
        .filter_map(|transition| {
            if transition.from_layer != layer.id && transition.to_layer != layer.id {
                return None;
            }
            let (from, to) = comp.tracks.iter().find_map(|track| {
                let from = track
                    .layers
                    .iter()
                    .find(|candidate| candidate.id == transition.from_layer)?;
                let to = track
                    .layers
                    .iter()
                    .find(|candidate| candidate.id == transition.to_layer)?;
                Some((from, to))
            })?;
            if !matches!(
                transition.kind,
                crate::state::transition::TransitionKind::Crossfade
            ) || !matches!(from.params, crate::state::layer::LayerParams::Audio(_))
                || !matches!(to.params, crate::state::layer::LayerParams::Audio(_))
                || transition.duration_us <= 0
            {
                return None;
            }
            Some(AudioCrossfade {
                start_us: to.t_start_us - layer.t_start_us,
                duration_us: transition.duration_us,
                incoming: transition.to_layer == layer.id,
            })
        })
        .collect()
}

pub fn apply_crossfades(envelope: &mut Envelope, fades: &[AudioCrossfade]) {
    if fades.is_empty() {
        return;
    }
    let mut values = Vec::new();
    let mut k = 0;
    loop {
        let t = (k * envelope.step_us).min(envelope.span_us);
        let mut gain = envelope.eval(t);
        for fade in fades {
            let progress = (t - fade.start_us) as f64 / fade.duration_us as f64;
            let (outgoing, incoming) = weftcut_eval::equal_power_crossfade(progress);
            gain *= if fade.incoming { incoming } else { outgoing } as f32;
        }
        values.push(gain);
        if t >= envelope.span_us {
            break;
        }
        k += 1;
    }
    envelope.values = values;
}

/// Pan envelope: plain sampling of Animated pan, clamped to [-1, 1].
pub fn sample_pan(pan: &Animated<f64>, span_us: i64) -> Envelope {
    if !pan.is_animated() {
        return Envelope::constant(pan.value_at(0, 0.0).clamp(-1.0, 1.0) as f32, span_us);
    }
    // Animated ⇒ Keyframed with ≥2 keys, so collect once and eval the slice
    // directly (no Static case to special-case here).
    let kfs = pan.eval_kfs();
    let ex = pan.extrapolation();
    let mut values = Vec::new();
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        values.push(weftcut_eval::eval_f64_ext(&kfs, ex, t, 0.0).clamp(-1.0, 1.0) as f32);
        if t >= span_us {
            break;
        }
        k += 1;
    }
    Envelope {
        step_us: ENVELOPE_STEP_US,
        span_us,
        values,
    }
}

/// Lerped equal-power pan coefficients `[a,b,c,d]` at layer-local `t_us`, off a
/// pan-VALUE envelope. Computes `pan_coeffs` at the two grid points straddling
/// `t_us` (from the un-lerped grid values) and lerps the coefficients — the X
/// parity contract: both export and the preview matrix mixer lerp COEFFICIENTS,
/// not the pan value. Mirrors `render/audio/panGraph.ts::panCoeffsAt`.
pub fn pan_coeffs_at(pan: &Envelope, channels: i32, t_us: i64) -> [f32; 4] {
    use weftcut_eval::pan_coeffs;
    if pan.values.len() <= 1 {
        return pan_coeffs(*pan.values.first().unwrap_or(&0.0) as f64, channels);
    }
    let (i, j, u) = pan.locate(t_us);
    let a = pan_coeffs(pan.values[i] as f64, channels);
    if i == j {
        return a;
    }
    let b = pan_coeffs(pan.values[j] as f64, channels);
    [
        a[0] + (b[0] - a[0]) * u,
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
        a[3] + (b[3] - a[3]) * u,
    ]
}

/// Property-based twin test: pins `pan_coeffs_at` to the same spec as the TS
/// twin `panCoeffsAt` (render/audio/panGraph.ts). The reference is derived
/// independently — it must NOT call `pan_coeffs_at` itself.
#[cfg(test)]
mod pbt {
    use super::*;
    use proptest::prelude::*;
    use proptest::sample::select;

    proptest! {
        #[test]
        fn pan_coeffs_at_matches_reference(
            values in proptest::collection::vec(-1.0f64..=1.0, 1usize..8),
            step_us in select(vec![10_000i64, 20_000]),
            channels in select(vec![1i32, 2]),
            // Query time as a fraction of the span, so it lands in every
            // segment (the short last one included) and before/after the ends.
            t_frac in -0.2f64..1.2,
            // Length of the last segment: layer ends rarely land on the grid.
            last_us in 1i64..=20_000,
        ) {
            // Build an Envelope directly from the generated grid — same shape
            // that sample_pan produces (values already clamped f64→f32).
            let span_us = if values.len() < 2 {
                0
            } else {
                (values.len() as i64 - 2) * step_us + last_us.min(step_us)
            };
            let t_us = (t_frac * span_us.max(step_us) as f64).round() as i64;
            let env = Envelope {
                step_us,
                span_us,
                values: values.iter().map(|&v| v as f32).collect(),
            };

            let got = pan_coeffs_at(&env, channels, t_us);

            // --- Independent reference (mirrors the TS reference exactly) ---
            // coeff(idx) reads the SAME f32-rounded grid value production reads
            // from `env.values` (production round-trips f64→f32→f64), so the
            // comparison is on identical inputs — not the raw proptest f64 vec.
            // The outer loop (index/clamp/lerp) is still derived independently.
            let coeff = |idx: usize| weftcut_eval::pan_coeffs(env.values[idx] as f64, channels);
            // Control points sit at min(k * step_us, span_us); find the
            // segment by walking the knots rather than dividing by the step.
            let last = values.len() - 1;
            let knot = |k: usize| (k as i64 * step_us).min(span_us);
            let exp: [f32; 4] = if last == 0 || t_us <= 0 {
                coeff(0)
            } else if t_us >= span_us {
                coeff(last)
            } else {
                let mut i = 0;
                while knot(i + 1) <= t_us {
                    i += 1;
                }
                let frac = ((t_us - knot(i)) as f64 / (knot(i + 1) - knot(i)) as f64) as f32;
                let a = coeff(i);
                let b = coeff(i + 1);
                [
                    a[0] + (b[0] - a[0]) * frac,
                    a[1] + (b[1] - a[1]) * frac,
                    a[2] + (b[2] - a[2]) * frac,
                    a[3] + (b[3] - a[3]) * frac,
                ]
            };

            for k in 0..4 {
                prop_assert!(
                    (got[k] - exp[k]).abs() < 1e-6,
                    "k={} got={} exp={} (t_us={} step_us={} span_us={} channels={} values={:?})",
                    k, got[k], exp[k], t_us, step_us, span_us, channels, values
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::animated::{Animated, Continuity, Extrapolation, Keyframe, Segment, Tangent};
    use crate::state::ids::new_id;

    #[test]
    fn crossfade_multiplies_user_fades() {
        let mut gain = sample_gain(&Animated::Static(0.0), 1_000_000, 0, 2_000_000);
        apply_crossfades(
            &mut gain,
            &[AudioCrossfade {
                start_us: 0,
                duration_us: 1_000_000,
                incoming: true,
            }],
        );
        assert!((gain.eval(500_000) - 0.5 * std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    }

    fn kf(t_us: i64, value: f64) -> Keyframe<f64> {
        Keyframe {
            time_fraction: None,
            id: new_id(),
            t_us,
            value,
            in_: Tangent::in_identity(),
            out: Tangent::out_identity(),
            continuity: Continuity::Broken,
            segment: Segment::Linear,
        }
    }

    #[test]
    fn scale_multiplies_every_point() {
        let mut e = sample_gain(&Animated::Static(0.0), 0, 0, 1_000_000); // unity, 1 point
        e.scale(0.5);
        assert!((e.eval(0) - 0.5).abs() < 1e-6);
        let mut k = sample_gain(&Animated::Static(0.0), 1_000_000, 0, 1_000_000); // fade-in ramp
        k.scale(2.0);
        assert!((k.eval(1_000_000) - 2.0).abs() < 1e-3);
    }

    #[test]
    fn static_no_fades_is_single_point() {
        let e = sample_gain(&Animated::Static(-6.0), 0, 0, 10_000_000);
        assert!(e.is_constant());
        assert!((e.values[0] - db_to_linear(-6.0)).abs() < 1e-6);
        assert!((e.eval(0) - e.eval(9_999_999)).abs() < 1e-9);
    }

    #[test]
    fn zero_db_is_unity() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-9);
        assert!((db_to_linear(-20.0) - 0.1).abs() < 1e-6);
    }

    #[test]
    fn fade_in_ramps_linearly() {
        // 0 dB gain, 1 s fade-in over a 10 s layer.
        let e = sample_gain(&Animated::Static(0.0), 1_000_000, 0, 10_000_000);
        assert!((e.eval(0) - 0.0).abs() < 1e-6);
        assert!((e.eval(500_000) - 0.5).abs() < 1e-3);
        assert!((e.eval(1_000_000) - 1.0).abs() < 1e-3);
        assert!((e.eval(5_000_000) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fade_out_ramps_to_zero_at_end() {
        let e = sample_gain(&Animated::Static(0.0), 0, 1_000_000, 10_000_000);
        assert!((e.eval(9_000_000) - 1.0).abs() < 1e-3);
        assert!((e.eval(9_500_000) - 0.5).abs() < 1e-3);
        assert!((e.eval(10_000_000) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn keyframed_gain_samples_the_engine_curve() {
        // -20 dB → 0 dB linear over 1 s: midpoint is -10 dB in dB-space,
        // sampled then linearized.
        let track = Animated::Keyframed(
            vec![kf(0, -20.0), kf(1_000_000, 0.0)].into_iter().collect(),
            Extrapolation::HOLD,
        );
        let e = sample_gain(&track, 0, 0, 1_000_000);
        assert!(!e.is_constant());
        assert!((e.eval(500_000) - db_to_linear(-10.0)).abs() < 2e-3);
    }

    /// Layer edges sit on frames, so the span rarely lands on the 10 ms grid.
    /// `(frame, span)` at 60 and 30 fps, a frame rounded to the µs as edges are.
    fn off_grid_spans() -> Vec<(i64, i64)> {
        [60i64, 30]
            .iter()
            .map(|fps| {
                let frame = (1_000_000 + fps / 2) / fps;
                let span = frame * (fps + 1);
                assert_ne!(
                    span % ENVELOPE_STEP_US,
                    0,
                    "span {span} must end off the grid"
                );
                (frame, span)
            })
            .collect()
    }

    #[test]
    fn linear_fade_is_reproduced_through_a_short_last_segment() {
        // A whole-layer fade-out is linear in time, so lerping its control
        // points must give 1 - t/span everywhere, including between the last
        // grid point and the layer end.
        for (_, span) in off_grid_spans() {
            let e = sample_gain(&Animated::Static(0.0), 0, span, span);
            let last_grid = (span / ENVELOPE_STEP_US) * ENVELOPE_STEP_US;
            for t in [
                0,
                last_grid / 2,
                last_grid,
                (last_grid + span) / 2,
                span - 1,
                span,
            ] {
                let expect = 1.0 - t as f32 / span as f32;
                assert!(
                    (e.eval(t) - expect).abs() < 1e-5,
                    "span {span} t {t}: got {}, expect {expect}",
                    e.eval(t)
                );
            }
            assert_eq!(
                e.eval(span),
                *e.values.last().unwrap(),
                "end reaches the last point"
            );
            assert_eq!(
                e.eval(span + ENVELOPE_STEP_US / 2),
                *e.values.last().unwrap(),
                "past the end holds"
            );
        }
    }

    #[test]
    fn one_frame_crossfade_outgoing_stays_under_the_equal_power_curve() {
        // Between control points the envelope is a chord of the outgoing
        // cos arc, which is concave on [0, 1], so the chord never rises above
        // the curve. At the last mixed sample the curve is ≈ 0: the outgoing
        // layer must be (almost) silent there, not cut off mid-fade.
        use crate::audio::mix::MIX_SAMPLE_RATE;
        for (duration_us, span) in off_grid_spans() {
            let start_us = span - duration_us;
            let mut e = sample_gain(&Animated::Static(0.0), 0, 0, span);
            apply_crossfades(
                &mut e,
                &[AudioCrossfade {
                    start_us,
                    duration_us,
                    incoming: false,
                }],
            );
            let t = span - 1_000_000 / MIX_SAMPLE_RATE;
            let progress = (t - start_us) as f64 / duration_us as f64;
            let curve = weftcut_eval::equal_power_crossfade(progress).0 as f32;
            let got = e.eval(t);
            assert!(
                (0.0..=curve + 1e-6).contains(&got),
                "span {span}: outgoing gain {got} at progress {progress} exceeds the curve {curve}"
            );
        }
    }

    #[test]
    fn pan_coeffs_follow_a_short_last_segment() {
        for (_, span) in off_grid_spans() {
            let track = Animated::Keyframed(
                vec![kf(0, -1.0), kf(span, 1.0)].into_iter().collect(),
                Extrapolation::HOLD,
            );
            let e = sample_pan(&track, span);
            let n = e.values.len();
            let last_grid = (n as i64 - 2) * ENVELOPE_STEP_US;
            let a = weftcut_eval::pan_coeffs(e.values[n - 2] as f64, 2);
            let b = weftcut_eval::pan_coeffs(e.values[n - 1] as f64, 2);
            let mid = pan_coeffs_at(&e, 2, (last_grid + span) / 2);
            let end = pan_coeffs_at(&e, 2, span);
            for k in 0..4 {
                assert!(
                    (mid[k] - (a[k] + b[k]) / 2.0).abs() < 1e-5,
                    "span {span} idx {k}: midpoint {} is not the mean of {} and {}",
                    mid[k],
                    a[k],
                    b[k]
                );
                assert!(
                    (end[k] - b[k]).abs() < 1e-6,
                    "span {span} idx {k}: end {} != last {}",
                    end[k],
                    b[k]
                );
            }
        }
    }

    #[test]
    fn grid_covers_span_inclusive() {
        let e = sample_gain(&Animated::Static(0.0), 0, 100_000, 25_000);
        // span 25 ms → points at 0, 10, 20, 25 ms = 4 points
        assert_eq!(e.values.len(), 4);
    }

    /// Cross-language golden vectors. The SAME fixture is asserted by
    /// `render/audio/envelope.golden.test.ts` against the TS twin; a change
    /// that passes one side and fails the other is envelope-contract drift.
    /// Also locks the serde wire shape (`mode`/`value`/`extrapolate`, `segment.kind`).
    #[test]
    fn golden_vectors_match_fixture() {
        #[derive(serde::Deserialize)]
        struct Sample {
            t_us: i64,
            expect: f64,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            gain_db: Animated<f64>,
            fade_in_us: i64,
            fade_out_us: i64,
            span_us: i64,
            samples: Vec<Sample>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/renderer/render/audio/audioEnvelopeGolden.fixture.json"
        ))
        .expect("fixture parses as Animated<f64> wire shape");
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            let e = sample_gain(
                &case.gain_db,
                case.fade_in_us,
                case.fade_out_us,
                case.span_us,
            );
            for s in &case.samples {
                let got = e.eval(s.t_us) as f64;
                assert!(
                    (got - s.expect).abs() < 1e-5,
                    "case `{}` t_us={}: got {got}, expect {}",
                    case.name,
                    s.t_us,
                    s.expect
                );
            }
        }

        #[derive(serde::Deserialize)]
        struct PanSample {
            t_us: i64,
            expect: f64,
        }
        #[derive(serde::Deserialize)]
        struct PanCase {
            name: String,
            pan: Animated<f64>,
            span_us: i64,
            samples: Vec<PanSample>,
        }
        #[derive(serde::Deserialize)]
        struct CoeffSample {
            t_us: i64,
            expect: [f32; 4],
        }
        #[derive(serde::Deserialize)]
        struct CoeffCase {
            name: String,
            pan: Animated<f64>,
            channels: i32,
            span_us: i64,
            samples: Vec<CoeffSample>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture2 {
            #[serde(default)]
            pan_cases: Vec<PanCase>,
            #[serde(default)]
            pan_coeff_env_cases: Vec<CoeffCase>,
        }

        let fx2: Fixture2 = serde_json::from_str(include_str!(
            "../../../src/renderer/render/audio/audioEnvelopeGolden.fixture.json"
        ))
        .unwrap();
        for c in &fx2.pan_cases {
            let e = sample_pan(&c.pan, c.span_us);
            for s in &c.samples {
                assert!(
                    (e.eval(s.t_us) as f64 - s.expect).abs() < 1e-5,
                    "pan `{}` t={}: got {}, expect {}",
                    c.name,
                    s.t_us,
                    e.eval(s.t_us),
                    s.expect
                );
            }
        }
        for c in &fx2.pan_coeff_env_cases {
            let e = sample_pan(&c.pan, c.span_us);
            for s in &c.samples {
                let got = pan_coeffs_at(&e, c.channels, s.t_us);
                for (i, (g, e)) in got.iter().zip(&s.expect).enumerate() {
                    assert!(
                        (g - e).abs() < 1e-5,
                        "coeff-env `{}` t={} idx{i}: got {g}, expect {e}",
                        c.name,
                        s.t_us
                    );
                }
            }
        }
    }
}
