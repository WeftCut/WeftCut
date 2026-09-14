//! MCP tool functions, transport-free. Each tool is a
//! `pub(super) async fn <name>(b: &Backend, args: <Args>) -> Result<ToolResult, McpToolError>`.
//! Errors map 1:1 onto the MCP error model in `wire.rs`.
//!
//! Only the native/compute/hybrid-compute tool handlers live here; mutation
//! tools are served by the TS actor.
//! Cloud tools (transcribe/synthesize) are gated on `feature = "speech"`.

use chrono::Utc;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[cfg(feature = "speech")]
use crate::speech;

#[cfg(feature = "jobs")]
use crate::cache::cached_ok;
#[cfg(feature = "jobs")]
use crate::jobs;
use uuid::Uuid;

use crate::napi_backend::Backend;
use crate::state::{LayerId, LayerParams};

use super::wire::{McpToolError, ToolResult};
use super::EmptyArgs;

// ============================================================
// Shared helpers
// ============================================================

pub(super) fn parse_uuid(s: &str, field: &str) -> Result<Uuid, McpToolError> {
    Uuid::parse_str(s)
        .map_err(|e| McpToolError::invalid_params(format!("{field} not a UUID: {e}"), None))
}

// ============================================================
// Liveness
// ============================================================

pub(super) async fn ping(_b: &Backend, _args: EmptyArgs) -> Result<ToolResult, McpToolError> {
    Ok(ToolResult::text("pong"))
}

// Track and layer mutation tools (add_track, remove_track, move_track,
// add_color_layer, add_video_layer, update_layer, update_layer_params,
// move_layer, trim_layer, delete_layer, split_layer, duplicate_layer) are
// absent — they are served by the TS actor.

#[expect(
    dead_code,
    reason = "hybrid-orchestrator stub: TS intercepts apply_subtitles before dispatch, so no Rust code reads the fields; the struct exists to emit the wire schema"
)]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ApplySubtitlesArgs {
    /// Subtitle document body (SRT, ASS, or VTT).
    pub body: String,
    /// 'srt', 'ass', or 'vtt'. Sniffed from body when omitted.
    pub format: Option<String>,
    /// IGNORED — the lane is the packing's to pick: cues land on the caption
    /// tracks already there where they have room (ADR 0070). Kept for
    /// wire-schema stability; do not remove.
    pub track_id: Option<String>,
    /// IGNORED — cue timings come from the body, not the timeline envelope.
    /// Kept for wire-schema stability; do not remove.
    pub t_start_us: Option<i64>,
    /// IGNORED — cue timings come from the body, not the timeline envelope.
    /// Kept for wire-schema stability; do not remove.
    pub t_end_us: i64,
}

