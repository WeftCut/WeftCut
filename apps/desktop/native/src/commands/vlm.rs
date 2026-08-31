//! Video-understanding (VLM) Settings commands — the twin of
//! [`commands::speech`](super::speech), with one structural difference that
//! follows ADR 0024.
//!
//! The speech listing reads its config off a resident `Backend` field that napi
//! setters populate. The video-understanding subsystem holds **no resident
//! state**: `describe_clip` takes its merged `vlm_config` snapshot as a call
//! argument, so this listing does too. Nothing is persisted here — Electron main
//! owns `vlm_config.json` and the safeStorage endpoint key, merges them
//! (`toVlmBackendSnapshot`), and injects the result. This command is a PURE
//! availability report over whatever it is handed.
//!
//! Key MATERIAL never crosses back out: a row reports presence only.

use std::collections::HashMap;

use crate::vlm::backend::{Locality, VlmBackend};
use crate::vlm::config::{availability, Availability, BackendConfig};
use crate::vlm::resolve::select_backend;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VlmBackendsArgs {
    /// The user's preferred engine tag (`"qwen3_vl"` / `"minicpm_v"` /
    /// `"byo_endpoint"`), or `None`/`"auto"` for automatic (fall through
    /// `DEFAULT_ORDER`, which is local-first).
    pub preferred: Option<String>,
    /// The merged backend-config snapshot, keyed by [`VlmBackend::as_str`] —
    /// the SAME map `describe_clip` receives, from the same producer. Absent or
    /// empty means nothing is configured and every row reports its own gap.
    #[serde(default)]
    pub vlm_config: HashMap<String, BackendConfig>,
}

/// One row for the Settings → Video understanding panel: a backend's identity,
/// its LIVE availability, and whether the resolver would pick it right now.
///
/// No `capabilities` sibling to [`SpeechBackendStatus`](super::speech): every
/// VLM backend serves the one capability (scene description) through the same
/// frames-plus-timestamps input path, so there is nothing to differentiate and
/// a struct of all-true booleans would say nothing.
///
/// The non-secret local paths / endpoint URL are merged in by Electron main
/// from its store — they are NOT echoed here.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VlmBackendStatus {
    /// Stable wire tag (`VlmBackend::as_str`).
    pub backend: String,
    pub label: String,
    /// `"local"` | `"endpoint"`.
    pub locality: String,
    /// `"available"` | `"needs_binary"` | `"needs_model"` | `"needs_endpoint"`.
    pub availability: String,
    /// True on the single backend the description resolver would use right now
    /// given the user's preference + what is available. `false` on every row
    /// when nothing is configured (the "no backend" degrade case).
    pub selected: bool,
}

/// Stable wire tag for an [`Availability`] verdict. Mirrors
/// `speech::availability_tag`, plus the endpoint locality STT does not have and
/// minus its `needs_key` (nothing here is key-gated).
fn availability_tag(a: Availability) -> &'static str {
    match a {
        Availability::Available => "available",
        Availability::NeedsBinary => "needs_binary",
        Availability::NeedsModel => "needs_model",
        Availability::NeedsEndpoint => "needs_endpoint",
    }
}

