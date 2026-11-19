use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::carrier::{DecodeMsg, Sink};

// ── wire structs ────────────────────────────────────────────────────────────

/// One pool slot handed back by `preview_gpu_open`: the shared D3D11
/// texture's NT handle in its wire bytes (`weftcut_d3d::handle_to_bytes`).
/// The main process passes them to `importSharedTexture`.
#[napi(object)]
pub struct PreviewGpuSlot {
    pub handle: Buffer,
}

/// Reply of `preview_gpu_open`: the decoded stream's dimensions + one
/// `PreviewGpuSlot` per pool slot.
#[napi(object)]
pub struct PreviewGpuOpenInfo {
    pub width: u32,
    pub height: u32,
    pub slots: Vec<PreviewGpuSlot>,
    pub adapter: Option<PreviewGpuAdapter>,
}

#[napi(object)]
pub struct PreviewGpuAdapter {
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub luid: String,
}

/// Per-metric ms summary of native preview timing. Field names cross to JS as
/// camelCase: `mean_ms` -> `meanMs`, etc.
#[napi(object)]
pub struct PreviewGpuTimingSummary {
    pub count: u32,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Native timing metrics returned by `preview_gpu_take_timings`. `ack_to_emit` +
/// `lookahead_gated_skips` are the throughput-bottleneck probe (the ack->next-emit
/// gap and its lookahead-gate attribution).
#[napi(object)]
pub struct PreviewGpuTimingReport {
    pub coord_rtt: PreviewGpuTimingSummary,
    pub decode_copy: PreviewGpuTimingSummary,
    /// GPU cost of the NV12→RGBA conversion pass (timestamp queries on the
    /// decode device; a subsample — see `preview_gpu::TimingReport::convert_gpu`).
    pub convert_gpu: PreviewGpuTimingSummary,
    pub ack_to_emit: PreviewGpuTimingSummary,
    pub lookahead_gated_skips: u32,
    /// Frames the pump discarded as already-late instead of delivering them (see
    /// `preview_gpu::TimingReport::late_frame_drops`).
    pub late_frame_drops: u32,
    // Thread time-budget probe (see `preview_gpu::TimingReport`).
    pub inter_emit: PreviewGpuTimingSummary,
    pub inter_ack: PreviewGpuTimingSummary,
    pub recv_block: PreviewGpuTimingSummary,
    pub recv_timeout_ticks: u32,
    pub recv_ack_msgs: u32,
    pub recv_req_msgs: u32,
    // Stall attribution (see `preview_gpu::TimingReport`).
    pub eof_returns: u32,
    pub pool_full_returns: u32,
    pub acquire_failed: u32,
    pub final_free_slots: u32,
    pub final_eof: bool,
    /// Fencing-token counters (see `preview_gpu::TimingReport`): leases the
    /// owner reclaimed on timeout, and acks dropped on a generation mismatch.
    pub lease_timeouts: u32,
    pub stale_gen_acks: u32,
    /// Session pool VRAM in bytes (`width × height × 4 × slots`, RGBA8). f64:
    /// byte counts outgrow the u32 counters' clamp convention.
    pub pool_slot_bytes: f64,
}

/// How a preview decode session decodes and what it ships. Every field is
/// optional; an empty object is the software lane, NV12, full size, every frame.
#[napi(object)]
pub struct PreviewDecodeOptions {
    /// `"nvdec"`, `"vaapi"` or `"videotoolbox"` decode on that hardware lane and
    /// copy each frame back to CPU memory; absent or `"software"` decodes with
    /// libavcodec. Either way the shipped bytes are the same. An unknown lane is
    /// treated as software: callers open only lanes they have probed.
    pub lane: Option<String>,
    /// The DRM render node a `vaapi` lane decodes on (libva's default device
    /// is often the wrong GPU on a multi-GPU host); ignored by other lanes.
    pub device: Option<String>,
    /// Playback-resolution divisor (1 | 2 | 4; absent = 1): frames are scaled
    /// down to `source / scaleDiv` before they are packed, so a 4K frame
    /// crosses IPC at a fraction of its size. Native owns the dimension math
    /// (even rounding, small-source floor); the open reply and every frame
    /// report the shipped size.
    pub scale_div: Option<u32>,
    /// Output cadence divisor (absent = 1): decode still consumes every source
    /// frame, but only every Nth is copied back, scaled, packed and shipped.
    pub cadence_div: Option<u32>,
    /// The packed layout: NV12 (absent, and for any unknown value) or I420P10,
    /// which the renderer asks for for a 10-bit source on the videotoolbox
    /// lane. Each frame's own `format` names what it carries.
    #[napi(ts_type = "'NV12' | 'I420P10'")]
    pub out_format: Option<String>,
}

/// The colour of the YCbCr planes a byte session ships, handed in at open: the
/// renderer's `nativePlaneColor`, which it reads the planes back with. An
/// RGB-coded source's frames are converted into it; a matrix the planes cannot
/// carry fails the open (`PlaneColor::parse`).
#[napi(object)]
pub struct PlaneColorInit {
    /// A WebCodecs YCbCr matrix name (`bt709`, `smpte170m`, `bt470bg`).
    pub matrix: String,
    pub full_range: bool,
}

impl PlaneColorInit {
    fn parse(&self) -> napi::Result<crate::preview_sw::decoder::PlaneColor> {
        crate::preview_sw::decoder::PlaneColor::parse(&self.matrix, self.full_range)
            .map_err(napi::Error::from_reason)
    }
}

/// Reply of `preview_decode_open`: the dimensions the session's frames will
/// SHIP at (`scaleDiv` already applied), which can be smaller than the source's.
#[napi(object)]
pub struct PreviewDecodeOpenInfo {
    pub width: u32,
    pub height: u32,
}

/// Verdict of a one-frame SW decode probe. `codec`/`pix_fmt` echo what
/// libavformat identified — main derives the capability-cache class key from
/// these (probe-informed, not caller-guessed).
#[napi(object)]
pub struct PreviewSwProbeResult {
    pub ok: bool,
    pub codec: Option<String>,
    pub pix_fmt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub reason: Option<String>,
}

/// Verdict of a one-frame HW (d3d11va) decode probe. Unlike the SW probe,
/// main supplies `classKey` (derived from `MediaSummary` before deciding to
/// probe, since the HW probe is comparatively expensive) — this result carries
/// no codec/pix_fmt/width/height echo.
#[napi(object)]
pub struct PreviewGpuProbeResult {
    pub ok: bool,
    pub reason: Option<String>,
}

// ── export-decode wire structs ───────────────────────────────────────────────

/// Reply of `export_decode_open`: the decoded stream's dimensions, source color
/// tags, and source-normalized start PTS (the offset applied to every frame's
/// `pts_us`). The color tags are the session's; its frames carry none.
/// `start_pts_us` crosses as `f64` (napi has no ergonomic `i64`), matching the
/// `pts_us`/`target_us` convention. Color tags are canonical FFmpeg string
/// names or `null` where unspecified.
#[napi(object)]
pub struct ExportDecodeOpenInfo {
    pub width: u32,
    pub height: u32,
    pub color_matrix: Option<String>,
    pub color_range: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub start_pts_us: f64,
}

/// The component's ffmpeg linkage identity — the SW capability-cache envKey.
/// Changes when the bundled/loaded avcodec changes.
// `allow`, not `expect`: rustc's dead-code pass treats expect(dead_code) on a
// #[napi] fn as a live root and never registers fulfillment, so expect would
// warn `unfulfilled_lint_expectations` in the very build it exists for.
#[cfg_attr(
    test,
    allow(
        dead_code,
        reason = "napi/noop test builds erase the #[napi] export that is the only caller (Cargo.toml test-noop note)"
    )
)]
#[napi]
pub fn version_info() -> String {
    format!(
        "avcodec={} avutil={}",
        ffmpeg_next::codec::version(),
        ffmpeg_next::util::version()
    )
}

