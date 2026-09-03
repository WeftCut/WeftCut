//! Pure `Animated<f64>` keyframe transforms for the authoring surface.
//!
//! Behavioral mirror of `apps/desktop/src/renderer/keyframe/edits.ts`, plus the
//! twins of the two segment-easing bridges in `src/shared/easing.ts`
//! (`segment_easing` / `apply_segment_easing`), of the write-time tangent
//! solver `src/shared/tangents.ts` (`solve_auto_tangents`) and of its four
//! side-slope helpers. Times are LAYER-LOCAL microseconds (the keyframe `t_us`
//! base). Each fn returns a NEW track; the actor re-normalizes
//! (snap/sort/dedupe) on write, so these need only stay self-consistent.
//!
//! Cross-language parity is locked by `keyframeEditsGolden.fixture.json`
//! (asserted by `golden_vectors_match_fixture` here AND by
//! `apps/desktop/src/renderer/keyframe/edits.golden.test.ts`). Any edit here MUST be mirrored in the TS
//! and reflected in the fixture — there is no other enforcing test (see memory
//! `feedback_engine_source_drift`, `feedback_snap_math_drift`).

use crate::state::animated::{
    Animated, Continuity, EaseDir, Extrapolate, Extrapolation, Keyframe, Segment, Tangent,
    TangentMode, IN_IDENTITY, OUT_IDENTITY,
};
use crate::state::ids::{new_id, KeyframeId};

/// The easing of ONE segment as a value — what a named preset bakes to and what
/// `set_segment_easing` takes. Mirrors TS `Interpolation` (`src/shared/easing.ts`)
/// with the same `kind` tagging so the golden fixture's `easing` arg deserializes
/// here. NOT a stored type: `Bezier` lands as the left key's `out`, the right
/// key's `in`, and `Segment::Spline`; the other kinds are the segment class with
/// identity sides.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
pub enum Interpolation {
    Hold,
    Linear,
    Bezier {
        p1: (f64, f64),
        p2: (f64, f64),
    },
    Elastic {
        dir: EaseDir,
        amplitude: f64,
        period: f64,
    },
    Bounce {
        dir: EaseDir,
    },
}

/// Read the easing of segment `left → right` back as one value: a Spline is
/// the two tangents as a cubic, any other class is itself.
pub fn segment_easing<T: Clone>(left: &Keyframe<T>, right: &Keyframe<T>) -> Interpolation {
    match left.segment {
        Segment::Spline => Interpolation::Bezier {
            p1: (left.out.x, left.out.y),
            p2: (right.in_.x, right.in_.y),
        },
        Segment::Hold => Interpolation::Hold,
        Segment::Linear => Interpolation::Linear,
        Segment::Elastic {
            dir,
            amplitude,
            period,
        } => Interpolation::Elastic {
            dir,
            amplitude,
            period,
        },
        Segment::Bounce { dir } => Interpolation::Bounce { dir },
    }
}

/// Write easing `e` onto segment `left → right`: the class and the leaving
/// side onto `left`, the arriving side onto `right`; both sides come out
/// `Free`. `right` is `None` when `left` is the last key — only `left` is
/// written. Pure: returns new keys.
pub fn apply_segment_easing<T: Clone>(
    left: &Keyframe<T>,
    right: Option<&Keyframe<T>>,
    e: Interpolation,
) -> (Keyframe<T>, Option<Keyframe<T>>) {
    let (segment, out, in_) = match e {
        Interpolation::Bezier { p1, p2 } => (
            Segment::Spline,
            Tangent::free(p1.0, p1.1),
            Tangent::free(p2.0, p2.1),
        ),
        Interpolation::Hold => (
            Segment::Hold,
            Tangent::out_identity(),
            Tangent::in_identity(),
        ),
        Interpolation::Linear => (
            Segment::Linear,
            Tangent::out_identity(),
            Tangent::in_identity(),
        ),
        Interpolation::Elastic {
            dir,
            amplitude,
            period,
        } => (
            Segment::Elastic {
                dir,
                amplitude,
                period,
            },
            Tangent::out_identity(),
            Tangent::in_identity(),
        ),
        Interpolation::Bounce { dir } => (
            Segment::Bounce { dir },
            Tangent::out_identity(),
            Tangent::in_identity(),
        ),
    };
    let l = Keyframe {
        segment,
        out,
        ..left.clone()
    };
    let r = right.map(|r| Keyframe { in_, ..r.clone() });
    (l, r)
}

/// A fresh key with identity sides, `Broken`, `Linear` — the shape every insert
/// starts from before it inherits or is given an easing.
fn new_key(t_us: i64, value: f64) -> Keyframe<f64> {
    Keyframe {
        id: new_id(),
        t_us,
        value,
        in_: Tangent::in_identity(),
        out: Tangent::out_identity(),
        continuity: Continuity::Broken,
        segment: Segment::Linear,
    }
}

