//! Shared error type for every speech backend — cloud HTTP providers and local
//! CLI sidecars alike — so the MCP tool layer can render a single,
//! agent-friendly error shape regardless of which engine served the request.
//!
//! The `From<reqwest::Error>` and `From<std::io::Error>` derives let provider
//! impls use `?` without manual mapping; everything else (auth, payload, rate
//! limits) needs an explicit constructor so the provider sees the failure mode.

use super::backend::SpeechBackend;

#[derive(Debug, thiserror::Error)]
pub enum SpeechError {
    #[error("no API key configured for {provider:?}; configure it in Settings → Transcription")]
    MissingKey { provider: SpeechBackend },

    #[error("{provider:?} rejected the API key (401 unauthorized)")]
    InvalidKey { provider: SpeechBackend },

    #[error("{provider:?} is rate-limited{}", retry_after_s.map(|s| format!(" (retry after {s}s)")).unwrap_or_default())]
    RateLimited {
        provider: SpeechBackend,
        retry_after_s: Option<u64>,
    },

    #[error("audio payload is {bytes} bytes; provider cap is {cap} bytes — narrow the [in_us, out_us] window")]
    PayloadTooLarge { bytes: u64, cap: u64 },

    /// An OpenAI-compatible server refused the upload with 413. Unlike
    /// [`Self::PayloadTooLarge`] the cap is the server's own and unknown here,
    /// so the message names the size that was refused and the remedy.
    #[error("{provider:?} refused the {bytes}-byte audio upload as too large (413) — transcribe a shorter window, or raise the server's upload limit")]
    UploadRefused { provider: SpeechBackend, bytes: u64 },

    /// The endpoint took the whole per-request timeout. Its own variant, not a
    /// `Network` error, because the remedy is the user's to apply: a slow
    /// self-hosted server needs a longer timeout on its model (#69).
    #[error("{provider:?} did not answer within {secs}s — raise the model's request timeout in Settings → Transcription, or transcribe a shorter window")]
    EndpointTimeout { provider: SpeechBackend, secs: u64 },

    #[error("{provider:?} returned an error: {message}")]
    Provider {
        provider: SpeechBackend,
        message: String,
    },

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[cfg_attr(
        not(feature = "test-noop"),
        expect(
            dead_code,
            reason = "reserved speech-pipeline error shape; audio-extract failures currently surface through Io/Provider"
        )
    )]
    #[error("audio extraction failed: {0}")]
    AudioExtract(String),

    #[error("failed to parse transcript: {0}")]
    Parse(String),

    // ── Local CLI-sidecar failures (whisper.cpp / FunASR); ADR 0036 ─────────
    #[error("failed to spawn speech engine {program}: {cause}")]
    Spawn { program: String, cause: String },

    #[error("speech engine exited with {}: {stderr}", code.map(|c| format!("code {c}")).unwrap_or_else(|| "a signal".into()))]
    EngineExit { code: Option<i32>, stderr: String },

    #[error("speech engine timed out after {secs}s")]
    Timeout { secs: u64 },
}

/// The shared local-engine child's failures, in this subsystem's words.
impl From<crate::inference::sidecar::SidecarFailure> for SpeechError {
    fn from(f: crate::inference::sidecar::SidecarFailure) -> Self {
        use crate::inference::sidecar::SidecarFailure as F;
        match f {
            F::Io(e) => Self::Io(e),
            F::Spawn { program, cause } => Self::Spawn { program, cause },
            F::Timeout { secs } => Self::Timeout { secs },
            F::Exit { code, stderr } => Self::EngineExit { code, stderr },
        }
    }
}