/// The decode lanes THIS build actually compiled in — the component's capability
/// advertisement (ADR 0029). `"software"` is unconditional
/// (the libavcodec SW lane builds on every platform); the `"d3d11va"` HW-preview
/// lane rides the SAME `#[cfg(windows)]` gate as the `preview_gpu` module it
/// names, so the advertisement can never claim a lane the addon didn't compile.
/// On Linux (issue #5 Block C) the copy-back HW lanes are advertised: `"nvdec"`
/// unconditionally (a missing libcuda makes the probe Err cleanly, no abort) and
/// `"vaapi"` ONLY when the bundled libva can copy back — the BtbN ffmpeg calls
/// `vaMapBuffer2` unconditionally, so a libva without it (glibc too old to load
/// the bundled >= 2.21 copy, or a stale system libva) aborts the process
/// UNCATCHABLY on the first mapped frame. The lane is gated on
/// [`crate::preview_sw::decoder::vaapi_copyback_supported`] (which also pins the
/// bundled libva so the implib resolves it) rather than advertised and later
/// crashed. On macOS (issue #10) the `"videotoolbox"` copy-back lane is
/// advertised unconditionally: VideoToolbox is an OS framework present on every
/// supported Mac, and where a decode is refused (unsupported codec/machine) the
/// one-frame probe Errs cleanly — no abort — so the resolver's cached
/// probe-verdict machinery, not the advertisement, is the gate (same posture as
/// NVDEC). Resolvers probe ONLY advertised lanes: on Linux, where
/// `preview_gpu_probe` is a by-design stub returning a "not built" verdict, the
/// d3d11va lane is never advertised and so is never probed.
// `allow`, not `expect`: rustc's dead-code pass treats expect(dead_code) on a
// #[napi] fn as a live root and never registers fulfillment, so expect would
// warn `unfulfilled_lint_expectations` in the very build it exists for.
#[cfg_attr(
    test,
    allow(
        dead_code,
        reason = "napi/noop test builds erase the #[napi] export that is the only caller (Cargo.toml test-noop note)"
    )
)]
#[napi]
pub fn capabilities() -> Vec<String> {
    #[allow(unused_mut)]
    let mut lanes = vec!["software".to_string()];
    #[cfg(windows)]
    lanes.push("d3d11va".to_string());
    #[cfg(target_os = "linux")]
    {
        lanes.push("nvdec".to_string());
        if crate::preview_sw::decoder::vaapi_copyback_supported() {
            lanes.push("vaapi".to_string());
        }
    }
    #[cfg(target_os = "macos")]
    {
        lanes.push("videotoolbox".to_string());
    }
    lanes
}

