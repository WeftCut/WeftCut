//! Per-source GPU preview session: a pool of shared RGBA8 textures and the
//! anchor-driven request driver ([`run_session`], `SessionState::pump`) that
//! fills it, run on the carrier's [`SessionRuntime`].
//!
//! Owns: the session's thread body, which opens the `VideoStream`, builds the
//! pool on ffmpeg's own D3D11 device (the NV12→RGBA convert target) and
//! announces each filled slot in band as [`DecodeMsg::Slot`]; the slot
//! protocol (fill generation, lease reclaim); the session's timing probe.
//!
//! Does NOT own the session lifecycle or the panic boundary
//! (`carrier::SessionRuntime`), the shared texture and its keyed mutex
//! (`weftcut_d3d`), the decode surface (`decoder`) or the colour conversion
//! (`convert`).
//!
//! Slot coherence: a slot is overwritten only after a release of its current
//! generation marked it free. That release, sent once the consumer's
//! cross-device read has GPU-completed, *not* the keyed mutex across the async
//! `createImageBitmap` boundary, is the coherence guarantee. With
//! `pool_size >= 2` the producer fills slot B while the renderer still snapshots
//! slot A. The keyed mutex only serialises our GPU write against Chromium's GPU
//! read of the same texture.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use weftcut_d3d::{handle_to_bytes, luid_string, AcquireError, KeyedMutexGuard, SharedTexture};
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R8G8B8A8_UNORM;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;

use super::convert::ConvertPass;
use super::decoder::{StreamFrame, VideoStream};
use crate::carrier::{DecodeMsg, SessionCtx, SessionRuntime, SessionShared, Sink};
use crate::recover::LockExt;

/// Cap on retained timing samples per metric. A 30s throughput window at native's
/// ~44fps yields ~1300 samples — far under this; the cap is only a runaway backstop
/// (timing is native-only, so WebCodecs frame rates never reach it). Stop-appending
/// once full (keeps the earliest, steady-state samples).
pub const TIMING_SAMPLE_CAP: usize = 20_000;

