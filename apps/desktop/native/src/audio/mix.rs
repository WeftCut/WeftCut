//! Export audio mixer — MixPlan construction from the project and the
//! block-pull summing loop. See ADR 0019.
//!
//! Time discipline: everything converts to the 48 kHz frame domain ONCE via
//! `us_to_frame`, then all placement/trim math is integer frames — the audio
//! analog of the video `frameGrid` rule. Group placement (offset sums and
//! window intersections in `for_each_audio_layer`) is that one µs step.
//!
//! Audio inside a Group (`LayerParams::CompositionRef`) is reached by
//! recursing with a time offset, never by flattening state; role buses stay
//! project-global (ADR 0023). Spec: `.scratch/links-and-groups/spec.md`
//! § "Time and audio"; shape: ADR 0052 §4.

use std::path::PathBuf;

use anyhow::Result;
use uuid::Uuid;

use crate::audio::conform_reader::ConformReader;
use crate::audio::envelope::{pan_coeffs_at, sample_gain, sample_pan, Envelope};
use crate::state::audio_role::RoleMixSettings;
use crate::state::ids::CompositionId;
use crate::state::layer::{AudioParams, Layer, LayerParams};
use crate::state::Project;

pub const MIX_SAMPLE_RATE: i64 = 48_000;
pub const MIX_BLOCK_FRAMES: usize = 65_536;

/// µs → 48 kHz frame index, round-half-up — see `weftcut_eval::us_to_frame`.
/// `MIX_SAMPLE_RATE` is the conform rate.
pub fn us_to_frame(us: i64) -> i64 {
    weftcut_eval::us_to_frame(us, MIX_SAMPLE_RATE as u32)
}

#[derive(Debug)]
pub struct MixLayer {
    pub label: String,
    pub conform_path: PathBuf,
    /// First frame that sounds, on the root frame grid — the layer's own
    /// start shifted into root time and clipped to every enclosing Group
    /// window and the export window.
    pub start_frame: i64,
    /// Source in/out on the conform frame grid, already advanced/retreated
    /// by whatever the clipping cut off, so `[src_in, src_out)` is exactly
    /// what the mixer reads.
    pub src_in_frame: i64,
    pub src_out_frame: i64,
    /// How far into the layer's own span `start_frame` sits (0 unless a head
    /// was clipped). `gain`/`pan` are sampled over the UNCLIPPED span — a
    /// fade belongs to the layer, and a Group window that cuts into it cuts
    /// the fade, as trimming a nest does in AE/Premiere — so the mixer
    /// evaluates them at `local + head_frame`.
    pub head_frame: i64,
    /// Linear gain (gain_db × fades × role gain), layer-local time domain.
    pub gain: Envelope,
    pub pan: Envelope,
}

impl MixLayer {
    pub fn end_frame(&self) -> i64 {
        self.start_frame + (self.src_out_frame - self.src_in_frame)
    }
}

#[derive(Debug)]
pub struct MixPlan {
    /// Export window on the composition frame grid (half-open).
    pub window_start_frame: i64,
    pub window_end_frame: i64,
    pub layers: Vec<MixLayer>,
}

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error(
        "audio layer on media \"{0}\" has no conform cache yet — wait for the conform job or run ensure_conform"
    )]
    ConformMissing(String),
    #[error("layer references missing media {0}")]
    MissingMedia(String),
}

// ── Role-gate primitives ────────────────────────────────────────────────────
// The canonical twin of `render/audio/roleGate.ts`. `audible_audio_layers`
// (gate) and `plan_for_project` (gain fold) call these, so the logic the export
// path runs IS the logic the cross-language golden locks
// (`render/audio/roleGate.golden.test.ts` + `tests::golden_vectors_match_fixture`
// share one fixture). Both sides call the same weftcut-eval leaf, so that golden
// is a wasm smoke, not a hand-mirror drift guard.

// The mute/solo decision + dB→linear math live in the weftcut-eval leaf (shared
// with the renderer's audio-preview gating via wasm). These wrappers keep the
// `&RoleMixSettings`/iterator signatures so callers are untouched while the
// rules stay single-sourced. `RoleMixSettings` stays in `state/audio_role.rs`.

/// True iff any role in the table is soloed. Absent roles can't be soloed, so a
/// partial/empty table answers correctly.
pub fn any_role_solo<'a>(roles: impl IntoIterator<Item = &'a RoleMixSettings>) -> bool {
    weftcut_eval::any_role_solo(roles.into_iter().map(|r| r.solo))
}

/// `role` is the RESOLVED settings (present, or the `Project::role_mix` default
/// for an absent role); resolving the absent case is the caller's job, matching
/// `role_mix`. The rule itself lives on `weftcut_eval::role_audible`.
pub fn role_audible(role: &RoleMixSettings, any_solo: bool) -> bool {
    weftcut_eval::role_audible(role.muted, role.solo, any_solo)
}

/// Linear gain for a role's `gain_db`, folded into each audible layer's gain
/// envelope (v1 has no per-role DSP). `f32` to match `db_to_linear` and
/// `Envelope::scale`; the TS twin computes in `f64`, so the golden compares
/// with an f32-width tolerance (same precision the envelope golden uses).
pub fn role_gain_linear(role: &RoleMixSettings) -> f32 {
    weftcut_eval::role_gain_linear(role.gain_db)
}

/// Deepest Group nesting the walk follows (root = 0). TS validation rejects
/// composition cycles, but Rust never trusts data it did not validate: a
/// corrupt file with a self-referencing Group stops here silently instead of
/// recursing without bound. Far above any real nesting.
const MAX_COMPOSITION_DEPTH: usize = 32;

/// An `Audio` layer the walk reached, placed in root time.
struct PlacedAudio<'a> {
    layer: &'a Layer,
    params: &'a AudioParams,
    /// Root time the layer starts sounding: its own `t_start` shifted by the
    /// accumulated offset, then clipped to every enclosing window.
    start_us: i64,
    /// What that clipping cut off the layer's head and tail (each ≥ 0): the
    /// source read and the envelopes begin `head_us` into the layer, and the
    /// source read ends `tail_us` before its own out point.
    head_us: i64,
    tail_us: i64,
}

