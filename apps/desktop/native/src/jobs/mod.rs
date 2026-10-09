//! Background-job pipeline for media derivatives.
//!
//! Each `enqueue_*` spawns a tokio task that adopts valid cached artifacts
//! before acquiring application-wide background resources for generation.
//! On completion, the task routes the
//! `MediaItem`'s derivative patch through `commit_media_derivatives`, which
//! always emits a `media:derivatives` event the TS state actor (the sole
//! writer, applied by Electron main) consumes — so subscribers (UI,
//! hot-reload, MCP change feed) re-fetch.
//!
//! Atomicity: all writes go through `cache::temp_path` + `promote_temp`. A
//! killed ffmpeg leaves a `<dest>.tmp` that the next run discards, never a
//! zero-byte `<dest>` that fools skip-if-cached.
//!
//! Events for UI:
//! - `media:job_started`  — `{ media_id, kind }`
//! - `media:job_complete` — `{ media_id, kind, path? }`
//! - `media:job_error`    — `{ media_id, kind, error }`

pub mod conform;
pub(crate) mod diagnostics;
pub mod filmstrip;
mod frame;
pub mod hwaccel;
pub mod import;
pub mod proxy;
pub mod proxy_decision;
pub mod quick_proxy;
pub mod shot;
pub(crate) mod singleflight;
mod thumbnails;
pub mod waveform;

pub use frame::extract as extract_frame;
pub use waveform::read_peaks_file;

use serde::Serialize;
use std::sync::Arc;

use crate::events::EventSink;
use tracing::{debug, info, warn};

use crate::cache::CacheLayout;
use crate::logs::{LogBusSlot, LogCategory, LogEntryInput, LogLevel, LogSource};
use crate::state::{
    CommandError, DecodeRoute, FullProxyLanded, MediaDerivativesPatch, MediaId, MediaItem,
    MediaKind,
};

/// Emit a completed job's derivative patch as `media:derivatives {media_id,
/// patch}` for the TS state actor (the sole writer, applied by Electron main)
/// to consume. The patch serializes with the absent/null/string tri-state for
/// the `Option<Option<PathBuf>>` proxy fields. Always `Ok` (fire-and-forget;
/// the TS actor's `set_media_derivatives` is `MediaNotFound`-tolerant and the
/// caller only logs failures). `pub(crate)` so the napi open-time derivative
/// fan-out can reuse the same seam for stale-proxy clearing.
pub(crate) async fn commit_media_derivatives(
    events: &Arc<dyn EventSink>,
    media_id: MediaId,
    patch: MediaDerivativesPatch,
) -> Result<(), CommandError> {
    events.emit(
        "media:derivatives",
        serde_json::json!({ "media_id": media_id.to_string(), "patch": patch }),
    );
    Ok(())
}

/// Emit the workspace-copy job's path/hash result as `media:workspace_paths` →
/// the TS host applies `set_media_workspace_paths`. Carries `file_size`/
/// `file_mtime` so the TS `WorkspacePaths` is fully populated. `pub(crate)`,
/// mirroring `commit_media_derivatives`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn commit_media_workspace_paths(
    events: &Arc<dyn EventSink>,
    media_id: MediaId,
    path_abs: std::path::PathBuf,
    path_rel: std::path::PathBuf,
    file_hash_blake3: String,
    file_size: u64,
    file_mtime: u64,
) -> Result<(), CommandError> {
    events.emit(
        "media:workspace_paths",
        serde_json::json!({
            "media_id": media_id.to_string(),
            "path_abs": path_abs,
            "path_rel": path_rel,
            "file_hash_blake3": file_hash_blake3,
            "file_size": file_size,
            "file_mtime": file_mtime,
        }),
    );
    Ok(())
}

pub const EVENT_STARTED: &str = "media:job_started";
pub const EVENT_COMPLETE: &str = "media:job_complete";
pub const EVENT_ERROR: &str = "media:job_error";

/// Background admission shared with native/renderer work and inference.
/// The authority owns thread, memory, playback and pressure checks.
pub(crate) fn ffmpeg_sem() -> &'static crate::resources::BackgroundGate {
    &crate::resources::BackgroundGate
}

/// Cache adoption is bookkeeping, not processing: it must remain possible
/// while playback, memory pressure or other work closes background admission.
/// Keep completion/write-back events so readers can recover missing paths.
async fn run_derivative(
    events: &Arc<dyn EventSink>,
    cache: &CacheLayout,
    media: &MediaItem,
    kind: JobKind,
    generate: impl std::future::Future<Output = anyhow::Result<std::path::PathBuf>>,
) -> anyhow::Result<std::path::PathBuf> {
    let mut timer = diagnostics::StageTimer::new(
        events.clone(),
        serde_json::to_value(kind)?.as_str().unwrap_or("unknown"),
        None,
        Some(media.id.to_string()),
    );
    cache.check_active()?;
    if let Some(path) = cached_derivative(cache, media, kind) {
        timer.hit();
        timer.finish(&Ok(()));
        return Ok(path);
    }
    emit(
        events,
        EVENT_STARTED,
        &JobStarted {
            media_id: media.id.to_string(),
            kind,
        },
    );
    let result = singleflight::run(cache, media, kind, async {
        if let Some(path) = cached_derivative(cache, media, kind) {
            timer.hit();
            return Ok(path);
        }
        // Audio needed for editing must not sit behind full-length transcodes.
        // Keep both permit types alive until the producer has exited.
        let (_preparation, _background) = if matches!(kind, JobKind::Conform | JobKind::Waveform) {
            let permit = tokio::select! {
                permit = crate::resources::import_preparation() => permit?,
                _ = cache.cancelled() => anyhow::bail!("workspace cancelled"),
            };
            (Some(permit), None)
        } else {
            let permit = tokio::select! {
                permit = ffmpeg_sem().acquire() => permit?,
                _ = cache.cancelled() => anyhow::bail!("workspace cancelled"),
            };
            (None, Some(permit))
        };
        timer.start();
        cache.check_active()?;
        let result = generate.await;
        cache.check_active()?;
        result
    })
    .await;
    timer.finish(&result);
    result
}

