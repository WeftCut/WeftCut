//! MCP prompts surface — `cut-silences`, `auto-caption`, `voiceover`. Owns the
//! advertised prompt catalog (`catalog`) and the per-call expansion (`expand`);
//! the cloud-backed `auto-caption` / `voiceover` exist only under
//! `#[cfg(feature = "speech")]`.
//!
//! Design: `docs/mcp.md`.

use serde_json::Map;
use serde_json::Value;

use super::wire::{
    ContentBlock, McpToolError, PromptArgDef, PromptDef, PromptMessage, PromptResult, PromptRole,
};

pub const NAME_CUT_SILENCES: &str = "cut-silences";
#[cfg(feature = "speech")]
pub const NAME_AUTO_CAPTION: &str = "auto-caption";
#[cfg(feature = "speech")]
pub const NAME_VOICEOVER: &str = "voiceover";

/// Static prompt catalog; re-exported as `list_prompts`.
pub(crate) fn catalog() -> Vec<PromptDef> {
    let mut prompts = vec![PromptDef {
        name: NAME_CUT_SILENCES.into(),
        description: Some(
            "Cut the silent regions out of a clip and close the gaps, tightening it. Or mark \
             them first, to review every gap on the ruler before any of it goes."
                .into(),
        ),
        arguments: vec![
            PromptArgDef {
                name: "layer_id".into(),
                description: Some("Target VideoClip or Audio layer id.".into()),
                required: true,
            },
            PromptArgDef {
                name: "threshold_amp".into(),
                description: Some(
                    "Peak amplitude threshold in [0.0, 1.0]. Default 0.02 (≈ -34 dBFS).".into(),
                ),
                required: false,
            },
            PromptArgDef {
                name: "min_silence_us".into(),
                description: Some(
                    "Minimum silence duration to cut, in microseconds. Default 500000 (0.5s)."
                        .into(),
                ),
                required: false,
            },
        ],
    }];
    #[cfg(feature = "speech")]
    {
        prompts.push(PromptDef {
            name: NAME_AUTO_CAPTION.into(),
            description: Some(
                "Transcribe a video or audio layer with cloud Whisper, then apply the SRT as subtitles."
                    .into(),
            ),
            arguments: vec![
                PromptArgDef {
                    name: "layer_id".into(),
                    description: Some("Target VideoClip or Audio layer id.".into()),
                    required: true,
                },
                PromptArgDef {
                    name: "language".into(),
                    description: Some(
                        "Optional ISO-639-1 language hint (en, zh, etc.). Auto-detect when omitted."
                            .into(),
                    ),
                    required: false,
                },
            ],
        });
        prompts.push(PromptDef {
            name: NAME_VOICEOVER.into(),
            description: Some(
                "Generate cloud TTS for a script and attach it as an Audio layer.".into(),
            ),
            arguments: vec![
                PromptArgDef {
                    name: "script".into(),
                    description: Some(
                        "Text to speak. tts-1 caps a single call at 4096 chars; for longer scripts split into paragraphs."
                            .into(),
                    ),
                    required: true,
                },
                PromptArgDef {
                    name: "voice".into(),
                    description: Some(
                        "OpenAI voice: alloy, echo, fable, onyx, nova, or shimmer.".into(),
                    ),
                    required: false,
                },
                PromptArgDef {
                    name: "speed".into(),
                    description: Some(
                        "Optional speech speed in [0.25, 4.0]. Omit for the provider default."
                            .into(),
                    ),
                    required: false,
                },
                PromptArgDef {
                    name: "target_track_id".into(),
                    description: Some(
                        "Optional Audio track id. Defaults to the first existing Audio track or a new 'Voiceover' track."
                            .into(),
                    ),
                    required: false,
                },
            ],
        });
    }
    prompts
}