/// Visit every enabled `Audio` layer reachable from `comp_id`, recursing
/// through `CompositionRef` layers, in depth-first track order.
///
/// Time frames: `offset_us` is where the composition's own `t = 0` sits in
/// ROOT time, so a layer at composition time `t` sounds at root time
/// `t + offset_us`; `window` is in ROOT time, half-open. Entering a ref
/// layer maps its child by `offset + ref.t_start − ref.src_in` (the spec's
/// parent-time `t ↔ t − t_start + src_in`, inverted) and narrows the window
/// to the ref's own root-time placement `[offset + ref.t_start, offset +
/// ref.t_end)`. Both accumulate, so nothing below needs to know its depth,
/// and `f` receives a placement already clipped to the window.
///
/// Gates here are structural only — `track.enabled` and `layer.enabled` on
/// every layer, Audio or ref, and the window. Roles, mute and lock are the
/// caller's (`audible_audio_layers`). A ref whose composition does not
/// resolve contributes nothing: validation rejects it, Rust never panics on
/// data.
fn for_each_audio_layer<'a>(
    project: &'a Project,
    comp_id: &CompositionId,
    offset_us: i64,
    window: (i64, i64),
    depth: usize,
    f: &mut dyn FnMut(PlacedAudio<'a>),
) {
    if depth > MAX_COMPOSITION_DEPTH || window.0 >= window.1 {
        return;
    }
    let Some(comp) = project.composition(comp_id) else {
        return;
    };
    for track in comp.tracks.iter() {
        if !track.enabled {
            continue;
        }
        for layer in track.layers.iter() {
            if !layer.enabled {
                continue;
            }
            let placed_start = offset_us + layer.t_start_us;
            let placed_end = offset_us + layer.t_end_us;
            let start_us = placed_start.max(window.0);
            let end_us = placed_end.min(window.1);
            // Half-open overlap gate: a layer the mix will never read must
            // neither require a conform cache nor occupy a reader slot —
            // otherwise a range export hard-errors (ConformMissing) on clips
            // entirely outside the range.
            if start_us >= end_us {
                continue;
            }
            match &layer.params {
                LayerParams::Audio(p) => f(PlacedAudio {
                    layer,
                    params: p,
                    start_us,
                    head_us: start_us - placed_start,
                    tail_us: placed_end - end_us,
                }),
                LayerParams::CompositionRef(r) => for_each_audio_layer(
                    project,
                    &r.composition,
                    placed_start - r.src_in_us,
                    (start_us, end_us),
                    depth + 1,
                    f,
                ),
                _ => {}
            }
        }
    }
}

/// Every audible audio layer in depth-first track order, placed in root
/// time. Whole-track and layer disable plus the window are the walk's
/// (`for_each_audio_layer`); audio mute/solo gating lives on ROLES, not
/// tracks (docs/audio.md) — role mute, the role solo set (mute wins over
/// solo) — plus the layer's own lock and mute. Shared by `plan_for_project`
/// and `conform_waiting_media` so the export-readiness gate and the mix plan
/// can never disagree on selection.
fn audible_audio_layers<'a>(
    project: &'a Project,
    w_start_us: i64,
    w_end_us: i64,
) -> Vec<PlacedAudio<'a>> {
    let any_solo = any_role_solo(project.audio_roles.values());
    let mut out = Vec::new();
    for_each_audio_layer(
        project,
        &project.root_id,
        0,
        (w_start_us, w_end_us),
        0,
        &mut |placed| {
            if placed.layer.locked || placed.params.mute {
                return;
            }
            let role = project.role_mix(placed.params.role);
            if !role_audible(&role, any_solo) {
                return;
            }
            out.push(placed);
        },
    );
    out
}

/// Walk every audible Audio layer (see `audible_audio_layers`) and resolve
/// envelopes into a `MixPlan`.
pub fn plan_for_project(
    project: &Project,
    window_us: Option<(i64, i64)>,
) -> Result<MixPlan, PlanError> {
    let (w_start_us, w_end_us) = window_us.unwrap_or((0, project.root().duration_us));
    let mut layers = Vec::new();
    for placed in audible_audio_layers(project, w_start_us, w_end_us) {
        let p = placed.params;
        let media = project
            .media_pool
            .get(&p.media)
            .ok_or_else(|| PlanError::MissingMedia(p.media.to_string()))?;
        let label = media
            .label
            .clone()
            .unwrap_or_else(|| media.path_abs.display().to_string());
        let conform_path = media
            .conform_path
            .clone()
            .filter(|c| crate::cache::cached_ok(c))
            .ok_or_else(|| PlanError::ConformMissing(label.clone()))?;
        let span_us = p.src_out_us - p.src_in_us;
        let role_gain = role_gain_linear(&project.role_mix(p.role));
        let mut gain = sample_gain(
            &p.gain_db,
            p.fade_in_us as i64,
            p.fade_out_us as i64,
            span_us,
        );
        gain.scale(role_gain);
        let start_frame = us_to_frame(placed.start_us);
        layers.push(MixLayer {
            label,
            conform_path,
            start_frame,
            src_in_frame: us_to_frame(p.src_in_us + placed.head_us),
            src_out_frame: us_to_frame(p.src_out_us - placed.tail_us),
            head_frame: start_frame - us_to_frame(placed.start_us - placed.head_us),
            gain,
            pan: sample_pan(&p.pan, span_us),
        });
    }
    Ok(MixPlan {
        window_start_frame: us_to_frame(w_start_us),
        window_end_frame: us_to_frame(w_end_us),
        layers,
    })
}

