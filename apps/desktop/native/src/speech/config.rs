//! Per-backend configuration (split by secrecy) and the availability check the
//! resolver uses to decide whether a backend can actually run right now.
//!
//! ADR 0036 "Config splits by secrecy": the OpenAI **key** is secret — it lives
//! in safeStorage, persisted as `cloud_keys.json`. A local engine's **paths**
//! (binary, model) are non-secret and come from a TS-owned config store
//! (`main/speech-config.ts` → `speech_config.json`). Electron main merges both,
//! plus the active endpoint profile, into one `HashMap<String, BackendConfig>`
//! snapshot (keyed by [`SpeechBackend::as_str`]) and injects it into every call
//! that resolves a backend (`speech_config` / `speechConfig` arg, ADR 0148) —
//! nothing is held on `Backend`, so the resolver is stateless like the VLM one.

use std::path::PathBuf;

use super::backend::{Locality, SpeechBackend};

/// One backend's configuration, tagged by locality. Deserializes from the
/// injected wire shape ([`WireConfig`]): `{"kind":"api_key","key":…}`,
/// `{"kind":"local",…}` or `{"kind":"endpoint",…}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(from = "WireConfig")]
pub enum BackendConfig {
    /// A cloud backend's API key (secret), from safeStorage; the persisted
    /// shape is `cloud_keys.json`.
    ApiKey(String),
    /// A local sidecar's on-disk config: the CLI binary + model file, with
    /// optional device / thread hints, from the TS config store.
    Local {
        binary: PathBuf,
        model: PathBuf,
        /// FunASR (sherpa-onnx Paraformer) needs a `tokens.txt` beside the model
        /// (`--tokens=`); it is part of the model bundle. ADDITIVE — whisper.cpp
        /// leaves this `None` and ignores it entirely.
        tokens: Option<PathBuf>,
        device: Option<String>,
        threads: Option<u32>,
    },
    /// An OpenAI-compatible transcription server. `url` is the full
    /// `…/audio/transcriptions` (or whisper-server `/inference`) URL; `model`
    /// is sent when set (whisper-server ignores it); `api_key` is optional and
    /// only ever comes from safeStorage; `timeout_s` overrides the per-request
    /// ceiling (absent → scaled to the audio length like the local sidecars).
    Endpoint {
        url: String,
        api_key: Option<String>,
        model: Option<String>,
        timeout_s: Option<u64>,
    },
}

/// The JSON each injected entry arrives as, internally tagged by `kind` like
/// the VLM `BackendConfig`. A newtype `ApiKey(String)` cannot be internally
/// tagged, so the wire names its key field and converts.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireConfig {
    ApiKey {
        key: String,
    },
    Local {
        binary: PathBuf,
        model: PathBuf,
        #[serde(default)]
        tokens: Option<PathBuf>,
        #[serde(default)]
        device: Option<String>,
        #[serde(default)]
        threads: Option<u32>,
    },
    Endpoint {
        url: String,
        #[serde(default)]
        api_key: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        timeout_s: Option<u64>,
    },
}

impl From<WireConfig> for BackendConfig {
    fn from(wire: WireConfig) -> Self {
        // Blank `model` / `api_key` are absent: no empty `model` field and no
        // bare `Bearer ` header is ever sent to a server that wants neither.
        let nonblank = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
        match wire {
            WireConfig::ApiKey { key } => BackendConfig::ApiKey(key.trim().to_string()),
            WireConfig::Local {
                binary,
                model,
                tokens,
                device,
                threads,
            } => BackendConfig::Local {
                binary,
                model,
                tokens,
                device,
                threads,
            },
            WireConfig::Endpoint {
                url,
                api_key,
                model,
                timeout_s,
            } => BackendConfig::Endpoint {
                url,
                api_key: nonblank(api_key),
                model: nonblank(model),
                timeout_s,
            },
        }
    }
}