#[napi]
pub struct NativeDecode {
    #[cfg(windows)]
    preview_gpu: crate::preview_gpu::PreviewGpuSessions,
    preview_decode: crate::preview_sw::PreviewSessions,
    export_decode: crate::export_sw::ExportSessions,
}

#[napi]
impl NativeDecode {
    /// Every session's messages go to the callback it was opened with; the
    /// component itself emits nothing.
    #[napi(constructor)]
    pub fn new() -> Self {
        NativeDecode {
            #[cfg(windows)]
            preview_gpu: crate::preview_gpu::PreviewGpuSessions::new(),
            preview_decode: crate::preview_sw::PreviewSessions::new(),
            export_decode: crate::export_sw::ExportSessions::new(),
        }
    }
}

// ── GPU methods (Windows) ────────────────────────────────────────────────────

/// Native GPU-decode preview command surface. Backed by
/// `NativeDecode::preview_gpu`; filled slots, the end of the material and
/// errors reach JS in band as [`DecodeMsg`] on the callback the session was
/// opened with.
#[cfg(windows)]
#[napi]
impl NativeDecode {
    /// Open `path` for GPU preview: spawns the session's decode thread and
    /// returns the shared RGBA8 pool's slot handles + frame dimensions.
    /// `matrix`/`full_range` are the stream's color tags (the same derivation
    /// the renderer ships with the open request) — they select the native
    /// NV12→RGBA conversion constants, so the shared texture is already
    /// working-space RGBA and main imports it tagged sRGB-passthrough.
    /// `on_msg` belongs to the session: every message goes to it, and it is
    /// dropped when the session closes or the open fails. Slots fill only
    /// after the first `preview_gpu_request_frame_at`.
    #[napi]
    pub fn preview_gpu_open(
        &self,
        session_id: String,
        path: String,
        pool_size: u32,
        matrix: String,
        full_range: bool,
        on_msg: ThreadsafeFunction<DecodeMsg>,
    ) -> napi::Result<PreviewGpuOpenInfo> {
        let info = self
            .preview_gpu
            .open(
                &session_id,
                &path,
                pool_size,
                &matrix,
                full_range,
                session_sink(on_msg),
            )
            .map_err(napi::Error::from_reason)?;
        Ok(PreviewGpuOpenInfo {
            width: info.width,
            height: info.height,
            adapter: info.adapter.map(|a| PreviewGpuAdapter {
                name: a.name,
                vendor_id: a.vendor_id,
                device_id: a.device_id,
                luid: a.luid,
            }),
            slots: info
                .slot_handles
                .into_iter()
                .map(|h| PreviewGpuSlot {
                    handle: Buffer::from(h.to_vec()),
                })
                .collect(),
        })
    }