/// Media ids (deduped, first-appearance order) of audible in-window audio
/// layers whose conform cache is absent or fails `cached_ok` — exactly the
/// set `plan_for_project` would `ConformMissing` on. The export-readiness
/// gate waits on these (kicking `ensure_conform`) before the audio stage.
/// Media without an audio stream can never conform and are excluded;
/// `plan_for_project` remains the backstop for that pathological case.
pub fn conform_waiting_media(project: &Project, window_us: Option<(i64, i64)>) -> Vec<Uuid> {
    let (w_start_us, w_end_us) = window_us.unwrap_or((0, project.root().duration_us));
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for placed in audible_audio_layers(project, w_start_us, w_end_us) {
        let p = placed.params;
        if !seen.insert(p.media) {
            continue;
        }
        let Some(media) = project.media_pool.get(&p.media) else {
            continue; // plan_for_project reports MissingMedia
        };
        if media.metadata.audio.is_none() {
            continue;
        }
        let ready = media
            .conform_path
            .as_deref()
            .map(crate::cache::cached_ok)
            .unwrap_or(false);
        if !ready {
            out.push(p.media);
        }
    }
    out
}

/// Sum one output block (stereo interleaved f32) starting at absolute
/// composition frame `block_start`. `readers` parallels `plan.layers`.
/// `out` has length `frames * 2` and is zeroed by the caller.
pub fn mix_block(
    plan: &MixPlan,
    readers: &mut [ConformReader],
    block_start: i64,
    frames: usize,
    out: &mut [f32],
) -> Result<()> {
    for (layer, reader) in plan.layers.iter().zip(readers.iter_mut()) {
        let layer_end = layer.end_frame();
        if block_start + frames as i64 <= layer.start_frame || block_start >= layer_end {
            continue;
        }
        let src_start = block_start - layer.start_frame + layer.src_in_frame;
        let data = reader.read_frames(src_start, frames)?;
        let ch = reader.header.channels as usize;
        for k in 0..frames {
            let comp_f = block_start + k as i64;
            if comp_f < layer.start_frame || comp_f >= layer_end {
                continue;
            }
            let local_f = comp_f - layer.start_frame + layer.head_frame;
            let local_us = local_f * 1_000_000 / MIX_SAMPLE_RATE;
            let g = layer.gain.eval(local_us);
            let [a, b, c, d] = pan_coeffs_at(&layer.pan, ch as i32, local_us);
            let frame = &data[k * ch..k * ch + ch];
            let (l, r) = match ch {
                1 => (frame[0] * g, 0.0),
                _ => (frame[0] * g, frame[1] * g),
            };
            // mono: pan_coeffs(channels=1) puts in→L in a, in→R in c (b=d=0), and
            // the single input sits in `l`, so a*l + b*0 and c*l + d*0 are correct.
            out[k * 2] += a * l + b * r;
            out[k * 2 + 1] += c * l + d * r;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::conform_reader::{write_vconf, ConformReader};
    use crate::state::animated::Animated;
    use crate::state::audio_role::{AudioRole, RoleMixSettings};
    use crate::state::composition::Composition;
    use crate::state::decode_route::DecodeRoute;
    use crate::state::layer::{AudioParams, CompositionRefParams, Layer, LayerParams};
    use crate::state::media::{AudioStreamMeta, MediaItem, MediaKind, MediaMetadata};
    use crate::state::project::{Project, ProjectMetadata, ProjectSettings};
    use crate::state::track::Track;
    use crate::state::transform::{BlendMode, Transform};
    use tempfile::TempDir;

    fn flat_mono_conform(dir: &std::path::Path, name: &str, value: f32, frames: usize) -> PathBuf {
        let p = dir.join(name);
        write_vconf(&p, 1, &vec![value; frames]);
        p
    }

    fn plain_layer(path: PathBuf, start_frame: i64, n_frames: i64) -> MixLayer {
        MixLayer {
            label: "test".into(),
            conform_path: path,
            start_frame,
            src_in_frame: 0,
            src_out_frame: n_frames,
            head_frame: 0,
            gain: Envelope::constant(1.0, n_frames * 1_000_000 / MIX_SAMPLE_RATE),
            pan: Envelope::constant(0.0, n_frames * 1_000_000 / MIX_SAMPLE_RATE),
        }
    }

    #[test]
    fn us_to_frame_is_exact_on_the_grid() {
        assert_eq!(us_to_frame(0), 0);
        assert_eq!(us_to_frame(1_000_000), 48_000);
        assert_eq!(us_to_frame(20_833), 1_000); // 1000 frames = 20833.3µs
    }

    #[test]
    fn single_centered_mono_layer_equal_power() {
        let tmp = TempDir::new().unwrap();
        let p = flat_mono_conform(tmp.path(), "a.conform", 0.5, 100);
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: 100,
            layers: vec![plain_layer(p.clone(), 0, 100)],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; 100 * 2];
        mix_block(&plan, &mut readers, 0, 100, &mut out).unwrap();
        // mono center: each side = 0.5 · cos(π/4) ≈ 0.35355
        assert!((out[0] - 0.35355).abs() < 1e-4);
        assert!((out[1] - 0.35355).abs() < 1e-4);
    }

    #[test]
    fn placement_offsets_and_silence_gaps() {
        let tmp = TempDir::new().unwrap();
        let p = flat_mono_conform(tmp.path(), "a.conform", 0.4, 10);
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: 30,
            layers: vec![plain_layer(p.clone(), 10, 10)],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; 30 * 2];
        mix_block(&plan, &mut readers, 0, 30, &mut out).unwrap();
        assert_eq!(out[9 * 2], 0.0, "before layer start: silence");
        assert!(out[10 * 2] > 0.2, "at layer start: signal");
        assert!(out[19 * 2] > 0.2, "last layer frame: signal");
        assert_eq!(out[20 * 2], 0.0, "past layer end: silence");
    }

    #[test]
    fn overlapping_layers_sum() {
        let tmp = TempDir::new().unwrap();
        let p1 = flat_mono_conform(tmp.path(), "a.conform", 0.3, 50);
        let p2 = flat_mono_conform(tmp.path(), "b.conform", 0.2, 50);
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: 50,
            layers: vec![
                plain_layer(p1.clone(), 0, 50),
                plain_layer(p2.clone(), 0, 50),
            ],
        };
        let mut readers = vec![
            ConformReader::open(&p1).unwrap(),
            ConformReader::open(&p2).unwrap(),
        ];
        let mut out = vec![0f32; 50 * 2];
        mix_block(&plan, &mut readers, 0, 50, &mut out).unwrap();
        let expect = (0.3 + 0.2) * (std::f32::consts::FRAC_PI_4).cos();
        assert!((out[0] - expect).abs() < 1e-4);
    }

    // ── plan_for_project mute/solo helpers ──────────────────────────────────

    /// A 1 s mono audio media item whose conform cache is `conform` — a real
    /// non-empty file so `cached_ok` passes.
    fn audio_media(id: Uuid, conform: PathBuf) -> MediaItem {
        MediaItem {
            id,
            label: None,
            path_abs: conform.clone(),
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 48_000,
                    channels: 1,
                    codec: "pcm_f32le".into(),
                    start_pts_us: None,
                }),
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: Some(conform),
            thumbnails_dir: None,
            file_hash_blake3: "0000000000000000".into(),
            file_size: 1,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        }
    }

    fn base_layer(t_start_us: i64, t_end_us: i64, params: LayerParams) -> Layer {
        Layer {
            id: Uuid::new_v4(),
            label: None,
            t_start_us,
            t_end_us,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params,
            effects: vec![],
        }
    }

    fn audio_layer(
        media: Uuid,
        role: AudioRole,
        t_start_us: i64,
        t_end_us: i64,
        src_in_us: i64,
        src_out_us: i64,
    ) -> Layer {
        base_layer(
            t_start_us,
            t_end_us,
            LayerParams::Audio(AudioParams {
                media,
                src_in_us,
                src_out_us,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
                role,
            }),
        )
    }

    /// A Group layer: `composition` windowed by `[src_in_us, src_out_us)`.
    fn ref_layer(
        composition: CompositionId,
        t_start_us: i64,
        t_end_us: i64,
        src_in_us: i64,
        src_out_us: i64,
    ) -> Layer {
        base_layer(
            t_start_us,
            t_end_us,
            LayerParams::CompositionRef(CompositionRefParams {
                composition,
                src_in_us,
                src_out_us,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                blend_mode: BlendMode::Normal,
            }),
        )
    }

    fn track_of(layers: Vec<Layer>) -> Track {
        Track {
            id: Uuid::new_v4(),
            label: None,
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: layers.into_iter().collect(),
        }
    }

    /// Real projects keep `duration_us ≥ max(layer.t_end_us)` (the ADR 0005
    /// autofit guard holds even when pinned); the window gate relies on it
    /// for the `None` ⇒ whole-project window.
    fn composition_of(id: CompositionId, tracks: Vec<Track>, duration_us: i64) -> Composition {
        let mut c = Composition::from_skeleton(id, None, tracks.into_iter().collect());
        c.duration_us = duration_us;
        c
    }

    fn project_of(
        root_id: CompositionId,
        compositions: Vec<Composition>,
        media: Vec<MediaItem>,
    ) -> Project {
        let now = chrono::Utc::now();
        Project {
            schema_version: 1,
            project_id: Uuid::new_v4(),
            metadata: ProjectMetadata {
                name: "mix test".into(),
                created_at: now,
                modified_at: now,
                description: None,
            },
            compositions: compositions.into_iter().map(|c| (c.id, c)).collect(),
            root_id,
            next_group_ordinal: 1,
            media_pool: media.into_iter().map(|m| (m.id, m)).collect(),
            audio_roles: imbl::HashMap::new(),
            settings: ProjectSettings::default(),
        }
    }

    /// Build a minimal `Project` with two Audio tracks, one layer each.
    /// Both conform files are written into `dir`. The returned `Project`
    /// is valid for `plan_for_project` — media pool entries point at real
    /// non-zero files so `cached_ok` passes.
    fn two_audio_tracks_project(dir: &std::path::Path) -> Project {
        let conform_a = dir.join("a.conform");
        let conform_b = dir.join("b.conform");
        write_vconf(&conform_a, 1, &vec![0.5f32; 48_000]);
        write_vconf(&conform_b, 1, &vec![0.3f32; 48_000]);

        let media_id_a = Uuid::new_v4();
        let media_id_b = Uuid::new_v4();
        let root_id = Uuid::new_v4();
        let root = composition_of(
            root_id,
            vec![
                track_of(vec![audio_layer(
                    media_id_a,
                    AudioRole::Dialogue,
                    0,
                    1_000_000,
                    0,
                    1_000_000,
                )]),
                track_of(vec![audio_layer(
                    media_id_b,
                    AudioRole::Music,
                    0,
                    1_000_000,
                    0,
                    1_000_000,
                )]),
            ],
            10_000_000,
        );
        project_of(
            root_id,
            vec![root],
            vec![
                audio_media(media_id_a, conform_a),
                audio_media(media_id_b, conform_b),
            ],
        )
    }

    fn set_role(p: &mut Project, role: AudioRole, s: RoleMixSettings) {
        p.audio_roles.insert(role, s);
    }

    #[test]
    fn muted_role_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(
            &mut project,
            AudioRole::Dialogue,
            RoleMixSettings {
                gain_db: 0.0,
                muted: true,
                solo: false,
            },
        );
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(
            plan.layers.len(),
            1,
            "Dialogue role muted ⇒ only Music plays"
        );
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("b.conform"));
    }

    #[test]
    fn solo_silences_non_solo_roles() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(
            &mut project,
            AudioRole::Dialogue,
            RoleMixSettings {
                gain_db: 0.0,
                muted: false,
                solo: true,
            },
        );
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1, "only soloed Dialogue plays");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("a.conform"));
    }

    #[test]
    fn role_mute_wins_over_solo() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(
            &mut project,
            AudioRole::Dialogue,
            RoleMixSettings {
                gain_db: 0.0,
                muted: true,
                solo: true,
            },
        );
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(
            plan.layers.len(),
            0,
            "mute wins; Music silenced by the solo set"
        );
    }

    #[test]
    fn role_gain_scales_output() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // +6.0206 dB ≈ ×2 on Dialogue only.
        set_role(
            &mut project,
            AudioRole::Dialogue,
            RoleMixSettings {
                gain_db: 6.0206,
                muted: false,
                solo: false,
            },
        );
        let plan = plan_for_project(&project, None).unwrap();
        let dialogue = plan
            .layers
            .iter()
            .find(|l| l.conform_path == tmp.path().join("a.conform"))
            .unwrap();
        assert!(
            (dialogue.gain.eval(0) - 2.0).abs() < 1e-2,
            "Dialogue folded ×2"
        );
        let music = plan
            .layers
            .iter()
            .find(|l| l.conform_path == tmp.path().join("b.conform"))
            .unwrap();
        assert!((music.gain.eval(0) - 1.0).abs() < 1e-3, "Music unchanged");
    }

    #[test]
    fn legacy_no_audio_roles_plays_both_at_unity() {
        let tmp = TempDir::new().unwrap();
        let project = two_audio_tracks_project(tmp.path()); // empty audio_roles
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 2);
        for l in &plan.layers {
            assert!((l.gain.eval(0) - 1.0).abs() < 1e-3);
        }
    }

    // ── conform_waiting_media ────────────────────────────────────────────────

    /// Media id behind the (single) audio layer of `project.root().tracks[track]`.
    fn layer_media(project: &Project, track: usize) -> uuid::Uuid {
        let LayerParams::Audio(p) = &project.root().tracks[track].layers[0].params else {
            unreachable!("fixture tracks carry audio layers");
        };
        p.media
    }

    #[test]
    fn waiting_lists_unconformed_in_window_media() {
        let tmp = TempDir::new().unwrap();
        let project = two_audio_tracks_project(tmp.path());
        assert!(
            conform_waiting_media(&project, None).is_empty(),
            "everything conformed ⇒ nothing to wait on"
        );
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        assert_eq!(
            conform_waiting_media(&project, None),
            vec![layer_media(&project, 1)],
            "track B's media lost its conform cache"
        );
    }

    #[test]
    fn waiting_skips_out_of_window_and_gated_layers() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        // Out of window: the plan never reads it, so the gate never waits.
        project.root_mut().tracks[1].layers[0].t_start_us = 2_000_000;
        project.root_mut().tracks[1].layers[0].t_end_us = 3_000_000;
        assert!(conform_waiting_media(&project, Some((0, 1_000_000))).is_empty());
        project.root_mut().tracks[1].layers[0].t_start_us = 0;
        project.root_mut().tracks[1].layers[0].t_end_us = 1_000_000;
        // Muted role (track B carries the Music role).
        set_role(
            &mut project,
            AudioRole::Music,
            RoleMixSettings {
                gain_db: 0.0,
                muted: true,
                solo: false,
            },
        );
        assert!(conform_waiting_media(&project, None).is_empty());
        set_role(
            &mut project,
            AudioRole::Music,
            RoleMixSettings {
                gain_db: 0.0,
                muted: false,
                solo: false,
            },
        );
        // Locked layer.
        project.root_mut().tracks[1].layers[0].locked = true;
        assert!(conform_waiting_media(&project, None).is_empty());
        project.root_mut().tracks[1].layers[0].locked = false;
        // Solo'd out by the Dialogue role (track A).
        set_role(
            &mut project,
            AudioRole::Dialogue,
            RoleMixSettings {
                gain_db: 0.0,
                muted: false,
                solo: true,
            },
        );
        assert!(conform_waiting_media(&project, None).is_empty());
    }

    #[test]
    fn waiting_dedups_media_and_skips_streamless() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        // A second layer of the same media ⇒ still one waiting entry.
        let mut extra = project.root().tracks[1].layers[0].clone();
        extra.id = uuid::Uuid::new_v4();
        project.root_mut().tracks[1].layers.push_back(extra);
        assert_eq!(conform_waiting_media(&project, None).len(), 1);
        // Media with no audio stream can never conform ⇒ excluded from the
        // wait set (plan_for_project's ConformMissing stays the backstop).
        let id_b = layer_media(&project, 1);
        let mut media_b = project.media_pool.get(&id_b).unwrap().clone();
        media_b.metadata.audio = None;
        project.media_pool.insert(id_b, media_b);
        assert!(conform_waiting_media(&project, None).is_empty());
    }

    // ── plan_for_project window gating ──────────────────────────────────────

    #[test]
    fn plan_skips_unconformed_layer_outside_window() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Track B's layer sits past the window and its conform cache is gone.
        // A window-limited plan must neither error on it nor include it — the
        // mix will never read a frame of it.
        project.root_mut().tracks[1].layers[0].t_start_us = 2_000_000;
        project.root_mut().tracks[1].layers[0].t_end_us = 3_000_000;
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        let plan = plan_for_project(&project, Some((0, 1_000_000))).unwrap();
        assert_eq!(plan.layers.len(), 1, "only the in-window layer plans");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("a.conform"));
    }

    #[test]
    fn plan_errors_on_unconformed_layer_inside_window() {
        let tmp = TempDir::new().unwrap();
        let project = two_audio_tracks_project(tmp.path());
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        let err = plan_for_project(&project, Some((0, 1_000_000))).unwrap_err();
        assert!(matches!(err, PlanError::ConformMissing(_)));
    }

    #[test]
    fn window_overlap_is_half_open() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Track B's layer at [1s, 2s); track A's stays at [0, 1s).
        project.root_mut().tracks[1].layers[0].t_start_us = 1_000_000;
        project.root_mut().tracks[1].layers[0].t_end_us = 2_000_000;
        // Window [0, 1s): B's t_start == window end ⇒ B excluded.
        let plan = plan_for_project(&project, Some((0, 1_000_000))).unwrap();
        assert_eq!(plan.layers.len(), 1, "t_start == w_end is no overlap");
        // Window [2s, 3s): B's t_end == window start ⇒ both excluded.
        let plan = plan_for_project(&project, Some((2_000_000, 3_000_000))).unwrap();
        assert_eq!(plan.layers.len(), 0, "t_end == w_start is no overlap");
        // Window [1.5s, 2.5s): genuine partial overlap ⇒ B included.
        let plan = plan_for_project(&project, Some((1_500_000, 2_500_000))).unwrap();
        assert_eq!(plan.layers.len(), 1, "partial overlap plans the layer");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("b.conform"));
    }

    // ── Groups: the plan reaches audio through CompositionRef ───────────────

    const S: i64 = 1_000_000;
    const FRAMES_PER_S: i64 = MIX_SAMPLE_RATE;

    /// 1 s mono conform whose sample value IS its frame index / 48 000, so a
    /// misread source position shows up in the output value.
    fn ramp_conform(dir: &std::path::Path) -> PathBuf {
        let p = dir.join("ramp.conform");
        let ramp: Vec<f32> = (0..FRAMES_PER_S)
            .map(|f| f as f32 / FRAMES_PER_S as f32)
            .collect();
        write_vconf(&p, 1, &ramp);
        p
    }

    /// Mix the plan's whole window in one block; stereo interleaved.
    fn mix_all(plan: &MixPlan) -> Vec<f32> {
        let mut readers: Vec<ConformReader> = plan
            .layers
            .iter()
            .map(|l| ConformReader::open(&l.conform_path).unwrap())
            .collect();
        let frames = (plan.window_end_frame - plan.window_start_frame) as usize;
        let mut out = vec![0f32; frames * 2];
        mix_block(plan, &mut readers, plan.window_start_frame, frames, &mut out).unwrap();
        out
    }

    /// Left channel at root frame `f` of a `mix_all` buffer for a plan whose
    /// window starts at 0.
    fn left_at(out: &[f32], f: i64) -> f32 {
        out[f as usize * 2]
    }

    fn assert_same_placement(a: &MixLayer, b: &MixLayer) {
        assert_eq!(a.start_frame, b.start_frame, "start_frame");
        assert_eq!(a.src_in_frame, b.src_in_frame, "src_in_frame");
        assert_eq!(a.src_out_frame, b.src_out_frame, "src_out_frame");
        assert_eq!(a.head_frame, b.head_frame, "head_frame");
        assert_eq!(a.gain, b.gain, "gain envelope");
        assert_eq!(a.pan, b.pan, "pan envelope");
    }

    #[test]
    fn group_at_offset_mixes_like_direct_placement() {
        let tmp = TempDir::new().unwrap();
        let conform = ramp_conform(tmp.path());
        let media = Uuid::new_v4();
        let root_id = Uuid::new_v4();
        let group_id = Uuid::new_v4();
        // The layer itself at [2 s, 3 s) …
        let direct = project_of(
            root_id,
            vec![composition_of(
                root_id,
                vec![track_of(vec![audio_layer(
                    media,
                    AudioRole::Dialogue,
                    2 * S,
                    3 * S,
                    0,
                    S,
                )])],
                4 * S,
            )],
            vec![audio_media(media, conform.clone())],
        );
        // … versus the same layer at t = 0 inside a Group placed at [2 s, 3 s).
        let grouped = project_of(
            root_id,
            vec![
                composition_of(
                    root_id,
                    vec![track_of(vec![ref_layer(group_id, 2 * S, 3 * S, 0, S)])],
                    4 * S,
                ),
                composition_of(
                    group_id,
                    vec![track_of(vec![audio_layer(
                        media,
                        AudioRole::Dialogue,
                        0,
                        S,
                        0,
                        S,
                    )])],
                    S,
                ),
            ],
            vec![audio_media(media, conform)],
        );
        let a = plan_for_project(&direct, None).unwrap();
        let b = plan_for_project(&grouped, None).unwrap();
        assert_eq!(a.layers.len(), 1);
        assert_eq!(b.layers.len(), 1);
        assert_same_placement(&a.layers[0], &b.layers[0]);
        assert_eq!(b.layers[0].start_frame, 2 * FRAMES_PER_S);
        assert_eq!(mix_all(&a), mix_all(&b), "sample-identical mixes");
    }

    #[test]
    fn nested_groups_accumulate_offsets() {
        let tmp = TempDir::new().unwrap();
        let conform = ramp_conform(tmp.path());
        let media = Uuid::new_v4();
        let (root_id, g1, g2) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        // root ─ G1 at 1 s ─ G2 at 0.5 s ─ audio at 0.25 s ⇒ root 1.75 s.
        let project = project_of(
            root_id,
            vec![
                composition_of(
                    root_id,
                    vec![track_of(vec![ref_layer(g1, S, 4 * S, 0, 3 * S)])],
                    4 * S,
                ),
                composition_of(
                    g1,
                    vec![track_of(vec![ref_layer(g2, S / 2, 3 * S, 0, 5 * S / 2)])],
                    3 * S,
                ),
                composition_of(
                    g2,
                    vec![track_of(vec![audio_layer(
                        media,
                        AudioRole::Music,
                        S / 4,
                        5 * S / 4,
                        0,
                        S,
                    )])],
                    5 * S / 4,
                ),
            ],
            vec![audio_media(media, conform)],
        );
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1);
        let l = &plan.layers[0];
        assert_eq!(l.start_frame, us_to_frame(7 * S / 4));
        assert_eq!(l.end_frame(), us_to_frame(11 * S / 4));
        assert_eq!((l.src_in_frame, l.src_out_frame), (0, FRAMES_PER_S));
        assert_eq!(l.head_frame, 0, "no window cut into the layer");
        let out = mix_all(&plan);
        assert_eq!(left_at(&out, us_to_frame(7 * S / 4) - 1), 0.0, "silent before");
        let half = std::f32::consts::FRAC_PI_4.cos();
        let mid = left_at(&out, us_to_frame(7 * S / 4) + FRAMES_PER_S / 2);
        assert!((mid - 0.5 * half).abs() < 1e-4, "source frame 24000 at root 2.25 s, got {mid}");
    }

    /// Group trimmed shorter than its content: the audio stops exactly at the
    /// ref's out point instead of leaking the layer's remaining half second.
    #[test]
    fn ref_window_clips_the_tail_at_its_out_point() {
        let tmp = TempDir::new().unwrap();
        let conform = ramp_conform(tmp.path());
        let media = Uuid::new_v4();
        let (root_id, group_id) = (Uuid::new_v4(), Uuid::new_v4());
        let project = project_of(
            root_id,
            vec![
                composition_of(
                    root_id,
                    vec![track_of(vec![ref_layer(group_id, 2 * S, 5 * S / 2, 0, S / 2)])],
                    3 * S,
                ),
                composition_of(
                    group_id,
                    vec![track_of(vec![audio_layer(media, AudioRole::Music, 0, S, 0, S)])],
                    S,
                ),
            ],
            vec![audio_media(media, conform)],
        );
        let plan = plan_for_project(&project, None).unwrap();
        let l = &plan.layers[0];
        assert_eq!(l.start_frame, 2 * FRAMES_PER_S);
        assert_eq!(l.end_frame(), 5 * FRAMES_PER_S / 2, "ends at the ref's out point");
        assert_eq!(l.src_out_frame, FRAMES_PER_S / 2, "source retreats by the cut tail");
        let out = mix_all(&plan);
        assert!(left_at(&out, 5 * FRAMES_PER_S / 2 - 1) > 0.3, "last frame inside sounds");
        assert_eq!(left_at(&out, 5 * FRAMES_PER_S / 2), 0.0, "first frame past the out point is silent");
    }

    /// `src_in_us > 0` on the ref: the layer's head is never heard and the
    /// first audible frame reads the source at the ref's in point.
    #[test]
    fn ref_src_in_skips_the_head_and_reads_from_it() {
        let tmp = TempDir::new().unwrap();
        let conform = ramp_conform(tmp.path());
        let media = Uuid::new_v4();
        let (root_id, group_id) = (Uuid::new_v4(), Uuid::new_v4());
        let project = project_of(
            root_id,
            vec![
                composition_of(
                    root_id,
                    vec![track_of(vec![ref_layer(group_id, 2 * S, 5 * S / 2, S / 2, S)])],
                    3 * S,
                ),
                composition_of(
                    group_id,
                    vec![track_of(vec![audio_layer(media, AudioRole::Music, 0, S, 0, S)])],
                    S,
                ),
            ],
            vec![audio_media(media, conform)],
        );
        let plan = plan_for_project(&project, None).unwrap();
        let l = &plan.layers[0];
        assert_eq!(l.start_frame, 2 * FRAMES_PER_S, "sounds from the ref's start, not 1.5 s");
        assert_eq!(l.src_in_frame, FRAMES_PER_S / 2, "source advances by the cut head");
        assert_eq!(l.src_out_frame, FRAMES_PER_S);
        assert_eq!(l.head_frame, FRAMES_PER_S / 2);
        let out = mix_all(&plan);
        assert_eq!(left_at(&out, 2 * FRAMES_PER_S - 1), 0.0, "the skipped head is silent");
        let half = std::f32::consts::FRAC_PI_4.cos();
        let first = left_at(&out, 2 * FRAMES_PER_S);
        assert!((first - 0.5 * half).abs() < 1e-4, "reads source frame 24000, got {first}");
    }

    /// The fade is the layer's, sampled over its own span: a ref window that
    /// starts half-way through a 1 s fade-in hears the fade at half, not a
    /// fade restarting at the window.
    #[test]
    fn clipped_head_keeps_the_layers_own_fade() {
        let tmp = TempDir::new().unwrap();
        let conform = flat_mono_conform(tmp.path(), "flat.conform", 1.0, FRAMES_PER_S as usize);
        let media = Uuid::new_v4();
        let (root_id, group_id) = (Uuid::new_v4(), Uuid::new_v4());
        let mut fading = audio_layer(media, AudioRole::Music, 0, S, 0, S);
        let LayerParams::Audio(p) = &mut fading.params else {
            unreachable!()
        };
        p.fade_in_us = S as u64;
        let project = project_of(
            root_id,
            vec![
                composition_of(
                    root_id,
                    vec![track_of(vec![ref_layer(group_id, 2 * S, 5 * S / 2, S / 2, S)])],
                    3 * S,
                ),
                composition_of(group_id, vec![track_of(vec![fading])], S),
            ],
            vec![audio_media(media, conform)],
        );
        let plan = plan_for_project(&project, None).unwrap();
        let out = mix_all(&plan);
        let half = std::f32::consts::FRAC_PI_4.cos();
        let first = left_at(&out, 2 * FRAMES_PER_S);
        assert!((first - 0.5 * half).abs() < 2e-3, "fade at its midpoint, got {first}");
    }

    #[test]
    fn disabled_ref_or_its_track_contributes_nothing() {
        let tmp = TempDir::new().unwrap();
        let conform = ramp_conform(tmp.path());
        let media = Uuid::new_v4();
        let (root_id, group_id) = (Uuid::new_v4(), Uuid::new_v4());
        let build = |ref_enabled: bool, track_enabled: bool| {
            let mut r = ref_layer(group_id, 2 * S, 3 * S, 0, S);
            r.enabled = ref_enabled;
            let mut t = track_of(vec![r]);
            t.enabled = track_enabled;
            project_of(
                root_id,
                vec![
                    composition_of(root_id, vec![t], 4 * S),
                    composition_of(
                        group_id,
                        vec![track_of(vec![audio_layer(media, AudioRole::Music, 0, S, 0, S)])],
                        S,
                    ),
                ],
                vec![audio_media(media, conform.clone())],
            )
        };
        assert_eq!(plan_for_project(&build(true, true), None).unwrap().layers.len(), 1);
        assert!(plan_for_project(&build(false, true), None).unwrap().layers.is_empty());
        assert!(plan_for_project(&build(true, false), None).unwrap().layers.is_empty());
        // The readiness gate agrees: nothing to conform for a silenced Group.
        std::fs::remove_file(&conform).unwrap();
        assert_eq!(conform_waiting_media(&build(true, true), None), vec![media]);
        assert!(conform_waiting_media(&build(false, true), None).is_empty());
    }

    /// Hand-built cycle TS validation would reject: the walk must still end.
    #[test]
    fn self_referencing_composition_terminates() {
        let tmp = TempDir::new().unwrap();
        let conform = ramp_conform(tmp.path());
        let media = Uuid::new_v4();
        let (root_id, group_id) = (Uuid::new_v4(), Uuid::new_v4());
        let project = project_of(
            root_id,
            vec![
                composition_of(
                    root_id,
                    vec![track_of(vec![ref_layer(group_id, 0, S, 0, S)])],
                    S,
                ),
                composition_of(
                    group_id,
                    vec![track_of(vec![
                        audio_layer(media, AudioRole::Music, 0, S, 0, S),
                        ref_layer(group_id, 0, S, 0, S),
                    ])],
                    S,
                ),
            ],
            vec![audio_media(media, conform)],
        );
        let plan = plan_for_project(&project, None).unwrap();
        // The Group is entered once per depth 1..=MAX; the window never
        // shrinks, so only the guard could have ended the walk.
        assert_eq!(plan.layers.len(), MAX_COMPOSITION_DEPTH);
    }

    #[test]
    fn waiting_collects_group_media() {
        let tmp = TempDir::new().unwrap();
        let conform = ramp_conform(tmp.path());
        let media = Uuid::new_v4();
        let (root_id, group_id) = (Uuid::new_v4(), Uuid::new_v4());
        let project = project_of(
            root_id,
            vec![
                composition_of(
                    root_id,
                    vec![track_of(vec![ref_layer(group_id, 2 * S, 3 * S, 0, S)])],
                    4 * S,
                ),
                composition_of(
                    group_id,
                    vec![track_of(vec![audio_layer(media, AudioRole::Music, 0, S, 0, S)])],
                    S,
                ),
            ],
            vec![audio_media(media, conform.clone())],
        );
        assert!(conform_waiting_media(&project, None).is_empty());
        std::fs::remove_file(&conform).unwrap();
        assert_eq!(conform_waiting_media(&project, None), vec![media]);
        // Out of the export window ⇒ not waited on, exactly as a root layer.
        assert!(conform_waiting_media(&project, Some((0, S))).is_empty());
    }

    #[test]
    fn gain_envelope_applies_per_sample() {
        let tmp = TempDir::new().unwrap();
        let n = 48_000i64; // 1 s
        let p = flat_mono_conform(tmp.path(), "a.conform", 1.0, n as usize);
        let mut layer = plain_layer(p.clone(), 0, n);
        // fade-in across the full second
        layer.gain = crate::audio::envelope::sample_gain(
            &crate::state::animated::Animated::Static(0.0),
            1_000_000,
            0,
            1_000_000,
        );
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: n,
            layers: vec![layer],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; n as usize * 2];
        mix_block(&plan, &mut readers, 0, n as usize, &mut out).unwrap();
        let half = (std::f32::consts::FRAC_PI_4).cos();
        assert!(out[0].abs() < 1e-3, "t=0 fade-in is silent");
        let mid = out[(n as usize / 2) * 2];
        assert!(
            (mid - 0.5 * half).abs() < 2e-3,
            "midpoint ≈ half gain, got {mid}"
        );
    }

    /// Cross-language golden vectors for the role gate. The SAME fixture is
    /// asserted by `render/audio/roleGate.golden.test.ts` against the TS
    /// `roleGate.ts`; a verdict that passes one side and fails the other is
    /// drift in the mute/solo/gain rules — exactly what this catches. Exercises
    /// the SAME `any_role_solo`/`role_audible`/`role_gain_linear` the export path
    /// runs, with absent roles resolved to `role_mix`'s default. Regenerate the
    /// fixture only on an INTENTIONAL rule change, mirrored in roleGate.ts.
    #[test]
    fn golden_vectors_match_fixture() {
        use std::collections::HashMap;

        #[derive(serde::Deserialize)]
        struct RoleEntry {
            role: AudioRole,
            gain_db: f64,
            muted: bool,
            solo: bool,
        }
        #[derive(serde::Deserialize)]
        struct Query {
            role: AudioRole,
            audible: bool,
            gain_linear: f64,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            roles: Vec<RoleEntry>,
            any_solo: bool,
            queries: Vec<Query>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/renderer/render/audio/roleGateGolden.fixture.json"
        ))
        .expect("roleGate golden fixture parses");
        assert!(!fixture.cases.is_empty());

        for case in &fixture.cases {
            let table: HashMap<AudioRole, RoleMixSettings> = case
                .roles
                .iter()
                .map(|r| {
                    (
                        r.role,
                        RoleMixSettings {
                            gain_db: r.gain_db,
                            muted: r.muted,
                            solo: r.solo,
                        },
                    )
                })
                .collect();
            let any_solo = any_role_solo(table.values());
            assert_eq!(any_solo, case.any_solo, "case `{}` any_solo", case.name);
            for q in &case.queries {
                // Absent role ⇒ role_mix default (unmuted/unsoloed, unity gain).
                let settings = table.get(&q.role).cloned().unwrap_or_default();
                assert_eq!(
                    role_audible(&settings, any_solo),
                    q.audible,
                    "case `{}` role {:?} audible",
                    case.name,
                    q.role
                );
                // f32 (Rust) vs f64 (TS/fixture): compare at f32 width, the
                // same precision the envelope golden locks db_to_linear at.
                let got = role_gain_linear(&settings) as f64;
                assert!(
                    (got - q.gain_linear).abs() < 1e-5,
                    "case `{}` role {:?} gain: got {got}, expect {}",
                    case.name,
                    q.role,
                    q.gain_linear
                );
            }
        }
    }
}