/// Insert-or-update a key at `t_us` (layer-local). A `Static` track is lifted
/// (the new key is the only key). An existing key at exactly `t_us` is updated
/// in place — value always; easing only when `easing` is `Some`. Otherwise a
/// new key K is inserted between A (the preceding key) and B (the following):
/// `K.segment = A.segment`, `K.out = A.out`, `K.in = B.in` (identity when B is
/// absent) — both halves repeat the ease A→B had, which is what "inherit the
/// preceding easing" meant when the ease lived on one key. No A → Linear with
/// identity sides. A given `easing` is then applied to `(K, next)`.
pub fn upsert(
    track: &Animated<f64>,
    t_us: i64,
    value: f64,
    easing: Option<Interpolation>,
) -> Animated<f64> {
    let (kfs, ex) = match track {
        Animated::Static(_) => {
            let mut k = new_key(t_us, value);
            if let Some(e) = easing {
                k = apply_segment_easing(&k, None, e).0;
            }
            return Animated::Keyframed(std::iter::once(k).collect(), Extrapolation::HOLD);
        }
        Animated::Keyframed(kfs, ex) => (kfs, *ex),
    };
    let mut keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    let at = match keys.iter().position(|k| k.t_us == t_us) {
        Some(at) => {
            keys[at].value = value;
            at
        }
        None => {
            let mut k = new_key(t_us, value);
            if let Some(a) = keys.iter().rev().find(|k| k.t_us < t_us) {
                k.segment = a.segment;
                k.out = a.out;
                k.in_ = keys
                    .iter()
                    .find(|k| k.t_us > t_us)
                    .map(|b| b.in_)
                    .unwrap_or(Tangent::in_identity());
            }
            keys.push(k);
            keys.sort_by_key(|k| k.t_us);
            keys.iter().position(|k| k.t_us == t_us).unwrap()
        }
    };
    if let Some(e) = easing {
        let right = keys.get(at + 1).cloned();
        let (l, r) = apply_segment_easing(&keys[at], right.as_ref(), e);
        keys[at] = l;
        if let Some(r) = r {
            keys[at + 1] = r;
        }
    }
    Animated::Keyframed(keys.into_iter().collect(), ex)
}

/// Remove a key by id. When it was the last key, collapse to a `Static` holding
/// that key's value (so the property keeps its on-screen value). `fallback` is
/// used only if `id` is absent (callers pre-check existence).
pub fn remove(track: &Animated<f64>, id: KeyframeId, fallback: f64) -> Animated<f64> {
    let Animated::Keyframed(kfs, ex) = track else {
        return track.clone();
    };
    let remaining: Vec<Keyframe<f64>> = kfs.iter().filter(|k| k.id != id).cloned().collect();
    if remaining.is_empty() {
        let removed = kfs.iter().find(|k| k.id == id).map(|k| k.value);
        return Animated::Static(removed.unwrap_or(fallback));
    }
    Animated::Keyframed(remaining.into_iter().collect(), *ex)
}

/// Move one key to `new_t_us` (layer-local) and re-sort.
pub fn retime(track: &Animated<f64>, id: KeyframeId, new_t_us: i64) -> Animated<f64> {
    let Animated::Keyframed(kfs, ex) = track else {
        return track.clone();
    };
    let mut keys: Vec<Keyframe<f64>> = kfs
        .iter()
        .map(|k| {
            if k.id == id {
                Keyframe {
                    t_us: new_t_us,
                    ..k.clone()
                }
            } else {
                k.clone()
            }
        })
        .collect();
    keys.sort_by_key(|k| k.t_us);
    Animated::Keyframed(keys.into_iter().collect(), *ex)
}

/// Set the easing of the segment leaving key `id` (`apply_segment_easing` on
/// that key and its successor).
pub fn set_segment_easing(
    track: &Animated<f64>,
    id: KeyframeId,
    easing: Interpolation,
) -> Animated<f64> {
    let Animated::Keyframed(kfs, ex) = track else {
        return track.clone();
    };
    let mut keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    let Some(i) = keys.iter().position(|k| k.id == id) else {
        return track.clone();
    };
    let right = keys.get(i + 1).cloned();
    let (l, r) = apply_segment_easing(&keys[i], right.as_ref(), easing);
    keys[i] = l;
    if let Some(r) = r {
        keys[i + 1] = r;
    }
    Animated::Keyframed(keys.into_iter().collect(), *ex)
}

/// Mark keys `ids` Auto on both sides with `Smooth` continuity, and make the
/// segments on either side of each `Spline` so the solved tangents are read.
/// Coordinates are untouched — `solve_auto_tangents` (main's write step)
/// produces them.
pub fn set_auto(track: &Animated<f64>, ids: &[KeyframeId]) -> Animated<f64> {
    let Animated::Keyframed(kfs, ex) = track else {
        return track.clone();
    };
    let mut keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    let n = keys.len();
    for i in 0..n {
        if !ids.contains(&keys[i].id) {
            continue;
        }
        keys[i].in_.mode = TangentMode::Auto;
        keys[i].out.mode = TangentMode::Auto;
        keys[i].continuity = Continuity::Smooth;
        if i + 1 < n {
            keys[i].segment = Segment::Spline;
        }
        if i > 0 {
            keys[i - 1].segment = Segment::Spline;
        }
    }
    Animated::Keyframed(keys.into_iter().collect(), *ex)
}

/// Which side of a key a tangent edit addresses. Serializes lowercase so the
/// golden fixture's `"side": "in" | "out"` deserializes here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    In,
    Out,
}

