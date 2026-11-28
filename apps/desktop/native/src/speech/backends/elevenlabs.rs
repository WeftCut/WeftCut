//! ElevenLabs backend — Scribe transcription, text-to-speech and the account's
//! voices, all on the one key under the `elevenlabs` tag (ADR 0184).
//!
//! Networking is [`inference::http`](crate::inference::http)'s (pooled client,
//! retry on 408 / 429 / 5xx); every request carries its own timeout.

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};

use crate::inference::http::{parse_retry_after, send_with_retry, shared_client};
use crate::speech::backend::SpeechBackend;
use crate::speech::backends::openai::trim_body;
use crate::speech::error::SpeechError;
use crate::speech::parse::{RawTranscript, TranscriptFormat};
use crate::speech::synthesizer::{
    check_request, AudioFormat, SynthesizeRequest, SynthesizeResponse, Synthesizer, Voice,
    VoiceoverFacts,
};
use crate::speech::transcriber::{TranscribeRequest, Transcriber};

const PROVIDER: SpeechBackend = SpeechBackend::ElevenLabs;
const API_BASE: &str = "https://api.elevenlabs.io";

/// The text-to-speech models a voiceover profile may name, `(model id,
/// per-request character cap)`. Settings → Voiceover lists one entry per model
/// and the host injects its id as `voiceover_model`; an id outside this table
/// is refused.
pub(crate) const TTS_MODELS: &[(&str, usize)] = &[
    ("eleven_v4", 100_000),
    ("eleven_multilingual_v2", 10_000),
    ("eleven_flash_v2_5", 40_000),
];
const TTS_FORMAT: AudioFormat = AudioFormat::Mp3;
/// Must name the same container as `TTS_FORMAT`: the cache path's extension
/// is chosen from the facts before the audio exists.
const TTS_OUTPUT_FORMAT: &str = "mp3_44100_128";
const STT_MODEL: &str = "scribe_v3";

/// The ceiling only stops a wedged request holding the tool, so it grows with
/// the script: each 10 000 characters (about ten minutes of speech) gets this
/// much, well over what synthesizing them takes.
const TTS_TIMEOUT_PER_10K_CHARS: Duration = Duration::from_secs(300);
const VOICES_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounds the `/v2/voices` walk (100 a page) against a server that keeps
/// answering `has_more`.
const MAX_VOICE_PAGES: usize = 50;

/// One client for all three endpoints, carrying the key resolved from the
/// in-memory cache at construction time. Transcribes as is; speaks as an
/// [`ElevenLabsTts`], which adds the model.
pub struct ElevenLabs {
    key: String,
    base: String,
}

impl ElevenLabs {
    pub fn new(key: String) -> Self {
        Self {
            key,
            base: API_BASE.to_string(),
        }
    }

    /// A client against `base` instead of the public API — a loopback test
    /// server.
    #[cfg(test)]
    pub(crate) fn with_base(key: &str, base: &str) -> Self {
        Self {
            key: key.to_string(),
            base: base.trim_end_matches('/').to_string(),
        }
    }