/// Per-metric millisecond summary handed across the napi boundary (mapped to a
/// `#[napi(object)]` in `backend.rs`). Percentiles use linear interpolation
/// over ascending samples, matching the TS-side `percentile` convention.
#[derive(Clone, Copy)]
pub struct TimingSummary {
    pub count: u32,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Everything `TimingAccum::drain` produces for one bench window.
pub struct TimingReport {
    /// Whole JS coordination round-trip: `Slot` emit -> main relay -> preload
    /// getVideoFrame/createImageBitmap -> release relayed back to this thread.
    pub coord_rtt: TimingSummary,
    /// Decode + GPU-convert cost for one delivered frame (`next_frame` +
    /// `convert_frame_into_slot`) — CPU wall time, submission included.
    pub decode_copy: TimingSummary,
    /// GPU-side cost of the NV12→RGBA conversion pass (staging copy + draw),
    /// measured with timestamp-disjoint queries on the decode device. A
    /// SUBSAMPLE: one bracket in flight at a time, polled non-blocking, so
    /// `count` legitimately trails the delivered-frame count.
    pub convert_gpu: TimingSummary,
    /// Bottleneck probe: gap from a slot's release (slot freed on this thread)
    /// to the *next* `Slot` emitted into that same slot. This is the one
    /// per-slot-cycle segment `coord_rtt` (emit->ack) does NOT cover; by
    /// telescoping, `coord_rtt.mean + ack_to_emit.mean` ~= the slot's inter-emit
    /// period (`pool_size * frame_interval`), so whichever is larger localises the
    /// throughput ceiling. A large `ack_to_emit` = the pump idles between freeing a
    /// slot and refilling it (Rust-side); a small one = the ceiling is the ack
    /// arrival rate (renderer-side).
    pub ack_to_emit: TimingSummary,
    /// Corroborates `ack_to_emit`'s mechanism: count of `pump` early-returns caused
    /// by the lookahead gate *while a free slot was available*. If large, the pump
    /// idle is the lookahead/anchor gate (anchor not advancing); if ~0, the idle is
    /// pool-full (waiting on the renderer's ack cadence), not the gate. The only
    /// other early-returns with a free slot are `eof` (excluded mid-stream) and
    /// the acquire-failed return (counted apart as `acquire_failed`).
    pub lookahead_gated_skips: u64,
    /// Frames `pump` discarded as already-late (see `LATE_FRAME_DROP_US`) rather
    /// than copying + delivering. This is the drop policy's own meter: 0 means the
    /// pipeline kept up, sustained non-zero means decode fell behind and the drop
    /// is what kept the delivery chain (and the displayed lag) bounded.
    pub late_frame_drops: u64,
    /// Session-thread cadence, measured in the thread's own clock:
    /// gap between consecutive `Slot` emits (ANY slot) — the true production interval.
    pub inter_emit: TimingSummary,
    /// gap between consecutive release arrivals (ANY slot) — the ack cadence.
    pub inter_ack: TimingSummary,
    /// duration of each `recv_timeout` call: ~0 when a message was already queued,
    /// ~`RECV_TIMEOUT` (4ms) when the thread blocked idle. Its sum ~= total thread
    /// idle time; a sum near the window means the thread is starved, not busy.
    pub recv_block: TimingSummary,
    /// How the thread woke, tallied over the window: 4ms `recv_timeout` expirations
    /// (idle ticks), `Release` messages, and `RequestFrameAt` messages. Together
    /// with `inter_emit` these say whether production is paced by acks, by anchor
    /// nudges, or by the idle tick.
    pub recv_timeout_ticks: u64,
    pub recv_ack_msgs: u64,
    pub recv_req_msgs: u64,
    /// Stall attribution. Every `pump` early-return increments exactly one of
    /// these; the dominant one over the run names the halt:
    /// `eof_returns` = decoder ended, `pool_full_returns` = no free slot
    /// (slots stuck busy — renderer stopped acking), `acquire_failed` = keyed-mutex
    /// AcquireSync timed out (slot held by Chromium), `lookahead_gated_skips`
    /// (above) = anchor not advancing.
    pub eof_returns: u64,
    pub pool_full_returns: u64,
    pub acquire_failed: u64,
    /// Terminal state snapshot (last `pump` early-return wins): free-slot count and
    /// the eof flag when the pump last gave up. `free_slots == 0` at end confirms a
    /// pool-full stall; `eof == true` confirms a decoder end.
    pub final_free_slots: u32,
    pub final_eof: bool,
    /// Fencing-token protocol counters. `lease_timeouts` = delivered slots the
    /// owner reclaimed after [`LEASE_TIMEOUT`] with no ack (each is one
    /// possibly-torn frame traded against a wedge — routine non-zero means the
    /// consumer is stalling). `stale_gen_acks` = acks dropped on a generation
    /// mismatch (the ABA the token exists to catch, usually the late ack of a
    /// reclaimed lease arriving after the slot refilled).
    pub lease_timeouts: u64,
    pub stale_gen_acks: u64,
    /// This session's shared-pool VRAM: `width × height × 4 (RGBA8) × slots`.
    /// Static per session — stamped by `take_timings` from the session's
    /// shared state, NOT accumulated (drain leaves it 0).
    pub pool_slot_bytes: u64,
}

/// Session-thread timing accumulator. Nanosecond samples in; drained to ms summaries.
#[derive(Default)]
pub struct TimingAccum {
    coord_rtt_ns: Vec<u64>,
    decode_copy_ns: Vec<u64>,
    convert_gpu_ns: Vec<u64>,
    ack_to_emit_ns: Vec<u64>,
    lookahead_gated_skips: u64,
    late_frame_drops: u64,
    inter_emit_ns: Vec<u64>,
    inter_ack_ns: Vec<u64>,
    recv_block_ns: Vec<u64>,
    recv_timeout_ticks: u64,
    recv_ack_msgs: u64,
    recv_req_msgs: u64,
    eof_returns: u64,
    pool_full_returns: u64,
    acquire_failed: u64,
    final_free_slots: u32,
    final_eof: bool,
    lease_timeouts: u64,
    stale_gen_acks: u64,
}

impl TimingAccum {
    fn push_capped(buf: &mut Vec<u64>, ns: u64) {
        if buf.len() < TIMING_SAMPLE_CAP {
            buf.push(ns);
        }
    }
    pub fn push_coord_rtt(&mut self, ns: u64) {
        Self::push_capped(&mut self.coord_rtt_ns, ns);
    }
    pub fn push_decode_copy(&mut self, ns: u64) {
        Self::push_capped(&mut self.decode_copy_ns, ns);
    }
    pub fn push_convert_gpu(&mut self, ns: u64) {
        Self::push_capped(&mut self.convert_gpu_ns, ns);
    }
    pub fn push_ack_to_emit(&mut self, ns: u64) {
        Self::push_capped(&mut self.ack_to_emit_ns, ns);
    }
    /// A `pump` pass found a free slot but the lookahead gate stopped it decoding.
    /// Saturating so the runaway backstop matches the sample cap's intent (a 30s
    /// window can only tick the pump ~7.5k times via `RECV_TIMEOUT`, far under u64).
    pub fn note_lookahead_gated_skip(&mut self, free_slots: u32, eof: bool) {
        self.lookahead_gated_skips = self.lookahead_gated_skips.saturating_add(1);
        // Record the terminal snapshot here TOO. LANDMINE: this return used to be
        // the only pump early-exit that left `final_free_slots` alone, so a
        // gate-wedged session reported a stale `final_free_slots: 0` from some
        // earlier pool-full return — reading as pool starvation when the pool was
        // fine. That cost a diagnosis. Every early-exit must stamp the snapshot.
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    /// A decoded frame was discarded as already-late (`pump`'s late-frame drop)
    /// instead of being copied + delivered. Non-zero means the drop policy is
    /// actively protecting the delivery chain; a run with sustained non-zero here
    /// is a run where decode could not keep up.
    pub fn note_late_frame_drop(&mut self) {
        self.late_frame_drops = self.late_frame_drops.saturating_add(1);
    }
    pub fn push_inter_emit(&mut self, ns: u64) {
        Self::push_capped(&mut self.inter_emit_ns, ns);
    }
    pub fn push_inter_ack(&mut self, ns: u64) {
        Self::push_capped(&mut self.inter_ack_ns, ns);
    }
    pub fn push_recv_block(&mut self, ns: u64) {
        Self::push_capped(&mut self.recv_block_ns, ns);
    }
    pub fn note_recv_timeout(&mut self) {
        self.recv_timeout_ticks = self.recv_timeout_ticks.saturating_add(1);
    }
    pub fn note_recv_ack(&mut self) {
        self.recv_ack_msgs = self.recv_ack_msgs.saturating_add(1);
    }
    pub fn note_recv_req(&mut self) {
        self.recv_req_msgs = self.recv_req_msgs.saturating_add(1);
    }
    /// Pump-stop attribution. Each records the terminal free-slot count +
    /// eof flag (last-write-wins) alongside its reason tally.
    pub fn note_eof_return(&mut self, free_slots: u32, eof: bool) {
        self.eof_returns = self.eof_returns.saturating_add(1);
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    pub fn note_pool_full_return(&mut self, free_slots: u32, eof: bool) {
        self.pool_full_returns = self.pool_full_returns.saturating_add(1);
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    pub fn note_acquire_failed(&mut self, free_slots: u32, eof: bool) {
        self.acquire_failed = self.acquire_failed.saturating_add(1);
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    /// A delivered slot's lease expired and the owner reclaimed it (gen bump).
    pub fn note_lease_timeout(&mut self) {
        self.lease_timeouts = self.lease_timeouts.saturating_add(1);
    }
    /// A release was dropped because its generation didn't match the
    /// slot's current fill.
    pub fn note_stale_gen_ack(&mut self) {
        self.stale_gen_acks = self.stale_gen_acks.saturating_add(1);
    }
    /// Compute the summaries and clear the buffers.
    pub fn drain(&mut self) -> TimingReport {
        let report = TimingReport {
            coord_rtt: summarize(&self.coord_rtt_ns),
            decode_copy: summarize(&self.decode_copy_ns),
            convert_gpu: summarize(&self.convert_gpu_ns),
            ack_to_emit: summarize(&self.ack_to_emit_ns),
            lookahead_gated_skips: self.lookahead_gated_skips,
            late_frame_drops: self.late_frame_drops,
            inter_emit: summarize(&self.inter_emit_ns),
            inter_ack: summarize(&self.inter_ack_ns),
            recv_block: summarize(&self.recv_block_ns),
            recv_timeout_ticks: self.recv_timeout_ticks,
            recv_ack_msgs: self.recv_ack_msgs,
            recv_req_msgs: self.recv_req_msgs,
            eof_returns: self.eof_returns,
            pool_full_returns: self.pool_full_returns,
            acquire_failed: self.acquire_failed,
            final_free_slots: self.final_free_slots,
            final_eof: self.final_eof,
            lease_timeouts: self.lease_timeouts,
            stale_gen_acks: self.stale_gen_acks,
            pool_slot_bytes: 0,
        };
        self.coord_rtt_ns.clear();
        self.decode_copy_ns.clear();
        self.convert_gpu_ns.clear();
        self.ack_to_emit_ns.clear();
        self.lookahead_gated_skips = 0;
        self.late_frame_drops = 0;
        self.inter_emit_ns.clear();
        self.inter_ack_ns.clear();
        self.recv_block_ns.clear();
        self.recv_timeout_ticks = 0;
        self.recv_ack_msgs = 0;
        self.recv_req_msgs = 0;
        self.eof_returns = 0;
        self.pool_full_returns = 0;
        self.acquire_failed = 0;
        self.final_free_slots = 0;
        self.final_eof = false;
        self.lease_timeouts = 0;
        self.stale_gen_acks = 0;
        report
    }
}

fn summarize(samples: &[u64]) -> TimingSummary {
    if samples.is_empty() {
        return TimingSummary {
            count: 0,
            mean_ms: 0.0,
            p50_ms: 0.0,
            p95_ms: 0.0,
            max_ms: 0.0,
        };
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let n = sorted.len();
    let ns_to_ms = |ns: f64| ns / 1_000_000.0;
    let sum: f64 = sorted.iter().map(|&x| x as f64).sum();
    TimingSummary {
        count: n as u32,
        mean_ms: ns_to_ms(sum / n as f64),
        p50_ms: percentile_ms(&sorted, 50.0),
        p95_ms: percentile_ms(&sorted, 95.0),
        max_ms: ns_to_ms(sorted[n - 1] as f64),
    }
}

/// Linear-interpolated percentile over an ASCENDING-sorted ns slice, returned in ms.
fn percentile_ms(sorted: &[u64], p: f64) -> f64 {
    let n = sorted.len();
    if n == 1 {
        return sorted[0] as f64 / 1_000_000.0;
    }
    let idx = (p / 100.0) * (n as f64 - 1.0);
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    let frac = idx - lo as f64;
    let v = sorted[lo] as f64 + (sorted[hi] as f64 - sorted[lo] as f64) * frac;
    v / 1_000_000.0
}

/// Ceiling on the keyed-mutex wait in [`convert_frame_into_slot`]. We only ever
/// write a slot the consumer already released, so
/// Chromium isn't holding its read lock when we `AcquireSync` — a free slot
/// acquires in microseconds. This value is generous on purpose: it never
/// trips on that happy path (so it can't drop frames or skew the benchmark's
/// throughput numbers) and only fires when a slot is genuinely stuck (e.g.
/// held by Chromium past its ack), turning what would otherwise be a
/// permanent session-thread hang into an observable, recoverable skip.
const ACQUIRE_TIMEOUT_MS: u32 = 1000;

/// Owner-side lease ceiling: how long a delivered slot may sit un-acked before
/// [`SessionState::reclaim_expired_leases`] takes it back (gen bump + free +
/// counter). Two orders of magnitude above the p99 ack latency under full load
/// (coord-RTT tens of ms) and 3× the AcquireSync ceiling, so it can only fire
/// on a genuinely wedged/vanished consumer — an occluded renderer whose
/// rAF-paced ack stalled, a dead port, a dropped IPC message. Deliberately NOT
/// tighter: a reclaim of a slot Chromium is still reading trades one torn
/// frame for the unwedge, and that trade should stay rare.
const LEASE_TIMEOUT: Duration = Duration::from_secs(3);

/// How far ahead of the anchor the pump pre-decodes. Bounds pre-buffering so a
/// scrub doesn't decode-and-discard a long tail past the new target. ~15 frames
/// at 30 fps; in practice the pool size usually binds first (a full pool stops
/// the pump before this does). Kept <= the implicit backward tolerance so that
/// during forward playback the anchor trailing the frontier never looks like a
/// backward seek.
const LOOKAHEAD_US: i64 = 500_000;

/// A forward jump larger than this (beyond the decoded frontier) seeks to a
/// keyframe instead of decode-and-discarding the gap; smaller forward moves
/// decode naturally. Any backward move always seeks.
///
/// Also the SEED for the measured keyframe interval (`key_interval_us`) until two
/// keyframes have been seen.
const SEEK_FORWARD_THRESHOLD_US: i64 = 1_000_000;

/// Floor/ceiling on the measured-keyframe-interval resync threshold
/// (`resync_threshold_us`). The floor keeps a short-GOP source (a 0.5 s-GOP quick
/// proxy) from re-seeking on every few frames of drift — a seek still costs a
/// decoder flush plus the re-approach. The ceiling keeps a pathological
/// keyframe-once-per-minute source from disabling resync entirely.
const MIN_RESYNC_US: i64 = 250_000;
const MAX_RESYNC_US: i64 = 3_000_000;

/// How far BEHIND the anchor a decoded frame's presentation interval must end
/// before the pump discards it instead of delivering it (`pump`'s late-frame
/// drop — ffplay's `framedrop`, mpv's `--framedrop=vo`).
///
/// Not zero: the margin is the A/V lag we are willing to SHOW rather than drop,
/// so a decoder that is only slightly behind still presents its most recent
/// frames instead of going blank. 100 ms matches ffplay's `AV_SYNC_THRESHOLD_MAX`
/// and doubles as the renderer ring's own `CLAMP_TO_FIRST_GAP_US`, so a frame
/// this pump keeps is a frame the ring can still serve.
const LATE_FRAME_DROP_US: i64 = 100_000;

/// How far the anchor must fall BEHIND the decoded frontier before that counts as
/// a backward divergence worth a seek, independent of how the anchor got there.
/// Must exceed `LOOKAHEAD_US`, or ordinary paused pre-buffering (frontier legally
/// leads the anchor by up to one lookahead) would read as a backward jump and
/// re-seek forever.
const BACKWARD_DIVERGENCE_US: i64 = 2 * LOOKAHEAD_US;
// The backstop only fires beyond the pre-buffer lead it must tolerate.
const _: () = assert!(BACKWARD_DIVERGENCE_US > LOOKAHEAD_US);

/// What a forward gap must exceed before seeking beats decoding through it.
///
/// A seek is not free: it flushes the decoder and must re-decode from the key
/// packet at/before the target, so it costs up to one keyframe interval of decode.
/// Decoding forward costs the gap. So seek when `gap > keyframe interval` —
/// measured, not guessed, because the right answer differs by an order of
/// magnitude between a 0.5 s-GOP proxy and a 3 s-GOP 4K original.
///
/// This prices the SEEK arm only. Bounding the A/V lag is [`is_late_frame`]'s job;
/// dropping is what makes tolerating a long GOP affordable in the first place.
fn resync_threshold_us(key_interval_us: i64) -> i64 {
    key_interval_us.clamp(MIN_RESYNC_US, MAX_RESYNC_US)
}

/// Pure seek decision for one `request_frame_at`. `anchor` is the PREVIOUS anchor,
/// `frontier_pts` the furthest pts decoded (`i64::MIN` = nothing since open/seek).
fn needs_seek(t: i64, anchor: i64, frontier_pts: i64, key_interval_us: i64) -> bool {
    if frontier_pts == i64::MIN {
        // Nothing decoded yet: seek only if the very first target is far from the
        // container start; a target near 0 is cheaper to reach by forward decode.
        return t > SEEK_FORWARD_THRESHOLD_US;
    }
    // Playhead moved backward — forward decode can't rewind.
    //
    // The `frontier` arm is a STRUCTURAL backstop, not a restatement of the
    // `anchor` one: it keys on what we actually DECODED rather than on where the
    // anchor last was. Without it, any path that lands the anchor behind a
    // far-ahead frontier WITHOUT passing through a successful seek (a seek that
    // returned Err; a request stream resuming after the anchor was already reset)
    // leaves `pump`'s lookahead gate permanently satisfied — `frontier >= anchor +
    // LOOKAHEAD_US` forever — and the session never decodes another frame for the
    // rest of its life. Live-observed: 178 requests, 0 emits, 329/329 pump
    // attempts exiting via the gate.
    if t < anchor || t.saturating_add(BACKWARD_DIVERGENCE_US) < frontier_pts {
        return true;
    }
    // Forward move: seek only on a jump the decoder can't cheaply cover.
    t > frontier_pts.saturating_add(resync_threshold_us(key_interval_us))
}

/// Whether a decoded frame is too late to be worth DELIVERING: its presentation
/// interval ended more than [`LATE_FRAME_DROP_US`] before the playhead, so nothing
/// downstream will ever show it (the renderer's `FrameRing` binds the newest frame
/// at or before the anchor, and this is not it). ffplay's `framedrop`.
///
/// `.max(1)` on the duration guards a 0/unknown value so the frame COVERING the
/// anchor is never mistaken for a past one.
fn is_late_frame(pts_us: i64, dur_us: i64, anchor: i64) -> bool {
    pts_us
        .saturating_add(dur_us.max(1))
        .saturating_add(LATE_FRAME_DROP_US)
        <= anchor
}

/// Fold an observed keyframe pts into the interval average. EWMA 3:1 toward
/// history — smooths an open-GOP source with irregular key spacing without
/// pinning to a first outlier. A non-advancing or first-ever key is a no-op.
fn fold_key_interval(key_interval_us: i64, last_key_pts: i64, pts_us: i64) -> i64 {
    if last_key_pts == i64::MIN || pts_us <= last_key_pts {
        return key_interval_us;
    }
    (key_interval_us * 3 + (pts_us - last_key_pts)) / 4
}

/// Whether a release of `slot` at `gen` may free it: only a currently-busy slot
/// whose ack echoes the CURRENT fill generation qualifies. Exactly-once acks
/// are otherwise enforced only by JS bookkeeping spread across three processes
/// — a duplicate, stale, or out-of-range ack reaching here would free a slot
/// the renderer may still be reading, letting the pump overwrite it mid-read:
/// the exact frame reorder/tear the order gate exists to catch.
///
/// The generation check is the ABA immunity the busy flag alone cannot give:
/// after a lease timeout reclaims + refills a slot, the ORIGINAL occupant's
/// late ack arrives against a busy slot again — busy-only validation would
/// free the new frame mid-read. `gen` names WHICH occupancy the ack releases.
fn ack_frees_slot(free: &[bool], slot_gen: &[u32], slot: usize, gen: u32) -> bool {
    free.get(slot) == Some(&false) && slot_gen.get(slot) == Some(&gen)
}

/// recv timeout so the pump makes progress (freed slot -> decode) between
/// messages without busy-spinning.
const RECV_TIMEOUT: Duration = Duration::from_millis(4);

/// What a session's loop takes off its command channel.
enum GpuCmd {
    /// Set the decode anchor to this source-microsecond target.
    RequestFrameAt(i64),
    /// The consumer is done with `slot`; it may be reused. `gen` is the fill
    /// generation the slot's `DecodeMsg::Slot` carried: a mismatch is a stale
    /// release, dropped whole (see `ack_frees_slot`).
    Release { slot: u32, gen: u32 },
}

/// State a session shares with the calls that must not queue behind its loop.
pub(crate) struct GpuShared {
    /// The session thread appends to it; `take_timings` drains it.
    timing: Arc<Mutex<TimingAccum>>,
    /// `width × height × 4 (RGBA8) × slots`, set once the pool is built.
    pool_slot_bytes: AtomicU64,
}

impl SessionShared for GpuShared {}

/// What `open` hands back to the caller: the pool's per-slot NT handles in
/// their wire bytes (`weftcut_d3d::handle_to_bytes`; main passes them to
/// `importSharedTexture`) plus the frame dimensions.
pub struct OpenInfo {
    pub width: u32,
    pub height: u32,
    pub slot_handles: Vec<[u8; 8]>,
    pub adapter: Option<DecoderAdapter>,
}

/// Identity comes from the device that actually owns this decoder, never from
/// enumeration order. Only plain data crosses the decoder thread boundary.
pub struct DecoderAdapter {
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub luid: String,
}

fn decoder_adapter(device: &ID3D11Device) -> Option<DecoderAdapter> {
    let dxgi: IDXGIDevice = device.cast().ok()?;
    let desc = unsafe { dxgi.GetAdapter().ok()?.GetDesc().ok()? };
    let end = desc
        .Description
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(desc.Description.len());
    Some(DecoderAdapter {
        name: String::from_utf16_lossy(&desc.Description[..end]),
        vendor_id: desc.VendorId,
        device_id: desc.DeviceId,
        luid: luid_string(desc.AdapterLuid),
    })
}

/// Everything the session thread owns and mutates. Never leaves the thread, so
/// it needs no `Send` impl despite the `!Send` COM + ffmpeg objects.
struct SessionState {
    stream: VideoStream,
    /// ffmpeg's device, cloned (AddRef) so it outlives the decoder; the pool
    /// textures were created on it. The per-frame convert goes through `context`.
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    /// One shared RGBA8 texture per slot, overwritten in place each time the
    /// slot is (re)filled.
    pool: Vec<SharedTexture>,
    /// Session-owned NV12→RGBA conversion pass (shader compiled once at open
    /// with the stream's matrix/range constants baked in).
    convert: ConvertPass,
    /// Per-slot free flag, owned solely by this thread (acks arrive as messages,
    /// so no cross-thread access -> a plain `Vec<bool>`, no atomics needed).
    free: Vec<bool>,
    /// Per-slot fill generation — the fencing token. Bumped on every fill
    /// (and on a lease-timeout reclaim, which is what invalidates the late
    /// ack); emitted with `Slot` and echoed by `Release`. Wrapping
    /// u32: ABA across 2^32 fills of one slot is not a real risk.
    slot_gen: Vec<u32>,
    width: u32,
    height: u32,
    /// Current decode target (source microseconds). `i64::MIN` before the first
    /// `request_frame_at`.
    anchor: i64,
    /// pts of the furthest frame decoded (delivered *or* discarded); `i64::MIN`
    /// when nothing has been decoded since open or since the last seek. Drives
    /// the lookahead gate and the forward-jump seek test.
    frontier_pts: i64,
    /// pts of the last frame actually delivered; `i64::MIN` if none.
    last_delivered_pts: i64,
    /// Set right after a seek: discard decoded frames whose pts is before the
    /// anchor until the first one at/after it.
    post_seek: bool,
    /// pts of the last keyframe the pump decoded; `i64::MIN` until one is seen.
    /// Paired with `key_interval_us` to price a resync seek.
    last_key_pts: i64,
    /// Measured interval between consecutive keyframes (µs), seeded to
    /// `SEEK_FORWARD_THRESHOLD_US`, then an EWMA over observed gaps — see
    /// `resync_threshold_us`.
    key_interval_us: i64,
    /// Decoder is drained; the pump idles until a backward seek resets this.
    eof: bool,
    /// Shared through `GpuShared` so `take_timings` can drain from the Node thread.
    timing: Arc<Mutex<TimingAccum>>,
    /// `Instant` the frame in each slot was announced via `Slot`; taken and
    /// turned into a coord-RTT sample when that slot's `Release` returns. `None`
    /// when the slot is free or unacked-but-never-emitted. Sized to the pool.
    slot_emit: Vec<Option<Instant>>,
    /// `Instant` each slot's `Release` arrived on this thread; taken and turned
    /// into an `ack_to_emit` sample at the next `Slot` for that slot. `None`
    /// before a slot has ever been acked (its first fill has no prior ack, so it
    /// yields no sample). Sized to the pool. See `TimingReport::ack_to_emit`.
    slot_ack_at: Vec<Option<Instant>>,
    /// Session-level (not per-slot) last-emit / last-ack instants for the
    /// cadence probes (`inter_emit` / `inter_ack`). NOT consumed by `take` — each
    /// event overwrites the prior, and the delta is the inter-event gap.
    last_emit_at: Option<Instant>,
    last_ack_at: Option<Instant>,
}

impl SessionState {
    fn slot_handles(&self) -> Vec<[u8; 8]> {
        self.pool
            .iter()
            .map(|s| handle_to_bytes(s.handle()))
            .collect()
    }

    /// A slot the renderer has released, if any.
    fn free_slot(&self) -> Option<usize> {
        self.free.iter().position(|&f| f)
    }

    /// Turn a slot's `Slot`->`Release` gap into a coord-RTT sample, and
    /// stamp the ack instant for the `ack_to_emit` probe (sampled at this slot's
    /// next `Slot`). `Option::take` guarantees at most one coord-RTT sample
    /// per emit; an ack with no prior emit (shouldn't happen given the free-flag
    /// protocol) contributes no coord-RTT but still stamps the ack instant.
    fn record_ack(&mut self, slot: usize) {
        let now = Instant::now();
        if let Some(emit_at) = self.slot_emit.get_mut(slot).and_then(Option::take) {
            let rtt_ns = now.duration_since(emit_at).as_nanos() as u64;
            if let Ok(mut t) = self.timing.lock() {
                t.push_coord_rtt(rtt_ns);
            }
        }
        // Ack instant for the ack->next-emit gap probe; the next `pump` emit into
        // this slot takes it and records `now - this`.
        if let Some(entry) = self.slot_ack_at.get_mut(slot) {
            *entry = Some(now);
        }
        // Session-level ack cadence (any slot): gap since the previous Release.
        if let Some(prev) = self.last_ack_at.replace(now) {
            let gap_ns = now.duration_since(prev).as_nanos() as u64;
            if let Ok(mut t) = self.timing.lock() {
                t.push_inter_ack(gap_ns);
            }
        }
    }

    /// Handle a release of `slot` at generation `gen`. A duplicate, stale,
    /// out-of-range or wrong-generation release is dropped whole (no free, no
    /// coord-RTT record; see `ack_frees_slot`). Generation mismatches are
    /// counted apart from silence: routine stale releases mean the consumer is
    /// answering leases the owner already reclaimed (a latency finding).
    fn on_release(&mut self, slot: u32, gen: u32) {
        let slot = slot as usize;
        if ack_frees_slot(&self.free, &self.slot_gen, slot, gen) {
            self.record_ack(slot);
            self.free[slot] = true;
        } else if self.free.get(slot) == Some(&false) {
            if let Ok(mut t) = self.timing.lock() {
                t.note_stale_gen_ack();
            }
        }
    }

    /// Handle a `request_frame_at`: set the anchor and, if `needs_seek` says the
    /// target left the reachable forward window, seek. Decision logic is the pure
    /// [`needs_seek`] (unit-gated); this method owns only the state transition.
    fn on_request(&mut self, t: i64, ctx: &SessionCtx) {
        let needs_seek = needs_seek(t, self.anchor, self.frontier_pts, self.key_interval_us);
        self.anchor = t;
        if needs_seek {
            match self.stream.seek(t) {
                Ok(()) => {
                    self.post_seek = true;
                    self.eof = false;
                    self.frontier_pts = i64::MIN;
                    self.last_delivered_pts = i64::MIN;
                    // The next keyframe after a seek is the landing key, not the
                    // natural successor of the one before the seek, so the gap
                    // across it is not an interval. Keep the learned average.
                    self.last_key_pts = i64::MIN;
                }
                Err(e) => {
                    // Non-fatal: leave the decode position as-is and report it;
                    // the caller can retry. Don't set eof.
                    ctx.emit(DecodeMsg::Error {
                        message: format!("seek to {t}us failed: {e}"),
                        terminal: false,
                    });
                }
            }
        }
    }

    /// Decode forward into free slots until the pool is full, the lookahead is
    /// satisfied, or the stream ends. Called after every message and on every
    /// recv timeout, so freed slots get refilled promptly without busy-spinning.
    fn pump(&mut self, ctx: &SessionCtx) {
        // Lease sweep first, so a slot whose consumer vanished re-enters the
        // free pool on the same tick that would otherwise report pool-full.
        self.reclaim_expired_leases();
        loop {
            // A post-seek discard can decode up to a GOP in this loop; close
            // must not wait it out (its grace is short, see `CLOSE_GRACE`).
            if ctx.cancelled() {
                return;
            }
            if self.eof {
                let free = self.free.iter().filter(|&&f| f).count() as u32;
                if let Ok(mut t) = self.timing.lock() {
                    t.note_eof_return(free, true);
                }
                return;
            }
            // A free slot is required to decode: a deliverable frame must land
            // somewhere, and its GPU surface is only valid until the next
            // `next_frame`. Discarded (pre-anchor) frames don't consume the slot,
            // so one free slot covers the whole post-seek discard + first deliver.
            let Some(slot_idx) = self.free_slot() else {
                // pool full (free count is 0 by definition); wait for a Release.
                if let Ok(mut t) = self.timing.lock() {
                    t.note_pool_full_return(0, self.eof);
                }
                return;
            };
            // Lookahead gate: stop once decoded far enough ahead of the anchor.
            // (frontier is behind the anchor during post-seek discard, so this
            // never fires mid-discard.) A free slot is available here (checked
            // above), so a gate hit = the pump idling on the anchor rather than on
            // the pool — count it to attribute the `ack_to_emit` gap (see the probe).
            if self.frontier_pts != i64::MIN
                && self.frontier_pts >= self.anchor.saturating_add(LOOKAHEAD_US)
            {
                let free = self.free.iter().filter(|&&f| f).count() as u32;
                if let Ok(mut t) = self.timing.lock() {
                    t.note_lookahead_gated_skip(free, self.eof);
                }
                return;
            }

            let decode_start = Instant::now();
            let decoded = match self.stream.next_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    self.eof = true;
                    // Every pump exit must stamp the terminal snapshot, or a
                    // `take_timings` in this window reads the PREVIOUS exit's
                    // final_* (see `note_lookahead_gated_skip`'s landmine).
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_eof_return(free, true);
                    }
                    ctx.emit(DecodeMsg::End);
                    return;
                }
                Err(e) => {
                    // Halt the pump so we don't spin on a persistent error; a
                    // later seek reopens decoding. The halt IS the eof state.
                    self.eof = true;
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_eof_return(free, true);
                    }
                    ctx.emit(DecodeMsg::Error {
                        message: e,
                        terminal: false,
                    });
                    return;
                }
            };

            // Keyframe cadence, for `resync_threshold_us`. Folded before any
            // discard below, because a discarded frame still tells us the GOP
            // structure — and the discard paths are exactly when we need it.
            if decoded.key {
                self.key_interval_us =
                    fold_key_interval(self.key_interval_us, self.last_key_pts, decoded.pts_us);
                self.last_key_pts = decoded.pts_us;
            }

            // Post-seek: drop frames before the anchor (the seek landed on a
            // keyframe at/<= the target) until the first one at/after it.
            if self.post_seek {
                if decoded.pts_us < self.anchor {
                    self.frontier_pts = decoded.pts_us;
                    continue; // slot stays free
                }
                self.post_seek = false;
            }

            // Already-late frame: discard so the delivery chain isn't spent on a
            // frame nobody sees; the slot stays free. Why the margin isn't zero:
            // see `LATE_FRAME_DROP_US`.
            if is_late_frame(decoded.pts_us, decoded.dur_us, self.anchor) {
                self.frontier_pts = decoded.pts_us;
                if let Ok(mut t) = self.timing.lock() {
                    t.note_late_frame_drop();
                }
                continue; // slot stays free
            }

            let copy = unsafe {
                convert_frame_into_slot(
                    &self.context,
                    &mut self.convert,
                    &self.pool[slot_idx],
                    slot_idx,
                    &self.stream,
                    &decoded,
                    &self.timing,
                )
            };
            match copy {
                Ok(CopyOutcome::AcquireFailed(message)) => {
                    // Report it but don't halt the pump — return to the session
                    // loop so it re-services its mailbox (and notices a close)
                    // instead of retrying in a tight loop against a slot that
                    // may stay stuck.
                    //
                    // The frame WAS consumed from the stream whether or not
                    // the copy landed: the frontier is the decoder's position,
                    // not the delivery's, or the lookahead gate and
                    // `needs_seek` drift off the real position.
                    self.frontier_pts = decoded.pts_us;
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_acquire_failed(free, self.eof);
                    }
                    ctx.emit(DecodeMsg::Error {
                        message,
                        terminal: false,
                    });
                    return;
                }
                Err(e) => {
                    self.eof = true;
                    self.frontier_pts = decoded.pts_us;
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_eof_return(free, true);
                    }
                    ctx.emit(DecodeMsg::Error {
                        message: e,
                        terminal: false,
                    });
                    return;
                }
                Ok(CopyOutcome::Copied) => {}
            }

            let decode_copy_ns = decode_start.elapsed().as_nanos() as u64;
            self.free[slot_idx] = false;
            // The fill IS the generation boundary: from here this occupancy is
            // named by the new token, and only an ack echoing it frees the slot.
            self.slot_gen[slot_idx] = self.slot_gen[slot_idx].wrapping_add(1);
            self.frontier_pts = decoded.pts_us;
            self.last_delivered_pts = decoded.pts_us;
            // Close the ack->next-emit gap for this slot, if it was previously
            // acked (its first fill has no prior ack -> `take` yields None -> no
            // sample). Measured against the same `now` used to stamp the emit.
            let now = Instant::now();
            let ack_to_emit_ns = self
                .slot_ack_at
                .get_mut(slot_idx)
                .and_then(Option::take)
                .map(|ack_at| now.duration_since(ack_at).as_nanos() as u64);
            // Session-level production cadence (any slot): gap since the previous emit.
            let inter_emit_ns = self
                .last_emit_at
                .replace(now)
                .map(|prev| now.duration_since(prev).as_nanos() as u64);
            // Stamp the slot BEFORE emit so the matching ack can measure the full
            // round-trip; record decode+copy (+ any gaps) for this delivered frame.
            self.slot_emit[slot_idx] = Some(now);
            if let Ok(mut t) = self.timing.lock() {
                t.push_decode_copy(decode_copy_ns);
                if let Some(gap_ns) = ack_to_emit_ns {
                    t.push_ack_to_emit(gap_ns);
                }
                if let Some(gap_ns) = inter_emit_ns {
                    t.push_inter_emit(gap_ns);
                }
            }
            ctx.emit(DecodeMsg::Slot {
                slot: slot_idx as u32,
                gen: self.slot_gen[slot_idx],
                pts_us: decoded.pts_us as f64,
                dur_us: decoded.dur_us as f64,
            });
        }
    }

