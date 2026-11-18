//! Per-source export-decode session: the range driver ([`serve_range`]) run on
//! the carrier's [`SessionRuntime`], one [`ByteWindow`] lease per frame.
//!
//! Owns: the session's thread body, which opens a [`SwVideoStream`], services
//! range commands in FIFO order and ships owned frame bytes (NV12 or I420P10,
//! per the session's [`ExportOutFormat`]) as [`DecodeMsg`]s. The reorder, GOP
//! walk and EOS drain are the decoder's; the coverage/continuation contract is
//! [`serve_range`].
//!
//! Does NOT own the decode surface (`preview_sw::decoder`), any VideoFrame
//! pool, or the session lifecycle (`carrier::SessionRuntime`). See ADR 0030
//! and ADR 0033 for why this contract differs from the preview path.

use std::sync::mpsc::Receiver;
use std::sync::Arc;

use napi::bindgen_prelude::Buffer;

use crate::carrier::{ByteWindow, DecodeMsg, SessionCtx, SessionRuntime, Sink};
use crate::preview_sw::decoder::{SwColorTags, SwFrame, SwOutFormat, SwVideoStream};

/// Default window (frames in flight): bounds a 4K 10-bit export's main-process
/// frame memory to ~100–200 MB while keeping the decoder far enough ahead of
/// the encoder that it never idles between chunks. See ADR 0033.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the export Worker passes its window at open; this names the value for ADR 0033 and the tests"
    )
)]
pub const DEFAULT_CREDIT_WINDOW: u32 = 6;

/// Largest number of backward re-seek attempts when a container's seek overshoots
/// the target. Index-less MPEG-PS/TS estimate the seek byte-offset and can land
/// AFTER the requested time; each retry steps the target back by a growing
/// margin. The final fallback (seek target 0) decodes from the start — always a
/// valid at-or-before landing. Mirrors `preview_sw::session::serve_request`.
const MAX_SEEK_RETRIES: u32 = 6;
/// Initial backward step when re-seeking after an overshoot; doubles each retry.
const SEEK_RETRY_MARGIN_US: i64 = 1_000_000;

/// The pixel format a session emits (8-bit NV12 or 10-bit I420P10 — layouts on
/// [`SwOutFormat`]); `parse` rejects any other requested format at `open` so a
/// caller never receives silently wrong-format output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportOutFormat {
    Nv12,
    I420p10,
}

impl ExportOutFormat {
    /// Parse the caller's requested output-format tag (case-insensitive on the
    /// canonical name). Anything the software lane cannot emit is an error
    /// carrying the offending string, so `open` fails loudly and names the format
    /// it could not produce.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_uppercase().as_str() {
            "NV12" => Ok(ExportOutFormat::Nv12),
            "I420P10" => Ok(ExportOutFormat::I420p10),
            other => Err(format!("unsupported export output format '{other}'")),
        }
    }

    /// The decoder-level target this session format packs into.
    fn decoder_format(self) -> SwOutFormat {
        match self {
            ExportOutFormat::Nv12 => SwOutFormat::Nv12,
            ExportOutFormat::I420p10 => SwOutFormat::I420p10,
        }
    }
}

/// What `open` hands back once the session thread has opened its decoder: the
/// stream's frame dimensions, color tags, and source-normalized start PTS. Built
/// from `SwVideoStream`'s public fields (set at open) — no frame is decoded just
/// to learn them. Frames carry no color of their own; this is the session's.
#[derive(Debug, Clone)]
pub struct ExportOpenInfo {
    pub width: u32,
    pub height: u32,
    pub color: SwColorTags,
    /// The container's first-packet PTS in source-normalized microseconds (the
    /// offset `media_time::ticks_to_source_us` subtracts). 0 for a stream that
    /// starts at t=0.
    pub start_pts_us: i64,
}

/// The one command a session's loop takes: decode `[a_us, b_us]`. Lease
/// returns do NOT travel here — they reach the [`ByteWindow`] directly, so
/// they land while the loop is mid-range.
struct DecodeRange {
    a_us: i64,
    b_us: i64,
}

/// Per-thread cursor state carried across ranges. Owned by the session
/// thread; never crosses a boundary.
#[derive(Default)]
struct RangeState {
    /// A frame decoded past the previous range's `b`, held so a forward
    /// continuation resumes on it instead of re-feeding the stream prefix.
    pending: Option<SwFrame>,
    /// `a` of the last serviced range; a range with `a >= last_range_a` is a
    /// forward continuation, otherwise a backward re-seek.
    last_range_a: Option<i64>,
    /// Largest presentation `pts_us` delivered so far; lets a forward range whose
    /// `b` is fully behind us short-circuit without re-decoding.
    covered_through_us: i64,
    /// EOS reached and not yet re-armed by a backward seek.
    ended: bool,
}