/// Write one side of key `id` as `Free (x, y)`: `x` clamped to `[0, 1]`, `y`
/// free. Grabbing either handle of an Auto key converts the key to Free (the
/// other side keeps its numbers, mode Free). The segment the written side
/// shapes becomes Spline. With `Smooth` continuity, when the OPPOSITE side's
/// segment is Spline, that side is rotated to the same value slope (the slope
/// helpers below), keeping its x; skipped when no finite y does it.
pub fn set_tangent(
    track: &Animated<f64>,
    id: KeyframeId,
    side: Side,
    x: f64,
    y: f64,
) -> Animated<f64> {
    let Animated::Keyframed(kfs, ex) = track else {
        return track.clone();
    };
    let mut keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    let Some(i) = keys.iter().position(|k| k.id == id) else {
        return track.clone();
    };
    let k = keys[i].clone();
    let prev = if i > 0 {
        Some(keys[i - 1].clone())
    } else {
        None
    };
    let next = keys.get(i + 1).cloned();
    let written = Tangent::free(clamp01(x), y);
    let other = match side {
        Side::In => k.out,
        Side::Out => k.in_,
    };
    let other_free = Tangent {
        mode: TangentMode::Free,
        ..other
    };
    let (mut in_side, mut out_side) = match side {
        Side::In => (written, other_free),
        Side::Out => (other_free, written),
    };

    if k.continuity == Continuity::Smooth {
        let dt_prev = prev.as_ref().map_or(0.0, |p| (k.t_us - p.t_us) as f64);
        let dv_prev = prev.as_ref().map_or(0.0, |p| k.value - p.value);
        let dt_next = next.as_ref().map_or(0.0, |n| (n.t_us - k.t_us) as f64);
        let dv_next = next.as_ref().map_or(0.0, |n| n.value - k.value);
        match side {
            Side::Out if prev.as_ref().is_some_and(|p| p.segment == Segment::Spline) => {
                if let Some(y) = out_slope(written, dt_next, dv_next)
                    .and_then(|m| in_y_for_slope(other_free.x, m, dt_prev, dv_prev))
                {
                    in_side = Tangent::free(other_free.x, y);
                }
            }
            Side::In if next.is_some() && k.segment == Segment::Spline => {
                if let Some(y) = in_slope(written, dt_prev, dv_prev)
                    .and_then(|m| out_y_for_slope(other_free.x, m, dt_next, dv_next))
                {
                    out_side = Tangent::free(other_free.x, y);
                }
            }
            _ => {}
        }
    }

    keys[i].in_ = in_side;
    keys[i].out = out_side;
    if side == Side::Out && next.is_some() {
        keys[i].segment = Segment::Spline;
    }
    if side == Side::In && prev.is_some() {
        keys[i - 1].segment = Segment::Spline;
    }
    Animated::Keyframed(keys.into_iter().collect(), *ex)
}

/// Set key `id`'s continuity. Switching to `Smooth` with both sides Free and
/// both adjacent segments Spline rotates `in_` to `out`'s slope at once ("out
/// wins", the rule `solve_auto_tangents` applies). `Broken` changes no number.
pub fn set_continuity(
    track: &Animated<f64>,
    id: KeyframeId,
    continuity: Continuity,
) -> Animated<f64> {
    let Animated::Keyframed(kfs, ex) = track else {
        return track.clone();
    };
    let mut keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    let Some(i) = keys.iter().position(|k| k.id == id) else {
        return track.clone();
    };
    let k = keys[i].clone();
    if continuity == Continuity::Smooth
        && k.in_.mode == TangentMode::Free
        && k.out.mode == TangentMode::Free
        && i > 0
        && keys[i - 1].segment == Segment::Spline
        && i + 1 < keys.len()
        && k.segment == Segment::Spline
    {
        let (p, n) = (&keys[i - 1], &keys[i + 1]);
        if let Some(y) = out_slope(k.out, (n.t_us - k.t_us) as f64, n.value - k.value)
            .and_then(|m| in_y_for_slope(k.in_.x, m, (k.t_us - p.t_us) as f64, k.value - p.value))
        {
            keys[i].in_ = Tangent::free(k.in_.x, y);
        }
    }
    keys[i].continuity = continuity;
    Animated::Keyframed(keys.into_iter().collect(), *ex)
}

/// Patch the track's extrapolation, one side or both; a `Static` track has
/// none and is returned as is.
pub fn set_extrapolation(
    track: &Animated<f64>,
    before: Option<Extrapolate>,
    after: Option<Extrapolate>,
) -> Animated<f64> {
    let Animated::Keyframed(kfs, ex) = track else {
        return track.clone();
    };
    Animated::Keyframed(
        kfs.clone(),
        Extrapolation {
            before: before.unwrap_or(ex.before),
            after: after.unwrap_or(ex.after),
        },
    )
}

/// A solved `-0.0` (a zero slope over a falling segment) is stored as `0.0`:
/// `== 0.0` holds for both signs, and the TS twin applies the same rule so
/// both sides serialize and compare the coordinate identically.
fn clamp01(v: f64) -> f64 {
    let c = v.clamp(0.0, 1.0);
    if c == 0.0 {
        0.0
    } else {
        c
    }
}

// ---------------------------------------------------------------------------
// Side slopes, in value per microsecond over the side's own segment — the
// twins of the four helpers in `src/shared/tangents.ts`, the only place a
// slope becomes a coordinate. `None` when no finite answer exists: a handle
// pointing nowhere in time (`out.x = 0`, `in.x = 1`), a segment with no span,
// or a flat segment for the inverse direction.
// ---------------------------------------------------------------------------

fn out_slope(out: Tangent, dt_next: f64, dv_next: f64) -> Option<f64> {
    if out.x == 0.0 || dt_next <= 0.0 {
        return None;
    }
    Some((out.y / out.x) * (dv_next / dt_next))
}