/// `apply_subtitles` Rust handler is a stub — the tool routes through the hybrid
/// orchestrator (parse_subtitles napi compute → TS-actor add_caption_track write).
pub(super) async fn apply_subtitles(
    _b: &Backend,
    _args: ApplySubtitlesArgs,
) -> Result<ToolResult, McpToolError> {
    Err(McpToolError::internal_error(
        "apply_subtitles is handled by the host process (TS actor hybrid)".to_string(),
        None,
    ))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct DetectPausesArgs {
    /// Target Audio layer id. A VideoClip id is accepted by the host, which
    /// resolves it to the Audio layer of its link before the call.
    pub layer_id: String,
    /// Peak amplitude threshold in [0.0, 1.0]. Anything strictly below this
    /// counts as quiet. Default 0.02 (≈ -34 dBFS).
    pub threshold_amp: Option<f32>,
    /// Shortest pause to surface, in microseconds. Default 500000 (0.5s).
    pub min_pause_us: Option<i64>,
    /// A loud run shorter than this INSIDE a quiet run does not end the pause,
    /// in microseconds. Default 80000 (80ms) — long enough to swallow a click,
    /// a cough or lip noise, short enough that no syllable fits. Must be ≥ 0
    /// and strictly below `min_pause_us`.
    pub bridge_us: Option<i64>,
    /// Injected by the TS MCP host (sole state owner) — the SUBJECT Audio layer
    /// resolved by `layer_id`, its `MediaItem`, and the peaks file the mixer
    /// would read. `#[schemars(skip)]` keeps them OUT of the advertised tool
    /// schema; serde still deserializes them. `None` on a direct Rust call →
    /// the handler produces the same not-found error.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
    /// The baked effect sibling's peaks file when it is ready; `None` falls
    /// back to the media's own. Detection must read what PLAYS, so the bands
    /// never disagree with the waveform drawn under them.
    #[serde(default)]
    #[schemars(skip)]
    pub peaks_path: Option<String>,
}

/// One pause, timeline-absolute and clipped to the layer's span.
#[derive(Debug, Serialize, JsonSchema)]
pub(super) struct PauseRegion {
    pub t_start_us: i64,
    pub t_end_us: i64,
}

/// Which peaks file a detection actually read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum PeaksSource {
    Raw,
    Fx,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(super) struct DetectPausesResult {
    pub pauses: Vec<PauseRegion>,
    /// 10th percentile of the folded peaks inside the layer's source window;
    /// 0.0 when the window holds no peak. The referent the UI's threshold
    /// readout and its Auto button are computed against.
    pub noise_floor_amp: f32,
    pub peaks_source: PeaksSource,
}

#[cfg(feature = "jobs")]
pub(super) async fn detect_pauses(
    b: &Backend,
    args: DetectPausesArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let layer = args
        .layer
        .as_ref()
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

    // A pause is a fact about the audio that PLAYS: only `LayerParams::Audio`
    // reaches the mixer, so a VideoClip's embedded track is not what a listener
    // hears, and reading it would cut picture by sound nobody hears. The host
    // resolves a VideoClip to the Audio member of its link before calling, so
    // one arriving here is a host bug and the refusal says so.
    let (media_id, src_in_us, src_out_us) = match &layer.params {
        LayerParams::Audio(p) => (p.media, p.src_in_us, p.src_out_us),
        LayerParams::VideoClip(_) => {
            return Err(McpToolError::invalid_params(
                format!(
                    "layer {layer_id} is a VideoClip; pass its Audio layer (the host resolves a linked partner)",
                ),
                None,
            ));
        }
        _ => {
            return Err(McpToolError::invalid_params(
                format!("layer {layer_id} kind has no audio — pass an Audio layer"),
                None,
            ));
        }
    };
    let media = args.media.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(
            format!("layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;

    let threshold_amp = args.threshold_amp.unwrap_or(0.02);
    let min_pause_us = args.min_pause_us.unwrap_or(500_000);
    let bridge_us = args.bridge_us.unwrap_or(80_000);
    if !(0.0..=1.0).contains(&threshold_amp) {
        return Err(McpToolError::invalid_params(
            format!("threshold_amp {threshold_amp} must be in [0.0, 1.0]"),
            None,
        ));
    }
    if min_pause_us <= 0 {
        return Err(McpToolError::invalid_params(
            format!("min_pause_us {min_pause_us} must be positive"),
            None,
        ));
    }
    if bridge_us < 0 {
        return Err(McpToolError::invalid_params(
            format!("bridge_us {bridge_us} must be at least 0"),
            None,
        ));
    }
    if bridge_us >= min_pause_us {
        return Err(McpToolError::invalid_params(
            format!("bridge_us {bridge_us} must be below min_pause_us {min_pause_us}"),
            None,
        ));
    }

    // An fx peaks file that is not cached falls back to the raw one rather than
    // refusing, mirroring the timeline's tile fetch; export keeps its own
    // strict gate. The wait-for-the-waveform refusal is therefore raw-only.
    let (peaks_path, peaks_source) = match args.peaks_path.as_deref() {
        Some(fx) if cached_ok(std::path::Path::new(fx)) => {
            let fx = std::path::PathBuf::from(fx);
            crate::cache::touch_if_stale(&fx);
            (fx, PeaksSource::Fx)
        }
        _ => {
            let raw = b.cache.waveform(&media.file_hash_blake3);
            crate::cache::touch_if_stale(&raw);
            if !cached_ok(&raw) {
                return Err(McpToolError::invalid_request(
                    format!(
                        "waveform not generated yet for media {media_id} — wait for a media:job_complete event with kind=waveform and retry",
                    ),
                    None,
                ));
            }
            (raw, PeaksSource::Raw)
        }
    };

    let peaks_file = jobs::read_peaks_file(&peaks_path)
        .map_err(|e| McpToolError::internal_error(format!("read peaks: {e:#}"), None))?;

    // Map source-relative pauses to timeline-absolute coords:
    //   timeline_t = layer.t_start_us + (source_t - layer.src_in_us)
    //   clipped to [layer.t_start_us, layer.t_end_us]
    let pauses = detect_pauses_in_peaks(
        &peaks_file.peaks,
        threshold_amp,
        min_pause_us,
        bridge_us,
        src_in_us,
        src_out_us,
        layer.t_start_us,
        peaks_file.sample_rate,
        peaks_file.frames_per_peak,
    );
    let noise_floor_amp = noise_floor_p10(
        &peaks_file.peaks,
        src_in_us,
        src_out_us,
        peaks_file.sample_rate,
        peaks_file.frames_per_peak,
    );

    ToolResult::json(&DetectPausesResult {
        pauses,
        noise_floor_amp,
        peaks_source,
    })
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AnalyzeClipArgs {
    /// Target VideoClip layer id.
    pub layer_id: String,
    /// Cut sensitivity in [0.0, 1.0]: a frame whose shot-change score exceeds
    /// this starts a new shot. Lower = more (finer) cuts. Default 0.4.
    pub sensitivity: Option<f32>,
    /// Minimum shot duration (microseconds); cuts closer than this are merged.
    /// Default 500000 (0.5 seconds).
    pub min_shot_us: Option<i64>,
    /// Which passes to run — a subset of `["shots", "stats", "events"]`.
    /// Default all. Drop `"stats"` / `"events"` to skip per-shot frame sampling
    /// and return timing only.
    pub passes: Option<Vec<String>>,
    /// Injected by the TS MCP host (sole state owner) — see DetectPausesArgs.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

#[cfg(feature = "jobs")]
pub(super) async fn analyze_clip(
    b: &Backend,
    args: AnalyzeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let layer = args
        .layer
        .as_ref()
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

    // Video-only: shots are a pixel concept. Reject anything else with an
    // actionable message (mirrors detect_pauses).
    let (media_id, src_in_us, src_out_us) = match &layer.params {
        LayerParams::VideoClip(p) => (p.media, p.src_in_us, p.src_out_us),
        _ => {
            return Err(McpToolError::invalid_params(
                format!(
                    "layer {layer_id} kind is not analyzable for shots — pass a VideoClip layer"
                ),
                None,
            ));
        }
    };
    let media = args.media.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(
            format!("layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_params(
            format!("media {media_id} is not a video — analyze_clip needs a video source"),
            None,
        ));
    }

    let sensitivity = args.sensitivity.unwrap_or(0.4);
    if !(0.0..=1.0).contains(&sensitivity) {
        return Err(McpToolError::invalid_params(
            format!("sensitivity {sensitivity} must be in [0.0, 1.0]"),
            None,
        ));
    }
    let min_shot_us = args.min_shot_us.unwrap_or(500_000);
    if min_shot_us <= 0 {
        return Err(McpToolError::invalid_params(
            format!("min_shot_us {min_shot_us} must be positive"),
            None,
        ));
    }

    // Passes: default all. Unknown tags are rejected so a typo never silently
    // drops a pass. "shots" is always the base; "stats"/"events" gate the
    // per-shot frame sampling.
    let (mut want_stats, mut want_events) = (true, true);
    if let Some(passes) = &args.passes {
        want_stats = passes.iter().any(|p| p == "stats");
        want_events = passes.iter().any(|p| p == "events");
        for p in passes {
            if !matches!(p.as_str(), "shots" | "stats" | "events") {
                return Err(McpToolError::invalid_params(
                    format!("unknown pass {p:?}; expected \"shots\", \"stats\", or \"events\""),
                    None,
                ));
            }
        }
    }

    let opts = jobs::shot::ShotOpts {
        sensitivity,
        min_shot_us,
        stats: want_stats,
        events: want_events,
    };
    // Content-addressed write-through: compute the WHOLE-source report once
    // (keyed by source hash + params, `jobs::shot::cache_key`), cache it, then
    // clip to THIS layer's window. A second call on any layer of the same source
    // with the same params hits the sidecar and skips the ffmpeg scan; the cache
    // shares no namespace with the video-understanding `description` sidecar.
    let source_report = jobs::shot::cached_source_report(&b.cache, media, &opts)
        .await
        .map_err(|e| McpToolError::internal_error(format!("shot analysis: {e:#}"), None))?;
    let report = jobs::shot::clip_report(&source_report, src_in_us, src_out_us);

    ToolResult::json(&report)
}

/// One side of a `compare_frames` pair. `#[schemars(skip)]` on the injected
/// `layer` / `media` keeps each side's ADVERTISED schema exactly
/// `{ layer_id, t_us }`; serde still deserializes the host-injected slice.
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct FrameRef {
    /// Target VideoClip layer id.
    pub layer_id: String,
    /// SOURCE-ABSOLUTE timestamp (microseconds) of the frame to sample — the
    /// same coordinate space as `media://{id}/frame/<t_us>` and the
    /// `keyframe_t_us` / `t_*_us` that `analyze_clip` returns, so a shot cover
    /// frame can be fed straight in.
    pub t_us: i64,
    /// Injected by the TS MCP host (sole state owner) — see DetectPausesArgs.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct CompareFramesArgs {
    /// First frame to compare.
    pub a: FrameRef,
    /// Second frame to compare.
    pub b: FrameRef,
}

/// Resolve one `FrameRef` to `(source_path, t_us)`: the layer must be a VideoClip
/// whose media is a video (same guards as `analyze_clip`). `side` ("a" / "b") is
/// folded into every error so the agent knows which frame is at fault.
#[cfg(feature = "jobs")]
fn resolve_frame_ref(r: &FrameRef, side: &str) -> Result<(std::path::PathBuf, i64), McpToolError> {
    let layer_id = parse_uuid(&r.layer_id, &format!("{side}.layer_id"))?;
    let layer = r.layer.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(format!("{side}: layer {layer_id} not found"), None)
    })?;
    let media_id = match &layer.params {
        LayerParams::VideoClip(p) => p.media,
        _ => {
            return Err(McpToolError::invalid_params(
                format!("{side}: layer {layer_id} is not a VideoClip — compare_frames compares video frames only"),
                None,
            ));
        }
    };
    let media = r.media.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(
            format!("{side}: layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_params(
            format!(
                "{side}: media {media_id} is not a video — compare_frames needs a video source"
            ),
            None,
        ));
    }
    if r.t_us < 0 {
        return Err(McpToolError::invalid_params(
            format!("{side}.t_us {} must be >= 0", r.t_us),
            None,
        ));
    }
    Ok((media.path_abs.clone(), r.t_us))
}

/// `compare_frames` — pairwise perceptual similarity of two video frames.
/// Read-only and cacheless — a pure function: sample one frame per side at its
/// source-absolute `t_us` through the same PNG extract as the shot stats, then a
/// DCT perceptual hash + MSSIM fused into a `similar` verdict.
/// Works across two different clips as well as within one.
#[cfg(feature = "jobs")]
pub(super) async fn compare_frames(
    _b: &Backend,
    args: CompareFramesArgs,
) -> Result<ToolResult, McpToolError> {
    let (path_a, t_a) = resolve_frame_ref(&args.a, "a")?;
    let (path_b, t_b) = resolve_frame_ref(&args.b, "b")?;

    let tmp = tempfile::Builder::new()
        .prefix("weftcut-cmp")
        .tempdir()
        .map_err(|e| McpToolError::internal_error(format!("temp dir: {e}"), None))?;
    let img_a = jobs::shot::extract_rgb(&path_a, t_a, &tmp.path().join("a.png"))
        .await
        .map_err(|e| McpToolError::internal_error(format!("frame a extract: {e:#}"), None))?;
    let img_b = jobs::shot::extract_rgb(&path_b, t_b, &tmp.path().join("b.png"))
        .await
        .map_err(|e| McpToolError::internal_error(format!("frame b extract: {e:#}"), None))?;

    ToolResult::json(&jobs::shot::sim::compare_frames(&img_a, &img_b))
}

// ============================================================
// Media tools
// ============================================================

#[expect(
    dead_code,
    reason = "hybrid-orchestrator stub: TS intercepts import_media before dispatch, so no Rust code reads the field; the struct exists to emit the wire schema"
)]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ImportMediaArgs {
    /// Absolute path to a video / audio / image / subtitle file the host can read.
    pub path: String,
}

