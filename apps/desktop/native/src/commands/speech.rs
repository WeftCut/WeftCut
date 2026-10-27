//! Speech-backend Settings commands. Key MATERIAL never crosses this surface
//! outward — status reports presence only, and the key `settings_test_provider`
//! uses arrives in the injected `speechConfig` snapshot (built by Electron main
//! from safeStorage + the config store at call time, ADR 0148), never returned.
//! `set`/`clear` are handled in the Electron main process (safeStorage + the
//! TS store), so they have no dispatch arm here.

use std::collections::HashMap;

use crate::commands::ApiKeyStatus;
use crate::inference::EngineTag;
use crate::speech;
use crate::speech::backend::{Locality, SpeechBackend};
use crate::speech::config::{availability, Availability, BackendConfig};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTestProviderArgs {
    pub provider: String,
    /// Injected by Electron main — see [`SpeechConfigArgs`].
    #[serde(default)]
    pub speech_config: HashMap<String, BackendConfig>,
}

/// Args of `settings_get_api_key_status`: only the injected snapshot.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeechConfigArgs {
    /// The merged speech backend config (keys + local paths + the active
    /// endpoint), keyed by backend tag, injected by Electron main per call —
    /// the same snapshot `transcribe_clip` receives, so the panel and the
    /// resolver cannot disagree. Absent → nothing configured.
    #[serde(default)]
    pub speech_config: HashMap<String, BackendConfig>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechBackendsArgs {
    /// The user's preferred engine tag (`"openai"` / `"whisper_cpp"` /
    /// `"funasr"`), or `None`/`"auto"` for automatic (fall through
    /// `DEFAULT_ORDER`). Injected by Electron main from the TS-owned
    /// `speech_config.json` store, since the preferred engine is non-secret
    /// TS-side config, not part of the backend config snapshot.
    pub preferred: Option<String>,
    /// Injected by Electron main — see [`SpeechConfigArgs`].
    #[serde(default)]
    pub speech_config: HashMap<String, BackendConfig>,
}

/// Static capability surface of a backend, echoed to the Settings UI so it can
/// gray out rows a locality can never serve (e.g. TTS on a local engine) and
/// badge engines that report exact per-word timestamps.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilities {
    pub transcription: bool,
    pub tts: bool,
    pub exact_word_timing: bool,
}

/// One row for the Settings → Transcription/Speech panel: a backend's identity
/// and static facts, its LIVE availability, and whether the resolver would pick
/// it right now (`selected`). The non-secret local paths/hints are merged in by
/// Electron main from the TS store — they are NOT echoed here.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechBackendStatus {
    /// Stable wire tag (`SpeechBackend::as_str`).
    pub backend: String,
    pub label: String,
    /// `"cloud"` | `"local"` | `"endpoint"`.
    pub locality: String,
    pub capabilities: SpeechCapabilities,
    /// `"available"` | `"needs_key"` | `"needs_binary"` | `"needs_model"` |
    /// `"needs_endpoint"`.
    pub availability: String,
    /// True on the single backend the transcription resolver would use right
    /// now given the user's preference + what is available. `false` on every
    /// row when nothing is configured (the "no backend" degrade case).
    pub selected: bool,
}

/// Stable wire tag for an [`Availability`] verdict.
fn availability_tag(a: Availability) -> &'static str {
    match a {
        Availability::Available => "available",
        Availability::NeedsKey => "needs_key",
        Availability::NeedsBinary => "needs_binary",
        Availability::NeedsModel => "needs_model",
        Availability::NeedsEndpoint => "needs_endpoint",
    }
}

/// Resolve a wire tag (`"openai"`, …) to its [`SpeechBackend`]. Matches against
/// the stable `as_str` tag, not the serde form.
fn parse_backend(s: &str) -> Result<SpeechBackend, String> {
    SpeechBackend::from_tag(s).ok_or_else(|| format!("unknown provider: {s}"))
}

/// Presence-only status for the Settings → Transcription panel. Reports whether an
/// API key is in the injected snapshot for each cloud backend.
///
/// Deliberately lists **cloud backends only** (the ones an API key applies
/// to); the full multi-backend listing incl. local engines is
/// [`settings_get_speech_backends`]. Kept alongside it so existing TS callers
/// don't break. `configured` is strictly "an `ApiKey` entry is present".
pub async fn settings_get_api_key_status(
    cfg: &HashMap<String, BackendConfig>,
) -> Result<Vec<ApiKeyStatus>, String> {
    Ok(SpeechBackend::all()
        .iter()
        .copied()
        .filter(|b| b.locality() == Locality::Cloud)
        .map(|p| ApiKeyStatus {
            provider: p.as_str().to_string(),
            label: p.label().to_string(),
            configured: matches!(cfg.get(p.as_str()), Some(BackendConfig::ApiKey(_))),
        })
        .collect())
}

/// Live smoke check for a backend, routed through [`speech::probe_backend`]
/// (cloud: `GET /v1/models`; local: binary/model file existence). Returns
/// `SpeechError::MissingKey` (message mentions Settings) cleanly when a cloud
/// backend has no key in the snapshot, rather than a misleading "test failed".
pub async fn settings_test_provider(
    cfg: &HashMap<String, BackendConfig>,
    provider: String,
) -> Result<speech::ConnectionTestInfo, String> {
    let backend = parse_backend(&provider)?;
    speech::probe_backend(backend, cfg.get(backend.as_str()))
        .await
        .map_err(|e| format!("{e}"))
}

/// Full backend listing for the Settings → Transcription/Speech panel: EVERY
/// [`SpeechBackend`], each with its label / locality / capabilities, its live
/// [`availability`] against the injected config snapshot, and a `selected`
/// marker for the one the transcription resolver would use given `preferred`.
///
/// Generalizes [`settings_get_api_key_status`] (which lists cloud backends
/// only) to cover local engines too; that command is kept alongside this one —
/// see its doc. `preferred` is injected by Electron main from the TS-owned
/// preferred-engine store (`"auto"` / absent → automatic fall-through).
pub async fn settings_get_speech_backends(
    cfg: &HashMap<String, BackendConfig>,
    preferred: Option<String>,
) -> Result<Vec<SpeechBackendStatus>, String> {
    // "auto" / unknown / absent → None (automatic); a known tag → that backend.
    let preferred_backend = preferred.as_deref().filter(|s| *s != "auto").and_then(|s| {
        SpeechBackend::all()
            .iter()
            .copied()
            .find(|bk| bk.as_str() == s)
    });
    let selected = speech::resolve_selected_transcriber_backend(preferred_backend, cfg);
    Ok(SpeechBackend::all()
        .iter()
        .copied()
        .map(|p| {
            let caps = p.capabilities();
            SpeechBackendStatus {
                backend: p.as_str().to_string(),
                label: p.label().to_string(),
                locality: match p.locality() {
                    Locality::Cloud => "cloud",
                    Locality::Local => "local",
                    Locality::Endpoint => "endpoint",
                }
                .to_string(),
                capabilities: SpeechCapabilities {
                    transcription: caps.transcription,
                    tts: caps.tts,
                    exact_word_timing: caps.exact_word_timing,
                },
                availability: availability_tag(availability(p, cfg.get(p.as_str()))).to_string(),
                selected: selected == Some(p),
            }
        })
        .collect())
}
