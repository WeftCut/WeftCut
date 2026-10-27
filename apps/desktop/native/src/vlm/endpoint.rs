//! OpenAI-compatible `/v1/chat/completions` describer — backs the
//! [`ByoEndpoint`](super::backend::VlmBackend::ByoEndpoint) backend.
//! Self-hosted (`llama-server`, vLLM, SGLang) and hosted providers differ only
//! in URL / key / model, so there is ONE impl and no hosted-provider backend of
//! its own: pointing this at `api.openai.com` is the hosted case.
//!
//! Same frame-sampling input as the local sidecar, adapted to the wire by
//! [`build_task_request_body`]; the reply is read by `extract_content` and tagged
//! [`RawDescription::JsonArray`], so the shared parser yields the same
//! `SceneDescription` shape as the local path.
//!
//! Networking is [`inference::http`](crate::inference::http)'s: the pooled
//! client and the retry policy (408 / 429 / 5xx) speech uses too. The timeout is
//! this module's: the model's own `timeout_s` when it sets one, else the same
//! frame-scaled hang guard the local sidecar gets.

use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use reqwest::StatusCode;
use serde_json::{json, Value};

use crate::inference::http::{bearer_auth, parse_retry_after, send_with_retry, shared_client};

use super::backend::VlmBackend;
use super::describer::{
    describe_hang_guard, DescribeRequest, Focus, Language, SceneDescriber, Task, TimedFrame,
};
use super::error::VlmError;
use super::parser::RawDescription;
use super::sidecar::{prompt_for, SUMMARY_TAIL};

/// Describer over an OpenAI-compatible chat-completions endpoint.
pub struct OpenAiCompatDescriber {
    url: String,
    api_key: Option<String>,
    model: String,
    /// Which backend this represents — for error attribution + the result
    /// envelope's `backend` tag.
    provider: VlmBackend,
    /// The model's own per-request ceiling; `None` → [`describe_hang_guard`].
    timeout: Option<Duration>,
}

impl OpenAiCompatDescriber {
    pub fn new(
        url: String,
        api_key: Option<String>,
        model: String,
        provider: VlmBackend,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            url,
            api_key,
            model,
            provider,
            timeout,
        }
    }
}

#[async_trait]
impl SceneDescriber for OpenAiCompatDescriber {
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError> {
        // Read + base64 each frame BEFORE building the body (async fs, sequential
        // — a handful of small JPEGs).
        let mut encoded = Vec::with_capacity(req.frames.len());
        for f in &req.frames {
            let bytes = tokio::fs::read(&f.path).await.map_err(VlmError::Io)?;
            encoded.push(EncodedFrame {
                t_us: f.t_us,
                mime: image_mime(&f.path),
                b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            });
        }
        let body =
            build_task_request_body(&self.model, &encoded, req.focus, &req.language, &req.task);
        let timeout = self
            .timeout
            .unwrap_or_else(|| describe_hang_guard(req.frames.len()));

        let make = || {
            let rb = shared_client().post(&self.url).json(&body);
            match &self.api_key {
                Some(key) => rb.header("Authorization", bearer_auth(key)),
                None => rb,
            }
        };
        let resp = send_with_retry(make, timeout, "VLM endpoint")
            .await
            .map_err(|e| self.network_error(e, timeout))?;
        let status = resp.status();
        if !status.is_success() {
            let retry_after_s = parse_retry_after(&resp);
            let body = resp.text().await.unwrap_or_default();
            return Err(self.map_status(status, retry_after_s, body));
        }
        // The body read is under the same per-request timeout.
        let payload: Value = resp
            .json()
            .await
            .map_err(|e| self.network_error(e, timeout))?;
        let content = extract_content(&payload).ok_or_else(|| VlmError::Provider {
            provider: self.provider,
            message: "response had no choices[0].message.content".into(),
        })?;
        Ok(RawDescription::JsonArray(content))
    }
}

impl OpenAiCompatDescriber {
    /// The final failure status after [`send_with_retry`] has spent its retries.
    fn map_status(&self, status: StatusCode, retry_after_s: Option<u64>, body: String) -> VlmError {
        match status {
            StatusCode::UNAUTHORIZED => VlmError::InvalidKey {
                provider: self.provider,
            },
            StatusCode::TOO_MANY_REQUESTS => VlmError::RateLimited {
                provider: self.provider,
                retry_after_s,
            },
            _ => VlmError::Provider {
                provider: self.provider,
                message: format!("HTTP {status}: {}", body.trim()),
            },
        }
    }

    /// A transport failure. A timeout names the ceiling it hit and where to
    /// raise it — the one network failure the user can fix from Settings.
    fn network_error(&self, e: reqwest::Error, timeout: Duration) -> VlmError {
        if e.is_timeout() {
            VlmError::EndpointTimeout {
                provider: self.provider,
                secs: timeout.as_secs(),
            }
        } else {
            VlmError::Network(e)
        }
    }
}

