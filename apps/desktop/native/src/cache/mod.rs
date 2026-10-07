//! Content-addressable cache layout for media derivatives — proxies,
//! thumbnails, waveforms, on-demand extracted frames.
//!
//! Per `docs/data-model.md`, the cache is rooted at `<workspace>/Cache/`; the
//! owner root moves via `set_workspace`; cloned layouts freeze the root and
//! cancellation scope for their queued/running work. The write-then-rename protocol every writer must follow is owned by
//! the atomicity helpers at the bottom of this file (`cached_ok`,
//! `claim_temp`, `promote_temp`).

pub const FULL_PROXY_FORMAT_VERSION: u32 = 7;
pub mod disk_lru;
mod session;
pub use session::Session;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};

fn known_layouts() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, CacheLayout>> {
    static ROOTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, CacheLayout>>,
    > = std::sync::OnceLock::new();
    ROOTS.get_or_init(Default::default)
}
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn sweep_all_soon() {
    let layout = known_layouts().lock().unwrap().values().next().cloned();
    if let Some(layout) = layout {
        layout.sweep_soon();
    }
}
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn notify_resource_cache_write() {
    let layout = known_layouts().lock().unwrap().values().next().cloned();
    if let Some(layout) = layout {
        layout.notify_write();
    }
}

/// Which decode source produced a filmstrip tile's pixels. Part of the tile's
/// disk key: when a media's decode route changes (e.g. Bypass ->
/// route-corrected Proxied), tiles from the old source stop matching and
/// re-extract; the stale-source orphans age out via the disk LRU. The tag
/// deliberately does NOT carry the proxy recipe version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilmstripSrc {
    Orig,
    Quick,
    Full,
}

impl FilmstripSrc {
    /// The exhaustive set of valid tag dir names under `filmstrip/{hash}/`.
    /// The disk-LRU sweep treats anything else there as pre-provenance
    /// layout and deletes it.
    pub const DIR_NAMES: [&'static str; 3] = ["orig", "quick", "full"];

    pub fn as_str(self) -> &'static str {
        match self {
            FilmstripSrc::Orig => "orig",
            FilmstripSrc::Quick => "quick",
            FilmstripSrc::Full => "full",
        }
    }
}

#[derive(Debug)]
pub struct CacheLayout {
    /// Current cache root. Swapped by `set_workspace` when the user opens or
    /// saves a project to a folder. Reads clone-by-value; never hand out a
    /// borrowed reference to the locked value or callers will deadlock on
    /// the next swap.
    root: Arc<RwLock<PathBuf>>,
    /// Debounce latch for background disk-LRU sweeps (`cache::disk_lru`).
    sweeper: Arc<disk_lru::SweepState>,
    session: Arc<RwLock<Arc<Session>>>,
    lifecycle: Arc<std::sync::Mutex<()>>,
}

impl Clone for CacheLayout {
    fn clone(&self) -> Self {
        self.snapshot()
    }
}

