//! Resident-ABI wasm exports. SCALARS ONLY across the boundary: the active
//! keyframe track lives in static buffers, uploaded once via `set_kf`/`set_n`
//! and evaluated per call by `eval`. Times are `f64` µs and rates are `i32`
//! (NEVER i64 — that would force BigInt marshaling at the JS boundary). Built
//! only for wasm32; the native crate excludes this module.
//!
//! Color is the one carve-out: an `Rgba8` crosses as a PACKED i32 (RGBA8 in one
//! scalar) via `set_kf_rgba`/`eval_rgba_packed` — still no BigInt and no memory
//! reads, just one i32 per color instead of four channel scalars.
//!
//! Single-threaded by construction (one wasm instance, no threads), so the
//! `static mut` track buffers need no synchronization. `Rational` is NOT here —
//! the snap fn takes `(num, den)` primitives (it stays in the napi crate).
// NOTE: the generic `crate::eval` is NOT imported here — this module exports its
// own `extern "C" fn eval` (the scalar shim), so both paths call
// `crate::eval::<T>` fully-qualified to dodge the name collision.
use crate::{
    db_to_linear as db_to_linear_impl, fade_multiplier as fade_multiplier_impl,
    frame_count as frame_count_impl, frame_index_ceil as frame_index_ceil_impl,
    frame_index_floor as frame_index_floor_impl, frame_index_round as frame_index_round_impl,
    pan_coeffs as pan_coeffs_impl, role_audible as role_audible_impl, snap_frame_ceil,
    snap_frame_floor, snap_frame_round, time_us_at_frame as time_us_at_frame_impl,
    us_to_frame as us_to_frame_impl, EaseDir, Extrapolate, Extrapolation, Kf, Rgba8, Segment,
};

/// Max keyframes held resident for ONE animated property (an `Animated<T>` /
/// the renderer's `AnimTrack` — e.g. one layer's opacity or x), NOT a whole
/// timeline track or clip. Static buffers because the no_std wasm build has no
/// heap; `set_n`/`set_kf` clamp longer inputs (the renderer authors at most a
/// handful per property). LANDMINE: this caps the wasm PREVIEW only — native
/// export's `value_at` evaluates the full keyframe vector, so a >MAXKF property
/// would make preview diverge from export. TS `loadTrack` (MAX_KEYFRAMES) warns.
const MAXKF: usize = 4096;

static mut PATH_NODES: [crate::path::Node; crate::path::MAX_NODES] =
    [crate::path::Node::ZERO; crate::path::MAX_NODES];
static mut PATH_SAMPLES: [[f64; 3]; crate::path::MAX_SAMPLES] =
    [[0.0; 3]; crate::path::MAX_SAMPLES];
static mut PATH_COUNT: usize = 0;
static mut PATH_START: crate::path::Point = crate::path::Point::ZERO;
static mut PATH_END: crate::path::Point = crate::path::Point::ZERO;

#[no_mangle]
pub extern "C" fn path_node(
    i: usize,
    x: f64,
    y: f64,
    ix: f64,
    iy: f64,
    ox: f64,
    oy: f64,
    cubic: i32,
) {
    if i >= crate::path::MAX_NODES {
        return;
    }
    unsafe {
        PATH_NODES[i] = crate::path::Node {
            point: crate::path::Point { x, y },
            incoming: crate::path::Point { x: ix, y: iy },
            outgoing: crate::path::Point { x: ox, y: oy },
            cubic: cubic != 0,
        };
    }
}
#[no_mangle]
pub extern "C" fn path_compile(n: usize) -> usize {
    if n == 0 || n > crate::path::MAX_NODES {
        return 0;
    }
    unsafe {
        let nodes = core::slice::from_raw_parts(core::ptr::addr_of!(PATH_NODES).cast(), n);
        PATH_COUNT = 0;
        let (start, end) = crate::path::compile(nodes, |p| {
            PATH_SAMPLES[PATH_COUNT] = p;
            PATH_COUNT += 1;
        });
        PATH_START = start;
        PATH_END = end;
        PATH_COUNT
    }
}
#[no_mangle]
pub extern "C" fn path_samples_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(PATH_SAMPLES).cast()
}
#[no_mangle]
pub extern "C" fn path_direction(axis: usize) -> f64 {
    unsafe {
        match axis {
            0 => PATH_START.x,
            1 => PATH_START.y,
            2 => PATH_END.x,
            _ => PATH_END.y,
        }
    }
}
#[no_mangle]
pub extern "C" fn path_activate(n: usize, sx: f64, sy: f64, ex: f64, ey: f64) {
    unsafe {
        PATH_COUNT = n.min(crate::path::MAX_SAMPLES);
        PATH_START = crate::path::Point { x: sx, y: sy };
        PATH_END = crate::path::Point { x: ex, y: ey };
    }
}
#[no_mangle]
pub extern "C" fn path_eval(progress: f64, axis: usize) -> f64 {
    unsafe {
        let samples =
            core::slice::from_raw_parts(core::ptr::addr_of!(PATH_SAMPLES).cast(), PATH_COUNT);
        let p = crate::path::evaluate(samples, progress, PATH_START, PATH_END);
        if axis == 0 {
            p.x
        } else {
            p.y
        }
    }
}

