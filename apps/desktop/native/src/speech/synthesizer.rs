//! `Synthesizer` capability surface — text in, audio bytes out — and the
//! voiceover facts each provider declares (ADR 0184): its model, voices,
//! per-request character cap, speed range and output format. The Voiceover
//! dialog and the MCP tools read these; no layer above the provider keeps a
//! voice list or a limit.
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

/// The speeds a provider's model applies, `1.0` = its natural pace.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SpeedRange {
    #[serde(serialize_with = "shortest_decimal")]
    pub min: f32,
    #[serde(serialize_with = "shortest_decimal")]
    pub max: f32,
    #[serde(serialize_with = "shortest_decimal")]
    pub default: f32,
}

/// An `f32` as the decimal it was written as: widening `0.7f32` to `f64`
/// prints `0.699999988079071`, and a range read off `list_voices` must accept
/// its own bounds.
fn shortest_decimal<S: Serializer>(v: &f32, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(v.to_string().parse().unwrap_or(f64::from(*v)))
}

/// What a voiceover provider's model is and takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VoiceoverFacts {
    pub provider: SpeechBackend,
    pub model: &'static str,
    /// Per-request cap on `text`, in characters.
    pub max_chars: usize,
    /// `None`: the model ignores speed, so a `speed` is refused rather than
    /// silently dropped.
    pub speed: Option<SpeedRange>,
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
    /// `None` lets the provider use its default without sending the parameter.
    pub speed: Option<f32>,
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
    let who = format!("{:?} {}", facts.provider, facts.model);
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
    match (req.speed, facts.speed) {
        (Some(s), Some(r)) if !(r.min..=r.max).contains(&s) => Err(invalid(format!(
            "speed {s} is outside {who}'s range [{}, {}]",
            r.min, r.max
        ))),
        (Some(_), None) => Err(invalid(format!("{who} has no speed control; omit `speed`"))),
        _ => Ok(()),
    }
}

/// Content address of one synthesis: every input that changes the audio —
/// provider, model, voice id (as given, never case-folded), speed, output
/// format and text — each length-prefixed so no two requests share a key.
///
/// `speed: None` and `Some(1.0)` are different keys on purpose: an omitted
/// parameter is the provider's untouched default, which a provider may shape
/// differently from an explicit 1.0.
pub fn cache_key(facts: &VoiceoverFacts, req: &SynthesizeRequest) -> String {
    let speed = req
        .speed
        .map_or_else(|| "default".to_string(), |s| s.to_string());
    let mut hasher = blake3::Hasher::new();
    for field in [
        facts.provider.as_str(),
        facts.model,
        &req.voice,
        &speed,
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
        speed: Some(SpeedRange {
            min: 0.7,
            max: 1.2,
            default: 1.0,
        }),
        format: AudioFormat::Mp3,
    };

    fn req(text: &str, voice: &str, speed: Option<f32>) -> SynthesizeRequest {
        SynthesizeRequest {
            text: text.into(),
            voice: voice.into(),
            speed,
        }
    }

    #[test]
    fn audio_format_extensions_match_filenames() {
        assert_eq!(AudioFormat::Mp3.extension(), "mp3");
        assert_eq!(AudioFormat::Wav.extension(), "wav");
        assert_eq!(AudioFormat::Opus.extension(), "opus");
        assert_eq!(AudioFormat::Flac.extension(), "flac");
    }

    #[test]
    fn requests_outside_the_facts_are_refused_as_invalid_input() {
        let refused = |r: SynthesizeRequest, facts: &VoiceoverFacts| match check_request(facts, &r)
        {
            Err(SpeechError::InvalidInput { message, .. }) => message,
            other => panic!("expected InvalidInput, got {other:?}"),
        };
        assert!(refused(req("  ", "v", None), &FACTS).contains("empty"));
        assert!(refused(req("12345678901", "v", None), &FACTS).contains("at most 10"));
        // The cap counts characters, not bytes.
        assert!(check_request(&FACTS, &req("你好你好你好你好你好", "v", None)).is_ok());
        assert!(refused(req("hi", "v", Some(1.3)), &FACTS).contains("[0.7, 1.2]"));
        let no_speed = VoiceoverFacts {
            speed: None,
            ..FACTS
        };
        assert!(refused(req("hi", "v", Some(1.0)), &no_speed).contains("omit `speed`"));
        assert!(check_request(&no_speed, &req("hi", "v", None)).is_ok());
        // The bounds themselves are inside the range.
        assert!(check_request(&FACTS, &req("hi", "v", Some(0.7))).is_ok());
        assert!(check_request(&FACTS, &req("hi", "v", Some(1.2))).is_ok());
    }

    #[test]
    fn the_cache_key_separates_every_input_and_keeps_voice_case() {
        let base = cache_key(&FACTS, &req("hello", "voice-a1", None));
        assert_eq!(base, cache_key(&FACTS, &req("hello", "voice-a1", None)));
        let differs = [
            cache_key(
                &VoiceoverFacts {
                    provider: SpeechBackend::OpenAi,
                    ..FACTS
                },
                &req("hello", "voice-a1", None),
            ),
            cache_key(
                &VoiceoverFacts {
                    model: "model-b",
                    ..FACTS
                },
                &req("hello", "voice-a1", None),
            ),
            cache_key(
                &VoiceoverFacts {
                    format: AudioFormat::Wav,
                    ..FACTS
                },
                &req("hello", "voice-a1", None),
            ),
            cache_key(&FACTS, &req("hello", "voice-b2", None)),
            cache_key(&FACTS, &req("hello", "Voice-A1", None)),
            cache_key(&FACTS, &req("hello", "voice-a1", Some(1.0))),
            cache_key(&FACTS, &req("hello!", "voice-a1", None)),
        ];
        for (i, k) in differs.iter().enumerate() {
            assert_ne!(&base, k, "variant {i} shares the base key");
        }
        // A field boundary cannot be moved between voice and text.
        assert_ne!(
            cache_key(&FACTS, &req("b", "a", None)),
            cache_key(&FACTS, &req("", "ab", None))
        );
    }

    #[test]
    fn a_speed_range_serializes_as_the_decimals_it_was_written_as() {
        let json = serde_json::to_string(&FACTS.speed).unwrap();
        assert_eq!(json, r#"{"min":0.7,"max":1.2,"default":1.0}"#);
        assert_eq!(
            serde_json::to_string(&AudioFormat::Mp3).unwrap(),
            r#""mp3""#
        );
    }
}
