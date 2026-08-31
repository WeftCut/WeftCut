//! The video-understanding backend catalog: the enum of engines we know how to
//! drive, their locality (local sidecar / OpenAI-compatible endpoint), and the
//! default order the resolver falls back through.
//!
//! Architectural twin of [`speech::backend`](crate::speech) — same shape, same
//! `as_str` wire-tag contract. The tags are the `vlm_config` map keys the TS
//! host injects; see [`VlmBackend::as_str`].
//!
//! Unlike STT there is no hosted-provider backend: a hosted VLM is reached by
//! pointing [`VlmBackend::ByoEndpoint`] at its URL, so one HTTP describer covers
//! self-hosted and hosted alike (see [`super::endpoint`]).
//!
//! Config material (a local engine's binary/model/mmproj paths, or an endpoint
//! URL + optional key) lives in [`super::config`]; this module is only the
//! backend identity + its static facts. Selection + availability is
//! [`super::resolve`].

use serde::{Deserialize, Serialize};

/// Video-understanding engines WeftCut can drive. `Qwen3Vl` and `MiniCpmV` are
/// local one-shot `llama-mtmd-cli` sidecars (a GGUF model + mmproj on disk);
/// `ByoEndpoint` is any OpenAI-compatible `/v1/chat/completions`. All three
/// ingest the SAME timestamped multi-image input (frames + injected `<t s>` text
/// markers) and diverge only in the output parser + availability probe — the
/// whole point of the [`SceneDescriber`](super::describer::SceneDescriber) /
/// [`DescriptionParser`](super::parser::DescriptionParser) split.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VlmBackend {
    /// Qwen3-VL-4B-Instruct via `llama-mtmd-cli` (Apache 2.0). The DEFAULT —
    /// its timestamps are injected plain text, so the llama.cpp path is
    /// low-risk and fully controllable.
    Qwen3Vl,
    /// MiniCPM-V 4.5 via `llama-mtmd-cli`. Reuses the SAME frames + text-marker
    /// input path as Qwen3-VL (spike-proven — `temporal_ids` not needed);
    /// differs only in the output parser (underscore-joined tags + a trailing
    /// empty segment) and the availability probe.
    MiniCpmV,
    /// Any OpenAI-compatible endpoint the user points us at — a self-hosted
    /// `llama-server` / vLLM / SGLang, or a hosted provider's URL. Same
    /// frame-sampling input adapter as the local sidecar; no bundled runtime.
    /// Its optional API key is the ONE secret this subsystem has, and it lives
    /// in safeStorage like every other credential (see [`super::config`]).
    ByoEndpoint,
}

/// Where a backend runs. Drives the availability check: a local backend needs
/// its binary + model + mmproj present; an endpoint needs a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locality {
    /// Spawned CLI sidecar, file-gated (binary + GGUF + mmproj).
    Local,
    /// OpenAI-compatible HTTP endpoint, URL-gated.
    Endpoint,
}

/// The order the resolver walks after honoring the caller's `preferred` hint.
/// **Local-first** (unlike STT, which leads with a hosted provider): the whole
/// subsystem is opt-in and privacy-sensitive (frames), so with nothing preferred
/// we pick an on-device engine and only reach the network when no local engine
/// is configured. Qwen3-VL leads — it is the validated default (ADR 0055).
pub const DEFAULT_ORDER: &[VlmBackend] = &[
    VlmBackend::Qwen3Vl,
    VlmBackend::MiniCpmV,
    VlmBackend::ByoEndpoint,
];

impl VlmBackend {
    /// Stable string tag — the `vlm_config` map key AND the TS/napi wire
    /// contract. Do NOT change once persisted.
    pub fn as_str(self) -> &'static str {
        match self {
            VlmBackend::Qwen3Vl => "qwen3_vl",
            VlmBackend::MiniCpmV => "minicpm_v",
            VlmBackend::ByoEndpoint => "byo_endpoint",
        }
    }

    /// Human-facing label for the Settings row, same as `SpeechBackend::label`.
    /// Read by `commands::vlm::settings_get_vlm_backends`.
    pub fn label(self) -> &'static str {
        match self {
            VlmBackend::Qwen3Vl => "Qwen3-VL (local)",
            VlmBackend::MiniCpmV => "MiniCPM-V (local)",
            VlmBackend::ByoEndpoint => "OpenAI-compatible endpoint",
        }
    }

    /// Every backend we know about, in the default resolution order.
    pub fn all() -> &'static [VlmBackend] {
        DEFAULT_ORDER
    }

    /// Local (spawned CLI) vs Endpoint (OpenAI-compatible HTTP).
    pub fn locality(self) -> Locality {
        match self {
            VlmBackend::Qwen3Vl | VlmBackend::MiniCpmV => Locality::Local,
            VlmBackend::ByoEndpoint => Locality::Endpoint,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_tags_are_stable() {
        // Wire/on-disk contract — must never drift.
        assert_eq!(VlmBackend::Qwen3Vl.as_str(), "qwen3_vl");
        assert_eq!(VlmBackend::MiniCpmV.as_str(), "minicpm_v");
        assert_eq!(VlmBackend::ByoEndpoint.as_str(), "byo_endpoint");
    }

    #[test]
    fn default_order_is_local_first_and_leads_with_qwen() {
        assert_eq!(DEFAULT_ORDER.first(), Some(&VlmBackend::Qwen3Vl));
        // The network engine is last so it is never a silent substitute for a
        // configured local one.
        assert_eq!(DEFAULT_ORDER.last(), Some(&VlmBackend::ByoEndpoint));
        assert_eq!(VlmBackend::all(), DEFAULT_ORDER);
    }

    #[test]
    fn localities_are_assigned_per_engine() {
        assert_eq!(VlmBackend::Qwen3Vl.locality(), Locality::Local);
        assert_eq!(VlmBackend::MiniCpmV.locality(), Locality::Local);
        assert_eq!(VlmBackend::ByoEndpoint.locality(), Locality::Endpoint);
    }
}