fn cached_derivative(
    cache: &CacheLayout,
    media: &MediaItem,
    kind: JobKind,
) -> Option<std::path::PathBuf> {
    let hash = &media.file_hash_blake3;
    match kind {
        JobKind::Conform => conform::cached_path(cache, media),
        JobKind::Thumbnails => {
            thumbnails::all_thumbnails_present(cache, hash).then(|| cache.thumbnails(hash))
        }
        JobKind::Waveform => waveform::cached_path(cache, media),
        JobKind::QuickProxy => {
            let path = cache.quick_proxy(hash);
            crate::cache::valid_mp4(&path).then_some(path)
        }
        JobKind::Proxy => proxy::cached_path(cache, media),
        JobKind::AudioFx | JobKind::ProxyBypass => None,
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Thumbnails,
    Proxy,
    #[serde(rename = "quick_proxy")]
    QuickProxy,
    #[serde(rename = "proxy_bypass")]
    ProxyBypass,
    Waveform,
    Conform,
    #[serde(rename = "audio_fx")]
    AudioFx,
}

#[derive(Debug, Clone, Serialize)]
struct JobStarted {
    media_id: String,
    kind: JobKind,
}

#[derive(Debug, Clone, Serialize)]
struct JobComplete {
    media_id: String,
    kind: JobKind,
    path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct JobError {
    media_id: String,
    kind: JobKind,
    error: String,
}

/// Human name for a job kind in console messages.
fn job_kind_label(kind: JobKind) -> &'static str {
    match kind {
        JobKind::Thumbnails => "Thumbnail",
        JobKind::Proxy => "Proxy",
        JobKind::QuickProxy => "Quick-proxy",
        JobKind::ProxyBypass => "Proxy-bypass",
        JobKind::Waveform => "Waveform",
        JobKind::Conform => "Audio-conform",
        JobKind::AudioFx => "Audio effects",
    }
}

/// What the console line calls this media: the explicit label when set,
/// else the file name — never a raw uuid.
fn media_display_name(media: &MediaItem) -> String {
    if let Some(label) = &media.label {
        if !label.is_empty() {
            return label.clone();
        }
    }
    media
        .path_abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| media.id.to_string())
}

/// Report a failed derivative job: the `media:job_error` renderer event
/// (status-bar pill decrement + readiness flip) plus one Err row on the
/// log bus so the failure leaves a durable, user-readable trace. Err only
/// by design — liveness while jobs grind is owned by the status-bar pill,
/// and per-job Started/Ok rows would flood the console on bulk imports
/// (docs/status-log.md).
fn emit_job_error(
    events: &Arc<dyn EventSink>,
    log_slot: &LogBusSlot,
    media: &MediaItem,
    kind: JobKind,
    error: String,
) {
    if error.contains("workspace cancelled") {
        return;
    }
    emit_job_error_named(
        events,
        log_slot,
        media.id,
        &media_display_name(media),
        kind,
        error,
    );
}

/// `emit_job_error` for a job whose driver never holds the `MediaItem` — the
/// audio-effect bake is addressed by artifact path, so `display` names the
/// row's subject instead.
fn emit_job_error_named(
    events: &Arc<dyn EventSink>,
    log_slot: &LogBusSlot,
    media_id: MediaId,
    display: &str,
    kind: JobKind,
    error: String,
) {
    emit(
        events,
        EVENT_ERROR,
        &JobError {
            media_id: media_id.to_string(),
            kind,
            error: error.clone(),
        },
    );
    log_slot.emit(LogEntryInput {
        level: LogLevel::Error,
        category: LogCategory::Job,
        source: LogSource::System,
        message: format!("{} job failed for {display}: {error}", job_kind_label(kind)),
        details: Some(serde_json::json!({
            "media_id": media_id.to_string(),
            "kind": kind,
        })),
        ..Default::default()
    });
}

/// Enqueue ONLY the full export proxy for a media item (no quick proxy, no
/// decision). Used by the export decode-failure recovery (`ensure_full_proxy`
/// command) when a DirectExport original turns out to be undecodable on this
/// machine. Returns immediately; the job runs on tokio::spawn.
pub fn enqueue_full_proxy(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    spawn_proxy(events, log_slot, cache, media);
}

/// On-demand quick-proxy build (per-clip "Generate proxy" / global Prefer
/// Proxies gap-fill). `then_full: false` — this never chains a full proxy.
/// `source_gop_secs: None` forces a transcode (safe scrub-proxy path); the
/// import fan-out probes the gap for its own build, on-demand keeps it simple.
#[cfg(feature = "jobs")]
pub fn enqueue_quick_proxy(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
    source_gop_secs: Option<f64>,
) {
    spawn_quick_proxy(events, log_slot, cache, media, false, source_gop_secs);
}

