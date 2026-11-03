//! One declarative table feeds BOTH `tool_catalog()` (the advertised schemas)
//! and `dispatch_tool()` (the name→handler match), so a tool can never appear
//! in one without the other. Each entry's description is the literal text the
//! MCP catalog advertises to clients.
//!
//! This table carries the native/compute/hybrid tools only.
//! TS-executed mutations are served by the TS actor's `MCP_TOOLS` table and
//! routed by `routeMcpTool`.

use super::wire::{
    McpCatalog, McpToolError, PromptDef, ResourceDef, ToolAnnotations, ToolDef, ToolResult,
};
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
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if let Some(props) = obj
        .get_mut("properties")
        .and_then(serde_json::Value::as_object_mut)
    {
        for (name, prop) in props.iter_mut() {
            if !required.iter().any(|r| r == name) {
                if let Some(p) = prop.as_object_mut() {
                    for key in ["type", "enum"] {
                        let Some(arr) = p.get(key).and_then(serde_json::Value::as_array).cloned()
                        else {
                            continue;
                        };
                        let kept: Vec<serde_json::Value> = arr
                            .into_iter()
                            .filter(|t| !(t.is_null() || t.as_str() == Some("null")))
                            .collect();
                        let collapsed = if key == "type" && kept.len() == 1 {
                            kept[0].clone()
                        } else {
                            serde_json::Value::Array(kept)
                        };
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
    #[cfg(feature = "jobs")]
    "analyze_audio" => ("Analyze original source audio from cached waveform peaks; local, read-only, no model. Returns bounded peak/RMS waveform bins, onset candidates and signed energy changes (dB), all in source µs (`src_*`), plus resolution and event counts. Choose music edit/alignment points, including outside a clip's trim. These are amplitude measurements, not beats, bars or melody recognition. At most 60 s per call; max_points affects only the summary. Peaks are cache-limited, not true-peak or LUFS. To land `src_us` at timeline T on a layer: `src_in_us = src_us - (T - t_start_us) * rate` (`rate` from project://tracks, 1 when absent).", super::audio_analysis::AnalyzeAudioArgs, super::audio_analysis::analyze_audio, ToolAnnotations::READ),
    // begin_agent_session routes to the TS actor ('ts' MCP tool) and is supplied
    // by the TS def; mergeMcpCatalog filters it out of the Rust side.
    #[cfg(feature = "jobs")]
    "detect_pauses" => ("Find the pauses in the audio a clip plays — the stretches nobody is speaking — from the pre-computed waveform. Read-only: the writes are `remove_pauses` (cut them, or a reviewed subset via its `pauses`) and `create_tacks` (point the user at them). A pause is a run where every channel's peak stays below `threshold_db` (dBFS, default -34) for at least `min_pause_us` (default 500000); a louder run under 80 ms inside it (a click, a cough) does not end it. `layer_id` is an Audio layer, or a VideoClip, read through the linked Audio member that plays (refused when it plays no sound). Returns `{ pauses: [{ t_start_us, t_end_us }], noise_floor_db, peaks_source }`, timeline µs, sorted; `noise_floor_db` is the 10th-percentile peak (null in silence; a threshold reads well 6 dB above it); `peaks_source` is \"raw\" or \"fx\" (baked effect chain). Refused (`DerivativeNotReady` with the waveform's `state`) until ready: retry after `retry_after_s`; `failed` names its reason.", tools::DetectPausesArgs, tools::detect_pauses, ToolAnnotations::READ),
    #[cfg(feature = "jobs")]
    "analyze_clip" => ("Shots and defect spans of a video's source, deterministic. `media_id`: a pooled item, placed or not, whole; `layer_id`: a VideoClip, clipped to the source it plays, plus its `mapping` (t = t_start_us + (src - src_in_us) / rate). Returns `{ media_id, mapping?, shots: [{ index, src_start_us, src_end_us, src_keyframe_us, brightness, motion, sharpness, flags }], cut_scores: [{ src_us, score }], spans? }`, source µs; `score` 0..1. Stats from 3 frames/shot: `brightness` midpoint mean luma 0..1; `motion` 1 - SSIM of the end frames; `sharpness` Laplacian variance, relative per source. `flags`: \"black\" (all 3 < luma 0.02), \"freeze\" (SSIM >= 0.985), \"fade\" (monotonic luma ramp >= 0.15 touching < 0.10). Dark/blurry/frozen spots in shots: `passes: [\"spans\"]` samples every `step_us` into `spans: [{ kind, src_start_us, src_end_us, value }]`: \"dark\" luma < 0.08 >= 0.5 s (value: mean), \"soft\" sharpness < 35% of source median >= 1 s (value: ratio), \"frozen\" adjacent SSIM >= 0.985 >= 1 s (value: min). `passes` default shots, stats, events; `[\"shots\"]` = timing only. To split: `auto_split_by_shot`.", tools::AnalyzeClipArgs, tools::analyze_clip, ToolAnnotations::READ),
    #[cfg(feature = "jobs")]
    "compare_frames" => ("Compare two video frames for perceptual similarity — dedup shots, match a cutaway. Each side is `{ media_id | layer_id, src_us }`: a pooled video (placed or not) or a VideoClip, and a source µs time (the space of `analyze_clip`'s `src_keyframe_us` and `media://{id}/frame/{src_us}`); the two may be one source or two. Returns `{ phash_hamming, ssim, similar }`: `phash_hamming` is the 0..64 distance between the frames' perceptual hashes (0 = identical, 20+ = a different scene), `ssim` is structural similarity 0..1, and `similar` is `phash_hamming <= 10 && ssim >= 0.5`. Read-only; video only, errors naming the offending side.", tools::CompareFramesArgs, tools::compare_frames, ToolAnnotations::READ),
    #[cfg(feature = "jobs")]
    "import_media" => ("Import media files: every path is checked first (a directory, missing or unreadable file refuses the call, nothing imported), then each is hashed, probed and copied into the project's Media/ folder. Returns `{ media: [record] }` in path order, each the pooled record with `derivatives`; `path` / `path_rel` name the Media/ copy (`copying: true` while it lands). A pooled file answers `existing: true` (a repeat is harmless), a missing one now read from here `relinked: true`; `same_content_as` names copies of its bytes. .srt/.vtt/.ass pool for `apply_subtitles`; .svg rasterises to PNG. Unrecorded.", tools::ImportMediaArgs, tools::import_media, ToolAnnotations::WRITE_IDEMPOTENT),
    #[cfg(feature = "speech")]
    "extract_clip_audio" => ("Extract the ORIGINAL source audio that plays on a VideoClip or Audio layer (a VideoClip through its linked Audio member) — before gain, mute, effects or mixing — for an agent running its own speech model; no engine or API key is involved and nothing is uploaded. Returns a JSON metadata block (`layer_id`, `media_id`, `t_start_us`, `t_end_us`, `src_in_us`, `src_out_us`, `duration_us`, `rate` {num, den}, `sample_rate_hz`, `channels`, `bits_per_sample`, `byte_length`, `mime_type`) plus an MCP audio block: base64 WAV, mono 16 kHz 16-bit, starting at zero — about 2.6 MB of base64 per 60 s. Optional `t_start_us`/`t_end_us` are timeline µs, defaulting to the layer endpoints; at most 60 s of source audio per call (timeline windows ≤ 60 s / rate), so a long clip is several calls. Map a WAV offset `w` to the timeline as `t_start_us + w / rate`, then `apply_transcripts`. Refuses a layer that plays no sound and a window outside the layer.",
                             super::clip_audio::ExtractClipAudioArgs, super::clip_audio::extract_clip_audio, ToolAnnotations::READ),
    #[cfg(feature = "speech")]
    "transcribe_clip" => ("Transcribe the audio that plays on 1–20 VideoClip or Audio layers (a VideoClip through its linked Audio member). Returns `{ transcripts: [{ source: { layer_id, signature }, backend, segments: [{ t_start_us, t_end_us, text, words: [{ t_start_us, t_end_us, text }] }], language, word_timing }], failed? }`, one per layer in order, timeline µs; hand `transcripts` to `apply_transcripts` as is. Cut pauses first, caption after: a clip changed since is refused there. `failed` lists layers that refused, with why. `t_start_us`/`t_end_us` narrow one layer's window. `language` is BCP-47; a model that does not cover it, or the language it detects, refuses with options. `whisper_cpp` and `funasr` run on this machine; `openai` (cloud) and `byo_endpoint` (the user's server) UPLOAD the audio — name one in `backend` only with the user's consent. Without `backend` the model selected in Settings runs, never another; if it cannot, the refusal names what it lacks and the ready engines. A retry after a client timeout joins the running job.", tools::TranscribeClipArgs, tools::transcribe_clip, ToolAnnotations::READ_OPEN),
    #[cfg(feature = "speech")]
    "synthesize_speech" => ("Synthesize speech with the configured cloud TTS provider (OpenAI tts-1; the text is uploaded) and place it as a voiceover Audio layer, one placement or none: a refused placement leaves nothing in the pool. `text` ≤ 4096 chars; `voice`; optional `speed` 0.25..4.0 (default ≈ 1.0); `composition_id` (default root); `t_start_us` (default: the composition's duration, so it appends); `target_track_id`, else the topmost unlocked track whose audio lane is free across the clip, else a new 'Voiceover' track. The MP3 is cached by `(model, voice, speed, text)`, so a repeat costs no API request. Returns `{ layer_id, media_id, track_id, t_start_us, t_end_us, cached }`.", tools::SynthesizeSpeechArgs, tools::synthesize_speech, ToolAnnotations::WRITE_OPEN),
    #[cfg(feature = "speech")]
    "describe_clip" => ("Describe a video's visual content as timestamped segments with a video-understanding model (local Qwen3-VL / MiniCPM-V, or an OpenAI-compatible endpoint). Name a pooled item by `media_id` (placed or not; the whole source by default) or a VideoClip by `layer_id` (the source it plays, plus its `mapping`, as `analyze_clip`'s). Samples the window at `fps` (default 1.0), ≤3600 frames per call. Returns `{ backend, model, summary?, media_id, mapping?, segments: [{ src_start_us, src_end_us, text, tags }] }`, source µs; `text` is prose, `tags` short visual keywords; long windows add a `summary`. Cached per source range, so a retry after a client timeout or an interruption resumes; `refresh` re-describes. `src_start_us`/`src_end_us` (e.g. a shot's) narrow the window; `focus` steers `tags`; `language` is BCP-47 (default: UI language). `qwen3_vl` and `minicpm_v` run on this machine; `byo_endpoint` UPLOADS frames — name it only with the user's consent. `backend` REQUIRES that engine, never substituting; omitted: the selected engine, then availability (local first).", tools::DescribeClipArgs, tools::describe_clip, ToolAnnotations::READ_OPEN),
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
    /// must be dispatchable. Smoke: a read tool with no required argument
    /// dispatches through the table.
    #[tokio::test]
    async fn a_listed_tool_dispatches() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let err = dispatch_tool(&b, "analyze_audio", "{}").await.unwrap_err();
        assert_ne!(
            err.code,
            super::super::wire::McpErrorCode::NotFound,
            "a listed tool must dispatch (an argument refusal is fine)"
        );
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
        #[cfg(feature = "jobs")]
        assert!(cat.tools.iter().any(|t| t.name == "import_media"));
        assert!(cat.resources.iter().any(|r| r.uri == "project://compiled"));
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
            "analyze_audio",
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
                // …and transcribe_clip the speech one (ADR 0036).
                assert!(
                    !props.contains_key("speech_config"),
                    "{name}: `speech_config` must not be advertised (schemars skip)"
                );
            }
        }
        // transcribe_clip: the host's per-layer id and the model's languages
        // are injected; describe_clip's cache purpose is the app's (M19).
        let props = |name: &str| {
            cat.tools
                .iter()
                .find(|t| t.name == name)
                .and_then(|t| t.input_schema["properties"].as_object().cloned())
                .unwrap_or_default()
        };
        let transcribe = props("transcribe_clip");
        assert!(transcribe.contains_key("layer_ids"));
        assert!(!transcribe.contains_key("layer_id"));
        assert!(!transcribe.contains_key("model_languages"));
        assert!(!props("describe_clip").contains_key("purpose"));
        // TTS carries the same injected config (its OpenAI key).
        let tts = cat
            .tools
            .iter()
            .find(|t| t.name == "synthesize_speech")
            .expect("synthesize_speech must be advertised");
        assert!(tts.input_schema["properties"]
            .as_object()
            .is_some_and(|p| !p.contains_key("speech_config")));
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
}