    /// Move the session's decode anchor. `target_us` is an `f64` (napi has no
    /// ergonomic `i64` param binding) carrying source microseconds; cast down
    /// to the `i64` the session expects.
    #[napi]
    pub fn preview_gpu_request_frame_at(
        &self,
        session_id: String,
        target_us: f64,
    ) -> napi::Result<()> {
        self.preview_gpu
            .request_frame_at(&session_id, target_us as i64)
            .map_err(napi::Error::from_reason)
    }

    /// Hand a slot back to the pool once the consumer's read of it has
    /// completed. `gen` echoes the `slot` message that delivered it (fencing
    /// token — a mismatch is dropped native-side as stale).
    #[napi]
    pub fn preview_gpu_release(&self, session_id: String, slot: u32, gen: u32) -> napi::Result<()> {
        self.preview_gpu
            .release(&session_id, slot, gen)
            .map_err(napi::Error::from_reason)
    }

    /// Tear down a session within a bounded grace. The session emits nothing
    /// after this returns; messages it had already queued for JS still arrive.
    #[napi]
    pub fn preview_gpu_close(&self, session_id: String) -> napi::Result<()> {
        self.preview_gpu
            .close(&session_id)
            .map_err(napi::Error::from_reason)
    }

    /// One-frame HW decode probe: does d3d11va yield a decodable D3D11
    /// surface for this codec on this GPU? Calls the decoder-level primitive
    /// directly (no session, no pool) — a throwaway open + one-frame decode is
    /// self-contained and self-bounding, unlike the streaming
    /// `preview_gpu_open` session. The `D3d11Frame` on success is dropped
    /// immediately (its `Drop` releases the GPU texture); only the ok/err
    /// verdict is returned. `timeout_ms` is advisory (kept for API symmetry
    /// with `preview_hw_probe`) — this synchronous primitive has no internal
    /// deadline machinery to wire it to.
    #[napi]
    pub fn preview_gpu_probe(
        &self,
        path: String,
        _timeout_ms: u32,
    ) -> napi::Result<PreviewGpuProbeResult> {
        match crate::preview_gpu::decoder::decode_first_d3d11_frame(&path) {
            Ok(_frame) => Ok(PreviewGpuProbeResult {
                ok: true,
                reason: None,
            }),
            Err(e) => Ok(PreviewGpuProbeResult {
                ok: false,
                reason: Some(e),
            }),
        }
    }

