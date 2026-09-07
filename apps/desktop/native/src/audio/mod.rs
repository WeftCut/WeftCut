//! Audio engine: envelope sampling (the preview/export parity contract),
//! the export block mixer, and the offline effect-chain bake. Spec:
//! docs/audio.md.

pub mod conform_reader;
pub mod envelope;
pub mod fx;
pub mod mix;