/// Look at a freshly imported `MediaItem` and fan out the appropriate
/// background jobs. Returns immediately; jobs run on tokio::spawn.
pub fn enqueue_for_media(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    if media.file_hash_blake3.starts_with("pending-") {
        return;
    }
    let cache = cache.snapshot();
    let events = cache.scoped_events(events);
    let mut planned = Vec::new();
    if matches!(media.kind, MediaKind::Video) {
        planned.push("thumbnails");
    }
    if media.metadata.audio.is_some() {
        planned.extend(["conform", "waveform"]);
    }
    let decision_pending = matches!(media.kind, MediaKind::Video)
        && proxy_decision::route_needs_decision(&media.decode_route);
    if matches!(media.kind, MediaKind::Video)
        && !decision_pending
        && !matches!(media.decode_route, DecodeRoute::Bypass)
    {
        planned.push("quick_proxy");
        if matches!(
            media.decode_route,
            DecodeRoute::Proxied { .. } | DecodeRoute::NativeSw { .. }
        ) {
            planned.push("proxy");
        }
    }
    diagnostics::plan(&events, media.id, &planned, decision_pending);
    spawn_decorations(
        events.clone(),
        log_slot.clone(),
        cache.clone(),
        media.clone(),
    );
    if matches!(media.kind, MediaKind::Video) {
        // Hydrate a preview artifact before a cold master or GOP probe can
        // encounter playback/pressure admission. Route selection is separate.
        if proxy_decision::route_needs_decision(&media.decode_route)
            && cached_derivative(&cache, &media, JobKind::QuickProxy).is_some()
        {
            spawn_quick_proxy(
                events.clone(),
                log_slot.clone(),
                cache.clone(),
                media.clone(),
                false,
                None,
            );
        }
        if proxy_decision::route_needs_decision(&media.decode_route) {
            spawn_proxy_decision(events, log_slot, cache, media);
        } else if !matches!(media.decode_route, DecodeRoute::Bypass) {
            if matches!(
                media.decode_route,
                DecodeRoute::Proxied { .. } | DecodeRoute::NativeSw { .. }
            ) {
                spawn_proxy(
                    events.clone(),
                    log_slot.clone(),
                    cache.clone(),
                    media.clone(),
                );
            }
            spawn_quick_proxy(events, log_slot, cache, media, false, None);
        }
    }
}

pub fn enqueue_waveform(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    spawn_waveform(events, log_slot, cache, media);
}
pub fn enqueue_thumbnails(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    spawn_thumbnails(events, log_slot, cache, media);
}

fn spawn_decorations(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    if matches!(media.kind, MediaKind::Video) {
        spawn_thumbnails(
            events.clone(),
            log_slot.clone(),
            cache.clone(),
            media.clone(),
        );
    }
    if media.metadata.audio.is_some() {
        let reuse_conform = media
            .metadata
            .audio
            .as_ref()
            .is_some_and(|audio| audio.sample_rate == 48_000 && audio.channels <= 2)
            && waveform::cached_path(&cache, &media).is_none();
        if reuse_conform {
            let cache = cache.snapshot();
            let conform = spawn_conform(
                events.clone(),
                log_slot.clone(),
                cache.clone(),
                media.clone(),
            );
            tokio::spawn(async move {
                let _ = conform.await;
                if !cache.is_cancelled() {
                    spawn_waveform(events, log_slot, cache, media);
                }
            });
        } else {
            spawn_waveform(
                events.clone(),
                log_slot.clone(),
                cache.clone(),
                media.clone(),
            );
            spawn_conform(events, log_slot, cache, media);
        }
    }
}

/// Enqueue ONLY the conform job (export readiness gate / backfill for media
/// imported without a conform, via the `ensure_conform` command). Returns
/// immediately.
pub fn enqueue_conform(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    spawn_conform(events, log_slot, cache, media);
}

fn spawn_conform(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) -> tokio::task::JoinHandle<()> {
    let cache = cache.snapshot();
    let log_slot = log_slot.snapshot();
    let events = cache.scoped_events(events);
    tokio::spawn(async move {
        if cache.is_cancelled() {
            return;
        }
        let media_id = media.id;
        let result = run_derivative(
            &events,
            &cache,
            &media,
            JobKind::Conform,
            conform::run(&cache, &media),
        )
        .await;
        if cache.is_cancelled() {
            return;
        }

        match result {
            Ok(conform_path) => {
                let path_str = conform_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    conform_path: Some(conform_path),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
                    warn!("conform commit failed for {media_id}: {e}");
                    emit_job_error(
                        &events,
                        &log_slot,
                        &media,
                        JobKind::Conform,
                        format!("commit: {e}"),
                    );
                    return;
                }
                info!("conform ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Conform,
                        path: Some(path_str),
                    },
                );
            }
            Err(e) => {
                warn!("conform job failed for {media_id}: {e:#}");
                emit_job_error(
                    &events,
                    &log_slot,
                    &media,
                    JobKind::Conform,
                    format!("{e:#}"),
                );
            }
        }
    })
}

