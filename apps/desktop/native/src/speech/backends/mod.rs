//! Concrete backend implementations behind the trait surfaces in
//! `speech::transcriber` and `speech::synthesizer`.
//!
//! Each backend module is a self-contained "single-file drop-in" — adding a
//! backend is one new file here plus a variant of `backend::SpeechBackend`
//! (and its entry in `SpeechBackend::ALL`), wired into `speech::construct_*`.

pub mod elevenlabs;
pub mod endpoint;
pub mod funasr;
pub mod openai;
pub mod sidecar;
pub mod whisper_cpp;
