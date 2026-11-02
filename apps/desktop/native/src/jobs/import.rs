//! Background-copy import worker.
//!
//! The import hybrid (TS `hybrids.ts` `import_media`) computes the real BLAKE3
//! content hash BEFORE enqueuing derivative jobs, so
//! every derivative is keyed on the final content hash from the start. This
//! worker only copies the source into `<workspace>/Media/<filename>` (hash-prefix
//! collision handling), then routes the path/hash result through the
//! `media:workspace_paths` seam (`commit_media_workspace_paths`) for the TS actor
//! (the sole writer) to flip `path_abs` to the workspace copy and populate
//! `path_rel`. Derivative jobs read the source until the copy lands; because they
//! are content-addressed, source vs the workspace copy is equivalent.
//!
//! napi events surface progress to the UI:
//!   - `import:queue`    → full list, on every state change
//!   - `import:started`  → media_id, when copy begins
//!   - `import:complete` → media_id + path_rel, on success
//!   - `import:error`    → media_id + detail, on failure
//!
//! Single-worker FIFO — disk write bandwidth is the bottleneck. Cancellation
//! between jobs drops the pending copy job (the media item stays in the pool —
//! the TS actor owns it); mid-copy cancellation is best-effort via a shared
//! atomic flag the chunked copy checks per buffer.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use crate::events::EventSink;
use crate::logs::LogBusSlot;
use anyhow::{Context, Result};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;
use tracing::{info, warn};

use crate::io::probe::FileFacts;
use crate::logs;
use crate::state::ids::MediaId;

const MEDIA_DIR: &str = "Media";
const COPY_BUFFER: usize = 1024 * 1024; // 1 MB

pub mod events {
    pub const QUEUE: &str = "import:queue";
    pub const STARTED: &str = "import:started";
    pub const COMPLETE: &str = "import:complete";
    pub const ERROR: &str = "import:error";
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind")]
pub enum ImportStatus {
    Pending,
    Copying,
    Completed,
    Failed { detail: String },
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportEntry {
    pub media_id: String,
    pub source: String,
    pub destination_rel: Option<String>,
    pub status: ImportStatus,
}

/// napi-managed queue. Cloneable handle (Arc-shared inner) so the worker
/// and the UI command surface both hold the same backing list.
#[derive(Clone)]
pub struct ImportQueue {
    inner: Arc<Mutex<ImportQueueInner>>,
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
}

struct ImportQueueInner {
    pending: VecDeque<PendingImport>,
    running: Option<RunningImport>,
    history: Vec<ImportEntry>,
    worker_alive: bool,
    cache: Option<crate::cache::CacheLayout>,
}

struct PendingImport {
    timer: super::diagnostics::StageTimer,
    media_id: MediaId,
    source: PathBuf,
    workspace_root: PathBuf,
    /// `Media/<name>`, reserved at enqueue so the import can answer where the
    /// copy lands before it has run.
    dest_rel: PathBuf,
    cache: Option<crate::cache::CacheLayout>,
    log_slot: LogBusSlot,
}

struct RunningImport {
    media_id: MediaId,
    cancel: Arc<AtomicBool>,
    cancel_wake: Arc<Notify>,
    workspace_root: PathBuf,
    dest_rel: PathBuf,
}

impl ImportQueueInner {
    /// The reservation of a copy of `media_id` still queued or running.
    fn queued_dest(&self, media_id: MediaId) -> Option<PathBuf> {
        if let Some(entry) = self.pending.iter().find(|e| e.media_id == media_id) {
            return Some(entry.dest_rel.clone());
        }
        self.running
            .as_ref()
            .filter(|e| e.media_id == media_id && !e.cancel.load(Ordering::Acquire))
            .map(|e| e.dest_rel.clone())
    }