    /// Drain + return this session's per-frame timing samples (coord-RTT + decode/copy).
    #[napi]
    pub fn preview_gpu_take_timings(
        &self,
        session_id: String,
    ) -> napi::Result<PreviewGpuTimingReport> {
        let rep = self
            .preview_gpu
            .take_timings(&session_id)
            .map_err(napi::Error::from_reason)?;
        // Counts stay far under u32 in a bench window (see `note_lookahead_gated_skip`);
        // saturate defensively rather than silently wrap on the cast.
        let clamp = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
        Ok(PreviewGpuTimingReport {
            coord_rtt: to_napi_timing_summary(rep.coord_rtt),
            decode_copy: to_napi_timing_summary(rep.decode_copy),
            convert_gpu: to_napi_timing_summary(rep.convert_gpu),
            ack_to_emit: to_napi_timing_summary(rep.ack_to_emit),
            lookahead_gated_skips: clamp(rep.lookahead_gated_skips),
            late_frame_drops: clamp(rep.late_frame_drops),
            inter_emit: to_napi_timing_summary(rep.inter_emit),
            inter_ack: to_napi_timing_summary(rep.inter_ack),
            recv_block: to_napi_timing_summary(rep.recv_block),
            recv_timeout_ticks: clamp(rep.recv_timeout_ticks),
            recv_ack_msgs: clamp(rep.recv_ack_msgs),
            recv_req_msgs: clamp(rep.recv_req_msgs),
            eof_returns: clamp(rep.eof_returns),
            pool_full_returns: clamp(rep.pool_full_returns),
            acquire_failed: clamp(rep.acquire_failed),
            final_free_slots: rep.final_free_slots,
            final_eof: rep.final_eof,
            lease_timeouts: clamp(rep.lease_timeouts),
            stale_gen_acks: clamp(rep.stale_gen_acks),
            pool_slot_bytes: rep.pool_slot_bytes as f64,
        })
    }
}

#[cfg(windows)]
fn to_napi_timing_summary(s: crate::preview_gpu::TimingSummary) -> PreviewGpuTimingSummary {
    PreviewGpuTimingSummary {
        count: s.count,
        mean_ms: s.mean_ms,
        p50_ms: s.p50_ms,
        p95_ms: s.p95_ms,
        max_ms: s.max_ms,
    }
}

/// Fallback surface when the addon wasn't built with GPU preview support
/// (non-Windows): the methods still exist so JS callers get a clean rejection
/// instead of a missing-method TypeError.
#[cfg(not(windows))]
#[napi]
impl NativeDecode {
    #[napi]
    pub fn preview_gpu_open(
        &self,
        _session_id: String,
        _path: String,
        _pool_size: u32,
        _matrix: String,
        _full_range: bool,
        _on_msg: ThreadsafeFunction<DecodeMsg>,
    ) -> napi::Result<PreviewGpuOpenInfo> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_request_frame_at(
        &self,
        _session_id: String,
        _target_us: f64,
    ) -> napi::Result<()> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_release(
        &self,
        _session_id: String,
        _slot: u32,
        _gen: u32,
    ) -> napi::Result<()> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_close(&self, _session_id: String) -> napi::Result<()> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_take_timings(
        &self,
        _session_id: String,
    ) -> napi::Result<PreviewGpuTimingReport> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    /// Non-Windows: the HW lane doesn't exist. Unlike the other GPU stubs
    /// above, this returns a verdict (`Ok`) rather than an `Err` — the caller
    /// (`decodeCap:probeHw`) treats capability probes as verdicts, never
    /// errors, so main can cache/branch on `ok` uniformly across platforms.
    #[napi]
    pub fn preview_gpu_probe(
        &self,
        _path: String,
        _timeout_ms: u32,
    ) -> napi::Result<PreviewGpuProbeResult> {
        Ok(PreviewGpuProbeResult {
            ok: false,
            reason: Some("preview-gpu not built".into()),
        })
    }
}

