//! Extract a `[in_us, out_us)` audio slice from a source media file as
//! mono 16 kHz 16-bit PCM WAV (see `SAMPLE_RATE_HZ`).
//!
//! Output is content-addressed and reused across calls. Hash composition is
//! `blake3([source_hash.as_bytes(), in_us.to_le_bytes(), out_us.to_le_bytes()].concat())` —
//! pinned here so callers never re-derive it differently. Files land in
//! `<cache>/transcribe-audio/<hash>.wav` (see `cache::CacheLayout`).
//!
//! Atomic via the shared `temp_path / promote_temp / discard_temp` triad,
//! same as the jobs module. Admitted through the user-compute lane
//! (`resources::user_compute`): someone is waiting on this slice, so it must
//! not queue behind background derivatives, yet it still respects memory
//! pressure and the shared CPU/memory budget rather than spawning unbounded
//! parallelism on import-heavy moments.
//!
//! Seeking is two-stage (see [`seek_args`]): a coarse input-side seek to a few
//! seconds before the in-point, then an exact output-side seek for the rest.
//! The output is the same window, so the cache key above is unaffected.
//!
//! Size envelope at 16 kHz mono pcm_s16le: 32 KB/sec, so the Whisper 25 MB
//! upload cap is ~13 minutes per single extract. `transcribe_clip`
//! is the layer that surfaces `PayloadTooLarge` against that envelope; this
//! module just produces the file.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::ffmpeg::{ffmpeg_is_installed, Bound};
use anyhow::{Context, Result};

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path, CacheLayout};
use crate::resources::{UserComputeBlock, UserComputeCaller};

/// The input rate every backend we drive takes (OpenAI Whisper, whisper.cpp,
/// FunASR): 16 kHz mono is the smallest shape that keeps transcription
/// accuracy.
pub const SAMPLE_RATE_HZ: u32 = 16_000;

/// How far before the in-point the coarse input-side seek lands. Demuxer seeks
/// are only as precise as the container index, and can land after the target
/// on sparse or estimated indexes (e.g. MP3 without a TOC). Landing anywhere
/// within this pre-roll still precedes the in-point, so the exact output-side
/// seek trims to the requested sample.
const SEEK_PREROLL_US: i64 = 5_000_000;

/// ffmpeg seek split for an in-point: the optional input-side `-ss` (before
/// `-i`, a fast demuxer seek) and the output-side `-ss` (after `-i`, decoded
/// and sample-accurate). Input seeking rebases timestamps to zero at its
/// target, so the two add up to `in_us`. Pure so the split is testable
/// without ffmpeg.
fn seek_args(in_us: i64) -> (Option<String>, String) {
    if in_us <= SEEK_PREROLL_US {
        // Decoding a few seconds from the start is cheap; seek exactly.
        return (None, us_to_seconds(in_us));
    }
    (
        Some(us_to_seconds(in_us - SEEK_PREROLL_US)),
        us_to_seconds(SEEK_PREROLL_US),
    )
}

/// Slice `[in_us, out_us)` of `source` into a mono 16 kHz WAV and return
/// the cached path. `source_hash` is the upstream `MediaItem.file_hash_blake3`
/// — we never re-hash the source here (the import path already did it).
pub async fn extract_audio_window(
    cache: &CacheLayout,
    source: &Path,
    source_hash: &str,
    in_us: i64,
    out_us: i64,
) -> Result<PathBuf> {
    extract_audio_window_with_observer(cache, source, source_hash, in_us, out_us, |_| {}).await
}