/// Resolve a prompt name + arguments to a `PromptResult` ready for the client.
/// Unknown names bubble up as `invalid_params` so well-behaved clients can show
/// "prompt not available" gracefully.
pub(crate) fn expand(
    name: &str,
    args: Option<&Map<String, Value>>,
) -> Result<PromptResult, McpToolError> {
    match name {
        NAME_CUT_SILENCES => expand_cut_silences(args),
        #[cfg(feature = "speech")]
        NAME_AUTO_CAPTION => expand_auto_caption(args),
        #[cfg(feature = "speech")]
        NAME_VOICEOVER => expand_voiceover(args),
        other => Err(McpToolError::invalid_params(
            format!(
                "unknown prompt '{other}'; available: cut-silences{}",
                if cfg!(feature = "speech") {
                    ", auto-caption, voiceover"
                } else {
                    ""
                }
            ),
            None,
        )),
    }
}

fn expand_cut_silences(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let layer_id = require_str(args, "layer_id")?;
    let threshold = optional_str(args, "threshold_amp");
    let min_silence = optional_str(args, "min_silence_us");

    let mut extra = String::new();
    if let Some(t) = &threshold {
        extra.push_str(&format!(", `threshold_amp: {t}`"));
    }
    if let Some(m) = &min_silence {
        extra.push_str(&format!(", `min_silence_us: {m}`"));
    }

    let text = format!(
"Cut the silent gaps out of layer `{layer_id}` and close them.

Steps:
1. Call `remove_silences` with `layer_id: \"{layer_id}\"`{extra}. It walks the pre-computed waveform peaks, splits the clip at the edges of every silent stretch, deletes those stretches and closes the gaps behind them, all as ONE recorded edit — a single undo puts the clip back whole. It returns `{{ surviving_layer_ids, removed, removed_us }}`: what is left of the clip in timeline order, how many silent stretches went, and how much time went with them. Linked audio/video partners travel with each removed slice, so no orphaned sliver is left behind. If the tool errors with a `waveform not generated yet` message, wait for the corresponding `media:job_complete` event (kind=waveform) and retry — imports run in the background.
2. Report how many silent stretches were removed and how much shorter the clip is.

A refusal is whole and lands before any write, so the clip comes back UNSPLIT with nothing recorded — fix what it names and call again. `RippleInsideHole` means a layer on another track STARTS inside one of the silent stretches, so the gap cannot close over it: either ripple that layer away too, or take the review-first route below and let the human decide. `RippleCollision`, `RippleLinkStraddles` and `RippleLockedLayer` / `TrackLocked` each name the layer that blocked. `InvalidArgument` means the clip is silent end to end — removing every part of it is a `delete_layer` (or `ripple_delete_layers`), not an edit to it.

REVIEW FIRST — the alternative when the gaps should be seen before any of them goes:
1. Call `detect_silences` with `layer_id: \"{layer_id}\"`{extra}. Same walk over the same peaks, but it commits nothing: it returns timeline-absolute `[{{ t_start_us, t_end_us }}, ...]` ranges where the audio is below threshold for the requested duration.
2. For each region, call `add_marker` with `t_us: <region.t_start_us>` and `end_t_us: <region.t_end_us>` — setting `end_t_us` is what makes it a REGION marker spanning the gap rather than a point at its start. Pass `anchor_layer_id: \"{layer_id}\"` so the mark follows the clip's material instead of standing at a fixed timeline instant: a ripple upstream then moves it with the audio it describes, and trimming the clip past a marked gap hibernates that mark rather than stranding it somewhere it means nothing. One call per region, each its own history entry.
3. Report how many silent regions were marked and their total duration, and leave what becomes of them to the human.

Defaults if the agent leaves args off: threshold_amp = 0.02 (-34 dBFS), min_silence_us 500ms — tuned for podcast-style speech with quick breath-pause cuts. Loosen for music (lower threshold, longer min) or tighten for talking-head (higher threshold)."
    );
    Ok(PromptResult {
        description: Some("Remove the silent regions from a clip, closing each gap; or mark them to review first.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

#[cfg(feature = "speech")]
fn expand_auto_caption(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let layer_id = require_str(args, "layer_id")?;
    let language = optional_str(args, "language");
    let language_clause = match language {
        Some(lang) => format!(", `language: \"{lang}\"`"),
        None => String::new(),
    };
    let text = format!(
"Auto-caption the clip on layer `{layer_id}` using the configured transcription engine.

Steps:
1. Call `transcribe_clip` with `layer_id: \"{layer_id}\"`{language_clause}. The tool extracts the layer's audio (mono 16 kHz WAV), transcribes it with the configured engine (cloud OpenAI Whisper, or local whisper.cpp / FunASR), and returns a JSON envelope `{{ backend, segments, language, word_timing, srt }}` with all timestamps already shifted to timeline-absolute microseconds. The `srt` field is a ready-to-apply SubRip body; `segments`/`words` carry the same content with per-word spans.
2. Inspect the `srt` field. Fix obvious mistakes you can spot — proper nouns, technical terms, on-screen text that should match exactly. Don't rewrite the prose.
3. Call `apply_subtitles` with the (possibly edited) `srt` body — NOT the whole JSON envelope. The cues self-position into a new caption track of editable Text layers via their internal timestamps — you do not pass start/end times (any `t_start_us`/`t_end_us` are ignored). The tool returns the new caption track id.

If `transcribe_clip` errors because no backend is configured (or with `MissingKey` / `InvalidKey`), tell the user to add an OpenAI API key or configure a local engine under Settings → Transcription. If `PayloadTooLarge`, narrow the window with `t_start_us`/`t_end_us` and call again — the cloud Whisper per-request cap is ~13 minutes of mono 16 kHz audio (local engines have no upload cap)."
    );
    Ok(PromptResult {
        description: Some("Auto-caption a clip via cloud Whisper + apply_subtitles.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

#[cfg(feature = "speech")]
fn expand_voiceover(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let script = require_str(args, "script")?;
    let voice = optional_str(args, "voice");
    let speed = optional_str(args, "speed");
    let target_track = optional_str(args, "target_track_id");

    let voice_clause = match &voice {
        Some(v) => format!("`{v}`"),
        None => "the default voice".to_string(),
    };

    let mut extra = String::new();
    if let Some(v) = &voice {
        extra.push_str(&format!(", `voice: \"{v}\"`"));
    }
    if let Some(s) = &speed {
        extra.push_str(&format!(", `speed: {s}`"));
    }
    if let Some(t) = &target_track {
        extra.push_str(&format!(", `target_track_id: \"{t}\"`"));
    }

    let text = format!(
"Generate voiceover audio for the script below using the {voice_clause} voice.

Script:
\"\"\"
{script}
\"\"\"

Steps:
1. Call `synthesize_speech` with `text: <the script>`{extra}. The tool content-addresses by `(model, voice, speed, text)`, so an identical earlier call returns the cached audio without re-billing.
2. Report the resulting `layer_id`, `media_id`, `t_start_us`, `t_end_us`, and whether the result was `cached`.

If the script exceeds 4096 characters, split it at paragraph boundaries and synthesize each chunk separately. Each call's `t_start_us` defaults to the current `composition.duration_us`, so successive chunks chain at the end of the timeline.

If `synthesize_speech` errors with `MissingKey` or `InvalidKey`, tell the user to configure their OpenAI API key under Settings → Transcription."
    );
    Ok(PromptResult {
        description: Some("Generate cloud TTS and attach it as an Audio layer.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

fn require_str(args: Option<&Map<String, Value>>, key: &str) -> Result<String, McpToolError> {
    optional_str(args, key).ok_or_else(|| {
        McpToolError::invalid_params(format!("required prompt argument '{key}' missing"), None)
    })
}

fn optional_str(args: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    args.and_then(|m| m.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(pairs: &[(&str, Value)]) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert((*k).into(), v.clone());
        }
        m
    }

    #[test]
    fn catalog_lists_cut_silences_with_required_args_marked() {
        let cat = catalog();
        #[cfg(not(feature = "speech"))]
        assert_eq!(cat.len(), 1);
        #[cfg(feature = "speech")]
        assert_eq!(cat.len(), 3);

        let cs = cat.iter().find(|p| p.name == NAME_CUT_SILENCES).unwrap();
        let layer = cs.arguments.iter().find(|a| a.name == "layer_id").unwrap();
        assert!(layer.required);
        let threshold = cs
            .arguments
            .iter()
            .find(|a| a.name == "threshold_amp")
            .unwrap();
        assert!(!threshold.required);
    }

    #[test]
    fn cut_silences_interpolates_layer_id_and_names_both_recipes() {
        let a = args(&[("layer_id", json!("xyz-789"))]);
        let result = expand(NAME_CUT_SILENCES, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`xyz-789`"));
        // Two recipes over one detection, and the prompt carries both: the cut
        // is the answer it leads with, the mark is the review-first fallback.
        assert!(body.contains("remove_silences"));
        assert!(body.contains("detect_silences"));
        // `end_t_us` is what makes each mark a region spanning the gap rather
        // than a point at its start, and the anchor is what keeps it tied to the
        // audio it describes. Drop either and the marks stop meaning what the
        // prompt says they mean.
        assert!(body.contains("add_marker"));
        assert!(body.contains("end_t_us"));
        assert!(body.contains("anchor_layer_id"));
    }

    /// This prompt could not keep its own name while the editor had no ripple
    /// delete: split then split then `delete_layer` left a gap exactly as long
    /// as what it removed — audibly identical to doing nothing — so the recipe
    /// marked, the blurb said so, and a "DO NOT split and delete" instruction
    /// stood in for the missing primitive. `remove_silences` is that primitive
    /// (ADR 0062), and every pin moves with it: the recipe cuts, the warning is
    /// gone, and the blurb may promise tightening because it now delivers it.
    /// The marking recipe stays pinned as the review-first alternative, so
    /// neither half can quietly drop out of the prompt.
    #[test]
    fn cut_silences_cuts_the_gaps_and_keeps_marking_as_the_alternative() {
        let a = args(&[("layer_id", json!("xyz"))]);
        let result = expand(NAME_CUT_SILENCES, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(
            body.contains("remove_silences"),
            "the recipe must reach the primitive that actually closes the gap"
        );
        assert!(
            !body.contains("DO NOT split and delete"),
            "the instruction that stood in for a missing primitive must not outlive it"
        );
        // The review-first half, intact.
        assert!(body.contains("detect_silences"));
        assert!(body.contains("add_marker"));
        assert!(body.contains("end_t_us"));
        assert!(body.contains("anchor_layer_id"));

        let listed = catalog();
        let cs = listed
            .iter()
            .find(|p| p.name == NAME_CUT_SILENCES)
            .expect("cut-silences in catalog");
        let desc = cs.description.as_deref().unwrap_or_default();
        assert!(
            !desc.contains("does not have"),
            "catalog blurb must not still claim the editor cannot cut: {desc}"
        );
        assert!(
            desc.contains("tightening"),
            "catalog blurb should promise what it now delivers: {desc}"
        );
        assert!(
            desc.contains("mark"),
            "catalog blurb must still offer the review-first half: {desc}"
        );
    }

    #[test]
    fn cut_silences_passes_through_optional_thresholds() {
        let a = args(&[
            ("layer_id", json!("xyz")),
            ("threshold_amp", json!("0.05")),
            ("min_silence_us", json!("1000000")),
        ]);
        let result = expand(NAME_CUT_SILENCES, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`threshold_amp: 0.05`"));
        assert!(body.contains("`min_silence_us: 1000000`"));
    }

    #[test]
    fn expand_unknown_prompt_errors() {
        let err = expand("nope", None).expect_err("unknown name");
        assert!(format!("{err}").contains("unknown prompt 'nope'"));
    }

    #[test]
    fn cut_silences_requires_layer_id() {
        let err = expand(NAME_CUT_SILENCES, None).expect_err("missing layer_id");
        assert!(format!("{err}").contains("layer_id"));
    }

    #[cfg(feature = "speech")]
    #[test]
    fn catalog_includes_cloud_prompts() {
        let names: Vec<_> = catalog().into_iter().map(|p| p.name).collect();
        assert!(names.iter().any(|n| n == "auto-caption"));
        assert!(names.iter().any(|n| n == "voiceover"));
    }

    #[cfg(feature = "speech")]
    #[test]
    fn voiceover_expands_with_script() {
        let a = args(&[("script", json!("hello there"))]);
        let r = expand("voiceover", Some(&a)).expect("expand voiceover");
        let body = message_text(&r.messages[0]);
        assert!(body.contains("hello there"));
    }

    fn message_text(msg: &PromptMessage) -> &str {
        match &msg.content {
            ContentBlock::Text { text } => text.as_str(),
            other => panic!("expected text content, got {other:?}"),
        }
    }
}