    /// Owner-side lease timeout: reclaim delivered slots whose ack never came
    /// back within [`LEASE_TIMEOUT`]. The trade is decided (drainFenceAcks
    /// precedent): one possibly-torn frame < a permanently wedged session —
    /// `pool_size` stranded slots stop production for good, and only the OWNER
    /// can break that. Bumping the generation is what makes the reclaim safe
    /// to observe: the original occupant's late ack now fails the gen check
    /// instead of freeing whatever the slot holds by then. The keyed mutex
    /// still serialises any actual GPU access if Chromium is genuinely
    /// mid-read (worst case: the next fill's AcquireSync waits/times out).
    ///
    /// Runs at the top of every `pump` (each message + each 4ms idle tick), so
    /// an expiry is noticed within one tick of `LEASE_TIMEOUT`.
    fn reclaim_expired_leases(&mut self) {
        let now = Instant::now();
        for slot in 0..self.pool.len() {
            if self.free[slot] {
                continue;
            }
            let Some(emit_at) = self.slot_emit[slot] else {
                continue; // busy-but-never-emitted: not a lease (mid-fill)
            };
            if now.duration_since(emit_at) < LEASE_TIMEOUT {
                continue;
            }
            // Take the emit stamp so the (never-arriving) coord-RTT sample is
            // cancelled with the lease rather than paired with a future ack —
            // and the stale ack stamp, so the next fill's ack_to_emit doesn't
            // pair against an ack from a previous occupancy.
            self.slot_emit[slot] = None;
            self.slot_ack_at[slot] = None;
            self.slot_gen[slot] = self.slot_gen[slot].wrapping_add(1);
            self.free[slot] = true;
            if let Ok(mut t) = self.timing.lock() {
                t.note_lease_timeout();
            }
        }
    }
}

