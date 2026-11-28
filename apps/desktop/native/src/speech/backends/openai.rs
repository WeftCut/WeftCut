//! OpenAI backend — Whisper transcription and tts-1 synthesis. Both surfaces
//! read the same key from `backend::SpeechBackend::OpenAi`; see `speech::backend`
//! for the one-key rationale.

use std::time::Duration;

use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::StatusCode;
use serde::Serialize;
use tokio::fs;

use crate::inference::http::{bearer_auth, parse_retry_after, send_with_retry, shared_client};
use crate::speech::backend::SpeechBackend;
use crate::speech::error::SpeechError;
use crate::speech::parse::RawTranscript;
use crate::speech::synthesizer::{
    check_request, AudioFormat, SynthesizeRequest, SynthesizeResponse, Synthesizer, Voice,
    VoiceoverFacts,
};
use crate::speech::transcriber::{TranscribeRequest, Transcriber};

/// OpenAI's documented Whisper upload cap. Surfacing this as a structured
/// `PayloadTooLarge` error lets the agent narrow `[t_start_us, t_end_us]`
/// rather than crashing into an opaque 413.
pub const WHISPER_MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

const WHISPER_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL: &str = "whisper-1";

/// Per-request ceiling for every OpenAI call (Whisper, tts-1, the models
/// probe). Whisper on a 13-minute 25 MB upload takes ~60s end-to-end; 180s is
/// comfortable headroom without letting a wedged provider freeze the MCP tool
/// indefinitely. The shared client has no timeout of its own
/// (`inference::http`), so this is the whole bound.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// Whisper transcription client. Carries the API key resolved from the
/// in-memory cache at construction time.
pub struct OpenAiWhisper {
    key: String,
}

impl OpenAiWhisper {
    pub fn new(key: String) -> Self {
        Self { key }
    }
}

#[async_trait]
impl Transcriber for OpenAiWhisper {
    /// OpenAI Whisper serves SRT only (`response_format=srt`), so it ignores
    /// `want_word_timing` — the SRT parser interpolates word times downstream
    /// (`Capabilities::exact_word_timing` is `false` for this backend).
    async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError> {
        let bytes = fs::read(&req.audio_path).await?;
        let size = bytes.len() as u64;
        if size > WHISPER_MAX_UPLOAD_BYTES {
            return Err(SpeechError::PayloadTooLarge {
                bytes: size,
                cap: WHISPER_MAX_UPLOAD_BYTES,
            });
        }

        let filename = req
            .audio_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio.wav")
            .to_string();

        let auth = bearer_auth(&self.key);
        let make = || {
            // Rebuild the multipart form each attempt — `Form`/`Part` aren't
            // cleanly cloneable, but the bytes/filename/language are cheap to
            // re-wrap. `bytes.clone()` runs on every attempt (incl. the first);
            // at ≤25 MB per upload that copy is acceptable.
            let file_part = Part::bytes(bytes.clone())
                .file_name(filename.clone())
                .mime_str("audio/wav")
                .expect("audio/wav is a valid mime");
            let mut form = Form::new()
                .text("model", WHISPER_MODEL)
                .text("response_format", "srt")
                .part("file", file_part);
            if let Some(lang) = req.language.as_deref() {
                form = form.text("language", lang.to_string());
            }
            shared_client()
                .post(WHISPER_ENDPOINT)
                .header("Authorization", &auth)
                .multipart(form)
        };
        let response = send_with_retry(make, REQUEST_TIMEOUT, "OpenAI Whisper").await?;
        let response = ok_or_speech_error(response).await?;
        let srt_body = response.text().await?;
        // SRT style: cue-granular, no language tag. The SRT parser derives
        // interpolated word times and leaves `language = None`.
        Ok(RawTranscript::Srt(srt_body))
    }
}

/// Pass a successful response through, or map the final failure (after
/// [`send_with_retry`] has spent its retries) to a [`SpeechError`]. Shared by
/// Whisper and tts-1.
async fn ok_or_speech_error(response: reqwest::Response) -> Result<reqwest::Response, SpeechError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let retry_after_s = parse_retry_after(&response);
    let body_text = response.text().await.unwrap_or_default();
    Err(map_status_to_speech_error(status, retry_after_s, body_text))
}

// ============================================================
// TTS — tts-1
// ============================================================