impl RangeState {
    fn new() -> Self {
        Self {
            covered_through_us: i64::MIN,
            ..Default::default()
        }
    }
}

/// Robust seek: land on a keyframe AT/BEFORE `target_us` and return the first
/// decoded frame there — the initial candidate for the forward scan. `Ok(None)`
/// means the seek landed at EOF. See [`MAX_SEEK_RETRIES`] for why an overshoot
/// is retried. Mirrors `preview_sw`'s inline retry.
fn robust_seek_and_probe(
    stream: &mut SwVideoStream,
    target_us: i64,
) -> Result<Option<SwFrame>, String> {
    let mut seek_target = target_us;
    let mut margin = SEEK_RETRY_MARGIN_US;
    let mut attempt = 0u32;
    loop {
        stream
            .seek(seek_target)
            .map_err(|e| format!("seek to {seek_target}us failed: {e}"))?;
        match stream.next_frame()? {
            Some(f) => {
                if f.pts_us > target_us && seek_target > 0 && attempt < MAX_SEEK_RETRIES {
                    seek_target = (target_us - margin).max(0);
                    margin = margin.saturating_mul(2);
                    attempt += 1;
                    continue;
                }
                return Ok(Some(f)); // landed at/before target (or can't retry further)
            }
            None => return Ok(None),
        }
    }
}

fn mark(a: i64, b: i64) -> DecodeMsg {
    DecodeMsg::Mark {
        a_us: a as f64,
        b_us: b as f64,
    }
}

/// A seek/decode failure the session survives: the next range re-seeks or
/// continues as usual.
fn recoverable(message: String) -> DecodeMsg {
    DecodeMsg::Error {
        message,
        terminal: false,
    }
}

/// Service one range `[a, b]`: deliver every frame whose presentation
/// interval `[pts, pts+dur)` intersects it (b inclusive — matches the
/// WebCodecs `ExportFrameStore` half-open containment + `pts <= bUs` feed
/// cutoff), exactly once, in presentation order, one window lease per frame.
///
/// Coverage is a plain forward scan because `next_frame` already yields
/// presentation order (monotonic `pts_us`) — no stop-key packet bookkeeping, no
/// mid-flush. A range is a *forward* continuation when `a >= last_range_a`,
/// resuming on the previous range's stopped-on frame ([`RangeState::pending`])
/// with no prefix re-feed; otherwise (backward clip-reuse jump) it re-seeks.
///
/// A cancelled session abandons the range between frames, without its `Mark`.
fn serve_range(
    stream: &mut SwVideoStream,
    state: &mut RangeState,
    window: &ByteWindow,
    ctx: &SessionCtx,
    a: i64,
    b: i64,
) {
    let forward = state.last_range_a.is_some_and(|la| a >= la);

    // Forward past a drained stream, or fully behind what we've already emitted:
    // nothing to decode, the range is trivially satisfied.
    if forward && (state.ended || b < state.covered_through_us) {
        ctx.emit(mark(a, b));
        return;
    }

    // Backward jump (or first range): re-seek to the GOP key at/before `a` and
    // arm the scan on the landing frame. A forward range keeps `pending`.
    if !forward {
        match robust_seek_and_probe(stream, a) {
            Ok(landing) => {
                state.pending = landing;
                state.ended = false;
                // The high-water mark no longer means "everything below was
                // delivered" once the cursor jumps back: keeping it would let a
                // later forward range whose [a, b] was never covered short-circuit
                // as trivially satisfied and deliver nothing. Mirrors the WebCodecs
                // handle's rebuild resetting `coveredThroughUs`.
                state.covered_through_us = i64::MIN;
            }
            Err(e) => {
                ctx.emit(recoverable(e));
                return;
            }
        }
    }
    state.last_range_a = Some(a);

    loop {
        if ctx.cancelled() {
            return;
        }
        let frame = match state.pending.take() {
            Some(f) => f,
            None => match stream.next_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    // Internal EOS: the final GOP's trailing frames have already
                    // been drained + delivered above. Signal end-of-stream, then
                    // close the range.
                    state.ended = true;
                    ctx.emit(DecodeMsg::End);
                    ctx.emit(mark(a, b));
                    return;
                }
                Err(e) => {
                    ctx.emit(recoverable(e));
                    return;
                }
            },
        };

        // Past the range end. Presentation order is monotonic, so no later frame
        // can re-enter `[a, b]`: stash this frame for the next forward range and
        // finish. (`>` not `>=`: a frame starting exactly at `b` still intersects
        // the inclusive range and must be delivered.)
        if frame.pts_us > b {
            state.pending = Some(frame);
            ctx.emit(mark(a, b));
            return;
        }

        // Entirely before the range start: decoded only as a reference for later
        // frames, not part of `[a, b]`. `.max(1)` guards a 0/unknown duration so a
        // frame at pts ≈ a is never mis-skipped.
        if frame.pts_us + frame.dur_us.max(1) <= a {
            continue;
        }

        // In range. Take a lease BEFORE emitting so in-flight frames never
        // exceed the window. A closed window, or a lease granted after cancel,
        // means teardown: abandon silently.
        let Some(lease) = window.acquire(frame.data.len()) else {
            return;
        };
        if ctx.cancelled() {
            window.release(lease);
            return;
        }
        if frame.pts_us > state.covered_through_us {
            state.covered_through_us = frame.pts_us;
        }
        ctx.emit(DecodeMsg::Bytes {
            lease,
            pts_us: frame.pts_us as f64,
            dur_us: frame.dur_us as f64,
            width: frame.width,
            height: frame.height,
            format: frame.format.into(),
            data: Buffer::from(frame.data),
            request_id: None,
        });
    }
}

