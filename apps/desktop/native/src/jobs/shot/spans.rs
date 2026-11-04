//! In-shot defect spans: where a source is dark, soft or frozen, at any point
//! rather than per whole shot. The opt-in `spans` pass of `analyze_clip`.
//!
//! Owns the one decode behind it ([`cached_source_spans`]): ffmpeg samples the
//! source every `step_us` (the input [`super::pick_source`] picks, 720p proxy
//! first), scales each sample to [`super::SPAN_FRAME_WIDTH`] and pipes it to
//! Rust, which keeps only the previous frame. Each sample is measured with the
//! per-shot stat functions (`mean_luma`, `var_laplacian`, `ssim`), so there is
//! one metric set; ffmpeg's blackdetect / freezedetect / blurdetect are not
//! used. [`assemble`] turns the sample stream into spans, pure and total.
//!
//! The whole-source result is cached like the VSHOT report, one sidecar per
//! (source, tier, step, thresholds) in the same `shots/` namespace, found on
//! any tier; callers clip it to a layer window with [`clip_spans`].

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use image::RgbImage;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};

use super::{
    mean_luma, ssim, var_laplacian, write_json_atomic, FREEZE_SSIM, SPAN_DARK_LUMA,
    SPAN_DARK_MIN_US, SPAN_FRAME_WIDTH, SPAN_FROZEN_MIN_US, SPAN_SOFT_MIN_US, SPAN_SOFT_RATIO,
    SPAN_STEP_RANGE_US,
};
use crate::cache::CacheLayout;
use crate::ffmpeg::{ffmpeg_is_installed, Bound};
use crate::state::MediaItem;

/// Wall-clock seconds the scan may spend per second of source, on top of
/// `FRAME_TIMEOUT`: room for a software decode of the original at half speed.
const SCAN_WALL_PER_SOURCE_SECOND: u64 = 2;

/// What a span reports. Serializes to the lowercase tag the tool advertises;
/// ordered so spans that start together sort the same way every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpanKind {
    Dark,
    Soft,
    Frozen,
}

/// One defect span, source-absolute. `value` is per kind: `dark` the mean
/// luma 0..1 of its samples, `soft` its samples' mean sharpness over the
/// source median, `frozen` the lowest adjacent-sample SSIM in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DefectSpan {
    pub kind: SpanKind,
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub value: f64,
}

/// The whole-source result the sidecar holds: every span of the source at
/// `step_us`, sorted by start.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanReport {
    pub step_us: i64,
    pub spans: Vec<DefectSpan>,
}

/// One sampled frame's numbers. Sample `k` sits at source time `k * step_us`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Sample {
    /// Mean luma 0..1 (`mean_luma`).
    pub luma: f64,
    /// Laplacian variance of 0..1 luma (`var_laplacian`).
    pub sharpness: f64,
    /// SSIM against the previous sample; `None` for the first.
    pub ssim_prev: Option<f64>,
}

impl Sample {
    fn is_dark(&self) -> bool {
        self.luma < SPAN_DARK_LUMA
    }
}

/// The sidecar key: `blake3("spans" | source_hash | tier | step_us |
/// thresholds)`. Source hash and tier for `super::cache_key`'s reasons; the
/// step because it changes the samples; the thresholds and frame width because
/// the cached value is the spans they produced, so retuning one re-scans
/// instead of serving spans the new numbers would not draw. The leading tag
/// keeps it apart from the VSHOT keys that share the `shots/` directory.
pub fn cache_key(source_hash: &str, tier: &str, step_us: i64) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"spans\0");
    h.update(source_hash.as_bytes());
    h.update(b"\0");
    h.update(tier.as_bytes());
    h.update(b"\0");
    h.update(&step_us.to_le_bytes());
    for v in [SPAN_DARK_LUMA, FREEZE_SSIM, SPAN_SOFT_RATIO] {
        h.update(&v.to_le_bytes());
    }
    for v in [SPAN_DARK_MIN_US, SPAN_FROZEN_MIN_US, SPAN_SOFT_MIN_US] {
        h.update(&v.to_le_bytes());
    }
    h.update(&SPAN_FRAME_WIDTH.to_le_bytes());
    h.finalize().to_hex().to_string()
}

