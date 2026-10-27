//! What every inference subsystem shares, whichever engine serves it.
//!
//! [`speech`](crate::speech) (transcription, TTS) and [`vlm`](crate::vlm)
//! (scene description) each own their backends, config and errors; this module
//! holds the pieces that must NOT differ between them: the networking
//! ([`http`]) — one pooled client, one retry policy, and the rule that every
//! request carries its own timeout — and the local engine child ([`sidecar`]) —
//! admission, conhost guard, kill-on-drop, hang guard and exit classification.

pub mod http;
pub mod sidecar;

/// An engine catalog whose members travel as stable wire tags — the
/// `SpeechBackend` and `VlmBackend` enums. The tag, not the serde form, is
/// what config maps, IPC and the tools' `backend` arguments carry, so every
/// lookup goes through [`EngineTag::from_tag`] and a refusal can list
/// [`EngineTag::catalog`] instead of a hand-written list that drifts.
pub trait EngineTag: Copy + 'static {
    /// Every member, in the catalog's default order.
    fn catalog() -> &'static [Self];
    /// The stable wire tag.
    fn wire_tag(self) -> &'static str;
    /// The member whose wire tag is `tag`, if any.
    fn from_tag(tag: &str) -> Option<Self> {
        Self::catalog()
            .iter()
            .copied()
            .find(|b| b.wire_tag() == tag)
    }
}
