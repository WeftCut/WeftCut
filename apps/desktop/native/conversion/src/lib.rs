//! Offline position conversion. A single Rust implementation owns sampling,
//! fitting, simplification and verification; TS transports records and IDs only.
//! Dynamic authoring buffers live here, outside the allocation-free eval Wasm.
use serde::{Deserialize, Serialize};
use weftcut_eval::{
    eval_precise,
    path::{self, Node, Point},
    Extrapolate, Extrapolation, Kf,
};
mod spatial;
mod temporal;
#[cfg(test)]
mod tests;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use weftcut_eval::MAX_RESIDENT_KEYFRAMES as MAX_KEYS;
#[derive(Clone, Deserialize, Serialize)]
pub struct Track {
    pub keys: Vec<Kf>,
    pub extrapolate: Extrapolation,
}
impl Track {
    fn at(&self, t: f64) -> f64 {
        eval_precise(&self.keys, self.extrapolate, t, 0.0)
    }
}
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum XyMode {
    #[default]
    Editable,
    Bake,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub fps_num: u32,
    pub fps_den: u32,
    pub start_frame: i64,
    pub end_frame: i64,
    pub tolerance_px: f64,
    pub every_frames: usize,
    #[serde(default)]
    pub xy_mode: XyMode,
}
impl Options {
    fn time(&self, f: i64) -> f64 {
        weftcut_eval::time_us_at_frame(f, self.fps_num, self.fps_den) as f64
    }
    fn validate(&self) -> Result<(), &'static str> {
        if self.fps_num == 0
            || self.fps_den == 0
            || self.start_frame < 0
            || self.end_frame <= self.start_frame
            || self.end_frame > i64::MAX / 4
            || (self.end_frame as f64 * 1e6 * self.fps_den as f64 / self.fps_num as f64)
                > 9_007_199_254_740_991.0
            || self.fps_num as f64 / self.fps_den as f64 > 250_000.0
        {
            return Err("conversion_range_error");
        }
        if !self.tolerance_px.is_finite() || self.tolerance_px < 0.05 || self.every_frames == 0 {
            return Err("conversion_options_error");
        }
        Ok(())
    }
}
#[derive(Deserialize)]
pub struct Request {
    pub nodes: Option<Vec<Node>>,
    pub tracks: Vec<Track>,
    pub options: Options,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversion {
    pub nodes: Option<Vec<Node>>,
    pub tracks: Vec<Track>,
    pub sample_count: usize,
    pub node_count: usize,
    pub max_error_px: f64,
    pub check_count: usize,
    pub within_tolerance: bool,
    pub limit: Option<&'static str>,
}
struct Compiled {
    samples: Vec<[f64; 4]>,
    start: Point,
    end: Point,
}
impl Compiled {
    fn new(nodes: &[Node]) -> Self {
        let mut samples = Vec::new();
        let (start, end) = path::compile(nodes, |s| samples.push(s));
        Self {
            samples,
            start,
            end,
        }
    }
    fn at(&self, p: f64) -> Point {
        path::evaluate(&self.samples, p, self.start, self.end)
    }
}
fn repeating(mode: Extrapolate) -> bool {
    matches!(
        mode,
        Extrapolate::Loop | Extrapolate::PingPong | Extrapolate::Offset
    )
}
fn boundaries(
    tracks: &[Track],
    path: Option<&Compiled>,
    start: f64,
    end: f64,
) -> Result<Vec<f64>, &'static str> {
    let mut times = Vec::new();
    let jumps = |a: f64, b: f64| path.map_or((a - b).abs(), |p| p.at(a).distance(p.at(b))) > 1e-9;
    for track in tracks {
        if track.keys.len() < 2 {
            continue;
        }
        let first = track.keys[0].t_us;
        let last = track.keys.last().unwrap().t_us;
        let period = last - first;
        let low = if repeating(track.extrapolate.before) {
            (((start - first) / period).floor() - 1.0).min(0.0) as i64
        } else {
            0
        };
        let high = if repeating(track.extrapolate.after) {
            (((end - first) / period).ceil() + 1.0).max(0.0) as i64
        } else {
            0
        };
        for cycle in low..=high {
            let mode = if cycle < 0 {
                track.extrapolate.before
            } else {
                track.extrapolate.after
            };
            if cycle != 0 && !repeating(mode) {
                continue;
            }
            let reverse = cycle != 0 && mode == Extrapolate::PingPong && cycle % 2 != 0;
            for (i, key) in track.keys.iter().enumerate() {
                let at = first
                    + cycle as f64 * period
                    + if reverse {
                        last - key.t_us
                    } else {
                        key.t_us - first
                    };
                if at >= start && at <= end {
                    times.push(at);
                }
                if i > 0
                    && track.keys[i - 1].segment == weftcut_eval::Segment::Hold
                    && jumps(track.keys[i - 1].value, key.value)
                    && if reverse {
                        at >= start && at < end
                    } else {
                        at > start && at <= end
                    }
                {
                    return Err("jump_error");
                }
            }
            let seam = first + cycle as f64 * period;
            let seam_mode = if cycle <= 0 {
                track.extrapolate.before
            } else {
                track.extrapolate.after
            };
            if seam_mode == Extrapolate::Loop
                && jumps(track.keys[0].value, track.keys.last().unwrap().value)
                && seam > start
                && seam <= end
                && !(cycle == 1 && seam == end)
            {
                return Err("jump_error");
            }
        }
        if start == last
            && end > start
            && track.extrapolate.after == Extrapolate::Loop
            && jumps(track.keys[0].value, track.keys.last().unwrap().value)
        {
            return Err("jump_error");
        }
    }
    Ok(times)
}
pub fn convert(request: Request) -> Result<Conversion, &'static str> {
    let Request {
        nodes,
        tracks,
        options,
    } = request;
    options.validate()?;
    if tracks.len() != if nodes.is_some() { 1 } else { 2 } {
        return Err("conversion_options_error");
    }
    for track in &tracks {
        if track.keys.is_empty() || track.keys.len() > MAX_KEYS {
            return Err("conversion_capacity_error");
        }
        if track.keys.iter().any(|k| {
            !k.t_us.is_finite()
                || !k.value.is_finite()
                || !k.in_.0.is_finite()
                || !k.in_.1.is_finite()
                || !k.out.0.is_finite()
                || !k.out.1.is_finite()
                || !(0.0..=1.0).contains(&k.in_.0)
                || !(0.0..=1.0).contains(&k.out.0)
        }) || track.keys.windows(2).any(|p| p[0].t_us >= p[1].t_us)
        {
            return Err("conversion_options_error");
        }
    }
    if let Some(nodes) = &nodes {
        if nodes.is_empty()
            || nodes.len() > path::MAX_NODES
            || nodes.iter().any(|n| {
                [n.point, n.incoming, n.outgoing]
                    .iter()
                    .any(|p| !p.x.is_finite() || !p.y.is_finite())
            })
        {
            return Err("conversion_options_error");
        }
    }
    let source_path = nodes.as_ref().map(|n| Compiled::new(n));
    if let Some(path) = &source_path {
        // Preserve the exact single-node fast path, including animated progress.
        // In editable mode a constant progress track is equally stationary.
        let stationary_geometry = path.samples.last().unwrap()[2] == 0.0;
        let stationary_progress = tracks[0]
            .keys
            .iter()
            .all(|k| k.value == tracks[0].keys[0].value);
        if stationary_geometry || (options.xy_mode == XyMode::Editable && stationary_progress) {
            let p = path.at(tracks[0].keys[0].value);
            let constant = |value| Track {
                keys: vec![Kf {
                    t_us: 0.0,
                    value,
                    in_: weftcut_eval::IN_IDENTITY,
                    out: weftcut_eval::OUT_IDENTITY,
                    segment: weftcut_eval::Segment::Linear,
                }],
                extrapolate: Extrapolation::HOLD,
            };
            return Ok(Conversion {
                nodes: None,
                tracks: vec![constant(p.x), constant(p.y)],
                sample_count: 0,
                node_count: 0,
                max_error_px: 0.0,
                check_count: 0,
                within_tolerance: true,
                limit: None,
            });
        }
        if options.xy_mode == XyMode::Bake
            && ((options.end_frame - options.start_frame) as u64)
                .div_ceil(options.every_frames as u64)
                + 1
                > MAX_KEYS as u64
        {
            return Err("conversion_capacity_error");
        }
    }
    let first = options.time(options.start_frame);
    let last = options.time(options.end_frame);
    let anchors = boundaries(&tracks, source_path.as_ref(), first, last)?;
    let mut times = Vec::new();
    let count = usize::try_from((options.end_frame - options.start_frame) * 4 + 1)
        .map_err(|_| "conversion_capacity_error")?;
    times
        .try_reserve(count)
        .map_err(|_| "conversion_capacity_error")?;
    for quarter in options.start_frame * 4..=options.end_frame * 4 {
        // Same rational frame grid as committed keys, including fractional rates.
        let numerator = quarter as i128 * 1_000_000 * options.fps_den as i128;
        let denominator = options.fps_num as i128 * 4;
        times.push(((numerator + denominator / 2) / denominator) as f64);
    }
    for &t in &anchors {
        for at in [t - 1.0, t, t + 1.0] {
            if at >= first && at <= last {
                times.push(at);
            }
        }
    }
    times.sort_by(f64::total_cmp);
    times.dedup();
    let original: Vec<Point> = times
        .iter()
        .map(|&t| {
            source_path.as_ref().map_or_else(
                || Point {
                    x: tracks[0].at(t),
                    y: tracks[1].at(t),
                },
                |p| p.at(tracks[0].at(t)),
            )
        })
        .collect();
    if original
        .iter()
        .any(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        return Err("conversion_options_error");
    }
    let fit = if source_path.is_none() {
        Some(spatial::fit(&original, options.tolerance_px * 0.35))
    } else {
        None
    };
    let target_path = fit.as_ref().map(|f| Compiled::new(&f.nodes));
    let mut result_tracks = Vec::new();
    let mut limit = None;
    if let Some(fit) = &fit {
        let path = target_path.as_ref().unwrap();
        let curve = temporal::fit(
            &times,
            &fit.progress,
            &anchors,
            &options,
            options.tolerance_px,
            false,
            |v, i| path.at(v).distance(original[i]),
        );
        limit = if fit.limited {
            Some("node_limit")
        } else {
            curve.limit
        };
        result_tracks.push(Track {
            keys: curve.keys,
            extrapolate: Extrapolation::HOLD,
        });
    } else {
        let bake = options.xy_mode == XyMode::Bake && nodes.as_ref().unwrap().len() > 1;
        for axis in 0..2 {
            let values: Vec<_> = original
                .iter()
                .map(|p| if axis == 0 { p.x } else { p.y })
                .collect();
            let curve = temporal::fit(
                &times,
                &values,
                &anchors,
                &options,
                options.tolerance_px / std::f64::consts::SQRT_2,
                bake,
                |v, i| (v - values[i]).abs(),
            );
            limit = limit.or(curve.limit);
            result_tracks.push(Track {
                keys: curve.keys,
                extrapolate: Extrapolation::HOLD,
            });
        }
    }
    if result_tracks.iter().any(|t| t.keys.is_empty()) {
        return Err("conversion_capacity_error");
    }
    let mut max_error = 0.0_f64;
    for (i, &t) in times.iter().enumerate() {
        let p = target_path.as_ref().map_or_else(
            || Point {
                x: result_tracks[0].at(t),
                y: result_tracks[1].at(t),
            },
            |p| p.at(result_tracks[0].at(t)),
        );
        max_error = max_error.max(p.distance(original[i]));
    }
    let within_tolerance = max_error <= options.tolerance_px;
    let nodes = fit.map(|f| f.nodes);
    Ok(Conversion {
        node_count: nodes.as_ref().map_or(0, Vec::len),
        nodes,
        sample_count: result_tracks
            .iter()
            .map(|t| if t.keys.len() == 1 { 0 } else { t.keys.len() })
            .max()
            .unwrap_or(0),
        tracks: result_tracks,
        max_error_px: max_error,
        check_count: times.len(),
        within_tolerance,
        limit: if within_tolerance {
            None
        } else {
            limit.or(Some("frame_grid"))
        },
    })
}
