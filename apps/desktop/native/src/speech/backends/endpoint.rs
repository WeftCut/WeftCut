//! OpenAI-compatible `/v1/audio/transcriptions` transcriber — backs the
//! [`ByoEndpoint`](crate::speech::SpeechBackend::ByoEndpoint) backend.
//! whisper.cpp's `whisper-server` (started with `--inference-path
//! /v1/audio/transcriptions`, or addressed at its own `/inference`), speaches,
//! vLLM, LocalAI and hosted providers share the request shape: a multipart
//! upload of the WAV with `model`, `language` and `response_format`. They
//! differ in which formats they answer, so the format is negotiated:
//!
//! 1. `verbose_json` with `timestamp_granularities[]=word` + `segment` — exact
//!    word times where the server has them ([`RawTranscript::OpenAiVerboseJson`]).
//! 2. If the server rejects it (400 / 415 / 422) or answers something that is
//!    not verbose JSON, `srt` once ([`RawTranscript::Srt`], interpolated words).
//!
//! The format that worked is remembered per URL for the life of the process,
//! so only the first call to a server that lacks `verbose_json` pays twice.
//! An explicit `word_timestamps: false` asks for `srt` directly, the same
//! opt-down every other backend honours.
//!
//! Networking is [`inference::http`](crate::inference::http)'s (pooled client,
//! retry on 408 / 429 / 5xx). The per-request timeout is the model's own
//! `timeout_s` when set, else the local sidecars' audio-scaled hang guard: a
//! self-hosted server on modest hardware is no faster than a local engine.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::StatusCode;

use crate::inference::http::{bearer_auth, parse_retry_after, send_with_retry, shared_client};
use crate::speech::backend::SpeechBackend;
use crate::speech::backends::openai::trim_body;
use crate::speech::backends::sidecar::scaled_timeout;
use crate::speech::error::SpeechError;
use crate::speech::parse::openai_verbose::is_verbose_json;
use crate::speech::parse::{RawTranscript, TranscriptFormat};
use crate::speech::transcriber::{TranscribeRequest, Transcriber};

const PROVIDER: SpeechBackend = SpeechBackend::ByoEndpoint;

/// Transcriber over a user-configured OpenAI-compatible server.
pub struct OpenAiCompatTranscriber {
    url: String,
    /// Sent as `Authorization: Bearer` only when non-blank — a bare `Bearer `
    /// header makes some self-hosted servers refuse a request they would
    /// otherwise accept.
    api_key: Option<String>,
    /// Sent as `model` only when non-blank; whisper-server ignores it.
    model: Option<String>,
    /// The model's own per-request ceiling; `None` → [`scaled_timeout`].
    timeout: Option<Duration>,
}

impl OpenAiCompatTranscriber {
    pub fn new(
        url: String,
        api_key: Option<String>,
        model: Option<String>,
        timeout: Option<Duration>,
    ) -> Self {
        let nonblank = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
        Self {
            url,
            api_key: nonblank(api_key),
            model: nonblank(model),
            timeout,
        }
    }
}

/// The format each server URL answered with, once known.
fn negotiated() -> &'static Mutex<HashMap<String, TranscriptFormat>> {
    static FORMATS: OnceLock<Mutex<HashMap<String, TranscriptFormat>>> = OnceLock::new();
    FORMATS.get_or_init(Default::default)
}

fn remember(url: &str, format: TranscriptFormat) {
    if let Ok(mut known) = negotiated().lock() {
        known.insert(url.to_string(), format);
    }
}

fn known_format(url: &str) -> Option<TranscriptFormat> {
    negotiated().lock().ok()?.get(url).copied()
}

#[async_trait]
impl Transcriber for OpenAiCompatTranscriber {
    async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError> {
        let bytes = tokio::fs::read(&req.audio_path).await?;
        let timeout = match self.timeout {
            Some(t) => t,
            None => scaled_timeout(&req.audio_path).await,
        };
        let filename = req
            .audio_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio.wav")
            .to_string();
        let send = |format| self.send(&bytes, &filename, req.language.as_deref(), format, timeout);

        let first = if req.want_word_timing {
            known_format(&self.url).unwrap_or(TranscriptFormat::OpenAiVerboseJson)
        } else {
            TranscriptFormat::Srt
        };
        let (status, retry_after_s, body) = send(first).await?;
        if first == TranscriptFormat::Srt {
            return if status.is_success() {
                Ok(RawTranscript::Srt(body))
            } else {
                Err(map_status(status, retry_after_s, body, bytes.len()))
            };
        }
        if status.is_success() && is_verbose_json(&body) {
            remember(&self.url, TranscriptFormat::OpenAiVerboseJson);
            return Ok(RawTranscript::OpenAiVerboseJson(body));
        }
        let unsupported = status.is_success()
            || matches!(
                status,
                StatusCode::BAD_REQUEST
                    | StatusCode::UNSUPPORTED_MEDIA_TYPE
                    | StatusCode::UNPROCESSABLE_ENTITY
            );
        if !unsupported {
            return Err(map_status(status, retry_after_s, body, bytes.len()));
        }
        tracing::info!(
            target: "weftcut::speech",
            "transcription endpoint answered {status} to verbose_json; retrying as srt",
        );
        let (status, retry_after_s, body) = send(TranscriptFormat::Srt).await?;
        if !status.is_success() {
            return Err(map_status(status, retry_after_s, body, bytes.len()));
        }
        // Only a format that actually worked is remembered: a 400 for another
        // reason (a bad language code) must not pin this server to SRT.
        remember(&self.url, TranscriptFormat::Srt);
        Ok(RawTranscript::Srt(body))
    }
}