/// Result of attempting to copy a decoded frame into a pool slot.
enum CopyOutcome {
    /// The mutex was acquired and the frame copied; the caller may mark the
    /// slot busy and announce it.
    Copied,
    /// `AcquireSync` did not grant the mutex (timeout, abandoned, or a genuine
    /// error). No GPU work happened — the slot was never touched, so it stays
    /// free — and this decoded frame is dropped. Carries the message for a
    /// non-terminal `DecodeMsg::Error`.
    AcquireFailed(String),
}

/// Convert the decoded NV12 surface into a pool slot's RGBA8 texture, bracketed
/// by the slot's keyed mutex (our GPU write vs. Chromium's read) and ffmpeg's
/// device-context lock (decode thread vs. ALL of our context use — staging copy,
/// draw, flush and the timing-query poll).
///
/// # Safety
/// `decoded.src_texture` must still be valid (no `next_frame` since it was
/// produced), and `context`/`stream`/`convert` must be the ones the surface
/// belongs to.
unsafe fn convert_frame_into_slot(
    context: &ID3D11DeviceContext,
    convert: &mut ConvertPass,
    slot: &SharedTexture,
    slot_idx: usize,
    stream: &VideoStream,
    decoded: &StreamFrame,
    timing: &Arc<Mutex<TimingAccum>>,
) -> Result<CopyOutcome, String> {
    let src_tex = ID3D11Texture2D::from_raw_borrowed(&decoded.src_texture)
        .ok_or_else(|| "decoded D3D11 texture is null".to_string())?;

    // The guard gives the key back on every path out of the copy region,
    // unwinding included: the runtime catches a panic here, and a key left
    // held would wedge Chromium's next read of the shared surface.
    let held = match KeyedMutexGuard::acquire(slot.mutex(), 0, ACQUIRE_TIMEOUT_MS) {
        Ok(held) => held,
        Err(AcquireError::Timeout) => {
            return Ok(CopyOutcome::AcquireFailed(format!(
                "AcquireSync timeout on slot after {ACQUIRE_TIMEOUT_MS}ms (slot stuck)"
            )));
        }
        // Abandoned: DXGI leaves the surface and its mutex inconsistent, so the
        // slot is neither written nor released.
        Err(e) => {
            return Ok(CopyOutcome::AcquireFailed(format!(
                "AcquireSync(slot) failed: {e}"
            )));
        }
    };

    if let Some(lock) = stream.lock {
        lock(stream.lock_ctx);
    }
    // Previous frame's GPU-time bracket, polled non-blocking while we already
    // hold the context lock (GetData is context use too).
    if let Some(gpu_ns) = convert.poll_gpu_time(context) {
        if let Ok(mut t) = timing.lock() {
            t.push_convert_gpu(gpu_ns);
        }
    }
    let converted = convert.convert_into_slot(context, src_tex, decoded.src_index, slot_idx);
    context.Flush();
    if let Some(unlock) = stream.unlock {
        unlock(stream.lock_ctx);
    }
    // Propagate a convert failure only after the lock was paired; the guard
    // still gives the key back on this early return.
    converted?;
    // Explicit release so a `ReleaseSync` failure surfaces here.
    held.release()
        .map_err(|e| format!("ReleaseSync(slot) failed: {e}"))?;
    Ok(CopyOutcome::Copied)
}

