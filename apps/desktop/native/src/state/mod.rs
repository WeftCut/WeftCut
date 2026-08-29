//! Project state model: the document types, their serde, and the shared
//! command-surface types (errors, media patches) — the Rust↔TS wire contract.
//! No actor machinery lives here; the TS state actor is the only writer.
//!
//! Design: `docs/data-model.md`.

// The `pub use` block below re-exports the state crate's whole surface for
// consumers (commands, MCP, tests). Many are not yet wired in the lib build
// but are intentionally public.
#![allow(unused_imports)]

pub mod animated;
pub mod audio_role;
pub mod color;
pub mod command;
pub mod composition;
pub mod decode_route;
pub mod effect;
pub mod ids;
pub mod keyframe_edits;
pub mod layer;
pub mod link;
pub mod marker;
pub mod media;
pub mod project;
pub mod time;
pub mod track;
pub mod transform;
pub mod transition;

pub use command::{
    CommandError, FullProxyLanded, LatticeField, MediaDerivativesPatch, ValidationError,
};
pub use decode_route::DecodeRoute;

pub use animated::{Animated, EaseDir, Interpolation, Keyframe};
pub use audio_role::{AudioRole, RoleFlagsPatch, RoleMixSettings};
pub use color::{ColorSpace, Rgba};
pub use composition::Composition;
pub use effect::{Effect, EffectPatch};
pub use link::{index_links, Link};
pub use ids::{
    new_id, CheckpointId, CompositionId, EffectId, KeyframeId, LayerId, LinkId, MarkerId,
    MediaId, OpId, TrackId, TransitionId,
};
pub use layer::{
    AudioParams, ColorParams, CompositionRefParams, FontSpec, ImageOverlayParams, Layer,
    LayerParams, MotifParams, Outline, Shadow, TextAlign, TextAnimPreset, TextParams, VAlign,
    VideoClipParams,
};
pub use marker::Marker;
pub use media::{AudioStreamMeta, MediaItem, MediaKind, MediaMetadata, VideoStreamMeta};
pub use project::{
    Project, ProjectMetadata, ProjectSettings, ProjectSettingsPatch, TrackFlagsPatch,
};
pub use time::{snap_frame_ceil, snap_frame_floor, Rational, TimeUs, US_PER_MS, US_PER_SEC};
pub use track::{Track, TrackRole};
pub use transform::{BlendMode, Rect, Transform};
pub use transition::{Transition, TransitionDirection, TransitionKind};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixture_project() -> Project {
        // Stable values so the round-trip is deterministic — no `now()` calls.
        let media_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
        let track_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000002").unwrap();
        let layer_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000003").unwrap();
        let layer2_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000004").unwrap();
        let root_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000005").unwrap();
        let group_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000006").unwrap();
        let ref_layer_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000007").unwrap();
        let group_track_id =
            uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000008").unwrap();
        let group_layer_id =
            uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000009").unwrap();

        let media = MediaItem {
            id: media_id,
            label: Some("intro.mp4".into()),
            path_abs: "/media/intro.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width: 1920,
                    height: 1080,
                    fps_num: 30,
                    fps_den: 1,
                    codec: "h264".into(),
                    pix_fmt: "yuv420p".into(),
                    start_pts_us: None,
                    nb_frames: None,
                    color_matrix: None,
                    color_range: None,
                    color_primaries: None,
                    color_transfer: None,
                }),
                audio: Some(AudioStreamMeta {
                    sample_rate: 48_000,
                    channels: 2,
                    codec: "aac".into(),
                    start_pts_us: None,
                }),
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0000000000000000".into(),
            file_size: 12_345_678,
            file_mtime: 1_700_000_000,
            imported_at: chrono::Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        };

        let layer = Layer {
            id: layer_id,
            label: Some("intro clip".into()),
            t_start_us: 0,
            t_end_us: 5_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 5_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: BlendMode::Normal,
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
            effects: vec![],
        };

        // A Group placed in the root: exercises the `CompositionRef` variant
        // and the two-entry `compositions` map in one round trip.
        let ref_layer = Layer {
            id: ref_layer_id,
            label: None,
            t_start_us: 5_000_000,
            t_end_us: 7_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::CompositionRef(CompositionRefParams {
                composition: group_id,
                src_in_us: 0,
                src_out_us: 2_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                blend_mode: BlendMode::Normal,
            }),
            effects: vec![],
        };

        let track = Track {
            id: track_id,
            label: Some("V1".into()),
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: imbl::vector![layer, ref_layer],
        };

        let group_layer = Layer {
            id: group_layer_id,
            label: None,
            t_start_us: 0,
            t_end_us: 2_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::BLACK),
                width: 1920,
                height: 1080,
            }),
            effects: vec![],
        };
        let group_track = Track {
            id: group_track_id,
            label: None,
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: imbl::vector![group_layer],
        };
        let mut group = Composition::from_skeleton(
            group_id,
            Some("Lower third".into()),
            imbl::vector![group_track],
        );
        group.duration_us = 2_000_000;
        // `from_skeleton` mints the root's reserved 0; a Group is 1-based.
        group.ordinal = 1;

        let mut root = Composition::from_skeleton(root_id, None, imbl::vector![track]);
        root.duration_us = 7_000_000;
        // All three kinds so the round-trip covers the full tagged union
        // (pure serde — participants aren't validated here).
        root.transitions = imbl::vector![
            Transition {
                id: uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000010").unwrap(),
                from_layer: layer_id,
                to_layer: layer2_id,
                duration_us: 1_000_000,
                kind: TransitionKind::Crossfade,
                extended_us: 1_000_000,
            },
            Transition {
                id: uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000011").unwrap(),
                from_layer: layer_id,
                to_layer: layer2_id,
                duration_us: 1_000_000,
                kind: TransitionKind::Wipe {
                    direction: TransitionDirection::Left,
                },
                extended_us: 0,
            },
            Transition {
                id: uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000012").unwrap(),
                from_layer: layer_id,
                to_layer: layer2_id,
                duration_us: 1_000_000,
                kind: TransitionKind::Slide {
                    direction: TransitionDirection::Up,
                },
                extended_us: 500_000,
            },
        ];

        Project {
            schema_version: 1,
            project_id: uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000000").unwrap(),
            metadata: ProjectMetadata {
                name: "Round-trip fixture".into(),
                created_at: chrono::Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                modified_at: chrono::Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                description: None,
            },
            compositions: imbl::ordmap! { root_id => root, group_id => group },
            root_id,
            next_group_ordinal: 2,
            media_pool: imbl::HashMap::unit(media_id, media),
            audio_roles: imbl::HashMap::new(),
            settings: ProjectSettings::default(),
        }
    }

    #[test]
    fn project_json_round_trip() {
        let original = fixture_project();
        let json = serde_json::to_string_pretty(&original).expect("serialize");
        let parsed: Project = serde_json::from_str(&json).expect("deserialize");
        let again = serde_json::to_string_pretty(&parsed).expect("serialize again");
        assert_eq!(json, again, "round-trip JSON should be byte-identical");
    }

    #[test]
    fn blank_project_round_trips() {
        let p = Project::new_blank("untitled");
        let json = serde_json::to_string(&p).expect("serialize");
        let parsed: Project = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(p.schema_version, parsed.schema_version);
        assert_eq!(p.project_id, parsed.project_id);
        assert_eq!(parsed.root().tracks.len(), 2, "reserved A/B skeleton");
    }

    /// Every JSON number as f64, so `1` (parsed from TS output) equals `1.0`
    /// (re-emitted from an `f64` field) — `serde_json::Value` keeps them as
    /// distinct variants otherwise.
    fn with_f64_numbers(v: &mut serde_json::Value) {
        match v {
            serde_json::Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if let Some(f) = serde_json::Number::from_f64(f) {
                        *n = f;
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(with_f64_numbers),
            serde_json::Value::Object(map) => map.values_mut().for_each(with_f64_numbers),
            _ => {}
        }
    }

    /// The only cross-language check of the composition wire contract: the
    /// fixture is TS output (`fixtures/projects/README.md`), so Rust
    /// deserialising it and re-emitting an equal `compositions` subtree proves
    /// neither side dropped or renamed a field there. `Value` equality is
    /// key-order-blind — `compositions` is an `OrdMap` here and
    /// insertion-ordered in TS. Only that subtree is compared: outside it the
    /// two sides already differ by design (Rust emits `Option` media-metadata
    /// fields TS omits, and its timestamps drop the `.000` TS writes).
    #[test]
    fn ts_fixture_v1_deserialises_and_round_trips() {
        let text = include_str!("../../../fixtures/projects/v1.json");
        let p: Project = serde_json::from_str(text).expect("fixture deserialises");
        assert_eq!(p.compositions.len(), 2, "root + one pre-composed Group");
        assert!(p.compositions.contains_key(&p.root_id));
        assert!(
            p.compositions
                .values()
                .flat_map(|c| c.layers())
                .any(|l| matches!(l.params, LayerParams::CompositionRef(_))),
            "fixture places the Group in the root"
        );
        let mut a: serde_json::Value = serde_json::from_str(text).unwrap();
        let mut b = serde_json::to_value(&p).unwrap();
        assert_eq!(a["root_id"], b["root_id"]);
        with_f64_numbers(&mut a["compositions"]);
        with_f64_numbers(&mut b["compositions"]);
        assert_eq!(
            a["compositions"], b["compositions"],
            "Rust must not drop or rename a composition field TS wrote"
        );
    }
}