/// The session's loop: serve ranges in FIFO order until close disconnects the
/// channel. A range still queued when the session is cancelled is dropped
/// unserved.
fn run_session(
    mut stream: SwVideoStream,
    rx: Receiver<DecodeRange>,
    ctx: SessionCtx,
    window: Arc<ByteWindow>,
) {
    let mut state = RangeState::new();
    while let Ok(DecodeRange { a_us, b_us }) = rx.recv() {
        if ctx.cancelled() {
            break;
        }
        serve_range(&mut stream, &mut state, &window, &ctx, a_us, b_us);
    }
    // `stream` drops here: the decoder + format context release on this thread.
}

/// The live export-decode sessions. `Send + Sync`, so the addon drives it from
/// napi calls.
pub struct ExportSessions {
    runtime: SessionRuntime<DecodeRange, ByteWindow>,
}

impl Default for ExportSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl ExportSessions {
    pub fn new() -> Self {
        Self {
            runtime: SessionRuntime::new("export-sw"),
        }
    }

    /// Open `path` for export decode into `out_format`, with at most `window`
    /// frames in flight and every message going to `sink`. Fails loudly
    /// (before returning) if the requested format cannot be emitted or the
    /// decoder cannot open.
    pub fn open(
        &self,
        session_id: &str,
        path: &str,
        out_format: &str,
        window: u32,
        sink: Sink,
    ) -> Result<ExportOpenInfo, String> {
        // Validate the requested format FIRST — a format the session can't emit
        // must fail at open, before any thread or decoder work.
        let fmt = ExportOutFormat::parse(out_format)?;
        let window = Arc::new(ByteWindow::new(window, 0));
        let thread_window = Arc::clone(&window);
        let path = path.to_string();
        let thread_limit = crate::preview_sw::decoder::configured_decode_threads();
        self.runtime.open(session_id, sink, window, move |ctx, rx| {
            crate::preview_sw::decoder::set_session_threads(thread_limit);
            let stream = SwVideoStream::open_with_format(&path, fmt.decoder_format())?;
            let info = ExportOpenInfo {
                width: stream.width,
                height: stream.height,
                color: stream.color.clone(),
                start_pts_us: stream.start_pts_us,
            };
            Ok((info, move || run_session(stream, rx, ctx, thread_window)))
        })
    }

    /// Ask a session to decode `[a_us, b_us]`. Fire-and-forget: frames and a
    /// `Mark` (or `End` then `Mark`) follow on the session's sink.
    pub fn decode_range(&self, session_id: &str, a_us: i64, b_us: i64) -> Result<(), String> {
        self.runtime.send(session_id, DecodeRange { a_us, b_us })
    }

    /// Hand a frame's lease back, resuming a producer parked on a full window.
    /// Reaches the window directly, so it lands while a range is being served
    /// (ADR 0033). `Ok(false)`: the lease was not in flight and changed nothing.
    pub fn release(&self, session_id: &str, lease: u32) -> Result<bool, String> {
        self.runtime
            .with(session_id, |window| window.release(lease))
    }

    /// Tear a session down: a parked producer wakes, a range in progress is
    /// abandoned between frames, queued ranges are dropped, and the call
    /// returns within the runtime's close grace.
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        self.runtime.close(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::carrier::PlaneFormat;
    use crate::test_wait::wait_for;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    const PRORES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/tiny_prores.mov"
    );
    const MPEG2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");

    /// Everything one session sent, so tests can assert the frame PTS
    /// sequence, per-frame format/bytes, the leases and the control markers.
    #[derive(Default)]
    struct Collected {
        pts: Vec<i64>,
        durs: Vec<i64>,
        formats: Vec<PlaneFormat>,
        datas: Vec<Vec<u8>>,
        leases: Vec<u32>,
        /// How many of `leases` the test has handed back.
        returned: usize,
        range_ends: usize,
        completed_ranges: Vec<(i64, i64)>,
        ended: usize,
        errors: Vec<(String, bool)>,
    }

