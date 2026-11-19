//! Per-source preview decode session: the request driver ([`run_session`] and
//! [`serve_request`]) run on the carrier's [`SessionRuntime`], one
//! [`ByteWindow`] lease per frame.
//!
//! Owns: the session's thread body, which opens a [`SwVideoStream`] (software
//! or a copy-back hardware lane), serves requests latest-wins with a forward
//! cursor, and ships owned frame bytes (NV12, or I420P10 for a 10-bit
//! session) as [`DecodeMsg`]s stamped with the request they answer.
//!
//! Does NOT own the decode surface (`decoder`), the session lifecycle or the
//! panic boundary (`carrier::SessionRuntime`), or colour: frames carry none,
//! the renderer stamps the source's resolved colour. See docs/preview.md
//! § The Standard engine.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::Buffer;

use super::decoder::{
    DecodeAccel, OutScale, OutputCadence, PlaneColor, SwFrame, SwOutFormat, SwVideoStream,
};
use crate::carrier::{ByteWindow, DecodeMsg, SessionCtx, SessionRuntime, SessionShared, Sink};

/// How far PAST the request target this lane keeps frames decoded before it
/// stops. This — not a frame count — is the lane's flow control: during playback
/// the target advances one frame per tick, so exactly one new frame falls inside
/// the horizon per request and the lane delivers at content rate instead of
/// racing ahead of its consumer.
///
/// Sized under `FrameRing`'s 1 s lookahead (renderer side) so a full horizon can
/// never overflow the ring's window. A fixed burst count cannot do this job: with
/// one, every request re-emits frames the ring already holds — measured at 4×
/// duplicate delivery on an all-intra source, 93 fps of NV12 pushed across IPC
/// for 30 fps of content.
const LOOKAHEAD_HORIZON_US: i64 = 500_000;

/// Furthest a request may sit PAST the decode frontier and still be served by
/// decoding through the gap rather than seeking to it. Twin of the WebCodecs
/// lane's `FORWARD_SEEK_RESET_US` (`PacketPump.ts`) — same value, same reasoning:
/// a seek costs a keyframe landing plus the entire GOP prefix, so it only wins
/// once the gap is longer than the walk would be.
///
/// LANDMINE: this is what makes forward playback cheap on a long-GOP source.
/// Seeking per request re-walks the GOP prefix every tick, and the prefix grows
/// as the playhead moves through the GOP — measured 137× decode amplification on
/// the 240-frame-GOP H.264 bench fixture (20 629 frames decoded to deliver 150),
/// which is 0.17× realtime where a linear walk is 15×. Anyone re-adding an
/// unconditional seek here re-creates that.
const FORWARD_CONTINUE_US: i64 = 1_000_000;

/// Hard cap on the frames one request may emit. Bounds cold start and horizon
/// re-fill after a long pause: without it a single request could hold the thread
/// away from the next command, and dump an unbounded NV12 burst across IPC in one
/// go. Steady playback never reaches it (one frame per request).
const MAX_BURST_FRAMES: usize = 16;

/// How long one request decodes before it yields to the command channel. A
/// yield resumes the same cursor, so a long GOP walk is sliced, not restarted;
/// it cannot interrupt a single blocking ffmpeg call.
const WORK_SLICE: Duration = Duration::from_millis(8);

/// How long a yielded request waits for a newer command before it resumes.
const RESUME_POLL: Duration = Duration::from_millis(1);

/// Largest number of backward re-seek attempts when a container's seek overshoots
/// the target. Index-less MPEG-PS/TS estimate the seek byte-offset and can land
/// AFTER the requested time; each retry steps the target back by a growing margin.
/// The final fallback (seek target 0) decodes from the start — always correct.
const MAX_SEEK_RETRIES: u32 = 6;
/// Initial backward step when re-seeking after an overshoot; doubles each retry.
/// ~1 s clears a typical (≤1 s) GOP overshoot in a single retry.
const SEEK_RETRY_MARGIN_US: i64 = 1_000_000;

/// Frames a session may have in flight: emitted, not yet released by the
/// renderer. A lease covers native -> napi -> IPC -> renderer acceptance; the
/// frame cache has its own budget. The session cursor holds at most one more
/// decoded frame of its own.
pub(crate) const WINDOW_FRAMES: u32 = 8;
/// Bytes a session may have in flight. A single larger frame still travels
/// alone ([`ByteWindow::new`]), so a high resolution cannot deadlock.
pub(crate) const WINDOW_BYTES: usize = 32 * 1024 * 1024;

/// What `open` hands back once the session thread has opened its decoder: the
/// dimensions frames will SHIP at — the session's [`OutScale`] already applied,
/// so a downscaled preview reports the smaller size rather than the source's.
/// Built from `SwVideoStream`'s `out_width`/`out_height` (set at open); no frame
/// is decoded just to learn them.
#[derive(Debug, Clone, Copy)]
pub struct PreviewOpenInfo {
    pub width: u32,
    pub height: u32,
}

/// How a session decodes and what it ships. The tests' default is the software
/// lane, NV12, full size, every frame.
#[derive(Debug, Clone)]
pub struct PreviewOpenOptions {
    /// Software, or a copy-back hardware lane; the shipped bytes are the same.
    pub accel: DecodeAccel,
    pub out_format: SwOutFormat,
    /// The colour the shipped planes carry.
    pub plane_color: PlaneColor,
    /// Playback-resolution divisor, applied before the bytes are packed.
    pub out_scale: OutScale,
    /// Which decoded frames are packed and shipped; decode still sees every one.
    pub output_cadence: OutputCadence,
}

#[cfg(test)]
impl Default for PreviewOpenOptions {
    fn default() -> Self {
        Self {
            accel: DecodeAccel::Software,
            out_format: SwOutFormat::Nv12,
            plane_color: PlaneColor::BT709_LIMITED,
            out_scale: OutScale::FULL,
            output_cadence: OutputCadence::FULL,
        }
    }
}