impl CacheLayout {
    /// Construct a layout rooted at `root`. Use this for the OS app-cache
    /// fallback at boot. `set_workspace` re-points at a workspace folder
    /// the first time a project is opened or saved.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Arc::new(RwLock::new(root)),
            sweeper: Arc::new(disk_lru::SweepState::default()),
            session: Arc::new(RwLock::new(Arc::new(Session::new(0)))),
            lifecycle: Arc::new(std::sync::Mutex::new(())),
        }
    }

    /// Freeze both identity and cancellation scope before a task is queued.
    pub fn snapshot(&self) -> Self {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.snapshot_locked()
    }
    pub fn snapshot_expected(&self, expected: Option<u32>) -> Result<Self> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.check_active()?;
        anyhow::ensure!(
            expected.is_none_or(|generation| generation == self.generation()),
            "workspace cancelled"
        );
        Ok(self.snapshot_locked())
    }
    fn snapshot_locked(&self) -> Self {
        Self {
            root: Arc::new(RwLock::new(self.current_root())),
            sweeper: self.sweeper.clone(),
            session: Arc::new(RwLock::new(self.session.read().unwrap().clone())),
            lifecycle: Arc::new(std::sync::Mutex::new(())),
        }
    }
    pub fn generation(&self) -> u32 {
        self.session.read().unwrap().generation
    }
    pub fn is_cancelled(&self) -> bool {
        self.session.read().unwrap().is_cancelled()
    }
    pub async fn cancelled(&self) {
        let session = self.session.read().unwrap().clone();
        session.cancelled().await;
    }
    pub fn check_active(&self) -> Result<()> {
        anyhow::ensure!(!self.is_cancelled(), "workspace cancelled");
        Ok(())
    }
    pub fn end_session(&self) -> u32 {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let generation = self.rotate_session();
        self.session.read().unwrap().cancel();
        generation
    }
    fn rotate_session(&self) -> u32 {
        let mut current = self.session.write().unwrap();
        current.cancel();
        let generation = current.generation.wrapping_add(1);
        *current = Arc::new(Session::new(generation));
        generation
    }
    pub fn scoped_events(
        &self,
        events: Arc<dyn crate::events::EventSink>,
    ) -> Arc<dyn crate::events::EventSink> {
        Arc::new(session::ScopedEvents {
            cache: self.snapshot(),
            events,
        })
    }

    /// Keep the caller's resource permit alive until cancellation has killed
    /// and reaped the child, not merely until its output future is dropped.
    pub async fn command_output(
        &self,
        command: &mut tokio::process::Command,
    ) -> Result<std::process::Output> {
        self.command_output_timeout(command, None).await
    }
    pub async fn command_output_timeout(
        &self,
        command: &mut tokio::process::Command,
        timeout: Option<std::time::Duration>,
    ) -> Result<std::process::Output> {
        self.check_active()?;
        let mut child = command.kill_on_drop(true).spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let output = drain_bounded(stdout, 8 * 1024 * 1024);
        let errors = drain_bounded(stderr, 64 * 1024);
        let deadline = async {
            match timeout {
                Some(duration) => tokio::time::sleep(duration).await,
                None => std::future::pending().await,
            }
        };
        let wait = async {
            tokio::select! {
                _ = deadline => {
                    child.kill().await?;
                    child.wait().await?;
                    anyhow::bail!("media probe timed out")
                },
                status = child.wait() => Ok(status?),
                _ = self.cancelled() => {
                    child.kill().await?;
                    child.wait().await?;
                    anyhow::bail!("workspace cancelled")
                }
            }
        };
        let (status, stdout, stderr) = tokio::join!(wait, output, errors);
        Ok(std::process::Output {
            status: status?,
            stdout: stdout?,
            stderr: stderr?,
        })
    }

    /// Prepare all directories before atomically replacing the workspace.
    /// Reopening the same path still starts a fresh cancellation generation.
    pub fn set_workspace(&self, workspace_root: &Path) -> Result<()> {
        let prepared = Self::new(workspace_root.join("Cache"));
        prepared.create_dirs()?;
        {
            let _lifecycle = self.lifecycle.lock().unwrap();
            *self.root.write().unwrap() = prepared.current_root();
            self.rotate_session();
        }
        self.register_layout();
        self.sweep_soon();
        Ok(())
    }

    /// Writers call this after landing a new derivative file. Debounced: the
    /// first call schedules a sweep `SWEEP_DEBOUNCE` later; calls inside the
    /// window coalesce. Outside a tokio runtime (sync unit tests) it is a
    /// no-op — the next workspace open sweeps anyway.
    pub fn notify_write(&self) {
        self.schedule_sweep(disk_lru::SWEEP_DEBOUNCE);
    }

    /// Prompt full sweep (workspace open): hygiene rules + budget eviction,
    /// no debounce. Also a no-op outside a runtime.
    pub fn sweep_soon(&self) {
        self.schedule_sweep(std::time::Duration::ZERO);
    }

    fn schedule_sweep(&self, delay: std::time::Duration) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        if !self.sweeper.try_schedule() {
            return;
        }
        let layout = self.clone();
        handle.spawn(async move {
            tokio::time::sleep(delay).await;
            // Re-arm BEFORE the walk: writes landing during a long sweep can
            // schedule the next one. The walk re-reads the CURRENT root, so a
            // workspace swap mid-schedule just sweeps the new root.
            layout.sweeper.finish();
            let layouts: Vec<_> = known_layouts().lock().unwrap().values().cloned().collect();
            let report = tokio::task::spawn_blocking(move || {
                disk_lru::sweep_all(
                    &layouts,
                    crate::resources::disk_cache_bytes(),
                    std::time::SystemTime::now(),
                )
            })
            .await
            .unwrap_or_default();
            if report.units_deleted > 0 {
                tracing::info!(
                    units = report.units_deleted,
                    mb = report.bytes_deleted / (1024 * 1024),
                    "disk cache sweep evicted"
                );
            }
        });
    }

    pub(crate) fn current_root(&self) -> PathBuf {
        self.root.read().expect("cache root lock poisoned").clone()
    }

    pub fn proxies_dir(&self) -> PathBuf {
        self.current_root().join("proxies")
    }

    pub fn thumbnails_root(&self) -> PathBuf {
        self.current_root().join("thumbnails")
    }

    pub fn waveforms_dir(&self) -> PathBuf {
        self.current_root().join("waveforms")
    }

    pub fn frames_root(&self) -> PathBuf {
        self.current_root().join("frames")
    }

    /// On-demand filmstrip tiles for the timeline, lazy-cached per source hash.
    /// Keys mirror the renderer's time grid: `{tag}/{lod}/{index:06}.jpg` (tag =
    /// decode source: orig/quick/full) where the tile samples source time
    /// `index * (250ms << lod)`. The disk-cache LRU sweep (`cache::disk_lru`)
    /// bounds growth; tiles are ~15-25 KB JPGs.
    pub fn filmstrip_root(&self) -> PathBuf {
        self.current_root().join("filmstrip")
    }

    /// Caption text bodies materialized to a blake3-addressed file, for a
    /// caller that needs a real on-disk path (an ffmpeg `subtitles=<file>`
    /// filter takes a filename, not a buffer).
    pub fn inline_subs_dir(&self) -> PathBuf {
        self.current_root().join("inline-subs")
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "reserved for the ffmpeg subtitle burn-in export path; unit tests are the only current caller"
        )
    )]
    pub fn inline_subs(&self, hash: &str, ext: &str) -> PathBuf {
        self.inline_subs_dir().join(format!("{hash}.{ext}"))
    }

    /// MP4 proxy for a hashed media file.
    pub fn proxy(&self, hash: &str) -> PathBuf {
        self.proxies_dir()
            .join(format!("{hash}.full-p{FULL_PROXY_FORMAT_VERSION}.mp4"))
    }

    /// Fast preview-first proxy for a hashed media file. The `q4` segment is
    /// the recipe version — bump it whenever the quick-proxy ffmpeg args
    /// change, so stale cached proxies are regenerated rather than reused.
    /// Current recipe: 720p cap, short scrub GOP (ADR 0008), and source color
    /// tags asserted with the mp4 `colr` atom written so proxy decodes aren't
    /// misread as bt709/limited.
    pub fn quick_proxy(&self, hash: &str) -> PathBuf {
        self.proxies_dir().join(format!("{hash}.quick-q4.mp4"))
    }

    /// Per-media thumbnail directory; individual thumbnails sit inside as
    /// `000.jpg`, `001.jpg`, ...
    pub fn thumbnails(&self, hash: &str) -> PathBuf {
        self.thumbnails_root().join(hash)
    }

    pub fn thumbnail(&self, hash: &str, idx: usize) -> PathBuf {
        self.thumbnails(hash).join(format!("{idx:03}.jpg"))
    }

    /// Multi-resolution audio peaks file (VPEAKS). The version segment in the
    /// filename is bumped when the on-disk layout changes, so a stale cache
    /// from an older layout is regenerated rather than misread (mirrors
    /// `quick_proxy`'s recipe tag).
    pub fn waveform(&self, hash: &str) -> PathBuf {
        self.waveforms_dir().join(format!("{hash}.v4.peaks"))
    }

    /// Peaks for a baked effect-chain sibling, so the timeline can draw the
    /// processed waveform. `sig16` is the chain signature TS computes; it
    /// names the artifact and nothing here interprets it.
    ///
    /// TWIN of `main/audioFx/fxPaths.ts` (`createFxCacheLayout`) — that copy is
    /// the one that actually names files at runtime, because only the TS baker
    /// holds a signature, which is why nothing in the lib build references this
    /// one. `layout_paths_are_content_addressable` below and `fxPaths.test.ts`
    /// pin the two copies to the same shapes.
    #[allow(dead_code)]
    pub fn waveform_fx(&self, media_hash: &str, sig16: &str) -> PathBuf {
        self.waveforms_dir()
            .join(format!("{media_hash}.fx-{sig16}.v4.peaks"))
    }

    /// Canonical conformed PCM for a hashed media file — 48 kHz, f32le,
    /// interleaved, ≤2 channels. See `jobs::conform` for the header format.
    pub fn audio_conform_dir(&self) -> PathBuf {
        self.current_root().join("audio")
    }

    pub fn audio_conform(&self, hash: &str) -> PathBuf {
        self.audio_conform_dir().join(format!("{hash}.conform"))
    }

    /// A media's conform with an effect chain baked in — same header, same
    /// rate/channels, same frame count, so every conform reader consumes it
    /// unchanged. One file per `(media, effective chain)`; `sig16` is the
    /// chain signature TS computes. Twinned with `main/audioFx/fxPaths.ts`, and
    /// unreferenced here, for the same reasons as `waveform_fx`. See ADR 0063.
    #[allow(dead_code)]
    pub fn audio_fx_conform(&self, media_hash: &str, sig16: &str) -> PathBuf {
        self.audio_conform_dir()
            .join(format!("{media_hash}.fx-{sig16}.conform"))
    }

    /// On-demand extracted frame, lazy-cached. Used by
    /// `media://{id}/frame/{t_us}` MCP resource.
    pub fn frames(&self, hash: &str) -> PathBuf {
        self.frames_root().join(hash)
    }

    pub fn frame(&self, hash: &str, t_us: i64) -> PathBuf {
        self.frames(hash).join(format!("{t_us}.jpg"))
    }

    pub fn filmstrip_tile(&self, hash: &str, src: FilmstripSrc, lod: u32, index: u32) -> PathBuf {
        self.filmstrip_root()
            .join(hash)
            .join(src.as_str())
            .join(lod.to_string())
            .join(format!("{index:06}.jpg"))
    }

    /// Audio slices extracted for cloud transcription (mono 16 kHz WAV).
    /// Hash composition is `blake3([source_hash_bytes, in_us.to_le_bytes(),
    /// out_us.to_le_bytes()].concat())` — see `speech::audio_extract`.
    pub fn transcribe_audio_dir(&self) -> PathBuf {
        self.current_root().join("transcribe-audio")
    }

    pub fn transcribe_audio(&self, hash: &str) -> PathBuf {
        self.transcribe_audio_dir().join(format!("{hash}.wav"))
    }

    /// Cached scene descriptions for the video-understanding sidecar (`vlm`).
    /// A SEPARATE namespace from the shot layer's `VSHOT` sidecar so the cheap
    /// deterministic layer and the expensive opt-in layer never block each
    /// other. The `key` is `vlm::description::cache_key` (source content hash +
    /// {backend, model, fps, focus, prompt_template_version}); the value is a
    /// range-lazy incremental `DescriptionCache` JSON — see `vlm/description.rs`.
    pub fn descriptions_dir(&self) -> PathBuf {
        self.current_root().join("descriptions")
    }

    pub fn description(&self, key: &str) -> PathBuf {
        self.descriptions_dir().join(format!("{key}.json"))
    }

    /// Deterministic shot-analysis reports (VSHOT) for the always-on shot layer
    /// (`jobs::shot`). A SEPARATE namespace from `descriptions` — see that
    /// method for why the two layers never share a sidecar. The
    /// `key` is `jobs::shot::cache_key` (source content hash + the source tier
    /// the detector ran on + the detection params that change the report); the
    /// value is a WHOLE-source `ShotReport`
    /// JSON with source-absolute times, which `analyze_clip` and
    /// `media://{id}/analysis` clip to a layer window at read time — so one entry
    /// serves every layer on that source. Because the source content hash IS part
    /// of the key, a source content-hash change (relink-by-content) auto-
    /// invalidates the entry; no manual eviction needed.
    pub fn shots_dir(&self) -> PathBuf {
        self.current_root().join("shots")
    }

    pub fn shot(&self, key: &str) -> PathBuf {
        self.shots_dir().join(format!("{key}.json"))
    }

    /// Per-span pixel measurements for the shot layer's on-demand stats pass
    /// (`jobs::shot::stats`). A SEPARATE namespace from `shots` because it is
    /// keyed differently: a VSHOT entry is one report per (source, detection
    /// params), while this is one accumulating sidecar per (source, tier) whose
    /// entries are addressed by span — the spans a reviewer measures depend on
    /// the threshold, and a namespace keyed by detection params could not hold
    /// them. The `key` is `jobs::shot::stats::cache_key` (source content hash +
    /// the source tier the frames were sampled from); the value is a
    /// `SpanStatsCache` JSON. Like `shots`, the source content hash in the key
    /// auto-invalidates a relink-by-content.
    pub fn shot_stats_dir(&self) -> PathBuf {
        self.current_root().join("shot-stats")
    }

    pub fn shot_stats(&self, key: &str) -> PathBuf {
        self.shot_stats_dir().join(format!("{key}.json"))
    }

    /// Synthesized TTS output. Content-addressed by `blake3(model || '\0' ||
    /// voice || '\0' || speed || '\0' || text)` so repeated requests with the
    /// same parameters skip the API call entirely — see
    /// `speech::backends::openai::tts_cache_key` and the `synthesize_speech`
    /// MCP tool.
    pub fn voiceover_dir(&self) -> PathBuf {
        self.current_root().join("voiceover")
    }

    pub fn voiceover(&self, hash: &str, ext: &str) -> PathBuf {
        self.voiceover_dir().join(format!("{hash}.{ext}"))
    }

    /// Create the top-level cache directory tree. Idempotent. Called
    /// implicitly by `set_workspace`; the boot fallback also calls it once.
    ///
    /// Two dirs are absent by design. `Cache/raster/` is the renderer's motif
    /// L2 pre-bake store — created and owned by
    /// `renderer/render/motifs/frameCache.ts`, not by this layout.
    /// `Cache/preview/` has no owner at all; a workspace carrying one is an
    /// orphan tree, left in place rather than auto-deleted so a user reverting
    /// to an older build keeps their cache.
    pub fn ensure_dirs(&self) -> Result<()> {
        self.create_dirs()?;
        self.register_layout();
        Ok(())
    }
    fn register_layout(&self) {
        let snapshot = self.snapshot();
        known_layouts()
            .lock()
            .unwrap()
            .entry(snapshot.current_root())
            .or_insert(snapshot);
    }
    fn create_dirs(&self) -> Result<()> {
        let root = self.current_root();
        for p in [
            root.clone(),
            self.proxies_dir(),
            self.thumbnails_root(),
            self.waveforms_dir(),
            self.audio_conform_dir(),
            self.frames_root(),
            self.filmstrip_root(),
            self.inline_subs_dir(),
            self.transcribe_audio_dir(),
            self.descriptions_dir(),
            self.shots_dir(),
            self.shot_stats_dir(),
            self.voiceover_dir(),
        ] {
            fs::create_dir_all(&p).with_context(|| format!("create cache dir {}", p.display()))?;
        }
        Ok(())
    }
}

