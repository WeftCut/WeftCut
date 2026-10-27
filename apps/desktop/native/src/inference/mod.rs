//! What every inference subsystem shares, whichever engine serves it.
//!
//! [`speech`](crate::speech) (transcription, TTS) and [`vlm`](crate::vlm)
//! (scene description) each own their backends, config and errors; this module
//! holds the pieces that must NOT differ between them — today the networking
//! ([`http`]): one pooled client, one retry policy, and the rule that every
//! request carries its own timeout.

pub mod http;