    /// `base` + `segments`, each percent-encoded as one path segment: a voice
    /// id is the agent's string, and a `/` or `?` in it must not retarget a
    /// request that carries the user's key.
    fn url(&self, segments: &[&str]) -> Result<Url, SpeechError> {
        let bad_base = || SpeechError::Provider {
            provider: PROVIDER,
            message: format!("invalid API base URL {:?}", self.base),
        };
        let mut url = Url::parse(&self.base).map_err(|_| bad_base())?;
        url.path_segments_mut()
            .map_err(|_| bad_base())?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    async fn send(
        &self,
        make: impl FnMut() -> reqwest::RequestBuilder,
        timeout: Duration,
        label: &str,
        voice: Option<&str>,
    ) -> Result<reqwest::Response, SpeechError> {
        let response = send_with_retry(make, timeout, label).await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let retry_after_s = parse_retry_after(&response);
        let body = response.text().await.unwrap_or_default();
        Err(map_error(status, retry_after_s, &body, voice))
    }
}

// ============================================================
// Scribe
// ============================================================

/// Per-request ceiling for a Scribe upload: a 120 s floor plus realtime. A
/// piece is at most 24 minutes (`speech::split`), which Scribe transcribes in
/// one parallel pass, so realtime leaves the upload itself ample room.
fn stt_timeout(wav_bytes: usize) -> Duration {
    // 16 kHz mono s16le after a 44-byte header.
    let audio_secs = (wav_bytes.saturating_sub(44) / 32_000) as u64;
    Duration::from_secs(120 + audio_secs)
}

/// The `language_code` Scribe is sent for a primary language subtag, or
/// `None` to let it detect. It takes ISO 639-1 codes and a few ISO 639-3 ones,
/// and refuses one it does not know with a 400 that would fail the whole
/// transcription, so an unlisted three-letter subtag is left out.
fn scribe_language(primary: &str) -> Option<&str> {
    match primary {
        l if l.len() == 2 => Some(l),
        "cmn" => Some("zh"),
        "yue" | "fil" => Some(primary),
        _ => None,
    }
}

#[async_trait]
impl Transcriber for ElevenLabs {
    /// Always word timestamps: Scribe charges nothing for them, so
    /// `want_word_timing` has nothing to opt down to.
    async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError> {
        let bytes = tokio::fs::read(&req.audio_path).await?;
        let timeout = stt_timeout(bytes.len());
        let filename = req
            .audio_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio.wav")
            .to_string();
        let language = req.language.as_deref().and_then(scribe_language);
        let url = self.url(&["v1", "speech-to-text"])?;
        let make = || {
            // Rebuilt per attempt: a multipart body cannot be cloned.
            let file = Part::bytes(bytes.clone())
                .file_name(filename.clone())
                .mime_str("audio/wav")
                .expect("audio/wav is a valid mime");
            let mut form = Form::new()
                .text("model_id", STT_MODEL)
                .text("timestamps_granularity", "word")
                .text("tag_audio_events", "false");
            if let Some(code) = language {
                form = form.text("language_code", code.to_string());
            }
            shared_client()
                .post(url.clone())
                .header("xi-api-key", &self.key)
                .multipart(form.part("file", file))
        };
        let response = self.send(make, timeout, "ElevenLabs Scribe", None).await?;
        Ok(RawTranscript::tagged(
            TranscriptFormat::ElevenLabsJson,
            response.text().await?,
        ))
    }
}

// ============================================================
// Text-to-speech + voices
// ============================================================

/// ElevenLabs as a voiceover provider: the client plus the model the selected
/// voiceover profile names.
pub struct ElevenLabsTts {
    api: ElevenLabs,
    facts: VoiceoverFacts,
}

impl ElevenLabsTts {
    /// `model` is the injected `voiceover_model`, one of [`TTS_MODELS`];
    /// anything else, or none, is refused naming the setting that chooses it.
    pub fn new(api: ElevenLabs, model: Option<&str>) -> Result<Self, String> {
        let model = model.ok_or(
            "No ElevenLabs voiceover model is selected. Choose an ElevenLabs entry in Settings → Voiceover.",
        )?;
        let (model, max_chars) = TTS_MODELS
            .iter()
            .copied()
            .find(|(id, _)| *id == model)
            .ok_or_else(|| {
                format!(
                    "ElevenLabs voiceover model {model:?} is unknown. Choose an ElevenLabs entry in Settings → Voiceover."
                )
            })?;
        Ok(Self {
            api,
            facts: VoiceoverFacts {
                provider: PROVIDER,
                model,
                max_chars,
                format: TTS_FORMAT,
            },
        })
    }
}

/// No `voice_settings` are sent (ADR 0184: voiceover has no speed).
#[derive(Serialize)]
struct TtsBody<'a> {
    text: &'a str,
    model_id: &'a str,
}

#[derive(Deserialize)]
struct VoicesPage {
    #[serde(default)]
    voices: Vec<WireVoice>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct WireVoice {
    voice_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    labels: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(default)]
    preview_url: Option<String>,
    #[serde(default)]
    voice_verification: Option<VoiceVerification>,
}

#[derive(Deserialize)]
struct VoiceVerification {
    #[serde(default)]
    requires_verification: bool,
    #[serde(default)]
    is_verified: bool,
}

