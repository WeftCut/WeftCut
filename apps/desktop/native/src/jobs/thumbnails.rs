//! Thumbnail extraction: one ffmpeg invocation per media item pulls
//! `THUMB_COUNT` evenly-spaced frames, scaled to `THUMB_WIDTH` (aspect kept).
//!
//! Cache layout: `<cache>/thumbnails/<file_hash>/000.jpg ..`; a set counts as
//! cached only when every JPG is present and non-empty.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::ffmpeg::ffmpeg_is_installed;
use anyhow::{anyhow, Context, Result};

use crate::process::NoConsoleWindow;

#[cfg(test)]
use crate::cache::cached_ok;
use crate::cache::CacheLayout;
use crate::state::MediaItem;

const THUMB_COUNT: usize = 10;
const THUMB_WIDTH: u32 = 320;
/// Below this, the fps filter pushes too high and ffmpeg refuses (or emits
/// fewer than N frames). Skip thumbnail generation for these.
const MIN_DURATION_US: i64 = 100_000;

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate thumbnails");
    }
    let duration_us = media
        .metadata
        .duration_us
        .ok_or_else(|| anyhow!("media has no duration; cannot space thumbnails"))?;
    if duration_us < MIN_DURATION_US {
        anyhow::bail!(
            "media duration {duration_us}us is below thumbnail minimum {MIN_DURATION_US}us"
        );
    }

    let hash = &media.file_hash_blake3;
    let dest_dir = cache.thumbnails(hash);

    if all_thumbnails_present(cache, hash) {
        return Ok(dest_dir);
    }

    // Fresh + temp dir alongside, atomic-ish: write into `<dest>.tmp/` then
    // rename. We don't use `cache::temp_path` directly because that's for
    // single files; for a directory of N JPGs we manage the .tmp dir
    // ourselves.
    let tmp_dir = {
        let mut s = dest_dir.as_os_str().to_owned();
        s.push(".tmp");
        PathBuf::from(s)
    };

    // Cleanup any prior interrupted attempt.
    remove_thumbnail_dir(cache, &tmp_dir).await?;
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .with_context(|| format!("create thumbnails tmp dir {}", tmp_dir.display()))?;

    let duration_s = duration_us as f64 / 1_000_000.0;
    let fps = THUMB_COUNT as f64 / duration_s;

    let pattern = tmp_dir.join("%03d.jpg");

    // -an drops audio (we only want frames). -q:v 5 = mid-quality JPG, ~30 KB
    // per thumbnail. The fps filter rounds, so `-frames:v` is what caps the set
    // at exactly `THUMB_COUNT`; -fps_mode passthrough so the fps filter's
    // output isn't second-guessed.
    if duration_s >= 30.0 {
        // Ten bounded GOP decodes replace scanning the entire long recording.
        // Short clips retain one invocation to avoid process-start overhead.
        for index in 0..THUMB_COUNT {
            cache.check_active()?;
            let time = duration_s * (index as f64 + 0.5) / THUMB_COUNT as f64;
            let dest = tmp_dir.join(format!("{:03}.jpg", index + 1));
            let mut command = crate::ffmpeg::command();
            command
                .no_console_window()
                .args([
                    "-y",
                    "-hide_banner",
                    "-nostats",
                    "-loglevel",
                    "error",
                    "-ss",
                    &format!("{time:.6}"),
                    "-i",
                ])
                .arg(&media.path_abs)
                .args([
                    "-an",
                    "-vf",
                    &format!("scale={THUMB_WIDTH}:-2"),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "5",
                    "-update",
                    "1",
                ])
                .arg(dest)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            let output = cache
                .command_output(&mut command)
                .await
                .context("seek thumbnail")?;
            anyhow::ensure!(
                output.status.success(),
                "thumbnail seek failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    } else {
        let mut command = crate::ffmpeg::command();
        let command = command
            .no_console_window()
            // Reap on future-drop so no orphan keeps writing the temp dir; see
            // hwaccel.rs.
            .kill_on_drop(true)
            .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
            .arg(&media.path_abs)
            .args([
                "-an",
                "-vf",
                &format!("fps={fps:.6},scale={THUMB_WIDTH}:-2"),
                "-frames:v",
                &THUMB_COUNT.to_string(),
                "-q:v",
                "5",
                "-fps_mode",
                "passthrough",
            ])
            .arg(&pattern)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = cache
            .command_output(command)
            .await
            .context("spawn ffmpeg for thumbnails")?
            .status;

        if !status.success() {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            anyhow::bail!("ffmpeg exited with {status} for thumbnail extraction");
        }
    }

    // Verify ffmpeg actually produced N non-empty thumbnails before promoting.
    for i in 0..THUMB_COUNT {
        let p = tmp_dir.join(format!("{:03}.jpg", i + 1));
        if !crate::cache::valid_jpeg(&p) {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            anyhow::bail!(
                "ffmpeg produced incomplete thumbnail set at {}",
                tmp_dir.display()
            );
        }
    }

    publish_thumbnails(cache, &tmp_dir, &dest_dir).await?;
    cache.notify_write();
    Ok(dest_dir)
}

async fn publish_thumbnails(cache: &CacheLayout, tmp_dir: &Path, dest_dir: &Path) -> Result<()> {
    // ffmpeg's %03d pattern is 1-indexed; rename to 0-indexed for stable
    // public layout.
    for i in 0..THUMB_COUNT {
        let from = tmp_dir.join(format!("{:03}.jpg", i + 1));
        let to = tmp_dir.join(format!("{:03}.jpg", i));
        if from != to {
            retry_thumbnail_io(cache, || tokio::fs::rename(&from, &to))
                .await
                .with_context(|| format!("rename {} -> {}", from.display(), to.display()))?;
        }
    }

    cache.check_active()?;
    // Promote: dest_dir might exist as a stale partial — wipe + rename.
    remove_thumbnail_dir(cache, dest_dir).await?;
    retry_thumbnail_io(cache, || tokio::fs::rename(tmp_dir, dest_dir))
        .await
        .with_context(|| format!("promote {} -> {}", tmp_dir.display(), dest_dir.display()))?;

    Ok(())
}

/// Retry only the current file operation: re-extracting or restarting the
/// renumbering loop would discard completed work or shift frames twice.
/// Await filesystem calls to completion; only the backoff is interruptible.
async fn retry_thumbnail_io<F, Fut>(cache: &CacheLayout, mut operation: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::io::Result<()>>,
{
    const RETRY_DELAYS_MS: [u64; 5] = [50, 100, 200, 400, 800];
    let mut delays = RETRY_DELAYS_MS.into_iter();
    loop {
        cache.check_active()?;
        let error = match operation().await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        let transient = matches!(
            error.kind(),
            std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
        ) || cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33));
        if !transient {
            return Err(error.into());
        }
        let Some(delay_ms) = delays.next() else {
            return Err(error.into());
        };
        tokio::select! {
            _ = cache.cancelled() => anyhow::bail!("workspace cancelled"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {}
        }
    }
}

async fn remove_thumbnail_dir(cache: &CacheLayout, dir: &Path) -> Result<()> {
    retry_thumbnail_io(cache, || async {
        match tokio::fs::remove_dir_all(dir).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    })
    .await
    .with_context(|| format!("remove thumbnails directory {}", dir.display()))
}

pub(super) fn all_thumbnails_present(cache: &CacheLayout, hash: &str) -> bool {
    (0..THUMB_COUNT).all(|i| crate::cache::valid_jpeg(&cache.thumbnail(hash, i)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;
    use tokio::process::Command;

    use crate::state::{new_id, DecodeRoute, MediaKind, MediaMetadata};

    #[cfg(windows)]
    fn staged_thumbnails(root: &Path) -> (PathBuf, PathBuf) {
        let tmp = root.join("thumbnails.tmp");
        let dest = root.join("thumbnails");
        std::fs::create_dir_all(&tmp).unwrap();
        for i in 1..=THUMB_COUNT {
            std::fs::write(
                tmp.join(format!("{i:03}.jpg")),
                include_bytes!("../../../fixtures/media/tiny.jpg"),
            )
            .unwrap();
        }
        (tmp, dest)
    }

    #[cfg(windows)]
    fn hold_without_delete_sharing(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(path)
            .unwrap()
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn publishing_retries_a_transient_thumbnail_sharing_violation() {
        let root = TempDir::new().unwrap();
        let cache = CacheLayout::new(root.path().join("Cache"));
        let (tmp, dest) = staged_thumbnails(root.path());
        // Match the observed failure after seven frames have already moved.
        let held = hold_without_delete_sharing(&tmp.join("008.jpg"));
        let release = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            drop(held);
        });
        let result = publish_thumbnails(&cache, &tmp, &dest).await;
        release.await.unwrap();
        result.expect("transient reader must not fail a completed thumbnail extraction");
        assert!(!tmp.exists());
        for i in 0..THUMB_COUNT {
            assert_eq!(
                std::fs::read(dest.join(format!("{i:03}.jpg"))).unwrap(),
                include_bytes!("../../../fixtures/media/tiny.jpg")
            );
        }
        assert_eq!(std::fs::read_dir(dest).unwrap().count(), THUMB_COUNT);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn publishing_retries_stale_directory_cleanup_and_directory_promotion() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = TempDir::new().unwrap();
        let cache = CacheLayout::new(root.path().join("Cache"));
        let (tmp, dest) = staged_thumbnails(root.path());
        std::fs::create_dir_all(&dest).unwrap();
        let stale = dest.join("stale.jpg");
        std::fs::write(&stale, b"stale").unwrap();
        let held_stale = hold_without_delete_sharing(&stale);
        // FILE_FLAG_BACKUP_SEMANTICS opens the directory itself. Allow reads
        // and writes, but deny renaming it until this handle closes.
        let held_dir = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(0x02000000)
            .open(&tmp)
            .unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            drop(held_stale);
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            drop(held_dir);
        });
        let result = publish_thumbnails(&cache, &tmp, &dest).await;
        release.await.unwrap();
        result.unwrap();
        assert!(!tmp.exists());
        assert!(!stale.exists());
        assert_eq!(std::fs::read_dir(dest).unwrap().count(), THUMB_COUNT);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn publishing_stops_after_persistent_sharing_violation() {
        let root = TempDir::new().unwrap();
        let cache = CacheLayout::new(root.path().join("Cache"));
        let (tmp, dest) = staged_thumbnails(root.path());
        let held = hold_without_delete_sharing(&tmp.join("008.jpg"));
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            publish_thumbnails(&cache, &tmp, &dest),
        )
        .await
        .expect("retries must be bounded")
        .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(32)
        );
        assert!(!dest.exists());
        assert!(tmp.join("006.jpg").exists());
        assert!(tmp.join("008.jpg").exists());
        drop(held);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn publishing_cancels_backoff_when_workspace_changes() {
        let root = TempDir::new().unwrap();
        let owner = CacheLayout::new(root.path().join("Cache"));
        let cache = owner.snapshot();
        let (tmp, dest) = staged_thumbnails(root.path());
        let held = hold_without_delete_sharing(&tmp.join("001.jpg"));
        let publish = publish_thumbnails(&cache, &tmp, &dest);
        tokio::pin!(publish);
        tokio::select! {
            result = &mut publish => panic!("must retry while the reader holds its lock: {result:?}"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
        }
        owner.set_workspace(&root.path().join("next")).unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_millis(200), publish)
            .await
            .expect("workspace cancellation must interrupt backoff")
            .unwrap_err();
        assert!(format!("{error:#}").contains("workspace cancelled"));
        assert!(!dest.exists());
        assert!(tmp.join("001.jpg").exists());
        drop(held);
    }

    #[tokio::test]
    async fn thumbnail_io_retries_are_bounded_and_permanent_errors_fail_immediately() {
        let root = TempDir::new().unwrap();
        let cache = CacheLayout::new(root.path().join("Cache"));
        let mut attempts = 0;
        let error = retry_thumbnail_io(&cache, || {
            attempts += 1;
            std::future::ready(Err(std::io::Error::from(std::io::ErrorKind::NotFound)))
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::NotFound
        );
        let mut attempts = 0;
        retry_thumbnail_io(&cache, || {
            attempts += 1;
            std::future::ready(Err(std::io::Error::from(std::io::ErrorKind::WouldBlock)))
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 6);
    }

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Generate a tiny 1-second mp4 via lavfi `testsrc` so the smoke test
    /// has real bytes to operate on without committing a video fixture.
    async fn make_test_video(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=320x180:rate=10",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-t",
                "1",
            ])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("test fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn thumbnails_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping thumbnails smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let video = tmp.path().join("source.mp4");
        make_test_video(&video).await.expect("test fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("source.mp4".into()),
            path_abs: video,
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let dir = run(&cache, &media).await.expect("thumbnails run");
        for i in 0..THUMB_COUNT {
            let p = dir.join(format!("{:03}.jpg", i));
            assert!(cached_ok(&p), "missing thumbnail {p:?}");
        }
    }

    #[tokio::test]
    async fn skip_when_already_cached() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping thumbnails skip-cache smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        // Pre-populate the cache with the 10 non-zero JPGs the run expects.
        let hash = "preexist";
        let dir = cache.thumbnails(hash);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for i in 0..THUMB_COUNT {
            tokio::fs::write(
                dir.join(format!("{:03}.jpg", i)),
                include_bytes!("../../../fixtures/media/tiny.jpg"),
            )
            .await
            .unwrap();
        }

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.mp4"), // never read because cache hits
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let returned = run(&cache, &media).await.expect("cache hit");
        assert_eq!(returned, dir);
    }

    #[tokio::test]
    async fn rejects_below_minimum_duration() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("tiny.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(50_000), // 50ms — below MIN_DURATION_US
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "tiny".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let err = run(&cache, &media).await.expect_err("too-short clip");
        assert!(
            format!("{err:#}").contains("below thumbnail minimum"),
            "wrong error: {err:#}"
        );
    }
}