    fn record(c: &mut Collected, msg: DecodeMsg) {
        match msg {
            DecodeMsg::Bytes {
                lease,
                pts_us,
                dur_us,
                format,
                data,
                request_id,
                ..
            } => {
                assert_eq!(
                    request_id, None,
                    "an export frame answers a range, not a request"
                );
                c.leases.push(lease);
                c.pts.push(pts_us as i64);
                c.durs.push(dur_us as i64);
                c.formats.push(format);
                c.datas.push(data.to_vec());
            }
            DecodeMsg::Mark { a_us, b_us } => {
                c.range_ends += 1;
                c.completed_ranges.push((a_us as i64, b_us as i64));
            }
            DecodeMsg::End => c.ended += 1,
            DecodeMsg::Error { message, terminal } => c.errors.push((message, terminal)),
            DecodeMsg::Slot { .. } => c
                .errors
                .push(("an export session sent a slot".into(), true)),
        }
    }

    fn collector() -> (Sink, Arc<Mutex<Collected>>) {
        let got = Arc::new(Mutex::new(Collected::default()));
        let g2 = got.clone();
        (
            Box::new(move |msg| record(&mut g2.lock().unwrap(), msg)),
            got,
        )
    }

    /// Open `id` on `sessions` with a fresh collector as its sink.
    fn open(
        sessions: &ExportSessions,
        id: &str,
        path: &str,
        format: &str,
        window: u32,
    ) -> Result<(ExportOpenInfo, Arc<Mutex<Collected>>), String> {
        let (sink, got) = collector();
        sessions
            .open(id, path, format, window, sink)
            .map(|info| (info, got))
    }

    /// How long a test gives a producer that should be parked on the window to
    /// show it is not. Only a negative reads after it: a slower machine makes
    /// the check weaker, never red.
    const PARKED: Duration = Duration::from_millis(100);

    fn frames(got: &Arc<Mutex<Collected>>) -> usize {
        got.lock().unwrap().pts.len()
    }

    /// Total control markers seen (range ends + stream ends). Read with a SINGLE
    /// lock — reading two fields off two `got.lock()` calls in one expression
    /// would hold both non-reentrant guards at once and self-deadlock.
    fn markers(got: &Arc<Mutex<Collected>>) -> usize {
        let c = got.lock().unwrap();
        c.range_ends + c.ended
    }

    /// Hand back every lease received and not yet returned, as a consumer that
    /// keeps up would.
    fn return_all(s: &ExportSessions, id: &str, got: &Arc<Mutex<Collected>>) {
        let leases = {
            let mut c = got.lock().unwrap();
            let fresh = c.leases[c.returned..].to_vec();
            c.returned = c.leases.len();
            fresh
        };
        for lease in leases {
            assert!(s.release(id, lease).unwrap(), "lease {lease} was in flight");
        }
    }

    /// Drive a range to its Mark (or End), returning leases as they arrive so
    /// the producer never parks. A range that reaches neither fails here, so a
    /// caller's assertions always read a finished range.
    fn run_range(s: &ExportSessions, id: &str, a: i64, b: i64, got: &Arc<Mutex<Collected>>) {
        let ends_before = markers(got);
        s.decode_range(id, a, b).unwrap();
        let finished = wait_for(|| {
            return_all(s, id, got);
            markers(got) > ends_before
        });
        assert!(
            finished,
            "range {a}..{b} of '{id}' reached neither a Mark nor an End"
        );
    }

    #[test]
    fn open_returns_dimensions_color_and_start_pts() {
        let s = ExportSessions::new();
        let (info, _got) = open(&s, "s", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).expect("open");
        assert_eq!((info.width, info.height), (320, 240));
        // ProRes fixture is color_range=tv; matrix/primaries/transfer unspecified.
        assert_eq!(info.color.range.as_deref(), Some("tv"));
        assert_eq!(info.start_pts_us, 0);
        s.close("s").unwrap();
    }

    #[test]
    fn export_decodes_at_full_source_resolution() {
        // LANDMINE: the PREVIEW lane can ship a downscaled frame (the
        // playback-resolution divisor). Export shares `SwVideoStream` and must
        // never inherit it — an export silently rendered at half res is data
        // loss. `open_with_format` takes the decoder's default out-size policy
        // (`OutScale::FULL`) and this lane has no way to set another.
        let stream = SwVideoStream::open_with_format(PRORES, SwOutFormat::Nv12).expect("open");
        assert_eq!(
            (stream.out_width, stream.out_height),
            (stream.width, stream.height),
            "export stream must decode at source resolution"
        );
        drop(stream);

        let s = ExportSessions::new();
        let (info, got) = open(&s, "full", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).expect("open");
        assert_eq!((info.width, info.height), (320, 240));
        run_range(&s, "full", 0, 300_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(!c.datas.is_empty(), "no frames delivered");
        for d in &c.datas {
            assert_eq!(
                d.len(),
                320 * 240 + 320 * 240 / 2,
                "export frame is not full-size NV12"
            );
        }
        drop(c);
        s.close("full").unwrap();
    }

    #[test]
    fn range_end_reports_the_exact_completed_range() {
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "s", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).expect("open");
        run_range(&s, "s", 125_000, 500_000, &got);
        assert_eq!(
            got.lock().unwrap().completed_ranges,
            vec![(125_000, 500_000)]
        );
        s.close("s").unwrap();
    }

