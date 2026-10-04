//! Frame-aligned scalar curves. Reference samples are measurements, not keys.
//! Local least-squares cubics refine only failing spans; a final merge pass
//! removes redundant anchors. All residuals use the playback evaluator.
use crate::{Options, MAX_KEYS};
use std::collections::BTreeSet;
use weftcut_eval::{eval_precise, Extrapolation, Kf, Segment, IN_IDENTITY, OUT_IDENTITY};

pub struct Curve {
    pub keys: Vec<Kf>,
    pub limit: Option<&'static str>,
}
struct Span {
    a: usize,
    b: usize,
    left: Kf,
    right: Kf,
    error: f64,
    worst: usize,
}
fn key(time: f64, value: f64) -> Kf {
    Kf {
        t_us: time,
        value,
        out: OUT_IDENTITY,
        in_: IN_IDENTITY,
        segment: Segment::Linear,
    }
}
fn residual(
    left: Kf,
    right: Kf,
    times: &[f64],
    error: &impl Fn(f64, usize) -> f64,
    a: usize,
    b: usize,
) -> (f64, usize) {
    let (mut maximum, mut worst) = (0.0, a);
    for (i, &t) in times.iter().enumerate().take(b + 1).skip(a) {
        let e = error(
            eval_precise(&[left, right], Extrapolation::HOLD, t, left.value),
            i,
        );
        if e > maximum {
            maximum = e;
            worst = i;
        }
    }
    (maximum, worst)
}
fn span(
    a: usize,
    b: usize,
    times: &[f64],
    values: &[f64],
    tolerance: f64,
    error: &impl Fn(f64, usize) -> f64,
) -> Span {
    let (mut left, mut right) = (key(times[a], values[a]), key(times[b], values[b]));
    let (mut maximum, mut worst) = residual(left, right, times, error, a, b);
    let dv = right.value - left.value;
    let dt = right.t_us - left.t_us;
    if maximum > tolerance && dv.abs() > 1e-12 {
        // Fit absolute control values first; equal-endpoint spans must split
        // because the existing scalar keyframe format scales handles by dv.
        let (mut aa, mut ab, mut bb, mut ar, mut br) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for i in a + 1..b {
            let u = (times[i] - times[a]) / dt;
            let v = 1.0 - u;
            let (w1, w2) = (3.0 * u * v * v, 3.0 * u * u * v);
            let r = values[i] - left.value * v * v * v - right.value * u * u * u;
            aa += w1 * w1;
            ab += w1 * w2;
            bb += w2 * w2;
            ar += w1 * r;
            br += w2 * r;
        }
        let determinant = aa * bb - ab * ab;
        if determinant > 1e-20 {
            let mut l = left;
            let mut r = right;
            l.segment = Segment::Spline;
            l.out.1 = ((ar * bb - br * ab) / determinant - left.value) / dv;
            r.in_.1 = ((br * aa - ar * ab) / determinant - left.value) / dv;
            if l.out.1.is_finite() && r.in_.1.is_finite() {
                let (e, i) = residual(l, r, times, error, a, b);
                if e < maximum {
                    left = l;
                    right = r;
                    maximum = e;
                    worst = i;
                }
            }
        }
    }
    Span {
        a,
        b,
        left,
        right,
        error: maximum,
        worst,
    }
}
pub fn fit(
    times: &[f64],
    values: &[f64],
    anchors: &[f64],
    options: &Options,
    tolerance: f64,
    bake: bool,
    error: impl Fn(f64, usize) -> f64,
) -> Curve {
    if !bake && values.iter().all(|v| *v == values[0]) {
        return Curve {
            keys: vec![key(times[0], values[0])],
            limit: None,
        };
    }
    let index = |f: i64| {
        times
            .binary_search_by(|t| t.total_cmp(&options.time(f)))
            .unwrap()
    };
    let mut selected = BTreeSet::from([index(options.start_frame), index(options.end_frame)]);
    let mut protected = BTreeSet::new();
    if bake {
        let count = (options.end_frame - options.start_frame) as usize / options.every_frames + 2;
        if count > MAX_KEYS + 1 {
            return Curve {
                keys: Vec::new(),
                limit: Some("key_limit"),
            };
        }
        for f in (options.start_frame..options.end_frame).step_by(options.every_frames) {
            selected.insert(index(f));
        }
    } else {
        for &t in anchors {
            let f =
                weftcut_eval::frame_index_round(t.round() as i64, options.fps_num, options.fps_den);
            if f > options.start_frame && f < options.end_frame {
                selected.insert(index(f));
            }
        }
        // Frame extrema and exact plateau boundaries retain recognizable edits.
        // Subframe features remain in the residual checks even if not expressible.
        for f in options.start_frame + 1..options.end_frame {
            let (a, b, c) = (index(f - 1), index(f), index(f + 1));
            let (before, after) = (values[b] - values[a], values[c] - values[b]);
            if before * after < 0.0 || (before == 0.0) != (after == 0.0) {
                selected.insert(b);
                protected.insert(b);
            }
        }
    }
    if bake && selected.len() > MAX_KEYS {
        return Curve {
            keys: Vec::new(),
            limit: Some("key_limit"),
        };
    }
    let indices: Vec<_> = selected.into_iter().collect();
    let mut spans: Vec<_> = indices
        .windows(2)
        .map(|p| span(p[0], p[1], times, values, tolerance, &error))
        .collect();
    let mut limit = None;
    if spans.len() >= MAX_KEYS && !bake {
        // Input anchors are working data, not an output capacity requirement.
        // A dense source plus clip endpoints can still simplify to two keys.
        let mut i = 0;
        while spans.len() >= MAX_KEYS && i + 1 < spans.len() {
            if !protected.contains(&spans[i].b) {
                let merged = span(spans[i].a, spans[i + 1].b, times, values, tolerance, &error);
                if merged.error <= tolerance {
                    spans.splice(i..=i + 1, [merged]);
                    continue;
                }
            }
            i += 1;
        }
        if spans.len() >= MAX_KEYS {
            return Curve {
                keys: Vec::new(),
                limit: Some("key_limit"),
            };
        }
    }
    // Replace only failing spans, without re-fitting or re-evaluating good ones.
    let mut i = 0;
    while i < spans.len() {
        let s = &spans[i];
        if s.error <= tolerance {
            i += 1;
            continue;
        }
        let lo =
            weftcut_eval::frame_index_round(times[s.a] as i64, options.fps_num, options.fps_den);
        let hi =
            weftcut_eval::frame_index_round(times[s.b] as i64, options.fps_num, options.fps_den);
        if hi - lo <= 1 {
            limit = Some("frame_grid");
            i += 1;
            continue;
        }
        if spans.len() + 1 >= MAX_KEYS {
            limit = Some("key_limit");
            break;
        }
        let f = weftcut_eval::frame_index_round(
            times[s.worst].round() as i64,
            options.fps_num,
            options.fps_den,
        )
        .clamp(lo + 1, hi - 1);
        let mid = index(f);
        let replacements = [
            span(s.a, mid, times, values, tolerance, &error),
            span(mid, s.b, times, values, tolerance, &error),
        ];
        spans.splice(i..=i, replacements);
    }
    if !bake {
        // Iterative merging reaches a fixed point; no wall-clock/iteration budget
        // silently reduces quality. Each accepted merge strictly reduces keys.
        loop {
            let mut changed = false;
            let mut i = 0;
            while i + 1 < spans.len() {
                if !protected.contains(&spans[i].b) {
                    let merged = span(spans[i].a, spans[i + 1].b, times, values, tolerance, &error);
                    if merged.error <= tolerance {
                        spans.splice(i..=i + 1, [merged]);
                        changed = true;
                        i += 1;
                        continue;
                    }
                }
                i += 1;
            }
            if !changed {
                break;
            }
        }
        // Hold extrapolation expresses leading/trailing rests without clip-edge keys.
        while spans.len() > 1
            && values[spans[0].a..=spans[0].b]
                .iter()
                .all(|v| *v == spans[0].left.value)
        {
            spans.remove(0);
        }
        while spans.len() > 1 {
            let s = spans.last().unwrap();
            if !values[s.a..=s.b].iter().all(|v| *v == s.left.value) {
                break;
            }
            spans.pop();
        }
    }
    let mut keys = vec![spans[0].left];
    for s in &spans {
        let left = keys.last_mut().unwrap();
        left.out = s.left.out;
        left.segment = s.left.segment;
        keys.push(s.right);
    }
    Curve { keys, limit }
}
