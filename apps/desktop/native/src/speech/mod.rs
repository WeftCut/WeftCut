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
//! Transcription resolves only the selected model, without substituting another.
//! Speech synthesis keeps its separate provider-selection policy.
//!
//! Design: `docs/adr/0036-pluggable-speech-backends-normalized-transcript.md`;
//! `docs/mcp.md` "Speech".

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

pub use backend::{Capabilities, Locality, SpeechBackend, DEFAULT_ORDER};
pub use config::{availability, Availability, BackendConfig};
pub use error::SpeechError;
// `parse_raw` is the tool-layer chokepoint; `Segment`/`WordTiming` name the
// `transcribe_clip` result envelope. The rest of the transcript/parse
// vocabulary (RawTranscript, TranscriptFormat, TranscriptParser, Transcript,
// Word) is reached via its module path by the backends that produce it.
pub use parse::parse_raw;
pub use synthesizer::{AudioFormat, SynthesizeRequest, Synthesizer};
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

/// Actionable "nothing can synthesize speech" message. TTS is cloud-only today
/// (no local backend advertises `tts`), so this names just the API-key remedy.
pub const NO_SYNTHESIZER_CONFIGURED: &str =
    "no speech-synthesis backend available — add an OpenAI API key in Settings (local TTS \
     engines are not supported yet)";

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
        DEFAULT_ORDER
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