    #[test]
    fn open_accepts_i420p10_and_rejects_garbage_loudly() {
        let s = ExportSessions::new();
        let Err(err) = open(&s, "s", PRORES, "RGBA64", DEFAULT_CREDIT_WINDOW) else {
            panic!("RGBA64 opened");
        };
        assert!(
            err.contains("RGBA64"),
            "error should name the format: {err}"
        );
        // 10-bit is a first-class lane output.
        open(&s, "s", PRORES, "I420P10", DEFAULT_CREDIT_WINDOW).expect("I420P10 opens");
        s.close("s").unwrap();
    }

    #[test]
    fn i420p10_range_from_tenbit_source_preserves_tenbit_samples() {
        // ProRes fixture decodes to yuv422p10le: real 10-bit samples in, so the
        // packed output must show >8-bit code values — an 8-bit-quantized path
        // caps every u16 sample at 255, while even 10-bit limited-range BLACK
        // is 256 (and white ~940).
        let s = ExportSessions::new();
        let (info, got) = open(&s, "p", PRORES, "I420P10", DEFAULT_CREDIT_WINDOW).unwrap();
        assert_eq!((info.width, info.height), (320, 240)); // even dims → w*h*3 bytes
        assert_eq!(
            info.color.range.as_deref(),
            Some("tv"),
            "color tags carried by the open reply"
        );
        run_range(&s, "p", 0, 300_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(!c.datas.is_empty(), "no frames delivered");
        assert!(
            c.formats.iter().all(|&f| f == PlaneFormat::I420p10),
            "message-level format tag"
        );
        let y_bytes = 320 * 240 * 2;
        let mut luma_above_8bit = false;
        for d in &c.datas {
            assert_eq!(d.len(), 320 * 240 * 3, "tightly-packed I420P10 length");
            for (i, s) in d.as_chunks::<2>().0.iter().enumerate() {
                let v = u16::from_le_bytes(*s);
                assert!(v <= 1023, "sample {i} = {v} exceeds the 10-bit range");
                if i * 2 < y_bytes && v > 255 {
                    luma_above_8bit = true;
                }
            }
        }
        assert!(
            luma_above_8bit,
            "no luma sample above 255 — output looks 8-bit-quantized"
        );
        drop(c);
        s.close("p").unwrap();
    }

    #[test]
    fn i420p10_upconverts_an_8bit_source() {
        // MPEG-2 decodes to 8-bit yuv420p; the lane still emits I420P10
        // (swscale 8→10 upconvert) so a mixed-depth timeline needs no
        // per-source format branch downstream.
        let s = ExportSessions::new();
        let (info, got) = open(&s, "m", MPEG2, "I420P10", DEFAULT_CREDIT_WINDOW).unwrap();
        assert_eq!((info.width, info.height), (320, 240));
        run_range(&s, "m", 0, 200_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(!c.datas.is_empty(), "no frames delivered");
        assert!(
            c.formats.iter().all(|&f| f == PlaneFormat::I420p10),
            "message-level format tag"
        );
        for d in &c.datas {
            assert_eq!(d.len(), 320 * 240 * 3, "tightly-packed I420P10 length");
            let mut max = 0u16;
            for s in d.as_chunks::<2>().0 {
                let v = u16::from_le_bytes(*s);
                assert!(v <= 1023, "upconverted sample {v} exceeds the 10-bit range");
                max = max.max(v);
            }
            // 8-bit values scale x4 into the 10-bit range — an all-zero (or
            // still-8-bit) buffer must not pass.
            assert!(
                max > 255,
                "upconvert produced no sample above the 8-bit ceiling (max {max})"
            );
        }
        drop(c);
        s.close("m").unwrap();
    }

    #[test]
    fn intra_range_covers_exactly_the_intersecting_frames() {
        // ProRes: 8 intra frames at 0,125_000,...,875_000 (dur 125_000). Range
        // [200_000, 500_000] intersects frames at 125_000 (ends 250_000 > a),
        // 250_000, 375_000, and 500_000 (starts at b, inclusive). Not 0 (ends at
        // 125_000 <= a) nor 625_000 (starts past b).
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "p", 200_000, 500_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert_eq!(c.pts, vec![125_000, 250_000, 375_000, 500_000]);
        assert!(
            c.formats.iter().all(|&f| f == PlaneFormat::Nv12),
            "message-level format tag"
        );
        assert_eq!(c.range_ends, 1);
        drop(c);
        s.close("p").unwrap();
    }

    #[test]
    fn forward_ranges_continue_without_duplicates() {
        // Two contiguous forward ranges over ProRes must partition the frames with
        // no repeats and no gaps: [0,300_000] then [300_001,700_000].
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "p", 0, 300_000, &got);
        run_range(&s, "p", 300_001, 700_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        // [0,300_000]: 0,125_000,250_000 (375_000 starts past 300_000).
        // [300_001,700_000]: 375_000,500_000,625_000,700_000? 700_000 has no frame;
        //   frames are 375_000,500_000,625_000 (750_000 starts past 700_000).
        assert_eq!(c.pts, vec![0, 125_000, 250_000, 375_000, 500_000, 625_000]);
        // Strictly increasing → no duplicates, presentation order preserved.
        assert!(c.pts.windows(2).all(|w| w[0] < w[1]));
        drop(c);
        s.close("p").unwrap();
    }

    #[test]
    fn backward_range_reseeks_and_reemits() {
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "p", 500_000, 875_000, &got);
        let after_fwd = got.lock().unwrap().pts.clone();
        assert_eq!(after_fwd, vec![500_000, 625_000, 750_000, 875_000]);
        // Clip-reuse jump backward: re-seek and re-emit the earlier frames.
        run_range(&s, "p", 0, 200_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert_eq!(&c.pts[after_fwd.len()..], &[0, 125_000]);
        drop(c);
        s.close("p").unwrap();
    }

    #[test]
    fn forward_range_after_backward_jump_is_not_falsely_covered() {
        // Regression: `covered_through_us` must reset on a backward re-seek.
        // Without the reset, the third range below sits under the FIRST range's
        // high-water mark (875k), short-circuits as "already covered", and
        // delivers nothing — though [300k, 400k] was never covered by any range.
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "p", 500_000, 875_000, &got); // high-water → 875k
        run_range(&s, "p", 0, 200_000, &got); // backward jump: coverage resets
        let before = got.lock().unwrap().pts.len();
        run_range(&s, "p", 300_000, 400_000, &got); // forward, never covered
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        // 250k ([250k,375k) intersects) and 375k ([375k,500k) intersects b=400k).
        assert_eq!(&c.pts[before..], &[250_000, 375_000]);
        drop(c);
        s.close("p").unwrap();
    }

    #[test]
    fn long_gop_range_delivers_presentation_order_across_bframes() {
        // MPEG-2 IBBP, start_time 0.533s → source-normalized. A range spanning the
        // first two GOPs must deliver monotonically increasing (presentation-order)
        // PTS despite B-frame decode-order reordering, covering the range densely
        // (30fps → ~33_333us spacing).
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "m", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "m", 0, 600_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(
            c.pts.len() >= 18,
            "expected dense coverage, got {}",
            c.pts.len()
        );
        // Presentation order (the B-frame reorder guarantee).
        assert!(
            c.pts.windows(2).all(|w| w[0] < w[1]),
            "not monotonic: {:?}",
            c.pts
        );
        // First delivered frame is at/near source t=0 (start_pts subtracted).
        assert!(c.pts[0] >= 0 && c.pts[0] < 40_000, "first pts {}", c.pts[0]);
        // Every delivered frame intersects [0, 600_000] (b inclusive).
        assert!(c.pts.iter().all(|&p| p <= 600_000));
        drop(c);
        s.close("m").unwrap();
    }

    #[test]
    fn long_gop_midstream_range_covers_exactly_the_linear_subset() {
        // The open-GOP case: a window starting INSIDE a later GOP forces a seek to
        // an earlier keyframe and a forward decode whose reference chain must be
        // rebuilt. Exactness is cross-checked against a full LINEAR decode: the
        // mid-stream seek must deliver exactly the frames the linear pass produced
        // in that window (same set, same presentation order) — a dropped, doubled,
        // or mis-timed frame from a botched seek would diverge.
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "full", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "full", 0, 10_000_000, &got);
        let all: Vec<(i64, i64)> = {
            let c = got.lock().unwrap();
            c.pts.iter().copied().zip(c.durs.iter().copied()).collect()
        };
        s.close("full").unwrap();
        assert_eq!(all.len(), 60);

        let (a, b) = (700_000, 1_100_000);
        let expected: Vec<i64> = all
            .iter()
            .filter(|&&(p, d)| p + d.max(1) > a && p <= b)
            .map(|&(p, _)| p)
            .collect();
        assert!(expected.len() >= 10, "mid-stream window unexpectedly small");

        let s2 = ExportSessions::new();
        let (_info, got2) = open(&s2, "mid", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s2, "mid", a, b, &got2);
        let delivered = {
            let c = got2.lock().unwrap();
            assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
            c.pts.clone()
        };
        s2.close("mid").unwrap();
        assert_eq!(delivered, expected);
    }

