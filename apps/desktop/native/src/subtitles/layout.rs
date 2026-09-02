use super::Cue;
use crate::state::animated::Animated;
use crate::state::color::Rgba;
use crate::state::layer::{FontSpec, Outline, Shadow, TextAlign, TextParams, VAlign};
use crate::state::transform::Transform;

pub const DEFAULT_CAPTION_FONT: &str = "Liberation Sans, Noto Sans SC";

/// Per-side safe-area margin, as a fraction of the composition edge: the inset
/// `anchor_for` positions a cue at, and — doubled — the frame width the caption
/// box gives up. One constant for both, because the position margin and the
/// wrap width have to agree and two literals that must agree are how they stop
/// agreeing. Twin in `src/main/state/mutations/captions.ts` — diff both sides
/// when you touch one.
const SAFE_AREA_MARGIN: f64 = 0.08;

/// Lay out one cue as a Text layer. Styleless cues (SRT/VTT) get the default
/// caption look: white fill, black outline + soft shadow, size 5% of comp
/// height, bottom-centre inside `SAFE_AREA_MARGIN`. The ASS 9-grid `align`
/// (or `\pos`) is converted here to an absolute anchor + position — the render
/// model stays plain x/y/anchor (no caption-specific render code).
pub fn cue_to_text_params(cue: &Cue, comp_w: u32, comp_h: u32) -> TextParams {
    let s = &cue.style;
    let size = s.size_px.unwrap_or((comp_h as f32 * 0.05).round());
    let primary = s.primary.unwrap_or(Rgba::WHITE);
    let outline_w = s.outline_px.unwrap_or(size * 0.06).max(1.0);
    let shadow_off = s.shadow_px.unwrap_or(2.0).max(1.0);

    let an = s.align.unwrap_or(2);
    let ((anchor_x, anchor_y), base_x, base_y) = anchor_for(an, comp_w as f64, comp_h as f64);
    let (raw_x, raw_y) = s.pos.unwrap_or((base_x, base_y));
    // Authored precision, matching the TS twin's `quantizeParam('x', ..)`. The
    // margin lands on a clean tenth at the standard heights (1080 -> 993.6) but on
    // a hundredth at most others (1081 -> 993.52), and an ASS `\pos` carries
    // whatever the file wrote — none of it authored at this precision by anyone.
    // `PARAM_PRECISION` in renderer/keyframe/descriptors.ts is the source of truth
    // for the place count; one decimal is the value that keeps a half-pixel
    // expressible.
    //
    // `f64::round` breaks ties away from zero, which is exactly what the TS
    // `quantize` was written to do (it takes the absolute value first for that
    // reason), so the two agree on every input these two can produce. Rounded in
    // place rather than behind a shared helper: a general cross-language quantizer
    // would be a twin in its own right, owing a golden fixture the way
    // `snap_frame_round` does, and two literals owe nothing.
    //
    // Guarded by MIRRORED unit tests on both sides — the same way this function's
    // other computed values are, since the differential corpus supplies explicit
    // style values and never reaches the paths that compute rather than copy.
    //
    // The one place the two rounding rules still part is negative zero, which TS
    // normalizes and Rust does not. Unreachable here: both values are insets of a
    // composition extent, so both are positive.
    let x = (raw_x * 10.0).round() / 10.0;
    let y = (raw_y * 10.0).round() / 10.0;

    TextParams {
        content: cue.text.clone(),
        font: FontSpec {
            family: s
                .font_family
                .clone()
                .unwrap_or_else(|| DEFAULT_CAPTION_FONT.to_string()),
            size_px: size,
            weight: if s.bold { 700 } else { 400 },
            italic: s.italic,
        },
        color: Animated::Static(primary),
        align: align_for(an),
        transform: Transform {
            x: Animated::Static(x),
            y: Animated::Static(y),
            anchor_x: Animated::Static(anchor_x),
            anchor_y: Animated::Static(anchor_y),
            ..Default::default()
        },
        opacity: Animated::Static(1.0),
        shadow: Some(Shadow {
            color: Rgba::BLACK,
            offset_x: shadow_off,
            offset_y: shadow_off,
            blur: shadow_off,
        }),
        outline: Some(Outline {
            color: s.outline_color.unwrap_or(Rgba::BLACK),
            width: outline_w,
        }),
        intro: None,
        outro: None,
        // Auto height, never Fixed: it wraps a transcript's unbroken line
        // without shrinking, so every cue keeps the size its style asked for.
        // Fixed would compress the long ones and make two cues of one file
        // render at different sizes. `box_w` is f32, the margin math f64 — cast
        // at the boundary, explicitly. See ADR 0049.
        //
        // ROUNDED BEFORE THE CAST, to whole pixels (BOX_PRECISION), and the order
        // matters: the box is authored in integers, so rounding first makes the f32
        // exact and the cast lossless. Casting first would leave the two sides
        // rounding different values on a tie.
        box_w: Some((comp_w as f64 * (1.0 - 2.0 * SAFE_AREA_MARGIN)).round() as f32),
        box_h: None,
        // Never observable in Auto height — the box's height tracks the content.
        valign: VAlign::default(),
        line_height: 0.0,
        letter_spacing: 0.0,
    }
}

/// ASS 9-grid → (anchor, x, y). 1-3 bottom, 4-6 middle, 7-9 top; 1/4/7 left,
/// 2/5/8 centre, 3/6/9 right, inset by `SAFE_AREA_MARGIN` on both axes.
fn anchor_for(an: u8, w: f64, h: f64) -> ((f64, f64), f64, f64) {
    let mx = w * SAFE_AREA_MARGIN;
    let my = h * SAFE_AREA_MARGIN;
    let (ax, x) = match an {
        1 | 4 | 7 => (0.0, mx),
        3 | 6 | 9 => (1.0, w - mx),
        _ => (0.5, w / 2.0),
    };
    let (ay, y) = match an {
        7..=9 => (0.0, my),
        4..=6 => (0.5, h / 2.0),
        _ => (1.0, h - my),
    };
    ((ax, ay), x, y)
}