// Resident SCALAR track: one slot per `Kf` field, parallel arrays so each
// `set_kf` call stores primitives only.
// Store the leaf's records at upload time. Increasing the baking capacity must
// not initialize/copy MAXKF records on every scalar evaluation of a tiny track.
static mut KEYFRAMES: [Kf; MAXKF] = [Kf {
    t_us: 0,
    value: 0.0,
    out: (0.0, 0.0),
    in_: (0.0, 0.0),
    segment: Segment::Spline,
}; MAXKF];
static mut N: usize = 0;
static mut EX: Extrapolation = Extrapolation::HOLD;

// Resident COLOR track, PARALLEL to the scalar one above (independent buffer;
// `loadColorTrack` in the TS layer caches it under its own handle). Values are
// packed RGBA8 (`(r<<24)|(g<<16)|(b<<8)|a`, r in the HIGH byte) so a color
// crosses the scalars-only ABI as one i32 — see the module header.
static mut COLOR_KEYFRAMES: [Kf<Rgba8>; MAXKF] = [Kf {
    t_us: 0,
    value: Rgba8 {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
    },
    out: (0.0, 0.0),
    in_: (0.0, 0.0),
    segment: Segment::Spline,
}; MAXKF];
static mut NC: usize = 0;
static mut EXC: Extrapolation = Extrapolation::HOLD;

/// `snap_frame_round(t_us, num/den)` — round to the nearest frame boundary.
#[no_mangle]
pub extern "C" fn snap_round(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_round(t_us as i64, num as u32, den as u32) as f64
}

/// `snap_frame_floor(t_us, num/den)` — floor to the frame boundary at or below.
#[no_mangle]
pub extern "C" fn snap_floor(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_floor(t_us as i64, num as u32, den as u32) as f64
}

/// `snap_frame_ceil(t_us, num/den)` — ceil to the frame boundary at or above.
#[no_mangle]
pub extern "C" fn snap_ceil(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_ceil(t_us as i64, num as u32, den as u32) as f64
}

/// `time_us_at_frame(frame, num/den)` — canonical µs of a frame index. Frame
/// indices and µs both stay far inside f64's exact-integer range at 24 h
/// (`i * 1e6 * den` peaks near 5.2e15, 1.7x under 2^53), so the f64 ABI is
/// lossless for every rate the app authors.
#[no_mangle]
pub extern "C" fn time_us_at_frame(frame: f64, num: i32, den: i32) -> f64 {
    time_us_at_frame_impl(frame as i64, num as u32, den as u32) as f64
}

/// `frame_index_floor(t_us, num/den)` — index of the frame containing `t_us`.
#[no_mangle]
pub extern "C" fn frame_index_floor(t_us: f64, num: i32, den: i32) -> f64 {
    frame_index_floor_impl(t_us as i64, num as u32, den as u32) as f64
}

/// `frame_index_round(t_us, num/den)` — index of the nearest frame (half-up).
#[no_mangle]
pub extern "C" fn frame_index_round(t_us: f64, num: i32, den: i32) -> f64 {
    frame_index_round_impl(t_us as i64, num as u32, den as u32) as f64
}

/// `frame_index_ceil(t_us, num/den)` — index of the first frame at or after `t_us`.
#[no_mangle]
pub extern "C" fn frame_index_ceil(t_us: f64, num: i32, den: i32) -> f64 {
    frame_index_ceil_impl(t_us as i64, num as u32, den as u32) as f64
}

/// `frame_count(start_us, end_us, num/den)` — grid frames in `[start, end)`.
#[no_mangle]
pub extern "C" fn frame_count(start_us: f64, end_us: f64, num: i32, den: i32) -> f64 {
    frame_count_impl(start_us as i64, end_us as i64, num as u32, den as u32) as f64
}

