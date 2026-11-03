//! MCP prompts surface — `cut-pauses`, `auto-caption`, `voiceover`. Owns the
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

pub const NAME_CUT_PAUSES: &str = "cut-pauses";
#[cfg(feature = "speech")]
pub const NAME_AUTO_CAPTION: &str = "auto-caption";
#[cfg(feature = "speech")]
pub const NAME_VOICEOVER: &str = "voiceover";

/// The `clip` argument both clip prompts take. A person picks a prompt from a
/// slash menu and has no layer id, so the clip is named as the user sees it
/// and the agent finds it (`find_clip_step`); an id still works.
fn clip_arg(what: &str) -> PromptArgDef {
    PromptArgDef {
        name: "clip".into(),
        description: Some(format!(
            "The clip {what}, as you would name it: its label, or what it shows or says. \
             Omit for the clip you mean in the conversation."
        )),
        required: false,
    }
}

/// Static prompt catalog; re-exported as `list_prompts`.
pub(crate) fn catalog() -> Vec<PromptDef> {
    let mut prompts = vec![PromptDef {
        name: NAME_CUT_PAUSES.into(),
        description: Some(
            "Cut the pauses out of a clip and close the gaps, tightening it. Or tack \
             them first, so the user reviews every pause before any of it goes."
                .into(),
        ),
        arguments: vec![
            clip_arg("to tighten"),
            PromptArgDef {
                name: "threshold_db".into(),
                description: Some("Peak threshold, dBFS (≤ 0). Omit for the default.".into()),
                required: false,
            },
            PromptArgDef {
                name: "min_pause_us".into(),
                description: Some(
                    "Shortest pause to cut, in microseconds. Omit for the default.".into(),
                ),
                required: false,
            },
            PromptArgDef {
                name: "pad_us".into(),
                description: Some(
                    "Microseconds of each pause kept on each side when cutting. Omit for the \
                     default."
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
                "Transcribe a clip with the configured engine, then lay the transcript on the caption tracks with its word timing."
                    .into(),
            ),
            arguments: vec![
                clip_arg("to caption"),
                PromptArgDef {
                    name: "language".into(),
                    description: Some(
                        "Optional language hint (en, zh, …). Auto-detect when omitted.".into(),
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
                    description: Some("Text to speak.".into()),
                    required: true,
                },
                PromptArgDef {
                    name: "voice".into(),
                    description: Some(
                        "OpenAI voice: alloy, echo, fable, onyx, nova, or shimmer.".into(),
                    ),
                    required: true,
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
                    name: "track".into(),
                    description: Some(
                        "Optional track to place it on, by its name. Omit for the default lane."
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
        NAME_CUT_PAUSES => expand_cut_pauses(args),
        #[cfg(feature = "speech")]
        NAME_AUTO_CAPTION => expand_auto_caption(args),
        #[cfg(feature = "speech")]
        NAME_VOICEOVER => expand_voiceover(args),
        other => Err(McpToolError::invalid_params(
            format!(
                "unknown prompt '{other}'; available: cut-pauses{}",
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

/// The step that turns the user's words for a clip into a `layer_id`: the
/// prompts carry process, and each tool's description carries its contract.
fn find_clip_step(clip: Option<&str>, kinds: &str) -> String {
    let which = match clip {
        Some(c) => format!("the {kinds} layer the user calls \"{c}\" (its label, its media or its text; this may also be a layer id)"),
        None => format!("the {kinds} layer the user means"),
    };
    format!(
        "Find the clip: read `project://tracks` and pick {which}. If none fits, or several do, ask the user which one. Use its `layer_id` below."
    )
}

fn expand_cut_pauses(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let clip = optional_str(args, "clip");
    let threshold = optional_str(args, "threshold_db");
    let min_pause = optional_str(args, "min_pause_us");
    let pad = optional_str(args, "pad_us");

    // The detection args both routes share; `pad_us` shapes the cut only, so it
    // rides along with `remove_pauses` and never with `detect_pauses`.
    let mut extra = String::new();
    if let Some(t) = &threshold {
        extra.push_str(&format!(", `threshold_db: {t}`"));
    }
    if let Some(m) = &min_pause {
        extra.push_str(&format!(", `min_pause_us: {m}`"));
    }
    let mut remove_extra = extra.clone();
    if let Some(p) = &pad {
        remove_extra.push_str(&format!(", `pad_us: {p}`"));
    }
    let find = find_clip_step(clip.as_deref(), "Audio or VideoClip");

    let text = format!(
"Cut the pauses out of a clip and close the gaps.

1. {find}
2. Call `remove_pauses` with the `layer_id`{remove_extra}. It is one recorded edit: one undo puts the clip back whole.
3. Report how many pauses went and how much shorter the clip is.

A refusal changes nothing and names its cause and the fix: act on it. If a layer on another track blocks the cut, offer the user the review-first route.

REVIEW FIRST — when the user wants to see the pauses before any of them goes:
1. Find the clip as above, then call `detect_pauses` with the `layer_id`{extra}. It commits nothing.
2. Call `create_tacks` ONCE, one region tack per pause: `t_us` and `t_end_us` from the pause, and a short `label`. Tacks are review marks, not markers: never `add_marker` here.
3. Tell the user to resolve or dismiss the tacks in the agent panel, and stop.
4. When they are done, read `project://tacks` and call `remove_pauses` with the `layer_id` and `pauses: [{{ t_start_us, t_end_us }}, ...]`, the ranges of the tacks they kept, as detected."
    );
    Ok(PromptResult {
        description: Some(
            "Remove the pauses from a clip, closing each gap; or tack them to review first.".into(),
        ),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

#[cfg(feature = "speech")]
fn expand_auto_caption(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let clip = optional_str(args, "clip");
    let language = optional_str(args, "language");
    let language_clause = match language {
        Some(lang) => format!(", `language: \"{lang}\"`"),
        None => String::new(),
    };
    let find = find_clip_step(clip.as_deref(), "VideoClip or Audio");
    let text = format!(
"Caption a clip with the configured transcription engine.

1. {find} If its pauses are to be cut, cut them first (`/cut-pauses`): captions follow the clip as it was transcribed.
2. Call `transcribe_clip` with `layer_ids: [<the layer_id>]`{language_clause}.
3. Read the `segments` text. Fix proper nouns and terms you can verify; do not rewrite the prose, and keep every word's times and the `source` as they came.
4. Call `apply_transcripts` with the `transcripts`.
5. Report how many cues landed.

If `transcribe_clip` refuses, tell the user what it names and offer the options it lists. Never pass `backend: \"openai\"` or `\"byo_endpoint\"` on your own: they upload the audio, so they need the user's consent."
    );
    Ok(PromptResult {
        description: Some("Auto-caption a clip via transcribe_clip + apply_transcripts.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

#[cfg(feature = "speech")]
fn expand_voiceover(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let script = require_str(args, "script")?;
    // Required here because `synthesize_speech` requires it: a prompt that
    // promised a default voice would write a call the tool refuses.
    let voice = require_str(args, "voice")?;
    let speed = optional_str(args, "speed");
    let track = optional_str(args, "track");

    let mut extra = format!(", `voice: \"{voice}\"`");
    if let Some(s) = &speed {
        extra.push_str(&format!(", `speed: {s}`"));
    }
    let mut steps: Vec<String> = Vec::new();
    if let Some(t) = &track {
        steps.push(format!(
            "Find the track the user calls \"{t}\" in `project://tracks` and pass its `track_id` as `target_track_id`. If none fits, or several do, ask."
        ));
        extra.push_str(", `target_track_id`");
    }
    steps.push(format!(
        "Call `synthesize_speech` with `text: <the script>`{extra}. A script longer than the tool takes goes in several calls, split at paragraph boundaries, in order."
    ));
    steps.push(
        "Report where the voiceover landed and whether it was `cached` (no new charge).".into(),
    );
    let steps = steps
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {s}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");

    let text = format!(
"Generate voiceover audio for the script below in the `{voice}` voice.

Script:
\"\"\"
{script}
\"\"\"

Steps:
{steps}

If `synthesize_speech` refuses, tell the user what it names; an OpenAI key goes under Settings → API keys."
    );
    Ok(PromptResult {
        description: Some("Generate cloud TTS and attach it as an Audio layer.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

#[cfg(feature = "speech")]
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
    fn catalog_lists_cut_pauses_with_no_required_args() {
        let cat = catalog();
        #[cfg(not(feature = "speech"))]
        assert_eq!(cat.len(), 1);
        #[cfg(feature = "speech")]
        assert_eq!(cat.len(), 3);

        let cs = cat.iter().find(|p| p.name == NAME_CUT_PAUSES).unwrap();
        for optional in ["clip", "threshold_db", "min_pause_us", "pad_us"] {
            let arg = cs
                .arguments
                .iter()
                .find(|a| a.name == optional)
                .unwrap_or_else(|| panic!("{optional} must be advertised"));
            assert!(!arg.required);
        }
    }

    /// A person invokes a prompt from a slash menu and has no layer id
    /// (audit W16), so no prompt asks for one: the clip is named in words, or
    /// left out, and the body tells the agent how to find it.
    #[test]
    fn no_prompt_requires_an_id() {
        for p in catalog() {
            for a in &p.arguments {
                assert!(
                    !(a.required && (a.name.ends_with("_id") || a.name.ends_with("_ids"))),
                    "{} requires {}",
                    p.name,
                    a.name
                );
            }
        }
        let body =
            message_text(&expand(NAME_CUT_PAUSES, None).expect("expand").messages[0]).to_string();
        assert!(body.contains("read `project://tracks`"));
        assert!(body.contains("ask the user which one"));
    }

    #[test]
    fn cut_pauses_names_the_clip_the_user_gave_and_both_routes() {
        let a = args(&[("clip", json!("Interview A"))]);
        let result = expand(NAME_CUT_PAUSES, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("\"Interview A\""));
        // Two routes over one detection: the cut leads, the tack is the
        // review-first alternative.
        assert!(body.contains("remove_pauses"));
        assert!(body.contains("detect_pauses"));
        // `t_end_us` is what makes each tack a region spanning the pause.
        assert!(body.contains("create_tacks"));
        assert!(body.contains("`t_end_us`"));
        assert!(!body.contains("end_t_us"));
        assert!(body.contains("`label`"));
    }

    /// The prompt carries process; each tool's description carries its
    /// contract (W16). Return shapes, defaults and refusal lists restated here
    /// drift from the tools, so none is.
    #[test]
    fn cut_pauses_restates_no_tool_contract() {
        let result = expand(NAME_CUT_PAUSES, None).expect("expand");
        let body = message_text(&result.messages[0]);
        for contract in [
            "100000",
            "-34",
            "500",
            "surviving_layer_ids",
            "noise_floor_db",
            "RippleInsideHole",
            "DerivativeNotReady",
        ] {
            assert!(!body.contains(contract), "restates `{contract}`");
        }
    }

    /// Review marks are tacks, not markers (ADR 0115): markers are the user's
    /// content, and an agent writes one only when the user asks for markers.
    #[test]
    fn review_first_points_with_tacks_never_with_markers() {
        let result = expand(NAME_CUT_PAUSES, None).expect("expand");
        let body = message_text(&result.messages[0]);
        let (_, review_half) = body.split_once("REVIEW FIRST").expect("both halves");
        assert!(review_half.contains("Call `create_tacks` ONCE"));
        assert!(
            review_half.contains("resolve") && review_half.contains("dismiss"),
            "the agent learns where the user's decision shows up"
        );
        assert!(review_half.contains("never `add_marker`"));
        assert!(!body.contains("call `add_marker`"));
        // The reviewed subset is cut as reviewed, not re-detected.
        assert!(review_half.contains("`pauses: [{ t_start_us, t_end_us }, ...]`"));
    }

    /// `pad_us` shapes the cut, not the detection, so it must reach
    /// `remove_pauses` and stay off the `detect_pauses` call the review-first
    /// route makes — an argument that tool does not take.
    #[test]
    fn cut_pauses_passes_through_optional_args_to_the_tool_that_takes_them() {
        let a = args(&[
            ("threshold_db", json!("-28")),
            ("min_pause_us", json!("1000000")),
            ("pad_us", json!("200000")),
        ]);
        let result = expand(NAME_CUT_PAUSES, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`threshold_db: -28`"));
        assert!(body.contains("`min_pause_us: 1000000`"));
        assert_eq!(
            body.matches("`pad_us: 200000`").count(),
            1,
            "pad_us belongs to the remove call only"
        );
        let (remove_half, review_half) = body.split_once("REVIEW FIRST").expect("both halves");
        assert!(remove_half.contains("`pad_us: 200000`"));
        assert!(!review_half.contains("`pad_us: 200000`"));
    }

    #[test]
    fn expand_unknown_prompt_errors() {
        let err = expand("nope", None).expect_err("unknown name");
        assert!(format!("{err}").contains("unknown prompt 'nope'"));
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
    fn auto_caption_finds_the_clip_and_asks_before_uploading() {
        let a = args(&[("clip", json!("the interview")), ("language", json!("zh"))]);
        let r = expand("auto-caption", Some(&a)).expect("expand auto-caption");
        let body = message_text(&r.messages[0]);
        assert!(body.contains("\"the interview\""));
        assert!(body.contains("read `project://tracks`"));
        assert!(body.contains("`layer_ids: [<the layer_id>]`, `language: \"zh\"`"));
        assert!(body.contains("they upload the audio"));
        assert!(
            !body.contains("MissingKey") && !body.contains("PayloadTooLarge"),
            "no token the tool's own refusal does not say"
        );
        assert!(!body.contains("source_layer_ids"));
        assert!(expand("auto-caption", None).is_ok(), "the clip is optional");
    }

    #[cfg(feature = "speech")]
    #[test]
    fn voiceover_expands_with_script_and_voice() {
        let a = args(&[("script", json!("hello there")), ("voice", json!("nova"))]);
        let r = expand("voiceover", Some(&a)).expect("expand voiceover");
        let body = message_text(&r.messages[0]);
        assert!(body.contains("hello there"));
        assert!(body.contains("in the `nova` voice"));
        assert!(body.contains("`voice: \"nova\"`"));
        assert!(
            !body.contains("voice voice"),
            "the sentence names one voice once"
        );
        assert!(body.contains("Settings → API keys"));
        assert!(
            !body.contains("target_track_id"),
            "no track named, no track step"
        );
        assert!(
            !body.contains("MissingKey"),
            "no token names the model cannot act on"
        );
    }

    #[cfg(feature = "speech")]
    #[test]
    fn voiceover_takes_a_track_by_name() {
        let a = args(&[
            ("script", json!("hi")),
            ("voice", json!("nova")),
            ("track", json!("Narration")),
        ]);
        let r = expand("voiceover", Some(&a)).expect("expand voiceover");
        let body = message_text(&r.messages[0]);
        assert!(body.contains("\"Narration\""));
        assert!(body.contains("`target_track_id`"));
    }

    /// `voice` is required because the tool requires it — the prompt and the
    /// tool agree, and the catalog says so.
    #[cfg(feature = "speech")]
    #[test]
    fn voiceover_requires_voice_as_the_tool_does() {
        let a = args(&[("script", json!("hello there"))]);
        assert!(expand("voiceover", Some(&a)).is_err());
        let def = catalog()
            .into_iter()
            .find(|p| p.name == "voiceover")
            .expect("voiceover in catalog");
        let voice = def
            .arguments
            .iter()
            .find(|a| a.name == "voice")
            .expect("voice arg");
        assert!(voice.required);
    }

    fn message_text(msg: &PromptMessage) -> &str {
        match &msg.content {
            ContentBlock::Text { text } => text.as_str(),
            other => panic!("expected text content, got {other:?}"),
        }
    }
}