impl WireVoice {
    /// A cloned voice awaiting its owner's voice verification is listed but
    /// refused for speech (`voice_access_denied`), so it is no voice to offer.
    fn speakable(&self) -> bool {
        self.voice_verification
            .as_ref()
            .is_none_or(|v| !v.requires_verification || v.is_verified)
    }
}

impl From<WireVoice> for Voice {
    /// The voice's string labels, plus its `category` (premade, cloned, …)
    /// under that key when the labels do not carry one.
    fn from(w: WireVoice) -> Self {
        let mut labels: BTreeMap<String, String> = w
            .labels
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect();
        if let Some(c) = w.category {
            labels.entry("category".into()).or_insert(c);
        }
        Voice {
            name: w.name.unwrap_or_else(|| w.voice_id.clone()),
            id: w.voice_id,
            labels,
            preview_url: w.preview_url.filter(|u| !u.is_empty()),
        }
    }
}

#[async_trait]
impl Synthesizer for ElevenLabsTts {
    fn facts(&self) -> VoiceoverFacts {
        self.facts
    }

    async fn voices(&self) -> Result<Vec<Voice>, SpeechError> {
        let api = &self.api;
        let mut voices = Vec::new();
        let mut token: Option<String> = None;
        for _ in 0..MAX_VOICE_PAGES {
            let mut url = api.url(&["v2", "voices"])?;
            url.query_pairs_mut().append_pair("page_size", "100");
            if let Some(t) = &token {
                url.query_pairs_mut().append_pair("next_page_token", t);
            }
            let make = || {
                shared_client()
                    .get(url.clone())
                    .header("xi-api-key", &api.key)
            };
            let response = api
                .send(make, VOICES_TIMEOUT, "ElevenLabs voices", None)
                .await?;
            let body = response.text().await?;
            let page: VoicesPage =
                serde_json::from_str(&body).map_err(|e| SpeechError::Provider {
                    provider: PROVIDER,
                    message: format!("unreadable voice list: {e}"),
                })?;
            voices.extend(
                page.voices
                    .into_iter()
                    .filter(WireVoice::speakable)
                    .map(Voice::from),
            );
            match page.next_page_token.filter(|t| !t.is_empty()) {
                Some(next) if page.has_more && token.as_ref() != Some(&next) => token = Some(next),
                _ => break,
            }
        }
        Ok(voices)
    }

    async fn synthesize(&self, req: SynthesizeRequest) -> Result<SynthesizeResponse, SpeechError> {
        check_request(&self.facts, &req)?;
        // The API answers an unknown id with `voice_not_found`; only ids that
        // are no path segment at all are refused here.
        if matches!(req.voice.trim(), "" | "." | "..") {
            return Err(SpeechError::InvalidInput {
                provider: PROVIDER,
                message: format!(
                    "voice {:?} is not an ElevenLabs voice id — call `list_voices` for the ids this account has",
                    req.voice
                ),
            });
        }
        let api = &self.api;
        let mut url = api.url(&["v1", "text-to-speech", &req.voice])?;
        url.query_pairs_mut()
            .append_pair("output_format", TTS_OUTPUT_FORMAT);
        let body = TtsBody {
            text: &req.text,
            model_id: self.facts.model,
        };
        let make = || {
            shared_client()
                .post(url.clone())
                .header("xi-api-key", &api.key)
                .json(&body)
        };
        let timeout = TTS_TIMEOUT_PER_10K_CHARS * req.text.chars().count().div_ceil(10_000) as u32;
        let response = api
            .send(make, timeout, "ElevenLabs TTS", Some(&req.voice))
            .await?;
        Ok(SynthesizeResponse {
            audio: response.bytes().await?.to_vec(),
            format: self.facts.format,
        })
    }
}

// ============================================================
// Errors
// ============================================================

/// The `detail` of an ElevenLabs error body: `{type, code, message, status}`,
/// the older `{status, message}` (where `status` is the code), or a 422's
/// validation list `[{loc, msg, type}]`.
struct Detail {
    codes: Vec<String>,
    message: Option<String>,
}