fn spawn_proxy_decision(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    let cache = cache.snapshot();
    let log_slot = log_slot.snapshot();
    let events = cache.scoped_events(events);
    tokio::spawn(async move {
        if cache.is_cancelled() {
            return;
        }
        let media_id = media.id;
        // Reopen self-heal: the content-addressed full master is already on
        // disk but the route lost track of it (a build landed whose commit
        // never persisted before an HMR/crash reopen, or the workspace moved
        // and the stored absolute path went stale). Re-running the decision
        // would reset the route and re-enqueue the full build; adopt the master
        // instead — the same trust as `proxy::run`'s cached-ok early return (a
        // stale-format registered master is excluded by recipe validation). Proxied/NativeSw only: those
        // are the two variants a full master belongs to, and the fold ignores
        // it elsewhere.
        if matches!(
            media.decode_route,
            DecodeRoute::Proxied { .. } | DecodeRoute::NativeSw { .. }
        ) {
            if let Some(master) = proxy::cached_path(&cache, &media) {
                let patch = MediaDerivativesPatch {
                    full_proxy_landed: Some(Some(FullProxyLanded {
                        path: master.clone(),
                        format_version: proxy::PROXY_FORMAT_VERSION,
                    })),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
                    warn!("adopted-proxy commit failed for {media_id}: {e}");
                }
                info!("full proxy adopted from disk for {media_id} (reopen self-heal)");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Proxy,
                        path: Some(master.display().to_string()),
                    },
                );

                // Adopt or rebuild the quick preview accelerator without
                // re-chaining the
                // full build. `None` GOP forces the safe transcode path,
                // matching the on-demand build.
                diagnostics::plan(&events, media_id, &["quick_proxy"], false);
                spawn_quick_proxy(events, log_slot, cache, media, false, None);
                return;
            }
        }
        // Probe the source's keyframe interval (on a blocking worker — it
        // shells out to ffprobe) so the routing policy can demote long-GOP
        // friendly H.264 to a short-GOP scrub proxy instead of a direct decode.
        let mut timer = diagnostics::StageTimer::new(
            events.clone(),
            "gop_probe",
            None,
            Some(media_id.to_string()),
        );
        let gop_result = singleflight::source(&cache, &media.path_abs, "gop", async {
            let _permit = tokio::select! {
                permit = crate::resources::import_preparation() => permit?,
                _ = cache.cancelled() => anyhow::bail!("workspace cancelled"),
            };
            timer.start();
            let gap =
                crate::io::probe::probe_max_keyframe_gap_secs_scoped(&media.path_abs, &cache).await;
            cache.check_active()?;
            Ok(serde_json::to_string(&gap)?)
        })
        .await;
        timer.finish(&gop_result);
        let source_gop_secs = gop_result
            .ok()
            .and_then(|json| serde_json::from_str::<Option<f64>>(&json).ok())
            .flatten();
        if cache.is_cancelled() {
            return;
        }
        let route = proxy_decision::decide(&media, source_gop_secs);
        let planned: &[&str] = match proxy_decision::job_for(route) {
            proxy_decision::ProxyJob::None => &[],
            proxy_decision::ProxyJob::QuickOnly => &["quick_proxy"],
            proxy_decision::ProxyJob::QuickThenFull => &["quick_proxy", "proxy"],
        };
        diagnostics::plan(&events, media_id, planned, false);
        // Commit the authoritative initial route FIRST, then spawn the jobs the
        // route implies.
        let initial = DecodeRoute::from_proxy_route(route);
        let patch = MediaDerivativesPatch {
            set_route: Some(initial),
            ..Default::default()
        };
        if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
            warn!("route decision commit failed for {media_id}: {e}");
        }
        match proxy_decision::job_for(route) {
            proxy_decision::ProxyJob::None => {
                emit(
                    &events,
                    EVENT_STARTED,
                    &JobStarted {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                    },
                );
                info!("proxy bypass accepted for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
            }
            proxy_decision::ProxyJob::QuickOnly => {
                emit(
                    &events,
                    EVENT_STARTED,
                    &JobStarted {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                    },
                );
                info!("direct-export accepted for {media_id}; preview proxy queued");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
                // Thumbnails + waveform off the original; preview proxy in the
                // background WITHOUT chaining a full proxy.

                spawn_quick_proxy(events, log_slot, cache, media, false, source_gop_secs);
            }
            proxy_decision::ProxyJob::QuickThenFull => {
                spawn_quick_proxy(events, log_slot, cache, media, true, source_gop_secs);
            }
        }
    });
}

fn spawn_thumbnails(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    let cache = cache.snapshot();
    let log_slot = log_slot.snapshot();
    let events = cache.scoped_events(events);
    tokio::spawn(async move {
        if cache.is_cancelled() {
            return;
        }
        let media_id = media.id;
        let result = run_derivative(
            &events,
            &cache,
            &media,
            JobKind::Thumbnails,
            thumbnails::run(&cache, &media),
        )
        .await;
        if cache.is_cancelled() {
            return;
        }

        match result {
            Ok(thumbs_dir) => {
                let path_str = thumbs_dir.display().to_string();
                let patch = MediaDerivativesPatch {
                    thumbnails_dir: Some(thumbs_dir),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
                    warn!("thumbnail commit failed for {media_id}: {e}");
                    emit_job_error(
                        &events,
                        &log_slot,
                        &media,
                        JobKind::Thumbnails,
                        format!("commit: {e}"),
                    );
                    return;
                }
                info!("thumbnails ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Thumbnails,
                        path: Some(path_str),
                    },
                );
            }
            Err(e) => {
                warn!("thumbnail job failed for {media_id}: {e:#}");
                emit_job_error(
                    &events,
                    &log_slot,
                    &media,
                    JobKind::Thumbnails,
                    format!("{e:#}"),
                );
            }
        }
    });
}

