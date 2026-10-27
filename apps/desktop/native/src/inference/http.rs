//! Shared `reqwest::Client`, auth header and retry loop for every networked
//! inference backend — OpenAI Whisper / TTS and the OpenAI-compatible
//! describer alike.
//!
//! The client carries NO request timeout of its own: a 25 MB Whisper upload, a
//! dozen frames on a slow self-hosted VLM and a `GET /v1/models` probe want
//! very different ceilings, and one process-wide value made a slow intranet
//! server time out where a local engine of the same model would not (#69).
//! Each caller passes its own to [`send_with_retry`] (or sets
//! `RequestBuilder::timeout` itself); only the connect timeout is shared,
//! because an unreachable host is unreachable whatever the payload.
//!
//! [`send_with_retry`] owns the retry policy (408 / 429 / 5xx with backoff,
//! bounded by [`MAX_RETRY_ATTEMPTS`] and [`RETRY_TOTAL_BUDGET`]) so every
//! backend retries the same way; mapping the final status to an error stays
//! the caller's job, since each subsystem has its own error type.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use reqwest::{Client, RequestBuilder, Response, StatusCode};

/// How long to wait for a TCP + TLS connection. Separate from the per-request
/// timeout: a host that is down should fail in seconds, even when the request,
/// once connected, may legitimately run for many minutes.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Process-global HTTP client. `reqwest::Client` is cheap to clone and pools
/// connections internally, so a single static instance is the right shape.
pub fn shared_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!("weftcut/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .expect("reqwest::Client::build with rustls-tls cannot fail")
    })
}

/// Build the `Authorization: Bearer <key>` header value. The caller resolves
/// the key from the in-memory cache (missing-key handling lives at the call
/// site / picker, which returns its subsystem's missing-key error cleanly).
pub fn bearer_auth(key: &str) -> String {
    format!("Bearer {key}")
}

/// Maximum attempts per request (1 initial + 2 retries = up to 3 sends).
/// Beyond this the loop returns the last response rather than burning more time.
pub const MAX_RETRY_ATTEMPTS: u32 = 3;

/// Ceiling on the whole retry sequence: before scheduling another attempt the
/// loop checks elapsed-since-first-send plus the proposed delay against this.
/// NOT a tail-latency cap on one wedged attempt — the per-request timeout
/// bounds that.
pub const RETRY_TOTAL_BUDGET: Duration = Duration::from_secs(45);

/// `Retry-After`-header cap. Providers sometimes return large values during
/// outage windows; we'd rather fail fast than block the agent for minutes.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(10);

/// Send the request `make` builds, retrying transient statuses, each attempt
/// bounded by `timeout`. `make` runs once per attempt because a multipart body
/// cannot be cloned. `label` names the provider in the retry log line.
///
/// Returns the final response — a success, or the permanent / retries-exhausted
/// failure — so the caller maps the status to its own error type (it can still
/// read `Retry-After` off it with [`parse_retry_after`]). A transport failure,
/// including the per-request timeout (`reqwest::Error::is_timeout`), is NOT
/// retried and comes back as `Err`: a server that took the whole timeout once
/// will most likely take it again, and the caller's job is waiting on it.
pub async fn send_with_retry(
    mut make: impl FnMut() -> RequestBuilder,
    timeout: Duration,
    label: &str,
) -> Result<Response, reqwest::Error> {
    let started = Instant::now();
    let mut attempt: u32 = 0;
    loop {
        let response = make().timeout(timeout).send().await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let Some(delay) = next_retry_delay(status, &response, attempt, started) else {
            return Ok(response);
        };
        tracing::warn!(
            target: "weftcut::inference",
            "{label} {status} (attempt {attempt}); retrying in {delay:?}",
        );
        drop(response);
        tokio::time::sleep(delay).await;
        attempt += 1;
    }
}