    /// Reserve `Media/<name>` for a copy of `source` into `workspace_root`:
    /// free on disk and not held by another copy queued or running there.
    fn reserve_dest(&self, workspace_root: &Path, source: &Path) -> PathBuf {
        let pending = self
            .pending
            .iter()
            .map(|e| (&e.workspace_root, &e.dest_rel));
        let running = self
            .running
            .iter()
            .map(|e| (&e.workspace_root, &e.dest_rel));
        let held: Vec<&PathBuf> = pending
            .chain(running)
            .filter(|(root, _)| root.as_path() == workspace_root)
            .map(|(_, rel)| rel)
            .collect();
        let media_dir = workspace_root.join(MEDIA_DIR);
        let name = pick_dest_filename(&media_dir, source, None, &|name| {
            held.iter()
                .any(|rel| rel.as_path() == Path::new(MEDIA_DIR).join(name))
        });
        PathBuf::from(MEDIA_DIR).join(name)
    }
}

impl ImportQueue {
    pub fn new(events: Arc<dyn EventSink>, log_slot: LogBusSlot) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ImportQueueInner {
                pending: VecDeque::new(),
                running: None,
                history: Vec::new(),
                worker_alive: false,
                cache: None,
            })),
            events,
            log_slot,
        }
    }

    /// Push a copy job. Spawns the worker on first enqueue; subsequent
    /// enqueues just append. Answers the `Media/<name>` the copy lands at —
    /// reserved now, against the files already in `Media/` and every copy
    /// still queued or running there — or `None` when the workspace is being
    /// retired. A media id already queued or copying answers its own
    /// reservation.
    #[cfg(test)]
    pub fn enqueue(
        &self,
        media_id: MediaId,
        source: PathBuf,
        workspace_root: PathBuf,
    ) -> Option<PathBuf> {
        self.enqueue_inner(media_id, source, workspace_root, None)
    }
    pub fn enqueue_scoped(
        &self,
        media_id: MediaId,
        source: PathBuf,
        workspace_root: PathBuf,
        cache: crate::cache::CacheLayout,
    ) -> Option<PathBuf> {
        self.enqueue_inner(media_id, source, workspace_root, Some(cache))
    }
    fn enqueue_inner(
        &self,
        media_id: MediaId,
        source: PathBuf,
        workspace_root: PathBuf,
        cache: Option<crate::cache::CacheLayout>,
    ) -> Option<PathBuf> {
        let dest_rel: PathBuf;
        let need_worker = {
            if cache.as_ref().is_some_and(|cache| cache.is_cancelled()) {
                return None;
            }
            let mut guard = self.inner.lock().expect("import queue poisoned");
            if let Some(queued) = guard.queued_dest(media_id) {
                return Some(queued);
            }
            dest_rel = guard.reserve_dest(&workspace_root, &source);
            guard.cache = cache.clone();
            guard.pending.push_back(PendingImport {
                timer: super::diagnostics::StageTimer::new(
                    cache
                        .as_ref()
                        .map(|cache| cache.scoped_events(self.events.clone()))
                        .unwrap_or_else(|| self.events.clone()),
                    "copy",
                    None,
                    Some(media_id.to_string()),
                ),
                media_id,
                source: source.clone(),
                workspace_root,
                dest_rel: dest_rel.clone(),
                cache,
                log_slot: self.log_slot.snapshot(),
            });
            guard.history.push(ImportEntry {
                media_id: media_id.to_string(),
                source: source.to_string_lossy().to_string(),
                destination_rel: None,
                status: ImportStatus::Pending,
            });
            let spawn = !guard.worker_alive;
            if spawn {
                guard.worker_alive = true;
            }
            spawn
        };
        self.emit_queue();
        if need_worker {
            let me = self.clone();
            tokio::spawn(async move { me.worker_loop().await });
        }
        Some(dest_rel)
    }

    pub fn cancel_all(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.pending.clear();
        inner.history.clear();
        inner.cache = None;
        if let Some(running) = &inner.running {
            running.cancel.store(true, Ordering::Release);
            running.cancel_wake.notify_one();
        }
    }

    /// Cancel a pending or running import by media_id. Returns true if a
    /// job was actually cancelled. A pending job is removed from the
    /// queue; a running job has its cancel flag set — the chunked copy
    /// checks it between buffers and aborts.
    pub fn cancel(&self, media_id: MediaId) -> bool {
        let mut guard = self.inner.lock().expect("import queue poisoned");
        // Pending case: just drop it.
        if let Some(pos) = guard.pending.iter().position(|j| j.media_id == media_id) {
            guard.pending.remove(pos);
            for entry in guard.history.iter_mut() {
                if entry.media_id == media_id.to_string()
                    && matches!(entry.status, ImportStatus::Pending)
                {
                    entry.status = ImportStatus::Cancelled;
                }
            }
            drop(guard);
            self.emit_queue();
            return true;
        }
        // Running case: signal cancel.
        if let Some(run) = guard.running.as_ref() {
            if run.media_id == media_id {
                run.cancel.store(true, Ordering::Relaxed);
                run.cancel_wake.notify_one();
                return true;
            }
        }
        false
    }

    /// Snapshot the queue + recent history for the UI.
    pub fn list(&self) -> Vec<ImportEntry> {
        self.inner
            .lock()
            .expect("import queue poisoned")
            .history
            .clone()
    }

    fn emit_queue(&self) {
        // Serialize snapshot and publication together: concurrent enqueue and
        // completion must never publish an older snapshot after a newer one.
        let guard = self.inner.lock().expect("import queue poisoned");
        let snapshot = guard.history.clone();
        let events = guard
            .cache
            .as_ref()
            .map(|cache| cache.scoped_events(self.events.clone()))
            .unwrap_or_else(|| self.events.clone());
        events.emit(
            events::QUEUE,
            serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null),
        );
    }

    async fn worker_loop(self) {
        loop {
            let mut next = {
                let mut guard = self.inner.lock().expect("import queue poisoned");
                let next = guard.pending.pop_front();
                if next.is_none() {
                    guard.worker_alive = false;
                    return;
                }
                next.unwrap()
            };

            let media_id = next.media_id;
            let events = next
                .cache
                .as_ref()
                .map(|cache| cache.scoped_events(self.events.clone()))
                .unwrap_or_else(|| self.events.clone());
            if next
                .cache
                .as_ref()
                .is_some_and(|cache| cache.is_cancelled())
            {
                continue;
            }
            let cancel = Arc::new(AtomicBool::new(false));
            let cancel_wake = Arc::new(Notify::new());
            {
                let mut guard = self.inner.lock().expect("import queue poisoned");
                guard.running = Some(RunningImport {
                    media_id,
                    cancel: cancel.clone(),
                    cancel_wake: cancel_wake.clone(),
                    workspace_root: next.workspace_root.clone(),
                    dest_rel: next.dest_rel.clone(),
                });
            }
            // Status-log producer: pair Started/Ok-Err on the same
            // op_id so the console collapses the lifecycle.
            let log_op_id = uuid::Uuid::now_v7();
            next.log_slot.emit(logs::LogEntryInput {
                level: logs::LogLevel::Info,
                category: logs::LogCategory::Import,
                source: logs::LogSource::User,
                message: format!("Importing {}", next.source.display()),
                op_id: Some(log_op_id),
                op_state: Some(logs::OpState::Started),
                details: Some(serde_json::json!({
                    "mediaId": media_id.to_string(),
                    "source": next.source.to_string_lossy(),
                })),
                ..Default::default()
            });
            self.emit_queue();

            let outcome = async {
                let permit = if let Some(cache) = &next.cache {
                    tokio::select! {
                        permit = crate::resources::workspace_copy() => Some(permit?),
                        _ = cache.cancelled() => return Ok(None),
                        _ = cancel_wake.notified() => return Ok(None),
                    }
                } else {
                    None
                };
                // One lightweight permit covers copying and inline hashing;
                // the FIFO copy worker supplies the disk concurrency limit.
                // The copy helper
                // must not acquire another job slot: on a one-slot allocation
                // that would wait for the very lease held by this caller.
                let _permit = permit;
                if cancel.load(Ordering::Acquire) {
                    return Ok(None);
                }
                {
                    let mut guard = self.inner.lock().expect("import queue poisoned");
                    if let Some(entry) = guard
                        .history
                        .iter_mut()
                        .rev()
                        .find(|entry| entry.media_id == media_id.to_string())
                    {
                        entry.status = ImportStatus::Copying;
                    }
                }
                self.emit_queue();
                events.emit(
                    events::STARTED,
                    serde_json::json!({ "mediaId": media_id.to_string() }),
                );
                next.timer.start();
                let copy = copy_to_workspace(
                    &next.source,
                    &next.workspace_root,
                    &next.dest_rel,
                    cancel.clone(),
                );
                tokio::pin!(copy);
                if let Some(cache) = &next.cache {
                    tokio::select! {
                        result = &mut copy => result,
                        _ = cache.cancelled() => {
                            cancel.store(true, Ordering::Release);
                            copy.await
                        }
                    }
                } else {
                    copy.await
                }
            }
            .await;
            if matches!(&outcome, Ok(None)) {
                next.timer.cancelled();
            } else {
                next.timer.finish(&outcome);
            }
            if next
                .cache
                .as_ref()
                .is_some_and(|cache| cache.is_cancelled())
            {
                self.inner.lock().unwrap().running = None;
                continue;
            }

            match outcome {
                Ok(Some(copy)) => {
                    let dest_abs = next.workspace_root.join(&copy.dest_rel);
                    // Route the path/hash write-back through the shared seam: it
                    // emits `media:workspace_paths` for the TS host to apply (the
                    // sole writer). The hash matches the standalone hash pass the
                    // import already ran (same bytes), so this is idempotent.
                    if let Err(e) = crate::jobs::commit_media_workspace_paths(
                        &events,
                        media_id,
                        dest_abs.clone(),
                        copy.dest_rel.clone(),
                        copy.facts.blake3_hex.clone(),
                        copy.facts.size,
                        copy.facts.mtime_secs,
                    )
                    .await
                    {
                        warn!("import: actor update failed: {e}");
                        self.finalize(
                            media_id,
                            ImportStatus::Failed {
                                detail: e.to_string(),
                            },
                        );
                        events.emit(
                            events::ERROR,
                            serde_json::json!({
                                "mediaId": media_id.to_string(),
                                "detail": e.to_string(),
                            }),
                        );
                        next.log_slot.emit(logs::LogEntryInput {
                            level: logs::LogLevel::Error,
                            category: logs::LogCategory::Import,
                            source: logs::LogSource::User,
                            message: format!("Import failed: {e}"),
                            op_id: Some(log_op_id),
                            op_state: Some(logs::OpState::Err),
                            ..Default::default()
                        });
                    } else {
                        info!(
                            "import: {} -> {}",
                            next.source.display(),
                            copy.dest_rel.display()
                        );
                        self.finalize_with_dest(
                            media_id,
                            ImportStatus::Completed,
                            Some(copy.dest_rel.to_string_lossy().to_string()),
                        );
                        events.emit(
                            events::COMPLETE,
                            serde_json::json!({
                                "mediaId": media_id.to_string(),
                                "pathRel": copy.dest_rel.to_string_lossy(),
                            }),
                        );
                        next.log_slot.emit(logs::LogEntryInput {
                            level: logs::LogLevel::Info,
                            category: logs::LogCategory::Import,
                            source: logs::LogSource::User,
                            message: format!(
                                "Imported {} → {}",
                                next.source.display(),
                                copy.dest_rel.display()
                            ),
                            op_id: Some(log_op_id),
                            op_state: Some(logs::OpState::Ok),
                            ..Default::default()
                        });
                    }
                }
                Ok(None) => {
                    // Cancelled mid-copy. A `Started` row is already out, so the
                    // op MUST be closed or the running-ops badge never clears; a
                    // user cancel closes it as `Ok`, not `Err` (same convention
                    // as the content-download op in `src/main/index.ts`).
                    self.finalize(media_id, ImportStatus::Cancelled);
                    next.log_slot.emit(logs::LogEntryInput {
                        level: logs::LogLevel::Info,
                        category: logs::LogCategory::Import,
                        source: logs::LogSource::User,
                        message: format!("Import cancelled: {}", next.source.display()),
                        op_id: Some(log_op_id),
                        op_state: Some(logs::OpState::Ok),
                        ..Default::default()
                    });
                }
                Err(e) => {
                    warn!("import: copy failed: {e:#}");
                    self.finalize(
                        media_id,
                        ImportStatus::Failed {
                            detail: format!("{e:#}"),
                        },
                    );
                    events.emit(
                        events::ERROR,
                        serde_json::json!({
                            "mediaId": media_id.to_string(),
                            "detail": format!("{e:#}"),
                        }),
                    );
                    next.log_slot.emit(logs::LogEntryInput {
                        level: logs::LogLevel::Error,
                        category: logs::LogCategory::Import,
                        source: logs::LogSource::User,
                        message: format!("Import copy failed: {e:#}"),
                        op_id: Some(log_op_id),
                        op_state: Some(logs::OpState::Err),
                        ..Default::default()
                    });
                }
            }
        }
    }

    fn finalize(&self, media_id: MediaId, status: ImportStatus) {
        self.finalize_with_dest(media_id, status, None);
    }

    fn finalize_with_dest(
        &self,
        media_id: MediaId,
        status: ImportStatus,
        dest_rel: Option<String>,
    ) {
        {
            let mut guard = self.inner.lock().expect("import queue poisoned");
            guard.running = None;
            if let Some(entry) = guard
                .history
                .iter_mut()
                .rev()
                .find(|e| e.media_id == media_id.to_string())
            {
                entry.status = status;
                if dest_rel.is_some() {
                    entry.destination_rel = dest_rel;
                }
            }
        }
        self.emit_queue();
    }
}

