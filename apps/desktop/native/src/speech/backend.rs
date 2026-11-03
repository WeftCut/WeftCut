//! The speech-backend catalog: the enum of engines we know how to drive, their
//! locality (cloud vs local sidecar), capability surfaces, and the default
//! order the resolver falls back through. The string tags are a wire + on-disk
//! HARD CONSTRAINT — see [`SpeechBackend::as_str`].
//!
//! Config material (the API key, or a local engine's binary/model paths) lives
//! in [`super::config`]; this module is only the backend identity + its static
//! facts. Selection + availability is [`super::resolve_transcriber`] /
//! [`super::config::availability`].

use serde::{Deserialize, Serialize};

/// Speech engines WeftCut can drive. `OpenAi` is a cloud HTTP API; `WhisperCpp`
/// and `FunAsr` are local one-shot CLI sidecars (transcription only, needing a
/// binary + model on disk); `ByoEndpoint` is any OpenAI-compatible
/// `/v1/audio/transcriptions` server the user points us at.
///
/// The serde tag (`"open-ai"`, from `rename_all = "kebab-case"`) is deliberately
/// distinct from the stable map/wire tag [`SpeechBackend::as_str`] (`"openai"`);
/// callers key the config map and IPC by `as_str`, never by the serde form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpeechBackend {
    /// OpenAI cloud API.
    OpenAi,
    /// whisper.cpp — local offline transcription CLI (STT only).
    WhisperCpp,
    /// FunASR Paraformer via the sherpa-onnx offline CLI (STT only).
    FunAsr,
    /// Any OpenAI-compatible transcription server — whisper.cpp's
    /// `whisper-server`, speaches, vLLM, LocalAI, or a hosted provider — at a
    /// URL the user gives (STT only). Its own backend rather than a URL on
    /// `OpenAi`: that tag is a wire constraint and TTS shares its key, while
    /// this one carries its own URL, model, optional key and timeout (ADR 0036).
    ByoEndpoint,
}

/// Where a backend runs. Drives the availability check: a cloud backend needs
/// an API key; a local backend needs its binary + model file present; an
/// endpoint needs a URL (its key is optional — a self-hosted server usually
/// wants none).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locality {
    Cloud,
    Local,
    Endpoint,
}

impl Locality {
    /// Whether the audio leaves the machine over HTTP — the engines whose
    /// request has an upload size and a network timeout to respect, and so the
    /// ones a long clip is split for (`speech::split`).
    pub fn is_network(self) -> bool {
        matches!(self, Locality::Cloud | Locality::Endpoint)
    }
}

/// The order speech synthesis walks after honoring the caller's `preferred`
/// hint, and the order of [`SpeechBackend::all`]. Transcription does not walk
/// it: it runs only the selected model (selection is strict). OpenAI leads:
/// with both a key and a local engine configured and no preference set, cloud
/// wins — it needs no local model download and its quality is the known
/// baseline. The user's own endpoint comes last.
pub const DEFAULT_ORDER: &[SpeechBackend] = &[
    SpeechBackend::OpenAi,
    SpeechBackend::WhisperCpp,
    SpeechBackend::FunAsr,
    SpeechBackend::ByoEndpoint,
];