    #[test]
    fn long_gop_backward_range_reseeks_correctly() {
        // A backward clip-reuse jump on a LONG-GOP source (not the trivial intra
        // case): decode a late window, then jump into an earlier GOP. The session
        // must re-seek to an earlier keyframe and deliver the earlier frames in
        // presentation order, covering the new range.
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "g", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "g", 1_400_000, 1_700_000, &got);
        let before = {
            let c = got.lock().unwrap();
            assert!(c.pts.windows(2).all(|w| w[0] < w[1]), "late not monotonic");
            assert!(c
                .pts
                .iter()
                .all(|&p| p + 33_333 > 1_400_000 && p <= 1_700_000));
            c.pts.len()
        };
        run_range(&s, "g", 400_000, 700_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        let early = &c.pts[before..];
        assert!(!early.is_empty(), "backward range delivered nothing");
        assert!(
            early.windows(2).all(|w| w[0] < w[1]),
            "backward not monotonic: {early:?}"
        );
        assert!(
            early.iter().all(|&p| p + 33_333 > 400_000 && p <= 700_000),
            "backward frames out of range: {early:?}"
        );
        assert!(
            early[0] < 450_000,
            "first backward frame not near a=400k: {}",
            early[0]
        );
        drop(c);
        s.close("g").unwrap();
    }

