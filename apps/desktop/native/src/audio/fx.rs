//! Audio-effect bake primitives: measure a conform range's level, render a
//! finished ffmpeg graph from one VCONF into a sibling VCONF, and cancel a
//! render by job key.
//!
//! What this module deliberately does NOT own: effect kinds, parameters,
//! chain order, and the signature that names the artifact. Those live in TS
//! (`src/shared/audioEffects/`), which hands down an already-built
//! `filter_complex` and destination path. See ADR 0063 and docs/audio.md
//! §Clip effects.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::audio::conform_reader::ConformReader;
use crate::cache::{claim_temp, discard_temp, promote_temp};
use crate::ffmpeg::{ffmpeg_is_installed, ffmpeg_path};
use crate::jobs::conform::{read_header, CONFORM_FORMAT_VERSION, HEADER_LEN, MAGIC};
use crate::process::NoConsoleWindow;

/// Pooled RMS over a conform frame range, in dBFS relative to a full-scale
/// sample. `None` when the range holds no frames or is digitally silent — a
/// level with no dB value, which the caller clamps its derived threshold to
/// (docs/audio.md §Clip effects).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct RmsReport {
    pub rms_dbfs: Option<f64>,
    pub frames: u64,
}

/// Frames per read while accumulating the sum of squares. A sample region is
/// user-drawn and can span a whole hour-long media, so the accumulator is
/// chunked rather than reading the range into one buffer.
const RMS_CHUNK_FRAMES: usize = 1 << 16;

/// Level of `[in_us, out_us)` in `conform_path`, all channels pooled into one
/// figure. The range is clamped to the file, so an out-of-bounds request
/// measures whatever part of it exists rather than failing.
pub fn measure_conform_rms(conform_path: &Path, in_us: i64, out_us: i64) -> Result<RmsReport> {
    let header = read_header(conform_path)?;
    let total = header.frame_count as i64;
    let start = crate::audio::mix::us_to_frame(in_us).clamp(0, total);
    let end = crate::audio::mix::us_to_frame(out_us).clamp(start, total);
    let frames = (end - start) as u64;
    if frames == 0 {
        return Ok(RmsReport {
            rms_dbfs: None,
            frames: 0,
        });
    }

    let mut reader = ConformReader::open(conform_path)?;
    let mut sum_sq = 0f64;
    let mut at = start;
    while at < end {
        let n = ((end - at) as usize).min(RMS_CHUNK_FRAMES);
        for s in reader.read_frames(at, n)? {
            sum_sq += (s as f64) * (s as f64);
        }
        at += n as i64;
    }
    let mean_sq = sum_sq / (frames as f64 * header.channels as f64);
    Ok(RmsReport {
        rms_dbfs: (mean_sq > 0.0).then(|| 20.0 * mean_sq.sqrt().log10()),
        frames,
    })
}

/// A destination's bake result, shared with whoever joined it mid-flight.
type BakeResult = Result<PathBuf, String>;

/// One in-flight bake per destination. Two layers with the same media and the
/// same effective chain resolve to the same artifact, and the writer path is
/// a deterministic `<dest>.tmp` — so a second requester joins the first
/// instead of interleaving writes into that temp. Mirrors
/// `jobs::conform_in_flight`, except a waiter here needs the produced path,
/// not just a completion event.
#[allow(clippy::type_complexity)]
fn in_flight() -> &'static Mutex<HashMap<PathBuf, broadcast::Sender<Arc<BakeResult>>>> {
    static S: OnceLock<Mutex<HashMap<PathBuf, broadcast::Sender<Arc<BakeResult>>>>> =
        OnceLock::new();
    S.get_or_init(Default::default)
}

/// Owns one destination's in-flight entry. Dropping it — including when a
/// cancel aborts the task mid-render — frees the destination, so a re-request
/// starts a fresh bake rather than joining a corpse.
struct InFlightGuard {
    dest: PathBuf,
    tx: broadcast::Sender<Arc<BakeResult>>,
}