/// [`extract_audio_window`] reporting admission: the blocking reason while it
/// waits, then `None` once the slice starts (see `resources::user_compute`). A
/// cache hit returns without admission and never calls the observer.
pub async fn extract_audio_window_with_observer(
    cache: &CacheLayout,
    source: &Path,
    source_hash: &str,
    in_us: i64,
    out_us: i64,
    observer: impl FnMut(Option<UserComputeBlock>) + Send,
) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot extract audio for transcription");
    }
    if in_us < 0 {
        anyhow::bail!("audio window in_us must be non-negative (got {in_us})");
    }
    if out_us <= in_us {
        anyhow::bail!("audio window must have positive duration (in_us={in_us}, out_us={out_us})");
    }

    let hash = window_hash(source_hash, in_us, out_us);
    let dest = cache.transcribe_audio(&hash);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let (coarse_s, exact_s) = seek_args(in_us);
    let dur_s = us_to_seconds(out_us - in_us);

    // The capacity refusal is the message itself: it names the blocking
    // reason and carries the prefix the renderer recognizes.
    let _permit = crate::resources::user_compute(UserComputeCaller::AudioExtract, observer)
        .await
        .map_err(anyhow::Error::msg)?;

    // Two-stage seek: the input-side -ss skips decoding everything before the
    // pre-roll (a window deep into a long file would otherwise decode from 0),
    // and the output-side -ss is the sample-accurate remainder transcription
    // needs; an input-side seek alone is only as precise as the index.
    let mut command = crate::ffmpeg::command(Bound::TemporarilyUnbounded);
    command.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);
    if let Some(coarse_s) = &coarse_s {
        command.args(["-ss", coarse_s]);
    }
    let output = command
        .arg("-i")
        .arg(source)
        .args([
            "-ss",
            &exact_s,
            "-t",
            &dur_s,
            "-vn",
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE_HZ.to_string(),
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg for audio extract")?
        .output()
        .await
        .context("await ffmpeg for audio extract")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for audio extract: {}",
            output.status,
            stderr.trim()
        );
    }
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!("audio extract produced an empty WAV");
    }
    promote_temp(&dest)?;
    Ok(dest)
}

