//! One declarative table feeds BOTH `tool_catalog()` (the advertised schemas)
//! and `dispatch_tool()` (the name→handler match), so a tool can never appear
//! in one without the other. Each entry's description is the literal text the
//! MCP catalog advertises to clients.
//!
//! This table carries the native/compute/hybrid tools only.
//! TS-executed mutations are served by the TS actor's `MCP_TOOLS` table and
//! routed by `routeMcpTool`.

use super::wire::{McpCatalog, McpToolError, PromptDef, ResourceDef, ToolAnnotations, ToolDef, ToolResult};
use super::{prompts, resources, tools};
use crate::napi_backend::Backend;

/// The advertised schema for one args type. Draft 2020-12 minus the parts no
/// agent reads and every `tools/list` pays for: the `$schema` / `title`
/// envelope, `format` hints (`int64`, `double`) and the `default: null` that
/// `#[serde(default)]` echoes onto every optional field. Subschemas are
/// inlined so a client that does not resolve `$ref` still sees a typed field.
fn tool_schema<T: schemars::JsonSchema>() -> serde_json::Value {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.meta_schema = None;
    settings.inline_subschemas = true;
    let schema = settings
        .with_transform(TrimAdvertised)
        .into_generator()
        .into_root_schema_for::<T>();
    let mut value = serde_json::to_value(schema).expect("schema serializes");
    drop_optional_null_arms(&mut value);
    value
}

/// `Option<T>` comes out of schemars as `["T", "null"]`. On a property that is
/// not `required`, omitting it already means "none", so the `null` arm is a
/// second spelling of the same thing, and across a catalog it reads as "this
/// field takes null". Drop it; a field where `null` means something of its own
/// is required, and keeps it. The TS-side argument check treats an explicit
/// `null` on an optional field as omitted, so a client that sends one is
/// answered as if it had left the field out.
fn drop_optional_null_arms(v: &mut serde_json::Value) {
    let Some(obj) = v.as_object_mut() else { return };
    let required: Vec<String> = obj
        .get("required")
        .and_then(serde_json::Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if let Some(props) = obj.get_mut("properties").and_then(serde_json::Value::as_object_mut) {
        for (name, prop) in props.iter_mut() {
            if !required.iter().any(|r| r == name) {
                if let Some(p) = prop.as_object_mut() {
                    for key in ["type", "enum"] {
                        let Some(arr) = p.get(key).and_then(serde_json::Value::as_array).cloned() else { continue };
                        let kept: Vec<serde_json::Value> = arr
                            .into_iter()
                            .filter(|t| !(t.is_null() || t.as_str() == Some("null")))
                            .collect();
                        let collapsed = if key == "type" && kept.len() == 1 { kept[0].clone() } else { serde_json::Value::Array(kept) };
                        p.insert(key.to_string(), collapsed);
                    }
                }
            }
            drop_optional_null_arms(prop);
        }
    }
    for key in ["items", "additionalProperties"] {
        if let Some(sub) = obj.get_mut(key) {
            drop_optional_null_arms(sub);
        }
    }
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(arr) = obj.get_mut(key).and_then(serde_json::Value::as_array_mut) {
            for sub in arr {
                drop_optional_null_arms(sub);
            }
        }
    }
}

#[derive(Clone, Debug)]
struct TrimAdvertised;

impl schemars::transform::Transform for TrimAdvertised {
    fn transform(&mut self, schema: &mut schemars::Schema) {
        if let Some(obj) = schema.as_object_mut() {
            obj.remove("title");
            obj.remove("format");
            if obj.get("default").is_some_and(serde_json::Value::is_null) {
                obj.remove("default");
            }
        }
        schemars::transform::transform_subschemas(self, schema);
    }
}