/// Open the decoder + build the shared RGBA8 pool on ffmpeg's device, plus the
/// session's NV12→RGBA conversion pass. Runs on the session thread (all
/// COM/ffmpeg objects stay here).
///
/// `matrix`/`full_range` are the stream's renderer-derived color tags: they
/// select the conversion constants baked into this session's shader, so the
/// shared texture is already working-space RGBA and the import side tags it
/// sRGB-passthrough unconditionally.
fn init_session(
    path: &str,
    pool_size: u32,
    matrix: &str,
    full_range: bool,
    timing: Arc<Mutex<TimingAccum>>,
) -> Result<SessionState, String> {
    let stream = VideoStream::open(path)?;
    let (width, height) = (stream.width, stream.height);

    unsafe {
        // Borrow ffmpeg's device/context, then clone (AddRef) so they outlive the
        // decoder — the pool textures are created on this device.
        let device = ID3D11Device::from_raw_borrowed(&stream.device)
            .ok_or_else(|| "ffmpeg D3D11 device is null".to_string())?
            .clone();
        let context = ID3D11DeviceContext::from_raw_borrowed(&stream.device_context)
            .ok_or_else(|| "ffmpeg D3D11 device context is null".to_string())?
            .clone();

        // RENDER_TARGET (part of every `SharedTexture`): each slot is the
        // conversion's RTV.
        let mut pool = Vec::with_capacity(pool_size as usize);
        for i in 0..pool_size {
            let slot = SharedTexture::create(&device, width, height, DXGI_FORMAT_R8G8B8A8_UNORM)
                .map_err(|e| format!("pool slot {i}: {e}"))?;
            pool.push(slot);
        }

        let slot_textures: Vec<ID3D11Texture2D> =
            pool.iter().map(|s| s.texture().clone()).collect();
        let convert = ConvertPass::new(&device, width, height, matrix, full_range, &slot_textures)?;

        let free = vec![true; pool.len()];
        // Computed before the struct literal (like `free` above): `pool` is moved
        // into its own field within the literal, so `pool.len()` must be captured
        // here rather than inline at the per-slot fields.
        let slot_gen = vec![0u32; pool.len()];
        let slot_emit = vec![None; pool.len()];
        let slot_ack_at = vec![None; pool.len()];

        Ok(SessionState {
            stream,
            _device: device,
            context,
            pool,
            convert,
            free,
            slot_gen,
            width,
            height,
            anchor: i64::MIN,
            frontier_pts: i64::MIN,
            last_delivered_pts: i64::MIN,
            post_seek: false,
            last_key_pts: i64::MIN,
            key_interval_us: SEEK_FORWARD_THRESHOLD_US,
            eof: false,
            timing,
            slot_emit,
            slot_ack_at,
            last_emit_at: None,
            last_ack_at: None,
        })
    }
}