/// The sidecar an earlier scan of `media` at `step_us` left on any tier, the
/// way `super::find_cached_report` finds a VSHOT report.
fn find_cached_spans(
    cache: &CacheLayout,
    media: &MediaItem,
    step_us: i64,
) -> Option<std::path::PathBuf> {
    super::find_cached_sidecar(cache, media, |tier| {
        cache.shot(&cache_key(&media.file_hash_blake3, tier, step_us))
    })
    .map(|(path, _tier)| path)
}

/// The WHOLE-source spans of `media` at `step_us`, from the sidecar, or scanned
/// and written through on a miss. A repeat call reads the sidecar and decodes
/// nothing; another `step_us` is another key and scans again. A corrupt
/// sidecar is a miss, so a killed write self-heals.
pub async fn cached_source_spans(
    cache: &CacheLayout,
    media: &MediaItem,
    step_us: i64,
) -> Result<SpanReport> {
    anyhow::ensure!(
        SPAN_STEP_RANGE_US.contains(&step_us),
        "step_us {step_us} is outside {}..={}",
        SPAN_STEP_RANGE_US.start(),
        SPAN_STEP_RANGE_US.end()
    );
    if let Some(path) = find_cached_spans(cache, media, step_us) {
        crate::cache::touch_if_stale(&path);
        match read_report(&path) {
            Ok(report) => return Ok(report),
            Err(e) => tracing::warn!(
                "span cache {} unreadable, rescanning: {e:#}",
                path.display()
            ),
        }
    }
    let (video, tier) = super::pick_source(cache, media);
    let path = cache.shot(&cache_key(&media.file_hash_blake3, tier, step_us));
    let duration_us = media.metadata.duration_us.unwrap_or_default();
    if duration_us <= 0 {
        anyhow::bail!(
            "media {} has no known duration — re-import it so ffprobe can measure the source before scanning spans",
            media.id
        );
    }
    let samples = scan(&video, duration_us, step_us).await?;
    let report = SpanReport {
        step_us,
        spans: assemble(&samples, step_us, duration_us),
    };
    write_json_atomic(&path, &report, "span report").await?;
    cache.notify_write();
    Ok(report)
}

/// Read a cached `SpanReport` back from its JSON sidecar.
fn read_report(path: &Path) -> Result<SpanReport> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse span report {}", path.display()))
}

/// Clip whole-source spans to the layer window `[in_us, out_us]`, the way
/// `super::clip_report` clips shots: a span cut by the window is truncated to
/// it, one outside it is dropped, and `value` carries over unchanged.
pub fn clip_spans(spans: &[DefectSpan], in_us: i64, out_us: i64) -> Vec<DefectSpan> {
    spans
        .iter()
        .filter_map(|s| {
            let t_start_us = s.t_start_us.max(in_us);
            let t_end_us = s.t_end_us.min(out_us);
            (t_end_us > t_start_us).then(|| DefectSpan {
                t_start_us,
                t_end_us,
                ..s.clone()
            })
        })
        .collect()
}