/// One frame ready for the wire: its window-relative time, image MIME type and
/// base64 bytes.
pub struct EncodedFrame {
    pub t_us: i64,
    pub mime: &'static str,
    pub b64: String,
}

/// The data-URL MIME type for a frame, from its extension. Sampled frames are
/// JPEG; the Settings verification sends a PNG; anything else is labelled JPEG,
/// the format `frame_extract` writes.
fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

/// Generation budget for a request over `n_frames` frames. The model writes a
/// JSON array with up to one segment per frame, so a flat 768 truncated long
/// windows into unparseable JSON; scale with the frame count, floored at the old
/// value and capped where any served model's context still has room.
fn max_tokens_for(n_frames: usize) -> u32 {
    (256 + 64 * n_frames as u32).clamp(768, 4096)
}

/// [`build_task_request_body`] for the timeline task — what the tests pin the
/// wire shape with.
#[cfg(test)]
pub fn build_request_body(
    model: &str,
    frames: &[EncodedFrame],
    focus: Focus,
    language: &Language,
) -> Value {
    build_task_request_body(model, frames, focus, language, &Task::Timeline)
}

/// Build the chat-completions request body: one user message whose `content` is
/// the interleaved [text, image, text, image, …, instruction] parts. The text
/// parts carry the injected `Frame at <t>s:` markers + the task's instruction
/// tail (reusing [`prompt_for`]'s exact wording so cloud/BYO stay faithful to
/// the local path; for a summary, the outline and its rules). Pure so it is
/// unit-testable without a network.
pub fn build_task_request_body(
    model: &str,
    frames: &[EncodedFrame],
    focus: Focus,
    language: &Language,
    task: &Task,
) -> Value {
    // Reuse the local prompt to derive the leading instruction wording; the
    // per-frame markers are emitted as structured parts instead of `<__media__>`.
    let timed: Vec<TimedFrame> = frames
        .iter()
        .map(|f| TimedFrame {
            t_us: f.t_us,
            path: Default::default(),
        })
        .collect();
    let instruction = trailing_instruction(&prompt_for(&timed, focus, language, task));

    let mut content: Vec<Value> = vec![json!({
        "type": "text",
        "text": "You are analyzing frames sampled from a single video clip. Each image is labeled with its timestamp in seconds."
    })];
    for f in frames {
        content.push(json!({ "type": "text", "text": format!("Frame at {:.2}s:", f.t_us as f64 / 1_000_000.0) }));
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", f.mime, f.b64) }
        }));
    }
    content.push(json!({ "type": "text", "text": instruction }));

    json!({
        "model": model,
        "temperature": 0.1,
        "max_tokens": max_tokens_for(frames.len()),
        "messages": [{ "role": "user", "content": content }],
    })
}

/// The instruction tail of the local prompt — everything from the "Return ONLY
/// a JSON array" line onward, or for a summary from the outline onward — reused
/// verbatim so every backend asks for the same output shape.
fn trailing_instruction(prompt: &str) -> String {
    match prompt
        .find(SUMMARY_TAIL)
        .or_else(|| prompt.find("Return ONLY a JSON array"))
    {
        Some(i) => prompt[i..].to_string(),
        None => prompt.to_string(),
    }
}