/// Keep draining after the retained diagnostic/probe bound so a verbose child
/// cannot deadlock on a full pipe or grow the process heap without a bound.
async fn drain_bounded<R: tokio::io::AsyncRead + Unpin>(
    pipe: Option<R>,
    limit: usize,
) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        let mut buffer = [0u8; 8192];
        loop {
            let count = pipe.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            let keep = count.min(limit.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buffer[..keep]);
        }
    }
    Ok(bytes)
}

/// True when the path exists and is non-zero size — the right "skip if cached"
/// predicate. Naive `exists()` will return true for an interrupted-ffmpeg
/// zero-byte file, which a worker would then skip and leave broken.
/// Validate container framing without decoding or reading the media payload.
/// A truncated mdat/moov must never be adopted as a completed derivative.
pub fn valid_mp4(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    let length = meta.len();
    let (mut position, mut ftyp, mut moov, mut mdat) = (0u64, false, false, false);
    while position < length {
        let mut header = [0u8; 8];
        if file.read_exact(&mut header).is_err() {
            return false;
        }
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let mut header_size = 8;
        if size == 1 {
            let mut extended = [0u8; 8];
            if file.read_exact(&mut extended).is_err() {
                return false;
            }
            size = u64::from_be_bytes(extended);
            header_size = 16;
        } else if size == 0 {
            size = length - position;
        }
        if size < header_size || size > length - position {
            return false;
        }
        match &header[4..] {
            b"ftyp" => ftyp = size >= header_size + 8,
            b"moov" => moov = size > header_size,
            b"mdat" => mdat = size > header_size,
            _ => {}
        }
        position += size;
        if file.seek(SeekFrom::Start(position)).is_err() {
            return false;
        }
    }
    ftyp && moov && mdat
}