impl OpenAiCompatTranscriber {
    /// One upload (with [`send_with_retry`]'s retries) in `format`, answering
    /// the final status, its `Retry-After` and the body. A transport failure —
    /// the per-request timeout above all — is an error here, not a status.
    async fn send(
        &self,
        bytes: &[u8],
        filename: &str,
        language: Option<&str>,
        format: TranscriptFormat,
        timeout: Duration,
    ) -> Result<(StatusCode, Option<u64>, String), SpeechError> {
        let make = || {
            // Rebuilt per attempt: a multipart body cannot be cloned.
            let file = Part::bytes(bytes.to_vec())
                .file_name(filename.to_string())
                .mime_str("audio/wav")
                .expect("audio/wav is a valid mime");
            let mut form = Form::new().part("file", file);
            if let Some(model) = &self.model {
                form = form.text("model", model.clone());
            }
            if let Some(lang) = language {
                form = form.text("language", lang.to_string());
            }
            form = match format {
                TranscriptFormat::OpenAiVerboseJson => form
                    .text("response_format", "verbose_json")
                    .text("timestamp_granularities[]", "word")
                    .text("timestamp_granularities[]", "segment"),
                _ => form.text("response_format", "srt"),
            };
            let rb = shared_client().post(&self.url).multipart(form);
            match &self.api_key {
                Some(key) => rb.header("Authorization", bearer_auth(key)),
                None => rb,
            }
        };
        let response = send_with_retry(make, timeout, "transcription endpoint")
            .await
            .map_err(|e| network_error(e, timeout))?;
        let status = response.status();
        let retry_after_s = parse_retry_after(&response);
        // The body read is under the same per-request timeout.
        let body = response
            .text()
            .await
            .map_err(|e| network_error(e, timeout))?;
        Ok((status, retry_after_s, body))
    }
}

/// A transport failure. A timeout names the ceiling it hit and where to raise
/// it — the one network failure the user can fix from Settings.
fn network_error(e: reqwest::Error, timeout: Duration) -> SpeechError {
    if e.is_timeout() {
        SpeechError::EndpointTimeout {
            provider: PROVIDER,
            secs: timeout.as_secs(),
        }
    } else {
        SpeechError::Network(e)
    }
}

