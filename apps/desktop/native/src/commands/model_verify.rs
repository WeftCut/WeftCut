//! Isolated candidate inference. Never changes the Backend's active config cache.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct LocalConfig {
    binary: PathBuf,
    model: PathBuf,
    tokens: Option<PathBuf>,
    mmproj: Option<PathBuf>,
    device: Option<String>,
    threads: Option<u32>,
}

#[derive(Deserialize)]
pub struct EndpointConfig {
    url: String,
    model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyModelArgs {
    #[serde(default)]
    request_id: String,
    family: String,
    backend: String,
    local: Option<LocalConfig>,
    endpoint: Option<EndpointConfig>,
    api_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VerifyResult {
    device: &'static str,
}

// Execution handles only, never model configuration or project state.
fn live_verifications() -> &'static Mutex<HashMap<String, Option<tokio::task::AbortHandle>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Option<tokio::task::AbortHandle>>>> =
        OnceLock::new();
    JOBS.get_or_init(Default::default)
}

pub async fn verify_model_job(a: VerifyModelArgs) -> Result<VerifyResult, String> {
    uuid::Uuid::parse_str(&a.request_id).map_err(|_| "Invalid verification request ID")?;
    let id = a.request_id.clone();
    let job = {
        let mut live = live_verifications()
            .lock()
            .map_err(|_| "Verification registry unavailable")?;
        if live.remove(&id).is_some() {
            return Err("Verification cancelled".into());
        }
        let job = tokio::spawn(verify_model(a));
        live.insert(id.clone(), Some(job.abort_handle()));
        job
    };
    let result = job.await.map_err(|_| "Verification cancelled".to_string());
    live_verifications()
        .lock()
        .map_err(|_| "Verification registry unavailable")?
        .remove(&id);
    result?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelVerificationArgs {
    pub request_id: String,
}

pub fn cancel_verification(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid verification request ID")?;
    let mut live = live_verifications()
        .lock()
        .map_err(|_| "Verification registry unavailable")?;
    if let Some(Some(job)) = live.remove(id) {
        job.abort();
    } else {
        // Cover cancellation delivered before the async invocation registers itself.
        // Bound stale cancellation markers from requests that never start.
        if live.len() >= 128 {
            live.retain(|_, handle| handle.is_some());
        }
        live.insert(id.to_owned(), None);
    }
    Ok(())
}

/// A two-second synthetic PCM sample: no project/user media is used or uploaded.
fn test_wav() -> Vec<u8> {
    let data_bytes = 16_000_u32 * 2 * 2;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&16_000_u32.to_le_bytes());
    wav.extend_from_slice(&32_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    wav.resize(44 + data_bytes as usize, 0);
    wav
}

pub async fn verify_model(a: VerifyModelArgs) -> Result<VerifyResult, String> {
    let tmp = tempfile::Builder::new()
        .prefix("weftcut-model-test")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let device = if a.local.as_ref().and_then(|l| l.device.as_deref()) == Some("cpu") {
        "cpu"
    } else if a.local.as_ref().and_then(|l| l.device.as_deref()).is_some() {
        "fixed"
    } else {
        "auto"
    };
    match a.family.as_str() {
        "speech" => {
            use crate::speech::{
                self, config::BackendConfig, transcriber::TranscribeRequest, SpeechBackend,
            };
            let backend = SpeechBackend::all()
                .iter()
                .copied()
                .find(|b| b.as_str() == a.backend)
                .ok_or("Unknown speech model backend")?;
            let entry = if backend == SpeechBackend::OpenAi {
                BackendConfig::ApiKey(a.api_key.unwrap_or_default())
            } else {
                let l = a.local.ok_or("Missing local model configuration")?;
                BackendConfig::Local {
                    binary: l.binary,
                    model: l.model,
                    tokens: l.tokens,
                    device: l.device,
                    threads: l.threads,
                }
            };
            let cfg = HashMap::from([(a.backend, entry)]);
            let transcriber =
                speech::resolve_transcriber_exact(backend, &cfg).map_err(|e| e.to_string())?;
            let audio_path = tmp.path().join("test.wav");
            tokio::fs::write(&audio_path, test_wav())
                .await
                .map_err(|e| e.to_string())?;
            let raw = transcriber
                .transcribe(TranscribeRequest {
                    audio_path,
                    language: Some("en".into()),
                    want_word_timing: true,
                })
                .await
                .map_err(|e| e.to_string())?;
            speech::parse::parse_raw(raw).map_err(|e| e.to_string())?;
            Ok(VerifyResult { device })
        }
        "vlm" => {
            use crate::vlm::{
                self,
                config::BackendConfig,
                describer::{DescribeRequest, Focus, Language, TimedFrame},
                sidecar::{LlamaMtmdSidecar, OutputStyle},
                VlmBackend,
            };
            let backend = VlmBackend::all()
                .iter()
                .copied()
                .find(|b| b.as_str() == a.backend)
                .ok_or("Unknown video model backend")?;
            let image_path = tmp.path().join("test.png");
            image::RgbImage::from_pixel(64, 64, image::Rgb([40, 100, 180]))
                .save(&image_path)
                .map_err(|e| e.to_string())?;
            let req = DescribeRequest {
                frames: vec![TimedFrame {
                    t_us: 0,
                    path: image_path,
                }],
                focus: Focus::General,
                language: Language::default(),
            };
            if backend == VlmBackend::ByoEndpoint {
                let ep = a.endpoint.ok_or("Missing model endpoint")?;
                let cfg = HashMap::from([(
                    a.backend,
                    BackendConfig::Endpoint {
                        url: ep.url,
                        model: Some(ep.model),
                        api_key: a.api_key,
                    },
                )]);
                let d =
                    vlm::resolve_scene_describer_exact(backend, &cfg).map_err(|e| e.to_string())?;
                let raw = d.describe(req).await.map_err(|e| e.to_string())?;
                vlm::parser::parse_raw(raw).map_err(|e| e.to_string())?;
                Ok(VerifyResult { device })
            } else {
                let l = a.local.ok_or("Missing local model configuration")?;
                let style = if backend == VlmBackend::Qwen3Vl {
                    OutputStyle::Qwen3VlJson
                } else {
                    OutputStyle::MiniCpmVText
                };
                let d = LlamaMtmdSidecar::new(
                    l.binary,
                    l.model,
                    l.mmproj.ok_or("Missing vision projector")?,
                    l.device,
                    style,
                );
                let (raw, cpu) = d.describe_verified(req).await.map_err(|e| e.to_string())?;
                vlm::parser::parse_raw(raw).map_err(|e| e.to_string())?;
                Ok(VerifyResult {
                    device: if cpu { "cpu" } else { device },
                })
            }
        }
        _ => Err("Unknown model family".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_can_arrive_before_the_verification_starts() {
        let id = uuid::Uuid::new_v4().to_string();
        cancel_verification(&id).unwrap();
        let args = serde_json::from_value(
            serde_json::json!({ "requestId": id, "family": "speech", "backend": "whisper_cpp" }),
        )
        .unwrap();
        assert!(verify_model_job(args)
            .await
            .unwrap_err()
            .contains("cancelled"));
    }
    #[test]
    fn synthetic_wav_is_two_seconds_of_mono_pcm() {
        let wav = test_wav();
        assert_eq!(wav.len(), 64044);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[36..40], b"data");
    }
    #[tokio::test]
    async fn missing_candidate_does_not_need_or_mutate_an_active_backend() {
        let args = serde_json::from_str(r#"{"family":"speech","backend":"whisper_cpp"}"#).unwrap();
        assert!(verify_model(args)
            .await
            .unwrap_err()
            .contains("Missing local"));
    }
}