pub fn valid_jpeg(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut marker = [0u8; 2];
    if file.read_exact(&mut marker).is_err() || marker != [0xff, 0xd8] {
        return false;
    }
    if file.seek(SeekFrom::End(-2)).is_err() {
        return false;
    }
    file.read_exact(&mut marker).is_ok() && marker == [0xff, 0xd9]
}

pub fn cached_ok(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// How stale a cache entry's mtime must be before a read refreshes it —
/// relatime semantics: hot-path hits stay at one metadata read.
pub const TOUCH_THROTTLE: Duration = Duration::from_secs(60 * 60);

/// Mark a swept-cache file as recently used by bumping its mtime. mtime IS
/// the disk-LRU clock (`cache::disk_lru`): reads that skip this age out as
/// if unused. Best-effort — errors are ignored (worst case the file evicts
/// and regenerates). A future mtime (clock skew) counts as stale so it
/// normalizes back to now.
pub fn touch_if_stale(path: &Path) {
    let now = SystemTime::now();
    let Ok(meta) = fs::metadata(path) else { return };
    let stale = match meta.modified() {
        Ok(m) => now
            .duration_since(m)
            .map(|age| age > TOUCH_THROTTLE)
            .unwrap_or(true),
        Err(_) => true,
    };
    if !stale {
        return;
    }
    if let Ok(f) = fs::File::options().write(true).open(path) {
        let _ = f.set_times(fs::FileTimes::new().set_modified(now));
    }
}

/// The `<dest>.tmp` path used by the write-then-rename protocol.
pub fn temp_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

/// Claim `<dest>.tmp` for a fresh build by removing any prior attempt.
/// NotFound is a clean claim. Any OTHER error is the overlap tell: Windows
/// cannot delete a file another process holds open, so a live writer (an
/// orphaned ffmpeg from a killed session, or a concurrent build in another
/// process) is still mid-write on this exact temp. Proceeding would interleave
/// two writers (`-y` truncates the holder's output) and burn a full transcode
/// that then dies at promote — bail fast instead; the holder's exit unblocks
/// the next attempt.
pub fn claim_temp(dest: &Path) -> Result<PathBuf> {
    let tmp = temp_path(dest);
    match fs::remove_file(&tmp) {
        Ok(()) => Ok(tmp),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(tmp),
        Err(e) => Err(e).with_context(|| {
            format!(
                "another writer holds {} — refusing to start an overlapping build",
                tmp.display()
            )
        }),
    }
}

/// Promote a successfully-written `<dest>.tmp` to `dest`. The caller is
/// responsible for ensuring the temp file is fully flushed to disk before
/// calling — `tokio::process::Child` waits already cover that.
pub fn promote_temp(dest: &Path) -> Result<()> {
    let tmp = temp_path(dest);
    fs::rename(&tmp, dest)
        .with_context(|| format!("promote {} -> {}", tmp.display(), dest.display()))
}

/// `promote_temp` with Windows collision handling, for content-addressed
/// derivatives (proxies) whose readers legitimately overlap writers:
/// - dest already valid (`cached_ok`): an equivalent artifact landed first
///   (same hash ⇒ same source + recipe) and a reader may hold it open
///   indefinitely, so a replace-rename can never win (os error 5). Adopt the
///   landed file and discard our temp — the rebuild was redundant.
/// - transient sharing violation / access denied (os errors 32/5) with no
///   valid dest: short-lived handle (AV scan, closing reader) — retry with
///   backoff (~1.5 s total) before giving up.
pub async fn promote_temp_retry(dest: &Path) -> Result<()> {
    const MAX_ATTEMPTS: u32 = 6;
    let tmp = temp_path(dest);
    let mut delay = Duration::from_millis(50);
    for attempt in 1..=MAX_ATTEMPTS {
        let err = match fs::rename(&tmp, dest) {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        if cached_ok(dest) {
            tracing::warn!(
                "promote {}: an equivalent artifact already landed at {}; adopting it \
                 and discarding the redundant temp",
                tmp.display(),
                dest.display()
            );
            let _ = fs::remove_file(&tmp);
            return Ok(());
        }
        let transient = matches!(err.raw_os_error(), Some(5) | Some(32))
            || err.kind() == std::io::ErrorKind::PermissionDenied;
        if !transient || attempt == MAX_ATTEMPTS {
            return Err(err)
                .with_context(|| format!("promote {} -> {}", tmp.display(), dest.display()));
        }
        tokio::time::sleep(delay).await;
        delay *= 2;
    }
    unreachable!("loop returns on success, adopt, or final error")
}

/// Best-effort cleanup of a `<dest>.tmp` that was never promoted. Used in the
/// error path of a job. Ignores file-not-found.
pub fn discard_temp(dest: &Path) {
    let tmp = temp_path(dest);
    let _ = fs::remove_file(tmp);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};
    use tempfile::TempDir;

    fn set_mtime(path: &Path, when: SystemTime) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(when))
            .unwrap();
    }

    #[test]
    fn workspace_snapshots_cancel_without_changing_their_paths() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        let owner = CacheLayout::new(first.path().join("Cache"));
        let pending = owner.clone();
        let old_path = pending.proxy("source");
        let old_generation = owner.generation();
        owner.set_workspace(second.path()).unwrap();
        assert!(pending.is_cancelled());
        assert_eq!(pending.proxy("source"), old_path);
        assert_ne!(owner.proxy("source"), old_path);
        assert!(owner.snapshot_expected(Some(old_generation)).is_err());
        assert!(!owner
            .snapshot_expected(Some(owner.generation()))
            .unwrap()
            .is_cancelled());
    }

    #[test]
    fn failed_workspace_preparation_preserves_the_active_session() {
        let dir = TempDir::new().unwrap();
        let owner = CacheLayout::new(dir.path().join("active/Cache"));
        owner.ensure_dirs().unwrap();
        let active = owner.clone();
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, b"file rather than directory").unwrap();
        assert!(owner.set_workspace(&blocked).is_err());
        assert_eq!(owner.current_root(), active.current_root());
        assert_eq!(owner.generation(), active.generation());
        assert!(!active.is_cancelled());
    }

    #[test]
    fn close_rejects_new_work_until_a_successful_reopen() {
        let dir = TempDir::new().unwrap();
        let owner = CacheLayout::new(dir.path().join("Cache"));
        let first = owner.clone();
        let closed = owner.end_session();
        assert!(first.is_cancelled());
        assert!(owner.snapshot_expected(Some(closed)).is_err());
        assert!(owner.snapshot_expected(None).is_err());
        owner.set_workspace(dir.path()).unwrap();
        assert!(owner.snapshot_expected(Some(owner.generation())).is_ok());
        let reopened = owner.clone();
        owner.set_workspace(dir.path()).unwrap();
        assert!(
            reopened.is_cancelled(),
            "same-path reopen rotates generation"
        );
    }

    #[tokio::test]
    async fn scoped_events_tag_current_payloads_and_suppress_old_completions() {
        use crate::events::VecEventSink;
        let dir = TempDir::new().unwrap();
        let owner = CacheLayout::new(dir.path().join("Cache"));
        let sink = Arc::new(VecEventSink::new());
        let scoped = owner.scoped_events(sink.clone());
        scoped.emit("media:derivatives", serde_json::json!({"media_id":"m"}));
        scoped.emit("import:queue", serde_json::json!([]));
        owner.end_session();
        scoped.emit("media:derivatives", serde_json::json!({"media_id":"old"}));
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].1["workspace_generation"], 0);
        assert_eq!(events[1].1["entries"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn command_pipe_drains_beyond_retained_bound() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(64);
        let producer = tokio::spawn(async move {
            writer.write_all(&vec![42; 8192]).await.unwrap();
        });
        let retained = drain_bounded(Some(reader), 100).await.unwrap();
        producer.await.unwrap();
        assert_eq!(retained, vec![42; 100]);
    }

    #[test]
    fn derivative_validation_rejects_truncated_container_and_jpeg() {
        let dir = TempDir::new().unwrap();
        let mp4 = dir.path().join("proxy.mp4");
        let bytes = include_bytes!("../../../fixtures/media/tiny.mp4");
        fs::write(&mp4, bytes).unwrap();
        assert!(valid_mp4(&mp4));
        fs::write(&mp4, &bytes[..bytes.len() - 1]).unwrap();
        assert!(!valid_mp4(&mp4));
        let jpg = dir.path().join("thumbnail.jpg");
        let bytes = include_bytes!("../../../fixtures/media/tiny.jpg");
        fs::write(&jpg, bytes).unwrap();
        assert!(valid_jpeg(&jpg));
        fs::write(&jpg, &bytes[..bytes.len() - 2]).unwrap();
        assert!(!valid_jpeg(&jpg));
    }

    #[test]
    fn layout_paths_are_content_addressable() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().to_path_buf());
        assert_eq!(
            layout.proxy("abc"),
            tmp.path().join("proxies").join("abc.full-p7.mp4"),
        );
        assert_eq!(
            layout.quick_proxy("abc"),
            tmp.path().join("proxies").join("abc.quick-q4.mp4"),
        );
        assert_eq!(
            layout.thumbnail("abc", 5),
            tmp.path().join("thumbnails").join("abc").join("005.jpg"),
        );
        assert_eq!(
            layout.waveform("abc"),
            tmp.path().join("waveforms").join("abc.v4.peaks"),
        );
        assert_eq!(
            layout.audio_conform("abc"),
            tmp.path().join("audio").join("abc.conform"),
        );
        assert_eq!(
            layout.audio_fx_conform("abc", "0123456789abcdef"),
            tmp.path()
                .join("audio")
                .join("abc.fx-0123456789abcdef.conform"),
        );
        assert_eq!(
            layout.waveform_fx("abc", "0123456789abcdef"),
            tmp.path()
                .join("waveforms")
                .join("abc.fx-0123456789abcdef.v4.peaks"),
        );
        assert_eq!(
            layout.frame("abc", 1_500_000),
            tmp.path().join("frames").join("abc").join("1500000.jpg"),
        );
        assert_eq!(
            layout.transcribe_audio("abc"),
            tmp.path().join("transcribe-audio").join("abc.wav"),
        );
        assert_eq!(
            layout.description("abc"),
            tmp.path().join("descriptions").join("abc.json"),
        );
        assert_eq!(
            layout.shot("abc"),
            tmp.path().join("shots").join("abc.json"),
        );
        assert_eq!(
            layout.shot_stats("abc"),
            tmp.path().join("shot-stats").join("abc.json"),
        );
        assert_eq!(
            layout.voiceover("abc", "mp3"),
            tmp.path().join("voiceover").join("abc.mp3"),
        );
        assert_eq!(
            layout.filmstrip_tile("abc", FilmstripSrc::Quick, 3, 7),
            tmp.path()
                .join("filmstrip")
                .join("abc")
                .join("quick")
                .join("3")
                .join("000007.jpg"),
        );
    }

    #[test]
    fn ensure_dirs_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().join("nested"));
        layout.ensure_dirs().unwrap();
        layout.ensure_dirs().unwrap(); // second call is a no-op
        assert!(layout.proxies_dir().is_dir());
        assert!(layout.thumbnails_root().is_dir());
        assert!(layout.waveforms_dir().is_dir());
        assert!(layout.audio_conform_dir().is_dir());
        assert!(layout.frames_root().is_dir());
        assert!(layout.inline_subs_dir().is_dir());
        assert!(layout.transcribe_audio_dir().is_dir());
        assert!(layout.descriptions_dir().is_dir());
        assert!(layout.shots_dir().is_dir());
        assert!(layout.shot_stats_dir().is_dir());
        assert!(layout.voiceover_dir().is_dir());
        assert!(layout.filmstrip_root().is_dir());
    }

    #[test]
    fn set_workspace_swaps_root_and_creates_dirs() {
        // Boot fallback: layout points at an OS-app-cache-ish location.
        let boot = TempDir::new().unwrap();
        let layout = CacheLayout::new(boot.path().to_path_buf());
        assert_eq!(layout.proxies_dir(), boot.path().join("proxies"));

        // User opens a workspace; cache moves under `<workspace>/Cache/`.
        let ws = TempDir::new().unwrap();
        layout.set_workspace(ws.path()).unwrap();
        assert_eq!(
            layout.proxies_dir(),
            ws.path().join("Cache").join("proxies"),
        );
        assert!(layout.proxies_dir().is_dir());

        // Idempotent: re-setting to the same workspace is a no-op.
        layout.set_workspace(ws.path()).unwrap();
        assert!(layout.proxies_dir().is_dir());
    }

    #[test]
    fn inline_subs_path_includes_extension() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().to_path_buf());
        assert_eq!(
            layout.inline_subs("abc", "srt"),
            tmp.path().join("inline-subs").join("abc.srt"),
        );
        assert_eq!(
            layout.inline_subs("abc", "ass"),
            tmp.path().join("inline-subs").join("abc.ass"),
        );
    }

    #[test]
    fn cached_ok_rejects_zero_byte_files() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("partial.mp4");
        fs::write(&path, b"").unwrap(); // simulate interrupted ffmpeg
        assert!(!cached_ok(&path));
        fs::write(&path, b"x").unwrap();
        assert!(cached_ok(&path));
    }

    #[test]
    fn cached_ok_rejects_missing_files() {
        let tmp = TempDir::new().unwrap();
        assert!(!cached_ok(&tmp.path().join("nope.mp4")));
    }

    /// End-to-end scheduling proof via a hygiene rule (budget-independent):
    /// sweep_soon must delete an orphaned v2 peaks file in the background.
    #[tokio::test]
    async fn sweep_soon_runs_hygiene_in_background() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().to_path_buf());
        layout.ensure_dirs().unwrap();
        let orphan = layout.waveforms_dir().join("aaa.v2.peaks");
        fs::write(&orphan, b"old").unwrap();

        layout.sweep_soon();
        for _ in 0..200 {
            if !orphan.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(!orphan.exists(), "background sweep never ran");
    }

    #[test]
    fn promote_and_discard_temp() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("out.mp4");
        let temp = temp_path(&dest);
        fs::write(&temp, b"data").unwrap();
        promote_temp(&dest).unwrap();
        assert!(dest.is_file());
        assert!(!temp.exists());

        // discard_temp on a fresh round
        let dest2 = tmp.path().join("out2.mp4");
        let temp2 = temp_path(&dest2);
        fs::write(&temp2, b"partial").unwrap();
        discard_temp(&dest2);
        assert!(!temp2.exists());
        // discard on missing is fine
        discard_temp(&dest2);
    }

    #[test]
    fn claim_temp_removes_stale_and_accepts_missing() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("out.mp4");
        // Missing temp: clean claim.
        let claimed = claim_temp(&dest).unwrap();
        assert_eq!(claimed, temp_path(&dest));
        // Stale unheld temp from an interrupted job: removed, clean claim.
        fs::write(temp_path(&dest), b"stale").unwrap();
        claim_temp(&dest).unwrap();
        assert!(!temp_path(&dest).exists());
    }

    /// Open like ffmpeg's MSVC CRT does: FILE_SHARE_READ|WRITE but NOT
    /// FILE_SHARE_DELETE. Rust std's default share mode INCLUDES delete, so a
    /// plain `File::open` can't reproduce the collision the live app hits.
    #[cfg(windows)]
    fn open_like_ffmpeg(path: &Path, write: bool) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;
        fs::File::options()
            .read(true)
            .write(write)
            .share_mode(FILE_SHARE_READ_WRITE)
            .open(path)
            .unwrap()
    }

    /// Windows-only: a temp held open by another writer (ffmpeg-style handle,
    /// no FILE_SHARE_DELETE) can't be deleted — claim must FAIL (the overlap
    /// tell) instead of silently proceeding into an interleaved two-writer
    /// build. (POSIX unlinks open files, so the overlap is undetectable there
    /// and the claim succeeds.)
    #[cfg(windows)]
    #[test]
    fn claim_temp_errors_while_temp_is_held_open() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("out.mp4");
        fs::write(temp_path(&dest), b"mid-write").unwrap();
        let held = open_like_ffmpeg(&temp_path(&dest), true);
        let err = claim_temp(&dest).expect_err("claim must refuse a held temp");
        assert!(
            err.to_string().contains("another writer holds"),
            "unexpected error: {err:#}"
        );
        drop(held);
        claim_temp(&dest).expect("claim succeeds once the holder exits");
    }

    #[tokio::test]
    async fn promote_temp_retry_plain_promote() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("out.mp4");
        fs::write(temp_path(&dest), b"data").unwrap();
        promote_temp_retry(&dest).await.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"data");
        assert!(!temp_path(&dest).exists());
    }

    /// Windows-only: dest already landed and is held open by a reader (no
    /// FILE_SHARE_DELETE) → replace-rename is denied forever. The retry must
    /// ADOPT the landed file (content-addressed ⇒ equivalent) and discard the
    /// redundant temp instead of erroring — the os-error-5 case.
    #[cfg(windows)]
    #[tokio::test]
    async fn promote_temp_retry_adopts_dest_held_by_reader() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("out.mp4");
        fs::write(&dest, b"landed-first").unwrap();
        let _reader = open_like_ffmpeg(&dest, false);
        fs::write(temp_path(&dest), b"redundant-rebuild").unwrap();
        promote_temp_retry(&dest).await.unwrap();
        assert_eq!(
            fs::read(&dest).unwrap(),
            b"landed-first",
            "the already-landed artifact must win"
        );
        assert!(!temp_path(&dest).exists(), "redundant temp discarded");
    }

    #[test]
    fn touch_if_stale_updates_only_stale_mtimes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("tile.jpg");
        fs::write(&path, b"x").unwrap();
        let now = SystemTime::now();

        // 30 min old: inside TOUCH_THROTTLE, must NOT be rewritten.
        set_mtime(&path, now - Duration::from_secs(30 * 60));
        touch_if_stale(&path);
        let m = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(
            m < now - Duration::from_secs(29 * 60),
            "fresh mtime rewritten"
        );

        // 2 h old: stale, must be refreshed to ~now.
        set_mtime(&path, now - Duration::from_secs(2 * 3600));
        touch_if_stale(&path);
        let m = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(
            m > now - Duration::from_secs(60),
            "stale mtime not refreshed"
        );
    }
}