/// `us_to_frame(us, rate)` — µs → sample-frame index at `rate` Hz (half-up).
/// Callers pass integer-valued µs (the preview playhead is frame-snapped), so the
/// `as i64` cast is lossless — same f64→i64 convention as `snap_round` above.
#[no_mangle]
pub extern "C" fn us_to_frame(us: f64, rate: i32) -> f64 {
    us_to_frame_impl(us as i64, rate as u32) as f64
}

/// `0=In, 1=Out, 2=InOut`. Anything else is a code-table drift: debug assert +
/// `In` (the same deliberate-fallback policy as `decode_segment`).
fn decode_dir(code: f64) -> EaseDir {
    match code as i32 {
        0 => EaseDir::In,
        1 => EaseDir::Out,
        2 => EaseDir::InOut,
        _ => {
            debug_assert!(false, "unknown ease-dir code");
            EaseDir::In
        }
    }
}

/// ABI segment code + param slots → `Segment` (shared by `set_kf` and
/// `set_kf_rgba`).
///
/// Code table — KEEP in lockstep with TS `renderer/eval/index.ts::encodeSegment`:
///   0 = Hold, 1 = Linear, 4 = Spline, 5 = Elastic, 6 = Bounce.
/// Codes 2/3 are RETIRED (the removed named EaseIn/EaseOut variants) and must
/// never be reassigned — a stale caller sending them must not get a different
/// curve than it asked for.
///
/// Param-slot layout by code (slots unused by a code are ignored; the Spline
/// tangents ride in their own `out_x/out_y/in_x/in_y` slots, not here):
///   5 Elastic: s0 = dir (see `decode_dir`), s1 = amplitude, s2 = period
///   6 Bounce:  s0 = dir
///
/// Unknown codes (incl. the retired 2/3) fall back to Linear — visible motion
/// rather than a silently wrong curve — and trip a debug assert so a code-table
/// drift fails loudly in debug builds.
fn decode_segment(seg: i32, s0: f64, s1: f64, s2: f64) -> Segment {
    match seg {
        0 => Segment::Hold,
        1 => Segment::Linear,
        4 => Segment::Spline,
        5 => Segment::Elastic {
            dir: decode_dir(s0),
            amplitude: s1,
            period: s2,
        },
        6 => Segment::Bounce {
            dir: decode_dir(s0),
        },
        _ => {
            debug_assert!(false, "unknown segment code");
            Segment::Linear
        }
    }
}

/// ABI extrapolate code → `Extrapolate`. KEEP in lockstep with TS
/// `renderer/eval/index.ts::encodeExtrapolate`:
///   0 = Hold, 1 = Loop, 2 = PingPong, 3 = Offset, 4 = Continue.
/// Unknown codes fall back to Hold (the clamp — no motion invented) and trip a
/// debug assert, mirroring `decode_segment`.
fn decode_extrapolate(code: i32) -> Extrapolate {
    match code {
        0 => Extrapolate::Hold,
        1 => Extrapolate::Loop,
        2 => Extrapolate::PingPong,
        3 => Extrapolate::Offset,
        4 => Extrapolate::Continue,
        _ => {
            debug_assert!(false, "unknown extrapolate code");
            Extrapolate::Hold
        }
    }
}

/// Set the resident track length (number of keyframes uploaded via `set_kf`)
/// and the track's extrapolation codes (`decode_extrapolate`).
#[no_mangle]
pub extern "C" fn set_n(n: i32, before: i32, after: i32) {
    let n = (n as usize).min(MAXKF);
    let ex = Extrapolation {
        before: decode_extrapolate(before),
        after: decode_extrapolate(after),
    };
    unsafe {
        N = n;
        EX = ex;
    }
}

/// Upload one keyframe into the resident buffer. `out_x/out_y` is the leaving
/// handle, `in_x/in_y` the arriving one (un-mirrored, see `Kf`); segment codes
/// and the `s0..s2` slot layout are documented at `decode_segment`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_kf(
    i: i32,
    t_us: f64,
    value: f64,
    out_x: f64,
    out_y: f64,
    in_x: f64,
    in_y: f64,
    seg: i32,
    s0: f64,
    s1: f64,
    s2: f64,
) {
    let segment = decode_segment(seg, s0, s1, s2);
    let i = (i as usize).min(MAXKF - 1);
    unsafe {
        KEYFRAMES[i] = Kf {
            t_us: t_us as i64,
            value,
            out: (out_x, out_y),
            in_: (in_x, in_y),
            segment,
        };
    }
}