/// Turn a sample stream into spans. Pure and total.
///
/// Each measurement stands for one step: sample `k`'s luma and sharpness for
/// `[k·step, (k+1)·step)`, and the SSIM pair `(k-1, k)` for `[(k-1)·step,
/// k·step]`. Consecutive qualifying measurements merge into one run, and a run
/// is a span once it lasts its kind's minimum. A run that reaches the last
/// sample ends at `duration_us`; nothing extends past it.
///
/// - `dark`: luma < [`SPAN_DARK_LUMA`] for ≥ [`SPAN_DARK_MIN_US`].
/// - `soft`: sharpness < [`SPAN_SOFT_RATIO`] × the median sharpness of the
///   source's non-dark samples, for ≥ [`SPAN_SOFT_MIN_US`].
/// - `frozen`: adjacent SSIM ≥ [`FREEZE_SSIM`] for ≥ [`SPAN_FROZEN_MIN_US`].
///
/// A dark sample counts only as dark: a black frame is trivially unsharp and
/// identical to the next, and reporting it three times says nothing more.
pub(crate) fn assemble(samples: &[Sample], step_us: i64, duration_us: i64) -> Vec<DefectSpan> {
    let n = samples.len();
    if n == 0 || step_us <= 0 || duration_us <= 0 {
        return Vec::new();
    }
    let last = n - 1;
    // Where a run whose last measurement covers up to `t` ends: the source end
    // when the run reaches the last sample, else `t`, never past the source.
    let end_of = |b: usize, t: i64| {
        if b == last {
            duration_us
        } else {
            t.min(duration_us)
        }
    };
    let mut out = Vec::new();

    // dark
    for (a, b) in runs(n, |k| samples[k].is_dark()) {
        let (t0, t1) = (a as i64 * step_us, end_of(b, (b as i64 + 1) * step_us));
        if t1 - t0 >= SPAN_DARK_MIN_US {
            let value = mean(samples[a..=b].iter().map(|s| s.luma));
            out.push(span(SpanKind::Dark, t0, t1, value));
        }
    }

    // soft, relative to the median of the samples that show a picture
    let mut sharp: Vec<f64> = samples
        .iter()
        .filter(|s| !s.is_dark())
        .map(|s| s.sharpness)
        .collect();
    if let Some(median) = median(&mut sharp).filter(|m| *m > 0.0) {
        let soft =
            |k: usize| !samples[k].is_dark() && samples[k].sharpness < SPAN_SOFT_RATIO * median;
        for (a, b) in runs(n, soft) {
            let (t0, t1) = (a as i64 * step_us, end_of(b, (b as i64 + 1) * step_us));
            if t1 - t0 >= SPAN_SOFT_MIN_US {
                let value = mean(samples[a..=b].iter().map(|s| s.sharpness)) / median;
                out.push(span(SpanKind::Soft, t0, t1, value));
            }
        }
    }

    // frozen: pair (k-1, k) qualifies at k
    let frozen = |k: usize| {
        k > 0 && !samples[k].is_dark() && samples[k].ssim_prev.is_some_and(|s| s >= FREEZE_SSIM)
    };
    for (a, b) in runs(n, frozen) {
        let (t0, t1) = ((a as i64 - 1) * step_us, end_of(b, b as i64 * step_us));
        if t1 - t0 >= SPAN_FROZEN_MIN_US {
            let value = samples[a..=b]
                .iter()
                .filter_map(|s| s.ssim_prev)
                .fold(f64::INFINITY, f64::min);
            out.push(span(SpanKind::Frozen, t0, t1, value));
        }
    }

    out.sort_by_key(|s| (s.t_start_us, s.kind, s.t_end_us));
    out
}

fn span(kind: SpanKind, t_start_us: i64, t_end_us: i64, value: f64) -> DefectSpan {
    DefectSpan {
        kind,
        t_start_us,
        t_end_us,
        // Three decimals: the thresholds are coarser than that, and the
        // numbers are advisory across ffmpeg builds like the per-shot stats.
        value: (value * 1000.0).round() / 1000.0,
    }
}

/// Maximal runs `(first, last)` of consecutive indices in `0..n` where `pred`
/// holds.
fn runs(n: usize, pred: impl Fn(usize) -> bool) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut open: Option<usize> = None;
    for k in 0..n {
        match (pred(k), open) {
            (true, None) => open = Some(k),
            (false, Some(a)) => {
                out.push((a, k - 1));
                open = None;
            }
            _ => {}
        }
    }
    if let Some(a) = open {
        out.push((a, n - 1));
    }
    out
}

fn mean(values: impl Iterator<Item = f64>) -> f64 {
    let (sum, count) = values.fold((0.0, 0usize), |(s, c), v| (s + v, c + 1));
    if count == 0 {
        0.0
    } else {
        sum / count as f64
    }
}

/// The median of `values` (sorted in place); the mean of the middle two for an
/// even count. `None` when empty.
fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    })
}

/// The scan's wall-clock limit: `FRAME_TIMEOUT` plus
/// [`SCAN_WALL_PER_SOURCE_SECOND`] per second of source.
fn scan_timeout(duration_us: i64) -> Duration {
    crate::ffmpeg::FRAME_TIMEOUT
        + Duration::from_micros(duration_us.max(0) as u64 * SCAN_WALL_PER_SOURCE_SECOND)
}

