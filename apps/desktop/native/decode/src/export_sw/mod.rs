//! Cross-platform export-side software decode: decodes a WebCodecs-blind
//! ORIGINAL directly for export — no lossy full-proxy — over an exactly-once,
//! GOP-exact, windowed range contract. See ADR 0030 and ADR 0033.
//!
//! Owns: the per-source range driver (`session`) that reuses
//! `preview_sw::decoder::SwVideoStream` (open / robust seek / presentation-
//! ordered `next_frame` / internal EOS drain / color tags) and runs on the
//! carrier's session runtime; every message reaches the session's own JS
//! callback in-band, in producer order.
//!
//! Does NOT own: the decode surface (that is `preview_sw::decoder`), the
//! session lifecycle or flow-control structures (`carrier`), nor any of the
//! WebCodecs no-mid-flush / stop-key / pool-slot machinery — none of it
//! carries over, because `next_frame` already yields presentation order and
//! this session holds no VideoFrame pool. The range contract lives at
//! `serve_range`.

mod session;
pub use session::ExportSessions;