fn spawn_quick_proxy(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
    then_full: bool,
    source_gop_secs: Option<f64>,
) {
    let cache = cache.snapshot();
    let log_slot = log_slot.snapshot();
    let events = cache.scoped_events(events);
    tokio::spawn(async move {
        if cache.is_cancelled() {
            return;
        }
        let media_id = media.id;
        let result = run_derivative(
            &events,
            &cache,
            &media,
            JobKind::QuickProxy,
            quick_proxy::run(&cache, &media, source_gop_secs),
        )
        .await;
        if cache.is_cancelled() {
            return;
        }

        match result {
            Ok(quick_proxy_path) => {
                let path_str = quick_proxy_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    quick_proxy_landed: Some(Some(quick_proxy_path)),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
                    warn!("quick proxy commit failed for {media_id}: {e}");
                    emit_job_error(
                        &events,
                        &log_slot,
                        &media,
                        JobKind::QuickProxy,
                        format!("commit: {e}"),
                    );
                } else {
                    info!("quick proxy ready for {media_id}");
                    emit(
                        &events,
                        EVENT_COMPLETE,
                        &JobComplete {
                            media_id: media_id.to_string(),
                            kind: JobKind::QuickProxy,
                            path: Some(path_str),
                        },
                    );
                }
            }
            Err(e) => {
                warn!("quick proxy job failed for {media_id}: {e:#}");
                emit_job_error(
                    &events,
                    &log_slot,
                    &media,
                    JobKind::QuickProxy,
                    format!("{e:#}"),
                );
            }
        }

        if then_full {
            // Full proxy chains after the quick proxy. The media's hash is real
            // (baked at enqueue — hash-first import), so no re-read is needed.
            spawn_proxy(events, log_slot, cache, media);
        }
    });
}

fn spawn_proxy(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    let cache = cache.snapshot();
    let log_slot = log_slot.snapshot();
    let events = cache.scoped_events(events);
    tokio::spawn(async move {
        if cache.is_cancelled() {
            return;
        }
        let media_id = media.id;
        let result = run_derivative(
            &events,
            &cache,
            &media,
            JobKind::Proxy,
            proxy::run(&cache, &media),
        )
        .await;
        if cache.is_cancelled() {
            return;
        }

        match result {
            Ok(proxy_path) => {
                // Keep the quick proxy on disk: it is the PREVIEW source
                // (lighter, height-capped — see `QUICK_PROXY_HEIGHT_CAP` in
                // quick_proxy.rs), while this full master is the EXPORT source.
                // Deleting it here leaves a proxied source with no preview path
                // once the full proxy lands (the summary nulls a missing quick
                // proxy and preview keys on it) → blank preview.
                let path_str = proxy_path.display().to_string();

                let patch = MediaDerivativesPatch {
                    full_proxy_landed: Some(Some(FullProxyLanded {
                        path: proxy_path,
                        format_version: proxy::PROXY_FORMAT_VERSION,
                    })),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
                    warn!("proxy commit failed for {media_id}: {e}");
                    emit_job_error(
                        &events,
                        &log_slot,
                        &media,
                        JobKind::Proxy,
                        format!("commit: {e}"),
                    );
                    return;
                }
                info!("proxy ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Proxy,
                        path: Some(path_str),
                    },
                );
            }
            Err(e) => {
                warn!("proxy job failed for {media_id}: {e:#}");
                emit_job_error(&events, &log_slot, &media, JobKind::Proxy, format!("{e:#}"));
            }
        }
    });
}

fn spawn_waveform(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    media: MediaItem,
) {
    let cache = cache.snapshot();
    let log_slot = log_slot.snapshot();
    let events = cache.scoped_events(events);
    tokio::spawn(async move {
        if cache.is_cancelled() {
            return;
        }
        let media_id = media.id;
        let result = run_derivative(
            &events,
            &cache,
            &media,
            JobKind::Waveform,
            waveform::run(&cache, &media),
        )
        .await;
        if cache.is_cancelled() {
            return;
        }

        match result {
            Ok(waveform_path) => {
                let path_str = waveform_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    waveform_path: Some(waveform_path),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
                    warn!("waveform commit failed for {media_id}: {e}");
                    emit_job_error(
                        &events,
                        &log_slot,
                        &media,
                        JobKind::Waveform,
                        format!("commit: {e}"),
                    );
                    return;
                }
                info!("waveform ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Waveform,
                        path: Some(path_str),
                    },
                );
            }
            Err(e) => {
                warn!("waveform job failed for {media_id}: {e:#}");
                emit_job_error(
                    &events,
                    &log_slot,
                    &media,
                    JobKind::Waveform,
                    format!("{e:#}"),
                );
            }
        }
    });
}