/// Decode `video` once, sampling a frame every `step_us`, and measure each.
/// Frames arrive as PPM (`image2pipe`): raw rgb24 behind a few header bytes
/// that carry the scaled size, which `scale=W:-2` decides from the source's
/// storage size and rotation — so the reader never has to predict it.
async fn scan(video: &Path, duration_us: i64, step_us: i64) -> Result<Vec<Sample>> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot scan spans");
    }
    let _permit = crate::resources::held_by(
        crate::resources::Holder::new("shots"),
        crate::jobs::ffmpeg_sem().acquire(),
    )
    .await
    .context("acquire ffmpeg slot")?;

    let limit = scan_timeout(duration_us);
    let vf = format!("fps=fps=1000000/{step_us},scale={SPAN_FRAME_WIDTH}:-2");
    let mut child = crate::ffmpeg::command(Bound::Timeout(limit))
        .args([
            "-nostdin",
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-i",
        ])
        .arg(video)
        .args([
            "-an",
            "-sn",
            "-dn",
            "-vf",
            &vf,
            "-pix_fmt",
            "rgb24",
            "-c:v",
            "ppm",
            "-f",
            "image2pipe",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg for span scan")?;
    let stdout = child.take_stdout().expect("stdout was piped");
    let stderr_task = tokio::spawn(crate::jobs::conform::drain_stderr(
        child.take_stderr().expect("stderr was piped"),
    ));

    let read = tokio::time::timeout(limit, read_samples(stdout, step_us, duration_us)).await;
    let samples = match read {
        Ok(Ok(samples)) => samples,
        Ok(Err(e)) => {
            let _ = child.stop().await;
            stderr_task.abort();
            return Err(e);
        }
        Err(_) => {
            let _ = child.stop().await;
            stderr_task.abort();
            anyhow::bail!("span scan ran past its {} s limit", limit.as_secs());
        }
    };
    let status = child.wait().await.context("await ffmpeg for span scan")?;
    let stderr = stderr_task.await.context("read span scan stderr task")??;
    if !status.success() {
        anyhow::bail!(
            "ffmpeg exited with {status} during the span scan: {}",
            String::from_utf8_lossy(&stderr).trim()
        );
    }
    if samples.is_empty() {
        anyhow::bail!("the span scan decoded no frames from {}", video.display());
    }
    Ok(samples)
}

/// Read PPM frames off `pipe` until EOF, measuring each against the previous
/// one and keeping no other frame. Samples at or past `duration_us` (the fps
/// filter may round one onto the end) are read and dropped.
pub(crate) async fn read_samples(
    pipe: impl AsyncRead + Unpin,
    step_us: i64,
    duration_us: i64,
) -> Result<Vec<Sample>> {
    let mut r = BufReader::new(pipe);
    let mut samples = Vec::new();
    let mut prev: Option<RgbImage> = None;
    let mut k: i64 = 0;
    while let Some(frame) = read_ppm(&mut r).await? {
        if k * step_us < duration_us {
            samples.push(Sample {
                luma: mean_luma(&frame),
                sharpness: var_laplacian(&frame),
                ssim_prev: prev.as_ref().map(|p| ssim(p, &frame)),
            });
        }
        prev = Some(frame);
        k += 1;
    }
    Ok(samples)
}

/// One binary PPM (`P6`, maxval 255) frame, or `None` at a clean EOF.
async fn read_ppm(r: &mut (impl AsyncRead + Unpin)) -> Result<Option<RgbImage>> {
    let mut magic = [0u8; 2];
    match r.read_exact(&mut magic).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e).context("read span frame"),
    }
    anyhow::ensure!(&magic == b"P6", "span frame is not a binary PPM");
    let width = read_ppm_number(r).await?;
    let height = read_ppm_number(r).await?;
    let maxval = read_ppm_number(r).await?;
    anyhow::ensure!(maxval == 255, "span frame maxval {maxval}, expected 255");
    anyhow::ensure!(
        width > 0 && height > 0 && width <= 16_384 && height <= 16_384,
        "span frame size {width}x{height} is implausible"
    );
    let mut data = vec![0u8; width as usize * height as usize * 3];
    r.read_exact(&mut data)
        .await
        .context("span frame ended early")?;
    RgbImage::from_raw(width, height, data)
        .map(Some)
        .context("span frame size")
}