fn in_slope(in_: Tangent, dt_prev: f64, dv_prev: f64) -> Option<f64> {
    if in_.x == 1.0 || dt_prev <= 0.0 {
        return None;
    }
    Some(((1.0 - in_.y) / (1.0 - in_.x)) * (dv_prev / dt_prev))
}

fn in_y_for_slope(in_x: f64, m: f64, dt_prev: f64, dv_prev: f64) -> Option<f64> {
    if dv_prev == 0.0 || dt_prev <= 0.0 || in_x == 1.0 {
        return None;
    }
    Some(1.0 - (m * (1.0 - in_x) * dt_prev) / dv_prev)
}

fn out_y_for_slope(out_x: f64, m: f64, dt_next: f64, dv_next: f64) -> Option<f64> {
    if dv_next == 0.0 || dt_next <= 0.0 || out_x == 0.0 {
        return None;
    }
    Some((m * out_x * dt_next) / dv_next)
}

/// Monotone-clamped tangent (scalar per microsecond) at key `i` over the
/// scalar projections `s` and times `t`: 0 at an endpoint, a local extremum,
/// or when a neighbour delta is 0 — Blender "Auto Clamped", so an Auto key
/// never overshoots.
fn tangent_at(s: &[f64], t: &[i64], i: usize) -> f64 {
    if i == 0 || i + 1 >= s.len() {
        return 0.0;
    }
    let d_prev = s[i] - s[i - 1];
    let d_next = s[i + 1] - s[i];
    if d_prev == 0.0 || d_next == 0.0 || d_prev.signum() != d_next.signum() {
        return 0.0;
    }
    let dt = (t[i + 1] - t[i - 1]) as f64;
    if dt <= 0.0 {
        return 0.0;
    }
    (s[i + 1] - s[i - 1]) / dt
}

