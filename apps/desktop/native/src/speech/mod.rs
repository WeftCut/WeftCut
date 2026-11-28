//! Pluggable speech backends behind a locality-neutral trait surface.
//!
//! Two capability surfaces (tool contracts in `docs/mcp.md`):
//! - **Transcription** — [`Transcriber`] trait → `transcribe_clip` MCP tool.
//! - **Text-to-speech** — [`Synthesizer`] trait → `synthesize_speech` MCP tool.
//!
//! A backend runs only when it is *available*, which generalizes "has an API
//! key". Each [`backend::SpeechBackend`] declares its
//! [`backend::Locality`] (Cloud/Local) and [`backend::Capabilities`]; its
//! config (an API key, or a local engine's binary/model paths) lives in
//! [`config::BackendConfig`], and [`config::availability`] decides whether it
//! can run right now (cloud → key present; local → binary + model on disk).
//!
//! Transcription and voiceover each resolve only the backend selected for them
//! in Settings, without substituting another; a key saved for one never
//! selects the other.
//!
//! Design: `docs/adr/0036-pluggable-speech-backends-normalized-transcript.md`,
//! `docs/adr/0184-voiceover-runs-on-a-selected-provider.md`; `docs/mcp.md`
//! "Speech".

use std::collections::HashMap;

pub mod audio_extract;
pub mod audio_normalize;
pub mod backend;
pub mod backends;
pub mod config;
pub mod error;
pub mod parse;
pub mod split;
pub mod synthesizer;
pub mod transcriber;
pub mod transcript;

pub use backend::SpeechBackend;
pub use config::{availability, Availability, BackendConfig};
pub use error::SpeechError;
// `parse_raw` is the tool-layer chokepoint; `Segment`/`WordTiming` name the
// `transcribe_clip` result envelope. The rest of the transcript/parse
// vocabulary (RawTranscript, TranscriptFormat, TranscriptParser, Transcript,
// Word) is reached via its module path by the backends that produce it.
pub use parse::parse_raw;
pub use synthesizer::{SynthesizeRequest, Synthesizer};
pub use transcriber::{TranscribeRequest, Transcriber};
pub use transcript::{Segment, WordTiming};

/// The languages a transcription model covers, by primary BCP-47 subtag; the
/// host injects them for the selected model from its catalog entry. An engine
/// with none declared is taken to cover every language.
pub type ModelLanguages = HashMap<String, Vec<String>>;

/// The primary subtag of a BCP-47 tag, lowercased (`"en-US"` → `"en"`), or
/// `None` when the tag is not one (2–3 letters, then `-`/`_`-separated
/// alphanumerics).
pub fn primary_language(tag: &str) -> Option<String> {
    let mut parts = tag.split(['-', '_']);
    let primary = parts.next()?;
    let ok = (2..=3).contains(&primary.len())
        && primary.chars().all(|c| c.is_ascii_alphabetic())
        && parts
            .all(|p| !p.is_empty() && p.len() <= 8 && p.chars().all(|c| c.is_ascii_alphanumeric()));
    ok.then(|| primary.to_ascii_lowercase())
}

/// Whether `backend`'s declared languages cover `language` (a primary subtag).
pub fn covers_language(langs: &ModelLanguages, backend: SpeechBackend, language: &str) -> bool {
    langs
        .get(backend.as_str())
        .is_none_or(|l| l.iter().any(|x| x.eq_ignore_ascii_case(language)))
}

/// The refusal of a voiceover call with no provider selected.
pub const NO_VOICEOVER_SELECTED: &str =
    "No voiceover provider is selected. Choose one in Settings → Voiceover.";

/// Why `backend` cannot run right now, in the words a person acts on; `None`
/// when it can.
pub fn unavailable_reason(
    backend: SpeechBackend,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<&'static str> {
    match availability(backend, cfg.get(backend.as_str())) {
        Availability::Available => None,
        Availability::NeedsKey => Some("no API key is set"),
        Availability::NeedsBinary => Some("its binary was not found"),
        Availability::NeedsModel => Some("its model file was not found"),
        Availability::NeedsEndpoint => Some("no endpoint URL is configured"),
    }
}