struct CopyResult {
    dest_rel: PathBuf,
    facts: FileFacts,
}

/// Pick a destination filename in `<workspace>/Media/`. Prefers the source
/// basename NFC-normalized (a macOS source hands NFD names; the copy we own
/// must byte-match the `path_rel` recorded in project.json after any
/// byte-preserving transfer — see relink.ts); if that name is already taken
/// on disk or by `reserved` (a copy still queued there), prefix with the first
/// 8 hex chars of `hash_hint` to disambiguate, or with a time-based value when
/// there is none (the import copy passes none: the hash is computed in the
/// same pass as the copy).
fn pick_dest_filename(
    media_dir: &Path,
    source: &Path,
    hash_hint: Option<&str>,
    reserved: &dyn Fn(&Path) -> bool,
) -> PathBuf {
    use unicode_normalization::UnicodeNormalization;
    let base = source
        .file_name()
        .map(|n| PathBuf::from(n.to_string_lossy().nfc().collect::<String>()))
        .unwrap_or_else(|| PathBuf::from("media"));
    if !media_dir.join(&base).exists() && !reserved(&base) {
        return base;
    }
    let prefix = hash_hint
        .map(|h| h[..h.len().min(8)].to_string())
        .unwrap_or_else(|| format!("{:08x}", rand_u32()));
    let base_str = base.to_string_lossy();
    PathBuf::from(format!("{prefix}-{base_str}"))
}