    #[test]
    fn eos_flushes_final_gop_then_signals_end() {
        // A range past the stream end drains the final GOP's trailing frames (no
        // external next-key) and fires exactly one End, before the range's Mark.
        let s = ExportSessions::new();
        let (info, got) = open(&s, "m", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        assert_eq!((info.width, info.height), (320, 240));
        run_range(&s, "m", 0, 10_000_000, &got); // b beyond the ~1.97s stream
                                                 // The End is a marker of its own, so wait for the Mark behind it too.
        assert!(wait_for(|| got.lock().unwrap().range_ends == 1));
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert_eq!(c.ended, 1, "expected exactly one End");
        // All 60 frames delivered, last near the stream end (~1.966s normalized).
        assert_eq!(c.pts.len(), 60, "expected all 60 frames");
        assert!(*c.pts.last().unwrap() > 1_900_000);
        drop(c);
        s.close("m").unwrap();
    }

    #[test]
    fn window_halts_then_resumes_per_returned_lease() {
        // With window=3 and no lease returned, the session emits 3 frames then
        // parks. Each returned lease lets exactly one more frame through.
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", 3).unwrap();
        s.decode_range("p", 0, 875_000).unwrap(); // all 8 frames intersect
                                                  // Each wait is for the frames the window allows; the pause after it is
                                                  // the time a producer that failed to park would have to show a frame
                                                  // too many.
        wait_for(|| frames(&got) >= 3);
        thread::sleep(PARKED);
        {
            let c = got.lock().unwrap();
            assert_eq!(c.pts.len(), 3, "window=3 should halt at 3 in flight");
            assert_eq!(c.range_ends, 0, "range not done while parked");
        }
        // Resume: return 2 leases → 2 more frames, then park again at 5 total.
        let (l0, l1) = {
            let c = got.lock().unwrap();
            (c.leases[0], c.leases[1])
        };
        assert!(s.release("p", l0).unwrap());
        assert!(s.release("p", l1).unwrap());
        wait_for(|| frames(&got) >= 5);
        thread::sleep(PARKED);
        assert_eq!(frames(&got), 5, "2 leases → 2 more frames");
        // Drain the rest.
        got.lock().unwrap().returned = 2;
        let done = wait_for(|| {
            return_all(&s, "p", &got);
            let c = got.lock().unwrap();
            c.pts.len() >= 8 && c.range_ends >= 1
        });
        assert!(done, "the range never finished after its leases came back");
        {
            let c = got.lock().unwrap();
            assert_eq!(c.pts.len(), 8, "all frames after returning the leases");
            assert_eq!(c.range_ends, 1);
        }
        s.close("p").unwrap();
    }

    #[test]
    fn a_duplicate_release_does_not_widen_the_window() {
        // A counter would take a lease returned twice as two credits and let a
        // third frame travel beside the two still in flight.
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", 2).unwrap();
        s.decode_range("p", 0, 875_000).unwrap();
        assert!(wait_for(|| frames(&got) >= 2));
        let first = got.lock().unwrap().leases[0];
        assert!(s.release("p", first).unwrap());
        assert!(
            !s.release("p", first).unwrap(),
            "the second return is ignored"
        );
        assert!(wait_for(|| frames(&got) >= 3));
        thread::sleep(PARKED);
        assert_eq!(
            frames(&got),
            3,
            "one returned lease → one more frame, whatever the duplicate"
        );
        s.close("p").unwrap();
    }

    #[test]
    fn leases_are_distinct_while_in_flight() {
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&s, "p", 0, 875_000, &got);
        let c = got.lock().unwrap();
        let mut leases = c.leases.clone();
        assert!(leases.iter().all(|&l| l != 0), "0 is never a lease");
        leases.sort_unstable();
        leases.dedup();
        assert_eq!(leases.len(), c.leases.len(), "a lease was granted twice");
        drop(c);
        s.close("p").unwrap();
    }

