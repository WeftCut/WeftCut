//! Cross-platform preview decode for WebCodecs-blind formats (ProRes, DNxHD,
//! MPEG-2, VC-1). Mirrors `preview_gpu` but ships CPU frames: libavcodec decodes
//! on the software lane or a copy-back hardware lane (NVDEC/VAAPI/VideoToolbox),
//! packed as 8-bit NV12 or u16LE I420P10.
//!
//! `decoder` is the streaming CPU decode surface; `session` drives it on the
//! carrier's session runtime, one session per source, every message in band on
//! the session's own sink.

pub mod decoder;
mod session;
pub use session::{PreviewOpenOptions, PreviewSessions};