/// The session's loop: serve each command, and pump on every idle tick so a
/// freed slot is refilled and an expired lease reclaimed without a message,
/// until close disconnects the channel.
/// What one sweep of the mailbox held.
struct Drained {
    /// The newest request's target, if the sweep held a request.
    newest: Option<i64>,
    requests: u64,
    releases: u64,
}

/// Takes `first` and everything already queued behind it off the mailbox.
/// Every release goes to `release`, in order. Of the requests only the newest
/// target is kept: the session chases one anchor, so a superseded target
/// would cost a seek and a pool of frames nobody will show.
///
/// LANDMINE: without this sweep a scrub is served target by target. The
/// consumer posts every distinct target; when main falls behind, a run of
/// them lands at once, and each stale one can seek before the newest is seen.
fn drain_mailbox(
    first: GpuCmd,
    rx: &Receiver<GpuCmd>,
    mut release: impl FnMut(u32, u32),
) -> Drained {
    let mut drained = Drained {
        newest: None,
        requests: 0,
        releases: 0,
    };
    let mut next = Some(first);
    while let Some(cmd) = next {
        match cmd {
            GpuCmd::RequestFrameAt(t) => {
                drained.newest = Some(t);
                drained.requests += 1;
            }
            GpuCmd::Release { slot, gen } => {
                release(slot, gen);
                drained.releases += 1;
            }
        }
        next = rx.try_recv().ok();
    }
    drained
}