    #[test]
    fn close_unblocks_a_parked_producer() {
        // A session parked on a full window must tear down promptly (no
        // deadlock): window 1, a big range, no lease returned, then close. The
        // first frame is the last one before the producer parks.
        let s = ExportSessions::new();
        let (_info, got) = open(&s, "p", PRORES, "NV12", 1).unwrap();
        s.decode_range("p", 0, 875_000).unwrap();
        assert!(
            wait_for(|| frames(&got) == 1),
            "the producer never delivered the frame it parks behind"
        );
        // Time to reach the park; close has to return either way.
        thread::sleep(PARKED);
        // If close hangs, the test harness will time out; a clean return is the
        // assertion.
        s.close("p").unwrap();
    }

    #[test]
    fn cancel_abandons_the_range_in_progress_and_the_ranges_queued_behind_it() {
        // Close sets the cancel flag before anything else. Driven here without
        // the runtime, which would also silence the sink, so what the loop does
        // after the flag stays visible. The window parks the producer at two
        // frames; returning both leases after the cancel lets it run again, and
        // it must stop rather than finish the 60-frame range and the next one.
        let (sink, got) = collector();
        let ctx = SessionCtx::for_test(sink);
        let window = Arc::new(ByteWindow::new(2, 0));
        let (tx, rx) = mpsc::channel();
        let (loop_ctx, loop_window) = (ctx.clone(), Arc::clone(&window));
        let session = thread::spawn(move || {
            let stream = SwVideoStream::open_with_format(MPEG2, SwOutFormat::Nv12).expect("open");
            run_session(stream, rx, loop_ctx, loop_window);
        });
        tx.send(DecodeRange {
            a_us: 0,
            b_us: 10_000_000,
        })
        .unwrap();
        tx.send(DecodeRange {
            a_us: 0,
            b_us: 500_000,
        })
        .unwrap();
        assert!(
            wait_for(|| frames(&got) == 2),
            "the window's two frames never came"
        );

        ctx.cancel();
        let leases = got.lock().unwrap().leases.clone();
        for lease in leases {
            assert!(window.release(lease));
        }
        drop(tx);
        // Bounded: a loop that ignores the flag parks again on the window
        // rather than exiting.
        let exited = wait_for(|| session.is_finished());

        let c = got.lock().unwrap();
        assert_eq!(c.pts.len(), 2, "a frame was emitted after the cancel");
        assert_eq!(c.range_ends, 0, "a range was completed after the cancel");
        assert_eq!(
            c.ended, 0,
            "the stream was decoded to its end after the cancel"
        );
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(exited, "the session loop kept running after the cancel");
        drop(c);
        session.join().expect("the session loop exits cleanly");
    }

    #[test]
    fn decode_panic_surfaces_as_terminal_error_and_leaves_sessions_usable() {
        // The sink panics on its FIRST call (poisoning the session's sink
        // lock); the runtime's `catch_unwind` must turn that into an in-band
        // terminal `Error`, and the recovery emit must succeed via
        // `lock_recover` on the poisoned lock — otherwise the export Worker
        // strands on frames that never arrive.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let errors: Arc<Mutex<Vec<(String, bool)>>> = Arc::new(Mutex::new(vec![]));
        let calls2 = calls.clone();
        let errors2 = errors.clone();
        let s = ExportSessions::new();
        s.open(
            "s",
            PRORES,
            "NV12",
            DEFAULT_CREDIT_WINDOW,
            Box::new(move |msg| {
                if calls2.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("boom in export-sw sink");
                }
                if let DecodeMsg::Error { message, terminal } = msg {
                    errors2.lock().unwrap().push((message, terminal));
                }
            }),
        )
        .expect("open");
        s.decode_range("s", 0, 875_000).unwrap();
        let saw_panic = wait_for(|| {
            errors
                .lock()
                .unwrap()
                .iter()
                .any(|(m, terminal)| m.contains("panicked") && *terminal)
        });
        let errs = errors.lock().unwrap();
        assert!(
            saw_panic,
            "expected a terminal decode-panic Error, got: {errs:?}"
        );
        drop(errs);
        s.close("s")
            .expect("sessions usable after a caught decode panic");
        open(&s, "s", PRORES, "NV12", DEFAULT_CREDIT_WINDOW).expect("the id reopens");
        s.close("s").unwrap();
    }
}