/// TTS-capable counterpart to [`resolve_transcriber`].
pub fn resolve_synthesizer(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<Box<dyn Synthesizer>> {
    // Synthesis has its own capability; the transcription model is not a TTS choice.
    let chosen = preferred
        .into_iter()
        .chain(DEFAULT_ORDER.iter().copied())
        .find(|b| {
            b.capabilities().tts && availability(*b, cfg.get(b.as_str())) == Availability::Available
        })?;
    construct_synthesizer(chosen, cfg.get(chosen.as_str()))
}

/// Which transcription backend is selected and can run, WITHOUT constructing
/// it — the Settings "which engine is active" (`selected`) marker; `None` when
/// the selected backend is unavailable.
pub fn resolve_selected_transcriber_backend(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<SpeechBackend> {
    select_backend(preferred, cfg, |c| c.transcription)
}

/// Use only the selected backend when it provides the capability and is available.
fn select_backend(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
    wants: impl Fn(Capabilities) -> bool,
) -> Option<SpeechBackend> {
    preferred.filter(|b| {
        wants(b.capabilities()) && availability(*b, cfg.get(b.as_str())) == Availability::Available
    })
}

/// Build the concrete transcriber for an already-selected, `Available` backend.
/// OpenAI (cloud), whisper.cpp and FunASR (local sidecars) and the
/// OpenAI-compatible endpoint all have real `impl`s. FunASR additionally requires its `tokens.txt` to be present — the
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

/// TTS counterpart to [`construct_transcriber`]. Only OpenAI advertises `tts`,
/// so `select_backend` only ever hands this `OpenAi`.
fn construct_synthesizer(
    b: SpeechBackend,
    cfg: Option<&BackendConfig>,
) -> Option<Box<dyn Synthesizer>> {
    match (b, cfg) {
        (SpeechBackend::OpenAi, Some(BackendConfig::ApiKey(key))) => {
            Some(Box::new(backends::openai::OpenAiTts::new(key.clone())))
        }
        _ => None,
    }
}

/// Result of [`probe_backend`] — provider-agnostic shape for the Settings
/// "Test" button. Fields stay shallow so the IPC layer can serde-pass them
/// without per-backend type juggling; the wire shape is frozen — TS Settings
/// parses it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionTestInfo {
    /// The backend tag (`"openai"`, etc.) so the UI can attribute the result
    /// to the right row when multiple backends exist.
    pub provider: String,
    /// One-line success summary for the user (e.g., `"42 models available"`).
    pub summary: String,
}

/// Probe whether a backend can serve requests, for the Settings "Test" button.
/// The availability verdict is conveyed through the `Ok`/`Err` split:
///
/// - **Cloud** — no key in [`BackendConfig::ApiKey`] → `SpeechError::MissingKey`
///   (its message hints Settings); with a key, a live smoke check reports what
///   it found.
/// - **Local** — GUARD: the [`availability`] (file-existence) verdict errors
///   early, naming the missing binary/model (incl. FunASR's tokens), with **no
///   spawn**. Only once the files exist does the engine get a liveness spawn.
/// - **Endpoint** — no URL → an error naming it; with one, a one-second
///   synthetic silence is transcribed (there is no `/models` a whisper-server
///   is guaranteed to serve), so the answer covers URL, key and format.
pub async fn probe_backend(
    backend: SpeechBackend,
    cfg: Option<&BackendConfig>,
) -> Result<ConnectionTestInfo, SpeechError> {
    match backend.locality() {
        Locality::Cloud => {
            let key = match cfg {
                Some(BackendConfig::ApiKey(k)) => k.clone(),
                // Missing or shape-mismatched config → a clean MissingKey.
                _ => return Err(SpeechError::MissingKey { provider: backend }),
            };
            match backend {
                SpeechBackend::OpenAi => {
                    let info = backends::openai::test_connection(&key).await?;
                    Ok(ConnectionTestInfo {
                        provider: backend.as_str().to_string(),
                        summary: format!("{} models available", info.model_count),
                    })
                }
                // No other cloud backend exists yet.
                _ => Err(SpeechError::MissingKey { provider: backend }),
            }
        }
        Locality::Endpoint => {
            let Some(cfg @ BackendConfig::Endpoint { .. }) = cfg else {
                return Err(SpeechError::Provider {
                    provider: backend,
                    message: "no endpoint URL configured — set it in Settings".into(),
                });
            };
            let transcriber =
                construct_transcriber(backend, Some(cfg)).ok_or_else(|| SpeechError::Provider {
                    provider: backend,
                    message: "no endpoint URL configured — set it in Settings".into(),
                })?;
            let dir = tempfile::tempdir()?;
            let wav = dir.path().join("probe.wav");
            tokio::fs::write(&wav, split::wav_bytes(&vec![0i16; 16_000])).await?;
            let raw = transcriber
                .transcribe(TranscribeRequest {
                    audio_path: wav,
                    language: Some("en".into()),
                    want_word_timing: true,
                })
                .await?;
            parse_raw(raw)?;
            Ok(ConnectionTestInfo {
                provider: backend.as_str().to_string(),
                summary: "endpoint answered a transcription request".to_string(),
            })
        }
        Locality::Local => {
            // GUARD: bail on the file-existence verdict BEFORE any spawn, so a
            // missing binary/model reports NeedsBinary/NeedsModel with no child
            // process ever started.
            match availability(backend, cfg) {
                Availability::Available => {}
                Availability::NeedsBinary => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine binary not found — set its path in Settings".into(),
                    })
                }
                Availability::NeedsModel => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine model file not found — set its path in Settings"
                            .into(),
                    })
                }
                // Locality::Local never yields NeedsKey / NeedsEndpoint.
                Availability::NeedsKey | Availability::NeedsEndpoint => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine is not configured".into(),
                    })
                }
            }
            // Available ⇒ both files exist ⇒ the config is `Local`. Extract the
            // binary for the liveness spawn.
            let binary = match cfg {
                Some(BackendConfig::Local { binary, .. }) => binary,
                // Unreachable given Available above; degrade to a clean error.
                _ => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine is not configured".into(),
                    })
                }
            };
            match backend {
                SpeechBackend::WhisperCpp => {
                    // `--help` liveness: exit code is ignored; we only care that
                    // the binary is runnable. 15 s is a generous ceiling for a
                    // help/usage print.
                    let args = [std::ffi::OsString::from("--help")];
                    match backends::sidecar::probe_liveness(
                        binary,
                        &args,
                        std::time::Duration::from_secs(15),
                    )
                    .await
                    {
                        Ok(()) => Ok(ConnectionTestInfo {
                            provider: backend.as_str().to_string(),
                            summary: "whisper.cpp binary responds; model present".to_string(),
                        }),
                        Err(e) => Err(SpeechError::Provider {
                            provider: backend,
                            message: format!("whisper.cpp binary failed to run: {e}"),
                        }),
                    }
                }
                SpeechBackend::FunAsr => {
                    // Same `--help` liveness as whisper.cpp; the availability
                    // guard above already proved binary + model + tokens exist.
                    let args = [std::ffi::OsString::from("--help")];
                    match backends::sidecar::probe_liveness(
                        binary,
                        &args,
                        std::time::Duration::from_secs(15),
                    )
                    .await
                    {
                        Ok(()) => Ok(ConnectionTestInfo {
                            provider: backend.as_str().to_string(),
                            summary: "sherpa-onnx binary responds; model + tokens present"
                                .to_string(),
                        }),
                        Err(e) => Err(SpeechError::Provider {
                            provider: backend,
                            message: format!("sherpa-onnx binary failed to run: {e}"),
                        }),
                    }
                }
                // OpenAI / the endpoint never reach this Local arm.
                _ => Ok(ConnectionTestInfo {
                    provider: backend.as_str().to_string(),
                    summary: "binary and model present".to_string(),
                }),
            }
        }
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
        assert!(resolve_synthesizer(None, &cfg).is_none());
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
        // OpenAI also serves TTS off the same key.
        assert!(resolve_synthesizer(None, &cfg).is_some());
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
        assert!(
            resolve_selected_transcriber_backend(Some(SpeechBackend::WhisperCpp), &cfg).is_none()
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

    #[tokio::test]
    async fn probe_whisper_cpp_with_no_config_reports_needs_binary_without_spawning() {
        // No config at all → availability is NeedsBinary → probe returns the
        // "binary not found" error BEFORE reaching any spawn (there is nothing
        // to spawn, which is the structural guarantee we assert).
        let err = probe_backend(SpeechBackend::WhisperCpp, None)
            .await
            .expect_err("no binary");
        let msg = format!("{err}");
        assert!(msg.contains("binary not found"), "unexpected: {msg}");
    }

    #[tokio::test]
    async fn probe_whisper_cpp_missing_binary_needs_binary_no_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = BackendConfig::Local {
            binary: dir.path().join("whisper-cli"), // does not exist
            model: dir.path().join("ggml.bin"),
            tokens: None,
            device: None,
            threads: None,
        };
        let err = probe_backend(SpeechBackend::WhisperCpp, Some(&cfg))
            .await
            .expect_err("missing binary");
        assert!(format!("{err}").contains("binary not found"));
    }

    #[tokio::test]
    async fn probe_whisper_cpp_binary_present_model_missing_needs_model_no_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("whisper-cli");
        std::fs::write(&binary, b"not a real binary").unwrap();
        let cfg = BackendConfig::Local {
            binary,
            model: dir.path().join("ggml.bin"), // does not exist
            tokens: None,
            device: None,
            threads: None,
        };
        // Model gap is detected by availability() → error before the liveness
        // spawn is ever attempted (so the bogus non-binary file is never run).
        let err = probe_backend(SpeechBackend::WhisperCpp, Some(&cfg))
            .await
            .expect_err("missing model");
        assert!(format!("{err}").contains("model file not found"));
    }

    /// FunASR with a present binary + model but missing tokens reports the
    /// model-bundle gap (tokens → NeedsModel) BEFORE any spawn — the same
    /// no-spawn structural guarantee as whisper.cpp, extended to the tokens file.
    #[tokio::test]
    async fn probe_funasr_binary_and_model_present_tokens_missing_no_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("sherpa-onnx-offline");
        let model = dir.path().join("model.onnx");
        std::fs::write(&binary, b"not a real binary").unwrap();
        std::fs::write(&model, b"\x00").unwrap();
        let cfg = BackendConfig::Local {
            binary,
            model,
            tokens: Some(dir.path().join("tokens.txt")), // does not exist
            device: None,
            threads: None,
        };
        let err = probe_backend(SpeechBackend::FunAsr, Some(&cfg))
            .await
            .expect_err("missing tokens");
        assert!(format!("{err}").contains("model file not found"));
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