const TTS_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";

/// tts-1's voiceover facts: OpenAI's documented per-request input cap; it
/// answers the mp3 this client asks for.
const TTS_FACTS: VoiceoverFacts = VoiceoverFacts {
    provider: SpeechBackend::OpenAi,
    model: "tts-1",
    max_chars: 4096,
    format: AudioFormat::Mp3,
};

/// tts-1's voices, `(id, display name)`. Static: OpenAI documents them and
/// every key has all of them.
const TTS_VOICES: &[(&str, &str)] = &[
    ("alloy", "Alloy"),
    ("echo", "Echo"),
    ("fable", "Fable"),
    ("onyx", "Onyx"),
    ("nova", "Nova"),
    ("shimmer", "Shimmer"),
];

/// OpenAI tts-1 client. Carries the API key resolved from the in-memory cache
/// at construction time.
pub struct OpenAiTts {
    key: String,
}

impl OpenAiTts {
    pub fn new(key: String) -> Self {
        Self { key }
    }
}

#[derive(Serialize)]
struct TtsBody<'a> {
    model: &'a str,
    input: &'a str,
    voice: &'a str,
    response_format: &'a str,
}

#[async_trait]
impl Synthesizer for OpenAiTts {
    fn facts(&self) -> VoiceoverFacts {
        TTS_FACTS
    }

    async fn voices(&self) -> Result<Vec<Voice>, SpeechError> {
        Ok(TTS_VOICES
            .iter()
            .map(|(id, name)| Voice {
                id: (*id).to_string(),
                name: (*name).to_string(),
                labels: Default::default(),
                preview_url: None,
            })
            .collect())
    }

    async fn synthesize(&self, req: SynthesizeRequest) -> Result<SynthesizeResponse, SpeechError> {
        check_request(&TTS_FACTS, &req)?;
        // Exact ids, as `voices` lists them: the cache key keeps a voice as
        // given, so accepting `Alloy` would cache one voice under two keys.
        if !TTS_VOICES.iter().any(|(id, _)| *id == req.voice) {
            let ids: Vec<&str> = TTS_VOICES.iter().map(|(id, _)| *id).collect();
            return Err(SpeechError::InvalidInput {
                provider: SpeechBackend::OpenAi,
                message: format!(
                    "OpenAI tts-1 has no voice {:?}; its voices are {} (`list_voices`)",
                    req.voice,
                    ids.join(", "),
                ),
            });
        }

        let body = TtsBody {
            model: TTS_FACTS.model,
            input: &req.text,
            voice: &req.voice,
            response_format: TTS_FACTS.format.extension(),
        };
        let auth = bearer_auth(&self.key);
        let make = || {
            shared_client()
                .post(TTS_ENDPOINT)
                .header("Authorization", &auth)
                .json(&body)
        };
        let response = send_with_retry(make, REQUEST_TIMEOUT, "OpenAI tts-1").await?;
        let response = ok_or_speech_error(response).await?;
        let bytes = response.bytes().await?.to_vec();
        Ok(SynthesizeResponse {
            audio: bytes,
            format: TTS_FACTS.format,
        })
    }
}

// ============================================================
// Shared HTTP-status mapping (Whisper + tts-1)
// ============================================================

fn map_status_to_speech_error(
    status: StatusCode,
    retry_after_s: Option<u64>,
    body_text: String,
) -> SpeechError {
    match status {
        StatusCode::UNAUTHORIZED => SpeechError::InvalidKey {
            provider: SpeechBackend::OpenAi,
        },
        StatusCode::PAYLOAD_TOO_LARGE => SpeechError::PayloadTooLarge {
            // Whisper-shaped arm: `transcribe` pre-checks
            // `WHISPER_MAX_UPLOAD_BYTES`, so landing here means OpenAI
            // tightened the cap or we miscounted. tts-1's text cap is checked
            // before sending, so its 413 is not expected here.
            bytes: 0,
            cap: WHISPER_MAX_UPLOAD_BYTES,
        },
        StatusCode::TOO_MANY_REQUESTS => SpeechError::RateLimited {
            provider: SpeechBackend::OpenAi,
            retry_after_s,
        },
        _ => SpeechError::Provider {
            provider: SpeechBackend::OpenAi,
            message: format!(
                "{} {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                trim_body(&body_text),
            ),
        },
    }
}