fn detail(body: &str) -> Detail {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let mut d = Detail {
        codes: Vec::new(),
        message: None,
    };
    match v.get("detail") {
        Some(serde_json::Value::Object(o)) => {
            d.codes = ["code", "status", "type"]
                .iter()
                .filter_map(|k| o.get(*k).and_then(|c| c.as_str()).map(str::to_string))
                .collect();
            d.message = o
                .get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string);
        }
        Some(serde_json::Value::Array(items)) => {
            let msgs: Vec<&str> = items
                .iter()
                .filter_map(|i| i.get("msg").and_then(|m| m.as_str()))
                .collect();
            d.message = (!msgs.is_empty()).then(|| msgs.join("; "));
        }
        Some(serde_json::Value::String(s)) => d.message = Some(s.clone()),
        _ => {}
    }
    d
}

/// The final failure (after [`send_with_retry`]'s retries) as a
/// [`SpeechError`]. Only `invalid_api_key` means the key is wrong: a scoped key
/// lacking a permission is also a 401, and its message names the permission.
/// `voice` is the TTS request's id, for its `voice_not_found`.
fn map_error(
    status: StatusCode,
    retry_after_s: Option<u64>,
    body: &str,
    voice: Option<&str>,
) -> SpeechError {
    let d = detail(body);
    let has = |code: &str| d.codes.iter().any(|c| c == code);
    let message = || d.message.clone().unwrap_or_else(|| trim_body(body));
    if has("quota_exceeded")
        || has("insufficient_credits")
        || status == StatusCode::PAYMENT_REQUIRED
    {
        return SpeechError::QuotaExceeded {
            provider: PROVIDER,
            message: message(),
        };
    }
    if has("missing_permissions") || status == StatusCode::FORBIDDEN {
        return SpeechError::PermissionDenied {
            provider: PROVIDER,
            message: message(),
        };
    }
    if let (true, Some(voice)) = (has("voice_access_denied"), voice) {
        return SpeechError::InvalidInput {
            provider: PROVIDER,
            message: format!("ElevenLabs refused voice {voice:?}: {}", message()),
        };
    }
    match (status, voice) {
        // A 401 also carries authorization refusals (a voice, a feature);
        // only `invalid_api_key`, or a 401 with no code at all, is the key.
        (StatusCode::UNAUTHORIZED, _) if has("invalid_api_key") || d.codes.is_empty() => {
            SpeechError::InvalidKey { provider: PROVIDER }
        }
        (StatusCode::NOT_FOUND, Some(voice)) if has("voice_not_found") || d.codes.is_empty() => {
            SpeechError::InvalidInput {
                provider: PROVIDER,
                message: format!(
                    "ElevenLabs has no voice {voice:?} on this account (ids are case-sensitive) — call `list_voices` for the ids it has"
                ),
            }
        }
        (StatusCode::TOO_MANY_REQUESTS, _) => SpeechError::RateLimited {
            provider: PROVIDER,
            retry_after_s,
        },
        _ => SpeechError::Provider {
            provider: PROVIDER,
            message: format!(
                "{} {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                trim_body(&message()),
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::http::test_server::{serve, Reply, TestServer};
    use crate::speech::parse::parse_raw;
    use crate::speech::split::wav_bytes;

    fn ok(body: &str) -> Reply {
        Some((200, "", body.to_string()))
    }

    fn client(server: &TestServer) -> ElevenLabs {
        ElevenLabs::with_base("key-x", server.url.trim_end_matches("/v1/test"))
    }

    fn request_line(raw: &str) -> &str {
        raw.lines().next().unwrap_or_default()
    }

    /// A voiceover client on the first listed model.
    fn speaker(server: &TestServer) -> ElevenLabsTts {
        ElevenLabsTts::new(client(server), Some(TTS_MODELS[0].0)).unwrap()
    }

    fn tts(voice: &str) -> SynthesizeRequest {
        tts_text("Hello there.", voice)
    }

    fn tts_text(text: &str, voice: &str) -> SynthesizeRequest {
        SynthesizeRequest {
            text: text.into(),
            voice: voice.into(),
        }
    }

    /// Each selectable model is the one the request names, and no
    /// `voice_settings` ride along to override the voice's own.
    #[tokio::test]
    async fn tts_posts_the_profiles_model_and_voice_with_the_key_header() {
        let server = serve(TTS_MODELS.iter().map(|_| ok("fake-mp3")).collect()).await;
        for (i, (model, _)) in TTS_MODELS.iter().enumerate() {
            let speaker = ElevenLabsTts::new(client(&server), Some(model)).unwrap();
            assert_eq!(speaker.facts().model, *model);
            let resp = speaker.synthesize(tts("voice-a1")).await.unwrap();
            assert_eq!(resp.audio, b"fake-mp3");
            assert_eq!(resp.format, speaker.facts().format);
            let sent = &server.requests()[i];
            assert_eq!(
                request_line(sent),
                "POST /v1/text-to-speech/voice-a1?output_format=mp3_44100_128 HTTP/1.1"
            );
            assert!(
                sent.to_ascii_lowercase().contains("xi-api-key: key-x"),
                "{sent}"
            );
            assert!(sent.contains(&format!(r#""model_id":"{model}""#)), "{sent}");
            assert!(sent.contains(r#""text":"Hello there.""#), "{sent}");
            assert!(!sent.contains("voice_settings"), "{sent}");
        }
    }

    #[test]
    fn a_model_outside_the_table_or_none_is_refused_naming_the_setting() {
        for model in [None, Some("eleven_unknown"), Some("ELEVEN_V4")] {
            let err = ElevenLabsTts::new(ElevenLabs::new("k".into()), model)
                .err()
                .unwrap_or_else(|| panic!("{model:?} was accepted"));
            assert!(err.contains("Settings → Voiceover"), "{err}");
        }
    }

    /// Each model's own cap, refused before anything is sent.
    #[tokio::test]
    async fn text_over_the_models_cap_is_refused_before_sending() {
        let server = serve(TTS_MODELS.iter().map(|_| ok("fake-mp3")).collect()).await;
        for (model, cap) in TTS_MODELS {
            let speaker = ElevenLabsTts::new(client(&server), Some(model)).unwrap();
            assert_eq!(speaker.facts().max_chars, *cap);
            let err = speaker
                .synthesize(tts_text(&"a".repeat(cap + 1), "voice-a1"))
                .await
                .unwrap_err();
            assert!(err.to_string().contains(&format!("at most {cap}")), "{err}");
            assert!(speaker
                .synthesize(tts_text("  ", "voice-a1"))
                .await
                .is_err());
        }
        assert_eq!(server.hits(), 0);
    }

    #[tokio::test]
    async fn a_voice_id_cannot_leave_its_path_segment() {
        let server = serve(vec![ok("fake-mp3")]).await;
        speaker(&server).synthesize(tts("a/b?c")).await.unwrap();
        assert!(
            request_line(&server.requests()[0])
                .starts_with("POST /v1/text-to-speech/a%2Fb%3Fc?output_format="),
            "{}",
            request_line(&server.requests()[0])
        );
        let err = speaker(&server).synthesize(tts("..")).await.unwrap_err();
        assert!(matches!(err, SpeechError::InvalidInput { .. }), "{err:?}");
        assert_eq!(server.hits(), 1, "a refused id sends nothing");
    }

    #[tokio::test]
    async fn voices_follow_the_page_token_to_the_last_page() {
        let first = r#"{"voices":[
            {"voice_id":"voice-a1","name":"Voice A","category":"premade",
             "labels":{"accent":"neutral","gender":"female"},"preview_url":"https://example.invalid/a.mp3"},
            {"voice_id":"Voice-B2","name":"Voice B","category":"cloned","labels":{},"preview_url":null}],
            "has_more":true,"next_page_token":"page-2"}"#;
        let second = r#"{"voices":[{"voice_id":"voice-c3","name":"Voice C","labels":{"category":"own"}}],
            "has_more":false,"next_page_token":null}"#;
        let server = serve(vec![ok(first), ok(second)]).await;
        let voices = speaker(&server).voices().await.unwrap();
        let ids: Vec<&str> = voices.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["voice-a1", "Voice-B2", "voice-c3"]);
        assert_eq!(voices[0].labels["accent"], "neutral");
        assert_eq!(voices[0].labels["category"], "premade");
        assert_eq!(
            voices[0].preview_url.as_deref(),
            Some("https://example.invalid/a.mp3")
        );
        assert_eq!(voices[1].preview_url, None);
        assert_eq!(voices[2].labels["category"], "own", "a label wins");

        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(
            request_line(&sent[0]),
            "GET /v2/voices?page_size=100 HTTP/1.1"
        );
        assert_eq!(
            request_line(&sent[1]),
            "GET /v2/voices?page_size=100&next_page_token=page-2 HTTP/1.1"
        );
        assert!(sent[1].to_ascii_lowercase().contains("xi-api-key: key-x"));
    }

    #[tokio::test]
    async fn a_voice_awaiting_verification_is_not_offered() {
        let page = r#"{"voices":[
            {"voice_id":"voice-a1","name":"Awaiting","category":"cloned",
             "voice_verification":{"requires_verification":true,"is_verified":false}},
            {"voice_id":"voice-b2","name":"Verified","category":"cloned",
             "voice_verification":{"requires_verification":true,"is_verified":true}},
            {"voice_id":"voice-c3","name":"Premade","category":"premade",
             "voice_verification":{"requires_verification":false,"is_verified":false}}],
            "has_more":false}"#;
        let server = serve(vec![ok(page)]).await;
        let voices = speaker(&server).voices().await.unwrap();
        let ids: Vec<&str> = voices.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["voice-b2", "voice-c3"]);
    }

    #[tokio::test]
    async fn a_page_that_repeats_its_token_ends_the_walk() {
        let page = r#"{"voices":[{"voice_id":"voice-a1","name":"A"}],"has_more":true,"next_page_token":"t"}"#;
        let server = serve(vec![ok(page), ok(page), ok(page)]).await;
        let voices = speaker(&server).voices().await.unwrap();
        assert_eq!(server.hits(), 2);
        assert_eq!(voices.len(), 2);
    }

    async fn wav() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        tokio::fs::write(&path, wav_bytes(&[0i16; 1600]))
            .await
            .unwrap();
        (dir, path)
    }

    fn stt(path: &std::path::Path, language: Option<&str>) -> TranscribeRequest {
        TranscribeRequest {
            audio_path: path.to_path_buf(),
            language: language.map(Into::into),
            want_word_timing: true,
        }
    }

    #[tokio::test]
    async fn scribe_uploads_the_wav_with_word_timestamps_and_no_audio_events() {
        let body = r#"{"language_code":"eng","language_probability":0.9,"text":"Hi there.",
            "words":[{"text":"Hi","start":0.1,"end":0.4,"type":"word"},
                     {"text":" ","start":0.4,"end":0.5,"type":"spacing"},
                     {"text":"there.","start":0.5,"end":0.9,"type":"word"}]}"#;
        let server = serve(vec![ok(body), ok(body)]).await;
        let (_d, path) = wav().await;
        let raw = client(&server)
            .transcribe(stt(&path, Some("zh")))
            .await
            .unwrap();
        let sent = &server.requests()[0];
        assert_eq!(request_line(sent), "POST /v1/speech-to-text HTTP/1.1");
        assert!(sent.to_ascii_lowercase().contains("xi-api-key: key-x"));
        let field =
            |name: &str, value: &str| sent.contains(&format!("name=\"{name}\"\r\n\r\n{value}\r\n"));
        assert!(field("model_id", "scribe_v3"), "{sent}");
        assert!(field("timestamps_granularity", "word"), "{sent}");
        assert!(field("tag_audio_events", "false"), "{sent}");
        assert!(field("language_code", "zh"), "{sent}");
        assert!(sent.contains("name=\"file\"; filename=\"a.wav\""), "{sent}");

        let t = parse_raw(raw).unwrap();
        assert_eq!(t.segments[0].text, "Hi there.");
        assert_eq!(t.language.as_deref(), Some("en"));

        // A subtag Scribe may not know is left for it to detect.
        client(&server)
            .transcribe(stt(&path, Some("xkz")))
            .await
            .unwrap();
        assert!(!server.requests()[1].contains("name=\"language_code\""));
    }

    #[test]
    fn only_codes_scribe_knows_are_sent_as_the_language() {
        assert_eq!(scribe_language("en"), Some("en"));
        assert_eq!(scribe_language("cmn"), Some("zh"));
        assert_eq!(scribe_language("yue"), Some("yue"));
        assert_eq!(scribe_language("xkz"), None);
    }

    #[test]
    fn the_upload_ceiling_grows_with_the_audio() {
        let minute = 44 + 60 * 32_000;
        assert!(stt_timeout(24 * minute) > stt_timeout(minute));
        assert!(stt_timeout(24 * minute) >= Duration::from_secs(24 * 60));
    }

    fn err(status: u16, body: &str, voice: Option<&str>) -> SpeechError {
        map_error(StatusCode::from_u16(status).unwrap(), None, body, voice)
    }

    #[test]
    fn only_an_invalid_key_reads_as_a_wrong_key() {
        assert!(matches!(
            err(
                401,
                r#"{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}"#,
                None
            ),
            SpeechError::InvalidKey { provider: PROVIDER }
        ));
        let scoped = err(
            401,
            r#"{"detail":{"type":"authorization_error","code":"missing_permissions","status":"missing_permissions",
                "message":"The API key you used is missing the permission voices_read to execute this operation.",
                "request_id":"req-0001"}}"#,
            None,
        );
        assert!(
            matches!(scoped, SpeechError::PermissionDenied { .. }),
            "{scoped:?}"
        );
        assert!(scoped.to_string().contains("voices_read"), "{scoped}");
        assert!(matches!(
            err(
                403,
                r#"{"detail":{"status":"forbidden","message":"Not allowed"}}"#,
                None
            ),
            SpeechError::PermissionDenied { .. }
        ));
    }

    #[test]
    fn a_refused_voice_is_the_voice_not_the_key() {
        let refused = err(
            401,
            r#"{"detail":{"type":"authorization_error","code":"voice_access_denied",
                "status":"detected_captcha_voice","message":"This voice requires verification."}}"#,
            Some("voice-a1"),
        );
        match refused {
            SpeechError::InvalidInput { message, .. } => {
                assert!(message.contains("voice-a1"), "{message}");
                assert!(message.contains("requires verification"), "{message}");
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
        let other_refusal = err(
            401,
            r#"{"detail":{"type":"authorization_error","code":"feature_not_available","message":"Not on this plan."}}"#,
            None,
        );
        assert!(
            !matches!(other_refusal, SpeechError::InvalidKey { .. }),
            "{other_refusal:?}"
        );
        assert!(other_refusal.to_string().contains("Not on this plan"));
    }

    #[test]
    fn out_of_credits_is_its_own_refusal_whatever_the_status() {
        for (status, body) in [
            (
                402,
                r#"{"detail":{"code":"insufficient_credits","message":"Not enough credits"}}"#,
            ),
            (
                401,
                r#"{"detail":{"status":"quota_exceeded","message":"Quota exceeded"}}"#,
            ),
            (402, "payment required"),
        ] {
            let e = err(status, body, None);
            assert!(
                matches!(e, SpeechError::QuotaExceeded { .. }),
                "{status}: {e:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_unknown_voice_points_the_caller_at_list_voices() {
        let server = serve(vec![Some((
            404,
            "",
            r#"{"detail":{"status":"voice_not_found","message":"A voice with the voice_id voice-zz was not found."}}"#
                .into(),
        ))])
        .await;
        let e = speaker(&server)
            .synthesize(tts("voice-zz"))
            .await
            .unwrap_err();
        assert!(matches!(e, SpeechError::InvalidInput { .. }), "{e:?}");
        let msg = e.to_string();
        assert!(
            msg.contains("\"voice-zz\"") && msg.contains("list_voices"),
            "{msg}"
        );
    }

    #[test]
    fn other_failures_keep_the_provider_message() {
        let e = err(
            422,
            r#"{"detail":[{"loc":["body","text"],"msg":"field required","type":"missing"}]}"#,
            None,
        );
        assert!(matches!(e, SpeechError::Provider { .. }));
        assert!(e.to_string().contains("422") && e.to_string().contains("field required"));
        assert!(matches!(
            err(429, "{}", None),
            SpeechError::RateLimited { .. }
        ));
    }
}