/// One PPM header number: leading whitespace and `#` comments skipped, then
/// digits, then the single whitespace byte that ends the field.
async fn read_ppm_number(r: &mut (impl AsyncRead + Unpin)) -> Result<u32> {
    let mut b = r.read_u8().await.context("span frame header")?;
    loop {
        if b.is_ascii_whitespace() {
            b = r.read_u8().await.context("span frame header")?;
        } else if b == b'#' {
            while b != b'\n' {
                b = r.read_u8().await.context("span frame header")?;
            }
        } else {
            break;
        }
    }
    let mut n: u32 = 0;
    let mut digits = 0;
    while b.is_ascii_digit() {
        n = n
            .checked_mul(10)
            .and_then(|n| n.checked_add(u32::from(b - b'0')))
            .context("span frame header number overflows")?;
        digits += 1;
        b = r.read_u8().await.context("span frame header")?;
    }
    anyhow::ensure!(
        digits > 0 && b.is_ascii_whitespace(),
        "malformed span frame header"
    );
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEP: i64 = 500_000;

    /// A sharp, moving picture: well lit, sharpness 1.0, unlike its neighbour.
    fn ok() -> Sample {
        Sample {
            luma: 0.5,
            sharpness: 1.0,
            ssim_prev: Some(0.5),
        }
    }
    fn dark() -> Sample {
        Sample { luma: 0.03, ..ok() }
    }
    fn soft() -> Sample {
        Sample {
            sharpness: 0.2,
            ..ok()
        }
    }
    fn still() -> Sample {
        Sample {
            ssim_prev: Some(0.995),
            ..ok()
        }
    }
    /// A run of samples replaced by what `f` makes.
    type Edit = (std::ops::Range<usize>, fn() -> Sample);
    /// `n` ok samples with `f` applied at `range`; the first has no SSIM.
    fn stream(n: usize, edits: &[Edit]) -> Vec<Sample> {
        let mut s: Vec<Sample> = (0..n).map(|_| ok()).collect();
        for (range, f) in edits {
            for k in range.clone() {
                s[k] = f();
            }
        }
        s[0].ssim_prev = None;
        s
    }
    fn shape(spans: &[DefectSpan]) -> Vec<(SpanKind, i64, i64)> {
        spans
            .iter()
            .map(|s| (s.kind, s.t_start_us, s.t_end_us))
            .collect()
    }

    #[test]
    fn a_dark_run_at_the_minimum_is_a_span_and_one_below_is_not() {
        // One dark sample covers one 0.5 s step: exactly the minimum.
        let spans = assemble(&stream(10, &[(4..5, dark)]), STEP, 5_000_000);
        assert_eq!(shape(&spans), vec![(SpanKind::Dark, 2_000_000, 2_500_000)]);
        assert_eq!(spans[0].value, 0.03);

        // At a 0.25 s step the same single sample is half the minimum.
        let spans = assemble(&stream(20, &[(8..9, dark)]), 250_000, 5_000_000);
        assert!(spans.is_empty(), "{spans:?}");
        // Two consecutive samples merge into one run that reaches it.
        let spans = assemble(&stream(20, &[(8..10, dark)]), 250_000, 5_000_000);
        assert_eq!(shape(&spans), vec![(SpanKind::Dark, 2_000_000, 2_500_000)]);
    }

    #[test]
    fn consecutive_samples_merge_and_a_gap_splits_the_run() {
        let spans = assemble(&stream(20, &[(2..5, dark), (6..9, dark)]), STEP, 10_000_000);
        assert_eq!(
            shape(&spans),
            vec![
                (SpanKind::Dark, 1_000_000, 2_500_000),
                (SpanKind::Dark, 3_000_000, 4_500_000),
            ]
        );
    }

    #[test]
    fn dark_value_is_the_mean_luma_of_the_run() {
        let mut s = stream(10, &[(2..4, dark)]);
        s[3].luma = 0.05;
        let spans = assemble(&s, STEP, 5_000_000);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].value, 0.04);
    }

    #[test]
    fn soft_is_relative_to_the_source_median_and_needs_a_second() {
        // Sharpness 0.2 against a median of 1.0: under 35 %.
        let spans = assemble(&stream(20, &[(4..6, soft)]), STEP, 10_000_000);
        assert_eq!(shape(&spans), vec![(SpanKind::Soft, 2_000_000, 3_000_000)]);
        assert_eq!(spans[0].value, 0.2);
        // One soft sample is half a second, under the minimum.
        assert!(assemble(&stream(20, &[(4..5, soft)]), STEP, 10_000_000).is_empty());

        // The same absolute sharpness in a uniformly soft source is its median,
        // so nothing is soft relative to it.
        let all_soft = stream(20, &[(0..20, soft)]);
        assert!(assemble(&all_soft, STEP, 10_000_000).is_empty());

        // 0.4 is 40 % of the median: not soft.
        let mut s = stream(20, &[(4..8, soft)]);
        for x in &mut s[4..8] {
            x.sharpness = 0.4;
        }
        assert!(assemble(&s, STEP, 10_000_000).is_empty());
    }

    #[test]
    fn dark_samples_count_only_as_dark() {
        // A black stretch is unsharp and identical frame to frame; it is
        // reported once, as dark, and stays out of the soft median.
        let mut s = stream(20, &[(4..10, dark)]);
        for x in &mut s[4..10] {
            x.sharpness = 0.0;
            x.ssim_prev = Some(1.0);
        }
        let spans = assemble(&s, STEP, 10_000_000);
        assert_eq!(shape(&spans), vec![(SpanKind::Dark, 2_000_000, 5_000_000)]);
    }

    #[test]
    fn frozen_spans_the_pairs_and_needs_a_second() {
        // Samples 4..=6 each repeat their predecessor: pairs (3,4) (4,5) (5,6)
        // hold from sample 3's time to sample 6's.
        let mut s = stream(20, &[(4..7, still)]);
        s[5].ssim_prev = Some(0.99);
        let spans = assemble(&s, STEP, 10_000_000);
        assert_eq!(
            shape(&spans),
            vec![(SpanKind::Frozen, 1_500_000, 3_000_000)]
        );
        assert_eq!(spans[0].value, 0.99, "the lowest SSIM in the run");

        // One repeated pair is half a second: under the minimum.
        assert!(assemble(&stream(20, &[(4..5, still)]), STEP, 10_000_000).is_empty());
        // At exactly FREEZE_SSIM a pair counts.
        let mut s = stream(20, &[(4..6, still)]);
        s[4].ssim_prev = Some(FREEZE_SSIM);
        assert_eq!(assemble(&s, STEP, 10_000_000).len(), 1);
    }

    #[test]
    fn a_run_reaching_the_last_sample_ends_at_the_source_duration() {
        // 10 samples at 0.5 s over a 4.8 s source: the last sits at 4.5 s.
        let spans = assemble(&stream(10, &[(8..10, dark)]), STEP, 4_800_000);
        assert_eq!(shape(&spans), vec![(SpanKind::Dark, 4_000_000, 4_800_000)]);
        let spans = assemble(&stream(10, &[(7..10, still)]), STEP, 4_800_000);
        assert_eq!(
            shape(&spans),
            vec![(SpanKind::Frozen, 3_000_000, 4_800_000)]
        );
        // A run that stops short of the last sample keeps its own end.
        let spans = assemble(&stream(10, &[(6..8, dark)]), STEP, 4_800_000);
        assert_eq!(shape(&spans), vec![(SpanKind::Dark, 3_000_000, 4_000_000)]);
    }

    #[test]
    fn spans_are_sorted_by_start() {
        let s = stream(30, &[(20..23, dark), (2..5, soft), (10..14, still)]);
        let spans = assemble(&s, STEP, 15_000_000);
        assert_eq!(
            shape(&spans),
            vec![
                (SpanKind::Soft, 1_000_000, 2_500_000),
                (SpanKind::Frozen, 4_500_000, 6_500_000),
                (SpanKind::Dark, 10_000_000, 11_500_000),
            ]
        );
    }

    #[test]
    fn an_empty_stream_has_no_spans() {
        assert!(assemble(&[], STEP, 10_000_000).is_empty());
    }

    #[test]
    fn clip_spans_truncates_at_the_window_and_drops_spans_outside_it() {
        let spans = vec![
            span(SpanKind::Dark, 0, 2_000_000, 0.01),
            span(SpanKind::Frozen, 3_000_000, 6_000_000, 0.99),
            span(SpanKind::Soft, 8_000_000, 9_000_000, 0.2),
        ];
        let clipped = clip_spans(&spans, 1_000_000, 5_000_000);
        assert_eq!(
            shape(&clipped),
            vec![
                (SpanKind::Dark, 1_000_000, 2_000_000),
                (SpanKind::Frozen, 3_000_000, 5_000_000),
            ]
        );
        assert_eq!(clipped[1].value, 0.99, "value carries over");
        // A span touching the window only at its edge is outside it.
        assert!(clip_spans(&spans, 2_000_000, 3_000_000).is_empty());
    }

    #[test]
    fn cache_key_depends_on_source_tier_and_step() {
        let base = cache_key("h", "quick", 500_000);
        assert_eq!(base, cache_key("h", "quick", 500_000));
        assert_ne!(base, cache_key("h2", "quick", 500_000));
        assert_ne!(base, cache_key("h", "orig", 500_000));
        assert_ne!(base, cache_key("h", "quick", 250_000));
        // Not a VSHOT key, though both live in `shots/`.
        assert_ne!(
            base,
            super::super::cache_key("h", "quick", &super::super::floor_opts())
        );
    }

    /// Frames as ffmpeg's `image2pipe` PPM writes them.
    fn ppm(img: &RgbImage) -> Vec<u8> {
        let mut out = format!("P6\n{} {}\n255\n", img.width(), img.height()).into_bytes();
        out.extend_from_slice(img.as_raw());
        out
    }

    #[tokio::test]
    async fn read_samples_measures_each_frame_against_the_previous_one() {
        let grey = RgbImage::from_pixel(16, 9, image::Rgb([128, 128, 128]));
        let black = RgbImage::from_pixel(16, 9, image::Rgb([0, 0, 0]));
        let mut pipe = Vec::new();
        for f in [&grey, &grey, &black, &black] {
            pipe.extend(ppm(f));
        }
        // The fourth frame sits at 1.5 s, past a 1.2 s source: read, dropped.
        let samples = read_samples(&pipe[..], STEP, 1_200_000).await.unwrap();
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0].ssim_prev, None);
        assert!((samples[1].ssim_prev.unwrap() - 1.0).abs() < 1e-9);
        assert!(samples[2].luma < 1e-9);
        assert!((samples[0].luma - mean_luma(&grey)).abs() < 1e-12);
    }

    #[tokio::test]
    async fn read_samples_refuses_a_truncated_frame() {
        let grey = RgbImage::from_pixel(16, 9, image::Rgb([128, 128, 128]));
        let mut pipe = ppm(&grey);
        pipe.truncate(pipe.len() - 10);
        assert!(read_samples(&pipe[..], STEP, 10_000_000).await.is_err());
        // An empty pipe is no frames, not an error; the scan refuses that.
        assert!(read_samples(&[0u8; 0][..], STEP, 10_000_000)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_scan_timeout_grows_with_the_source() {
        let short = scan_timeout(10_000_000);
        let long = scan_timeout(3_600_000_000);
        assert!(short >= crate::ffmpeg::FRAME_TIMEOUT);
        assert_eq!(long - short, Duration::from_secs((3_600 - 10) * 2));
    }

    fn test_media(path: &Path, hash: &str, duration_us: Option<i64>) -> MediaItem {
        serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::now_v7(),
            "label": null,
            "path_abs": path,
            "path_rel": null,
            "kind": "Video",
            "metadata": crate::state::MediaMetadata { duration_us, ..Default::default() },
            "decode_route": { "route": "bypass" },
            "waveform_path": null,
            "conform_path": null,
            "thumbnails_dir": null,
            "file_hash_blake3": hash,
            "file_size": 0,
            "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        }))
        .unwrap()
    }

    /// A seeded sidecar is a hit that decodes nothing (the source does not
    /// exist), and another step is another key: a miss that has to scan.
    #[tokio::test]
    async fn a_repeat_call_reads_the_sidecar_and_another_step_rescans() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let media = test_media(Path::new("/nonexistent.mp4"), "cafef00d", Some(6_000_000));
        let seeded = SpanReport {
            step_us: STEP,
            spans: vec![span(SpanKind::Dark, 0, 1_000_000, 0.01)],
        };
        // No proxy in the temp cache, so the scan tier is "orig".
        let path = cache.shot(&cache_key("cafef00d", "orig", STEP));
        write_json_atomic(&path, &seeded, "span report")
            .await
            .unwrap();

        let got = cached_source_spans(&cache, &media, STEP).await.unwrap();
        assert_eq!(got.spans, seeded.spans);
        assert!(cached_source_spans(&cache, &media, 250_000).await.is_err());
        // Out of range is refused before any lookup.
        assert!(cached_source_spans(&cache, &media, 50_000).await.is_err());
    }

    /// The live decode: a generated clip with a black, a frozen and a blurred
    /// section yields one span of each kind, each within a step of where the
    /// section is; a second call is served from the sidecar with the source
    /// gone. Skips cleanly without ffmpeg.
    #[tokio::test]
    async fn scan_finds_a_dark_a_frozen_and_a_soft_section() {
        if !ffmpeg_is_installed() {
            eprintln!("ffmpeg not installed — skipping the span scan smoke");
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let video = tmp.path().join("defects.mp4");
        // 0-3 s moving, 3-5 s black, 5-8 s one frame held, 8-11 s blurred,
        // 11-14 s moving. `scroll` keeps the picture moving, blurred or not.
        let src = "testsrc2=s=320x180:r=25:d=3,scroll=h=0.004";
        let graph = format!(
            "{src}[a];\
             color=c=black:s=320x180:r=25:d=2[b];\
             testsrc2=s=320x180:r=25:d=0.04,tpad=stop_mode=clone:stop_duration=2.96[c];\
             {src},boxblur=6:2[d];\
             {src}[e];\
             [a][b][c][d][e]concat=n=5:v=1:a=0,format=yuv420p[v]"
        );
        let status = tokio::process::Command::new(crate::ffmpeg::ffmpeg_path())
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(["-filter_complex", &graph, "-map", "[v]"])
            .args(["-c:v", "mpeg4", "-q:v", "2"])
            .arg(&video)
            .status()
            .await
            .unwrap();
        assert!(status.success(), "fixture ffmpeg failed: {status}");

        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let media = test_media(&video, "defects", Some(14_000_000));
        let report = cached_source_spans(&cache, &media, STEP).await.unwrap();

        let near = |a: i64, b: i64| (a - b).abs() <= STEP;
        let one = |kind: SpanKind, t0: i64, t1: i64| {
            let of_kind: Vec<_> = report.spans.iter().filter(|s| s.kind == kind).collect();
            assert_eq!(of_kind.len(), 1, "{kind:?}: {:?}", report.spans);
            let s = of_kind[0];
            assert!(
                near(s.t_start_us, t0) && near(s.t_end_us, t1),
                "{kind:?} at [{}, {}], expected about [{t0}, {t1}]",
                s.t_start_us,
                s.t_end_us
            );
        };
        one(SpanKind::Dark, 3_000_000, 5_000_000);
        one(SpanKind::Frozen, 5_000_000, 8_000_000);
        one(SpanKind::Soft, 8_000_000, 11_000_000);

        // The repeat is a sidecar read: with the source deleted, a decode
        // would fail.
        std::fs::remove_file(&video).unwrap();
        let again = cached_source_spans(&cache, &media, STEP).await.unwrap();
        assert_eq!(again.spans, report.spans);
    }
}