impl InFlightGuard {
    fn publish(&self, result: &BakeResult) {
        let _ = self.tx.send(Arc::new(result.clone()));
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        in_flight()
            .lock()
            .expect("audio fx in-flight map poisoned")
            .remove(&self.dest);
    }
}

enum Begin {
    Owner(InFlightGuard),
    Waiter(broadcast::Receiver<Arc<BakeResult>>),
}

/// Claim `dest` for this caller, or hand back a subscription to the claim
/// already held. Subscribing under the same lock that the owner's `Drop`
/// takes is what makes the handoff race-free: a waiter is registered before
/// the owner can publish or vanish.
fn begin(dest: &Path) -> Begin {
    let mut map = in_flight().lock().expect("audio fx in-flight map poisoned");
    match map.get(dest) {
        Some(tx) => Begin::Waiter(tx.subscribe()),
        None => {
            let (tx, _rx) = broadcast::channel(1);
            map.insert(dest.to_path_buf(), tx.clone());
            Begin::Owner(InFlightGuard {
                dest: dest.to_path_buf(),
                tx,
            })
        }
    }
}

/// Render `filter_complex` over `conform_path` into a VCONF at `dest`, or
/// join the bake already producing it.
pub async fn bake(conform_path: &Path, filter_complex: &str, dest: &Path) -> Result<PathBuf> {
    let guard = match begin(dest) {
        Begin::Waiter(mut rx) => {
            return match rx.recv().await {
                Ok(shared) => shared.as_ref().clone().map_err(anyhow::Error::msg),
                Err(_) => anyhow::bail!(
                    "the in-flight bake for {} ended without a result",
                    dest.display()
                ),
            }
        }
        Begin::Owner(guard) => guard,
    };
    let result = render(conform_path, filter_complex, dest).await;
    guard.publish(
        &result
            .as_ref()
            .map(PathBuf::clone)
            .map_err(|e| format!("{e:#}")),
    );
    result
}

/// Discards `<dest>.tmp` on every exit path, including a cancel — which drops
/// the render future rather than unwinding it, so no `?`-shaped cleanup can
/// cover that case.
struct TempGuard {
    dest: PathBuf,
    armed: bool,
}