// ── preview-decode methods (all platforms) ───────────────────────────────────

/// One session's messages, in producer order, on its own JS callback.
///
/// LANDMINE: NonBlocking on the default UNBOUNDED tsfn queue. A bounded queue
/// would silently drop messages — control signals included — under
/// backpressure. One queue per session is what keeps JS observing messages in
/// the order the session produced them.
fn session_sink(on_msg: ThreadsafeFunction<DecodeMsg>) -> Sink {
    Box::new(move |msg| {
        let _ = on_msg.call(Ok(msg), ThreadsafeFunctionCallMode::NonBlocking);
    })
}

/// Native preview decode command surface (cross-platform): the software lane
/// and the copy-back hardware lanes, ADR 0029. Backed by
/// `NativeDecode::preview_decode`; frames, the end of the material and errors
/// reach JS in band as [`DecodeMsg`] on the callback the session was opened
/// with.
#[napi]
impl NativeDecode {
    /// Open `path` for preview: spawn the session's decode thread and return
    /// the shipped frame dimensions, its planes carrying `color`. `on_msg`
    /// belongs to the session: every
    /// message goes to it, and it is dropped when the session closes or the
    /// open fails. Fails if the id is already open or the decoder (a hardware
    /// device included) cannot open, so the caller can fall back. Frames flow
    /// only after the first `preview_decode_fill_from`.
    #[napi]
    pub fn preview_decode_open(
        &self,
        session_id: String,
        path: String,
        options: PreviewDecodeOptions,
        color: PlaneColorInit,
        on_msg: ThreadsafeFunction<DecodeMsg>,
    ) -> napi::Result<PreviewDecodeOpenInfo> {
        use crate::preview_sw::decoder::{DecodeAccel, OutScale, OutputCadence, SwOutFormat};
        let accel = match options.lane.as_deref() {
            Some("nvdec") => DecodeAccel::Nvdec,
            Some("vaapi") => DecodeAccel::Vaapi {
                device: options.device.unwrap_or_default(),
            },
            Some("videotoolbox") => DecodeAccel::VideoToolbox,
            _ => DecodeAccel::Software,
        };
        let out_format = match options.out_format.as_deref() {
            Some("I420P10") => SwOutFormat::I420p10,
            _ => SwOutFormat::Nv12,
        };
        let options = crate::preview_sw::PreviewOpenOptions {
            accel,
            out_format,
            plane_color: color.parse()?,
            out_scale: options
                .scale_div
                .map_or(OutScale::FULL, OutScale::from_divisor),
            output_cadence: options
                .cadence_div
                .map_or(OutputCadence::FULL, OutputCadence::from_divisor),
        };
        let info = self
            .preview_decode
            .open(&session_id, &path, options, session_sink(on_msg))
            .map_err(napi::Error::from_reason)?;
        Ok(PreviewDecodeOpenInfo {
            width: info.width,
            height: info.height,
        })
    }

    /// Ask for every frame from `target_us` (source µs, as `f64`: napi has no
    /// ergonomic `i64`) through the session's lookahead horizon, in answer to
    /// `request_id`. Frames carry the id of the request they answer; a new id
    /// is a discontinuity, so the session re-seeks and stops sending frames of
    /// earlier requests. The newest request wins over any still queued.
    #[napi]
    pub fn preview_decode_fill_from(
        &self,
        session_id: String,
        target_us: f64,
        request_id: u32,
    ) -> napi::Result<()> {
        self.preview_decode
            .fill_from(&session_id, target_us as i64, request_id)
            .map_err(napi::Error::from_reason)
    }