fn rand_u32() -> u32 {
    // Coarse non-cryptographic randomness as a last-resort collision
    // breaker for the no-hash code path. Time-based — unique enough across
    // realistic imports.
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

/// Copy `source` into `<workspace>/<dest_rel>` (the `Media/<name>` reserved at
/// enqueue; re-picked only if a file took that name meanwhile) via a
/// `.tmp + rename` atomic step, checking the cancel flag every chunk. Blake3-hashes the
/// copied bytes in the same pass so the final content hash is available
/// without a second read of the file. Returns:
///   - `Ok(Some(CopyResult))` on a successful copy + rename
///   - `Ok(None)` if the operation was cancelled before completion
///   - `Err(_)` on any I/O failure
async fn copy_to_workspace(
    source: &Path,
    workspace_root: &Path,
    dest_rel: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<Option<CopyResult>> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    if !source.is_file() {
        anyhow::bail!("source not found: {}", source.display());
    }
    let media_dir = workspace_root.join(MEDIA_DIR);
    tokio::fs::create_dir_all(&media_dir)
        .await
        .with_context(|| format!("create {}", media_dir.display()))?;

    let reserved_name = dest_rel
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| pick_dest_filename(&media_dir, source, None, &|_| false));
    let dest_rel_basename = if media_dir.join(&reserved_name).exists() {
        pick_dest_filename(&media_dir, source, None, &|_| false)
    } else {
        reserved_name
    };
    let dest_abs = media_dir.join(&dest_rel_basename);
    let tmp = dest_abs.with_extension(format!(
        "{}.tmp",
        dest_abs
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    ));

    let mut src_file = tokio::fs::File::open(source)
        .await
        .with_context(|| format!("open {}", source.display()))?;
    let mut dst_file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {}", tmp.display()))?;
    let mut buf = vec![0u8; COPY_BUFFER];
    let mut hasher = blake3::Hasher::new();

    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(dst_file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Ok(None);
        }
        let n = src_file
            .read(&mut buf)
            .await
            .with_context(|| format!("read {}", source.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        dst_file
            .write_all(&buf[..n])
            .await
            .with_context(|| format!("write {}", tmp.display()))?;
    }
    dst_file
        .flush()
        .await
        .with_context(|| format!("flush {}", tmp.display()))?;
    drop(dst_file);

    tokio::fs::rename(&tmp, &dest_abs)
        .await
        .with_context(|| format!("promote {} -> {}", tmp.display(), dest_abs.display()))?;

    let metadata = tokio::fs::metadata(&dest_abs)
        .await
        .with_context(|| format!("stat {}", dest_abs.display()))?;
    let facts = FileFacts {
        size: metadata.len(),
        mtime_secs: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
        blake3_hex: hasher.finalize().to_hex().to_string(),
    };

    Ok(Some(CopyResult {
        dest_rel: PathBuf::from(MEDIA_DIR).join(&dest_rel_basename),
        facts,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn scoped_copies_progress_under_transcode_load_and_cancel_while_waiting() {
        // The production queue uses the global governor. Isolate it from other
        // tests instead of substituting an unscoped queue that skips admission.
        const CHILD: &str = "WEFTCUT_COPY_ADMISSION_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "jobs::import::tests::scoped_copies_progress_under_transcode_load_and_cancel_while_waiting", "--nocapture"])
                .env(CHILD, "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        async fn wait_until(condition: impl Fn() -> bool) {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while !condition() {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("copy queue must progress without releasing transcode slots");
        }
        crate::resources::resources_configure(
            serde_json::json!({
                "cpu_threads": 13, "task_threads": 4, "background_jobs": 6,
                "work_mib": 4505, "disk_cache_mib": 2048, "background_playback": false
            })
            .to_string(),
        )
        .unwrap();
        let mut transcodes = Vec::new();
        for _ in 0..3 {
            transcodes.push(crate::jobs::ffmpeg_sem().acquire().await.unwrap());
        }
        crate::resources::resources_activity(true, false, None);
        let ws = TempDir::new().unwrap();
        let source = TempDir::new().unwrap();
        let cache = crate::cache::CacheLayout::new(ws.path().join("Cache"));
        let sink = Arc::new(crate::events::VecEventSink::new());
        let queue = ImportQueue::new(sink.clone(), LogBusSlot::new());
        for name in ["first.bin", "second.bin"] {
            let path = source.path().join(name);
            std::fs::write(&path, vec![17u8; 1024]).unwrap();
            queue.enqueue_scoped(
                crate::state::ids::new_id(),
                path,
                ws.path().to_path_buf(),
                cache.clone(),
            );
        }
        wait_until(|| {
            queue
                .list()
                .iter()
                .filter(|e| matches!(e.status, ImportStatus::Completed))
                .count()
                == 2
        })
        .await;
        for name in ["first.bin", "second.bin"] {
            assert_eq!(
                std::fs::read(ws.path().join("Media").join(name)).unwrap(),
                vec![17u8; 1024]
            );
        }
        let stages = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, value)| event == "import:diagnostic" && value["stage"] == "copy")
            .filter_map(|(_, value)| value["status"].as_str().map(str::to_owned))
            .filter(|status| status == "running" || status == "completed")
            .collect::<Vec<_>>();
        assert_eq!(stages, ["running", "completed", "running", "completed"]);

        // Pressure still closes copy admission; cancelling a waiting copy must
        // release its waiter without requiring memory pressure to recover.
        crate::resources::resources_activity(false, true, None);
        let cancelled_id = crate::state::ids::new_id();
        queue.enqueue_scoped(
            cancelled_id,
            source.path().join("first.bin"),
            ws.path().to_path_buf(),
            cache.clone(),
        );
        wait_until(|| crate::resources::background_diagnostic_state()["waiting"] == 1).await;
        assert!(queue.list().iter().any(|entry| {
            entry.media_id == cancelled_id.to_string()
                && matches!(entry.status, ImportStatus::Pending)
        }));
        assert!(queue.cancel(cancelled_id));
        wait_until(|| {
            queue.list().iter().any(|e| {
                e.media_id == cancelled_id.to_string()
                    && matches!(e.status, ImportStatus::Cancelled)
            })
        })
        .await;
        assert_eq!(
            crate::resources::background_diagnostic_state()["waiting"],
            0
        );

        // Workspace retirement also drains blocked admission and never writes
        // the obsolete copy into either workspace.
        let obsolete = source.path().join("obsolete.bin");
        std::fs::write(&obsolete, b"obsolete").unwrap();
        queue.enqueue_scoped(
            crate::state::ids::new_id(),
            obsolete,
            ws.path().to_path_buf(),
            cache.clone(),
        );
        wait_until(|| crate::resources::background_diagnostic_state()["waiting"] == 1).await;
        let next_ws = TempDir::new().unwrap();
        cache.set_workspace(next_ws.path()).unwrap();
        queue.cancel_all();
        wait_until(|| !queue.inner.lock().unwrap().worker_alive).await;
        assert_eq!(
            crate::resources::background_diagnostic_state()["waiting"],
            0
        );
        assert!(!ws.path().join("Media/obsolete.bin").exists());
        assert!(!next_ws.path().join("Media/obsolete.bin").exists());
        crate::resources::resources_activity(false, false, None);
        drop(transcodes);
        assert_eq!(
            crate::resources::background_diagnostic_state()["reserved_mib"],
            0
        );
    }

    #[test]
    fn pick_dest_filename_basic() {
        let tmp = TempDir::new().unwrap();
        let media_dir = tmp.path();
        let picked = pick_dest_filename(
            media_dir,
            Path::new("/external/some/clip.mp4"),
            Some("deadbeef00112233"),
            &|_| false,
        );
        assert_eq!(picked, PathBuf::from("clip.mp4"));
    }

    #[test]
    fn pick_dest_filename_normalizes_nfd_to_nfc() {
        let tmp = TempDir::new().unwrap();
        // "デート.mp4" with the katakana ダクテン decomposed (NFD), as macOS
        // filesystems hand it out: テ + U+3099 combining voiced sound mark.
        let nfd = "テ\u{3099}ート.mp4";
        let nfc = "デート.mp4";
        assert_ne!(nfd, nfc); // sanity: distinct byte sequences
        let picked = pick_dest_filename(tmp.path(), Path::new(nfd), None, &|_| false);
        assert_eq!(picked.to_string_lossy(), nfc);
    }

    #[test]
    fn pick_dest_filename_collision_prefixes_with_hash() {
        let tmp = TempDir::new().unwrap();
        let media_dir = tmp.path();
        std::fs::write(media_dir.join("clip.mp4"), b"existing").unwrap();
        let picked = pick_dest_filename(
            media_dir,
            Path::new("/another/place/clip.mp4"),
            Some("deadbeef00112233"),
            &|_| false,
        );
        assert_eq!(
            picked.file_name().unwrap().to_string_lossy(),
            "deadbeef-clip.mp4"
        );
    }

    #[test]
    fn pick_dest_filename_avoids_a_reserved_name() {
        let tmp = TempDir::new().unwrap();
        let picked = pick_dest_filename(
            tmp.path(),
            Path::new("/another/place/clip.mp4"),
            Some("deadbeef00112233"),
            &|name| name == Path::new("clip.mp4"),
        );
        assert_eq!(picked, PathBuf::from("deadbeef-clip.mp4"));
    }

    #[tokio::test]
    async fn enqueue_answers_the_reserved_media_path_and_the_copy_lands_there() {
        // NEW-4: import_media answers where its copy lands before the copy
        // ran. Two queued files with one basename get two names; asking again
        // for a queued id answers its own reservation.
        let ws = TempDir::new().unwrap();
        let ext = TempDir::new().unwrap();
        let (a, b) = (ext.path().join("a"), ext.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("clip.mp4"), b"first").unwrap();
        std::fs::write(b.join("clip.mp4"), b"second").unwrap();
        let sink = Arc::new(crate::events::VecEventSink::new());
        let queue = ImportQueue::new(sink.clone(), LogBusSlot::new());
        let (first, second) = (crate::state::ids::new_id(), crate::state::ids::new_id());
        let first_rel = queue
            .enqueue(first, a.join("clip.mp4"), ws.path().to_path_buf())
            .unwrap();
        let second_rel = queue
            .enqueue(second, b.join("clip.mp4"), ws.path().to_path_buf())
            .unwrap();
        assert_eq!(first_rel, PathBuf::from("Media/clip.mp4"));
        assert_ne!(second_rel, first_rel);
        assert!(second_rel.starts_with(MEDIA_DIR));
        for _ in 0..500 {
            if queue
                .list()
                .iter()
                .filter(|e| matches!(e.status, ImportStatus::Completed))
                .count()
                == 2
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let landed = |id: MediaId| {
            queue
                .list()
                .into_iter()
                .find(|e| e.media_id == id.to_string())
                .and_then(|e| e.destination_rel)
        };
        assert_eq!(landed(first), Some(first_rel.to_string_lossy().to_string()));
        assert_eq!(
            landed(second),
            Some(second_rel.to_string_lossy().to_string())
        );
        assert_eq!(std::fs::read(ws.path().join(&first_rel)).unwrap(), b"first");
        assert_eq!(
            std::fs::read(ws.path().join(&second_rel)).unwrap(),
            b"second"
        );
    }

    #[tokio::test]
    async fn copy_to_workspace_writes_into_media_dir() {
        let ws = TempDir::new().unwrap();
        let ext = TempDir::new().unwrap();
        let src = ext.path().join("video.mp4");
        std::fs::write(&src, b"hello video").unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let result = copy_to_workspace(&src, ws.path(), Path::new("Media/video.mp4"), cancel)
            .await
            .unwrap();
        let copy = result.expect("copy completed");
        assert_eq!(copy.dest_rel, PathBuf::from("Media/video.mp4"));
        let landed = ws.path().join(&copy.dest_rel);
        assert_eq!(std::fs::read(&landed).unwrap(), b"hello video");
        assert_eq!(copy.facts.size, 11);
        assert!(!copy.facts.blake3_hex.is_empty());
    }

    /// A test sink that cancels the running import the moment `import:started`
    /// fires. That event is emitted before the copy loop starts, so the loop's
    /// first per-buffer cancel check already sees the flag — a deterministic
    /// mid-copy cancel with no timing dependency.
    struct CancelOnStarted {
        queue: Mutex<Option<ImportQueue>>,
        media_id: MediaId,
    }

    impl EventSink for CancelOnStarted {
        fn emit(&self, event: &str, _payload: serde_json::Value) {
            if event == events::STARTED {
                if let Some(q) = self.queue.lock().unwrap().as_ref() {
                    q.cancel(self.media_id);
                }
            }
        }
    }

    // Guards the cancel arm's terminal row: a `Started` is already out when a
    // mid-copy cancel lands, so the op must close (as `Ok` — a user cancel is
    // not an error) or the running-ops badge never clears.
    #[tokio::test]
    async fn cancel_mid_copy_closes_the_log_op() {
        let ws = TempDir::new().unwrap();
        let ext = TempDir::new().unwrap();
        let src = ext.path().join("video.mp4");
        std::fs::write(&src, vec![0u8; 4 * 1024 * 1024]).unwrap();

        let media_id: MediaId = crate::state::ids::new_id();
        let sink = Arc::new(CancelOnStarted {
            queue: Mutex::new(None),
            media_id,
        });
        let slot = LogBusSlot::new();
        let bus = crate::logs::LogBus::spawn(ws.path(), sink.clone());
        slot.install(bus.clone());

        let queue = ImportQueue::new(sink.clone(), slot);
        *sink.queue.lock().unwrap() = Some(queue.clone());
        queue.enqueue(media_id, src, ws.path().to_path_buf());

        // The worker emits the terminal row synchronously after the copy
        // returns; poll for it (bounded) rather than sleeping a fixed amount.
        let mut terminal = None;
        for _ in 0..500 {
            terminal = bus
                .list()
                .into_iter()
                .find(|e| matches!(e.op_state, Some(logs::OpState::Ok)));
            if terminal.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let terminal = terminal.expect("cancel emitted no terminal row");

        assert!(
            terminal.message.starts_with("Import cancelled:"),
            "unexpected terminal message: {}",
            terminal.message
        );
        assert_eq!(terminal.level, logs::LogLevel::Info);
        let started = bus
            .list()
            .into_iter()
            .find(|e| matches!(e.op_state, Some(logs::OpState::Started)))
            .expect("no Started row");
        assert_eq!(
            started.op_id, terminal.op_id,
            "terminal row must close the Started op"
        );
        assert!(queue
            .list()
            .iter()
            .any(|e| matches!(e.status, ImportStatus::Cancelled)));
    }

    #[tokio::test]
    async fn copy_to_workspace_respects_cancel() {
        let ws = TempDir::new().unwrap();
        let ext = TempDir::new().unwrap();
        let src = ext.path().join("video.mp4");
        std::fs::write(&src, vec![0u8; 5 * 1024 * 1024]).unwrap();

        // Pre-armed cancel flag: the copy loop must bail before its first read.
        let cancel = Arc::new(AtomicBool::new(true));
        let result = copy_to_workspace(&src, ws.path(), Path::new("Media/video.mp4"), cancel)
            .await
            .unwrap();
        assert!(result.is_none(), "expected cancelled outcome");
        // The .tmp shouldn't survive cancellation.
        let media_dir = ws.path().join(MEDIA_DIR);
        if media_dir.is_dir() {
            let stragglers: Vec<_> = std::fs::read_dir(&media_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
                .collect();
            assert!(stragglers.is_empty(), "leaked tmp files: {stragglers:?}");
        }
    }
}
