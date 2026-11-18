//! The in-band message a decode session sends to JS. These Rust types are the
//! source of the TypeScript types napi generates; JS reads them from the
//! addon's `index.d.ts`, never from a hand-kept mirror.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use crate::preview_sw::decoder::SwOutFormat;

/// Packed layout of a [`DecodeMsg::Bytes`] frame (byte layouts on
/// `SwOutFormat`).
// `skip_typescript` + the field's `ts_type` below: the napi CLI renders a
// string enum as an ambient `const enum` by default, which TS compiled with
// isolated modules can neither reference nor compare with a string literal.
// The field is typed as the literal union instead.
#[napi(string_enum, skip_typescript)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaneFormat {
    #[napi(value = "NV12")]
    Nv12,
    #[napi(value = "I420P10")]
    I420p10,
}

impl From<SwOutFormat> for PlaneFormat {
    fn from(f: SwOutFormat) -> Self {
        match f {
            SwOutFormat::Nv12 => PlaneFormat::Nv12,
            SwOutFormat::I420p10 => PlaneFormat::I420p10,
        }
    }
}

/// One message on a session's own callback, in the order the session produced
/// it. Frames and control share this one channel because the order is the
/// contract: a `mark` or `end` must never overtake the frames sent before it
/// (docs/export-ipc-transport.md § Decode-in). Times are source-normalized
/// microseconds, carried as `f64` because napi has no ergonomic `i64`.
#[napi(discriminant = "kind", discriminant_case = "lowercase")]
pub enum DecodeMsg {
    /// One decoded frame, owned by the consumer from here on.
    Bytes {
        /// Hand back through the session's release call once the frame has
        /// left the consumer; until then it counts against the session's window.
        lease: u32,
        pts_us: f64,
        dur_us: f64,
        /// Shipped dimensions; `data`'s length follows them and `format`.
        width: u32,
        height: u32,
        #[napi(ts_type = "'NV12' | 'I420P10'")]
        format: PlaneFormat,
        data: Buffer,
    },
    /// Every frame intersecting `[a_us, b_us]` (b inclusive) has been sent.
    Mark { a_us: f64, b_us: f64 },
    /// The stream reached its end; its final frames were sent before this.
    End,
    /// A failure. `terminal`: the session's thread is gone and nothing
    /// follows; otherwise the session stays usable and can be asked again.
    Error { message: String, terminal: bool },
}