/// Whether a backend can run right now, and if not, the single most-actionable
/// missing piece — so the Settings UI and the resolver's error can name the
/// exact gap rather than a generic "not configured".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Ready to use: cloud has a key, or local has both files present.
    Available,
    /// Cloud backend with no API key configured.
    NeedsKey,
    /// Local backend whose CLI binary path does not exist on disk.
    NeedsBinary,
    /// Local backend whose model file path does not exist on disk.
    NeedsModel,
    /// Endpoint backend with no URL configured.
    NeedsEndpoint,
}

/// Decide whether `backend` can run given its (optional) config map entry.
///
/// - **Cloud** → `Available` iff an [`BackendConfig::ApiKey`] entry is present,
///   else `NeedsKey`. (Presence only — an empty string still counts as "a key
///   is set".)
/// - **Local** → `NeedsBinary` if the binary path is missing, then `NeedsModel`
///   if the model path is missing, then — for FunASR only — `NeedsModel` again
///   if its `tokens.txt` is unset/absent (tokens are part of the model bundle,
///   so they reuse `NeedsModel` rather than a new variant), then `Available`.
///   Checks **file existence only**; the liveness spawn is [`super::probe_backend`].
///
/// - **Endpoint** → `Available` iff an [`BackendConfig::Endpoint`] with a
///   non-blank URL is present, else `NeedsEndpoint`. The key never gates it: a
///   self-hosted server usually wants none, and one that does answers 401.
///
/// A config entry whose shape mismatches the backend's locality (e.g. an
/// `ApiKey` filed under a local backend) is treated as "the thing it needs is
/// absent" — a cloud backend reads it as `NeedsKey`, a local one as
/// `NeedsBinary`, an endpoint as `NeedsEndpoint`.
pub fn availability(backend: SpeechBackend, cfg: Option<&BackendConfig>) -> Availability {
    match backend.locality() {
        Locality::Cloud => match cfg {
            Some(BackendConfig::ApiKey(_)) => Availability::Available,
            _ => Availability::NeedsKey,
        },
        Locality::Local => match cfg {
            Some(BackendConfig::Local {
                binary,
                model,
                tokens,
                ..
            }) => {
                if !binary.exists() {
                    Availability::NeedsBinary
                } else if !model.exists()
                    || (backend == SpeechBackend::FunAsr
                        && tokens.as_deref().is_none_or(|t| !t.exists()))
                {
                    // FunASR's tokens file counts as part of its model.
                    Availability::NeedsModel
                } else {
                    Availability::Available
                }
            }
            // No local config (or a mismatched ApiKey): the binary is the first
            // thing missing.
            _ => Availability::NeedsBinary,
        },
        Locality::Endpoint => match cfg {
            Some(BackendConfig::Endpoint { url, .. }) if !url.trim().is_empty() => {
                Availability::Available
            }
            _ => Availability::NeedsEndpoint,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_available_iff_api_key_present() {
        assert_eq!(
            availability(
                SpeechBackend::OpenAi,
                Some(&BackendConfig::ApiKey("sk-x".into()))
            ),
            Availability::Available,
        );
        assert_eq!(
            availability(SpeechBackend::OpenAi, None),
            Availability::NeedsKey,
        );
    }

    #[test]
    fn local_missing_binary_then_model_then_available() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("whisper-cli");
        let model = dir.path().join("ggml-base.bin");

        // Neither file yet → binary is the first gap.
        let cfg = BackendConfig::Local {
            binary: binary.clone(),
            model: model.clone(),
            tokens: None,
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::NeedsBinary,
        );

        // Binary present, model still missing → NeedsModel.
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::NeedsModel,
        );

        // Both present → Available.
        std::fs::write(&model, b"\x00\x01\x02").unwrap();
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::Available,
        );
    }

    #[test]
    fn endpoint_available_iff_url_nonblank_and_key_never_gates_it() {
        let ep = |url: &str, key: Option<&str>| BackendConfig::Endpoint {
            url: url.into(),
            api_key: key.map(Into::into),
            model: None,
            timeout_s: None,
        };
        let b = SpeechBackend::ByoEndpoint;
        assert_eq!(
            availability(b, Some(&ep("http://127.0.0.1:8080/inference", None))),
            Availability::Available,
        );
        assert_eq!(
            availability(b, Some(&ep("https://h/v1/audio/transcriptions", Some("k")))),
            Availability::Available,
        );
        assert_eq!(
            availability(b, Some(&ep("  ", None))),
            Availability::NeedsEndpoint
        );
        assert_eq!(availability(b, None), Availability::NeedsEndpoint);
        // A mismatched shape reads as "no URL".
        assert_eq!(
            availability(b, Some(&BackendConfig::ApiKey("k".into()))),
            Availability::NeedsEndpoint,
        );
    }

    #[test]
    fn local_with_no_config_needs_binary() {
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, None),
            Availability::NeedsBinary,
        );
    }

    /// FunASR additionally requires a `tokens.txt`: with binary + model present
    /// but tokens unset/absent it reports `NeedsModel` (the tokens are part of
    /// the model bundle — no new variant); adding the tokens file → `Available`.
    #[test]
    fn funasr_needs_tokens_after_binary_and_model() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("sherpa-onnx-offline");
        let model = dir.path().join("model.onnx");
        let tokens = dir.path().join("tokens.txt");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        std::fs::write(&model, b"\x00\x01\x02").unwrap();

        // tokens: None → NeedsModel (the bundle is incomplete).
        let cfg_none = BackendConfig::Local {
            binary: binary.clone(),
            model: model.clone(),
            tokens: None,
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::FunAsr, Some(&cfg_none)),
            Availability::NeedsModel,
        );

        // tokens set but the file does not exist yet → still NeedsModel.
        let cfg = BackendConfig::Local {
            binary,
            model,
            tokens: Some(tokens.clone()),
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::FunAsr, Some(&cfg)),
            Availability::NeedsModel,
        );

        // tokens file present → Available.
        std::fs::write(&tokens, b"<blk> 0\n").unwrap();
        assert_eq!(
            availability(SpeechBackend::FunAsr, Some(&cfg)),
            Availability::Available,
        );
    }

    /// whisper.cpp ignores `tokens` entirely: binary + model present with
    /// `tokens: None` is `Available` (the FunASR-only tokens gate must not
    /// regress the whisper path).
    #[test]
    fn whisper_ignores_tokens_and_is_available_without_them() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("whisper-cli");
        let model = dir.path().join("ggml.bin");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        std::fs::write(&model, b"\x00").unwrap();
        let cfg = BackendConfig::Local {
            binary,
            model,
            tokens: None,
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::Available,
        );
    }

    #[test]
    fn the_injected_wire_shape_deserializes_into_each_arm() {
        let map: std::collections::HashMap<String, BackendConfig> =
            serde_json::from_value(serde_json::json!({
                "openai": { "kind": "api_key", "key": " sk-x " },
                "whisper_cpp": { "kind": "local", "binary": "w", "model": "m", "threads": 4 },
                "funasr": { "kind": "local", "binary": "s", "model": "p", "tokens": "t",
                            "device": "cpu" },
                "byo_endpoint": { "kind": "endpoint", "url": "http://h/v1/audio/transcriptions",
                                  "api_key": "", "model": " ", "timeout_s": 900 },
            }))
            .unwrap();
        assert_eq!(map["openai"], BackendConfig::ApiKey("sk-x".into()));
        assert_eq!(
            map["whisper_cpp"],
            BackendConfig::Local {
                binary: "w".into(),
                model: "m".into(),
                tokens: None,
                device: None,
                threads: Some(4),
            }
        );
        assert_eq!(
            map["funasr"],
            BackendConfig::Local {
                binary: "s".into(),
                model: "p".into(),
                tokens: Some("t".into()),
                device: Some("cpu".into()),
                threads: None,
            }
        );
        // Blank key and model are absent, never sent.
        assert_eq!(
            map["byo_endpoint"],
            BackendConfig::Endpoint {
                url: "http://h/v1/audio/transcriptions".into(),
                api_key: None,
                model: None,
                timeout_s: Some(900),
            }
        );
    }
}
