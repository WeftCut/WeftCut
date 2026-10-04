use super::*;
use weftcut_eval::{Segment, IN_IDENTITY, OUT_IDENTITY};
fn key(t_us: f64, value: f64) -> Kf {
    Kf {
        t_us,
        value,
        in_: IN_IDENTITY,
        out: OUT_IDENTITY,
        segment: Segment::Linear,
    }
}
fn options() -> Options {
    Options {
        fps_num: 30,
        fps_den: 1,
        start_frame: 0,
        end_frame: 60,
        tolerance_px: 0.5,
        every_frames: 1,
        xy_mode: XyMode::Editable,
    }
}
fn request(keys: Vec<Kf>) -> Request {
    Request {
        nodes: Some(vec![
            Node {
                point: Point { x: 0.0, y: 20.0 },
                ..Node::ZERO
            },
            Node {
                point: Point { x: 300.0, y: 20.0 },
                ..Node::ZERO
            },
        ]),
        tracks: vec![Track {
            keys,
            extrapolate: Extrapolation::HOLD,
        }],
        options: options(),
    }
}
#[test]
fn sparse_line_and_independent_static_axis() {
    let result = convert(request(vec![key(0.0, 0.0), key(2e6, 1.0)])).unwrap();
    assert!(result.within_tolerance);
    assert_eq!(result.tracks[0].keys.len(), 2);
    assert_eq!(result.tracks[1].keys.len(), 1);
    assert!(result.max_error_px < 1e-9);
}
#[test]
fn rests_retain_only_motion_and_pause_boundaries() {
    let mut source = request(vec![
        key(1e6, 0.0),
        key(2e6, 0.5),
        key(3e6, 0.5),
        key(4e6, 1.0),
    ]);
    source.options.end_frame = 150;
    let result = convert(source).unwrap();
    let times: Vec<_> = result.tracks[0].keys.iter().map(|k| k.t_us).collect();
    assert_eq!(times, vec![1e6, 2e6, 3e6, 4e6]);
    assert!(result.within_tolerance);
}
#[test]
fn equal_endpoint_excursion_preserves_turn() {
    let result = convert(request(vec![key(0.0, 0.0), key(1e6, 1.0), key(2e6, 0.0)])).unwrap();
    assert!(result.within_tolerance);
    assert_eq!(result.tracks[0].keys.len(), 3);
    assert_eq!(result.tracks[0].at(1e6), 300.0);
}
#[test]
fn redundant_authored_keys_are_removed() {
    let result = convert(request(
        (0..=60)
            .map(|f| key(options().time(f), options().time(f) / 2e6))
            .collect(),
    ))
    .unwrap();
    assert_eq!(result.tracks[0].keys.len(), 2);
    assert!(result.within_tolerance);
}
#[test]
fn cubic_timing_uses_two_editable_keys() {
    let mut a = key(0.0, 0.0);
    let mut b = key(2e6, 1.0);
    a.segment = Segment::Spline;
    a.out.1 = 0.0;
    b.in_.1 = 1.0;
    let result = convert(request(vec![a, b])).unwrap();
    assert!(result.within_tolerance);
    assert_eq!(result.tracks[0].keys.len(), 2);
    assert_eq!(result.tracks[0].keys[0].segment, Segment::Spline);
}
#[test]
fn stationary_multinode_path_collapses_both_axes() {
    let result = convert(request(vec![key(0.0, 0.4)])).unwrap();
    assert_eq!(result.sample_count, 0);
    assert_eq!(result.tracks[0].at(1e6), 120.0);
    assert_eq!(result.tracks[1].at(1e6), 20.0);
}
#[test]
fn explicit_bake_retains_grid_and_capacity() {
    let mut source = request(vec![key(0.0, 0.0), key(2e6, 1.0)]);
    source.options.xy_mode = XyMode::Bake;
    let result = convert(source).unwrap();
    assert_eq!(result.tracks[0].keys.len(), 61);
    assert_eq!(result.tracks[1].keys.len(), 61);
    let mut source = request(vec![key(0.0, 0.0), key(2e6, 1.0)]);
    source.options.xy_mode = XyMode::Bake;
    source.options.end_frame = 4096;
    assert_eq!(convert(source).err(), Some("conversion_capacity_error"));
}
#[test]
fn long_sparse_conversion_has_no_arbitrary_frame_range_cap() {
    let mut source = request(vec![key(0.0, 0.0), key(2e6, 1.0)]);
    source.options.end_frame = 20000;
    let result = convert(source).unwrap();
    assert!(result.within_tolerance);
    assert_eq!(result.tracks[0].keys.len(), 2);
}
#[test]
fn dense_source_with_extra_clip_endpoints_can_still_simplify() {
    let mut source = request(
        (1..=4096)
            .map(|f| key(options().time(f), f as f64 / 4096.0))
            .collect(),
    );
    source.options.end_frame = 4200;
    let result = convert(source).unwrap();
    assert!(result.within_tolerance);
    assert_eq!(result.tracks[0].keys.len(), 2);
}
#[test]
fn fractional_fps_keys_remain_canonical() {
    let mut source = request(vec![key(0.0, 0.0), key(2_002_000.0, 1.0)]);
    source.options.fps_num = 30000;
    source.options.fps_den = 1001;
    let result = convert(source).unwrap();
    assert!(result.within_tolerance);
    for track in result.tracks {
        for k in track.keys {
            assert_eq!(
                weftcut_eval::snap_frame_round(k.t_us as i64, 30000, 1001) as f64,
                k.t_us
            );
        }
    }
}
#[test]
fn subframe_excursion_is_not_claimed_as_success() {
    let mut source = request(vec![
        key(0.0, 0.0),
        key(8333.0, 1.0),
        key(16667.0, 0.0),
        key(33333.0, 0.0),
    ]);
    source.options.end_frame = 1;
    let result = convert(source).unwrap();
    assert!(!result.within_tolerance);
    assert_eq!(result.limit, Some("frame_grid"));
}
#[test]
fn jump_rejected_but_pingpong_is_continuous() {
    let mut source = request(vec![key(0.0, 0.0), key(2e6, 1.0)]);
    source.tracks[0].keys[0].segment = Segment::Hold;
    assert_eq!(convert(source).err(), Some("jump_error"));
    let mut source = request(vec![key(0.0, 0.0), key(2e6, 1.0)]);
    source.tracks[0].extrapolate.after = Extrapolate::PingPong;
    source.options.end_frame = 180;
    let result = convert(source).unwrap();
    assert!(result.within_tolerance);
    assert_eq!(result.tracks[0].at(4e6), 0.0);
}
#[test]
fn curved_path_respects_joint_pixel_error() {
    let mut source = request(vec![key(0.0, 0.0), key(2e6, 1.0)]);
    let nodes = source.nodes.as_mut().unwrap();
    nodes[0].cubic = true;
    nodes[0].outgoing = Point { x: 0.0, y: 300.0 };
    nodes[1].incoming = Point { x: 0.0, y: 300.0 };
    let original = Compiled::new(nodes);
    let result = convert(source).unwrap();
    assert!(result.within_tolerance);
    assert!(result.sample_count < 30);
    for i in 0..480 {
        let t = i as f64 * 2e6 / 480.0;
        let actual = Point {
            x: result.tracks[0].at(t),
            y: result.tracks[1].at(t),
        };
        assert!(actual.distance(original.at(t / 2e6)) < 0.6);
    }
}
#[test]
fn spatial_fitter_retains_circle_order_and_node_limit() {
    let points: Vec<_> = (0..=720)
        .map(|i| {
            let a = i as f64 * std::f64::consts::PI / 360.0;
            Point {
                x: 100.0 * a.cos(),
                y: 100.0 * a.sin(),
            }
        })
        .collect();
    let fit = spatial::fit(&points, 0.1);
    assert!(!fit.limited);
    assert!(fit.nodes.len() < 32);
    assert!(fit.progress.windows(2).all(|p| p[0] <= p[1]));
    let path = Compiled::new(&fit.nodes);
    for (i, p) in points.iter().enumerate() {
        assert!(path.at(fit.progress[i]).distance(*p) < 0.12);
    }
    let points: Vec<_> = (0..600)
        .map(|i| Point {
            x: i as f64,
            y: (i % 2) as f64 * 100.0,
        })
        .collect();
    let fit = spatial::fit(&points, 0.01);
    assert!(fit.limited);
    assert_eq!(fit.nodes.len(), 128);
}