/// `import_media` Rust handler is a stub — the tool routes through the hybrid
/// orchestrator (probe_media napi compute → TS-actor write).
#[cfg(feature = "jobs")]
pub(super) async fn import_media(
    _b: &Backend,
    _args: ImportMediaArgs,
) -> Result<ToolResult, McpToolError> {
    Err(McpToolError::internal_error(
        "import_media is handled by the host process (TS actor hybrid)".to_string(),
        None,
    ))
}

// ============================================================
// detect_pauses peak-scan helpers
// ============================================================

/// The source time a peak window opens at, on the peaks file's own rational
/// timebase. Every duration in the scan is a difference of two of these, so
/// nothing is ever resampled to a nominal rate.
#[cfg(feature = "jobs")]
#[inline]
fn peak_time_us(idx: usize, sample_rate: u32, frames_per_peak: u32) -> i64 {
    ((idx as i128 * frames_per_peak as i128 * 1_000_000) / sample_rate as i128) as i64
}

/// Scan a peaks array and return timeline-absolute pauses: runs where every
/// value is strictly below `threshold_amp`, bridged over short loud
/// interruptions, whose clipped duration is ≥ `min_pause_us`.
#[cfg(feature = "jobs")]
#[allow(clippy::too_many_arguments)]
fn detect_pauses_in_peaks(
    peaks: &[f32],
    threshold_amp: f32,
    min_pause_us: i64,
    bridge_us: i64,
    src_in_us: i64,
    src_out_us: i64,
    layer_t_start_us: i64,
    sample_rate: u32,
    frames_per_peak: u32,
) -> Vec<PauseRegion> {
    // Quiet runs first, as half-open window ranges in scan order.
    let mut quiet: Vec<(usize, usize)> = Vec::new();
    let mut run_start: Option<usize> = None;
    for (i, &p) in peaks.iter().enumerate() {
        match (p < threshold_amp, run_start) {
            (true, None) => run_start = Some(i),
            (false, Some(start)) => {
                quiet.push((start, i));
                run_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = run_start {
        quiet.push((start, peaks.len()));
    }

    // Bridge: a loud run shorter than `bridge_us` BETWEEN two quiet runs is
    // absorbed, so a cough or a click no longer splits one pause into two
    // sub-minimum halves that both vanish. A loud run at either end of the
    // scan has no quiet run on one side, so it is never a bridge — which is
    // exactly what "between two quiet runs" already says.
    let mut bridged: Vec<(usize, usize)> = Vec::with_capacity(quiet.len());
    for (start, end) in quiet {
        let absorb = bridged.last().is_some_and(|&(_, prev_end)| {
            peak_time_us(start, sample_rate, frames_per_peak)
                - peak_time_us(prev_end, sample_rate, frames_per_peak)
                < bridge_us
        });
        match bridged.last_mut() {
            Some(prev) if absorb => prev.1 = end,
            _ => bridged.push((start, end)),
        }
    }

    let mut regions = Vec::new();
    for (start, end) in bridged {
        push_if_long_enough(
            &mut regions,
            start,
            end,
            sample_rate,
            frames_per_peak,
            min_pause_us,
            src_in_us,
            src_out_us,
            layer_t_start_us,
        );
    }
    regions
}

#[cfg(feature = "jobs")]
#[allow(clippy::too_many_arguments)]
fn push_if_long_enough(
    out: &mut Vec<PauseRegion>,
    start_idx: usize,
    end_idx: usize, // exclusive
    sample_rate: u32,
    frames_per_peak: u32,
    min_pause_us: i64,
    src_in_us: i64,
    src_out_us: i64,
    layer_t_start_us: i64,
) {
    let src_pause_start = peak_time_us(start_idx, sample_rate, frames_per_peak);
    let src_pause_end = peak_time_us(end_idx, sample_rate, frames_per_peak);
    // Intersect with the layer's source window — peaks beyond src_out_us
    // belong to media the layer doesn't reference.
    let src_start = src_pause_start.max(src_in_us);
    let src_end = src_pause_end.min(src_out_us);
    if src_end - src_start < min_pause_us {
        return;
    }
    let t_start = layer_t_start_us + (src_start - src_in_us);
    let t_end = layer_t_start_us + (src_end - src_in_us);
    out.push(PauseRegion {
        t_start_us: t_start,
        t_end_us: t_end,
    });
}

/// 10th percentile (nearest-rank) of the peaks whose window lies wholly inside
/// the layer's source window; 0.0 when the window holds none. Nearest-rank on a
/// sorted copy rather than an interpolated quantile: the value returned is one
/// the audio actually reached, which is what "noise floor" has to mean for the
/// UI to offer it as a threshold.
#[cfg(feature = "jobs")]
fn noise_floor_p10(
    peaks: &[f32],
    src_in_us: i64,
    src_out_us: i64,
    sample_rate: u32,
    frames_per_peak: u32,
) -> f32 {
    let mut inside: Vec<f32> = peaks
        .iter()
        .enumerate()
        .filter(|(i, _)| {
            peak_time_us(*i, sample_rate, frames_per_peak) >= src_in_us
                && peak_time_us(*i + 1, sample_rate, frames_per_peak) <= src_out_us
        })
        .map(|(_, &p)| p)
        .collect();
    if inside.is_empty() {
        return 0.0;
    }
    inside.sort_by(|a, b| a.total_cmp(b));
    // Integer nearest-rank so no float rounding can push the rank a slot over.
    let rank = (inside.len() * 10).div_ceil(100).max(1);
    inside[rank - 1]
}

// ============================================================
// Tests for the free-fn tool surface.
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================
    // detect_pauses_in_peaks — the pause scan
    // ============================================================

    /// 100 peaks/sec means each peak covers 10_000us. Easier to think in
    /// "peak indices" when constructing fixtures.
    #[cfg(feature = "jobs")]
    const US_PER_PEAK: i64 = 10_000;

    /// The shipped `bridge_us` default, so the fixtures below exercise the
    /// number the tool actually runs with.
    #[cfg(feature = "jobs")]
    const BRIDGE: i64 = 80_000;

    #[cfg(feature = "jobs")]
    fn flat_peaks(n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|_| amp).collect()
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_returns_empty_for_loud_track() {
        let peaks = flat_peaks(500, 0.5);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 500_000, BRIDGE, 0, 5_000_000, 0, 100, 1);
        assert!(regions.is_empty());
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_finds_single_quiet_window() {
        // 200 peaks (= 2s) total. Quiet from peak 50 (= 500ms) to peak 150
        // (= 1500ms), so the pause lasts 1000ms.
        let mut peaks = flat_peaks(200, 0.5);
        peaks[50..150].fill(0.001);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 500_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 50 * US_PER_PEAK);
        assert_eq!(regions[0].t_end_us, 150 * US_PER_PEAK);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_filters_out_runs_shorter_than_min_duration() {
        // 200 peaks (= 2s). Three quiet runs of 30 peaks each (= 300ms).
        // With min_pause_us=500_000 (500ms) none should be returned.
        let mut peaks = flat_peaks(200, 0.5);
        peaks[0..30].fill(0.0);
        peaks[80..110].fill(0.0);
        peaks[160..190].fill(0.0);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 500_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert!(regions.is_empty(), "expected no regions, got {regions:?}");

        // With min_pause_us=200_000 (200ms) all three should be returned.
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 200_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 3);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_handles_a_pause_at_the_tail() {
        // Quiet from peak 100 to the end (peak 200). Runs to EOF — make
        // sure the closing branch flushes the pending region.
        let mut peaks = flat_peaks(200, 0.5);
        peaks[100..200].fill(0.0);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 500_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 100 * US_PER_PEAK);
        assert_eq!(regions[0].t_end_us, 200 * US_PER_PEAK);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_shifts_by_layer_t_start_us() {
        // Layer placed at timeline t=5s. Source [0, 2s]. Pause at source
        // [0.5s, 1.5s] → timeline [5.5s, 6.5s].
        let mut peaks = flat_peaks(200, 0.5);
        peaks[50..150].fill(0.0);
        let regions = detect_pauses_in_peaks(
            &peaks, 0.02, 500_000, BRIDGE, 0, 2_000_000, 5_000_000, 100, 1,
        );
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 5_500_000);
        assert_eq!(regions[0].t_end_us, 6_500_000);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_clips_to_layer_source_window() {
        // Peaks cover 2s of source. Layer references only source [0.3s, 1.7s].
        // A pause spanning the WHOLE peaks file [0, 2s] should clip to
        // [0.3s, 1.7s] in source coords → timeline [0, 1.4s] for a layer
        // anchored at t=0.
        let peaks = flat_peaks(200, 0.0);
        let regions = detect_pauses_in_peaks(
            &peaks, 0.02, 100_000, BRIDGE, 300_000,   // src_in_us
            1_700_000, // src_out_us
            0,         // layer_t_start_us
            100, 1,
        );
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 0);
        assert_eq!(regions[0].t_end_us, 1_400_000);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_threshold_is_strict_below() {
        // Peaks exactly at threshold are NOT quiet.
        let peaks = flat_peaks(200, 0.02);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 100_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert!(regions.is_empty());

        // Just below threshold → a pause.
        let peaks = flat_peaks(200, 0.019);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 100_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 1);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_pauses_uses_rational_peak_timebase_without_long_drift() {
        let mut peaks = flat_peaks(800, 0.5);
        for peak in &mut peaks[783..790] {
            *peak = 0.0;
        }
        let regions = detect_pauses_in_peaks(&peaks, 0.02, 1, 0, 0, 200_000_000, 0, 22_050, 2_816);
        assert_eq!(regions.len(), 1);
        assert_eq!(
            regions[0].t_start_us,
            (783_i128 * 2_816 * 1_000_000 / 22_050) as i64
        );
        assert_eq!(
            regions[0].t_end_us,
            (790_i128 * 2_816 * 1_000_000 / 22_050) as i64
        );
    }

    /// A click, a cough or lip noise is 30–100 ms; without the bridge it splits
    /// one pause into halves that are each under the minimum and both vanish.
    #[cfg(feature = "jobs")]
    #[test]
    fn bridge_absorbs_a_burst_shorter_than_bridge_us() {
        // 1s of quiet (peaks 50..150) with a 60 ms burst at 940 ms.
        let mut peaks = flat_peaks(200, 0.5);
        peaks[50..150].fill(0.0);
        peaks[94..100].fill(0.6);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 300_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 1, "60 ms burst must not end the pause");
        assert_eq!(regions[0].t_start_us, 50 * US_PER_PEAK);
        assert_eq!(regions[0].t_end_us, 150 * US_PER_PEAK);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn bridge_does_not_absorb_a_burst_at_or_over_bridge_us() {
        // Same layout, 120 ms of speech in the middle: two pauses, not one.
        let mut peaks = flat_peaks(200, 0.5);
        peaks[50..150].fill(0.0);
        peaks[94..106].fill(0.6);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 300_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 2, "120 ms of sound ends the pause");
        assert_eq!(regions[0].t_end_us, 94 * US_PER_PEAK);
        assert_eq!(regions[1].t_start_us, 106 * US_PER_PEAK);

        // Exactly `bridge_us` ends it too — the comparison is strict.
        let mut peaks = flat_peaks(200, 0.5);
        peaks[50..150].fill(0.0);
        peaks[94..102].fill(0.6);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 300_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(
            regions.len(),
            2,
            "a run of exactly bridge_us ends the pause"
        );
    }

    /// A loud run at either end of the scan has no quiet run on one side, so it
    /// can never be bridged away — the pause starts where the sound stops.
    #[cfg(feature = "jobs")]
    #[test]
    fn bridge_never_absorbs_a_loud_run_at_the_scan_edge() {
        let mut peaks = flat_peaks(200, 0.0);
        peaks[0..6].fill(0.6);
        peaks[194..200].fill(0.6);
        let regions =
            detect_pauses_in_peaks(&peaks, 0.02, 300_000, BRIDGE, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 6 * US_PER_PEAK);
        assert_eq!(regions[0].t_end_us, 194 * US_PER_PEAK);
    }

    // ============================================================
    // noise_floor_p10
    // ============================================================

    #[cfg(feature = "jobs")]
    #[test]
    fn noise_floor_is_the_tenth_percentile_of_the_window() {
        // A ramp 0.00 .. 0.99 over 100 windows: nearest-rank P10 is the 10th
        // smallest, 0.09.
        let peaks: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        let floor = noise_floor_p10(&peaks, 0, 1_000_000, 100, 1);
        assert!(
            (floor - 0.1).abs() < 0.02,
            "P10 of a 0..1 ramp should sit near 0.1, got {floor}"
        );
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn noise_floor_reads_only_the_layers_source_window() {
        // Quiet first half, loud second. A layer that starts at 1s sees only
        // the loud half, so its floor is loud too.
        let mut peaks = flat_peaks(200, 0.5);
        peaks[0..100].fill(0.001);
        assert!(noise_floor_p10(&peaks, 0, 2_000_000, 100, 1) < 0.01);
        assert_eq!(noise_floor_p10(&peaks, 1_000_000, 2_000_000, 100, 1), 0.5);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn noise_floor_is_zero_when_the_window_holds_no_peak() {
        let peaks = flat_peaks(200, 0.5);
        assert_eq!(noise_floor_p10(&peaks, 500_000, 500_000, 100, 1), 0.0);
        assert_eq!(noise_floor_p10(&[], 0, 2_000_000, 100, 1), 0.0);
    }

    // ============================================================
    // detect_pauses — the tool handler
    // ============================================================

    #[cfg(feature = "jobs")]
    fn audio_layer(src_in_us: i64, src_out_us: i64) -> crate::state::Layer {
        use crate::state::{new_id, AudioParams, Layer, LayerParams};
        Layer {
            id: new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: src_out_us - src_in_us,
            enabled: true,
            locked: false,
            metadata: Default::default(),
            params: LayerParams::Audio(AudioParams {
                media: new_id(),
                src_in_us,
                src_out_us,
                gain_db: Default::default(),
                pan: Default::default(),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
                role: Default::default(),
            }),
            effects: Vec::new(),
        }
    }

    #[cfg(feature = "jobs")]
    fn audio_media(hash: &str) -> crate::state::MediaItem {
        use crate::state::{new_id, DecodeRoute, MediaItem, MediaKind, MediaMetadata};
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: std::path::PathBuf::from("/nonexistent/source.wav"),
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata::default(),
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    /// Write a one-level mono peaks file whose windows are `amps`. 441 frames
    /// per peak is the coarsest window that divides evenly into microseconds
    /// at the fixed 22 050 Hz peaks rate, so a window is exactly 20 ms and the
    /// expected region bounds are round numbers.
    #[cfg(feature = "jobs")]
    const TEST_FRAMES_PER_PEAK: u32 = 441;
    #[cfg(feature = "jobs")]
    const TEST_US_PER_PEAK: i64 = 20_000;

    #[cfg(feature = "jobs")]
    async fn write_test_peaks(path: &std::path::Path, amps: &[f32]) {
        use crate::jobs::waveform::{quantize, quantize_rms, write_peaks, LevelData};
        let level = LevelData {
            channels: 1,
            peak_count: amps.len() as u32,
            mins: vec![amps.iter().map(|a| quantize(-a)).collect()],
            maxs: vec![amps.iter().map(|a| quantize(*a)).collect()],
            rmss: vec![amps.iter().map(|a| quantize_rms(*a)).collect()],
        };
        write_peaks(path, 1, &[(TEST_FRAMES_PER_PEAK, level)])
            .await
            .expect("write test peaks");
    }

    /// The subject rule: only `LayerParams::Audio` reaches the mixer, so a
    /// VideoClip arriving here means the host skipped link resolution. The
    /// refusal has to say which layer and what to pass instead.
    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn detect_pauses_refuses_a_videoclip_subject() {
        use crate::state::{new_id, Layer, LayerParams, Transform, VideoClipParams};
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let layer = Layer {
            id: new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: Default::default(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: new_id(),
                src_in_us: 0,
                src_out_us: 1_000_000,
                transform: Transform::default(),
                opacity: Default::default(),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
            effects: Vec::new(),
        };
        let layer_id = layer.id;
        let err = detect_pauses(
            &b,
            DetectPausesArgs {
                layer_id: layer_id.to_string(),
                threshold_amp: None,
                min_pause_us: None,
                bridge_us: None,
                layer: Some(layer),
                media: None,
                peaks_path: None,
            },
        )
        .await
        .expect_err("a VideoClip is never a subject");
        assert_eq!(
            err.message,
            format!(
                "layer {layer_id} is a VideoClip; pass its Audio layer (the host resolves a linked partner)"
            )
        );
    }

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn detect_pauses_refuses_bridge_at_or_over_min_pause() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let layer = audio_layer(0, 2_000_000);
        let err = detect_pauses(
            &b,
            DetectPausesArgs {
                layer_id: layer.id.to_string(),
                threshold_amp: None,
                min_pause_us: Some(500_000),
                bridge_us: Some(500_000),
                layer: Some(layer),
                media: Some(audio_media("no-such-waveform")),
                peaks_path: None,
            },
        )
        .await
        .expect_err("bridge_us == min_pause_us is refused");
        assert_eq!(
            err.message,
            "bridge_us 500000 must be below min_pause_us 500000"
        );
    }

    /// Decision 11: detection reads what PLAYS. When the host injects a ready
    /// fx peaks file the tool reads THAT and says so — here the media's own
    /// waveform does not exist at all, so a fallback would refuse instead.
    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn detect_pauses_reads_the_injected_peaks_path_and_reports_fx() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let dir = std::env::temp_dir().join(format!("weftcut-pauses-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let fx_peaks = dir.join("fx.v4.peaks");
        // 4 s of speech over room tone, with 1 s of tone alone from 0.5 s; the
        // layer sees the first 2 s of it.
        let mut amps = vec![0.5f32; 200];
        amps[25..75].fill(0.004);
        write_test_peaks(&fx_peaks, &amps).await;
        assert_eq!(25 * TEST_US_PER_PEAK, 500_000);

        let layer = audio_layer(0, 2_000_000);
        let result = detect_pauses(
            &b,
            DetectPausesArgs {
                layer_id: layer.id.to_string(),
                threshold_amp: None,
                min_pause_us: None,
                bridge_us: None,
                layer: Some(layer),
                media: Some(audio_media("raw-waveform-never-built")),
                peaks_path: Some(fx_peaks.to_string_lossy().into_owned()),
            },
        )
        .await
        .expect("the injected peaks file is read instead of the missing raw one");
        let v = serde_json::to_value(&result).unwrap();
        let body: serde_json::Value =
            serde_json::from_str(v["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["peaks_source"], "fx");
        assert_eq!(body["pauses"].as_array().unwrap().len(), 1);
        assert_eq!(body["pauses"][0]["t_start_us"], 500_000);
        assert_eq!(body["pauses"][0]["t_end_us"], 1_500_000);
        let floor = body["noise_floor_amp"]
            .as_f64()
            .expect("a floor is reported");
        assert!(
            (floor - 0.004).abs() < 0.0005,
            "the floor is the room tone, not the speech over it; got {floor}"
        );

        // An override that is not on disk falls back to the raw path, which
        // here is the wait-for-the-waveform refusal.
        let layer = audio_layer(0, 2_000_000);
        let err = detect_pauses(
            &b,
            DetectPausesArgs {
                layer_id: layer.id.to_string(),
                threshold_amp: None,
                min_pause_us: None,
                bridge_us: None,
                layer: Some(layer),
                media: Some(audio_media("raw-waveform-never-built")),
                peaks_path: Some(dir.join("missing.v4.peaks").to_string_lossy().into_owned()),
            },
        )
        .await
        .expect_err("no fx file, no raw file");
        assert!(
            err.message.starts_with("waveform not generated yet"),
            "the renderer matches on the leading phrase; got: {}",
            err.message
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Subtitle cue-shift + parse coverage lives in the subtitles module tests +
    // the TS-side hybrid e2e.
}

// ============================================================
// Cloud tools: transcribe_clip + synthesize_speech. Gated on feature = "speech".
// ============================================================

#[cfg(feature = "speech")]
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub(super) struct TranscribeClipArgs {
    /// Target VideoClip or Audio layer id.
    pub layer_id: String,
    /// Optional transcription window start in timeline microseconds.
    /// Defaults to the layer's `t_start_us`. Must lie within the layer.
    #[serde(default)]
    pub t_start_us: Option<i64>,
    /// Optional transcription window end in timeline microseconds.
    /// Defaults to the layer's `t_end_us`. Must lie within the layer.
    #[serde(default)]
    pub t_end_us: Option<i64>,
    /// Optional ISO-639-1 language hint (`"en"`, `"zh"`). Auto-detect when omitted.
    #[serde(default)]
    pub language: Option<String>,
    /// Optional STRICT backend override: `"openai"` | `"whisper_cpp"` |
    /// `"funasr"`. When set, that engine serves the request or the call errors
    /// naming its exact gap (missing key / binary / model) — it never
    /// substitutes another engine, so an explicit local choice can never leak
    /// audio to a cloud provider. When omitted, the resolver walks the user's
    /// preference then availability. An unknown value is rejected.
    #[serde(default)]
    pub backend: Option<String>,
    /// Injected by the TS MCP host from the user's Settings preferred-engine —
    /// a SOFT hint (falls back by availability), unlike the agent-visible
    /// strict `backend` above. Unknown tags are ignored. Never advertised.
    #[serde(default)]
    #[schemars(skip)]
    pub preferred_backend: Option<String>,
    /// Request exact per-word timestamps when the chosen backend can emit them
    /// (whisper.cpp → `-ojf`). Defaults to `true` — the backend's best
    /// precision, at no extra engine cost; pass `false` to force the SRT-style
    /// (interpolated) output instead. OpenAI Whisper is SRT-only and ignores
    /// it either way; check `word_timing` in the result for what you got.
    #[serde(default)]
    pub word_timestamps: Option<bool>,
    /// Injected by the TS MCP host (sole state owner) — see DetectPausesArgs.
    /// `skip_serializing` keeps the slice out of the tool's log details.
    #[serde(default, skip_serializing)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default, skip_serializing)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

#[cfg(feature = "speech")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SynthesizeSpeechArgs {
    /// Text to synthesize. tts-1 caps at 4096 characters.
    pub text: String,
    /// Voice identifier. tts-1 accepts: alloy, echo, fable, onyx, nova, shimmer.
    pub voice: String,
    /// 0.25..4.0 for tts-1. Omit to use the provider default (~1.0).
    #[serde(default)]
    pub speed: Option<f32>,
    /// Optional Audio track id. If omitted, lands on the first existing Audio
    /// track or auto-creates one labeled "Voiceover".
    #[cfg_attr(
        not(feature = "test-noop"),
        expect(
            dead_code,
            reason = "placement is applied TS-side; kept for wire-schema stability"
        )
    )]
    #[serde(default)]
    pub target_track_id: Option<String>,
    /// Optional timeline start in microseconds. Defaults to the composition's
    /// current `duration_us` so the voiceover appends at the end.
    #[cfg_attr(
        not(feature = "test-noop"),
        expect(
            dead_code,
            reason = "placement is applied TS-side; kept for wire-schema stability"
        )
    )]
    #[serde(default)]
    pub t_start_us: Option<i64>,
}

/// Shared source-audio coordinates for transcription and model-free extraction.
#[cfg(feature = "speech")]
#[derive(Debug)]
pub(super) struct ResolvedClipAudio {
    /// The media the window was read from — resolved here so a caller never
    /// re-derives it from the injected slice it already handed us.
    pub media_id: crate::state::MediaId,
    pub source_path: std::path::PathBuf,
    pub source_hash: String,
    /// Source-relative microseconds: where to start the ffmpeg slice.
    pub source_in_us: i64,
    /// Source-relative microseconds: where to end the ffmpeg slice.
    pub source_out_us: i64,
    /// Timeline-absolute microseconds of the slice's start — what we shift
    /// the SRT cue timestamps by so they land on the timeline.
    pub timeline_start_us: i64,
    /// Timeline-absolute microseconds of the slice's exclusive end: the
    /// defaulted `t_end_us`, so the caller reports the window it actually got
    /// rather than the one it asked for.
    pub timeline_end_us: i64,
}

/// Find a layer with audio attached (VideoClip or Audio), validate the
/// requested timeline window lies inside it, and map that window onto the
/// source media's coordinate space.
#[cfg(feature = "speech")]
pub(super) fn resolve_clip_audio_source(
    layer: Option<&crate::state::Layer>,
    media: Option<&crate::state::MediaItem>,
    layer_id: LayerId,
    t_start_arg: Option<i64>,
    t_end_arg: Option<i64>,
) -> Result<ResolvedClipAudio, McpToolError> {
    use crate::state::{AudioParams, VideoClipParams};

    let layer = layer
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

    let (media_id, src_in_us, src_out_us) = match &layer.params {
        LayerParams::VideoClip(VideoClipParams {
            media,
            src_in_us,
            src_out_us,
            speed,
            ..
        }) => {
            if (*speed - 1.0).abs() > f64::EPSILON {
                return Err(McpToolError::invalid_params(
                    format!(
                        "clip audio does not yet support speed != 1.0 (layer speed={speed}); \
                         split off a speed-1 segment first",
                    ),
                    None,
                ));
            }
            (*media, *src_in_us, *src_out_us)
        }
        LayerParams::Audio(AudioParams {
            media,
            src_in_us,
            src_out_us,
            ..
        }) => (*media, *src_in_us, *src_out_us),
        _ => {
            return Err(McpToolError::invalid_params(
                format!(
                    "layer {layer_id} has no source audio — pass a VideoClip or Audio layer",
                ),
                None,
            ));
        }
    };

    let media = media.ok_or_else(|| {
        McpToolError::invalid_params(
            format!(
                "layer {layer_id} references missing media {media_id} (project state is inconsistent)",
            ),
            None,
        )
    })?;
    if media.metadata.audio.is_none() {
        return Err(McpToolError::invalid_params(
            format!("media {media_id} has no audio stream"),
            None,
        ));
    }

    let t_start = t_start_arg.unwrap_or(layer.t_start_us);
    let t_end = t_end_arg.unwrap_or(layer.t_end_us);
    if t_end <= t_start {
        return Err(McpToolError::invalid_params(
            format!(
                "audio window must have positive duration (t_start_us={t_start}, t_end_us={t_end})",
            ),
            None,
        ));
    }
    if t_start < layer.t_start_us || t_end > layer.t_end_us {
        return Err(McpToolError::invalid_params(
            format!(
                "audio window [{t_start}, {t_end}] is outside layer range [{}, {}]",
                layer.t_start_us, layer.t_end_us,
            ),
            None,
        ));
    }

    let to_source = |t: i64| {
        t.checked_sub(layer.t_start_us)
            .and_then(|offset| src_in_us.checked_add(offset))
            .filter(|t| *t >= 0)
            .ok_or_else(|| McpToolError::invalid_params("audio window maps outside supported source timestamps", None))
    };
    let source_in = to_source(t_start)?;
    let source_out = to_source(t_end)?;
    if source_out > src_out_us {
        return Err(McpToolError::invalid_params(
            format!(
                "audio window maps past the layer's source range (source_out={source_out} > src_out_us={src_out_us})",
            ),
            None,
        ));
    }

    Ok(ResolvedClipAudio {
        media_id,
        source_path: media.path_abs.clone(),
        source_hash: media.file_hash_blake3.clone(),
        source_in_us: source_in,
        source_out_us: source_out,
        timeline_start_us: t_start,
        timeline_end_us: t_end,
    })
}

/// Write synthesized audio bytes atomically to the cache. Mirrors the
/// `<dest>.tmp → promote_temp` pattern from the jobs module so an interrupted
/// write never leaves a zero-byte file that `cached_ok` would happily skip.
#[cfg(feature = "speech")]
async fn write_voiceover_atomic(dest: &std::path::Path, bytes: &[u8]) -> Result<(), anyhow::Error> {
    use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path};
    use anyhow::Context;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let tmp = temp_path(dest);
    let _ = tokio::fs::remove_file(&tmp).await;
    tokio::fs::write(&tmp, bytes)
        .await
        .with_context(|| format!("write {}", tmp.display()))?;
    if !cached_ok(&tmp) {
        discard_temp(dest);
        anyhow::bail!("synthesized audio is empty after write");
    }
    promote_temp(dest)?;
    Ok(())
}

/// Map a `speech::SpeechError` to an `McpToolError` so the agent sees a structured
/// failure (missing key, invalid key, rate-limited, too-large payload) with
/// actionable recovery steps in the message.
#[cfg(feature = "speech")]
fn map_speech_error(e: speech::SpeechError) -> McpToolError {
    use speech::SpeechError as E;
    let message = e.to_string();
    match e {
        E::MissingKey { .. } | E::InvalidKey { .. } => McpToolError::invalid_request(message, None),
        E::PayloadTooLarge { .. } => McpToolError::invalid_params(message, None),
        E::RateLimited { .. } | E::Provider { .. } | E::Network(_) => {
            McpToolError::internal_error(message, None)
        }
        E::Io(_) | E::AudioExtract(_) | E::Parse(_) => McpToolError::internal_error(message, None),
        // Local CLI-sidecar failures (whisper.cpp / FunASR): the message already
        // carries the exit code + engine stderr / the spawn cause / the timeout.
        E::EngineExit { .. } | E::Spawn { .. } | E::Timeout { .. } => {
            McpToolError::internal_error(message, None)
        }
    }
}

/// JSON envelope `transcribe_clip` returns: the normalized transcript
/// (`segments` with per-word spans, detected `language`, `word_timing`
/// provenance), the `backend` tag that actually served the request (so a
/// fallback pick is visible, not silent), PLUS a rendered `srt` field. The
/// agent inspects `segments` for word-level editing and pipes `srt` straight
/// into `apply_subtitles` (which still expects an SRT body). Borrows the
/// transcript so we serialize without cloning the segment vec.
#[cfg(feature = "speech")]
#[derive(Serialize)]
struct TranscribeClipResult<'a> {
    backend: &'a str,
    segments: &'a [speech::Segment],
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
    word_timing: speech::WordTiming,
    srt: String,
}

#[cfg(feature = "speech")]
pub(super) async fn transcribe_clip(
    b: &Backend,
    args: TranscribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let resolved = resolve_clip_audio_source(
        args.layer.as_ref(),
        args.media.as_ref(),
        layer_id,
        args.t_start_us,
        args.t_end_us,
    )?;

    // Explicit `backend` → STRICT; unknown tag → clean invalid_params. Matched
    // against the stable `as_str` wire tag (not the serde form).
    let explicit = match args.backend.as_deref() {
        None => None,
        Some(tag) => Some(
            speech::SpeechBackend::all()
                .iter()
                .copied()
                .find(|b| b.as_str() == tag)
                .ok_or_else(|| {
                    McpToolError::invalid_params(
                        format!(
                            "unknown backend {tag:?}; expected \"openai\", \"whisper_cpp\", or \"funasr\""
                        ),
                        None,
                    )
                })?,
        ),
    };
    // Host-injected user preference → SOFT hint for the resolver's
    // preference-then-availability walk. Unknown/absent tags fall to None.
    let preferred = args.preferred_backend.as_deref().and_then(|tag| {
        speech::SpeechBackend::all()
            .iter()
            .copied()
            .find(|b| b.as_str() == tag)
    });

    let (used_backend, transcriber) = {
        let cfg = b.speech_config.lock().expect("speech_config poisoned");
        match explicit.or(preferred) {
            Some(b) => (
                b,
                // Strict-resolution failures are the caller's/config's to fix
                // (wrong choice or missing key/binary/model) → invalid_request,
                // not internal_error.
                speech::resolve_transcriber_exact(b, &cfg)
                    .map_err(|e| McpToolError::invalid_request(e.to_string(), None))?,
            ),
            None => speech::resolve_transcriber(preferred, &cfg).ok_or_else(|| {
                McpToolError::invalid_request(speech::NO_TRANSCRIBER_CONFIGURED, None)
            })?,
        }
    };

    let audio_path = speech::audio_extract::extract_audio_window(
        &b.cache,
        &resolved.source_path,
        &resolved.source_hash,
        resolved.source_in_us,
        resolved.source_out_us,
    )
    .await
    .map_err(|e| McpToolError::internal_error(format!("audio extract: {e:#}"), None))?;

    let raw = transcriber
        .transcribe(speech::TranscribeRequest {
            audio_path,
            language: args.language,
            want_word_timing: args.word_timestamps.unwrap_or(true),
        })
        .await
        .map_err(map_speech_error)?;

    // Normalize the backend's raw style → one Transcript, then place the
    // audio-slice-relative times on the timeline.
    let mut transcript = speech::parse_raw(raw).map_err(map_speech_error)?;
    transcript.shift(resolved.timeline_start_us);

    let srt = transcript.render_srt();
    let result = TranscribeClipResult {
        backend: used_backend.as_str(),
        segments: &transcript.segments,
        language: transcript.language.as_deref(),
        word_timing: transcript.word_timing,
        srt,
    };
    ToolResult::json(&result)
}

// ============================================================
// Video-understanding tool: describe_clip. Gated on feature = "speech" (reuses
// jobs ffmpeg for frame sampling + the speech HTTP client for cloud/BYO). The
// architectural twin of transcribe_clip; see native/src/vlm/.
// ============================================================

#[cfg(feature = "speech")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct DescribeClipArgs {
    /// Target VideoClip layer id.
    pub layer_id: String,
    /// Optional window start in timeline microseconds. Defaults to the layer's
    /// `t_start_us`. Must lie within the layer.
    #[serde(default)]
    pub t_start_us: Option<i64>,
    /// Optional window end in timeline microseconds. Defaults to the layer's
    /// `t_end_us`. Must lie within the layer.
    #[serde(default)]
    pub t_end_us: Option<i64>,
    /// Frames sampled per second across the window. Higher = finer temporal
    /// detail at more cost; capped so the frame set fits the model's context.
    /// Defaults to the app's Video-understanding setting, which the host injects
    /// when this is omitted; with no host, 1.0. Part of the cache key.
    #[serde(default)]
    pub fps: Option<f64>,
    /// Prompt focus: `"general"` or `"shot-type"` (biases `tags` toward shot
    /// type / camera). Defaults to the app's Video-understanding setting, which
    /// the host injects when this is omitted; with no host, `"general"`. Part of
    /// the cache key.
    #[serde(default)]
    pub focus: Option<String>,
    /// Language the `text` and `tags` come back in, as a BCP-47 tag
    /// (`"en-US"`, `"zh-CN"`, `"ja"`, …). Defaults to the app's UI language,
    /// which the host injects when this is omitted; with no host, `"en-US"`.
    /// Part of the cache key — a description in another language is a different
    /// description, not a translation of this one.
    #[serde(default)]
    pub language: Option<String>,
    /// Optional STRICT backend override: `"qwen3_vl"` | `"minicpm_v"` |
    /// `"byo_endpoint"`. When set, that engine serves the request or the call
    /// errors naming its exact gap — it never substitutes another engine, so an
    /// explicit local choice can never leak frames over the network.
    /// When omitted, selection is preference then availability. Unknown → rejected.
    #[serde(default)]
    pub backend: Option<String>,
    /// Injected by the TS MCP host from the user's Settings preferred VLM engine
    /// — a SOFT hint (falls back by availability). Never advertised.
    #[serde(default)]
    #[schemars(skip)]
    pub preferred_backend: Option<String>,
    /// Injected by the TS MCP host: the merged video-understanding backend
    /// config snapshot (cloud key + local paths + endpoint), keyed by backend
    /// tag. The subsystem is stateless (ADR 0024) — unlike transcribe_clip, VLM
    /// config is not held on `Backend`; it rides in with the call. `#[schemars(skip)]`
    /// keeps it out of the advertised schema; empty → "no backend available".
    #[serde(default)]
    #[schemars(skip)]
    pub vlm_config: std::collections::HashMap<String, crate::vlm::BackendConfig>,
    /// Injected by the TS MCP host (sole state owner) — see DetectPausesArgs.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

/// Resolved source-video coordinates for a `describe_clip` call.
#[cfg(feature = "speech")]
#[derive(Debug)]
struct ResolvedClipVideo {
    source_path: std::path::PathBuf,
    source_hash: String,
    /// Source-relative microseconds: the window mapped onto the source.
    source_in_us: i64,
    source_out_us: i64,
}

/// Find a VideoClip layer, validate the requested timeline window lies inside
/// it, and map that window onto the source media's coordinate space. Mirrors
/// `resolve_clip_audio_source` but video-only (frames, not audio).
#[cfg(feature = "speech")]
fn resolve_clip_video_source(
    layer: Option<&crate::state::Layer>,
    media: Option<&crate::state::MediaItem>,
    layer_id: LayerId,
    t_start_arg: Option<i64>,
    t_end_arg: Option<i64>,
) -> Result<ResolvedClipVideo, McpToolError> {
    use crate::state::VideoClipParams;

    let layer = layer
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

    let (media_id, src_in_us, src_out_us) = match &layer.params {
        LayerParams::VideoClip(VideoClipParams {
            media,
            src_in_us,
            src_out_us,
            speed,
            ..
        }) => {
            if (*speed - 1.0).abs() > f64::EPSILON {
                return Err(McpToolError::invalid_params(
                    format!(
                        "describe_clip does not yet support speed != 1.0 (layer speed={speed}); \
                         split off a speed-1 segment first",
                    ),
                    None,
                ));
            }
            (*media, *src_in_us, *src_out_us)
        }
        _ => {
            return Err(McpToolError::invalid_params(
                format!("layer {layer_id} kind is not describable — pass a VideoClip layer"),
                None,
            ));
        }
    };

    let media = media.ok_or_else(|| {
        McpToolError::invalid_params(
            format!(
                "layer {layer_id} references missing media {media_id} (project state is inconsistent)",
            ),
            None,
        )
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_params(
            format!("media {media_id} is not a video — describe_clip needs a video source"),
            None,
        ));
    }

    let t_start = t_start_arg.unwrap_or(layer.t_start_us);
    let t_end = t_end_arg.unwrap_or(layer.t_end_us);
    if t_end <= t_start {
        return Err(McpToolError::invalid_params(
            format!(
                "description window must have positive duration (t_start_us={t_start}, t_end_us={t_end})",
            ),
            None,
        ));
    }
    if t_start < layer.t_start_us || t_end > layer.t_end_us {
        return Err(McpToolError::invalid_params(
            format!(
                "description window [{t_start}, {t_end}] is outside layer range [{}, {}]",
                layer.t_start_us, layer.t_end_us,
            ),
            None,
        ));
    }

    let source_in = src_in_us + (t_start - layer.t_start_us);
    let source_out = src_in_us + (t_end - layer.t_start_us);
    if source_out > src_out_us {
        return Err(McpToolError::invalid_params(
            format!(
                "description window maps past the layer's source range (source_out={source_out} > src_out_us={src_out_us})",
            ),
            None,
        ));
    }

    Ok(ResolvedClipVideo {
        source_path: media.path_abs.clone(),
        source_hash: media.file_hash_blake3.clone(),
        source_in_us: source_in,
        source_out_us: source_out,
    })
}

/// Map a `vlm::VlmError` to a structured `McpToolError` — mirror of
/// `map_speech_error`.
#[cfg(feature = "speech")]
fn map_vlm_error(e: crate::vlm::VlmError) -> McpToolError {
    use crate::vlm::VlmError as E;
    let message = e.to_string();
    match e {
        E::InvalidKey { .. } | E::MissingEndpoint { .. } => {
            McpToolError::invalid_request(message, None)
        }
        E::RateLimited { .. } | E::Provider { .. } | E::Network(_) => {
            McpToolError::internal_error(message, None)
        }
        E::Io(_) | E::FrameExtract(_) | E::Parse(_) => McpToolError::internal_error(message, None),
        E::EngineExit { .. } | E::Spawn { .. } | E::Timeout { .. } => {
            McpToolError::internal_error(message, None)
        }
    }
}

/// Persist a `DescriptionCache` JSON atomically (temp → promote), mirroring
/// `write_voiceover_atomic`.
#[cfg(feature = "speech")]
async fn write_description_atomic(
    dest: &std::path::Path,
    cache: &crate::vlm::DescriptionCache,
) -> Result<(), anyhow::Error> {
    use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path};
    use anyhow::Context;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(cache).context("serialize description cache")?;
    let tmp = temp_path(dest);
    let _ = tokio::fs::remove_file(&tmp).await;
    tokio::fs::write(&tmp, &body)
        .await
        .with_context(|| format!("write {}", tmp.display()))?;
    if !cached_ok(&tmp) {
        discard_temp(dest);
        anyhow::bail!("description cache is empty after write");
    }
    promote_temp(dest)?;
    Ok(())
}

#[cfg(feature = "speech")]
pub(super) async fn describe_clip(
    b: &Backend,
    args: DescribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    use crate::vlm;

    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let resolved = resolve_clip_video_source(
        args.layer.as_ref(),
        args.media.as_ref(),
        layer_id,
        args.t_start_us,
        args.t_end_us,
    )?;

    // Explicit `backend` → STRICT; unknown tag → clean invalid_params. Matched
    // against the stable `as_str` wire tag (not the serde form).
    let explicit = match args.backend.as_deref() {
        None => None,
        Some(tag) => Some(
            vlm::VlmBackend::all()
                .iter()
                .copied()
                .find(|b| b.as_str() == tag)
                .ok_or_else(|| {
                    McpToolError::invalid_params(
                        format!(
                            "unknown backend {tag:?}; expected \"qwen3_vl\", \"minicpm_v\", or \"byo_endpoint\""
                        ),
                        None,
                    )
                })?,
        ),
    };
    let preferred = args.preferred_backend.as_deref().and_then(|tag| {
        vlm::VlmBackend::all()
            .iter()
            .copied()
            .find(|b| b.as_str() == tag)
    });

    let cfg = &args.vlm_config;
    let (used_backend, describer) = match explicit.or(preferred) {
        Some(be) => (
            be,
            vlm::resolve_scene_describer_exact(be, cfg)
                .map_err(|e| McpToolError::invalid_request(e.to_string(), None))?,
        ),
        None => vlm::resolve_scene_describer(preferred, cfg)
            .ok_or_else(|| McpToolError::invalid_request(vlm::NO_DESCRIBER_CONFIGURED, None))?,
    };
    let model = vlm::model_label(used_backend, cfg.get(used_backend.as_str()));

    let fps = args.fps.unwrap_or(vlm::DEFAULT_FPS);
    if !(fps.is_finite() && fps > 0.0 && fps <= 30.0) {
        return Err(McpToolError::invalid_params(
            format!("fps {fps} must be in (0.0, 30.0]"),
            None,
        ));
    }
    let focus = vlm::Focus::parse(args.focus.as_deref());
    // Unknown tags are passed to the model as themselves rather than refused:
    // the BYO endpoint may serve a model that knows a language this build has
    // no name for, and a refusal here would be this layer overruling it.
    let language = vlm::Language::parse(args.language.as_deref());
    let fps_milli = vlm::fps_milli(fps);

    let key = vlm::cache_key(
        &resolved.source_hash,
        used_backend,
        &vlm::resolve::cache_model_identity(used_backend, cfg.get(used_backend.as_str())),
        fps_milli,
        focus,
        &language,
    );
    let dest = b.cache.description(&key);

    // Range-lazy: load the prior cache; if the window is already covered, reuse
    // it with NO engine spawn.
    let mut cache: vlm::DescriptionCache = match tokio::fs::read(&dest).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => vlm::DescriptionCache::default(),
    };

    if !cache.covers(resolved.source_in_us, resolved.source_out_us) {
        // Uncovered → sample the window's frames and describe it once.
        let anchors =
            vlm::frame_extract::plan_anchors(resolved.source_in_us, resolved.source_out_us, fps);
        let tmp = tempfile::Builder::new()
            .prefix("weftcut-vlm")
            .tempdir()
            .map_err(|e| McpToolError::internal_error(format!("temp dir: {e}"), None))?;
        let frames = vlm::frame_extract::sample_frames(
            &resolved.source_path,
            resolved.source_in_us,
            tmp.path(),
            &anchors,
        )
        .await
        .map_err(map_vlm_error)?;

        let raw = describer
            .describe(vlm::DescribeRequest {
                frames,
                focus,
                language: language.clone(),
            })
            .await
            .map_err(map_vlm_error)?;
        let mut fresh = vlm::parse_raw(raw).map_err(map_vlm_error)?;
        // Parser output is window-relative; place it on source-absolute time.
        vlm::shift_segments(&mut fresh, resolved.source_in_us);

        cache.merge_window(resolved.source_in_us, resolved.source_out_us, fresh);
        write_description_atomic(&dest, &cache).await.map_err(|e| {
            McpToolError::internal_error(format!("persist description: {e:#}"), None)
        })?;
    }

    let result = vlm::SceneDescription {
        backend: used_backend.as_str().to_string(),
        model,
        segments: cache.segments_in(resolved.source_in_us, resolved.source_out_us),
    };
    ToolResult::json(&result)
}

/// TTS compute half of the `synthesize_speech` hybrid. Does NOT write to the
/// project actor — that is the TS host's job. Returns `(MediaItem, cached)`.
#[cfg(feature = "speech")]
pub(crate) async fn synthesize_speech_audio(
    b: &Backend,
    args: &SynthesizeSpeechArgs,
) -> Result<(crate::state::MediaItem, bool), McpToolError> {
    use crate::cache::cached_ok;
    use crate::io::probe;
    use crate::state::{new_id, DecodeRoute, MediaItem, MediaKind};

    if args.text.trim().is_empty() {
        return Err(McpToolError::invalid_params("text is empty", None));
    }

    let synthesizer = {
        let cfg = b.speech_config.lock().expect("speech_config poisoned");
        // `preferred: None` — TTS has one capable backend (OpenAI), so there is
        // no preference to honor; the resolver's availability walk suffices.
        speech::resolve_synthesizer(None, &cfg)
    }
    .ok_or_else(|| McpToolError::invalid_request(speech::NO_SYNTHESIZER_CONFIGURED, None))?;

    let cache_key = speech::backends::openai::tts_cache_key(&args.text, &args.voice, args.speed);
    // Cache extension hardcoded "mp3": the only TTS provider pins
    // `response_format=mp3`. The `debug_assert!` below trips in dev the first time
    // a provider returns a different format — fix the extension-from-response here.
    // TODO: pull extension from `resp.format` once a non-mp3 TTS provider lands.
    let dest = b.cache.voiceover(&cache_key, "mp3");
    let cached = cached_ok(&dest);
    if !cached {
        let resp = synthesizer
            .synthesize(speech::SynthesizeRequest {
                text: args.text.clone(),
                voice: args.voice.clone(),
                speed: args.speed,
            })
            .await
            .map_err(map_speech_error)?;
        debug_assert_eq!(
            resp.format,
            speech::AudioFormat::Mp3,
            "TTS cache extension assumes mp3 output; update it before adding non-mp3 providers",
        );
        write_voiceover_atomic(&dest, &resp.audio)
            .await
            .map_err(|e| McpToolError::internal_error(format!("write voiceover: {e:#}"), None))?;
    }

    // Probe the (now-existing) file on a blocking thread to get duration.
    // ffprobe is required here — without duration we can't size the
    // Audio layer correctly.
    let probe_path = dest.clone();
    let cache_key_clone = cache_key.clone();
    let media_item = tokio::task::spawn_blocking(move || -> Result<MediaItem, String> {
        let metadata = probe::probe_metadata(&probe_path);
        if metadata.duration_us.is_none() {
            return Err(
                "ffprobe could not determine duration of synthesized audio — \
                 install ffprobe (ships with ffmpeg) and retry"
                    .to_string(),
            );
        }
        let stat = std::fs::metadata(&probe_path).map_err(|e| format!("stat voiceover: {e}"))?;
        Ok(MediaItem {
            id: new_id(),
            label: Some(format!("voiceover-{}", &cache_key_clone[..8])),
            path_abs: probe_path,
            path_rel: None,
            kind: MediaKind::Audio,
            metadata,
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: cache_key_clone,
            file_size: stat.len(),
            file_mtime: stat
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            imported_at: Utc::now(),
        })
    })
    .await
    .map_err(|e| McpToolError::internal_error(format!("probe join: {e}"), None))?
    .map_err(|e| McpToolError::internal_error(e, None))?;

    Ok((media_item, cached))
}

/// `synthesize_speech` Rust handler is a stub — the tool routes through the
/// hybrid orchestrator (synthesize_speech_compute napi compute → TS-actor
/// add_media_item + add Audio layer write); the schema stays so `listTools`
/// advertises it, but the TS host intercepts the call before dispatch reaches
/// this handler. The compute half (`synthesize_speech_audio`) stays — the napi
/// `synthesize_speech_compute` calls it.
#[cfg(feature = "speech")]
pub(super) async fn synthesize_speech(
    _b: &Backend,
    _args: SynthesizeSpeechArgs,
) -> Result<ToolResult, McpToolError> {
    Err(McpToolError::internal_error(
        "synthesize_speech is handled by the host process (TS actor hybrid)".to_string(),
        None,
    ))
}