impl SpeechBackend {
    /// Stable string tag — the injected `speech_config` map key AND the TS/napi
    /// wire contract.
    ///
    /// HARD CONSTRAINT: `OpenAi` MUST stay `"openai"`. That exact string is the
    /// key's safeStorage tag the host builds the `openai` entry from, the Settings
    /// status command's `provider` field, and the key format persisted in
    /// `cloud_keys.json`. New backends use `"whisper_cpp"` / `"funasr"` /
    /// `"byo_endpoint"` (the same tag as the video-understanding endpoint; the
    /// two config maps are separate, so they never meet).
    pub fn as_str(self) -> &'static str {
        match self {
            SpeechBackend::OpenAi => "openai",
            SpeechBackend::WhisperCpp => "whisper_cpp",
            SpeechBackend::FunAsr => "funasr",
            SpeechBackend::ByoEndpoint => "byo_endpoint",
        }
    }

    /// Human-facing label for the Settings row / Test button.
    pub fn label(self) -> &'static str {
        match self {
            SpeechBackend::OpenAi => "OpenAI (Whisper)",
            SpeechBackend::WhisperCpp => "whisper.cpp (local)",
            SpeechBackend::FunAsr => "FunASR (local)",
            SpeechBackend::ByoEndpoint => "OpenAI-compatible endpoint",
        }
    }

    /// Every backend we know about, in the default resolution order.
    pub fn all() -> &'static [SpeechBackend] {
        DEFAULT_ORDER
    }

    /// Cloud (HTTP, key-gated) vs Local (spawned CLI, file-gated) vs Endpoint
    /// (HTTP, URL-gated).
    pub fn locality(self) -> Locality {
        match self {
            SpeechBackend::OpenAi => Locality::Cloud,
            SpeechBackend::WhisperCpp | SpeechBackend::FunAsr => Locality::Local,
            SpeechBackend::ByoEndpoint => Locality::Endpoint,
        }
    }

    /// Which capability surfaces this backend can serve. The resolver walks
    /// [`DEFAULT_ORDER`], filters by the requested capability, requires
    /// `availability == Available`, and returns the first match — so a single
    /// OpenAI key still activates both transcription and TTS with no per-surface
    /// configuration on the user side.
    pub fn capabilities(self) -> Capabilities {
        match self {
            SpeechBackend::OpenAi => Capabilities {
                transcription: true,
                tts: true,
                // response_format=srt only — word times are interpolated
                // downstream, never engine-exact.
                exact_word_timing: false,
            },
            SpeechBackend::WhisperCpp => Capabilities {
                transcription: true,
                tts: false,
                exact_word_timing: true, // -ojf per-token offsets
            },
            SpeechBackend::FunAsr => Capabilities {
                transcription: true,
                tts: false,
                exact_word_timing: true, // per-token (per-character) timestamps
            },
            SpeechBackend::ByoEndpoint => Capabilities {
                transcription: true,
                tts: false,
                // Depends on the server: `verbose_json` with word timestamps
                // is exact, an SRT fallback is not. The static badge promises
                // only what every server gives; each transcript's own
                // `word_timing` reports what actually came back.
                exact_word_timing: false,
            },
        }
    }
}

/// Per-backend declaration of which capability surfaces are reachable through
/// it. A transcription-only local engine is `transcription: true, tts: false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub transcription: bool,
    pub tts: bool,
    /// Whether the engine reports per-word/token timestamps itself
    /// (`WordTiming::Exact`), as opposed to word times interpolated from cue
    /// spans. A static fact of the engine's output format — shown as a badge
    /// in Settings so users choosing an engine can see it.
    pub exact_word_timing: bool,
}

impl crate::inference::EngineTag for SpeechBackend {
    fn catalog() -> &'static [Self] {
        Self::all()
    }
    fn wire_tag(self) -> &'static str {
        self.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_tags_are_stable() {
        // Wire/on-disk contract — must never drift.
        assert_eq!(SpeechBackend::OpenAi.as_str(), "openai");
        assert_eq!(SpeechBackend::WhisperCpp.as_str(), "whisper_cpp");
        assert_eq!(SpeechBackend::FunAsr.as_str(), "funasr");
        assert_eq!(SpeechBackend::ByoEndpoint.as_str(), "byo_endpoint");
    }

    #[test]
    fn openai_backend_supports_both_surfaces_and_is_cloud() {
        let caps = SpeechBackend::OpenAi.capabilities();
        assert!(caps.transcription);
        assert!(caps.tts);
        // SRT-only → word times are interpolated, never engine-exact.
        assert!(!caps.exact_word_timing);
        assert_eq!(SpeechBackend::OpenAi.locality(), Locality::Cloud);
    }

    #[test]
    fn local_backends_are_transcription_only_and_local() {
        for b in [SpeechBackend::WhisperCpp, SpeechBackend::FunAsr] {
            let caps = b.capabilities();
            assert!(caps.transcription, "{b:?} should transcribe");
            assert!(!caps.tts, "{b:?} has no TTS");
            assert!(
                caps.exact_word_timing,
                "{b:?} reports engine-exact word times"
            );
            assert_eq!(b.locality(), Locality::Local, "{b:?} is local");
        }
    }

    #[test]
    fn endpoint_backend_transcribes_only_over_the_network() {
        let b = SpeechBackend::ByoEndpoint;
        assert_eq!(b.as_str(), "byo_endpoint");
        assert_eq!(b.locality(), Locality::Endpoint);
        assert!(b.locality().is_network());
        assert!(!Locality::Local.is_network());
        let caps = b.capabilities();
        assert!(caps.transcription && !caps.tts && !caps.exact_word_timing);
        // Last in the walk: never a substitute for a configured engine.
        assert_eq!(DEFAULT_ORDER.last(), Some(&b));
    }

    #[test]
    fn default_order_leads_with_openai() {
        assert_eq!(DEFAULT_ORDER.first(), Some(&SpeechBackend::OpenAi));
        assert_eq!(SpeechBackend::all(), DEFAULT_ORDER);
    }
}