/// Pull `choices[0].message.content` out of a chat-completions response.
fn extract_content(payload: &Value) -> Option<String> {
    payload
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::http::test_server::serve;

    fn frame(t_us: i64, mime: &'static str, b64: &str) -> EncodedFrame {
        EncodedFrame {
            t_us,
            mime,
            b64: b64.to_string(),
        }
    }

    #[test]
    fn request_body_interleaves_frames_and_carries_the_instruction() {
        let frames = vec![
            frame(0, "image/png", "AAAA"),
            frame(2_500_000, "image/jpeg", "BBBB"),
        ];
        let body = build_request_body("gpt-4o", &frames, Focus::General, &Language::default());
        let content = body["messages"][0]["content"].as_array().unwrap();
        // lead text + (text + image) * 2 + instruction = 6 parts.
        assert_eq!(content.len(), 6);
        assert_eq!(content[1]["text"], "Frame at 0.00s:");
        assert!(content[2]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,AAAA"));
        assert_eq!(content[3]["text"], "Frame at 2.50s:");
        assert!(content[4]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,BBBB"));
        assert!(content.last().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("Return ONLY a JSON array"));
        assert_eq!(body["model"], "gpt-4o");
    }

    #[test]
    fn a_summary_request_sends_the_outline_after_the_frames() {
        let frames = vec![frame(0, "image/jpeg", "AAAA")];
        let task = Task::Summary {
            outline: "[0.0–4.0s] sheep on a hill".into(),
        };
        let body =
            build_task_request_body("m", &frames, Focus::General, &Language::default(), &task);
        let last = body["messages"][0]["content"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(last.starts_with(SUMMARY_TAIL), "{last}");
        assert!(last.contains("sheep on a hill"));
        assert!(last.contains("Return ONLY a JSON object"));
        assert!(!last.contains("JSON array"));
    }

    #[test]
    fn request_body_carries_the_language_rule_to_the_networked_engines() {
        // The proof that `trailing_instruction`'s reuse actually forwards the
        // language: the sidecar's own test pins the line's POSITION, this one
        // pins that the HTTP body ends up with it.
        let frames = vec![frame(0, "image/jpeg", "AAAA")];
        let body = build_request_body(
            "gpt-4o",
            &frames,
            Focus::General,
            &Language::parse(Some("zh-CN")),
        );
        let content = body["messages"][0]["content"].as_array().unwrap();
        let instruction = content.last().unwrap()["text"].as_str().unwrap();
        assert!(instruction.contains("in Simplified Chinese"));
    }

    #[test]
    fn extract_content_reads_first_choice() {
        let payload = json!({
            "choices": [{ "message": { "content": "[{\"t_start\":0}]" } }]
        });
        assert_eq!(
            extract_content(&payload).as_deref(),
            Some("[{\"t_start\":0}]")
        );
        assert_eq!(extract_content(&json!({ "choices": [] })), None);
    }

    #[test]
    fn mime_follows_the_frame_extension() {
        assert_eq!(image_mime(Path::new("f00.jpg")), "image/jpeg");
        assert_eq!(image_mime(Path::new("f00.JPEG")), "image/jpeg");
        assert_eq!(image_mime(Path::new("test.png")), "image/png");
        assert_eq!(image_mime(Path::new("noext")), "image/jpeg");
    }

    #[test]
    fn max_tokens_scale_with_frames_between_the_floor_and_the_cap() {
        assert_eq!(max_tokens_for(1), 768);
        assert_eq!(max_tokens_for(16), 256 + 64 * 16);
        assert_eq!(max_tokens_for(1000), 4096);
        let frames: Vec<_> = (0..16).map(|i| frame(i, "image/jpeg", "A")).collect();
        let body = build_request_body("m", &frames, Focus::General, &Language::default());
        assert_eq!(body["max_tokens"], 256 + 64 * 16);
    }

    const REPLY: &str =
        r#"{"choices":[{"message":{"content":"[{\"t_start\":0,\"t_end\":1,\"text\":\"a\"}]"}}]}"#;

    async fn request_to(url: &str, timeout: Option<Duration>) -> Result<RawDescription, VlmError> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f00.jpg");
        std::fs::write(&path, b"jpeg-bytes").unwrap();
        let d = OpenAiCompatDescriber::new(
            url.into(),
            None,
            "m".into(),
            VlmBackend::ByoEndpoint,
            timeout,
        );
        d.describe(DescribeRequest {
            frames: vec![TimedFrame { t_us: 0, path }],
            focus: Focus::General,
            language: Language::default(),
            task: Task::Timeline,
        })
        .await
    }

    #[tokio::test]
    async fn a_busy_endpoint_is_retried_and_its_jpeg_frames_are_labelled() {
        let server = serve(vec![
            Some((503, "", "loading".into())),
            Some((200, "Content-Type: application/json\r\n", REPLY.into())),
        ])
        .await;
        let raw = request_to(&server.url, None).await.unwrap();
        assert!(matches!(raw, RawDescription::JsonArray(_)));
        assert_eq!(server.hits(), 2);
        assert!(server.requests()[1].contains("data:image/jpeg;base64,"));
    }

    #[tokio::test]
    async fn an_exhausted_rate_limit_keeps_its_retry_after() {
        let limited = || Some((429, "Retry-After: 0\r\n", "slow".to_string()));
        let server = serve(vec![limited(), limited(), limited()]).await;
        let err = request_to(&server.url, None).await.unwrap_err();
        assert!(
            matches!(
                err,
                VlmError::RateLimited {
                    retry_after_s: Some(0),
                    ..
                }
            ),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn a_silent_endpoint_reports_the_timeout_and_where_to_raise_it() {
        let server = serve(vec![None]).await;
        let err = request_to(&server.url, Some(Duration::from_secs(1)))
            .await
            .unwrap_err();
        assert!(
            matches!(err, VlmError::EndpointTimeout { secs: 1, .. }),
            "{err:?}"
        );
        assert!(err.to_string().contains("request timeout"), "{err}");
    }
}