/// What a session's loop takes off its command channel. Lease returns do not
/// travel here: they reach the [`ByteWindow`] directly and only queue a `Wake`.
enum PreviewCmd {
    /// Make every frame from `target_us` through its horizon delivered, in
    /// answer to request `request_id`.
    Request { target_us: i64, request_id: u32 },
    /// A lease came back: resume a cursor that stopped on a full window.
    Wake,
}

/// State a session shares with the calls that must not queue behind its loop.
pub(crate) struct PreviewShared {
    window: ByteWindow,
    /// The newest request id, stored before the request is queued, so work for
    /// a superseded request stops between frames instead of after the drain.
    newest: AtomicU32,
}

impl PreviewShared {
    fn new() -> Self {
        Self {
            window: ByteWindow::new(WINDOW_FRAMES, WINDOW_BYTES),
            newest: AtomicU32::new(0),
        }
    }

    fn current(&self, request_id: u32) -> bool {
        self.newest.load(Ordering::Acquire) == request_id
    }
}

impl SessionShared for PreviewShared {
    fn on_close(&self) {
        self.window.close();
    }
}

/// Where the decoder is, carried ACROSS requests. This is the whole of the
/// lane's flow control; without it every request is a fresh seek and a fixed
/// burst, which starves long-GOP sources and floods intra ones. Owned by the
/// session thread, never crosses a boundary.
#[derive(Default)]
struct PumpCursor {
    /// The last request stopped on its work slice, not on its horizon.
    needs_resume: bool,
    /// A frame decoded past the previous request's horizon (or held back by a
    /// full window), so the next request resumes ON it rather than decoding it
    /// a second time.
    pending: Option<SwFrame>,
    /// Target of the last request served. A request at or after it is FORWARD;
    /// anything earlier is a backward seek. `None` before the first request.
    last_target_us: Option<i64>,
    /// PTS of the newest frame decoded so far — the frontier a forward request
    /// measures its gap against ([`FORWARD_CONTINUE_US`]).
    frontier_us: i64,
    /// EOF reached, and not yet re-armed by a backward seek. Without this, every
    /// tick past the end of a clip re-seeks and re-decodes the tail to rediscover
    /// the same EOF.
    ended: bool,
}

impl PumpCursor {
    /// Forget where the decoder is, so the next request — forward or not — seeks
    /// before it decodes. Used after a seek/decode failure (the stream's position
    /// is undefined then) and on a new request id (the renderer discarded what it
    /// held, so resuming beyond those frames would leave a hole).
    fn invalidate(&mut self) {
        self.pending = None;
        self.last_target_us = None;
        self.ended = false;
    }
}

/// A seek or decode failure the session survives: the cursor is invalidated and
/// the next request seeks again. Logged here as well, so a run of them is
/// visible in the app log whatever the consumer does with it.
fn recoverable(session: &str, ctx: &SessionCtx, message: String) {
    tracing::warn!(%session, %message, "preview-sw decode error");
    ctx.emit(DecodeMsg::Error {
        message,
        terminal: false,
    });
}

fn end(session: &str, ctx: &SessionCtx) {
    tracing::debug!(%session, "preview-sw eof");
    ctx.emit(DecodeMsg::End);
}

