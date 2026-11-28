//! `Synthesizer` capability surface — text in, audio bytes out — and the
//! voiceover facts each provider declares (ADR 0184): its model, voices,
//! per-request character cap and output format. The Voiceover dialog and the
//! MCP tools read these; no layer above the provider keeps a voice list or a
//! limit.
//!
//! Bytes (not paths) on the way out: the `synthesize_speech` tool
//! content-addresses the result, which means it needs the bytes in hand to
//! hash. Letting providers write their own file would force a re-read just
//! to hash, and require each provider to know our cache layout.

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::{Serialize, Serializer};

use super::backend::SpeechBackend;
use super::error::SpeechError;

/// Audio container/codec a provider returns. Decides the cache-file and
/// `Media/Voiceover/` extension, which matter for OS file associations and for
/// the agent inspecting the path (ffmpeg sniffs either way).
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "forward provider surface: both providers produce Mp3, so no non-test code constructs the other formats"
    )
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Wav,
    Opus,
    Flac,
}

impl AudioFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Opus => "opus",
            Self::Flac => "flac",
        }
    }
}

impl Serialize for AudioFormat {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.extension())
    }
}

/// What a voiceover provider's model is and takes. No speed: pace is changed
/// on the placed clip (ADR 0184).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VoiceoverFacts {
    pub provider: SpeechBackend,
    pub model: &'static str,
    /// Per-request cap on `text`, in characters.
    pub max_chars: usize,
    pub format: AudioFormat,
}

/// One voice a provider offers. `id` is what `synthesize_speech { voice }`
/// takes, exactly as listed (ElevenLabs ids are case-sensitive).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Voice {
    pub id: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub preview_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SynthesizeRequest {
    pub text: String,
    /// A voice id from the provider's [`Synthesizer::voices`], as given.
    pub voice: String,
}

#[derive(Debug, Clone)]
pub struct SynthesizeResponse {
    pub audio: Vec<u8>,
    pub format: AudioFormat,
}

#[async_trait]
pub trait Synthesizer: Send + Sync {
    fn facts(&self) -> VoiceoverFacts;
    /// The voices this provider offers the account — static for OpenAI, a
    /// request for ElevenLabs.
    async fn voices(&self) -> Result<Vec<Voice>, SpeechError>;
    async fn synthesize(&self, req: SynthesizeRequest) -> Result<SynthesizeResponse, SpeechError>;
}

/// Refuse what `facts` say the model cannot take — before anything is sent,
/// so the caller hears the limit rather than a provider 400. Voice ids are the
/// provider's to check.
pub fn check_request(facts: &VoiceoverFacts, req: &SynthesizeRequest) -> Result<(), SpeechError> {
    let invalid = |message: String| SpeechError::InvalidInput {
        provider: facts.provider,
        message,
    };
    let who = format!("{} {}", facts.provider, facts.model);
    if req.text.trim().is_empty() {
        return Err(invalid(format!(
            "text is empty; {who} needs words to speak"
        )));
    }
    let chars = req.text.chars().count();
    if chars > facts.max_chars {
        return Err(invalid(format!(
            "text is {chars} characters; {who} takes at most {} per request — split it at paragraph boundaries",
            facts.max_chars
        )));
    }
    Ok(())
}

/// Content address of one synthesis: every input that changes the audio —
/// provider, model, voice id (as given, never case-folded), output format and
/// text — each length-prefixed so no two requests share a key.
pub fn cache_key(facts: &VoiceoverFacts, req: &SynthesizeRequest) -> String {
    let mut hasher = blake3::Hasher::new();
    for field in [
        facts.provider.as_str(),
        facts.model,
        &req.voice,
        facts.format.extension(),
        &req.text,
    ] {
        hasher.update(&(field.len() as u64).to_le_bytes());
        hasher.update(field.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FACTS: VoiceoverFacts = VoiceoverFacts {
        provider: SpeechBackend::ElevenLabs,
        model: "model-a",
        max_chars: 10,
        format: AudioFormat::Mp3,
    };

    fn req(text: &str, voice: &str) -> SynthesizeRequest {
        SynthesizeRequest {
            text: text.into(),
            voice: voice.into(),
        }
    }

    #[test]
    fn audio_format_extensions_match_filenames() {
        assert_eq!(AudioFormat::Mp3.extension(), "mp3");
        assert_eq!(AudioFormat::Wav.extension(), "wav");
        assert_eq!(AudioFormat::Opus.extension(), "opus");
        assert_eq!(AudioFormat::Flac.extension(), "flac");
        assert_eq!(
            serde_json::to_string(&AudioFormat::Mp3).unwrap(),
            r#""mp3""#
        );
    }

    #[test]
    fn requests_outside_the_facts_are_refused_as_invalid_input() {
        let refused = |r: SynthesizeRequest| match check_request(&FACTS, &r) {
            Err(SpeechError::InvalidInput { message, .. }) => message,
            other => panic!("expected InvalidInput, got {other:?}"),
        };
        let at_cap = "a".repeat(FACTS.max_chars);
        assert!(refused(req("  ", "v")).contains("empty"));
        assert!(check_request(&FACTS, &req(&at_cap, "v")).is_ok());
        assert!(refused(req(&format!("{at_cap}a"), "v"))
            .contains(&format!("at most {}", FACTS.max_chars)));
        // The cap counts characters, not bytes.
        assert!(check_request(&FACTS, &req(&"你".repeat(FACTS.max_chars), "v")).is_ok());
    }

    #[test]
    fn the_cache_key_separates_every_input_and_keeps_voice_case() {
        let base = cache_key(&FACTS, &req("hello", "voice-a1"));
        assert_eq!(base, cache_key(&FACTS, &req("hello", "voice-a1")));
        let differs = [
            cache_key(
                &VoiceoverFacts {
                    provider: SpeechBackend::OpenAi,
                    ..FACTS
                },
                &req("hello", "voice-a1"),
            ),
            cache_key(
                &VoiceoverFacts {
                    model: "model-b",
                    ..FACTS
                },
                &req("hello", "voice-a1"),
            ),
            cache_key(
                &VoiceoverFacts {
                    format: AudioFormat::Wav,
                    ..FACTS
                },
                &req("hello", "voice-a1"),
            ),
            cache_key(&FACTS, &req("hello", "voice-b2")),
            cache_key(&FACTS, &req("hello", "Voice-A1")),
            cache_key(&FACTS, &req("hello!", "voice-a1")),
        ];
        for (i, k) in differs.iter().enumerate() {
            assert_ne!(&base, k, "variant {i} shares the base key");
        }
        // A field boundary cannot be moved between voice and text.
        assert_ne!(
            cache_key(&FACTS, &req("b", "a")),
            cache_key(&FACTS, &req("", "ab"))
        );
    }
}