    /// Hand back the lease of a frame the consumer has taken or dropped. A
    /// lease not in flight (already returned, or never granted) is ignored.
    #[napi]
    pub fn preview_decode_release(&self, session_id: String, lease: u32) -> napi::Result<()> {
        self.preview_decode
            .release(&session_id, lease)
            .map(|_| ())
            .map_err(napi::Error::from_reason)
    }

    /// Tear down a session within a bounded grace. The session emits nothing
    /// after this returns; messages it had already queued for JS still arrive.
    #[napi]
    pub fn preview_decode_close(&self, session_id: String) -> napi::Result<()> {
        self.preview_decode
            .close(&session_id)
            .map_err(napi::Error::from_reason)
    }
}

/// One-shot decode probes: no session, a verdict per call. Main asks them
/// before it opens a lane.
#[napi]
impl NativeDecode {
    /// One-frame decode probe for the SW lane. Opens a THROWAWAY stream (never
    /// registered in the session registry), decodes one frame, closes. Failure
    /// is a verdict, not an error — Err only for panics worth surfacing.
    #[napi]
    pub fn preview_sw_probe(&self, path: String) -> napi::Result<PreviewSwProbeResult> {
        match crate::preview_sw::decoder::SwVideoStream::open(&path) {
            Ok(mut stream) => {
                let (codec, pix_fmt, width, height) = stream.probe_identity();
                match stream.next_frame() {
                    Ok(Some(_frame)) => Ok(PreviewSwProbeResult {
                        ok: true,
                        codec: Some(codec),
                        pix_fmt: Some(pix_fmt),
                        width,
                        height,
                        reason: None,
                    }),
                    Ok(None) => Ok(PreviewSwProbeResult {
                        ok: false,
                        codec: Some(codec),
                        pix_fmt: Some(pix_fmt),
                        width,
                        height,
                        reason: Some("no decodable frame".into()),
                    }),
                    Err(e) => Ok(PreviewSwProbeResult {
                        ok: false,
                        codec: Some(codec),
                        pix_fmt: Some(pix_fmt),
                        width,
                        height,
                        reason: Some(e.to_string()),
                    }),
                }
            }
            Err(e) => Ok(PreviewSwProbeResult {
                ok: false,
                codec: None,
                pix_fmt: None,
                width: 0,
                height: 0,
                reason: Some(e.to_string()),
            }),
        }
    }

    /// One-frame HARDWARE decode probe (issue #5 Block C; `videotoolbox`: issue
    /// #10). `lane` is `"nvdec"`, `"vaapi"`, or `"videotoolbox"`; for `vaapi`,
    /// `device` is the DRM render node this probe targets
    /// (main enumerates the nodes and probes each). Opens a throwaway stream on
    /// that hardware lane, decodes one frame, and confirms the surface came back
    /// HARDWARE-decoded — a silent software fallback counts as `ok:false`, so the
    /// resolver's per-machine cache records the negative and the Standard engine
    /// stays on its software lane. Failure is a verdict, not an error (matches the
    /// SW and d3d11va probes): callers branch on `ok`, never catch. Reuses
    /// `PreviewGpuProbeResult` — main-supplied classKey, no codec/dims echo.
    /// `_timeout_ms` is advisory (kept for API symmetry with the other probes) —
    /// this synchronous one-frame decode has no deadline machinery to wire it to.
    #[napi]
    pub fn preview_hw_probe(
        &self,
        path: String,
        lane: String,
        device: Option<String>,
        _timeout_ms: u32,
    ) -> napi::Result<PreviewGpuProbeResult> {
        use crate::preview_sw::decoder::DecodeAccel;
        let accel = match lane.as_str() {
            "nvdec" => DecodeAccel::Nvdec,
            "vaapi" => DecodeAccel::Vaapi {
                device: device.unwrap_or_default(),
            },
            "videotoolbox" => DecodeAccel::VideoToolbox,
            other => {
                return Ok(PreviewGpuProbeResult {
                    ok: false,
                    reason: Some(format!("unknown hw lane '{other}'")),
                })
            }
        };
        match crate::preview_sw::decoder::probe_hw_first_frame(&path, accel) {
            Ok(()) => Ok(PreviewGpuProbeResult {
                ok: true,
                reason: None,
            }),
            Err(e) => Ok(PreviewGpuProbeResult {
                ok: false,
                reason: Some(e),
            }),
        }
    }
}