/// The final failure status (after retries) as a [`SpeechError`].
fn map_status(
    status: StatusCode,
    retry_after_s: Option<u64>,
    body: String,
    upload_bytes: usize,
) -> SpeechError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            SpeechError::InvalidKey { provider: PROVIDER }
        }
        StatusCode::TOO_MANY_REQUESTS => SpeechError::RateLimited {
            provider: PROVIDER,
            retry_after_s,
        },
        StatusCode::PAYLOAD_TOO_LARGE => SpeechError::UploadRefused {
            provider: PROVIDER,
            bytes: upload_bytes as u64,
        },
        _ => SpeechError::Provider {
            provider: PROVIDER,
            message: format!(
                "{} {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                trim_body(&body),
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::http::test_server::{serve, Reply};
    use crate::speech::split::wav_bytes;

    const VERBOSE: &str = r#"{"language":"english","segments":[{"start":0.0,"end":1.0,"text":" hi","words":[{"word":" hi","start":0.1,"end":0.6}]}]}"#;
    const SRT: &str = "1\n00:00:00,000 --> 00:00:01,000\nhi\n";

    fn ok(body: &str) -> Reply {
        Some((200, "", body.to_string()))
    }

    async fn wav() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        tokio::fs::write(&path, wav_bytes(&[0i16; 1600]))
            .await
            .unwrap();
        (dir, path)
    }

    fn req(path: &std::path::Path) -> TranscribeRequest {
        TranscribeRequest {
            audio_path: path.to_path_buf(),
            language: Some("en".into()),
            want_word_timing: true,
        }
    }

    fn engine(url: &str, key: Option<&str>) -> OpenAiCompatTranscriber {
        OpenAiCompatTranscriber::new(
            url.into(),
            key.map(Into::into),
            Some("whisper-large-v3".into()),
            Some(Duration::from_secs(5)),
        )
    }

    #[tokio::test]
    async fn verbose_json_is_asked_for_first_and_kept_when_answered() {
        let server = serve(vec![ok(VERBOSE)]).await;
        let (_d, path) = wav().await;
        let raw = engine(&server.url, Some("sk-x"))
            .transcribe(req(&path))
            .await
            .unwrap();
        assert!(matches!(raw, RawTranscript::OpenAiVerboseJson(_)));
        let sent = &server.requests()[0];
        assert!(sent.contains("verbose_json"));
        assert!(sent.contains("timestamp_granularities[]"));
        assert!(sent.contains("whisper-large-v3"));
        assert!(sent
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-x"));
        assert_eq!(
            known_format(&server.url),
            Some(TranscriptFormat::OpenAiVerboseJson)
        );
    }

    #[tokio::test]
    async fn a_server_without_verbose_json_falls_back_to_srt_once_then_goes_straight_there() {
        let server = serve(vec![
            Some((400, "", "unsupported response_format".into())),
            ok(SRT),
            ok(SRT),
        ])
        .await;
        let (_d, path) = wav().await;
        let e = engine(&server.url, None);
        assert!(matches!(
            e.transcribe(req(&path)).await.unwrap(),
            RawTranscript::Srt(_)
        ));
        assert_eq!(server.hits(), 2);
        // Second call: SRT directly, one request.
        assert!(matches!(
            e.transcribe(req(&path)).await.unwrap(),
            RawTranscript::Srt(_)
        ));
        assert_eq!(server.hits(), 3);
        let third = &server.requests()[2];
        assert!(third.contains("srt") && !third.contains("verbose_json"));
    }

    #[tokio::test]
    async fn a_200_that_is_not_verbose_json_also_falls_back() {
        let server = serve(vec![ok(r#"{"text":"hi"}"#), ok(SRT)]).await;
        let (_d, path) = wav().await;
        let raw = engine(&server.url, None)
            .transcribe(req(&path))
            .await
            .unwrap();
        assert!(matches!(raw, RawTranscript::Srt(_)));
    }

    #[tokio::test]
    async fn no_key_sends_no_authorization_header() {
        let server = serve(vec![ok(VERBOSE)]).await;
        let (_d, path) = wav().await;
        OpenAiCompatTranscriber::new(server.url.clone(), Some("  ".into()), None, None)
            .transcribe(req(&path))
            .await
            .unwrap();
        let sent = server.requests()[0].to_ascii_lowercase();
        assert!(!sent.contains("authorization:"), "{sent}");
        assert!(!sent.contains("name=\"model\""), "blank model is not sent");
    }

    #[tokio::test]
    async fn word_timestamps_false_asks_for_srt_directly() {
        let server = serve(vec![ok(SRT)]).await;
        let (_d, path) = wav().await;
        let mut r = req(&path);
        r.want_word_timing = false;
        let raw = engine(&server.url, None).transcribe(r).await.unwrap();
        assert!(matches!(raw, RawTranscript::Srt(_)));
        assert!(!server.requests()[0].contains("verbose_json"));
        assert_eq!(known_format(&server.url), None, "nothing negotiated");
    }

    #[tokio::test]
    async fn a_413_names_the_refused_upload() {
        let server = serve(vec![Some((413, "", "too big".into()))]).await;
        let (_d, path) = wav().await;
        let err = engine(&server.url, None)
            .transcribe(req(&path))
            .await
            .unwrap_err();
        assert!(matches!(err, SpeechError::UploadRefused { bytes, .. } if bytes > 0));
        assert!(err.to_string().contains("shorter window"));
        assert_eq!(
            server.hits(),
            1,
            "413 is neither retried nor a format problem"
        );
    }

    #[tokio::test]
    async fn auth_and_rate_limits_map_to_their_errors() {
        let server = serve(vec![Some((401, "", "no".into()))]).await;
        let (_d, path) = wav().await;
        let err = engine(&server.url, None)
            .transcribe(req(&path))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            SpeechError::InvalidKey { provider: PROVIDER }
        ));

        let busy = || Some((429, "Retry-After: 0\r\n", "slow".to_string()));
        let server = serve(vec![busy(), busy(), busy()]).await;
        let err = engine(&server.url, None)
            .transcribe(req(&path))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            SpeechError::RateLimited {
                retry_after_s: Some(0),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn a_server_that_never_answers_reports_the_timeout_and_its_remedy() {
        let server = serve(vec![None]).await;
        let (_d, path) = wav().await;
        let e = OpenAiCompatTranscriber::new(
            server.url.clone(),
            None,
            None,
            Some(Duration::from_millis(300)),
        );
        let err = e.transcribe(req(&path)).await.unwrap_err();
        assert!(matches!(err, SpeechError::EndpointTimeout { secs: 0, .. }));
        assert!(err.to_string().contains("request timeout"));
    }
}
