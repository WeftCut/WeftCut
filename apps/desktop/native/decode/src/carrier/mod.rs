//! What every decode session is carried on: the one message it sends to JS
//! ([`DecodeMsg`]), the bound on its byte frames in flight ([`ByteWindow`]),
//! and the registry + thread host it runs on ([`SessionRuntime`]).
//!
//! Owns no decoding and no pipeline policy: a pipeline supplies the driver
//! that runs on the session thread (`export_sw/session.rs` is one).

mod msg;
mod runtime;
mod window;

pub use msg::DecodeMsg;
#[cfg(test)]
pub(crate) use msg::PlaneFormat;
pub(crate) use runtime::{SessionCtx, SessionRuntime, Sink};
pub(crate) use window::ByteWindow;