/// Robustly seek to a keyframe at/before `target_us` and return the first frame
/// decoded there — the initial candidate for the forward scan.
///
/// ffmpeg's BACKWARD seek is only approximate on index-less containers
/// (MPEG-PS/TS): it estimates a byte offset and can overshoot, landing AFTER the
/// target. Probe the first decoded frame; if it is past the target, re-seek
/// earlier with a growing margin until it lands at/before (or we reach the file
/// start, always a valid at-or-before landing). Indexed containers (MOV/MP4) land
/// correctly on the first try — zero retries. Mirrors `export_sw`'s
/// `robust_seek_and_probe`.
///
/// `Ok(None)` = the seek landed at EOF. Returns early with `Ok(None)` on
/// cancel too; the caller checks the flag itself before emitting anything.
fn robust_seek_and_probe(
    stream: &mut SwVideoStream,
    target_us: i64,
    ctx: &SessionCtx,
) -> Result<Option<SwFrame>, String> {
    let mut seek_target = target_us;
    let mut margin = SEEK_RETRY_MARGIN_US;
    let mut attempt = 0u32;
    loop {
        // Teardown preempts: each attempt is itself a seek + a decode probe.
        if ctx.cancelled() {
            return Ok(None);
        }
        stream
            .seek(seek_target)
            .map_err(|e| format!("seek to {seek_target}us failed: {e}"))?;
        match stream.next_frame()? {
            Some(f) => {
                if f.pts_us > target_us && seek_target > 0 && attempt < MAX_SEEK_RETRIES {
                    // Overshoot — step the seek target back and retry.
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

/// Service one request: make sure everything from `target_us` to
/// `target_us + LOOKAHEAD_HORIZON_US` has been sent, decoding only what is not
/// already delivered.
///
/// A FORWARD request (target at/after the last one, and no further than
/// [`FORWARD_CONTINUE_US`] past the decode frontier) resumes on the cursor's
/// stashed frame and walks the stream — no seek, no re-decode, so a playing
/// timeline costs exactly the frames it displays. Anything else (backward scrub,
/// a long forward jump, the first request) seeks to the keyframe at/before the
/// target and discards the GOP prefix as references.
///
/// Stops on the horizon (stashing the frame that crossed it), on
/// [`MAX_BURST_FRAMES`], on [`WORK_SLICE`] (to resume), on a full window
/// (stashing the frame; the lease that comes back wakes it), on EOF (an `End`)
/// or on a seek/decode failure (a non-terminal `Error`). Once the session is
/// cancelled or the request superseded, returns without emitting anything
/// further.
fn serve_request(
    session: &str,
    stream: &mut SwVideoStream,
    cursor: &mut PumpCursor,
    target_us: i64,
    request_id: u32,
    shared: &PreviewShared,
    ctx: &SessionCtx,
) {
    cursor.needs_resume = false;
    if !shared.current(request_id) {
        return;
    }
    let deadline = Instant::now() + WORK_SLICE;
    // Saturating, as the GPU twin is at every equivalent site: `target_us`
    // arrives as `f64 as i64` from napi, so an absurd JS value sits at the i64
    // extremes, where plain `-` panics in debug and wraps (misclassifying
    // forward/backward) in release.
    let forward = cursor.last_target_us.is_some_and(|lt| {
        // A cooperative yield can leave a long GOP's frontier far behind the
        // SAME target. Resuming that target must never seek back to its keyframe.
        target_us == lt
            || (target_us > lt
                && target_us.saturating_sub(cursor.frontier_us) <= FORWARD_CONTINUE_US)
    });

    // Forward past a drained stream: there is nothing left to decode and the
    // consumer was already told. Re-seeking to rediscover EOF is the tail cost
    // this avoids on every tick that sits past the end of a clip.
    if forward && cursor.ended {
        return;
    }

    if !forward {
        match robust_seek_and_probe(stream, target_us, ctx) {
            Ok(Some(f)) => {
                cursor.frontier_us = f.pts_us;
                cursor.pending = Some(f);
                cursor.ended = false;
            }
            Ok(None) => {
                // Teardown wins silently; a real EOF landing is still an EOF.
                if ctx.cancelled() {
                    return;
                }
                cursor.pending = None;
                cursor.ended = true;
                // The frontier must track the requested target on an EOF
                // landing: left stale, every post-EOF tick further than
                // FORWARD_CONTINUE_US past it fails the forward test and pays a
                // fresh seek+flush+probe to rediscover the same EOF, forever.
                // Advanced, the retry cadence collapses to one seek per
                // FORWARD_CONTINUE_US of playhead advance — which doubles as
                // self-heal for still-growing files.
                cursor.frontier_us = cursor.frontier_us.max(target_us);
                end(session, ctx);
                cursor.last_target_us = Some(target_us);
                return;
            }
            Err(message) => {
                cursor.invalidate();
                recoverable(session, ctx, message);
                return;
            }
        }
    }
    cursor.last_target_us = Some(target_us);

    let mut emitted = 0usize;
    loop {
        if !shared.current(request_id) {
            return;
        }
        if Instant::now() >= deadline {
            cursor.needs_resume = true;
            return;
        }
        let frame = match cursor.pending.take() {
            Some(f) => f,
            None => {
                // Teardown preempts the (potentially slow) decode of the next
                // frame; long-GOP discard loops pass through here every frame.
                if ctx.cancelled() {
                    return;
                }
                match stream.next_frame() {
                    Ok(Some(f)) => {
                        cursor.frontier_us = f.pts_us;
                        f
                    }
                    Ok(None) => {
                        cursor.ended = true;
                        // Same constraint as the seek-landing EOF arm above: an
                        // indexed container's far-forward seek lands on the tail
                        // keyframe and EOF surfaces HERE, with the frontier at
                        // the tail frame's pts — stale, every later tick past
                        // the continue-window would re-seek forever.
                        cursor.frontier_us = cursor.frontier_us.max(target_us);
                        end(session, ctx);
                        return;
                    }
                    Err(message) => {
                        cursor.invalidate();
                        recoverable(session, ctx, message);
                        return;
                    }
                }
            }
        };
        // A frame whose interval ends at/before the target is in the past — a GOP
        // prefix decoded only as a reference, or (on a forward continuation) a
        // frame the consumer already holds. `.max(1)` guards a 0/unknown duration
        // so the covering frame (pts ≈ target) is never skipped.
        if frame.pts_us.saturating_add(frame.dur_us.max(1)) <= target_us {
            continue;
        }
        // Past the horizon: enough is ready. Stash it, so the next forward
        // request resumes here and this frame is never decoded twice.
        if frame.pts_us > target_us.saturating_add(LOOKAHEAD_HORIZON_US) {
            cursor.pending = Some(frame);
            return;
        }
        // No frame may go out once teardown is observed or the request is
        // superseded.
        if ctx.cancelled() || !shared.current(request_id) {
            cursor.pending = Some(frame);
            return;
        }
        // LANDMINE: `try_acquire`, never the parking `acquire`. A parked
        // preview session cannot see a newer request, and the lease that wakes
        // it would ship this superseded frame first.
        let Some(lease) = shared.window.try_acquire(frame.data.len()) else {
            cursor.pending = Some(frame);
            return;
        };
        ctx.emit(DecodeMsg::Bytes {
            lease,
            pts_us: frame.pts_us as f64,
            dur_us: frame.dur_us as f64,
            width: frame.width,
            height: frame.height,
            format: frame.format.into(),
            data: Buffer::from(frame.data),
            request_id: Some(request_id),
        });
        emitted += 1;
        if emitted >= MAX_BURST_FRAMES {
            return;
        }
    }
}

/// The session's loop: wait for a command, coalesce everything queued behind it
/// latest-wins, serve the newest request, until close disconnects the channel.
///
/// Idle and window-blocked sessions sleep until a command or a returned lease.
/// A work-slice yield polls briefly and resumes without waiting for a new target.
fn run_session(
    session: String,
    mut stream: SwVideoStream,
    rx: Receiver<PreviewCmd>,
    ctx: SessionCtx,
    shared: Arc<PreviewShared>,
) {
    // Lives for the whole session, beside the stream it describes: it is what
    // lets consecutive requests share one forward decode pass.
    let mut cursor = PumpCursor::default();
    let mut demand = None;
    let mut last_request = None;
    loop {
        let first = if cursor.needs_resume {
            match rx.recv_timeout(RESUME_POLL) {
                Ok(cmd) => cmd,
                Err(RecvTimeoutError::Timeout) => PreviewCmd::Wake,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(cmd) => cmd,
                Err(_) => break,
            }
        };
        // Close sets the flag before it drops the channel, and the flag is
        // what preempts the queued backlog.
        if ctx.cancelled() {
            break;
        }
        // Latest-wins: drain everything already queued BEFORE serving. Only the
        // newest target matters for preview, so superseded targets never cost a
        // seek or a burst. No timers, no extra threads — a non-blocking sweep of
        // what recv() woke up to.
        if let PreviewCmd::Request {
            target_us,
            request_id,
        } = first
        {
            demand = Some((target_us, request_id));
        }
        while let Ok(cmd) = rx.try_recv() {
            if let PreviewCmd::Request {
                target_us,
                request_id,
            } = cmd
            {
                demand = Some((target_us, request_id));
            }
        }
        if ctx.cancelled() {
            break;
        }
        let Some((target_us, request_id)) = demand else {
            continue;
        };
        // A request id marks a discontinuity: a renderer cache flush must
        // redeliver even the exact same target, while forward refills keep the
        // id, the cursor and every useful frame in flight.
        if last_request != Some(request_id) {
            cursor.invalidate();
        }
        last_request = Some(request_id);
        serve_request(
            &session,
            &mut stream,
            &mut cursor,
            target_us,
            request_id,
            &shared,
            &ctx,
        );
    }
    // `stream` drops here: the decoder + format context release on this thread.
}

/// The live preview decode sessions. `Send + Sync`, so the addon drives it from
/// napi calls.
pub struct PreviewSessions {
    runtime: SessionRuntime<PreviewCmd, PreviewShared>,
}

impl Default for PreviewSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewSessions {
    pub fn new() -> Self {
        Self {
            runtime: SessionRuntime::new("preview-sw"),
        }
    }

    /// Open `path` for preview with every message going to `sink`. Blocks on the
    /// decoder open, so a failure (a hardware device that cannot be created
    /// included) surfaces here and the caller can fall back. Frames flow only
    /// after the first request.
    pub fn open(
        &self,
        session_id: &str,
        path: &str,
        options: PreviewOpenOptions,
        sink: Sink,
    ) -> Result<PreviewOpenInfo, String> {
        let shared = Arc::new(PreviewShared::new());
        let thread_shared = Arc::clone(&shared);
        let path = path.to_string();
        let session = session_id.to_string();
        let thread_limit = super::decoder::configured_decode_threads();
        self.runtime.open(session_id, sink, shared, move |ctx, rx| {
            super::decoder::set_session_threads(thread_limit);
            let mut stream = SwVideoStream::open_with_accel(
                &path,
                options.out_format,
                options.accel,
                options.out_scale,
                options.plane_color,
            )?;
            stream.set_output_cadence(options.output_cadence);
            let info = PreviewOpenInfo {
                width: stream.out_width,
                height: stream.out_height,
            };
            Ok((info, move || {
                run_session(session, stream, rx, ctx, thread_shared)
            }))
        })
    }

    /// Ask for every frame from `target_us` through its horizon, in answer to
    /// `request_id`. A different id from the last one is a discontinuity: the
    /// cursor re-seeks and frames of earlier requests stop at once. Fire-and-
    /// forget: frames follow on the session's sink.
    pub fn fill_from(
        &self,
        session_id: &str,
        target_us: i64,
        request_id: u32,
    ) -> Result<(), String> {
        self.runtime.with(session_id, |s| {
            s.newest.store(request_id, Ordering::Release);
        })?;
        self.runtime.send(
            session_id,
            PreviewCmd::Request {
                target_us,
                request_id,
            },
        )
    }

    /// Hand a frame's lease back and wake a session that stopped on a full
    /// window. `Ok(false)`: the lease was not in flight and changed nothing.
    pub fn release(&self, session_id: &str, lease: u32) -> Result<bool, String> {
        let released = self.runtime.with(session_id, |s| s.window.release(lease))?;
        if released {
            self.runtime.send(session_id, PreviewCmd::Wake)?;
        }
        Ok(released)
    }

    /// Tear a session down: the request in progress stops at its next frame,
    /// queued requests are dropped, and the call returns within the runtime's
    /// close grace. Leases still in flight are forgiven with the session.
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
    use std::sync::{Mutex, OnceLock, Weak};
    use std::thread;

    const PRORES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/tiny_prores.mov"
    );
    const MPEG2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");

    /// How long a test watches for a message that must not come. Only a
    /// negative reads after it: a slower machine makes the check weaker, never
    /// red.
    const QUIET: Duration = Duration::from_millis(100);

    /// Spacing between requests that should each be served on their own. The
    /// session coalesces whatever is queued when it wakes, so requests sent
    /// back to back collapse into the last one.
    const TICK: Duration = Duration::from_millis(120);

    #[derive(Debug, Clone, PartialEq)]
    enum Seen {
        Frame(Frame),
        End,
        Error {
            message: String,
            terminal: bool,
        },
        /// A message this lane never sends.
        Other,
    }

    #[derive(Debug, Clone, PartialEq)]
    struct Frame {
        lease: u32,
        request_id: Option<u32>,
        pts: i64,
        width: u32,
        height: u32,
        len: usize,
        format: PlaneFormat,
    }

    type Log = Arc<Mutex<Vec<Seen>>>;

    fn seen(msg: DecodeMsg) -> Seen {
        match msg {
            DecodeMsg::Bytes {
                lease,
                pts_us,
                width,
                height,
                format,
                data,
                request_id,
                ..
            } => Seen::Frame(Frame {
                lease,
                request_id,
                pts: pts_us as i64,
                width,
                height,
                len: data.len(),
                format,
            }),
            DecodeMsg::End => Seen::End,
            DecodeMsg::Error { message, terminal } => Seen::Error { message, terminal },
            DecodeMsg::Mark { .. } | DecodeMsg::Slot { .. } => Seen::Other,
        }
    }

    /// Open `id` with a recording sink. With `keep_up`, the sink hands each
    /// lease straight back, as a renderer that keeps up would; without it the
    /// test returns leases itself.
    fn open(
        sessions: &Arc<PreviewSessions>,
        id: &str,
        path: &str,
        options: PreviewOpenOptions,
        keep_up: bool,
    ) -> Result<(PreviewOpenInfo, Log), String> {
        let log: Log = Arc::default();
        let log2 = Arc::clone(&log);
        let weak: Weak<PreviewSessions> = Arc::downgrade(sessions);
        let sid = id.to_string();
        let sink: Sink = Box::new(move |msg| {
            let msg = seen(msg);
            if let (true, Seen::Frame(f)) = (keep_up, &msg) {
                if let Some(s) = weak.upgrade() {
                    let _ = s.release(&sid, f.lease);
                }
            }
            log2.lock().unwrap().push(msg);
        });
        sessions
            .open(id, path, options, sink)
            .map(|info| (info, log))
    }

    fn open_keeping_up(sessions: &Arc<PreviewSessions>, id: &str, path: &str) -> Log {
        open(sessions, id, path, PreviewOpenOptions::default(), true)
            .expect("open")
            .1
    }

    fn frames(log: &Log) -> Vec<Frame> {
        log.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                Seen::Frame(f) => Some(f.clone()),
                _ => None,
            })
            .collect()
    }

    fn pts(log: &Log) -> Vec<i64> {
        frames(log).iter().map(|f| f.pts).collect()
    }

    fn ends(log: &Log) -> usize {
        log.lock()
            .unwrap()
            .iter()
            .filter(|m| **m == Seen::End)
            .count()
    }

    #[test]
    fn open_then_request_delivers_a_frame() {
        let s = Arc::new(PreviewSessions::new());
        let (info, log) = open(&s, "s1", PRORES, PreviewOpenOptions::default(), true).unwrap();
        assert_eq!(info.width, 320);
        s.fill_from("s1", 0, 1).unwrap();
        assert!(wait_for(|| !frames(&log).is_empty()), "no frame arrived");
        s.close("s1").unwrap();
        let first = &frames(&log)[0];
        // Do NOT assert colour: frames carry none, and the synthetic fixture may
        // leave its stream tags unspecified anyway.
        assert_eq!(first.width, 320, "frame width");
        assert!(first.pts >= 0, "expected pts_us >= 0, got {}", first.pts);
    }

    #[test]
    fn open_reports_the_shipped_dimensions_and_honors_the_small_source_floor() {
        // The 320x240 fixture is already at the floor, so even a ¼ request ships
        // full size — and `open`'s reply must agree with the frames, or the
        // renderer sizes its texture against a resolution that never arrives.
        let s = Arc::new(PreviewSessions::new());
        let options = PreviewOpenOptions {
            out_scale: OutScale::from_divisor(4),
            ..PreviewOpenOptions::default()
        };
        let (info, log) = open(&s, "sc1", PRORES, options, true).unwrap();
        assert_eq!((info.width, info.height), (320, 240));
        s.fill_from("sc1", 0, 1).unwrap();
        assert!(wait_for(|| !frames(&log).is_empty()), "no frame arrived");
        s.close("sc1").unwrap();
        let first = &frames(&log)[0];
        assert_eq!((first.width, first.height), (info.width, info.height));
        assert_eq!(first.len, (320 * 240) + (320 * 240 / 2));
    }

    // The wired session path for the macOS copy-back lane (issue #10): the
    // session must open on VideoToolbox and deliver the SAME NV12 frames the
    // software lane does. Deterministic on any macOS host (VideoToolbox is an
    // OS framework; see the decoder tests), unlike NVDEC/VAAPI whose session
    // proof stays manual/bench.
    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_session_delivers_nv12_frames() {
        let s = Arc::new(PreviewSessions::new());
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_h264.mp4");
        let options = PreviewOpenOptions {
            accel: DecodeAccel::VideoToolbox,
            ..PreviewOpenOptions::default()
        };
        let (info, log) = open(&s, "vt1", p, options, true).expect("open on videotoolbox");
        assert_eq!((info.width, info.height), (192, 144));
        s.fill_from("vt1", 0, 1).unwrap();
        assert!(wait_for(|| !frames(&log).is_empty()), "no frame arrived");
        s.close("vt1").unwrap();
        let first = &frames(&log)[0];
        // Same ship-bytes NV12 shape as software (ADR 0029) — packed w*h*3/2.
        assert_eq!(first.format, PlaneFormat::Nv12);
        assert_eq!((first.width, first.height), (192, 144));
        assert_eq!(first.len, (192 * 144) + (192 * 144 / 2));
    }

    // A 10-bit source on the VideoToolbox lane (issue #10) opens with I420P10
    // output — the session decodes on the OS media engine, copies back, and
    // ships tightly-packed u16LE I420P10 frames whose byte length is exactly
    // what the renderer's `tenBitFrameFromBytes` adapter expects (w*h*3 for
    // even dims; a drift there throws, so the length IS the contract). HEVC
    // Main10 rather than ProRes so the hw path truly engages on EVERY macOS host
    // (the ProRes VT decoder needs a ProRes-engine chip — see the decoder tests).
    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_session_delivers_i420p10_frames() {
        let s = Arc::new(PreviewSessions::new());
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_hevc10.mp4"
        );
        let options = PreviewOpenOptions {
            accel: DecodeAccel::VideoToolbox,
            out_format: SwOutFormat::I420p10,
            ..PreviewOpenOptions::default()
        };
        let (info, log) =
            open(&s, "vtp10", p, options, true).expect("open HEVC Main10 with I420P10 output");
        assert_eq!((info.width, info.height), (192, 144));
        s.fill_from("vtp10", 0, 1).unwrap();
        assert!(wait_for(|| !frames(&log).is_empty()), "no frame arrived");
        s.close("vtp10").unwrap();
        let first = &frames(&log)[0];
        assert_eq!(first.format, PlaneFormat::I420p10, "frame format tag");
        // u16LE Y (w*h) + U + V at (w/2)*(h/2) → 3 bytes/px on even dims — the
        // exact `tenBitFrameFromBytes` layout.
        assert_eq!((first.width, first.height), (192, 144));
        assert_eq!(first.len, 192 * 144 * 3);
    }

    #[test]
    fn long_gop_request_forward_decodes_to_target() {
        // MPEG-2 is long-GOP (GOP 15 here): AVSEEK_FLAG_BACKWARD lands on a
        // keyframe well before the target, so serve_request must decode-forward to
        // the frame COVERING the target. Without that it would deliver the
        // keyframe at ~0.5 s.
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "m1", MPEG2);
        s.fill_from("m1", 800_000, 1).unwrap(); // ~frame 24, mid-GOP
        assert!(wait_for(|| !frames(&log).is_empty()), "no frame arrived");
        s.close("m1").unwrap();
        let first = pts(&log)[0];
        assert!(
            (700_000..=900_000).contains(&first),
            "first delivered pts {first} should cover target 800_000, not the keyframe (~500_000)"
        );
    }

    #[test]
    fn a_panic_is_one_terminal_error_and_the_sessions_stay_usable() {
        // A panic on the session thread must NOT silently kill the thread (the
        // renderer would wait forever) and must NOT cascade. The sink panics on
        // its FIRST call while the runtime holds its lock, which poisons it: the
        // runtime still reports the panic in band and still closes.
        let calls = Arc::new(Mutex::new(0usize));
        let log: Log = Arc::default();
        let (calls2, log2) = (Arc::clone(&calls), Arc::clone(&log));
        let s = PreviewSessions::new();
        let sink: Sink = Box::new(move |msg| {
            let n = {
                let mut c = calls2.lock().unwrap();
                *c += 1;
                *c
            };
            if n == 1 {
                panic!("boom in preview-sw sink");
            }
            log2.lock().unwrap().push(seen(msg));
        });
        s.open("p1", PRORES, PreviewOpenOptions::default(), sink)
            .unwrap();
        s.fill_from("p1", 0, 1).unwrap();
        assert!(
            wait_for(|| !log.lock().unwrap().is_empty()),
            "the panic never reached the sink"
        );
        s.close("p1")
            .expect("the session closes after a caught panic");
        let got = log.lock().unwrap().clone();
        match got.as_slice() {
            [Seen::Error { message, terminal }] => {
                assert!(message.contains("panicked"), "{message}");
                assert!(terminal, "a panic ends the session");
            }
            other => panic!("expected one terminal error, got {other:?}"),
        }
        let s = Arc::new(s);
        let log = open_keeping_up(&s, "p1", PRORES);
        s.fill_from("p1", 0, 1).unwrap();
        assert!(
            wait_for(|| !frames(&log).is_empty()),
            "the id did not reopen"
        );
        s.close("p1").unwrap();
    }

    #[test]
    fn cancel_stops_the_request_in_progress_and_serves_nothing_queued() {
        // Close sets the session's cancel flag before anything else (the
        // runtime's tests show that). Here the flag goes up while the first
        // frame of a burst is being delivered, with more requests queued behind
        // it: the burst stops before its next frame and the queue is dropped.
        let stream = SwVideoStream::open_with_accel(
            MPEG2,
            SwOutFormat::Nv12,
            DecodeAccel::Software,
            OutScale::FULL,
            PlaneColor::BT709_LIMITED,
        )
        .unwrap();
        let shared = Arc::new(PreviewShared::new());
        let (tx, rx) = mpsc::channel();
        let queued = Mutex::new(Some(tx.clone()));
        let own: Arc<OnceLock<SessionCtx>> = Arc::default();
        let own2 = Arc::clone(&own);
        let delivered = Arc::new(Mutex::new(0usize));
        let delivered2 = Arc::clone(&delivered);
        let ctx = SessionCtx::for_test(Box::new(move |msg| {
            if let DecodeMsg::Bytes { .. } = msg {
                *delivered2.lock().unwrap() += 1;
                if let Some(tx) = queued.lock().unwrap().take() {
                    // Alternate targets so each request, if served, is a seek
                    // and a burst that delivers frames.
                    for i in 0..64u32 {
                        let target_us = if i % 2 == 0 { 800_000 } else { 0 };
                        tx.send(PreviewCmd::Request {
                            target_us,
                            request_id: i + 2,
                        })
                        .unwrap();
                    }
                    own2.get().unwrap().cancel();
                }
            }
        }));
        assert!(own.set(ctx.clone()).is_ok());
        shared.newest.store(1, Ordering::Release);
        tx.send(PreviewCmd::Request {
            target_us: 0,
            request_id: 1,
        })
        .unwrap();
        drop(tx);
        run_session("c1".into(), stream, rx, ctx, shared);
        assert_eq!(
            *delivered.lock().unwrap(),
            1,
            "the burst went on after cancel, or the queue behind it was served"
        );
    }

    #[test]
    fn scrub_storm_coalesces_to_latest_target() {
        // Latest-wins drain: a queued scrub storm must NOT be served FIFO.
        //
        // "Exactly one burst" is not assertable — the session thread races the
        // send loop and may serve a few drain generations. The two invariants
        // that hold under every interleaving: (a) the LAST target's burst IS
        // emitted, and (b) target 0 was served at most once (its low-pts frames
        // fit inside a single burst).
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "lw1", MPEG2);
        // N-1 superseded requests at target 0 (burst pts ~0..135_000), then ONE
        // final request at 800_000 (burst pts >= 700_000, proven by
        // `long_gop_request_forward_decodes_to_target`). The two targets are
        // distinguishable by pts range with a wide dead zone between.
        const N: usize = 100;
        for _ in 0..(N - 1) {
            s.fill_from("lw1", 0, 1).unwrap();
        }
        s.fill_from("lw1", 800_000, 2).unwrap();
        // The wait only runs out if the final request is never served at all.
        wait_for(|| pts(&log).iter().any(|&v| v >= 700_000));
        s.close("lw1").unwrap();
        let pts = pts(&log);
        assert!(
            pts.iter().any(|&v| (700_000..=900_000).contains(&v)),
            "final target's burst missing from {pts:?}"
        );
        let low = pts.iter().filter(|&&v| v < 500_000).count();
        assert!(
            low <= MAX_BURST_FRAMES,
            "target 0 was served more than once ({low} low-pts frames, one burst is at most {MAX_BURST_FRAMES}); the {} superseded requests are not being coalesced",
            N - 1
        );
    }

    #[test]
    fn forward_playback_never_re_emits_a_frame() {
        // THE flow-control invariant. Playback issues one request per tick with
        // the target advancing one frame and the request id unchanged; each must
        // continue the previous decode pass, never re-seek and re-deliver frames
        // the consumer already holds.
        //
        // Duplicates are the assertion because they are interleaving-proof: the
        // latest-wins drain may skip targets (fewer frames), but no scheduling
        // can make a strictly-forward walk emit one PTS twice.
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "fw1", MPEG2);
        const TICKS: i64 = 30;
        const STEP_US: i64 = 1_000_000 / 30;
        for i in 0..TICKS {
            s.fill_from("fw1", i * STEP_US, 1).unwrap();
            // Space the ticks so most are served rather than coalesced away —
            // this is a playback cadence, not a scrub storm.
            thread::sleep(Duration::from_millis(5));
        }
        // The last request is always served (latest wins) and its horizon holds
        // frames past its target, so delivery gets past that target. The pause
        // is for a frame beyond the horizon to show.
        let last_target = (TICKS - 1) * STEP_US;
        let reached = wait_for(|| pts(&log).last().is_some_and(|&v| v > last_target));
        thread::sleep(QUIET);
        s.close("fw1").unwrap();
        let pts = pts(&log);
        assert!(reached, "delivery never got past the last target: {pts:?}");
        let mut sorted = pts.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            pts.len(),
            "a PTS was delivered twice — the lane re-seeked and re-decoded: {pts:?}"
        );
        assert!(
            pts.windows(2).all(|w| w[0] < w[1]),
            "delivery is not monotonic; a forward tick re-seeked: {pts:?}"
        );
        // Nothing beyond the last target's horizon: the burst is bounded by the
        // horizon, not by how fast the decoder can run.
        assert!(
            *pts.last().unwrap() <= last_target + LOOKAHEAD_HORIZON_US,
            "delivered {} us, past the {} us horizon of the last target",
            pts.last().unwrap(),
            last_target + LOOKAHEAD_HORIZON_US
        );
    }

    #[test]
    fn one_request_fills_exactly_the_horizon() {
        // The fixture is 8 frames at 8 fps (125 ms each), so a 500 ms horizon from
        // target 0 is frames 0..=4 and nothing more — an exact count, no timing
        // slack. Intra, so the seek lands on the covering frame with no prefix.
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "hz1", PRORES);
        s.fill_from("hz1", 0, 1).unwrap();
        // Wait for the five, then leave time for a sixth to show.
        wait_for(|| pts(&log).len() >= 5);
        thread::sleep(QUIET);
        s.close("hz1").unwrap();
        assert_eq!(
            pts(&log),
            vec![0, 125_000, 250_000, 375_000, 500_000],
            "one request must deliver exactly the horizon"
        );
    }

    #[test]
    fn backward_request_reseeks_and_redelivers() {
        // The continuation must not swallow a backward scrub: a target behind the
        // last one re-seeks, and the earlier frames are delivered AGAIN (the
        // consumer's ring has evicted them by then — that is why it asked).
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "bw1", PRORES);
        // The horizon of 750_000 reaches past the end of the 1 s fixture, so the
        // forward burst ends in an End: after it, every frame is the backward
        // request's.
        s.fill_from("bw1", 750_000, 1).unwrap();
        assert!(
            wait_for(|| ends(&log) == 1),
            "the forward burst never reached the end of the material"
        );
        let after_forward = pts(&log).len();
        s.fill_from("bw1", 0, 2).unwrap();
        wait_for(|| pts(&log).len() > after_forward);
        s.close("bw1").unwrap();
        let pts = pts(&log);
        assert_eq!(
            pts[..after_forward].first().copied(),
            Some(750_000),
            "forward request should start at its target: {pts:?}"
        );
        assert_eq!(
            pts.get(after_forward).copied(),
            Some(0),
            "backward request must re-seek and re-deliver from 0: {pts:?}"
        );
    }

    #[test]
    fn the_end_follows_the_last_frame_in_band() {
        // Frames and the end share one channel in the order the session produced
        // them, so the consumer never sees the end before the frames it closes.
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "e1", PRORES);
        s.fill_from("e1", 750_000, 1).unwrap();
        assert!(wait_for(|| ends(&log) == 1), "no end arrived");
        s.close("e1").unwrap();
        let got = log.lock().unwrap().clone();
        let tail: Vec<_> = got
            .iter()
            .map(|m| match m {
                Seen::Frame(f) => Some(f.pts),
                _ => None,
            })
            .collect();
        assert_eq!(
            tail,
            vec![Some(750_000), Some(875_000), None],
            "expected the two tail frames, then the end: {got:?}"
        );
        assert_eq!(got.last(), Some(&Seen::End));
    }

    #[test]
    fn ticking_past_eof_stays_quiet() {
        // Past the end of the material the renderer keeps ticking with the same
        // request id. The drained cursor absorbs those ticks — one End, and no
        // repeat of the last frame.
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "eof1", PRORES);
        // 875_000 is the last frame of the 1 s fixture; the three ticks after it
        // are past the material.
        s.fill_from("eof1", 875_000, 1).unwrap();
        assert!(
            wait_for(|| ends(&log) == 1),
            "the tail request never reached the end of the material"
        );
        for t in [908_000, 941_000, 974_000] {
            s.fill_from("eof1", t, 1).unwrap();
            thread::sleep(TICK);
        }
        // The channel is served in order, so a frame of this backward request
        // means every tick before it has been taken.
        s.fill_from("eof1", 0, 2).unwrap();
        wait_for(|| pts(&log).contains(&0));
        s.close("eof1").unwrap();
        let pts = pts(&log);
        assert_eq!(
            pts.get(..2),
            Some(&[875_000, 0][..]),
            "the tail frame was re-delivered: {pts:?}"
        );
        assert_eq!(
            ends(&log),
            1,
            "each post-eof tick re-discovered eof instead of short-circuiting"
        );
    }

    #[test]
    fn far_past_eof_ticks_do_not_reseek() {
        // A target FURTHER than FORWARD_CONTINUE_US past the material (a
        // playhead parked way past a short clip): the seek lands at the tail
        // and EOF is rediscovered — once. The EOF arms advance the frontier to
        // the target, which keeps every later tick inside the continue window.
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "feof1", PRORES);
        // The fixture is 1 s; 5 s is > FORWARD_CONTINUE_US past its tail, and
        // the tail frame itself is past-discarded — the request yields only an
        // End. The +33 ms ticks after it stay within the continue window of the
        // advanced frontier, so the drained cursor must absorb them.
        s.fill_from("feof1", 5_000_000, 1).unwrap();
        assert!(
            wait_for(|| ends(&log) == 1),
            "the far-past-EOF request never reported the end of the material"
        );
        for t in [5_033_000, 5_066_000, 5_099_000] {
            s.fill_from("feof1", t, 1).unwrap();
            thread::sleep(TICK);
        }
        // The channel is served in order, so a frame of this backward request
        // means every tick before it has been taken.
        s.fill_from("feof1", 0, 2).unwrap();
        wait_for(|| !pts(&log).is_empty());
        s.close("feof1").unwrap();
        let pts = pts(&log);
        assert_eq!(
            pts.first().copied(),
            Some(0),
            "a far-past-EOF target must deliver no frames: {pts:?}"
        );
        assert_eq!(
            ends(&log),
            1,
            "each far-past-eof tick re-seeked and re-discovered eof instead of going quiet"
        );
    }

    /// Open `id` on the 1 s ProRes fixture with leases left to the test, and
    /// fill its window: request 1 at 0 takes the five frames of its horizon,
    /// request 2 at 500 ms the rest of the window. Returns the log.
    fn open_with_a_full_window(s: &Arc<PreviewSessions>, id: &str) -> Log {
        let (_, log) = open(s, id, PRORES, PreviewOpenOptions::default(), false).unwrap();
        s.fill_from(id, 0, 1).unwrap();
        assert!(wait_for(|| frames(&log).len() == 5), "request 1's horizon");
        s.fill_from(id, 500_000, 2).unwrap();
        assert!(
            wait_for(|| frames(&log).len() == WINDOW_FRAMES as usize),
            "request 2 never filled the window"
        );
        thread::sleep(QUIET);
        assert_eq!(
            frames(&log).len(),
            WINDOW_FRAMES as usize,
            "frames went out beyond the window"
        );
        log
    }

    #[test]
    fn a_full_window_holds_production_and_a_new_request_does_not_forgive_it() {
        let s = Arc::new(PreviewSessions::new());
        let log = open_with_a_full_window(&s, "w1");
        // A seek changes the request but forgives no lease still in flight.
        s.fill_from("w1", 0, 3).unwrap();
        thread::sleep(QUIET);
        assert_eq!(
            frames(&log).len(),
            WINDOW_FRAMES as usize,
            "a new request widened a full window"
        );
        assert_eq!(ends(&log), 0, "the held frame was skipped");
        // Close does not wait for the leases.
        s.close("w1").unwrap();
    }

    #[test]
    fn a_full_window_never_parks_the_session() {
        // The window is full while request 2 still has a frame to send. A
        // newer request arrives, then one lease comes back: the one free place
        // goes to the newer request's first frame. A session parked on the
        // window would have woken on that lease and shipped request 2's frame.
        let s = Arc::new(PreviewSessions::new());
        let log = open_with_a_full_window(&s, "np1");
        s.fill_from("np1", 0, 3).unwrap();
        let first_lease = frames(&log)[0].lease;
        assert!(s.release("np1", first_lease).unwrap());
        assert!(
            wait_for(|| frames(&log).len() > WINDOW_FRAMES as usize),
            "the returned lease was not used"
        );
        thread::sleep(QUIET);
        s.close("np1").unwrap();
        let after: Vec<_> = frames(&log)[WINDOW_FRAMES as usize..]
            .iter()
            .map(|f| (f.request_id, f.pts))
            .collect();
        assert_eq!(
            after,
            vec![(Some(3), 0)],
            "one lease back must send exactly the newest request's first frame"
        );
    }

    #[test]
    fn leases_return_by_id_once() {
        let s = Arc::new(PreviewSessions::new());
        let log = open_with_a_full_window(&s, "l1");
        let leases: Vec<u32> = frames(&log).iter().map(|f| f.lease).collect();
        let mut distinct = leases.clone();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(distinct.len(), leases.len(), "two frames share a lease");
        s.fill_from("l1", 0, 3).unwrap();
        assert!(s.release("l1", leases[0]).unwrap(), "an in-flight lease");
        assert!(!s.release("l1", leases[0]).unwrap(), "a lease returns once");
        assert!(
            !s.release("l1", leases.iter().max().unwrap() + 1000)
                .unwrap(),
            "a lease never granted"
        );
        assert!(
            s.release("l1", leases[1]).unwrap(),
            "another in-flight lease is still its own"
        );
        // Two leases came back, so exactly two more frames go out.
        assert!(wait_for(|| frames(&log).len() == WINDOW_FRAMES as usize + 2));
        thread::sleep(QUIET);
        assert_eq!(
            frames(&log).len(),
            WINDOW_FRAMES as usize + 2,
            "the ignored returns widened the window"
        );
        s.close("l1").unwrap();
        assert!(
            s.release("l1", leases[2]).is_err(),
            "no session after close"
        );
    }

    #[test]
    fn frames_carry_the_request_they_answer() {
        let s = Arc::new(PreviewSessions::new());
        let log = open_keeping_up(&s, "r1", PRORES);
        s.fill_from("r1", 0, 7).unwrap();
        assert!(wait_for(|| frames(&log).len() == 5), "request 7's horizon");
        s.fill_from("r1", 250_000, 8).unwrap();
        assert!(
            wait_for(|| frames(&log).iter().any(|f| f.request_id == Some(8))),
            "request 8 delivered nothing"
        );
        thread::sleep(QUIET);
        s.close("r1").unwrap();
        let ids: Vec<_> = frames(&log).iter().map(|f| f.request_id).collect();
        let split = ids.iter().position(|id| *id == Some(8)).unwrap();
        assert!(
            ids[..split].iter().all(|id| *id == Some(7))
                && ids[split..].iter().all(|id| *id == Some(8)),
            "each frame names the request it answers: {ids:?}"
        );
        // A new id re-seeks: request 8 starts again at its own target.
        assert_eq!(frames(&log)[split].pts, 250_000);
    }
}
