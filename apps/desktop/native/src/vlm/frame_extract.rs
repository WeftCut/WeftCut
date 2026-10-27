//! Sample still frames from a source video for the video-understanding sidecar.
//!
//! The input contract is a set of *timed frames*, not a video file (see
//! [`super::describer`]). We own the sampling so the timestamps become a quantity
//! WE define (the whole premise of the design): given a source window
//! `[in_us, out_us]` and a sampling `fps`, we midpoint-sample N frames, extract
//! each as a downscaled JPEG, and return them tagged with their **window-relative**
//! timestamp.
//!
//! One ffmpeg child per frame, all under a single user-compute admission
//! (`resources::user_compute`): someone is waiting on the description, so the
//! sampling neither queues behind background derivatives nor re-queues between
//! frames. Frames land in a
//! caller-owned temp dir (RAII-cleaned once the sidecar has read them), not the
//! persistent cache — the *description* is what we cache, not the frames.

use std::path::Path;
use std::process::Stdio;

use crate::ffmpeg::ffmpeg_is_installed;

use crate::process::NoConsoleWindow;
use crate::resources::{UserComputeBlock, UserComputeCaller};

use super::describer::TimedFrame;
use super::error::VlmError;

/// Longest side of an extracted frame, in pixels: enough detail for
/// description, small enough to fit the KV budget [`MAX_FRAMES`] documents.
const MAX_SIDE: u32 = 768;

/// Frames per request for a local engine. Its context is capped at 8192 tokens
/// (KV-cache OOM guard), which comfortably holds ~8–16 downscaled frames plus
/// generation; beyond that it would overflow. A longer window is described in
/// more requests ([`plan_chunks`]), never sampled coarser: the cache key names
/// the fps, so the fps must be the one sampled.
pub const MAX_FRAMES: usize = 16;

/// Most frames one `describe_clip` call may sample, summed over its chunks: an
/// hour at 1 fps. A call over that is refused before any work, naming the
/// longest window that fits — a mistyped fps over a long clip would otherwise
/// queue hours of inference nobody asked for.
pub const MAX_FRAMES_PER_CALL: usize = 3600;

/// Where the `i`-th sampled frame lands. JPEG, not PNG: a 768 px PNG still is
/// several hundred KB, so a dozen of them base64-encoded made a request body
/// past 10 MB for an OpenAI-compatible endpoint — slow to upload to a modest
/// self-hosted server, and its time counted against the request timeout. A
/// q 3 JPEG is an order of magnitude smaller, and the description cannot tell.
/// llama-mtmd reads it too (stb_image sniffs the content).
fn frame_path(out_dir: &Path, i: usize) -> std::path::PathBuf {
    out_dir.join(format!("f{i:02}.jpg"))
}

/// Plan the sampling anchors for `[in_us, out_us]` at `fps`, at most
/// [`MAX_FRAMES`] — one request's worth; see [`plan_anchors_capped`]. Tests
/// only: the tool plans through [`plan_chunks`].
#[cfg(test)]
pub fn plan_anchors(in_us: i64, out_us: i64, fps: f64) -> Vec<i64> {
    plan_anchors_capped(in_us, out_us, fps, MAX_FRAMES)
}

/// Plan the sampling anchors for `[in_us, out_us]` at `fps`: midpoint sampling
/// (no exact-boundary frames), N = round(duration_s * fps) clamped to
/// `[1, cap]`. Returns window-relative anchor times in µs. Pure so the sampling
/// contract is unit-testable without ffmpeg. [`plan_chunks`] sizes its chunks so
/// the cap never binds on a chunk.
pub fn plan_anchors_capped(in_us: i64, out_us: i64, fps: f64, cap: usize) -> Vec<i64> {
    let range_us = (out_us - in_us).max(0);
    if range_us == 0 {
        return vec![0];
    }
    let range_s = range_us as f64 / 1_000_000.0;
    let n = ((range_s * fps).round() as i64).clamp(1, cap.max(1) as i64) as usize;
    (0..n)
        .map(|i| {
            // Midpoint of the i-th of n equal sub-spans, window-relative.
            let frac = (i as f64 + 0.5) / n as f64;
            (frac * range_us as f64).round() as i64
        })
        .collect()
}

/// One engine request's share of a window: its source-absolute span and the
/// chunk-relative anchors to sample in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub window: [i64; 2],
    pub anchors: Vec<i64>,
}