/// One audio-effect bake: a finished ffmpeg graph over a media's conform,
/// landing at `dest`. The chain behind `filter_complex` and the signature
/// that named `dest` are TS's (ADR 0063); nothing here inspects either.
pub struct AudioFxRequest {
    pub media_id: MediaId,
    /// Cancellation handle. The baker debounces edits and cancels the bake it
    /// supersedes, one live bake per key.
    pub job_key: String,
    pub conform_path: std::path::PathBuf,
    pub filter_complex: String,
    pub dest: std::path::PathBuf,
}

/// The landed artifact. `frame_count` is read back off the promoted file, so
/// it doubles as a header check of what the caller is about to play.
#[derive(Debug, Clone, Serialize)]
pub struct AudioFxOutcome {
    pub path: std::path::PathBuf,
    pub frame_count: u64,
}

/// What a cancelled bake reports. A supersede is routine, so this string is
/// the one failure that does not earn a durable log row.
const AUDIO_FX_CANCELLED: &str = "cancelled";

/// Run one audio-effect bake to completion, emitting the same
/// started/complete/error events every other derivative job does so the
/// status-bar job counter includes bakes. Unlike the `enqueue_*` jobs this
/// awaits its result: the baker chains a peaks build onto it and publishes
/// the artifact paths itself.
pub async fn spawn_audio_fx(
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
    cache: CacheLayout,
    req: AudioFxRequest,
) -> Result<AudioFxOutcome, String> {
    let AudioFxRequest {
        media_id,
        job_key,
        conform_path,
        filter_complex,
        dest,
    } = req;
    emit(
        &events,
        EVENT_STARTED,
        &JobStarted {
            media_id: media_id.to_string(),
            kind: JobKind::AudioFx,
        },
    );

    let (tx, rx) = tokio::sync::oneshot::channel();
    let bake_dest = dest.clone();
    let handle = tokio::spawn(async move {
        // The permit is acquired INSIDE the cancellable task so a cancel
        // while the bake is still queued behind import derivatives aborts the
        // wait too, rather than starting a doomed ffmpeg once a slot frees.
        // The bake's render entry owns admission, including export callers.
        // Holding another permit here would deadlock a one-thread machine.
        let outcome = crate::audio::fx::bake(&conform_path, &filter_complex, &bake_dest)
            .await
            .map_err(|e| format!("{e:#}"));
        let _ = tx.send(outcome);
    });
    let _slot = crate::audio::fx::register_job(job_key, handle);

    let result = match rx.await {
        Ok(outcome) => outcome,
        // The sender lives in the task; it can only vanish unsent if the task
        // was aborted.
        Err(_) => Err(AUDIO_FX_CANCELLED.to_string()),
    };

    let artifact = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dest.display().to_string());

    let error = match result {
        Ok(path) => match conform::read_header(&path) {
            Ok(header) => {
                cache.notify_write();
                info!("audio fx bake ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::AudioFx,
                        path: Some(path.display().to_string()),
                    },
                );
                return Ok(AudioFxOutcome {
                    path,
                    frame_count: header.frame_count,
                });
            }
            Err(e) => format!("baked artifact is unreadable: {e:#}"),
        },
        Err(e) => e,
    };

    if error == AUDIO_FX_CANCELLED {
        // A supersede is the per-layer debounce working as designed, so it
        // stays at debug: a warning here would fire on every ordinary edit.
        // The event is still emitted, to balance the started one so the
        // status-bar counter doesn't leak, but without an Err row for what the
        // baker did on purpose.
        debug!("audio fx bake superseded for {media_id}");
        emit(
            &events,
            EVENT_ERROR,
            &JobError {
                media_id: media_id.to_string(),
                kind: JobKind::AudioFx,
                error: error.clone(),
            },
        );
    } else {
        warn!("audio fx bake failed for {media_id}: {error}");
        emit_job_error_named(
            &events,
            &log_slot,
            media_id,
            &artifact,
            JobKind::AudioFx,
            error.clone(),
        );
    }
    Err(error)
}