/// Resolve every `Auto` side and every `Smooth` pair of `Free` sides over
/// SORTED keys — the twin of `src/shared/tangents.ts::solveAutoTangents`,
/// which is the one main's write normalization runs. `scalar` projects a value
/// onto the axis the slopes are measured on; `None` (a non-scalar `T`) sends
/// Auto sides to the identity coordinates and skips the Smooth rule. A side
/// adjacent to a non-Spline segment is left alone: the engine ignores it.
pub fn solve_auto_tangents<T: Clone>(
    keys: &[Keyframe<T>],
    scalar: Option<&dyn Fn(&T) -> f64>,
) -> Vec<Keyframe<T>> {
    let n = keys.len();
    let s: Option<Vec<f64>> = scalar.map(|f| keys.iter().map(|k| f(&k.value)).collect());
    let t: Vec<i64> = keys.iter().map(|k| k.t_us).collect();
    let mut out: Vec<Keyframe<T>> = keys.to_vec();
    for i in 0..n {
        let k = &keys[i];
        let out_spline = i + 1 < n && matches!(keys[i].segment, Segment::Spline);
        let in_spline = i > 0 && matches!(keys[i - 1].segment, Segment::Spline);

        // Auto out: this key's leaving handle from the monotone slope.
        if k.out.mode == TangentMode::Auto && out_spline {
            out[i].out = match &s {
                None => Tangent {
                    x: OUT_IDENTITY.0,
                    y: OUT_IDENTITY.1,
                    mode: TangentMode::Auto,
                },
                Some(s) => {
                    let m = tangent_at(s, &t, i);
                    let dt = (t[i + 1] - t[i]) as f64;
                    let dv = s[i + 1] - s[i];
                    if dv == 0.0 || dt <= 0.0 {
                        Tangent {
                            x: OUT_IDENTITY.0,
                            y: OUT_IDENTITY.1,
                            mode: TangentMode::Auto,
                        }
                    } else {
                        Tangent {
                            x: 1.0 / 3.0,
                            y: clamp01(m * dt / (3.0 * dv)),
                            mode: TangentMode::Auto,
                        }
                    }
                }
            };
        }

        // Auto in: this key's arriving handle from the same slope.
        if k.in_.mode == TangentMode::Auto && in_spline {
            out[i].in_ = match &s {
                None => Tangent {
                    x: IN_IDENTITY.0,
                    y: IN_IDENTITY.1,
                    mode: TangentMode::Auto,
                },
                Some(s) => {
                    let m = tangent_at(s, &t, i);
                    let dt = (t[i] - t[i - 1]) as f64;
                    let dv = s[i] - s[i - 1];
                    if dv == 0.0 || dt <= 0.0 {
                        Tangent {
                            x: IN_IDENTITY.0,
                            y: IN_IDENTITY.1,
                            mode: TangentMode::Auto,
                        }
                    } else {
                        Tangent {
                            x: 2.0 / 3.0,
                            y: clamp01(1.0 - m * dt / (3.0 * dv)),
                            mode: TangentMode::Auto,
                        }
                    }
                }
            };
        }

        // Smooth continuity over two Free sides: OUT WINS — the arriving handle
        // is re-aimed so its slope equals the leaving handle's (deterministic
        // because main cannot know which handle was dragged).
        if let Some(s) = &s {
            if k.continuity == Continuity::Smooth
                && k.in_.mode == TangentMode::Free
                && k.out.mode == TangentMode::Free
                && out_spline
                && in_spline
            {
                let dt_next = (t[i + 1] - t[i]) as f64;
                let dv_next = s[i + 1] - s[i];
                let dt_prev = (t[i] - t[i - 1]) as f64;
                let dv_prev = s[i] - s[i - 1];
                if let Some(y) = out_slope(k.out, dt_next, dv_next)
                    .and_then(|m| in_y_for_slope(k.in_.x, m, dt_prev, dv_prev))
                {
                    out[i].in_.y = y;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A distinctive Spline easing for identity/inheritance assertions (the
    /// CSS ease-in cubic — any recognizable `Bezier` would do).
    const EASE_IN: Interpolation = Interpolation::Bezier {
        p1: (0.42, 0.0),
        p2: (1.0, 1.0),
    };

    fn kf(id: u128, t_us: i64, value: f64, segment: Segment) -> Keyframe<f64> {
        Keyframe {
            id: uuid::Uuid::from_u128(id),
            t_us,
            value,
            in_: Tangent::in_identity(),
            out: Tangent::out_identity(),
            continuity: Continuity::Broken,
            segment,
        }
    }
    fn keyframed(kfs: Vec<Keyframe<f64>>) -> Animated<f64> {
        Animated::Keyframed(kfs.into_iter().collect(), Extrapolation::HOLD)
    }
    fn keys(track: &Animated<f64>) -> Vec<Keyframe<f64>> {
        match track {
            Animated::Keyframed(k, _) => k.iter().cloned().collect(),
            Animated::Static(_) => vec![],
        }
    }
    fn ids(track: &Animated<f64>) -> Vec<KeyframeId> {
        keys(track).iter().map(|x| x.id).collect()
    }
    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn upsert_lifts_static_with_identity_sides_and_hold_extrapolation() {
        let out = upsert(&Animated::Static(0.5), 1_000_000, 0.9, None);
        let Animated::Keyframed(kfs, ex) = &out else {
            panic!("lifted")
        };
        assert_eq!(kfs.len(), 1);
        assert_eq!(kfs[0].t_us, 1_000_000);
        assert!(near(kfs[0].value, 0.9));
        assert_eq!(kfs[0].segment, Segment::Linear);
        assert_eq!(kfs[0].out, Tangent::out_identity());
        assert_eq!(kfs[0].in_, Tangent::in_identity());
        assert_eq!(kfs[0].continuity, Continuity::Broken);
        assert_eq!(*ex, Extrapolation::HOLD);
    }

    #[test]
    fn upsert_lifts_static_with_a_given_easing_on_the_lone_key() {
        let out = upsert(&Animated::Static(0.5), 0, 0.9, Some(EASE_IN));
        let k = &keys(&out)[0];
        assert_eq!(k.segment, Segment::Spline);
        assert_eq!(k.out, Tangent::free(0.42, 0.0));
        assert_eq!(k.in_, Tangent::in_identity(), "no right key to write");
    }

    #[test]
    fn upsert_updates_existing_preserves_id_and_shape() {
        let mut a = kf(1, 0, 0.0, Segment::Spline);
        a.out = Tangent::free(0.42, 0.0);
        let tr = keyframed(vec![a]);
        let id_before = ids(&tr);
        let out = upsert(&tr, 0, 0.7, None);
        assert_eq!(ids(&out), id_before, "id preserved on in-place update");
        let k = &keys(&out)[0];
        assert!(near(k.value, 0.7));
        assert_eq!(k.segment, Segment::Spline);
        assert_eq!(k.out, Tangent::free(0.42, 0.0), "shape preserved when None");
    }

    #[test]
    fn upsert_insert_inherits_the_preceding_segment_and_both_handles() {
        // A→B is ease_in (A.out = p1, B.in = p2); inserting K between them
        // repeats the ease on both halves.
        let mut a = kf(1, 0, 0.0, Segment::Spline);
        a.out = Tangent::free(0.42, 0.0);
        let mut b = kf(2, 2_000_000, 1.0, Segment::Linear);
        b.in_ = Tangent::free(1.0, 1.0);
        let out = upsert(&keyframed(vec![a, b]), 1_000_000, 0.5, None);
        let k = keys(&out);
        assert_eq!(k.len(), 3);
        assert_eq!(k[1].t_us, 1_000_000);
        assert_eq!(k[1].segment, Segment::Spline);
        assert_eq!(k[1].out, Tangent::free(0.42, 0.0));
        assert_eq!(k[1].in_, Tangent::free(1.0, 1.0));
        assert_eq!(k[1].continuity, Continuity::Broken);
        assert_eq!(k[2].in_, Tangent::free(1.0, 1.0), "B untouched");
    }

    #[test]
    fn upsert_insert_before_first_is_linear_identity() {
        let out = upsert(
            &keyframed(vec![kf(1, 2_000_000, 1.0, Segment::Hold)]),
            0,
            0.0,
            None,
        );
        let k = keys(&out);
        assert_eq!(k[0].t_us, 0);
        assert_eq!(k[0].segment, Segment::Linear);
        assert_eq!(k[0].out, Tangent::out_identity());
    }

    #[test]
    fn upsert_with_easing_writes_the_segment_to_the_next_key() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Segment::Linear),
            kf(2, 2_000_000, 1.0, Segment::Linear),
        ]);
        let out = upsert(&tr, 1_000_000, 0.5, Some(EASE_IN));
        let k = keys(&out);
        assert_eq!(k[1].segment, Segment::Spline);
        assert_eq!(k[1].out, Tangent::free(0.42, 0.0));
        assert_eq!(k[2].in_, Tangent::free(1.0, 1.0));
        assert_eq!(
            k[0].segment,
            Segment::Linear,
            "the preceding segment is untouched"
        );
    }

    #[test]
    fn remove_last_collapses_to_removed_value() {
        let tr = keyframed(vec![kf(1, 0, 0.33, Segment::Linear)]);
        let out = remove(&tr, uuid::Uuid::from_u128(1), 999.0);
        assert!(matches!(out, Animated::Static(v) if (v - 0.33).abs() < 1e-9));
    }

    #[test]
    fn remove_keeps_the_extrapolation() {
        let tr = Animated::Keyframed(
            vec![
                kf(1, 0, 0.0, Segment::Linear),
                kf(2, 1_000_000, 1.0, Segment::Linear),
            ]
            .into_iter()
            .collect(),
            Extrapolation {
                before: Extrapolate::Loop,
                after: Extrapolate::Loop,
            },
        );
        let out = remove(&tr, uuid::Uuid::from_u128(1), 0.0);
        assert_eq!(out.extrapolation().after, Extrapolate::Loop);
    }

    #[test]
    fn set_tangent_and_set_continuity_leave_a_static_or_idless_track_alone() {
        let st = Animated::Static(2.0);
        assert!(matches!(
            set_tangent(&st, uuid::Uuid::from_u128(9), Side::Out, 0.5, 0.5),
            Animated::Static(v) if v == 2.0
        ));
        let tr = keyframed(vec![kf(1, 0, 0.0, Segment::Linear)]);
        let missing = uuid::Uuid::from_u128(9);
        assert_eq!(
            keys(&set_tangent(&tr, missing, Side::Out, 0.5, 0.5))[0].out,
            Tangent::out_identity()
        );
        assert_eq!(
            keys(&set_continuity(&tr, missing, Continuity::Smooth))[0].continuity,
            Continuity::Broken
        );
    }

    #[test]
    fn set_extrapolation_patches_only_the_named_side_and_skips_static() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Segment::Linear),
            kf(2, 1_000_000, 1.0, Segment::Linear),
        ]);
        let out = set_extrapolation(&tr, None, Some(Extrapolate::Offset));
        assert_eq!(
            out.extrapolation(),
            Extrapolation {
                before: Extrapolate::Hold,
                after: Extrapolate::Offset
            }
        );
        assert!(matches!(
            set_extrapolation(&Animated::Static(1.0), Some(Extrapolate::Loop), None),
            Animated::Static(_)
        ));
    }

    #[test]
    fn side_slope_helpers_invert_each_other() {
        // A leaving handle's slope, fed back through the inverse, returns its y.
        let out = Tangent::free(0.25, 0.8);
        let m = out_slope(out, 2_000_000.0, 3.0).unwrap();
        assert!(near(
            out_y_for_slope(out.x, m, 2_000_000.0, 3.0).unwrap(),
            out.y
        ));
        let in_ = Tangent::free(0.6, 0.1);
        let m = in_slope(in_, 500_000.0, -2.0).unwrap();
        assert!(near(
            in_y_for_slope(in_.x, m, 500_000.0, -2.0).unwrap(),
            in_.y
        ));
        // Degenerate bounds have no finite answer.
        assert_eq!(out_slope(Tangent::free(0.0, 1.0), 1.0, 1.0), None);
        assert_eq!(in_slope(Tangent::free(1.0, 1.0), 1.0, 1.0), None);
        assert_eq!(in_y_for_slope(0.5, 1.0, 1.0, 0.0), None);
        assert_eq!(out_y_for_slope(0.0, 1.0, 1.0, 1.0), None);
    }

    #[test]
    fn retime_resorts() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Segment::Linear),
            kf(2, 2_000_000, 1.0, Segment::Linear),
        ]);
        let out = retime(&tr, uuid::Uuid::from_u128(1), 3_000_000);
        let k = keys(&out);
        assert_eq!(
            k.iter().map(|k| k.t_us).collect::<Vec<_>>(),
            vec![2_000_000, 3_000_000]
        );
        assert!(near(k[1].value, 0.0), "moved key keeps its value");
    }

    #[test]
    fn segment_easing_round_trips_through_apply() {
        let a = kf(1, 0, 0.0, Segment::Linear);
        let b = kf(2, 1_000_000, 1.0, Segment::Linear);
        for e in [
            Interpolation::Hold,
            Interpolation::Linear,
            EASE_IN,
            Interpolation::Elastic {
                dir: EaseDir::Out,
                amplitude: 1.5,
                period: 0.45,
            },
            Interpolation::Bounce {
                dir: EaseDir::InOut,
            },
        ] {
            let (l, r) = apply_segment_easing(&a, Some(&b), e);
            assert_eq!(segment_easing(&l, &r.unwrap()), e, "{e:?}");
            assert_eq!(l.out.mode, TangentMode::Free);
        }
    }

    #[test]
    fn set_segment_easing_writes_both_sides_free() {
        let mut b = kf(2, 2_000_000, 1.0, Segment::Linear);
        b.in_.mode = TangentMode::Auto;
        let tr = keyframed(vec![kf(1, 0, 0.0, Segment::Linear), b]);
        let out = set_segment_easing(&tr, uuid::Uuid::from_u128(1), EASE_IN);
        let k = keys(&out);
        assert_eq!(k[0].segment, Segment::Spline);
        assert_eq!(k[0].out, Tangent::free(0.42, 0.0));
        assert_eq!(k[1].in_, Tangent::free(1.0, 1.0));
    }

    #[test]
    fn set_auto_flips_modes_and_splines_both_neighbouring_segments() {
        let tr = keyframed(vec![
            kf(
                1,
                0,
                0.0,
                Segment::Elastic {
                    dir: EaseDir::Out,
                    amplitude: 1.0,
                    period: 0.3,
                },
            ),
            kf(2, 1_000_000, 1.0, Segment::Linear),
            kf(3, 2_000_000, 2.0, Segment::Linear),
        ]);
        let out = set_auto(&tr, &[uuid::Uuid::from_u128(2)]);
        let k = keys(&out);
        assert_eq!(k[0].segment, Segment::Spline, "prev segment becomes Spline");
        assert_eq!(k[0].out, Tangent::out_identity(), "coords untouched");
        assert_eq!(k[1].in_.mode, TangentMode::Auto);
        assert_eq!(k[1].out.mode, TangentMode::Auto);
        assert_eq!(k[1].continuity, Continuity::Smooth);
        assert_eq!(k[1].segment, Segment::Spline);
        assert_eq!(k[1].in_.x, IN_IDENTITY.0, "coords untouched until solve");
        assert_eq!(
            k[2].segment,
            Segment::Linear,
            "the last key's class is unread"
        );
    }

    #[test]
    fn solve_reproduces_the_monotone_smooth_numbers() {
        // Ramp 0 → 1 → 2 over 1 s steps, middle key Auto: m = 2/2 s, so
        // out.y = m·dt/(3·dv) = 1/3 and in.y = 1 − 1/3 = 2/3.
        let tr = set_auto(
            &keyframed(vec![
                kf(1, 0, 0.0, Segment::Linear),
                kf(2, 1_000_000, 1.0, Segment::Linear),
                kf(3, 2_000_000, 2.0, Segment::Linear),
            ]),
            &[uuid::Uuid::from_u128(2)],
        );
        let solved = solve_auto_tangents(&keys(&tr), Some(&|v: &f64| *v));
        assert_eq!(solved[1].out.x, 1.0 / 3.0);
        assert!(near(solved[1].out.y, 1.0 / 3.0));
        assert_eq!(solved[1].in_.x, 2.0 / 3.0);
        assert!(near(solved[1].in_.y, 2.0 / 3.0));
        assert_eq!(
            solved[1].out.mode,
            TangentMode::Auto,
            "mode survives the solve"
        );
        // A peak is a flat extremum: out.y = 0, in.y = 1.
        let peak = set_auto(
            &keyframed(vec![
                kf(1, 0, 0.0, Segment::Linear),
                kf(2, 1_000_000, 1.0, Segment::Linear),
                kf(3, 2_000_000, 0.0, Segment::Linear),
            ]),
            &[uuid::Uuid::from_u128(2)],
        );
        let solved = solve_auto_tangents(&keys(&peak), Some(&|v: &f64| *v));
        assert_eq!(solved[1].out.y, 0.0);
        assert_eq!(solved[1].in_.y, 1.0);
    }

    #[test]
    fn solve_sends_a_degenerate_or_scalarless_auto_side_to_the_identity() {
        // Flat segment (Δv = 0) → identity coords, mode kept Auto.
        let flat = set_auto(
            &keyframed(vec![
                kf(1, 0, 5.0, Segment::Linear),
                kf(2, 1_000_000, 5.0, Segment::Linear),
            ]),
            &[uuid::Uuid::from_u128(1)],
        );
        let solved = solve_auto_tangents(&keys(&flat), Some(&|v: &f64| *v));
        assert_eq!(solved[0].out.x, OUT_IDENTITY.0);
        assert_eq!(solved[0].out.y, OUT_IDENTITY.1);
        assert_eq!(solved[0].out.mode, TangentMode::Auto);
        // No scalar → identity with mode Auto as well.
        let no_scalar = solve_auto_tangents(&keys(&flat), None);
        assert_eq!(no_scalar[0].out.x, OUT_IDENTITY.0);
        assert_eq!(no_scalar[0].out.mode, TangentMode::Auto);
    }

    #[test]
    fn solve_leaves_auto_sides_next_to_non_spline_segments_alone() {
        let mut k0 = kf(1, 0, 0.0, Segment::Linear);
        k0.out = Tangent {
            x: 0.9,
            y: 0.1,
            mode: TangentMode::Auto,
        };
        let solved = solve_auto_tangents(
            &[k0, kf(2, 1_000_000, 1.0, Segment::Linear)],
            Some(&|v: &f64| *v),
        );
        assert_eq!(solved[0].out.x, 0.9);
        assert_eq!(solved[0].out.y, 0.1);
    }

    #[test]
    fn solve_smooth_free_pair_re_aims_the_arriving_handle_from_the_leaving_one() {
        // Both segments Spline, middle key Smooth with two Free sides. out =
        // (1/3, 1/3) on 0→1 over 1 s → slope m = 1 per s; in.x = 2/3 over the
        // 1 s / Δv 1 arriving segment → in.y = 1 − 1·(1/3)·1/1 = 2/3.
        let mut a = kf(1, 0, 0.0, Segment::Spline);
        a.out = Tangent::free(0.0, 0.0);
        let mut k = kf(2, 1_000_000, 1.0, Segment::Spline);
        k.continuity = Continuity::Smooth;
        k.in_ = Tangent::free(2.0 / 3.0, 0.0);
        let solved = solve_auto_tangents(
            &[a, k, kf(3, 2_000_000, 2.0, Segment::Linear)],
            Some(&|v: &f64| *v),
        );
        assert_eq!(solved[1].in_.x, 2.0 / 3.0, "in.x kept");
        assert!(near(solved[1].in_.y, 2.0 / 3.0));
        assert_eq!(
            solved[1].out,
            Tangent::out_identity(),
            "out wins, untouched"
        );
    }

    #[derive(serde::Deserialize)]
    struct GoldenArgs {
        t_us: Option<i64>,
        value: Option<f64>,
        id: Option<String>,
        ids: Option<Vec<String>>,
        fallback: Option<f64>,
        new_t_us: Option<i64>,
        easing: Option<Interpolation>,
        side: Option<Side>,
        x: Option<f64>,
        y: Option<f64>,
        continuity: Option<Continuity>,
        before: Option<Extrapolate>,
        after: Option<Extrapolate>,
    }
    #[derive(serde::Deserialize)]
    struct GoldenCase {
        name: String,
        op: String,
        args: GoldenArgs,
        input: Animated<f64>,
        expect: Animated<f64>,
    }
    #[derive(serde::Deserialize)]
    struct GoldenFixture {
        cases: Vec<GoldenCase>,
    }

    fn apply_op(track: &Animated<f64>, op: &str, args: &GoldenArgs) -> Animated<f64> {
        let id = || uuid::Uuid::parse_str(args.id.as_ref().unwrap()).unwrap();
        match op {
            "upsert" => upsert(track, args.t_us.unwrap(), args.value.unwrap(), args.easing),
            "remove" => remove(track, id(), args.fallback.unwrap()),
            "retime" => retime(track, id(), args.new_t_us.unwrap()),
            "set_segment_easing" => set_segment_easing(track, id(), args.easing.unwrap()),
            "set_auto" => {
                let ids: Vec<KeyframeId> = args
                    .ids
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|s| uuid::Uuid::parse_str(s).unwrap())
                    .collect();
                set_auto(track, &ids)
            }
            "set_tangent" => set_tangent(
                track,
                id(),
                args.side.unwrap(),
                args.x.unwrap(),
                args.y.unwrap(),
            ),
            "set_continuity" => set_continuity(track, id(), args.continuity.unwrap()),
            "set_extrapolation" => set_extrapolation(track, args.before, args.after),
            "solve" => match track {
                Animated::Keyframed(kfs, ex) => {
                    let keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
                    Animated::Keyframed(
                        solve_auto_tangents(&keys, Some(&|v: &f64| *v))
                            .into_iter()
                            .collect(),
                        *ex,
                    )
                }
                Animated::Static(_) => track.clone(),
            },
            other => panic!("unknown op {other}"),
        }
    }

    /// Tangent equality as the golden defines it: `x` exact (the values are
    /// `1/3` / `2/3` expressions or fixture literals on both sides), `y` within
    /// `1e-9` (solved), mode exact.
    fn tangent_eq(a: Tangent, b: Tangent) -> bool {
        a.x == b.x && (a.y - b.y).abs() < 1e-9 && a.mode == b.mode
    }

    /// Same fixture as `keyframe/edits.golden.test.ts`; a change that passes one
    /// language and fails the other is a Rust↔TS drift, which is what this catches.
    #[test]
    fn golden_vectors_match_fixture() {
        let fixture: GoldenFixture = serde_json::from_str(include_str!(
            "../../../src/renderer/keyframe/keyframeEditsGolden.fixture.json"
        ))
        .expect("fixture parses");
        assert!(!fixture.cases.is_empty());
        for c in &fixture.cases {
            let got = apply_op(&c.input, &c.op, &c.args);
            match (&got, &c.expect) {
                (Animated::Static(g), Animated::Static(w)) => {
                    assert!((g - w).abs() < 1e-9, "case `{}` static value", c.name);
                }
                (Animated::Keyframed(g, gex), Animated::Keyframed(w, wex)) => {
                    assert_eq!(gex, wex, "case `{}` extrapolate", c.name);
                    assert_eq!(g.len(), w.len(), "case `{}` key count", c.name);
                    for (gk, wk) in g.iter().zip(w.iter()) {
                        assert_eq!(gk.t_us, wk.t_us, "case `{}` t_us", c.name);
                        assert!(
                            (gk.value - wk.value).abs() < 1e-9,
                            "case `{}` value",
                            c.name
                        );
                        assert!(
                            tangent_eq(gk.in_, wk.in_),
                            "case `{}` in at t={}: got {:?}, want {:?}",
                            c.name,
                            gk.t_us,
                            gk.in_,
                            wk.in_
                        );
                        assert!(
                            tangent_eq(gk.out, wk.out),
                            "case `{}` out at t={}: got {:?}, want {:?}",
                            c.name,
                            gk.t_us,
                            gk.out,
                            wk.out
                        );
                        assert_eq!(gk.continuity, wk.continuity, "case `{}` continuity", c.name);
                        assert_eq!(gk.segment, wk.segment, "case `{}` segment", c.name);
                    }
                }
                _ => panic!("case `{}` mode mismatch", c.name),
            }
        }
    }
}