/// Tile `[in_us, out_us]` into chunks of `frames_per_request / fps` seconds from
/// its start (the last may be shorter), each sampled at `fps` — so a long window
/// takes more requests instead of sparser frames. Refuses, before any work, a
/// window that needs more than [`MAX_FRAMES_PER_CALL`] frames, naming the
/// longest window that fits at this fps.
pub fn plan_chunks(
    in_us: i64,
    out_us: i64,
    fps: f64,
    frames_per_request: usize,
) -> Result<Vec<Chunk>, String> {
    let per = frames_per_request.max(1);
    let len_us = ((per as f64 / fps) * 1_000_000.0).round().max(1.0) as i64;
    let out_us = out_us.max(in_us);
    let mut windows = Vec::new();
    let mut at = in_us;
    loop {
        let end = at.saturating_add(len_us).min(out_us);
        windows.push([at, end]);
        if end >= out_us {
            break;
        }
        at = end;
    }
    let frames = |[a, b]: [i64; 2]| {
        if b <= a {
            1
        } else {
            (((b - a) as f64 / 1_000_000.0 * fps).round() as usize).clamp(1, per)
        }
    };
    let total: usize = windows.iter().map(|w| frames(*w)).sum();
    if total > MAX_FRAMES_PER_CALL {
        let window_s = (out_us - in_us) as f64 / 1_000_000.0;
        let fits_s = MAX_FRAMES_PER_CALL as f64 / fps;
        return Err(format!(
            "describing {window_s:.1} s at {fps} fps needs {total} frames, more than the \
             {MAX_FRAMES_PER_CALL} one call may sample — describe at most {fits_s:.0} s per call \
             at this fps (and call again for the rest), or lower fps"
        ));
    }
    Ok(windows
        .into_iter()
        .map(|w| Chunk {
            window: w,
            anchors: plan_anchors_capped(w[0], w[1], fps, per),
        })
        .collect())
}