impl TempGuard {
    fn arm(dest: &Path) -> Self {
        Self {
            dest: dest.to_path_buf(),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if self.armed {
            discard_temp(&self.dest);
        }
    }
}

/// The ffmpeg run. `filter_complex` arrives finished and must map its result
/// to `[out]`; rate and channel count come off the input header so the output
/// is the same VCONF shape as the input.
///
/// A graph that changes the frame count breaks the 1:1 sample alignment the
/// whole design rests on (`ConformReader` reads the sibling at the raw
/// conform's frame offsets), so a length change fails the bake instead of
/// landing a misaligned artifact.
async fn render(conform_path: &Path, filter_complex: &str, dest: &Path) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot bake audio effects");
    }
    let src = read_header(conform_path)?;

    // Armed before the first write so an abort mid-render leaves nothing for
    // the next attempt to trip over.
    let mut temp = TempGuard::arm(dest);
    let tmp = claim_temp(dest)?;

    let mut child = Command::new(ffmpeg_path())
        .no_console_window()
        // Reap on future-drop so a cancelled bake takes its ffmpeg with it;
        // see hwaccel.rs.
        .kill_on_drop(true)
        .args(["-hide_banner", "-nostats", "-loglevel", "error"])
        .args(["-skip_initial_bytes", &HEADER_LEN.to_string()])
        .args([
            "-f",
            "f32le",
            "-ar",
            &src.sample_rate.to_string(),
            "-ac",
            &src.channels.to_string(),
        ])
        .arg("-i")
        .arg(conform_path)
        .args(["-filter_complex", filter_complex])
        .args(["-map", "[out]", "-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg for audio fx bake")?;

    let mut stdout = child.stdout.take().expect("stdout was piped");

    let mut f = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {}", tmp.display()))?;
    let mut head = Vec::with_capacity(HEADER_LEN as usize);
    head.extend_from_slice(MAGIC);
    head.extend_from_slice(&CONFORM_FORMAT_VERSION.to_le_bytes());
    head.extend_from_slice(&src.sample_rate.to_le_bytes());
    head.extend_from_slice(&src.channels.to_le_bytes());
    head.extend_from_slice(&0u64.to_le_bytes()); // frame_count patched below
    f.write_all(&head).await.context("write bake header")?;

    let mut total_bytes: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = stdout.read(&mut buf).await.context("read ffmpeg stdout")?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).await.context("write bake data")?;
        total_bytes += n as u64;
    }

    let output = child
        .wait_with_output()
        .await
        .context("await ffmpeg for audio fx bake")?;
    if !output.status.success() {
        anyhow::bail!(
            "ffmpeg exited with {} for audio fx bake: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let bytes_per_frame = src.channels as u64 * 4;
    let frame_count = total_bytes / bytes_per_frame;
    if frame_count != src.frame_count {
        anyhow::bail!(
            "audio fx graph changed length: {} produced {frame_count} frames from {} — \
             a bake must stay sample-aligned with the conform it derives from",
            dest.display(),
            src.frame_count
        );
    }

    f.seek(std::io::SeekFrom::Start(20))
        .await
        .context("seek to frame_count")?;
    f.write_all(&frame_count.to_le_bytes())
        .await
        .context("patch frame_count")?;
    f.flush().await.context("flush bake")?;
    drop(f);

    promote_temp(dest)?;
    temp.disarm();
    Ok(dest.to_path_buf())
}

/// Live bake tasks by job key. The baker cancels a superseded bake by key
/// (docs/audio.md §Clip effects) — aborting drops the render future, which
/// reaps ffmpeg through `kill_on_drop` and discards the temp.
#[allow(clippy::type_complexity)]
fn live_jobs() -> &'static Mutex<HashMap<String, (u64, JoinHandle<()>)>> {
    static S: OnceLock<Mutex<HashMap<String, (u64, JoinHandle<()>)>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Registration counter. A key can legitimately be re-registered while the
/// previous task is still winding down, so a slot removes only the entry it
/// put there — without the token, the older slot's cleanup would deregister
/// (and so un-cancel) the newer task.
static NEXT_JOB_TOKEN: AtomicU64 = AtomicU64::new(0);

/// Holds a job key's registration for as long as the caller holds it.
pub struct JobSlot {
    job_key: String,
    token: u64,
}

impl Drop for JobSlot {
    fn drop(&mut self) {
        let mut map = live_jobs().lock().expect("audio fx job map poisoned");
        if map
            .get(&self.job_key)
            .is_some_and(|(token, _)| *token == self.token)
        {
            map.remove(&self.job_key);
        }
    }
}

/// Make `handle` cancellable under `job_key` until the returned slot drops.
pub fn register_job(job_key: String, handle: JoinHandle<()>) -> JobSlot {
    let token = NEXT_JOB_TOKEN.fetch_add(1, Ordering::Relaxed);
    live_jobs()
        .lock()
        .expect("audio fx job map poisoned")
        .insert(job_key.clone(), (token, handle));
    JobSlot { job_key, token }
}

/// Abort the bake registered under `job_key`. `false` means nothing was live
/// — it already finished, or was never registered.
pub fn cancel(job_key: &str) -> bool {
    let entry = live_jobs()
        .lock()
        .expect("audio fx job map poisoned")
        .remove(job_key);
    match entry {
        Some((_, handle)) => {
            handle.abort();
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::conform_reader::write_vconf;
    use crate::cache::{temp_path, CacheLayout};
    use crate::jobs::conform::CONFORM_SAMPLE_RATE;
    use tempfile::TempDir;

    const SR: f64 = CONFORM_SAMPLE_RATE as f64;

    fn ffmpeg_available() -> bool {
        ffmpeg_is_installed()
    }

    fn db_to_amp(dbfs: f64) -> f64 {
        10f64.powf(dbfs / 20.0)
    }

    /// A continuous sine at `rms_dbfs` (RMS, not peak).
    fn sine(freq: f64, rms_dbfs: f64, frames: usize) -> Vec<f32> {
        let amp = db_to_amp(rms_dbfs) * 2f64.sqrt();
        (0..frames)
            .map(|n| (amp * (2.0 * std::f64::consts::PI * freq * n as f64 / SR).sin()) as f32)
            .collect()
    }

    /// Pink noise at `rms_dbfs`, from a seeded PRNG through Kellet's
    /// economy −3 dB/octave filter. Seeded rather than `anoisesrc` so the
    /// thresholds below are pinned to one waveform and cannot drift with an
    /// ffmpeg version.
    fn pink_noise(rms_dbfs: f64, frames: usize, seed: u64) -> Vec<f32> {
        // A tenth of a second of filter warm-up is discarded — the cascade
        // starts from rest and its first output is not pink.
        let warmup = SR as usize / 10;
        let mut state = seed | 1;
        let mut next_white = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            ((state >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
        };
        let mut b = [0f64; 7];
        let mut out = Vec::with_capacity(frames);
        for i in 0..(frames + warmup) {
            let w = next_white();
            b[0] = 0.99886 * b[0] + w * 0.0555179;
            b[1] = 0.99332 * b[1] + w * 0.0750759;
            b[2] = 0.96900 * b[2] + w * 0.1538520;
            b[3] = 0.86650 * b[3] + w * 0.3104856;
            b[4] = 0.55000 * b[4] + w * 0.5329522;
            b[5] = -0.7616 * b[5] - w * 0.0168980;
            let pink = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
            b[6] = w * 0.115926;
            if i >= warmup {
                out.push(pink);
            }
        }
        let mean_sq = out.iter().map(|s| s * s).sum::<f64>() / out.len() as f64;
        let scale = db_to_amp(rms_dbfs) / mean_sq.sqrt();
        out.iter().map(|s| (s * scale) as f32).collect()
    }

    fn read_samples(path: &Path) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("read vconf");
        bytes[HEADER_LEN as usize..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect()
    }

    /// In-place iterative radix-2 FFT. Only `residual_dbfs` needs it and the
    /// crate has no FFT dependency.
    fn fft(re: &mut [f64], im: &mut [f64]) {
        let n = re.len();
        let mut j = 0usize;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j |= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2usize;
        while len <= n {
            let ang = -2.0 * std::f64::consts::PI / len as f64;
            let (wr, wi) = (ang.cos(), ang.sin());
            let half = len / 2;
            let mut base = 0usize;
            while base < n {
                let (mut cr, mut ci) = (1.0f64, 0.0f64);
                let mut k = 0usize;
                while k < half {
                    let (ur, ui) = (re[base + k], im[base + k]);
                    let (xr, xi) = (re[base + k + half], im[base + k + half]);
                    let (vr, vi) = (xr * cr - xi * ci, xr * ci + xi * cr);
                    re[base + k] = ur + vr;
                    im[base + k] = ui + vi;
                    re[base + k + half] = ur - vr;
                    im[base + k + half] = ui - vi;
                    let ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = ncr;
                    k += 1;
                }
                base += len;
            }
            len <<= 1;
        }
    }

    /// Level of `samples` in dBFS with a band around `notch_hz` removed —
    /// an ideal zero-phase notch, applied by zeroing the in-band bins of a
    /// Hann-windowed spectrum. That is how the noise residual under a loud
    /// tone becomes measurable: a time-domain notch steep enough to bury a
    /// −12 dBFS tone would also colour the very band being measured, and a
    /// least-squares projection at exactly 440 Hz leaves the tone's
    /// gain-modulation skirt behind.
    fn residual_dbfs(samples: &[f32], notch_hz: f64, half_width_hz: f64) -> f64 {
        let n = samples.len();
        let padded = n.next_power_of_two();
        let mut re = vec![0f64; padded];
        let mut im = vec![0f64; padded];
        for (i, s) in samples.iter().enumerate() {
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
            re[i] = *s as f64 * w;
        }
        fft(&mut re, &mut im);
        let mut power = 0f64;
        for k in 0..padded {
            let bin = k.min(padded - k) as f64 * SR / padded as f64;
            if (bin - notch_hz).abs() <= half_width_hz {
                continue;
            }
            power += re[k] * re[k] + im[k] * im[k];
        }
        // Parseval, undone: the padded transform's power / (N · n) is the mean
        // square of the WINDOWED samples, and a periodic Hann's mean square
        // is 3/8.
        let mean_sq = power / (padded as f64 * n as f64) / 0.375;
        10.0 * mean_sq.log10()
    }

    // ── measure_conform_rms ─────────────────────────────────────────────────

    #[test]
    fn rms_reports_a_known_level_and_none_for_silence() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("level.conform");
        // 1 s of −20 dBFS 1 kHz sine (whole cycles) followed by 1 s of digital
        // silence.
        let mut frames = sine(1000.0, -20.0, CONFORM_SAMPLE_RATE as usize);
        frames.extend(std::iter::repeat_n(0f32, CONFORM_SAMPLE_RATE as usize));
        write_vconf(&path, 1, &frames);

        let tone = measure_conform_rms(&path, 0, 1_000_000).expect("tone range");
        assert_eq!(tone.frames, 48_000);
        let dbfs = tone.rms_dbfs.expect("a sine has a level");
        assert!((dbfs + 20.0).abs() < 0.1, "expected −20 dBFS, got {dbfs}");

        let silent = measure_conform_rms(&path, 1_000_000, 2_000_000).expect("silent range");
        assert_eq!(silent.frames, 48_000);
        assert_eq!(
            silent.rms_dbfs, None,
            "digital silence has no dB value to report"
        );
    }

    #[test]
    fn rms_clamps_the_range_to_the_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("short.conform");
        write_vconf(&path, 2, &sine(1000.0, -20.0, 2 * 24_000));
        // 0.25 s of stereo audio; ask for [−1 s, +10 s) and for an inverted
        // range.
        let all = measure_conform_rms(&path, -1_000_000, 10_000_000).expect("clamped");
        assert_eq!(all.frames, 24_000);
        assert!(all.rms_dbfs.is_some());
        let empty = measure_conform_rms(&path, 200_000, 100_000).expect("inverted");
        assert_eq!(empty.frames, 0);
        assert_eq!(empty.rms_dbfs, None);
    }

    // ── cancel registry ─────────────────────────────────────────────────────

    #[test]
    fn cancel_reports_false_for_a_key_with_nothing_live() {
        assert!(!cancel("audio-fx-tests/never-registered"));
    }

    #[tokio::test]
    async fn a_re_registered_key_keeps_only_the_newest_slot() {
        let key = "audio-fx-tests/re-registered".to_string();
        let first = register_job(key.clone(), tokio::spawn(std::future::pending()));
        let _second = register_job(key.clone(), tokio::spawn(std::future::pending()));
        // The older slot must not deregister — and so un-cancel — the task
        // that replaced it.
        drop(first);
        assert!(cancel(&key), "the newest registration is still cancellable");
    }

    // ── bake, against real ffmpeg ───────────────────────────────────────────

    #[tokio::test]
    async fn bake_preserves_the_conform_shape() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not resolvable — skipping audio fx bake smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in.conform");
        let dest = tmp.path().join("in.fx-0123456789abcdef.conform");
        // 2 s stereo: 440 Hz left, 660 Hz right.
        let n = 2 * CONFORM_SAMPLE_RATE as usize;
        let left = sine(440.0, -18.0, n);
        let right = sine(660.0, -24.0, n);
        let interleaved: Vec<f32> = left
            .iter()
            .zip(right.iter())
            .flat_map(|(l, r)| [*l, *r])
            .collect();
        write_vconf(&src, 2, &interleaved);
        let src_header = read_header(&src).expect("source header");

        let out = bake(&src, "[0:a]afftdn=nr=6[out]", &dest)
            .await
            .expect("bake");
        assert_eq!(out, dest);

        let header = read_header(&dest).expect("baked header");
        assert_eq!(header.version, CONFORM_FORMAT_VERSION);
        assert_eq!(header.sample_rate, CONFORM_SAMPLE_RATE);
        assert_eq!(header.channels, src_header.channels);
        assert_eq!(
            header.frame_count, src_header.frame_count,
            "a bake must stay sample-aligned with its conform"
        );
        assert_eq!(
            std::fs::metadata(&dest).unwrap().len(),
            header.byte_offset_of_frame(header.frame_count),
            "body length must match the header"
        );
        assert!(!temp_path(&dest).exists(), "the temp was promoted");
    }

    #[tokio::test]
    async fn a_length_changing_graph_fails_the_bake() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not resolvable — skipping length-change guard");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in.conform");
        let dest = tmp.path().join("in.fx-deadbeefdeadbeef.conform");
        write_vconf(&src, 1, &sine(440.0, -18.0, CONFORM_SAMPLE_RATE as usize));

        let err = bake(
            &src,
            "[0:a]atrim=start=0.5,asetpts=PTS-STARTPTS[out]",
            &dest,
        )
        .await
        .expect_err("a shorter output is a defect, not a result");
        assert!(
            format!("{err:#}").contains("changed length"),
            "unexpected error: {err:#}"
        );
        assert!(!dest.exists(), "nothing may be promoted");
        assert!(!temp_path(&dest).exists(), "the temp is discarded");
    }

    #[tokio::test]
    async fn peaks_build_from_a_baked_vconf() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not resolvable — skipping vconf peaks build");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let src = tmp.path().join("in.conform");
        let dest = tmp.path().join("in.fx-abcdef0123456789.conform");
        write_vconf(
            &src,
            1,
            &sine(440.0, -18.0, 2 * CONFORM_SAMPLE_RATE as usize),
        );
        bake(&src, "[0:a]afftdn=nr=6[out]", &dest)
            .await
            .expect("bake");

        let peaks_dest = cache.waveform_fx("abc", "abcdef0123456789");
        let header = read_header(&dest).expect("baked header");
        let peaks = crate::jobs::waveform::run_from_input(
            &cache,
            crate::jobs::waveform::WaveformInput::Vconf {
                path: &dest,
                channels: header.channels,
            },
            peaks_dest.clone(),
        )
        .await
        .expect("peaks build");
        assert_eq!(peaks, peaks_dest);

        let peaks_header = crate::jobs::waveform::read_header(&peaks).expect("peaks header");
        // A mono VCONF decodes to 2 identical channels under the peaks
        // pipeline's `-ac 2`, exactly as a mono media file does.
        assert_eq!(
            peaks_header.channels,
            crate::jobs::waveform::MAX_CHANNELS as u32
        );
        assert!(!peaks_header.levels.is_empty());
    }

    /// A superseded bake must leave nothing behind: no partial temp, no
    /// promoted artifact, and no in-flight claim on the destination.
    #[tokio::test]
    async fn cancel_leaves_no_temp_and_frees_the_destination() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not resolvable — skipping bake cancel");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in.conform");
        let dest = tmp.path().join("in.fx-1111111111111111.conform");
        write_vconf(
            &src,
            1,
            &pink_noise(-30.0, 30 * CONFORM_SAMPLE_RATE as usize, 0xC0FFEE),
        );
        // Slow enough that the cancel lands mid-render: one afftdn pass runs
        // ~300x realtime, so a stack of them brings 30 s well over a second.
        let mut graph = String::from("[0:a]");
        for i in 0..32 {
            if i > 0 {
                graph.push(',');
            }
            graph.push_str("afftdn=nr=1");
        }
        graph.push_str("[out]");

        let key = "audio-fx-tests/cancel".to_string();
        let (bake_src, bake_dest) = (src.clone(), dest.clone());
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = tx.send(
                bake(&bake_src, &graph, &bake_dest)
                    .await
                    .map_err(|e| format!("{e:#}")),
            );
        });
        let slot = register_job(key.clone(), handle);

        let tmp_file = temp_path(&dest);
        assert!(
            wait_for(|| tmp_file.exists()).await,
            "the render never started"
        );
        assert!(cancel(&key), "an in-flight bake is cancellable");
        drop(slot);
        assert!(
            rx.await.is_err(),
            "an aborted task drops its sender rather than answering"
        );

        assert!(
            wait_for(|| !tmp_file.exists()).await,
            "a cancelled bake left {} behind",
            tmp_file.display()
        );
        assert!(!dest.exists(), "nothing was promoted");

        // The destination's in-flight claim went with the task, so a fresh
        // request runs rather than joining a corpse.
        bake(&src, "[0:a]afftdn=nr=6[out]", &dest)
            .await
            .expect("re-request after a cancel starts fresh");
        assert_eq!(
            read_header(&dest).unwrap().frame_count,
            read_header(&src).unwrap().frame_count
        );
    }

    /// Poll `cond` for up to ~5 s. Both halves of the cancel contract are
    /// observed through the filesystem, and Windows can hold a just-closed
    /// handle a moment longer than the abort itself takes.
    async fn wait_for(cond: impl Fn() -> bool) -> bool {
        for _ in 0..1000 {
            if cond() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        cond()
    }

    /// The catalog's denoise stage, mirrored from the spec so this DSP test
    /// exercises the graph TS actually emits: split, trim the sample region,
    /// concat it in front so `afftdn` learns the profile before the real
    /// signal arrives, then trim the pre-roll back off.
    ///
    /// Both trims are in SAMPLES. With second-valued `start`/`end` a region
    /// whose bounds miss the 48 kHz lattice makes the pre-roll and the
    /// trailing trim differ by one sample, and the length guard in `render`
    /// then rejects the bake. `asendcmd` keeps seconds — it is frame-granular
    /// and a sample of slop there is immaterial.
    fn denoise_stage(in_us: i64, out_us: i64, nr: i64, nf: i64) -> String {
        let in_n = crate::audio::mix::us_to_frame(in_us);
        let out_n = crate::audio::mix::us_to_frame(out_us);
        let len_n = out_n - in_n;
        let len_s = len_n as f64 / SR;
        format!(
            "[0:a]asplit[da][db];\
             [da]atrim=start_sample={in_n}:end_sample={out_n},asetpts=PTS-STARTPTS[dn];\
             [dn][db]concat=n=2:v=0:a=1,\
             asendcmd=c='0 afftdn@d sn start; {len_s:.6} afftdn@d sn stop',\
             afftdn@d=nr={nr}:nf={nf},\
             atrim=start_sample={len_n},asetpts=PTS-STARTPTS[out]"
        )
    }

    /// A sample region off the 48 kHz lattice at both ends, and with a span
    /// that is not a whole number of samples either, still bakes to an
    /// identical frame count. This is the regression guard for the trim units
    /// in `denoise_stage`: seconds here would land the output a sample short
    /// or long and the bake would bail.
    #[tokio::test]
    async fn a_non_lattice_region_still_bakes_to_an_equal_frame_count() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not resolvable — skipping non-lattice region bake");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("fixture.conform");
        let dest = tmp.path().join("fixture.fx-2222222222222222.conform");
        let frames = 12 * CONFORM_SAMPLE_RATE as usize;
        write_vconf(&src, 1, &pink_noise(-30.0, frames, 0xA11CE));

        // 9.2 s + 7 µs .. 10.8 s + 11 µs: 441600.336 .. 518400.528 samples.
        let graph = denoise_stage(9_200_007, 10_800_011, 12, -26);
        bake(&src, &graph, &dest)
            .await
            .expect("a non-lattice region must not change the length");

        let header = read_header(&dest).expect("baked header");
        assert_eq!(header.frame_count, frames as u64);
        assert_eq!(
            std::fs::metadata(&dest).unwrap().len(),
            header.byte_offset_of_frame(header.frame_count)
        );
        assert!(!temp_path(&dest).exists());
    }

    /// The reason the denoise stage carries a concat pre-roll: `afftdn` is
    /// streaming, so audio BEFORE `sn stop` is processed with an untrained
    /// profile. Prepending a copy of the sample region and trimming it back
    /// off trains the profile before the real signal reaches the filter, and
    /// re-deriving that here is what would tell us an ffmpeg upgrade changed
    /// `afftdn`'s behaviour.
    #[tokio::test]
    async fn the_concat_pre_roll_is_what_makes_the_profile_engage() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not resolvable — skipping profile-engages fixture");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("fixture.conform");

        // 12 s mono: pink noise throughout, plus a 440 Hz tone over 0–8 s.
        // 440 Hz x 8 s is a whole number of cycles, so the tone ends on a zero
        // crossing and adds no click. The tail leaves 9–11 s noise-only for
        // the sample region.
        let frames = 12 * CONFORM_SAMPLE_RATE as usize;
        let mut fixture = pink_noise(-34.0, frames, 0x5EED);
        let tone = sine(440.0, -12.0, 8 * CONFORM_SAMPLE_RATE as usize);
        for (f, t) in fixture.iter_mut().zip(tone.iter()) {
            *f += *t;
        }
        write_vconf(&src, 1, &fixture);

        let (in_us, out_us) = (9_200_000i64, 10_800_000i64);
        let region = measure_conform_rms(&src, in_us, out_us).expect("region rms");
        let region_dbfs = region.rms_dbfs.expect("the region is not silent");
        let nr = 12;
        let nf = (region_dbfs + 8.0).round().clamp(-80.0, -20.0) as i64;

        let graph_a = denoise_stage(in_us, out_us, nr, nf);
        // Graph B samples the region in place — same filter, same nr/nf, no
        // pre-roll.
        let (in_s, out_s) = (in_us as f64 / 1e6, out_us as f64 / 1e6);
        let graph_b = format!(
            "[0:a]asendcmd=c='{in_s:.6} afftdn@d sn start; {out_s:.6} afftdn@d sn stop',\
             afftdn@d=nr={nr}:nf={nf}[out]"
        );

        let dest_a = tmp.path().join("fixture.fx-aaaaaaaaaaaaaaaa.conform");
        let dest_b = tmp.path().join("fixture.fx-bbbbbbbbbbbbbbbb.conform");
        bake(&src, &graph_a, &dest_a).await.expect("bake A");
        bake(&src, &graph_b, &dest_b).await.expect("bake B");

        let baked_a = read_samples(&dest_a);
        let baked_b = read_samples(&dest_b);
        assert_eq!(baked_a.len(), frames, "A stayed sample-aligned");
        assert_eq!(baked_b.len(), frames, "B stayed sample-aligned");

        // 2–7 s carries the tone; 11.2–11.9 s is post-region noise only. The
        // same ideal notch is applied to both so the two are comparable.
        let under_tone =
            |s: &[f32]| residual_dbfs(&s[(2.0 * SR) as usize..(7.0 * SR) as usize], 440.0, 30.0);
        let after_region =
            |s: &[f32]| residual_dbfs(&s[(11.2 * SR) as usize..(11.9 * SR) as usize], 440.0, 30.0);

        let raw_pre = under_tone(&fixture);
        let a_pre = under_tone(&baked_a);
        let a_post = after_region(&baked_a);
        let b_pre = under_tone(&baked_b);
        eprintln!(
            "profile-engages residuals (dBFS): region {region_dbfs:.2}, nf {nf}, \
             raw 2-7s {raw_pre:.2}, A 2-7s {a_pre:.2}, A 11.2-11.9s {a_post:.2}, \
             B 2-7s {b_pre:.2}"
        );

        assert!(
            raw_pre - a_pre >= 6.0,
            "the pre-roll must buy at least 6 dB before the region: \
             raw {raw_pre:.2} -> A {a_pre:.2}"
        );
        assert!(
            (a_pre - a_post).abs() <= 1.5,
            "a trained profile treats both stretches alike: \
             A 2-7s {a_pre:.2} vs A 11.2-11.9s {a_post:.2}"
        );
        assert!(
            raw_pre - b_pre < 5.0,
            "sampling in place leaves the pre-region stretch largely \
             untreated: raw {raw_pre:.2} -> B {b_pre:.2}"
        );
    }
}