/// Resolve the model selected in Settings for a call that named no `backend`.
/// Strict (ADR 0036, 0064): the selection is the user's explicit choice, so no
/// other engine is substituted. When it cannot run, the refusal says it is the
/// SELECTED model, what it lacks, and the ways out: repair or reselect it, a
/// ready local engine the caller may name in `backend`, or an uploading engine
/// — only with the user's consent.
pub fn resolve_selected_transcriber(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Result<(SpeechBackend, Box<dyn Transcriber>), String> {
    let preferred = preferred.filter(|b| b.capabilities().transcription);
    if let Some(p) = preferred {
        if unavailable_reason(p, cfg).is_none() {
            if let Some(t) = construct_transcriber(p, cfg.get(p.as_str())) {
                return Ok((p, t));
            }
        }
    }
    let ready = |network: bool| -> Vec<String> {
        SpeechBackend::ALL
            .iter()
            .filter(|b| {
                Some(**b) != preferred
                    && b.capabilities().transcription
                    && b.locality().is_network() == network
                    && unavailable_reason(**b, cfg).is_none()
            })
            .map(|b| format!("`backend: \"{}\"`", b.as_str()))
            .collect()
    };
    let what = match preferred {
        Some(p) => format!(
            "the model selected in Settings → Transcription ({}) cannot run: {}",
            p.as_str(),
            unavailable_reason(p, cfg).unwrap_or("it could not be constructed")
        ),
        None => "no transcription model is selected in Settings → Transcription".to_string(),
    };
    let mut options = vec![format!(
        "ask the user to repair or reselect it — {NO_TRANSCRIBER_CONFIGURED_REMEDY}"
    )];
    let local = ready(false);
    if !local.is_empty() {
        options.push(format!("{} (ready, on this machine)", local.join(" or ")));
    }
    let uploading = ready(true);
    if !uploading.is_empty() {
        options.push(format!(
            "{} (uploads the audio — needs the user's consent)",
            uploading.join(" or ")
        ));
    }
    Err(format!("{what}. Options: {}", options.join("; ")))
}

/// The Settings remedy every "nothing can transcribe" refusal names.
pub const NO_TRANSCRIBER_CONFIGURED_REMEDY: &str =
    "select and prepare a model in Settings → Transcription";

/// STRICT single-backend resolution for an explicit per-call override: build
/// `backend` or error naming exactly what is missing. Never falls back — the
/// caller asked for THIS engine (possibly local-for-privacy), so substituting
/// another (possibly cloud) engine would silently violate that choice. The
/// error text identifies the configuration that needs repair.
pub fn resolve_transcriber_exact(
    backend: SpeechBackend,
    cfg: &HashMap<String, BackendConfig>,
) -> Result<Box<dyn Transcriber>, SpeechError> {
    if !backend.capabilities().transcription {
        return Err(SpeechError::Provider {
            provider: backend,
            message: "backend does not support transcription".into(),
        });
    }
    let entry = cfg.get(backend.as_str());
    match availability(backend, entry) {
        Availability::Available => {
            construct_transcriber(backend, entry).ok_or_else(|| SpeechError::Provider {
                provider: backend,
                // Available but unconstructable = a config-shape hole this
                // module failed to keep in sync; degrade to a clean error.
                message: "backend is configured but could not be constructed".into(),
            })
        }
        Availability::NeedsKey => Err(SpeechError::MissingKey { provider: backend }),
        Availability::NeedsBinary => Err(SpeechError::Provider {
            provider: backend,
            message: "requested explicitly but its binary was not found — set its path in \
                      Settings, or select another model in Settings"
                .into(),
        }),
        Availability::NeedsModel => Err(SpeechError::Provider {
            provider: backend,
            message: "requested explicitly but its model file (for FunASR, also tokens.txt) was \
                      not found — set its path in Settings, or select another model in Settings"
                .into(),
        }),
        Availability::NeedsEndpoint => Err(SpeechError::Provider {
            provider: backend,
            message: "requested explicitly but no endpoint URL is configured — set it on the \
                      model in Settings → Transcription, or select another model"
                .into(),
        }),
    }
}

/// The voiceover provider selected in Settings → Voiceover, strictly (ADR
/// 0184): `None` is refused, and so is a selection that cannot run. Nothing is
/// substituted — a key saved for transcription never picks the voice.
///
/// `model` is the selected profile's model id, for a provider with several
/// (ElevenLabs, which refuses one it does not list); OpenAI runs its one model
/// and ignores it.
pub fn resolve_synthesizer(
    selected: Option<SpeechBackend>,
    model: Option<&str>,
    cfg: &HashMap<String, BackendConfig>,
) -> Result<Box<dyn Synthesizer>, String> {
    let b = selected.ok_or(NO_VOICEOVER_SELECTED)?;
    if !b.capabilities().tts {
        return Err(format!(
            "{} cannot synthesize speech. Choose a voiceover provider in Settings → Voiceover.",
            b.as_str()
        ));
    }
    if let Some(reason) = unavailable_reason(b, cfg) {
        return Err(format!(
            "The voiceover provider selected in Settings → Voiceover ({}) cannot run: {reason}. \
             Add its key there, or choose another provider.",
            b.as_str()
        ));
    }
    construct_synthesizer(b, model, cfg.get(b.as_str()))
}

/// Build the concrete transcriber for an already-selected, `Available` backend.
/// OpenAI and ElevenLabs (cloud), whisper.cpp and FunASR (local sidecars) and
/// the OpenAI-compatible endpoint all have real `impl`s. FunASR additionally
/// requires its `tokens.txt` to be present — the
/// arm only matches `tokens: Some(_)`, mirroring [`availability`] (which reports
/// `NeedsModel` without it), so a tokens-less FunASR config falls to `None`
/// rather than constructing an engine that cannot run. Reaching a `None` arm
/// means a caller hand-built config against a not-yet-runnable engine — we
/// return `None` rather than panic.
fn construct_transcriber(
    b: SpeechBackend,
    cfg: Option<&BackendConfig>,
) -> Option<Box<dyn Transcriber>> {
    match (b, cfg) {
        (SpeechBackend::OpenAi, Some(BackendConfig::ApiKey(key))) => {
            Some(Box::new(backends::openai::OpenAiWhisper::new(key.clone())))
        }
        (SpeechBackend::ElevenLabs, Some(BackendConfig::ApiKey(key))) => {
            Some(Box::new(backends::elevenlabs::ElevenLabs::new(key.clone())))
        }
        (
            SpeechBackend::WhisperCpp,
            Some(BackendConfig::Local {
                binary,
                model,
                device,
                threads,
                // whisper.cpp ignores tokens.
                ..
            }),
        ) => Some(Box::new(backends::whisper_cpp::WhisperCpp::new(
            binary.clone(),
            model.clone(),
            *threads,
            device.clone(),
        ))),
        (
            SpeechBackend::FunAsr,
            Some(BackendConfig::Local {
                binary,
                model,
                tokens: Some(tokens),
                device,
                threads,
            }),
        ) => Some(Box::new(backends::funasr::FunAsr::new(
            binary.clone(),
            model.clone(),
            tokens.clone(),
            *threads,
            device.clone(),
        ))),
        (
            SpeechBackend::ByoEndpoint,
            Some(BackendConfig::Endpoint {
                url,
                api_key,
                model,
                timeout_s,
            }),
        ) => Some(Box::new(backends::endpoint::OpenAiCompatTranscriber::new(
            url.clone(),
            api_key.clone(),
            model.clone(),
            timeout_s.map(std::time::Duration::from_secs),
        ))),
        _ => None,
    }
}

/// TTS counterpart to [`construct_transcriber`], for the backends whose
/// capabilities include `tts`.
fn construct_synthesizer(
    b: SpeechBackend,
    model: Option<&str>,
    cfg: Option<&BackendConfig>,
) -> Result<Box<dyn Synthesizer>, String> {
    match (b, cfg) {
        (SpeechBackend::OpenAi, Some(BackendConfig::ApiKey(key))) => {
            Ok(Box::new(backends::openai::OpenAiTts::new(key.clone())))
        }
        (SpeechBackend::ElevenLabs, Some(BackendConfig::ApiKey(key))) => {
            Ok(Box::new(backends::elevenlabs::ElevenLabsTts::new(
                backends::elevenlabs::ElevenLabs::new(key.clone()),
                model,
            )?))
        }
        _ => Err(format!(
            "{} is configured but could not be constructed",
            b.as_str()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_with(entries: &[(&str, BackendConfig)]) -> HashMap<String, BackendConfig> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn empty_config_resolves_to_none() {
        let cfg = HashMap::new();
        assert!(resolve_selected_transcriber(None, &cfg).is_err());
        assert!(resolve_synthesizer(None, None, &cfg).is_err());
    }

    #[test]
    fn openai_key_resolves_a_transcriber() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        let (b, _) = resolve_selected_transcriber(Some(SpeechBackend::OpenAi), &cfg)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(b, SpeechBackend::OpenAi);
        // Unselected, the cloud engine is an option the refusal names, never a pick.
        let Err(err) = resolve_selected_transcriber(None, &cfg) else {
            panic!("no selection must not upload");
        };
        assert!(
            err.starts_with("no transcription model is selected"),
            "{err}"
        );
        assert!(
            err.contains("`backend: \"openai\"` (uploads the audio — needs the user's consent)"),
            "{err}"
        );
        // The same key serves TTS once OpenAI is the voiceover selection.
        assert!(resolve_synthesizer(Some(SpeechBackend::OpenAi), None, &cfg).is_ok());
    }

    /// An ElevenLabs model the provider's table lists, for the resolutions
    /// that are not about the model.
    const ELEVEN_MODEL: Option<&str> = Some(backends::elevenlabs::TTS_MODELS[0].0);

    fn synth_provider(
        selected: Option<SpeechBackend>,
        cfg: &HashMap<String, BackendConfig>,
    ) -> Result<SpeechBackend, String> {
        resolve_synthesizer(selected, ELEVEN_MODEL, cfg).map(|s| s.facts().provider)
    }

    /// The injected model is the one ElevenLabs runs; it must be one it lists.
    /// OpenAI has one model, whatever is injected.
    #[test]
    fn the_injected_model_picks_the_elevenlabs_model_and_is_checked() {
        let cfg = cfg_with(&[
            ("openai", BackendConfig::ApiKey("sk-x".into())),
            ("elevenlabs", BackendConfig::ApiKey("xi-x".into())),
        ]);
        for (model, cap) in backends::elevenlabs::TTS_MODELS {
            let facts = resolve_synthesizer(Some(SpeechBackend::ElevenLabs), Some(model), &cfg)
                .unwrap_or_else(|e| panic!("{e}"))
                .facts();
            assert_eq!((facts.model, facts.max_chars), (*model, *cap));
        }
        for model in [None, Some("eleven_unknown")] {
            let Err(err) = resolve_synthesizer(Some(SpeechBackend::ElevenLabs), model, &cfg) else {
                panic!("{model:?} was accepted");
            };
            assert!(err.contains("Settings → Voiceover"), "{err}");
        }
        let openai = |model| {
            resolve_synthesizer(Some(SpeechBackend::OpenAi), model, &cfg)
                .unwrap_or_else(|e| panic!("{e}"))
                .facts()
        };
        assert_eq!(openai(None), openai(Some("eleven_v4")));
    }

    /// With both keys saved, voiceover runs the selected provider and only
    /// that one; with none selected, it refuses naming the setting.
    #[test]
    fn voiceover_runs_only_the_selected_provider() {
        let cfg = cfg_with(&[
            ("openai", BackendConfig::ApiKey("sk-x".into())),
            ("elevenlabs", BackendConfig::ApiKey("xi-x".into())),
        ]);
        assert_eq!(
            synth_provider(Some(SpeechBackend::ElevenLabs), &cfg),
            Ok(SpeechBackend::ElevenLabs)
        );
        assert_eq!(
            synth_provider(Some(SpeechBackend::OpenAi), &cfg),
            Ok(SpeechBackend::OpenAi)
        );
        let none = synth_provider(None, &cfg).unwrap_err();
        assert_eq!(none, NO_VOICEOVER_SELECTED);
        assert!(none.contains("Settings → Voiceover"));
    }

    /// A key saved for transcription does not make its provider the voice:
    /// the selection without its own key refuses rather than using another.
    #[test]
    fn a_selection_without_its_key_refuses_instead_of_using_another() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        let err = synth_provider(Some(SpeechBackend::ElevenLabs), &cfg).unwrap_err();
        assert!(
            err.contains("Settings → Voiceover") && err.contains("elevenlabs"),
            "{err}"
        );
        assert!(err.contains("no API key"), "{err}");
        let err = synth_provider(Some(SpeechBackend::WhisperCpp), &cfg).unwrap_err();
        assert!(err.contains("cannot synthesize"), "{err}");
    }

    #[test]
    fn an_elevenlabs_key_resolves_scribe_strictly() {
        let cfg = cfg_with(&[("elevenlabs", BackendConfig::ApiKey("xi-x".into()))]);
        assert!(resolve_transcriber_exact(SpeechBackend::ElevenLabs, &cfg).is_ok());
        let (b, _) = resolve_selected_transcriber(Some(SpeechBackend::ElevenLabs), &cfg)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(b, SpeechBackend::ElevenLabs);
    }

    /// NEW-8: an unavailable selection is refused as the SELECTED model, not
    /// as an explicit request, naming what is missing and the ready engines —
    /// and nothing else runs in its place (ADR 0064).
    #[test]
    fn an_unavailable_selection_refuses_with_its_options_and_substitutes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, model, tokens) = (
            dir.path().join("sherpa"),
            dir.path().join("model.onnx"),
            dir.path().join("tokens.txt"),
        );
        for f in [&bin, &model, &tokens] {
            std::fs::write(f, b"x").unwrap();
        }
        let cfg = cfg_with(&[
            (
                "funasr",
                BackendConfig::Local {
                    binary: bin,
                    model,
                    tokens: Some(tokens),
                    device: None,
                    threads: None,
                },
            ),
            ("openai", BackendConfig::ApiKey("sk-x".into())),
        ]);
        let Err(err) = resolve_selected_transcriber(Some(SpeechBackend::WhisperCpp), &cfg) else {
            panic!("an unavailable selection must not be substituted");
        };
        assert!(
            err.starts_with(
                "the model selected in Settings → Transcription (whisper_cpp) cannot run: its binary was not found"
            ),
            "{err}"
        );
        assert!(!err.contains("requested explicitly"), "{err}");
        assert!(err.contains("repair or reselect"), "{err}");
        assert!(
            err.contains("`backend: \"funasr\"` (ready, on this machine)"),
            "{err}"
        );
        assert!(
            err.contains("`backend: \"openai\"` (uploads the audio"),
            "{err}"
        );
    }

    #[test]
    fn language_tags_reduce_to_their_primary_subtag() {
        assert_eq!(primary_language("en"), Some("en".into()));
        assert_eq!(primary_language("zh-CN"), Some("zh".into()));
        assert_eq!(primary_language("EN_us"), Some("en".into()));
        assert_eq!(primary_language("english"), None);
        assert_eq!(primary_language("e"), None);
        assert_eq!(primary_language("en-"), None);
        let langs: ModelLanguages = [("funasr".to_string(), vec!["zh".to_string()])].into();
        assert!(covers_language(&langs, SpeechBackend::FunAsr, "zh"));
        assert!(!covers_language(&langs, SpeechBackend::FunAsr, "en"));
        assert!(covers_language(&langs, SpeechBackend::WhisperCpp, "en"));
    }

    /// The STRICT counterpart never substitutes: an explicitly-requested but
    /// unconfigured whisper.cpp errors (naming the gap and the omit-`backend`
    /// remedy) even though OpenAI is available and could serve the request.
    #[test]
    fn exact_unavailable_errors_instead_of_falling_back() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        // (`Box<dyn Transcriber>` has no Debug, so no expect_err — destructure.)
        let Err(err) = resolve_transcriber_exact(SpeechBackend::WhisperCpp, &cfg) else {
            panic!("must not substitute OpenAI for an explicit whisper.cpp request");
        };
        let msg = format!("{err}");
        assert!(msg.contains("binary was not found"), "names the gap: {msg}");
        assert!(
            msg.contains("select another model"),
            "names the fallback remedy: {msg}"
        );
    }

    #[test]
    fn exact_available_backend_constructs() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        assert!(resolve_transcriber_exact(SpeechBackend::OpenAi, &cfg).is_ok());
    }

    #[test]
    fn exact_cloud_without_key_is_missing_key() {
        let Err(err) = resolve_transcriber_exact(SpeechBackend::OpenAi, &HashMap::new()) else {
            panic!("no key must not resolve");
        };
        assert!(matches!(err, SpeechError::MissingKey { .. }));
    }

    #[test]
    fn no_provider_message_names_both_remedies() {
        // Acceptance #1: the message the tool layer surfaces when nothing can
        // run must name the Settings remedy.
        let Err(err) = resolve_selected_transcriber(None, &HashMap::new()) else {
            panic!("nothing configured must not resolve");
        };
        assert!(err.contains(NO_TRANSCRIBER_CONFIGURED_REMEDY), "{err}");
        assert!(NO_TRANSCRIBER_CONFIGURED_REMEDY.contains("Settings"));
        assert!(NO_TRANSCRIBER_CONFIGURED_REMEDY.contains("model"));
    }
}