pub(crate) fn trim_body(s: &str) -> String {
    const MAX: usize = 400;
    let trimmed = s.trim();
    if trimmed.len() <= MAX {
        trimmed.to_string()
    } else {
        // Cut on a char boundary at or below MAX bytes — a raw `[..MAX]` slice
        // panics when byte 400 lands inside a multi-byte char (e.g. a proxy's
        // Chinese error page).
        let cut = trimmed
            .char_indices()
            .take_while(|(i, _)| *i <= MAX)
            .last()
            .map_or(0, |(i, _)| i);
        format!("{}…", &trimmed[..cut])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_401_to_invalid_key() {
        let err = map_status_to_speech_error(
            StatusCode::UNAUTHORIZED,
            None,
            "{\"error\":{\"message\":\"Invalid Authentication\"}}".into(),
        );
        match err {
            SpeechError::InvalidKey {
                provider: SpeechBackend::OpenAi,
            } => {}
            other => panic!("expected InvalidKey, got {other:?}"),
        }
    }

    #[test]
    fn maps_429_to_rate_limited_with_retry_after() {
        let err = map_status_to_speech_error(
            StatusCode::TOO_MANY_REQUESTS,
            Some(20),
            "rate limit".into(),
        );
        match err {
            SpeechError::RateLimited {
                provider: SpeechBackend::OpenAi,
                retry_after_s: Some(20),
            } => {}
            other => panic!("expected RateLimited(20), got {other:?}"),
        }
    }

    #[test]
    fn maps_413_to_payload_too_large() {
        let err = map_status_to_speech_error(StatusCode::PAYLOAD_TOO_LARGE, None, "too big".into());
        match err {
            SpeechError::PayloadTooLarge { cap, .. } => {
                assert_eq!(cap, WHISPER_MAX_UPLOAD_BYTES);
            }
            other => panic!("expected PayloadTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn maps_500_to_provider_error_with_body() {
        let err =
            map_status_to_speech_error(StatusCode::INTERNAL_SERVER_ERROR, None, "kaboom".into());
        match err {
            SpeechError::Provider {
                provider: SpeechBackend::OpenAi,
                message,
            } => {
                assert!(message.contains("500"), "missing status: {message}");
                assert!(message.contains("kaboom"), "missing body: {message}");
            }
            other => panic!("expected Provider, got {other:?}"),
        }
    }

    fn tts_req(text: &str, voice: &str) -> SynthesizeRequest {
        SynthesizeRequest {
            text: text.into(),
            voice: voice.into(),
        }
    }

    async fn refused(req: SynthesizeRequest) -> String {
        match OpenAiTts::new("test-key".into()).synthesize(req).await {
            Err(SpeechError::InvalidInput { message, .. }) => message,
            other => panic!("expected InvalidInput, got {:?}", other.map(|_| ())),
        }
    }

    #[tokio::test]
    async fn tts_refuses_what_its_facts_rule_out_before_sending() {
        assert!(refused(tts_req("", "alloy")).await.contains("empty"));
        let too_long = "a".repeat(TTS_FACTS.max_chars + 1);
        assert!(refused(tts_req(&too_long, "alloy"))
            .await
            .contains(&format!("at most {}", TTS_FACTS.max_chars)));
    }

    /// Voice ids are exact: a different case is another id, which the cache
    /// would otherwise key apart from the voice it plays.
    #[tokio::test]
    async fn tts_takes_only_the_voice_ids_it_lists() {
        let msg = refused(tts_req("hello", "no-such-voice")).await;
        assert!(
            msg.contains("no voice") && msg.contains("list_voices"),
            "{msg}"
        );
        assert!(refused(tts_req("hello", "Alloy"))
            .await
            .contains("no voice"));
        let voices = OpenAiTts::new("k".into()).voices().await.unwrap();
        let ids: Vec<&str> = voices.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
        assert_eq!(voices[0].name, "Alloy");
    }

    #[test]
    fn trim_body_caps_at_400() {
        let long = "x".repeat(1000);
        let trimmed = trim_body(&long);
        // 400 'x' bytes + '…' (3 bytes in UTF-8).
        assert_eq!(trimmed.chars().count(), 401);
        assert!(trimmed.ends_with('…'));
    }
}