/// Extract one downscaled JPEG per planned anchor into `out_dir`, returning the
/// [`TimedFrame`]s (window-relative time + path). `source_in_us` is where the
/// window starts in the SOURCE; anchors are window-relative, so the absolute
/// seek time is `source_in_us + anchor`.
///
/// `observer` hears admission: the blocking reason while it waits, then `None`
/// once sampling starts (see `resources::user_compute`). `on_frame` hears how
/// many frames are done after each one, so a long window shows movement
/// between admission and the model.
pub async fn sample_frames(
    source: &Path,
    source_in_us: i64,
    out_dir: &Path,
    anchors: &[i64],
    observer: impl FnMut(Option<UserComputeBlock>) + Send,
    mut on_frame: impl FnMut(usize) + Send,
) -> Result<Vec<TimedFrame>, VlmError> {
    if !ffmpeg_is_installed() {
        return Err(VlmError::FrameExtract(
            "ffmpeg not installed; cannot sample frames for description".into(),
        ));
    }
    tokio::fs::create_dir_all(out_dir)
        .await
        .map_err(VlmError::Io)?;

    // Held across every frame: the frames run one at a time, and admitting
    // each separately would let background work in between.
    let _permit = crate::resources::user_compute(UserComputeCaller::FrameExtract, observer)
        .await
        .map_err(VlmError::FrameExtract)?;

    let mut frames = Vec::with_capacity(anchors.len());
    for (i, &anchor_us) in anchors.iter().enumerate() {
        let abs_us = (source_in_us + anchor_us).max(0);
        let abs_s = abs_us as f64 / 1_000_000.0;
        let path = frame_path(out_dir, i);

        // -ss BEFORE -i = fast keyframe seek (matches spike.mjs + jobs/frame.rs);
        // description is robust to thumbnail-grade seek accuracy.
        let output = crate::ffmpeg::command()
            .no_console_window()
            .kill_on_drop(true)
            .args([
                "-nostdin",
                "-hide_banner",
                "-nostats",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                &format!("{abs_s:.3}"),
                "-i",
            ])
            .arg(source)
            .args([
                "-frames:v",
                "1",
                "-vf",
                &format!("scale='min({MAX_SIDE},iw)':-2"),
                // The extension picks mjpeg; q 3 is `jobs/frame.rs`'s setting.
                "-q:v",
                "3",
                "-update",
                "1",
                "-f",
                "image2",
            ])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| {
                VlmError::FrameExtract(format!("spawn ffmpeg for frame @{abs_s}s: {e}"))
            })?;

        if !output.status.success() || !crate::cache::cached_ok(&path) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(VlmError::FrameExtract(format!(
                "ffmpeg frame extract @{abs_s}s failed ({}): {}",
                output.status,
                stderr.trim()
            )));
        }
        frames.push(TimedFrame {
            t_us: anchor_us,
            path,
        });
        on_frame(frames.len());
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_anchors_midpoint_samples_at_fps() {
        // 4 s window at 1 fps → 4 frames, midpoints at 0.5/1.5/2.5/3.5 s.
        let a = plan_anchors(0, 4_000_000, 1.0);
        assert_eq!(a, vec![500_000, 1_500_000, 2_500_000, 3_500_000]);
    }

    #[test]
    fn plan_anchors_clamps_to_at_least_one_and_max_frames() {
        // Sub-frame window still yields one anchor.
        assert_eq!(plan_anchors(0, 100_000, 1.0).len(), 1);
        // One request's worth: a long window at high fps clamps to the cap
        // (`plan_chunks` keeps chunks short enough that it never binds).
        assert_eq!(plan_anchors(0, 600_000_000, 5.0).len(), MAX_FRAMES);
        assert_eq!(plan_anchors_capped(0, 600_000_000, 5.0, 40).len(), 40);
        // Zero-duration window → a single anchor at 0.
        assert_eq!(plan_anchors(5_000_000, 5_000_000, 1.0), vec![0]);
    }

    #[test]
    fn chunks_tile_the_window_at_full_density() {
        // 64 s at 1 fps, 16 frames a request → four 16 s chunks of 16 frames.
        let c = plan_chunks(10_000_000, 74_000_000, 1.0, 16).unwrap();
        assert_eq!(c.len(), 4);
        assert_eq!(c[0].window, [10_000_000, 26_000_000]);
        assert_eq!(c[3].window, [58_000_000, 74_000_000]);
        assert!(c.iter().all(|c| c.anchors.len() == 16));
        // Chunk-relative anchors: the first sits half a second into its chunk.
        assert_eq!(c[1].anchors[0], 500_000);
        // Contiguous, no gaps or overlaps.
        for pair in c.windows(2) {
            assert_eq!(pair[0].window[1], pair[1].window[0]);
        }
    }

    #[test]
    fn the_tail_chunk_is_short_and_the_fps_is_never_clamped() {
        // 40 s at 2 fps, 16 frames a request → 8 s chunks: 5 of them, the
        // density 2 fps everywhere (the old single request held 16 frames).
        let c = plan_chunks(0, 40_000_000, 2.0, 16).unwrap();
        assert_eq!(c.len(), 5);
        assert_eq!(c.iter().map(|c| c.anchors.len()).sum::<usize>(), 80);
        let c = plan_chunks(0, 20_000_000, 1.0, 16).unwrap();
        assert_eq!(c.last().unwrap().window, [16_000_000, 20_000_000]);
        assert_eq!(c.last().unwrap().anchors.len(), 4);
        // A frame budget per request bounds every chunk.
        let c = plan_chunks(0, 100_000_000, 30.0, 64).unwrap();
        assert!(c.iter().all(|c| c.anchors.len() <= 64));
        // A zero-length window is one single-frame chunk, as before.
        let c = plan_chunks(5_000_000, 5_000_000, 1.0, 16).unwrap();
        assert_eq!(
            c,
            vec![Chunk {
                window: [5_000_000, 5_000_000],
                anchors: vec![0]
            }]
        );
    }

    #[test]
    fn a_call_over_the_frame_cap_is_refused_naming_what_fits() {
        // Two hours at 1 fps = 7200 frames.
        let err = plan_chunks(0, 7_200_000_000, 1.0, 16).unwrap_err();
        assert!(err.contains("7200 frames"), "{err}");
        assert!(err.contains("3600"), "{err}");
        assert!(err.contains("at most 3600 s"), "{err}");
        assert!(err.contains("lower fps"), "{err}");
        // Exactly an hour fits.
        assert!(plan_chunks(0, 3_600_000_000, 1.0, 16).is_ok());
    }

    #[test]
    fn frames_are_written_as_jpeg() {
        let p = frame_path(Path::new("out"), 3);
        assert_eq!(p, Path::new("out").join("f03.jpg"));
    }

    #[test]
    fn plan_anchors_are_window_relative() {
        // Anchors do not include the source offset — they are 0-based.
        let a = plan_anchors(10_000_000, 12_000_000, 1.0);
        assert!(a.iter().all(|&t| (0..=2_000_000).contains(&t)));
    }
}