// ── export-decode methods (all platforms) ────────────────────────────────────

/// Native export software-decode command surface (cross-platform; the
/// export-decode overlay, ADR 0030 and ADR 0033). Backed by
/// `NativeDecode::export_decode`; decoded frames and the control signals
/// reach JS in-band as [`DecodeMsg`] on the callback the session was opened
/// with. The driving contract (open → range → release → close) is what the
/// export Worker's `ExportDecodeSession` handle sits behind.
#[napi]
impl NativeDecode {
    /// Open `path` for export decode into `out_format`, with at most `window`
    /// frames (leases) in flight, its planes carrying `color`. `on_msg`
    /// belongs to the session: every
    /// message goes to it, and it is dropped when the session closes or the
    /// open fails. Fails loudly if the id is already open, the format can't be
    /// emitted or the decoder can't open. Returns dimensions, source color tags,
    /// and start PTS.
    #[napi]
    pub fn export_decode_open(
        &self,
        session_id: String,
        path: String,
        #[napi(ts_arg_type = "'NV12' | 'I420P10'")] out_format: String,
        window: u32,
        color: PlaneColorInit,
        on_msg: ThreadsafeFunction<DecodeMsg>,
    ) -> napi::Result<ExportDecodeOpenInfo> {
        let plane_color = color.parse()?;
        let info = self
            .export_decode
            .open(
                &session_id,
                &path,
                &out_format,
                window,
                plane_color,
                session_sink(on_msg),
            )
            .map_err(napi::Error::from_reason)?;
        Ok(ExportDecodeOpenInfo {
            width: info.width,
            height: info.height,
            color_matrix: info.color.matrix,
            color_range: info.color.range,
            color_primaries: info.color.primaries,
            color_transfer: info.color.transfer,
            start_pts_us: info.start_pts_us as f64,
        })
    }

    /// Decode the presentation range `[a_us, b_us]` (source-normalized µs, b
    /// inclusive). Fire-and-forget: `bytes` messages arrive on the session's
    /// callback, followed in-band by a `mark` (or `end` then `mark` at stream
    /// end) once the range is satisfied. `a_us`/`b_us` cross as `f64` (no
    /// ergonomic napi `i64`).
    #[napi]
    pub fn export_decode_range(
        &self,
        session_id: String,
        a_us: f64,
        b_us: f64,
    ) -> napi::Result<()> {
        self.export_decode
            .decode_range(&session_id, a_us as i64, b_us as i64)
            .map_err(napi::Error::from_reason)
    }

    /// Hand back the lease of a frame that has left the consumer, resuming a
    /// producer parked on a full window. Safe while a range is in flight; a
    /// lease not in flight (already returned, or never granted) is ignored.
    #[napi]
    pub fn export_decode_release(&self, session_id: String, lease: u32) -> napi::Result<()> {
        self.export_decode
            .release(&session_id, lease)
            .map(|_| ())
            .map_err(napi::Error::from_reason)
    }

    /// Tear down a session: wakes a parked producer, abandons the range in
    /// progress and returns within a bounded grace. The session emits nothing
    /// after this returns; messages it had already queued for JS still arrive.
    #[napi]
    pub fn export_decode_close(&self, session_id: String) -> napi::Result<()> {
        self.export_decode
            .close(&session_id)
            .map_err(napi::Error::from_reason)
    }
}