fn window_hash(source_hash: &str, in_us: i64, out_us: i64) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(source_hash.as_bytes());
    hasher.update(&in_us.to_le_bytes());
    hasher.update(&out_us.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

fn us_to_seconds(us: i64) -> String {
    // ffmpeg accepts decimal seconds; 6 decimal places preserve full us
    // precision. Callers guarantee `us >= 0` (asserted above).
    debug_assert!(us >= 0);
    format!("{}.{:06}", us / 1_000_000, us % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;
    use tokio::process::Command;

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn make_test_source(dest: &Path, duration_s: u32) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency=1000:duration={duration_s}"),
                "-ac",
                "2",
                "-ar",
                "44100",
            ])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("test fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    /// Crack the WAV header just enough to verify channels + sample rate +
    /// bits/sample. RIFF layout: bytes 0..4 = "RIFF", 8..12 = "WAVE", then a
    /// sequence of chunks. ffmpeg writes "fmt " first; we depend on that
    /// (matching how the file is produced above).
    fn parse_wav_format(path: &Path) -> Result<(u16, u32, u16)> {
        let bytes = std::fs::read(path)?;
        anyhow::ensure!(bytes.len() >= 44, "wav too short ({} bytes)", bytes.len());
        anyhow::ensure!(&bytes[0..4] == b"RIFF", "not RIFF");
        anyhow::ensure!(&bytes[8..12] == b"WAVE", "not WAVE");
        anyhow::ensure!(&bytes[12..16] == b"fmt ", "first chunk not fmt ");
        let channels = u16::from_le_bytes([bytes[22], bytes[23]]);
        let sample_rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
        let bits_per_sample = u16::from_le_bytes([bytes[34], bytes[35]]);
        Ok((channels, sample_rate, bits_per_sample))
    }

    /// Real-ffmpeg smoke: string-matching the args is not enough — invoke the
    /// tool and verify the output. Extracts a 2-sec mono slice from a 5-sec
    /// stereo source and checks the WAV header.
    #[tokio::test]
    async fn audio_extract_window_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping audio_extract smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let source = tmp.path().join("src.wav");
        make_test_source(&source, 5).await.expect("test fixture");

        let path = extract_audio_window(&cache, &source, "src-hash-stable", 1_000_000, 3_000_000)
            .await
            .expect("audio extract");
        assert!(cached_ok(&path), "wav not written");
        assert!(
            path.starts_with(cache.transcribe_audio_dir()),
            "output not under transcribe-audio cache dir: {}",
            path.display(),
        );

        let (channels, sample_rate, bits) = parse_wav_format(&path).expect("parse wav header");
        assert_eq!(channels, 1, "must be mono for Whisper input");
        assert_eq!(sample_rate, SAMPLE_RATE_HZ, "must be 16 kHz");
        assert_eq!(bits, 16, "must be 16-bit PCM");

        // 2 sec * 16000 Hz * 2 bytes ≈ 64000 data bytes + 44-byte header.
        // Allow generous slack — ffmpeg's `-t` isn't sample-perfect.
        let size = std::fs::metadata(&path).unwrap().len() as i64;
        assert!(
            (50_000..=80_000).contains(&size),
            "expected ~64KB output, got {size} bytes",
        );

        // Second call hits the content-addressed cache.
        let path2 = extract_audio_window(&cache, &source, "src-hash-stable", 1_000_000, 3_000_000)
            .await
            .expect("audio extract second call");
        assert_eq!(path, path2);
    }

    #[test]
    fn seek_splits_into_coarse_input_and_exact_output_parts() {
        // Within the pre-roll: no input seek, the whole offset is exact.
        assert_eq!(seek_args(0), (None, "0.000000".into()));
        assert_eq!(seek_args(3_250_000), (None, "3.250000".into()));
        assert_eq!(seek_args(SEEK_PREROLL_US), (None, "5.000000".into()));
        // Deep in-point: the input seek stops one pre-roll short and the exact
        // remainder makes up the rest, to the microsecond.
        assert_eq!(
            seek_args(1_800_500_001),
            (Some("1795.500001".into()), "5.000000".into()),
        );
        assert_eq!(
            seek_args(SEEK_PREROLL_US + 1),
            (Some("0.000001".into()), "5.000000".into()),
        );
    }

    /// The two-stage seek must stay sample-accurate: a tone that starts at
    /// exactly 7 s lands at exactly the middle of a `[6.9 s, 7.1 s)` slice.
    #[tokio::test]
    async fn two_stage_seek_keeps_the_window_sample_accurate() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping two-stage seek smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let source = tmp.path().join("onset.m4a");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg("aevalsrc=if(gte(t\\,7)\\,0.5*sin(2*PI*1000*t)\\,0):s=44100:d=10")
            .args(["-c:a", "aac", "-b:a", "192k"])
            .arg(&source)
            .status()
            .await
            .unwrap();
        assert!(status.success());

        let path = extract_audio_window(&cache, &source, "onset", 6_900_000, 7_100_000)
            .await
            .expect("audio extract");
        let bytes = std::fs::read(&path).unwrap();
        let data = bytes
            .windows(4)
            .position(|w| w == b"data")
            .expect("data chunk");
        let samples: Vec<i16> = bytes[data + 8..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|s| i16::from_le_bytes(*s))
            .collect();
        let half = (SAMPLE_RATE_HZ / 10) as usize; // 0.1 s
        assert!(
            (samples.len() as i64 - 2 * half as i64).abs() < 32,
            "{}",
            samples.len()
        );
        // Allow a few ms for the resampler and AAC filter to ring at the edge.
        let quiet = samples[..half - 64]
            .iter()
            .map(|s| s.unsigned_abs())
            .max()
            .unwrap();
        let loud = samples[half + 64..]
            .iter()
            .map(|s| s.unsigned_abs())
            .max()
            .unwrap();
        assert!(quiet < 500, "audio before the onset: peak {quiet}");
        assert!(loud > 8_000, "tone missing after the onset: peak {loud}");
    }

    #[test]
    fn window_hash_is_deterministic_and_window_sensitive() {
        let a = window_hash("hash-a", 0, 1_000_000);
        let b = window_hash("hash-a", 0, 1_000_000);
        assert_eq!(a, b, "deterministic");
        let c = window_hash("hash-a", 0, 2_000_000);
        assert_ne!(a, c, "different end → different hash");
        let d = window_hash("hash-a", 500_000, 1_000_000);
        assert_ne!(a, d, "different start → different hash");
        let e = window_hash("hash-b", 0, 1_000_000);
        assert_ne!(a, e, "different source → different hash");
    }

    #[tokio::test]
    async fn rejects_zero_duration_window() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let err = extract_audio_window(
            &cache,
            &tmp.path().join("any.wav"),
            "x",
            1_000_000,
            1_000_000,
        )
        .await
        .expect_err("zero window");
        assert!(
            format!("{err:#}").contains("positive duration"),
            "unexpected error: {err:#}",
        );
    }

    #[tokio::test]
    async fn rejects_negative_in_us() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let err = extract_audio_window(&cache, &tmp.path().join("any.wav"), "x", -1, 1_000_000)
            .await
            .expect_err("negative in_us");
        assert!(
            format!("{err:#}").contains("non-negative"),
            "unexpected error: {err:#}",
        );
    }

    #[test]
    fn us_to_seconds_renders_microsecond_precision() {
        assert_eq!(us_to_seconds(0), "0.000000");
        assert_eq!(us_to_seconds(1_500_000), "1.500000");
        assert_eq!(us_to_seconds(123), "0.000123");
        assert_eq!(us_to_seconds(3_600_000_000), "3600.000000");
    }
}