fn emit<T: Serialize>(events: &Arc<dyn EventSink>, event: &str, payload: &T) {
    events.emit(
        event,
        serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivatives_patch_serializes_tristate() {
        use crate::state::{DecodeRoute, FullProxyLanded, MediaDerivativesPatch};
        use serde_json::json;

        // absent: outer None → key omitted entirely.
        let p = MediaDerivativesPatch {
            conform_path: Some("c.bin".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(
            v.get("full_proxy_landed").is_none(),
            "absent full_proxy_landed must be omitted"
        );
        assert_eq!(v.get("conform_path").unwrap(), &json!("c.bin"));

        // clear: Some(None) → null.
        let p = MediaDerivativesPatch {
            full_proxy_landed: Some(None),
            ..Default::default()
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v.get("full_proxy_landed").unwrap(),
            &serde_json::Value::Null
        );

        // set: a quick proxy landed → Some(Some(path)) → string.
        let p = MediaDerivativesPatch {
            quick_proxy_landed: Some(Some("q.mp4".into())),
            ..Default::default()
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("quick_proxy_landed").unwrap(), &json!("q.mp4"));

        // a full proxy landed → Some(Some(FullProxyLanded)) → self-describing object.
        let p = MediaDerivativesPatch {
            full_proxy_landed: Some(Some(FullProxyLanded {
                path: "full.mp4".into(),
                format_version: 7,
            })),
            ..Default::default()
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v.get("full_proxy_landed").unwrap(),
            &json!({ "path": "full.mp4", "format_version": 7 })
        );

        // set_route: an authoritative route replacement serializes the variant.
        let p = MediaDerivativesPatch {
            set_route: Some(DecodeRoute::Bypass),
            ..Default::default()
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("set_route").unwrap(), &json!({ "route": "bypass" }));
    }

    /// Reopen self-heal: when the content-addressed full master is already on
    /// disk but the (stale-persisted) route says un-built, the decision path
    /// must ADOPT it — commit `full_proxy_landed` — and must NOT re-run the
    /// routing decision (no `set_route` reset, no full rebuild).
    #[tokio::test]
    async fn proxy_decision_adopts_on_disk_master_without_redeciding() {
        use crate::events::VecEventSink;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();

        let hash = "healme";
        std::fs::write(
            cache.proxy(hash),
            include_bytes!("../../../fixtures/media/tiny.mp4"),
        )
        .unwrap();

        let media = MediaItem {
            id: crate::state::new_id(),
            label: None,
            path_abs: tmp.path().join("gone.mp4"), // source needn't exist for the heal
            path_rel: None,
            kind: MediaKind::Video,
            metadata: Default::default(),
            decode_route: DecodeRoute::Proxied {
                quick_proxy: None,
                full_proxy: None, // the landed commit never persisted
                format_version: 0,
            },
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 1,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        };
        let media_id = media.id;

        let sink = Arc::new(VecEventSink::new());
        let events: Arc<dyn EventSink> = sink.clone();
        spawn_proxy_decision(events, crate::logs::LogBusSlot::new(), cache.clone(), media);

        // The adopt commit is the first thing the spawned task does; poll for it.
        let mut adopted = None;
        for _ in 0..200 {
            let recorded = sink.events.lock().unwrap().clone();
            adopted = recorded
                .into_iter()
                .find(|(n, p)| {
                    n == "media:derivatives"
                        && p.get("patch")
                            .and_then(|patch| patch.get("full_proxy_landed"))
                            .is_some()
                })
                .map(|(_, p)| p);
            if adopted.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let payload = adopted.expect("the on-disk master must be adopted");
        assert_eq!(
            payload.get("media_id").unwrap(),
            &serde_json::json!(media_id.to_string())
        );
        let landed = payload
            .get("patch")
            .unwrap()
            .get("full_proxy_landed")
            .unwrap();
        assert_eq!(
            landed.get("path").unwrap(),
            &serde_json::json!(cache.proxy(hash))
        );
        assert_eq!(
            landed.get("format_version").unwrap(),
            &serde_json::json!(proxy::PROXY_FORMAT_VERSION)
        );

        // No re-decision: nothing may carry a set_route reset.
        let recorded = sink.events.lock().unwrap().clone();
        assert!(
            recorded.iter().all(|(n, p)| n != "media:derivatives"
                || p.get("patch")
                    .and_then(|patch| patch.get("set_route"))
                    .is_none()),
            "the heal must not reset the route via set_route"
        );
    }

    /// `commit_media_derivatives` always emits a `media:derivatives` event for the
    /// TS state actor (the sole writer) to apply.
    #[tokio::test]
    async fn commit_derivatives_emits_event() {
        use crate::events::VecEventSink;
        use crate::state::MediaDerivativesPatch;
        use std::sync::Arc;

        let sink = Arc::new(VecEventSink::new());
        let events: Arc<dyn crate::events::EventSink> = sink.clone();
        let media_id = uuid::Uuid::now_v7();

        let patch = MediaDerivativesPatch {
            full_proxy_landed: Some(None),
            conform_path: Some("c.bin".into()),
            ..Default::default()
        };
        commit_media_derivatives(&events, media_id, patch)
            .await
            .unwrap();

        let recorded = sink.events.lock().unwrap().clone();
        let (name, payload) = recorded
            .iter()
            .find(|(n, _)| n == "media:derivatives")
            .expect("a media:derivatives event must be emitted");
        assert_eq!(name, "media:derivatives");
        assert_eq!(
            payload.get("media_id").unwrap(),
            &serde_json::json!(media_id.to_string())
        );
        let patch_v = payload.get("patch").unwrap();
        assert_eq!(
            patch_v.get("full_proxy_landed").unwrap(),
            &serde_json::Value::Null
        ); // cleared
        assert_eq!(
            patch_v.get("conform_path").unwrap(),
            &serde_json::json!("c.bin")
        );
    }

    fn media_named(label: Option<&str>, path: &str) -> MediaItem {
        serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::now_v7(),
            "label": label,
            "path_abs": path,
            "path_rel": null,
            "kind": "Video",
            "metadata": crate::state::MediaMetadata::default(),
            "decode_route": { "route": "bypass" },
            "waveform_path": null,
            "conform_path": null,
            "thumbnails_dir": null,
            "file_hash_blake3": "h",
            "file_size": 0,
            "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn cached_pictures_and_proxies_never_enter_generation() {
        use crate::events::VecEventSink;

        let dir = tempfile::tempdir().unwrap();
        let cache = CacheLayout::new(dir.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let media = media_named(None, "/nonexistent/source.mp4");
        let hash = &media.file_hash_blake3;
        std::fs::create_dir_all(cache.thumbnails(hash)).unwrap();
        for i in 0..10 {
            std::fs::write(
                cache.thumbnail(hash, i),
                include_bytes!("../../../fixtures/media/tiny.jpg"),
            )
            .unwrap();
        }
        std::fs::write(
            cache.quick_proxy(hash),
            include_bytes!("../../../fixtures/media/tiny.mp4"),
        )
        .unwrap();
        std::fs::write(
            cache.proxy(hash),
            include_bytes!("../../../fixtures/media/tiny.mp4"),
        )
        .unwrap();
        let sink = Arc::new(VecEventSink::new());
        let events: Arc<dyn EventSink> = sink.clone();
        for (kind, path) in [
            (JobKind::Thumbnails, cache.thumbnails(hash)),
            (JobKind::QuickProxy, cache.quick_proxy(hash)),
            (JobKind::Proxy, cache.proxy(hash)),
        ] {
            let result = run_derivative(&events, &cache, &media, kind, async {
                panic!("a cache hit must never run the producer");
            })
            .await
            .unwrap();
            assert_eq!(result, path);
        }
        assert!(
            !sink.names().iter().any(|name| name == EVENT_STARTED),
            "cache adoption must not emit started"
        );
        let rows = sink.events.lock().unwrap();
        let completions: Vec<_> = rows
            .iter()
            .filter(|(event, row)| event == "import:diagnostic" && row["status"] == "completed")
            .collect();
        assert_eq!(completions.len(), 3);
        assert!(completions
            .iter()
            .all(|(_, row)| row["cache"] == "hit" && row["queue_ms"] == 0.0));
    }

    #[tokio::test]
    async fn reopening_cached_audio_restores_four_derivatives_without_starting_processing() {
        use crate::events::VecEventSink;
        use crate::state::AudioStreamMeta;

        let dir = tempfile::tempdir().unwrap();
        let cache = CacheLayout::new(dir.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let sink = Arc::new(VecEventSink::new());
        for hash in ["cached-audio-a", "cached-audio-b"] {
            let mut media = media_named(None, "/nonexistent/source.wav");
            media.kind = MediaKind::Audio;
            media.file_hash_blake3 = hash.into();
            media.metadata.audio = Some(AudioStreamMeta {
                codec: "pcm_f32le".into(),
                sample_rate: 48_000,
                channels: 1,
                start_pts_us: None,
            });
            let mut header = conform::MAGIC.to_vec();
            header.extend_from_slice(&conform::CONFORM_FORMAT_VERSION.to_le_bytes());
            header.extend_from_slice(&conform::CONFORM_SAMPLE_RATE.to_le_bytes());
            header.extend_from_slice(&1u32.to_le_bytes());
            header.extend_from_slice(&1u64.to_le_bytes());
            header.extend_from_slice(&0f32.to_le_bytes());
            std::fs::write(cache.audio_conform(hash), header).unwrap();
            waveform::write_peaks(
                &cache.waveform(hash),
                1,
                &[(
                    waveform::BASE_FRAMES_PER_PEAK,
                    waveform::LevelData {
                        channels: 1,
                        peak_count: 1,
                        mins: vec![vec![0]],
                        maxs: vec![vec![0]],
                        rmss: vec![vec![0]],
                    },
                )],
            )
            .await
            .unwrap();
            enqueue_for_media(sink.clone(), LogBusSlot::new(), cache.clone(), media);
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if sink
                    .names()
                    .iter()
                    .filter(|name| *name == EVENT_COMPLETE)
                    .count()
                    == 4
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("cached derivatives must be restored immediately");
        assert!(
            !sink.names().iter().any(|name| name == EVENT_STARTED),
            "reopening already-cached media must not report generation"
        );
        assert_eq!(
            sink.names()
                .iter()
                .filter(|name| *name == "media:derivatives")
                .count(),
            4
        );
    }

    #[test]
    fn media_display_name_prefers_label_then_file_name() {
        assert_eq!(
            media_display_name(&media_named(Some("Intro cut"), "/media/a.mp4")),
            "Intro cut"
        );
        assert_eq!(
            media_display_name(&media_named(None, "/media/a.mp4")),
            "a.mp4"
        );
    }

    #[tokio::test]
    async fn emit_job_error_pairs_the_event_with_one_err_log_row() {
        use crate::events::VecEventSink;
        use crate::logs::{LogBus, LogBusSlot, LogCategory, LogLevel, OpState};

        let sink = VecEventSink::new();
        let events: Arc<dyn EventSink> = Arc::new(sink.clone());
        let slot = LogBusSlot::new();
        let dir = tempfile::tempdir().unwrap();
        slot.install(LogBus::spawn(dir.path(), events.clone()));

        let media = media_named(None, "/media/intro.mp4");
        emit_job_error(&events, &slot, &media, JobKind::Waveform, "boom".into());

        // Renderer event still fires (pill decrement + readiness flip).
        assert!(sink.names().contains(&EVENT_ERROR.to_string()));

        // Exactly one Err row on the bus, category Job, named — no uuid.
        let rows = slot.current().unwrap().list();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].level, LogLevel::Error);
        assert_eq!(rows[0].category, LogCategory::Job);
        assert_eq!(rows[0].message, "Waveform job failed for intro.mp4: boom");
        // Err only by design: no op lifecycle — a failed background job is a
        // single row, not a Started→Err pair.
        assert_eq!(rows[0].op_state, None::<OpState>);
    }
}
