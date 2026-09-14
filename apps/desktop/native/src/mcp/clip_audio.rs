//! Model-free audio delivery for external agents. Shares source-window
//! resolution and the WAV cache with transcription; no speech backend is
//! resolved here, no inference runs, and nothing is uploaded.
//!
//! The point of the tool is an agent that brings its OWN speech model: it asks
//! for a window of a clip's source audio, transcribes it wherever it likes, and
//! shifts the offsets it gets back onto the timeline with the `t_start_us` this
//! tool reports. That shift is the whole alignment contract — the returned WAV
//! starts at zero, so a cue at `w` in the WAV belongs at `t_start_us + w`.

use base64::Engine;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::napi_backend::Backend;
use crate::speech::audio_extract::{extract_audio_window, SAMPLE_RATE_HZ};
use crate::state::{Layer, LayerId, MediaId, MediaItem};

use super::tools::{parse_uuid, resolve_clip_audio_source};
use super::wire::{ContentBlock, McpToolError, ToolResult};

/// One call's ceiling. A whole clip is fetched as consecutive windows rather
/// than in one response: base64 inflates the payload by 4/3, so 60 s is already
/// ~2.5 MB of JSON-RPC, and a 10-minute take in one message would be 25 MB.
const MAX_DURATION_US: i64 = 60_000_000;

/// The extract's own shape: mono `SAMPLE_RATE_HZ` s16 PCM = 32 KB/s.
const BYTES_PER_SECOND: usize = SAMPLE_RATE_HZ as usize * 2;

/// Read ceiling, NOT a second duration gate — the duration is refused below
/// before any ffmpeg runs. This bounds the read itself, including a cache hit
/// whose file was written by some earlier, differently-shaped call. Two seconds
/// of slack over the window covers the WAV header and ffmpeg's sub-frame `-t`
/// overshoot without ever tripping on a legitimate 60 s extract.
const MAX_AUDIO_BYTES: usize = (MAX_DURATION_US as usize / 1_000_000 + 2) * BYTES_PER_SECOND;

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ExtractClipAudioArgs {
    /// Target VideoClip or Audio layer id.
    pub layer_id: String,
    /// Window start in the owning composition's absolute microseconds.
    /// Defaults to the layer start. Must lie inside the layer.
    #[serde(default)]
    pub t_start_us: Option<i64>,
    /// Exclusive window end in the owning composition's absolute microseconds.
    /// Defaults to the layer end. Maximum window duration: 60000000 us (60 s).
    #[serde(default)]
    pub t_end_us: Option<i64>,
    /// Injected by the TS MCP host (sole state owner) — see `TranscribeClipArgs`.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<MediaItem>,
}

/// The text block beside the audio block: everything needed to place a
/// transcript of the WAV back on the timeline, plus the WAV's own shape so a
/// caller can decode it without sniffing the header.
///
/// `t_start_us` / `t_end_us` are the window as RESOLVED (the layer's endpoints
/// when the args omitted them), so a caller that passed neither still learns
/// exactly which span it received.
#[derive(Debug, Serialize)]
struct ExtractClipAudioResult {
    layer_id: LayerId,
    media_id: MediaId,
    t_start_us: i64,
    t_end_us: i64,
    source_in_us: i64,
    source_out_us: i64,
    duration_us: i64,
    sample_rate_hz: u32,
    channels: u8,
    bits_per_sample: u8,
    byte_length: usize,
    mime_type: &'static str,
}