/// Full backend listing for the Settings → Video understanding panel: EVERY
/// [`VlmBackend`] with its label / locality, its live [`availability`] against
/// the injected config, and a `selected` marker for the one [`select_backend`]
/// would choose.
///
/// `select_backend` is reused rather than re-derived so the panel's "active
/// engine" line and `describe_clip`'s actual choice can never disagree.
pub async fn settings_get_vlm_backends(
    preferred: Option<String>,
    cfg: HashMap<String, BackendConfig>,
) -> Result<Vec<VlmBackendStatus>, String> {
    // "auto" / unknown / absent → None (automatic); a known tag → that backend.
    let preferred_backend = preferred
        .as_deref()
        .filter(|s| *s != "auto")
        .and_then(|s| VlmBackend::all().iter().copied().find(|bk| bk.as_str() == s));
    let selected = select_backend(preferred_backend, &cfg);
    Ok(VlmBackend::all()
        .iter()
        .copied()
        .map(|p| VlmBackendStatus {
            backend: p.as_str().to_string(),
            label: p.label().to_string(),
            locality: match p.locality() {
                Locality::Local => "local",
                Locality::Endpoint => "endpoint",
            }
            .to_string(),
            availability: availability_tag(availability(p, cfg.get(p.as_str()))).to_string(),
            selected: selected == Some(p),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_of(pairs: Vec<(&str, BackendConfig)>) -> HashMap<String, BackendConfig> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    fn endpoint(url: &str) -> BackendConfig {
        BackendConfig::Endpoint { url: url.into(), api_key: None, model: None }
    }

    /// A local config whose three files exist, so it reports `Available`.
    fn present_local(dir: &std::path::Path) -> BackendConfig {
        let binary = dir.join("llama-mtmd-cli");
        let model = dir.join("qwen.gguf");
        let mmproj = dir.join("mmproj.gguf");
        for p in [&binary, &model, &mmproj] {
            std::fs::write(p, b"\x00").unwrap();
        }
        BackendConfig::Local { binary, model, mmproj, device: None }
    }

    #[tokio::test]
    async fn empty_config_lists_every_backend_with_its_own_gap_and_nothing_selected() {
        let rows = settings_get_vlm_backends(None, HashMap::new()).await.unwrap();
        assert_eq!(rows.len(), VlmBackend::all().len());
        assert!(!rows.iter().any(|r| r.selected), "nothing configured => no row selected");
        // Each locality names the piece IT is missing, not a generic "unavailable".
        let by = |tag: &str| rows.iter().find(|r| r.backend == tag).unwrap();
        assert_eq!(by("qwen3_vl").availability, "needs_binary");
        assert_eq!(by("byo_endpoint").availability, "needs_endpoint");
        assert_eq!(by("byo_endpoint").locality, "endpoint");
        assert_eq!(by("qwen3_vl").locality, "local");
    }

    #[tokio::test]
    async fn selected_follows_the_resolver_and_honors_preference() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = cfg_of(vec![
            ("qwen3_vl", present_local(dir.path())),
            ("byo_endpoint", endpoint("http://localhost:8080/v1/chat/completions")),
        ]);
        // Automatic: DEFAULT_ORDER is local-first, so the on-device engine wins.
        let rows = settings_get_vlm_backends(None, cfg.clone()).await.unwrap();
        assert_eq!(rows.iter().find(|r| r.selected).map(|r| r.backend.as_str()), Some("qwen3_vl"));
        // An explicit preference that IS available wins.
        let rows = settings_get_vlm_backends(Some("byo_endpoint".into()), cfg.clone())
            .await
            .unwrap();
        assert_eq!(
            rows.iter().find(|r| r.selected).map(|r| r.backend.as_str()),
            Some("byo_endpoint"),
        );
        // "auto" is what the TS store spells; it must read as NO preference.
        let rows = settings_get_vlm_backends(Some("auto".into()), cfg).await.unwrap();
        assert_eq!(rows.iter().find(|r| r.selected).map(|r| r.backend.as_str()), Some("qwen3_vl"));
    }

    #[tokio::test]
    async fn a_preference_that_is_unavailable_falls_through_to_what_is() {
        let cfg = cfg_of(vec![("byo_endpoint", endpoint("http://h/v1/chat/completions"))]);
        // qwen3_vl preferred but unconfigured => the walk continues to the endpoint.
        let rows = settings_get_vlm_backends(Some("qwen3_vl".into()), cfg).await.unwrap();
        assert_eq!(
            rows.iter().find(|r| r.selected).map(|r| r.backend.as_str()),
            Some("byo_endpoint"),
        );
    }

    #[tokio::test]
    async fn args_deserialize_from_the_camel_case_wire_shape() {
        let a: VlmBackendsArgs = serde_json::from_value(serde_json::json!({
            "preferred": "qwen3_vl",
            "vlmConfig": {
                "byo_endpoint": { "kind": "endpoint", "url": "http://h/v1/chat/completions" },
            },
        }))
        .unwrap();
        assert_eq!(a.preferred.as_deref(), Some("qwen3_vl"));
        assert!(a.vlm_config.contains_key("byo_endpoint"));
        // An omitted config map is the "nothing configured yet" default, not an error.
        let a: VlmBackendsArgs = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(a.vlm_config.is_empty());
    }
}