fn align_for(an: u8) -> TextAlign {
    match an {
        1 | 4 | 7 => TextAlign::Left,
        3 | 6 | 9 => TextAlign::Right,
        _ => TextAlign::Center,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subtitles::{Cue, CueStyle};

    fn cue(style: CueStyle) -> Cue {
        Cue {
            start_us: 0,
            end_us: 1,
            text: "hi".into(),
            style,
        }
    }

    #[test]
    fn styleless_cue_gets_bottom_center_default() {
        let p = cue_to_text_params(&cue(CueStyle::default()), 1920, 1080);
        assert_eq!(p.font.family, "Liberation Sans, Noto Sans SC");
        assert_eq!(p.font.size_px, 54.0); // round(1080 * 0.05)
        assert!(p.outline.is_some());
        assert!(p.shadow.is_some());
        // an2: bottom-center → anchor (0.5, 1.0), x = w/2, y = h - 8%
        assert_eq!(static_anchor(&p.transform), (0.5, 1.0));
        match (&p.transform.x, &p.transform.y) {
            (Animated::Static(x), Animated::Static(y)) => {
                assert_eq!(*x, 960.0);
                assert!((*y - (1080.0 - 1080.0 * 0.08)).abs() < 0.5);
            }
            _ => panic!("static xy expected"),
        }
        // Auto height: a wrap width so an unbroken transcript line stays inside
        // the safe area, and no height so it wraps without ever shrinking.
        // 1920 less the margin per side is 1612.8, rounded to a whole pixel
        // because the box lays glyphs out. Exact, not toleranced: rounding before
        // the f32 cast is what makes the cast lossless, so a tolerance here would
        // hide the two coming apart.
        assert_eq!(p.box_w.expect("a cue is born with a wrap width"), 1613.0);
        assert!(p.box_h.is_none());
    }

    /// The layout arithmetic is the only place a POSITION is computed rather than
    /// authored, so it is the only place that can put digits nobody chose into the
    /// store — at scale, since one import writes a layer per cue. Twin of
    /// `layout positions land on the authored precision` in
    /// state/mutations/captions.test.ts. This pair IS the cross-language guard:
    /// the differential corpus supplies explicit style values and never reaches
    /// the paths that compute rather than copy.
    #[test]
    fn layout_positions_land_on_the_authored_precision() {
        // 1081 - 1081 * 0.08 = 994.52, a hundredth of a pixel. The standard
        // heights happen to come out clean (1080 -> 993.6), which is exactly why an
        // unrounded path could ship unnoticed.
        let p = cue_to_text_params(&cue(CueStyle::default()), 1920, 1081);
        match &p.transform.y {
            Animated::Static(y) => assert_eq!(*y, 994.5),
            _ => panic!("static y expected"),
        }
    }

    /// An explicit `\pos` is an authored position and is rounded like one.
    #[test]
    fn explicit_pos_is_rounded_like_any_authored_position() {
        let s = CueStyle {
            align: Some(1),
            pos: Some((100.373737, 200.06)),
            ..CueStyle::default()
        };
        let p = cue_to_text_params(&cue(s), 1920, 1080);
        match (&p.transform.x, &p.transform.y) {
            (Animated::Static(x), Animated::Static(y)) => assert_eq!((*x, *y), (100.4, 200.1)),
            _ => panic!("static xy expected"),
        }
    }

    #[test]
    fn an8_top_center_anchors_top() {
        let s = CueStyle {
            align: Some(8),
            ..CueStyle::default()
        };
        let p = cue_to_text_params(&cue(s), 1920, 1080);
        assert_eq!(static_anchor(&p.transform), (0.5, 0.0));
    }

    /// The box wraps; it never relocates. An ASS cue carrying both `\an` and an
    /// explicit `\pos` keeps its 9-grid alignment and its absolute position, and
    /// gets the same wrap width as a positionless cue.
    #[test]
    fn explicit_pos_and_an_survive_the_box() {
        let s = CueStyle {
            align: Some(1), // bottom-left
            pos: Some((100.0, 200.0)),
            ..CueStyle::default()
        };
        let p = cue_to_text_params(&cue(s), 1920, 1080);
        assert_eq!(static_anchor(&p.transform), (0.0, 1.0));
        match (&p.transform.x, &p.transform.y) {
            (Animated::Static(x), Animated::Static(y)) => assert_eq!((*x, *y), (100.0, 200.0)),
            _ => panic!("static xy expected"),
        }
        assert_eq!(p.align, TextAlign::Left);
        assert_eq!(p.box_w.expect("wrap width"), 1613.0);
        assert!(p.box_h.is_none());
    }

    /// The wrap width tracks the composition, not a hardcoded 1920.
    #[test]
    fn wrap_width_scales_with_the_composition() {
        let p = cue_to_text_params(&cue(CueStyle::default()), 640, 360);
        assert_eq!(p.box_w.expect("wrap width"), 538.0); // round(640 * 0.84)
    }

    /// The anchor pair as plain numbers. `\an` import always writes Static, so a
    /// Keyframed track here means the layout path grew an animation it shouldn't
    /// have — panic rather than silently reading the first key.
    fn static_anchor(t: &Transform) -> (f64, f64) {
        match (&t.anchor_x, &t.anchor_y) {
            (Animated::Static(x), Animated::Static(y)) => (*x, *y),
            _ => panic!("static anchor expected"),
        }
    }
}