fn run_session(mut state: SessionState, rx: Receiver<GpuCmd>, ctx: SessionCtx) {
    loop {
        // Thread time-budget probe: time the recv itself (0 when a message
        // was already queued; ~RECV_TIMEOUT when the thread blocked idle) and tally
        // the wake reason, before dispatching. One uncontended lock/iteration.
        let t_recv = Instant::now();
        let msg = rx.recv_timeout(RECV_TIMEOUT);
        let block_ns = t_recv.elapsed().as_nanos() as u64;
        if let Ok(mut t) = state.timing.lock() {
            t.push_recv_block(block_ns);
            if matches!(msg, Err(RecvTimeoutError::Timeout)) {
                t.note_recv_timeout();
            }
        }
        // Close sets the flag before it drops the channel; commands still
        // queued behind it are not served.
        if ctx.cancelled() {
            break;
        }
        match msg {
            Ok(first) => {
                // The pump runs once for the whole drain, whatever it held: the
                // mailbox deserves service either way.
                let target = drain_mailbox(first, &rx, |slot, gen| state.on_release(slot, gen));
                if let Ok(mut t) = state.timing.lock() {
                    for _ in 0..target.requests {
                        t.note_recv_req();
                    }
                    for _ in 0..target.releases {
                        t.note_recv_ack();
                    }
                }
                if let Some(t) = target.newest {
                    state.on_request(t, &ctx);
                }
                state.pump(&ctx);
            }
            Err(RecvTimeoutError::Timeout) => state.pump(&ctx),
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // `state` drops here (or in the unwind the runtime catches): closes each
    // slot's NT handle, drops the VideoStream (unrefs the hw context), device,
    // context, and pool textures.
}

/// The live GPU preview sessions. `Send + Sync`, so the addon drives it from
/// napi calls.
pub struct PreviewGpuSessions {
    runtime: SessionRuntime<GpuCmd, GpuShared>,
}

impl Default for PreviewGpuSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewGpuSessions {
    pub fn new() -> Self {
        Self {
            runtime: SessionRuntime::new("preview-gpu"),
        }
    }

    /// Open `path` for GPU preview with every message going to `sink`: spawn
    /// its decode thread, build the pool + conversion pass, and hand back the
    /// slot handles + dimensions once the thread reports ready. `matrix` /
    /// `full_range` are the stream's renderer-derived color tags (they pick
    /// the conversion constants — see `convert::coef_for_matrix`).
    pub fn open(
        &self,
        session_id: &str,
        path: &str,
        pool_size: u32,
        matrix: &str,
        full_range: bool,
        sink: Sink,
    ) -> Result<OpenInfo, String> {
        let timing = Arc::new(Mutex::new(TimingAccum::default()));
        let shared = Arc::new(GpuShared {
            timing: Arc::clone(&timing),
            pool_slot_bytes: AtomicU64::new(0),
        });
        let thread_shared = Arc::clone(&shared);
        let path = path.to_string();
        let matrix = matrix.to_string();
        let pool_size = pool_size.max(1);
        self.runtime.open(session_id, sink, shared, move |ctx, rx| {
            let state = init_session(&path, pool_size, &matrix, full_range, timing)?;
            let slot_handles = state.slot_handles();
            thread_shared.pool_slot_bytes.store(
                state.width as u64 * state.height as u64 * 4 * slot_handles.len() as u64,
                Ordering::Relaxed,
            );
            let info = OpenInfo {
                width: state.width,
                height: state.height,
                slot_handles,
                adapter: decoder_adapter(&state._device),
            };
            Ok((info, move || run_session(state, rx, ctx)))
        })
    }

    /// Set the decode anchor for a session; the thread pumps lookahead toward it.
    pub fn request_frame_at(&self, session_id: &str, target_us: i64) -> Result<(), String> {
        self.runtime
            .send(session_id, GpuCmd::RequestFrameAt(target_us))
    }

    /// Hand a slot back to the pool. `gen` must echo the `DecodeMsg::Slot` that
    /// delivered it, or the session thread drops the release as stale
    /// (fencing token).
    pub fn release(&self, session_id: &str, slot: u32, gen: u32) -> Result<(), String> {
        self.runtime.send(session_id, GpuCmd::Release { slot, gen })
    }

    /// Drain the session's accumulated timing samples into a summary report.
    /// Called once at the end of a bench window (before `close`), from the Node
    /// main thread via the addon.
    pub fn take_timings(&self, session_id: &str) -> Result<TimingReport, String> {
        self.runtime.with(session_id, |s| {
            let mut report = s.timing.lock_recover().drain();
            report.pool_slot_bytes = s.pool_slot_bytes.load(Ordering::Relaxed);
            report
        })
    }

    /// Tear a session down within the runtime's close grace. The thread closes
    /// each slot's NT handle and drops the decoder on its way out.
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        self.runtime.close(session_id)
    }
}

#[cfg(test)]
mod timing_tests {
    use super::{TimingAccum, TIMING_SAMPLE_CAP};

    #[test]
    fn summary_percentiles_and_mean_over_known_samples() {
        let mut a = TimingAccum::default();
        for ms in [10u64, 20, 30, 40, 50] {
            a.push_coord_rtt(ms * 1_000_000); // ns
        }
        let r = a.drain();
        assert_eq!(r.coord_rtt.count, 5);
        assert!(
            (r.coord_rtt.mean_ms - 30.0).abs() < 1e-6,
            "mean {}",
            r.coord_rtt.mean_ms
        );
        assert!(
            (r.coord_rtt.p50_ms - 30.0).abs() < 1e-6,
            "p50 {}",
            r.coord_rtt.p50_ms
        );
        // linear interp: idx = 0.95*(5-1) = 3.8 -> 40 + (50-40)*0.8 = 48
        assert!(
            (r.coord_rtt.p95_ms - 48.0).abs() < 1e-6,
            "p95 {}",
            r.coord_rtt.p95_ms
        );
        assert!(
            (r.coord_rtt.max_ms - 50.0).abs() < 1e-6,
            "max {}",
            r.coord_rtt.max_ms
        );
    }

    #[test]
    fn drain_clears_buffers() {
        let mut a = TimingAccum::default();
        a.push_decode_copy(5_000_000);
        a.push_ack_to_emit(7_000_000);
        a.note_lookahead_gated_skip(2, false);
        a.note_late_frame_drop();
        a.push_inter_emit(22_000_000);
        a.push_inter_ack(22_000_000);
        a.push_recv_block(4_000_000);
        a.note_recv_timeout();
        a.note_recv_ack();
        a.note_recv_req();
        a.note_eof_return(2, true);
        a.note_pool_full_return(0, false);
        a.note_acquire_failed(1, false);
        let r = a.drain();
        assert_eq!(r.decode_copy.count, 1);
        assert_eq!(r.ack_to_emit.count, 1);
        assert_eq!(r.lookahead_gated_skips, 1);
        assert_eq!(r.late_frame_drops, 1);
        assert_eq!(r.inter_emit.count, 1);
        assert_eq!(r.inter_ack.count, 1);
        assert_eq!(r.recv_block.count, 1);
        assert_eq!(r.recv_timeout_ticks, 1);
        assert_eq!(r.recv_ack_msgs, 1);
        assert_eq!(r.recv_req_msgs, 1);
        assert_eq!(r.eof_returns, 1);
        assert_eq!(r.pool_full_returns, 1);
        assert_eq!(r.acquire_failed, 1);
        // final_* reflect the LAST note (note_acquire_failed(1, false) here).
        assert_eq!(r.final_free_slots, 1);
        assert!(!r.final_eof);
        // Second drain sees the cleared state (buffers + counters reset).
        let r2 = a.drain();
        assert_eq!(r2.decode_copy.count, 0);
        assert_eq!(r2.ack_to_emit.count, 0);
        assert_eq!(r2.lookahead_gated_skips, 0);
        assert_eq!(r2.late_frame_drops, 0);
        assert_eq!(r2.inter_emit.count, 0);
        assert_eq!(r2.recv_block.count, 0);
        assert_eq!(r2.recv_timeout_ticks, 0);
        assert_eq!(r2.recv_ack_msgs, 0);
        assert_eq!(r2.recv_req_msgs, 0);
        assert_eq!(r2.eof_returns, 0);
        assert_eq!(r2.pool_full_returns, 0);
        assert_eq!(r2.acquire_failed, 0);
        assert_eq!(r2.final_free_slots, 0);
    }

    #[test]
    fn ack_to_emit_summary_and_skip_count() {
        let mut a = TimingAccum::default();
        for ms in [12u64, 24, 36] {
            a.push_ack_to_emit(ms * 1_000_000);
        }
        for _ in 0..5 {
            a.note_lookahead_gated_skip(1, false);
        }
        let r = a.drain();
        assert_eq!(r.ack_to_emit.count, 3);
        assert!(
            (r.ack_to_emit.mean_ms - 24.0).abs() < 1e-6,
            "mean {}",
            r.ack_to_emit.mean_ms
        );
        assert!(
            (r.ack_to_emit.p50_ms - 24.0).abs() < 1e-6,
            "p50 {}",
            r.ack_to_emit.p50_ms
        );
        assert_eq!(r.lookahead_gated_skips, 5);
    }

    #[test]
    fn empty_summary_is_zeroed() {
        let mut a = TimingAccum::default();
        let r = a.drain();
        assert_eq!(r.coord_rtt.count, 0);
        assert_eq!(r.coord_rtt.p95_ms, 0.0);
        assert_eq!(r.ack_to_emit.count, 0);
        assert_eq!(r.ack_to_emit.p95_ms, 0.0);
        assert_eq!(r.lookahead_gated_skips, 0);
    }

    #[test]
    fn sample_cap_holds() {
        let mut a = TimingAccum::default();
        for _ in 0..(TIMING_SAMPLE_CAP + 100) {
            a.push_decode_copy(1_000_000);
        }
        assert_eq!(a.drain().decode_copy.count as usize, TIMING_SAMPLE_CAP);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_wait::wait_for;
    use std::thread;

    // --- Playback-load policy: the pure decisions `pump`/`on_request` delegate to.
    // These are the whole behavioural contract of the late-frame drop + adaptive
    // resync, so they are gated here rather than only through a live GPU session
    // (which needs D3D11 + a real file and can't assert a counterfactual).

    /// One frame interval at 29.97 fps — the measured stress case.
    const F30: i64 = 33_367;

    #[test]
    fn late_frame_drop_keeps_the_covering_frame_and_the_tolerated_lag() {
        // The frame COVERING the anchor is never late, however long its duration.
        assert!(!is_late_frame(1_000_000, F30, 1_000_000));
        assert!(!is_late_frame(1_000_000, F30, 1_000_000 + F30 - 1));
        // A zero/unknown duration must not turn the covering frame into a past one
        // (the `.max(1)` guard) — pts == anchor is still current.
        assert!(!is_late_frame(1_000_000, 0, 1_000_000));
        // Frames inside the A/V tolerance still get delivered: showing a slightly
        // stale frame beats showing nothing, which is why the margin isn't zero.
        assert!(!is_late_frame(
            1_000_000,
            F30,
            1_000_000 + LATE_FRAME_DROP_US
        ));
        // Past the tolerance, drop: nothing downstream would ever bind it.
        assert!(is_late_frame(
            1_000_000,
            F30,
            1_000_000 + F30 + LATE_FRAME_DROP_US
        ));
        // A deep backlog (the sustained-shortfall case) drops wholesale.
        assert!(is_late_frame(1_000_000, F30, 5_000_000));
    }

    #[test]
    fn late_frame_drop_never_fires_while_pre_buffering_ahead() {
        // Paused / healthy playback decodes AHEAD of the anchor. Every such frame
        // must be delivered — a false positive here would blank the preview.
        for ahead in [1, F30, LOOKAHEAD_US, 10 * LOOKAHEAD_US] {
            assert!(
                !is_late_frame(1_000_000 + ahead, F30, 1_000_000),
                "frame {ahead}us ahead of the anchor must not be dropped"
            );
        }
    }

    #[test]
    fn resync_threshold_tracks_the_measured_keyframe_interval_within_clamps() {
        // A short-GOP quick proxy resyncs promptly...
        assert_eq!(resync_threshold_us(500_000), 500_000);
        // ...but never so promptly that it thrashes on a few frames of drift.
        assert_eq!(resync_threshold_us(F30), MIN_RESYNC_US);
        // A long-GOP 4K original (3 s GOP, measured) tolerates more drift, because
        // a seek there costs re-decoding up to a whole GOP.
        assert_eq!(resync_threshold_us(3_000_000), 3_000_000);
        // A pathological keyframe-once-a-minute source can't disable resync.
        assert_eq!(resync_threshold_us(60_000_000), MAX_RESYNC_US);
    }

    #[test]
    fn key_interval_folds_gaps_and_ignores_non_advancing_keys() {
        // First key ever: nothing to measure, seed survives.
        assert_eq!(
            fold_key_interval(SEEK_FORWARD_THRESHOLD_US, i64::MIN, 5_000_000),
            SEEK_FORWARD_THRESHOLD_US
        );
        // A repeated / out-of-order key pts is not an interval.
        assert_eq!(
            fold_key_interval(1_000_000, 5_000_000, 5_000_000),
            1_000_000
        );
        assert_eq!(
            fold_key_interval(1_000_000, 5_000_000, 4_000_000),
            1_000_000
        );
        // EWMA converges toward a real 3 s GOP from the 1 s seed rather than jumping.
        let mut k = SEEK_FORWARD_THRESHOLD_US;
        let mut last = 0;
        for i in 1..=12 {
            let pts = i * 3_000_000;
            k = fold_key_interval(k, last, pts);
            last = pts;
        }
        assert!(
            (2_900_000..=3_000_000).contains(&k),
            "expected convergence toward the 3s GOP, got {k}"
        );
    }

    #[test]
    fn ack_frees_slot_accepts_only_a_busy_slot() {
        let free = [true, false, true];
        let gen = [7u32, 7, 7];
        // Busy slot + matching generation: the renderer released it, the ack
        // frees it.
        assert!(ack_frees_slot(&free, &gen, 1, 7));
        // Busy slot, WRONG generation (the ABA case: a late ack from a
        // previous occupancy after a lease-timeout reclaim + refill): dropped,
        // or it would free the CURRENT frame mid-read.
        assert!(!ack_frees_slot(&free, &gen, 1, 6));
        assert!(!ack_frees_slot(&free, &gen, 1, 8));
        // Already-free slot (duplicate or stale ack): freeing again would let
        // the pump overwrite a slot the renderer may still be reading.
        assert!(!ack_frees_slot(&free, &gen, 0, 7));
        assert!(!ack_frees_slot(&free, &gen, 2, 7));
        // Out-of-range slot: never frees anything.
        assert!(!ack_frees_slot(&free, &gen, 3, 7));
        assert!(!ack_frees_slot(&free, &gen, usize::MAX, 7));
    }

    #[test]
    fn needs_seek_covers_cold_start_backward_and_forward_jumps() {
        const K: i64 = 3_000_000; // long-GOP source
                                  // Cold start: a near-zero target is cheaper to reach by forward decode.
        assert!(!needs_seek(0, i64::MIN, i64::MIN, K));
        assert!(needs_seek(90_000_000, i64::MIN, i64::MIN, K));
        // Backward move relative to the previous anchor.
        assert!(needs_seek(1_000_000, 8_000_000, 8_500_000, K));
        // Ordinary forward playback within the resync window: no seek. This is the
        // arm the late-frame drop relies on — catch up by dropping, not by seeking.
        assert!(!needs_seek(8_100_000, 8_000_000, 8_500_000, K));
        assert!(!needs_seek(10_000_000, 8_000_000, 8_500_000, K));
        // A forward jump past what a GOP re-decode would cost: seek.
        assert!(needs_seek(20_000_000, 8_000_000, 8_500_000, K));
        // Same gap on a SHORT-GOP source seeks much sooner (the adaptive part).
        assert!(needs_seek(9_000_000, 8_000_000, 8_500_000, 400_000));
        assert!(!needs_seek(9_000_000, 8_000_000, 8_500_000, K));
    }

    #[test]
    fn needs_seek_backstops_an_anchor_stranded_behind_the_frontier() {
        // THE WEDGE — see `needs_seek`'s frontier arm.
        // Re-requesting the SAME anchor must still be recognised as divergence.
        assert!(needs_seek(0, 0, 12_500_000, 3_000_000));
        // ...and must not depend on the anchor having moved backward this call.
        assert!(needs_seek(1_000_000, 1_000_000, 12_500_000, 3_000_000));
    }

    #[test]
    fn needs_seek_tolerates_legitimate_pre_buffer_lead() {
        // Paused pre-buffering legally runs the frontier one LOOKAHEAD_US ahead of
        // a held anchor. That must NOT read as backward divergence, or a parked
        // playhead would re-seek on every idle tick.
        let anchor = 5_000_000;
        assert!(!needs_seek(
            anchor,
            anchor,
            anchor + LOOKAHEAD_US,
            3_000_000
        ));
    }

    #[test]
    fn a_mailbox_sweep_keeps_every_release_in_order_and_only_the_newest_target() {
        let (tx, rx) = std::sync::mpsc::channel();
        for cmd in [
            GpuCmd::Release { slot: 1, gen: 4 },
            GpuCmd::RequestFrameAt(200),
            GpuCmd::Release { slot: 0, gen: 9 },
            GpuCmd::RequestFrameAt(300),
        ] {
            tx.send(cmd).unwrap();
        }
        let mut released = Vec::new();
        let drained = drain_mailbox(GpuCmd::RequestFrameAt(100), &rx, |slot, gen| {
            released.push((slot, gen))
        });
        assert_eq!(drained.newest, Some(300), "superseded targets are skipped");
        assert_eq!(
            released,
            [(1, 4), (0, 9)],
            "no release is lost or reordered"
        );
        assert_eq!((drained.requests, drained.releases), (3, 2));
        assert!(rx.try_recv().is_err(), "the sweep left nothing queued");

        // A sweep of releases alone names no target: the anchor stays.
        let only = drain_mailbox(GpuCmd::Release { slot: 2, gen: 1 }, &rx, |_, _| {});
        assert_eq!(only.newest, None);
    }

    // --- A live session. `open` needs a d3d11va device and has no software
    // fallback (decoder.rs), so on a host without one these tests skip; what
    // they check does not depend on which GPU decodes.

    const H264: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_h264.mp4");

    /// How long a test watches for a message that must not come. Only a
    /// negative reads after it: a slower machine makes the check weaker, never
    /// red. Far below `LEASE_TIMEOUT`, so no reclaim frees a slot meanwhile.
    const QUIET: Duration = Duration::from_millis(100);

    #[derive(Debug, Clone, PartialEq)]
    enum Seen {
        Slot { slot: u32, gen: u32, pts: i64 },
        End,
        Error { message: String, terminal: bool },
        Other,
    }

    type Log = Arc<Mutex<Vec<Seen>>>;

    fn seen(msg: DecodeMsg) -> Seen {
        match msg {
            DecodeMsg::Slot {
                slot, gen, pts_us, ..
            } => Seen::Slot {
                slot,
                gen,
                pts: pts_us as i64,
            },
            DecodeMsg::End => Seen::End,
            DecodeMsg::Error { message, terminal } => Seen::Error { message, terminal },
            DecodeMsg::Bytes { .. } | DecodeMsg::Mark { .. } => Seen::Other,
        }
    }

    /// Open `id` on the H.264 fixture with a recording sink, or `None` without
    /// a d3d11va device. With `keep_up`, the sink hands each slot straight
    /// back, as a consumer that keeps up would.
    fn open_live(
        sessions: &Arc<PreviewGpuSessions>,
        id: &str,
        pool: u32,
        keep_up: bool,
    ) -> Option<(OpenInfo, Log)> {
        let log: Log = Arc::default();
        let log2 = Arc::clone(&log);
        let weak = Arc::downgrade(sessions);
        let sid = id.to_string();
        let sink: Sink = Box::new(move |msg| {
            let msg = seen(msg);
            if let (true, Seen::Slot { slot, gen, .. }) = (keep_up, &msg) {
                if let Some(s) = weak.upgrade() {
                    let _ = s.release(&sid, *slot, *gen);
                }
            }
            log2.lock().unwrap().push(msg);
        });
        match sessions.open(id, H264, pool, "bt709", false, sink) {
            Ok(info) => Some((info, log)),
            Err(e) => {
                eprintln!("skipping: no d3d11va session on this host ({e})");
                None
            }
        }
    }

    fn slots(log: &Log) -> Vec<(u32, u32, i64)> {
        log.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                Seen::Slot { slot, gen, pts } => Some((*slot, *gen, *pts)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_slot_is_refilled_only_after_a_release_of_its_current_generation() {
        let s = Arc::new(PreviewGpuSessions::new());
        let Some((info, log)) = open_live(&s, "g", 2, false) else {
            return;
        };
        assert_eq!(info.slot_handles.len(), 2, "one handle per slot");
        s.request_frame_at("g", 0).unwrap();
        assert!(
            wait_for(|| slots(&log).len() == 2),
            "the pool never filled: {:?}",
            log.lock().unwrap()
        );
        thread::sleep(QUIET);
        let filled = slots(&log);
        assert_eq!(filled.len(), 2, "a slot refilled unreleased: {filled:?}");
        let (slot, gen, _) = filled[0];

        s.release("g", slot, gen.wrapping_sub(1)).unwrap();
        // Received is the witness, whatever the session made of the release.
        let (mut received, mut stale) = (0, 0);
        assert!(
            wait_for(|| {
                let t = s.take_timings("g").unwrap();
                received += t.recv_ack_msgs;
                stale += t.stale_gen_acks;
                received > 0
            }),
            "the stale release was never received"
        );
        thread::sleep(QUIET);
        assert_eq!(slots(&log).len(), 2, "a stale release freed its slot");
        stale += s.take_timings("g").unwrap().stale_gen_acks;
        assert_eq!(stale, 1, "the stale release counts once as stale");

        s.release("g", slot, gen).unwrap();
        assert!(
            wait_for(|| slots(&log).len() == 3),
            "a current release did not free its slot"
        );
        let (refilled, regen, pts) = slots(&log)[2];
        assert_eq!(refilled, slot, "only the released slot was free");
        assert_eq!(regen, gen.wrapping_add(1), "a refill is a new generation");
        assert!(pts > filled[1].2, "frames fill in presentation order");
        s.close("g").unwrap();
    }

    #[test]
    fn the_end_follows_the_last_slot_once() {
        let s = Arc::new(PreviewGpuSessions::new());
        let Some((_info, log)) = open_live(&s, "g", 2, true) else {
            return;
        };
        // Past the fixture's midpoint, so the lookahead reaches its end.
        s.request_frame_at("g", 600_000).unwrap();
        assert!(
            wait_for(|| log.lock().unwrap().contains(&Seen::End)),
            "no end: {:?}",
            log.lock().unwrap()
        );
        thread::sleep(QUIET);
        let got = log.lock().unwrap().clone();
        let Some((Seen::End, frames)) = got.split_last() else {
            panic!("the end was not the last message: {got:?}");
        };
        assert!(!frames.is_empty(), "no frame before the end");
        assert!(
            frames.iter().all(|m| matches!(m, Seen::Slot { .. })),
            "only frames precede the end: {got:?}"
        );
        let pts: Vec<i64> = slots(&log).iter().map(|f| f.2).collect();
        assert!(
            pts.windows(2).all(|w| w[0] < w[1]),
            "frames in presentation order: {pts:?}"
        );
        s.close("g").unwrap();
    }
}