pub(super) async fn extract_clip_audio(
    b: &Backend,
    args: ExtractClipAudioArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let resolved = resolve_clip_audio_source(
        args.layer.as_ref(),
        args.media.as_ref(),
        layer_id,
        args.t_start_us,
        args.t_end_us,
    )?;
    let duration_us = resolved.source_out_us - resolved.source_in_us;
    if duration_us > MAX_DURATION_US {
        return Err(McpToolError::invalid_params(
            format!(
                "extract_clip_audio accepts at most {MAX_DURATION_US} us (60 s) per call; the \
                 requested window is {duration_us} us — fetch consecutive t_start_us/t_end_us \
                 windows instead",
            ),
            Some(serde_json::json!({
                "max_duration_us": MAX_DURATION_US,
                "requested_duration_us": duration_us,
            })),
        ));
    }

    let path = extract_audio_window(
        &b.cache,
        &resolved.source_path,
        &resolved.source_hash,
        resolved.source_in_us,
        resolved.source_out_us,
    )
    .await
    .map_err(|e| McpToolError::internal_error(format!("audio extract: {e:#}"), None))?;

    // Bounded read: `take` caps the bytes that can ever reach the encoder, so a
    // cache file larger than the envelope is refused rather than serialized.
    // The extracted path never leaves this tool — an agent gets bytes, not a
    // filesystem handle into the user's cache.
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| McpToolError::internal_error(format!("open extracted audio: {e}"), None))?;
    let mut bytes = Vec::new();
    file.take((MAX_AUDIO_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| McpToolError::internal_error(format!("read extracted audio: {e}"), None))?;
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(McpToolError::internal_error(
            format!("extracted audio exceeds the {MAX_AUDIO_BYTES}-byte response envelope"),
            None,
        ));
    }

    // Text block FIRST: the host's `toolResultPayload` reads `content[0]` as
    // the tool's answer, and every other tool's answer is its JSON.
    let mut result = ToolResult::json(&ExtractClipAudioResult {
        layer_id,
        media_id: resolved.media_id,
        t_start_us: resolved.timeline_start_us,
        t_end_us: resolved.timeline_end_us,
        source_in_us: resolved.source_in_us,
        source_out_us: resolved.source_out_us,
        duration_us,
        sample_rate_hz: SAMPLE_RATE_HZ,
        channels: 1,
        bits_per_sample: 16,
        byte_length: bytes.len(),
        mime_type: "audio/wav",
    })?;
    result.content.push(ContentBlock::Audio {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type: "audio/wav".into(),
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        new_id, AudioParams, AudioStreamMeta, DecodeRoute, LayerParams, MediaKind, MediaMetadata,
    };
    use std::path::{Path, PathBuf};

    /// An Audio layer whose source window is the whole of `[0, duration_us)`,
    /// placed at `t_start_us` on the timeline.
    fn audio_layer(media_id: MediaId, t_start_us: i64, duration_us: i64) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us,
            t_end_us: t_start_us + duration_us,
            enabled: true,
            locked: false,
            metadata: Default::default(),
            params: LayerParams::Audio(AudioParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: duration_us,
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

    fn audio_media(path: PathBuf, duration_us: i64) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: path,
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(duration_us),
                audio: Some(AudioStreamMeta {
                    sample_rate: 44_100,
                    channels: 2,
                    codec: "pcm_s16le".into(),
                    start_pts_us: None,
                }),
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "extract-clip-audio-test-hash".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        }
    }

    fn args(
        layer: &Layer,
        media: &MediaItem,
        t_start_us: Option<i64>,
        t_end_us: Option<i64>,
    ) -> ExtractClipAudioArgs {
        ExtractClipAudioArgs {
            layer_id: layer.id.to_string(),
            t_start_us,
            t_end_us,
            layer: Some(layer.clone()),
            media: Some(media.clone()),
        }
    }

    async fn test_backend() -> Backend {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.expect("backend init");
        b
    }

    /// The cap is the tool's whole reason for a windowed API, so it has to
    /// refuse BEFORE ffmpeg runs — the media path here does not exist, and the
    /// refusal naming the cap (not a decode failure) is what proves it.
    #[tokio::test]
    async fn refuses_a_window_longer_than_sixty_seconds() {
        let b = test_backend().await;
        let media = audio_media(PathBuf::from("/nonexistent/source.wav"), 90_000_000);
        let layer = audio_layer(media.id, 0, 90_000_000);
        let err = extract_clip_audio(&b, args(&layer, &media, Some(0), Some(60_000_001)))
            .await
            .expect_err("over-long window");
        assert!(
            err.message.contains("at most 60000000 us"),
            "refusal should name the cap, got: {}",
            err.message,
        );
        assert!(
            err.message.contains("60000001"),
            "refusal should name the requested duration, got: {}",
            err.message,
        );
    }

    /// Exactly 60 s is inside the cap — an off-by-one here would make the
    /// advertised maximum unusable.
    #[tokio::test]
    async fn sixty_seconds_exactly_is_not_refused_by_the_cap() {
        let b = test_backend().await;
        let media = audio_media(PathBuf::from("/nonexistent/source.wav"), 90_000_000);
        let layer = audio_layer(media.id, 0, 90_000_000);
        let err = extract_clip_audio(&b, args(&layer, &media, Some(0), Some(60_000_000)))
            .await
            .expect_err("the nonexistent source still fails, but later");
        assert!(
            !err.message.contains("at most"),
            "60 s exactly must pass the cap and fail at extraction instead, got: {}",
            err.message,
        );
    }

    /// A window the cap admits is still refused when it leaves the layer — the
    /// shared resolver owns that, and this pins that the tool consults it.
    #[tokio::test]
    async fn refuses_a_window_outside_the_layer() {
        let b = test_backend().await;
        let media = audio_media(PathBuf::from("/nonexistent/source.wav"), 10_000_000);
        let layer = audio_layer(media.id, 2_000_000, 10_000_000);
        let err = extract_clip_audio(&b, args(&layer, &media, Some(0), Some(1_000_000)))
            .await
            .expect_err("window before the layer");
        assert!(
            err.message.contains("outside layer range"),
            "unexpected error: {}",
            err.message,
        );
    }

    fn ffmpeg_available() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn make_test_source(dest: &Path, duration_s: u32) {
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency=440:duration={duration_s}"),
                "-ac",
                "2",
                "-ar",
                "44100",
            ])
            .arg(dest)
            .status()
            .await
            .expect("spawn ffmpeg fixture");
        assert!(status.success(), "test fixture ffmpeg failed: {status}");
    }

    /// End-to-end against real ffmpeg: the two content blocks, the alignment
    /// metadata, and a WAV that actually decodes to mono 16 kHz 16-bit.
    #[tokio::test]
    async fn returns_metadata_plus_a_mono_16k_wav_block() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping extract_clip_audio smoke");
            return;
        }
        let b = test_backend().await;
        let dir = tempfile::TempDir::new().unwrap();
        let source = dir.path().join("src.wav");
        make_test_source(&source, 6).await;

        // Layer placed at 5 s on the timeline, holding source [0, 6s).
        // Asking for timeline [6s, 8s) therefore reads source [1s, 3s).
        let media = audio_media(source, 6_000_000);
        let layer = audio_layer(media.id, 5_000_000, 6_000_000);
        let result = extract_clip_audio(&b, args(&layer, &media, Some(6_000_000), Some(8_000_000)))
            .await
            .expect("extract");

        assert_eq!(result.content.len(), 2, "one text block then one audio block");
        let meta: serde_json::Value = match &result.content[0] {
            ContentBlock::Text { text } => serde_json::from_str(text).expect("metadata is JSON"),
            other => panic!("expected text first, got {other:?}"),
        };
        assert_eq!(meta["layer_id"], serde_json::json!(layer.id.to_string()));
        assert_eq!(meta["media_id"], serde_json::json!(media.id.to_string()));
        assert_eq!(meta["t_start_us"], 6_000_000);
        assert_eq!(meta["t_end_us"], 8_000_000);
        assert_eq!(
            meta["source_in_us"], 1_000_000,
            "the timeline window maps onto the layer's source window",
        );
        assert_eq!(meta["source_out_us"], 3_000_000);
        assert_eq!(meta["duration_us"], 2_000_000);
        assert_eq!(meta["sample_rate_hz"], SAMPLE_RATE_HZ);
        assert_eq!(meta["channels"], 1);
        assert_eq!(meta["bits_per_sample"], 16);
        assert_eq!(meta["mime_type"], "audio/wav");

        let (data, mime) = match &result.content[1] {
            ContentBlock::Audio { data, mime_type } => (data, mime_type),
            other => panic!("expected audio second, got {other:?}"),
        };
        assert_eq!(mime, "audio/wav");
        let wav = base64::engine::general_purpose::STANDARD
            .decode(data)
            .expect("audio block is valid base64");
        assert_eq!(
            meta["byte_length"].as_u64().unwrap() as usize,
            wav.len(),
            "byte_length describes the decoded WAV, not the base64",
        );
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            SAMPLE_RATE_HZ,
            "16 kHz",
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "16-bit");
        // 2 s of mono 16 kHz s16 is ~64 KB; generous slack for ffmpeg's `-t`.
        assert!(
            (50_000..=80_000).contains(&wav.len()),
            "expected ~64KB of audio, got {} bytes",
            wav.len(),
        );
    }

    /// The MCP content-block wire shape: `type: "audio"` alongside a camelCase
    /// `mimeType`. `ContentBlock` is internally tagged, so a variant rename or a
    /// dropped `serde(rename)` would go on compiling and break every client
    /// silently — and no test that inspects the enum can see it.
    #[test]
    fn audio_block_serializes_to_the_mcp_content_shape() {
        let mut result = ToolResult::text("{}");
        result.content.push(ContentBlock::Audio {
            data: "AAAA".into(),
            mime_type: "audio/wav".into(),
        });
        let wire = serde_json::to_value(&result).expect("serialize tool result");
        assert_eq!(wire["content"][0]["type"], "text");
        assert_eq!(wire["content"][1]["type"], "audio");
        assert_eq!(wire["content"][1]["mimeType"], "audio/wav");
        assert_eq!(wire["content"][1]["data"], "AAAA");
    }

    /// The read ceiling must never be the thing that rejects a legal maximum
    /// window — if it ever drops below a full 60 s extract, the tool's
    /// advertised cap becomes unreachable.
    #[test]
    fn read_ceiling_clears_a_full_length_extract() {
        let full_window = (MAX_DURATION_US as usize / 1_000_000) * BYTES_PER_SECOND;
        assert!(
            MAX_AUDIO_BYTES > full_window,
            "{MAX_AUDIO_BYTES} must exceed the {full_window} bytes a 60 s extract writes",
        );
        assert!(
            MAX_AUDIO_BYTES - full_window >= 2 * BYTES_PER_SECOND,
            "at least 2 s of slack for the header and ffmpeg's -t overshoot",
        );
    }
}