/// Evaluate the resident track at `t_us`, returning `default` for an empty track.
#[no_mangle]
pub extern "C" fn eval(t_us: f64, default: f64) -> f64 {
    unsafe {
        // N is clamped at upload; no callback or mutation can overlap this
        // synchronous read in a single-threaded Wasm instance.
        let keys = core::slice::from_raw_parts(core::ptr::addr_of!(KEYFRAMES).cast(), N);
        crate::eval::<f64>(keys, EX, t_us as i64, default)
    }
}

/// Set the resident COLOR track length (keyframes uploaded via `set_kf_rgba`)
/// and its extrapolation codes.
#[no_mangle]
pub extern "C" fn set_n_rgba(n: i32, before: i32, after: i32) {
    let n = (n as usize).min(MAXKF);
    let ex = Extrapolation {
        before: decode_extrapolate(before),
        after: decode_extrapolate(after),
    };
    unsafe {
        NC = n;
        EXC = ex;
    }
}

/// Upload one COLOR keyframe. `packed` layout is documented at the color-track
/// buffer above; tangent slots as `set_kf`; segment codes at `decode_segment`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_kf_rgba(
    i: i32,
    t_us: f64,
    packed: i32,
    out_x: f64,
    out_y: f64,
    in_x: f64,
    in_y: f64,
    seg: i32,
    s0: f64,
    s1: f64,
    s2: f64,
) {
    let segment = decode_segment(seg, s0, s1, s2);
    let i = (i as usize).min(MAXKF - 1);
    unsafe {
        let u = packed as u32;
        COLOR_KEYFRAMES[i] = Kf {
            t_us: t_us as i64,
            value: Rgba8 {
                r: (u >> 24) as u8,
                g: (u >> 16) as u8,
                b: (u >> 8) as u8,
                a: u as u8,
            },
            out: (out_x, out_y),
            in_: (in_x, in_y),
            segment,
        };
    }
}

/// Evaluate the resident COLOR track at `t_us` through the SAME leaf
/// `eval::<Rgba8>` (OkLab + premultiplied alpha) the native side runs, returning
/// `default_packed` for an empty track. In/out are packed RGBA8 i32 — r in the
/// HIGH byte, matching the TS `packRgba`/`unpackRgba` exactly.
#[no_mangle]
pub extern "C" fn eval_rgba_packed(t_us: f64, default_packed: i32) -> i32 {
    unsafe {
        let unpack = |u: u32| Rgba8 {
            r: (u >> 24) as u8,
            g: (u >> 16) as u8,
            b: (u >> 8) as u8,
            a: u as u8,
        };
        let def = unpack(default_packed as u32);
        let keys = core::slice::from_raw_parts(core::ptr::addr_of!(COLOR_KEYFRAMES).cast(), NC);
        let out = crate::eval::<Rgba8>(keys, EXC, t_us as i64, def);
        (((out.r as u32) << 24) | ((out.g as u32) << 16) | ((out.b as u32) << 8) | (out.a as u32))
            as i32
    }
}

/// `10^(db/20)` linear gain.
#[no_mangle]
pub extern "C" fn db_to_linear(db: f64) -> f32 {
    db_to_linear_impl(db)
}

/// Role mute/solo gate (booleans as i32; nonzero = true). Returns 1 if audible.
#[no_mangle]
pub extern "C" fn role_audible(muted: i32, solo: i32, any_solo: i32) -> i32 {
    role_audible_impl(muted != 0, solo != 0, any_solo != 0) as i32
}

/// `pan_coeffs(pan, channels)[idx]` — equal-power pan law, one coefficient per
/// call (scalar ABI; the renderer reads idx 0..3 to build the matrix curves).
#[no_mangle]
pub extern "C" fn pan_coeff(pan: f64, channels: i32, idx: i32) -> f32 {
    let c = pan_coeffs_impl(pan, channels);
    let i = (idx as usize).min(3);
    c[i]
}

/// `fade_multiplier(t_us, span_us, fade_in_us, fade_out_us)` — fade ramp. Times
/// as f64 µs (frame/grid-aligned integers, lossless `as i64`).
#[no_mangle]
pub extern "C" fn fade_mul(t_us: f64, span_us: f64, fade_in_us: f64, fade_out_us: f64) -> f64 {
    fade_multiplier_impl(
        t_us as i64,
        span_us as i64,
        fade_in_us as i64,
        fade_out_us as i64,
    )
}

/// Liveness probe for the loader.
#[no_mangle]
pub extern "C" fn noop() {}
