//! Windows-only native GPU decode preview path (see docs/decode-bench.md).
//! d3d11va decode -> own-shader NV12→RGBA conversion into a pool of shared
//! RGBA8 textures -> Electron sharedTexture -> renderer FrameRing. The
//! conversion (convert.rs) keeps color math + tag authority native (ADR 0032
//! generalized): the browser receives sRGB-passthrough RGBA and its
//! createImageBitmap is a pure byte copy. 8-bit only (Result-7 P010 block).
//! See poc/shared-texture/INTEGRATION-DESIGN.md.
pub mod convert;
pub mod decoder;
mod session;
pub use session::{PreviewGpuSessions, TimingSummary};