macro_rules! tool_table {
    ( $( $(#[$meta:meta])* $name:literal => ($desc:expr, $args:ty, $handler:path, $ann:expr) ),* $(,)? ) => {
        pub(crate) fn tool_catalog() -> Vec<ToolDef> {
            vec![ $(
                $(#[$meta])*
                ToolDef {
                    name: $name.to_string(),
                    description: $desc.to_string(),
                    input_schema: tool_schema::<$args>(),
                    annotations: $ann,
                }
            ),* ]
        }
        pub async fn dispatch_tool(b: &Backend, name: &str, args_json: &str)
            -> Result<ToolResult, McpToolError>
        {
            match name {
                $( $(#[$meta])* $name => {
                    let a: $args = serde_json::from_str(args_json)
                        .map_err(|e| McpToolError::invalid_params(
                            format!("invalid args for {}: {e}", $name), None))?;
                    $handler(b, a).await
                } )*
                other => Err(McpToolError::resource_not_found(
                    format!("unknown tool '{other}'"), None)),
            }
        }
    };
}

tool_table! {
    "ping" => ("Liveness check. Returns 'pong' to confirm the WeftCut MCP server is reachable.", super::EmptyArgs, tools::ping, ToolAnnotations::READ),
    // begin_agent_session routes to the TS actor ('ts' MCP tool) and is supplied
    // by the TS def; mergeMcpCatalog filters it out of the Rust side.
    "apply_subtitles" => ("Import a subtitle document (SRT/VTT/ASS) as editable Text layers on the caption tracks. Cue timings come from the body; each cue packs onto the first unlocked caption track with room, and a new caption track opens only for a cue that collides with all of them. `format` is sniffed when omitted; advanced ASS styling (karaoke, drawings) is simplified. For a `transcribe_clip` result use `apply_transcripts` instead — an SRT discards its word timing. Returns `{ caption_track_id, cues, simplified }`.", tools::ApplySubtitlesArgs, tools::apply_subtitles, ToolAnnotations::WRITE),
    #[cfg(feature = "jobs")]
    "detect_pauses" => ("Find the pauses in a clip's audio — the stretches nobody is speaking — from the pre-computed waveform. Read-only: the write is `remove_pauses` (cut them) or `add_marker` (mark them). A pause is a run where every channel's peak stays below `threshold_amp` for at least `min_pause_us`; a loud run shorter than `bridge_us` inside it (a click, a cough) does not end it. Defaults `threshold_amp=0.02` (-34 dBFS), `min_pause_us=500000`, `bridge_us=80000` (must be below `min_pause_us`). `layer_id` is an Audio layer, or a VideoClip, which resolves to the Audio layer of its link (refused when it plays no sound). Returns `{ pauses: [{ t_start_us, t_end_us }], noise_floor_amp, peaks_source }`, timeline-absolute µs, sorted; `noise_floor_amp` is the 10th-percentile peak (a threshold reads well at the floor + 6 dB); `peaks_source` is \"raw\" or \"fx\" (baked effect chain). Errors until the waveform job finishes — wait for `media:job_complete` with `kind=waveform` and retry.", tools::DetectPausesArgs, tools::detect_pauses, ToolAnnotations::READ),
    #[cfg(feature = "jobs")]
    "analyze_clip" => ("Detect shot boundaries in a VideoClip layer. Deterministic, over the source (720p proxy preferred). Returns `{ shots: [{ index, t_start_us, t_end_us, keyframe_t_us, brightness, motion, sharpness, flags }], cut_scores: [{ t_us, score }] }`, all SOURCE-ABSOLUTE µs clipped to the layer's source window. `shots` is the cleaned segmentation (cuts closer than `min_shot_us` merged), `cut_scores` the raw cut signal (0..1). Per shot: `keyframe_t_us` is the midpoint cover frame; `brightness` mean luma 0..1; `sharpness` variance of the Laplacian (higher = sharper); `motion` 0..1 endpoint difference; `flags` may hold \"black\", \"freeze\", \"fade\". Optional `sensitivity` (0..1, default 0.4; lower = more cuts), `min_shot_us` (default 500000), `passes` (subset of \"shots\" / \"stats\" / \"events\", default all — drop \"stats\" / \"events\" for timing only). VideoClip layers only. To split at every cut in one edit use `auto_split_by_shot`.", tools::AnalyzeClipArgs, tools::analyze_clip, ToolAnnotations::READ),
    #[cfg(feature = "jobs")]
    "compare_frames" => ("Compare two video frames for perceptual similarity — dedup shots, match a cutaway. Each side is `{ layer_id, t_us }`: a VideoClip layer and a SOURCE-ABSOLUTE µs timestamp (the space `analyze_clip`'s `keyframe_t_us` and `media://{id}/frame/<t_us>` use); the two may be the same clip or different clips. Returns `{ phash_hamming, ssim, similar }`: `phash_hamming` is the 0..64 distance between the frames' perceptual hashes (0 = identical, 20+ = a different scene), `ssim` is structural similarity 0..1, and `similar` is `phash_hamming <= 10 && ssim >= 0.5`. Read-only; VideoClip layers only, errors naming the offending side.", tools::CompareFramesArgs, tools::compare_frames, ToolAnnotations::READ),
    #[cfg(feature = "jobs")]
    "import_media" => ("Import ONE media file from an absolute path. Hashes the file (blake3) and probes \
                          metadata via ffprobe when installed. Returns `{ media_id, kind, label, path, duration_us, width, height, has_audio }`; \
                          a subtitle document (.srt/.vtt/.ass) is laid onto a caption track instead and returns `{ caption_track_id, cues }`. \
                          A directory, a missing path or an unreadable file is refused by name before anything is written; a read that \
                          fails mid-import rolls the provisional pool row back. Unrecorded.", tools::ImportMediaArgs, tools::import_media, ToolAnnotations::WRITE),
    #[cfg(feature = "speech")]
    "extract_clip_audio" => ("Extract a VideoClip or Audio layer's ORIGINAL source audio — before gain, mute, effects or mixing — for an agent running its own speech model; no engine or API key is involved and nothing is uploaded. Returns a JSON metadata block (`layer_id`, `media_id`, `t_start_us`, `t_end_us`, `source_in_us`, `source_out_us`, `duration_us`, `sample_rate_hz`, `channels`, `bits_per_sample`, `byte_length`, `mime_type`) plus an MCP audio block: base64 WAV, mono 16 kHz 16-bit, starting at zero. Optional `t_start_us`/`t_end_us` are composition-absolute µs, defaulting to the layer endpoints; at most 60 s per call — walk a long clip in consecutive windows. Add the reported `t_start_us` to the offsets your model returns before `apply_subtitles`. Refuses a layer with no audio, a window outside the layer, and a VideoClip with speed != 1.0 (a VideoClip's audio is its own stream, not its linked Audio layer).",
                             super::clip_audio::ExtractClipAudioArgs, super::clip_audio::extract_clip_audio, ToolAnnotations::READ),
    #[cfg(feature = "speech")]
    "transcribe_clip" => ("Transcribe a VideoClip or Audio layer with the configured engine (cloud OpenAI Whisper, or local whisper.cpp / FunASR). Returns `{ backend, segments: [{ t_start_us, t_end_us, text, words: [{ t_start_us, t_end_us, text }] }], language, word_timing, srt }` in timeline-absolute µs. Hand the envelope to `apply_transcripts` to lay captions that keep the word timing (`apply_subtitles` with `srt` works but discards it). `word_timing` is \"exact\" or \"interpolated_from_cue\". Optional `t_start_us`/`t_end_us` narrow the window; `backend` (\"openai\" | \"whisper_cpp\" | \"funasr\") REQUIRES that engine — it errors naming the missing key / binary / model rather than substituting, so a local choice never uploads; omitted, the user's preferred engine then availability. `word_timestamps` (default true) asks for exact per-word times where the engine can (OpenAI is SRT-only). A VideoClip with speed != 1.0 is refused. Errors name the cause: no engine, the provider cap (~13 min for cloud Whisper), rate limits, auth.", tools::TranscribeClipArgs, tools::transcribe_clip, ToolAnnotations::READ),
    #[cfg(feature = "speech")]
    "synthesize_speech" => ("Synthesize speech with the configured cloud TTS provider (OpenAI tts-1) and place it as an Audio layer. `text` ≤ 4096 chars; `voice` is one of alloy / echo / fable / onyx / nova / shimmer; optional `speed` 0.25..4.0 (default ≈ 1.0); optional `target_track_id` (default: the first Audio track, else a new 'Voiceover' track); optional `t_start_us` (default: the composition's current duration, so the clip appends at the end). The MP3 is cached by `(model, voice, speed, text)`, so a repeat call costs no API request. Returns `{ layer_id, media_id, t_start_us, t_end_us, cached }`.", tools::SynthesizeSpeechArgs, tools::synthesize_speech, ToolAnnotations::WRITE),
    #[cfg(feature = "speech")]
    "describe_clip" => ("Describe a VideoClip layer's visual content as timestamped, open-vocabulary segments with a video-understanding model (local Qwen3-VL / MiniCPM-V via llama-mtmd-cli, or an OpenAI-compatible endpoint). Samples frames at `fps` (default 1.0) and runs the model once over the window. Returns `{ backend, model, segments: [{ t_start_us, t_end_us, text, tags }] }` in SOURCE-ABSOLUTE µs; `text` is prose, `tags` short visual keywords (subjects, setting, camera, shot type). Cached per source range. Optional `t_start_us`/`t_end_us` narrow the window; `focus` (\"general\" | \"shot-type\") picks the prompt that fills `tags`; `language` is a BCP-47 tag for the output (default: the app's UI language) and part of the cache key. `backend` (\"qwen3_vl\" | \"minicpm_v\" | \"byo_endpoint\") REQUIRES that engine — it errors naming the missing binary / model / endpoint rather than substituting, so a local choice never uploads frames; omitted, the user's preferred engine then availability (local first). A VideoClip with speed != 1.0 is refused; so is a call with no engine configured, naming the gap.", tools::DescribeClipArgs, tools::describe_clip, ToolAnnotations::READ),
}

pub(crate) fn resource_catalog() -> Vec<ResourceDef> {
    resources::static_resources()
}
pub(crate) fn prompt_catalog() -> Vec<PromptDef> {
    prompts::catalog()
}
pub(crate) fn catalog() -> McpCatalog {
    McpCatalog {
        tools: tool_catalog(),
        resources: resource_catalog(),
        prompts: prompt_catalog(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table feeds both surfaces from one source — every advertised tool
    /// must be dispatchable. Smoke: catalog is non-empty and `ping` dispatches.
    #[tokio::test]
    async fn ping_dispatches_to_pong() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let r = dispatch_tool(&b, "ping", "{}").await.unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["content"][0]["text"], "pong");
    }

    #[tokio::test]
    async fn unknown_tool_is_not_found() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let err = dispatch_tool(&b, "does_not_exist", "{}").await.unwrap_err();
        assert_eq!(err.code, super::super::wire::McpErrorCode::NotFound);
    }

    #[test]
    fn catalog_advertises_tools_resources_prompts() {
        let cat = catalog();
        assert!(cat.tools.iter().any(|t| t.name == "ping"));
        assert!(cat.tools.iter().any(|t| t.name == "apply_subtitles"));
        assert!(cat.resources.iter().any(|r| r.uri == "project://current"));
        assert!(cat.prompts.iter().any(|p| p.name == "cut-pauses"));
    }

    /// detect_pauses / transcribe_clip carry
    /// serde-deserialized `layer` / `media` slice fields the TS host injects.
    /// `#[schemars(skip)]` MUST keep them out of the advertised tool schema so
    /// agents never see (or try to fill) them.
    #[cfg(all(feature = "jobs", feature = "speech"))]
    #[test]
    fn injected_slice_fields_are_not_advertised() {
        let cat = catalog();
        for name in [
            "detect_pauses",
            "transcribe_clip",
            "describe_clip",
            "extract_clip_audio",
        ] {
            let tool = cat
                .tools
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("{name} must be advertised"));
            if let Some(props) = tool
                .input_schema
                .get("properties")
                .and_then(|p| p.as_object())
            {
                assert!(
                    !props.contains_key("layer"),
                    "{name}: `layer` must not be advertised (schemars skip)"
                );
                assert!(
                    !props.contains_key("media"),
                    "{name}: `media` must not be advertised (schemars skip)"
                );
                // Host-injected soft preference (transcribe_clip only): agents
                // must never see it — the agent-visible knob is the strict
                // `backend` arg.
                assert!(
                    !props.contains_key("preferred_backend"),
                    "{name}: `preferred_backend` must not be advertised (schemars skip)"
                );
                // describe_clip additionally injects the merged VLM backend
                // config (stateless — ADR 0024); it must never be advertised.
                assert!(
                    !props.contains_key("vlm_config"),
                    "{name}: `vlm_config` must not be advertised (schemars skip)"
                );
            }
        }
    }

    #[cfg(feature = "speech")]
    #[test]
    fn catalog_advertises_cloud_tools() {
        let cat = catalog();
        assert!(cat.tools.iter().any(|t| t.name == "transcribe_clip"));
        assert!(cat.tools.iter().any(|t| t.name == "synthesize_speech"));
        assert!(cat.tools.iter().any(|t| t.name == "describe_clip"));
        // every advertised tool must dispatch — schema is an object.
        for t in &cat.tools {
            assert!(
                t.input_schema.is_object(),
                "{} schema not an object",
                t.name
            );
        }
    }

    /// apply_subtitles is a hybrid: its Rust handler is a stub that
    /// returns an error (the TS host intercepts the real call). The catalog entry
    /// stays (asserted above); dispatch reaching the Rust stub errors cleanly.
    #[tokio::test]
    async fn apply_subtitles_rust_handler_is_a_host_stub() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let args = serde_json::json!({
            "body": "1\n00:00:01,000 --> 00:00:02,000\nHi\n", "t_end_us": 2_000_000
        })
        .to_string();
        let err = dispatch_tool(&b, "apply_subtitles", &args)
            .await
            .unwrap_err();
        assert!(
            err.message.contains("host process"),
            "apply_subtitles Rust handler must be a host stub, got: {}",
            err.message,
        );
    }
}