/// The delay before the next attempt, or `None` when the failure is permanent,
/// the attempts are spent, or the delay would overrun [`RETRY_TOTAL_BUDGET`].
fn next_retry_delay(
    status: StatusCode,
    response: &Response,
    attempt: u32,
    started: Instant,
) -> Option<Duration> {
    if attempt + 1 >= MAX_RETRY_ATTEMPTS {
        return None;
    }
    let delay = retry_delay_for_status(status, parse_retry_after(response), attempt)?;
    if started.elapsed() + delay > RETRY_TOTAL_BUDGET {
        return None;
    }
    Some(delay)
}

/// A numeric `Retry-After` header, in seconds. (The HTTP-date form is ignored:
/// no provider we talk to sends it.)
pub fn parse_retry_after(response: &Response) -> Option<u64> {
    response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// Decide whether a failed HTTP status should be retried. Returns the delay
/// to wait before the next attempt, or `None` if the failure is permanent
/// (auth errors, validation errors, …).
///
/// 429: prefer `Retry-After` header (capped at [`RETRY_AFTER_CAP`]). If no
/// header, fall back to exponential. 5xx and 408 use exponential (500ms,
/// 1s, 2s, ...). Everything else is permanent.
pub fn retry_delay_for_status(
    status: StatusCode,
    retry_after_s: Option<u64>,
    attempt: u32,
) -> Option<Duration> {
    if !is_transient_status(status) {
        return None;
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        if let Some(s) = retry_after_s {
            return Some(Duration::from_secs(s).min(RETRY_AFTER_CAP));
        }
    }
    let shift = attempt.min(4);
    let backoff_ms = 500u64.saturating_mul(1u64 << shift);
    Some(Duration::from_millis(backoff_ms))
}

fn is_transient_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

/// A canned HTTP/1.1 server for the networked backends' tests — no mock crate,
/// just a `TcpListener` that answers each connection with the next scripted
/// reply. `None` accepts the connection and never answers, which is how a test
/// trips a per-request timeout. Every reply carries `Connection: close`, so each
/// attempt is a fresh connection the server can count.
#[cfg(test)]
pub(crate) mod test_server {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub struct TestServer {
        pub url: String,
        hits: Arc<AtomicUsize>,
        bodies: Arc<Mutex<Vec<String>>>,
    }

    impl TestServer {
        /// Connections accepted so far — one per attempt.
        pub fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }

        /// The raw requests (headers + body) received, in order.
        pub fn requests(&self) -> Vec<String> {
            self.bodies.lock().unwrap().clone()
        }
    }

    /// One scripted reply: `(status line suffix, extra headers, body)`, e.g.
    /// `(503, "", "busy")`.
    pub type Reply = Option<(u16, &'static str, String)>;

    pub async fn serve(replies: Vec<Reply>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let (h, b) = (hits.clone(), bodies.clone());
        tokio::spawn(async move {
            for reply in replies {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                h.fetch_add(1, Ordering::SeqCst);
                let request = read_request(&mut sock).await;
                b.lock().unwrap().push(request);
                match reply {
                    Some((status, headers, body)) => {
                        let text = format!(
                            "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                            body.len()
                        );
                        let _ = sock.write_all(text.as_bytes()).await;
                        let _ = sock.shutdown().await;
                    }
                    // Hold the socket open, unanswered, until the test ends.
                    None => {
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                            drop(sock);
                        });
                    }
                }
            }
        });
        TestServer {
            url: format!("http://{addr}/v1/test"),
            hits,
            bodies,
        }
    }

    /// Read one request: headers, then `Content-Length` bytes of body.
    async fn read_request(sock: &mut tokio::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = sock.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf);
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text[..end]
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if buf.len() >= end + 4 + len {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::serve;
    use super::*;
    use crate::speech::backend::SpeechBackend;
    use crate::speech::error::SpeechError;

    #[test]
    fn shared_client_is_a_singleton() {
        let a = shared_client();
        let b = shared_client();
        assert!(
            std::ptr::eq(a, b),
            "shared_client must return the same instance"
        );
    }

    #[test]
    fn missing_key_returns_structured_error() {
        // Constructor-only check: the MissingKey message must hint Settings.
        let err = SpeechError::MissingKey {
            provider: SpeechBackend::OpenAi,
        };
        assert!(format!("{err}").contains("Settings"));
    }

    #[test]
    fn retry_delay_returns_none_for_4xx_non_429() {
        for &status in &[
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::PAYLOAD_TOO_LARGE,
        ] {
            assert_eq!(
                retry_delay_for_status(status, None, 0),
                None,
                "{status} should not retry",
            );
        }
    }

    #[test]
    fn retry_delay_for_429_honors_retry_after_capped_at_10s() {
        let d = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, Some(3), 0);
        assert_eq!(d, Some(Duration::from_secs(3)));

        // Over-cap: 60s gets clamped to 10s so we don't freeze the agent.
        let d = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, Some(60), 0);
        assert_eq!(d, Some(RETRY_AFTER_CAP));
    }

    #[test]
    fn retry_delay_for_429_falls_back_to_exponential_without_header() {
        let d0 = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, None, 0).expect("retry");
        let d1 = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, None, 1).expect("retry");
        assert!(d1 > d0, "exponential should grow: {d0:?} -> {d1:?}");
    }

    #[test]
    fn retry_delay_for_5xx_uses_exponential_backoff() {
        for &status in &[
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::GATEWAY_TIMEOUT,
        ] {
            let d0 = retry_delay_for_status(status, None, 0).expect("retry");
            let d2 = retry_delay_for_status(status, None, 2).expect("retry");
            assert!(d2 > d0, "{status}: backoff should grow with attempt");
        }
    }

    #[test]
    fn retry_delay_caps_exponential_at_attempt_4() {
        // attempt=5 should not produce a larger delay than attempt=4 — the
        // shift saturates at 4 so we never enter pathological wait territory.
        let d4 = retry_delay_for_status(StatusCode::SERVICE_UNAVAILABLE, None, 4).expect("retry");
        let d5 = retry_delay_for_status(StatusCode::SERVICE_UNAVAILABLE, None, 5).expect("retry");
        assert_eq!(d4, d5);
    }

    const T: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn a_transient_status_is_retried_until_success() {
        let server = serve(vec![
            Some((503, "", "busy".into())),
            Some((200, "", "ok".into())),
        ])
        .await;
        let resp = send_with_retry(|| shared_client().get(&server.url), T, "test")
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.text().await.unwrap(), "ok");
        assert_eq!(server.hits(), 2, "one retry after the 503");
    }

    #[tokio::test]
    async fn a_permanent_status_is_returned_without_retrying() {
        let server = serve(vec![Some((400, "", "bad".into()))]).await;
        let resp = send_with_retry(|| shared_client().get(&server.url), T, "test")
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(server.hits(), 1);
    }

    #[tokio::test]
    async fn exhausted_retries_hand_back_the_last_failure_with_its_retry_after() {
        let busy = || Some((429, "Retry-After: 0\r\n", "slow down".to_string()));
        let server = serve(vec![busy(), busy(), busy()]).await;
        let resp = send_with_retry(|| shared_client().get(&server.url), T, "test")
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(parse_retry_after(&resp), Some(0));
        assert_eq!(server.hits() as u32, MAX_RETRY_ATTEMPTS);
    }

    #[tokio::test]
    async fn a_server_that_never_answers_trips_the_per_request_timeout() {
        let server = serve(vec![None]).await;
        let err = send_with_retry(
            || shared_client().get(&server.url),
            Duration::from_millis(300),
            "test",
        )
        .await
        .expect_err("no answer");
        assert!(err.is_timeout(), "expected a timeout, got {err:?}");
        assert_eq!(server.hits(), 1, "a timeout is not retried");
    }
}
