//! Source-audio measurements for choosing music edit points. Reads bounded
//! ranges of the existing finest waveform cache; no decode, model or mutation.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::tools::parse_uuid;
use super::wire::{McpToolError, ToolResult};
use crate::jobs::waveform;
use crate::napi_backend::Backend;
use crate::state::{MediaItem, MediaKind};

const MAX_WINDOW_US: i64 = 60_000_000;
const CONTEXT_US: i64 = 500_000;

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AnalyzeAudioArgs {
    /// Imported Audio or Video media id; analyzes its original audio before mix/effects.
    media_id: String,
    /// Source-absolute start in microseconds, inclusive. Default 0.
    start_us: Option<i64>,
    /// Source-absolute end, exclusive. Default start + 60 seconds, capped at media end. At most 60 seconds per call.
    end_us: Option<i64>,
    /// Maximum waveform summary bins, 1..1000 (default 200). Does not change event detection resolution.
    max_points: Option<usize>,
    /// Minimum short-time energy rise for onset candidates, 1..30 dB (default 6). Candidates are not beats or melody labels.
    onset_threshold_db: Option<f64>,
    #[serde(default)]
    #[schemars(skip)]
    media: Option<MediaItem>,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct Bin {
    start_us: i64,
    end_us: i64,
    peak_dbfs: f64,
    rms_dbfs: f64,
}

#[derive(Debug, Clone, Serialize)]
struct Event {
    source_us: i64,
    /// Energy ratio in dB, not a probability. Signed for energy changes.
    change_db: f64,
    rms_dbfs: f64,
}

#[derive(Debug, Serialize)]
struct Analysis {
    media_id: String,
    time_basis: &'static str,
    audio_basis: &'static str,
    start_us: i64,
    end_us: i64,
    resolution_us: f64,
    db_floor: f64,
    peak_dbfs: f64,
    rms_dbfs: f64,
    waveform: Vec<Bin>,
    onsets: Vec<Event>,
    onset_count: usize,
    energy_changes: Vec<Event>,
    energy_change_count: usize,
}

fn invalid(message: impl Into<String>) -> McpToolError {
    McpToolError::invalid_params(message, None)
}

fn window(args: &AnalyzeAudioArgs, duration: i64) -> Result<(i64, i64, usize, f64), McpToolError> {
    let start = args.start_us.unwrap_or(0);
    let end = args
        .end_us
        .unwrap_or(start.saturating_add(MAX_WINDOW_US).min(duration));
    if start < 0 || end <= start || end > duration {
        return Err(invalid(format!(
            "audio window [{start}, {end}) must lie inside [0, {duration}) with start_us < end_us"
        )));
    }
    if end - start > MAX_WINDOW_US {
        return Err(invalid(
            "analyze_audio accepts at most 60000000 us (60 s); request consecutive windows",
        ));
    }
    let points = args.max_points.unwrap_or(200);
    if !(1..=1000).contains(&points) {
        return Err(invalid("max_points must be in 1..1000"));
    }
    let threshold = args.onset_threshold_db.unwrap_or(6.0);
    if !threshold.is_finite() || !(1.0..=30.0).contains(&threshold) {
        return Err(invalid("onset_threshold_db must be in 1..30"));
    }
    Ok((start, end, points, threshold))
}

pub(super) async fn analyze_audio(
    b: &Backend,
    args: AnalyzeAudioArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.media_id, "media_id")?;
    let media = args
        .media
        .as_ref()
        .filter(|m| m.id == id)
        .ok_or_else(|| invalid(format!("media {id} not found")))?;
    if !matches!(media.kind, MediaKind::Audio | MediaKind::Video) || media.metadata.audio.is_none()
    {
        return Err(invalid(format!("media {id} has no audio stream")));
    }
    let duration = media
        .metadata
        .duration_us
        .filter(|d| *d > 0)
        .ok_or_else(|| {
            McpToolError::invalid_request(
                "media duration is not available; wait for media probing",
                None,
            )
        })?;
    let (start, end, points, threshold) = window(&args, duration)?;
    let path = media
        .waveform_path
        .clone()
        .filter(|p| crate::cache::cached_ok(p))
        .unwrap_or_else(|| b.cache.waveform(&media.file_hash_blake3));
    if !crate::cache::cached_ok(&path) {
        return Err(McpToolError::invalid_request(format!("waveform not generated yet for media {id} — wait for a media:job_complete event with kind=waveform and retry"), None));
    }
    crate::cache::touch_if_stale(&path);
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Analysis> {
        let header = waveform::read_header(&path)?;
        anyhow::ensure!(
            (1..=2).contains(&header.channels),
            "unsupported waveform channel count"
        );
        let level = header.levels[0];
        let rate = header.sample_rate as u128;
        let scale = level.frames_per_peak as u128 * 1_000_000;
        // Rational indexing avoids accumulated drift on long source files.
        let first = ((start.saturating_sub(CONTEXT_US).max(0) as u128 * rate) / scale)
            .min(level.peak_count as u128) as u32;
        let last = (((end.saturating_add(CONTEXT_US).min(duration) as u128 * rate).div_ceil(scale))
            .min(level.peak_count as u128)) as u32;
        anyhow::ensure!(
            last > first && last - first <= 1_000_000,
            "waveform range is empty or exceeds the analysis limit"
        );
        // A cached envelope may extend by one partial bin, but may not silently
        // omit the requested tail (a stale/truncated cache is an error).
        anyhow::ensure!(
            level.peak_count as u128 * scale / rate + scale.div_ceil(rate) >= end as u128,
            "waveform does not cover the requested audio window"
        );
        let mut energy = vec![0.0; (last - first) as usize];
        let mut peak = vec![0.0_f64; energy.len()];
        for channel in 0..header.channels {
            let r = waveform::read_range(&path, 0, channel as usize, first, last - first)?;
            for i in 0..energy.len() {
                // Average channel energies, never signed samples (anti-phase
                // stereo must not cancel). Peak is the loudest channel.
                energy[i] +=
                    (waveform::dequantize_rms(r.rms[i]) as f64).powi(2) / header.channels as f64;
                peak[i] = peak[i]
                    .max((waveform::dequantize(r.min[i]) as f64).abs())
                    .max((waveform::dequantize(r.max[i]) as f64).abs());
            }
        }
        let signal = Signal {
            energy,
            peak,
            first: first as u64,
            sample_rate: rate as u64,
            frames_per_peak: level.frames_per_peak as u64,
        };
        Ok(signal.analyze(args.media_id, start, end, points, threshold))
    })
    .await
    .map_err(|e| McpToolError::internal_error(format!("audio analysis task: {e}"), None))?
    .map_err(|e| McpToolError::internal_error(format!("audio analysis: {e:#}"), None))?;
    ToolResult::json(&result)
}

struct Signal {
    energy: Vec<f64>,
    peak: Vec<f64>,
    first: u64,
    sample_rate: u64,
    frames_per_peak: u64,
}

fn db(energy: f64) -> f64 {
    (10.0 * energy.max(1e-12).log10()).max(-120.0)
}
fn rounded(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

impl Signal {
    fn time(&self, i: usize) -> i64 {
        (((self.first as u128 + i as u128) * self.frames_per_peak as u128 * 1_000_000)
            / self.sample_rate as u128) as i64
    }

    fn analyze(
        &self,
        media_id: String,
        start: i64,
        end: i64,
        points: usize,
        threshold: f64,
    ) -> Analysis {
        let n = self.energy.len();
        let resolution = self.frames_per_peak as f64 * 1e6 / self.sample_rate as f64;
        let count_for = |us: f64| ((us / resolution).round() as usize).max(1);
        let mut prefix = vec![0.0; n + 1];
        for (i, e) in self.energy.iter().enumerate() {
            prefix[i + 1] = prefix[i] + e;
        }
        let mean = |a: usize, b: usize| (prefix[b] - prefix[a]) / (b - a).max(1) as f64;
        let lo = (0..n).find(|&i| self.time(i + 1) > start).unwrap_or(n);
        let hi = (lo..n).find(|&i| self.time(i) >= end).unwrap_or(n);
        let mut waveform = Vec::new();
        let stride = (hi - lo).div_ceil(points).max(1);
        let mut total_energy = 0.0;
        let mut total_duration = 0;
        let mut total_peak = 0.0_f64;
        for a in (lo..hi).step_by(stride) {
            let b = (a + stride).min(hi);
            let mut energy = 0.0;
            let mut length = 0;
            let mut peak = 0.0_f64;
            for i in a..b {
                let weight = (self.time(i + 1).min(end) - self.time(i).max(start)).max(0);
                energy += self.energy[i] * weight as f64;
                length += weight;
                peak = peak.max(self.peak[i]);
            }
            total_energy += energy;
            total_duration += length;
            total_peak = total_peak.max(peak);
            waveform.push(Bin {
                start_us: self.time(a).max(start),
                end_us: self.time(b).min(end),
                peak_dbfs: rounded(db(peak * peak)),
                rms_dbfs: rounded(db(energy / length.max(1) as f64)),
            });
        }
        // Compare 10 ms after an attack to 50 ms before it; energy changes
        // compare two 500 ms windows. Context is read outside the requested
        // range so a zoom does not manufacture a boundary onset.
        let attack = count_for(10_000.0);
        let baseline = count_for(50_000.0);
        let section = count_for(CONTEXT_US as f64);
        let mut onsets = Vec::new();
        let mut changes = Vec::new();
        for i in lo..hi {
            let t = self.time(i);
            if t < start {
                continue;
            }
            if i >= baseline && i + attack <= n {
                let after = mean(i, i + attack);
                let change = db(after) - db(mean(i - baseline, i));
                if change >= threshold && db(after) >= -40.0 {
                    onsets.push(Event {
                        source_us: t,
                        change_db: rounded(change),
                        rms_dbfs: rounded(db(after)),
                    });
                }
            }
            if i >= section && i + section <= n {
                let before = mean(i - section, i);
                let after = mean(i, i + section);
                let change = db(after) - db(before);
                if change.abs() >= 4.0 && db(before.max(after)) >= -40.0 {
                    changes.push(Event {
                        source_us: t,
                        change_db: rounded(change),
                        rms_dbfs: rounded(db(after)),
                    });
                }
            }
        }
        let (onsets, onset_count) = select_events(onsets, 100_000, 128);
        let (energy_changes, energy_change_count) = select_events(changes, 500_000, 32);
        Analysis {
            media_id,
            time_basis: "source",
            audio_basis: "original_before_mix_and_effects",
            start_us: start,
            end_us: end,
            resolution_us: resolution,
            db_floor: -120.0,
            peak_dbfs: rounded(db(total_peak * total_peak)),
            rms_dbfs: rounded(db(total_energy / total_duration.max(1) as f64)),
            waveform,
            onsets,
            onset_count,
            energy_changes,
            energy_change_count,
        }
    }
}

// Non-maximum suppression over the whole request: keep the strongest local
// candidates, then return chronologically. Count reports any output truncation.
fn select_events(mut events: Vec<Event>, gap: i64, limit: usize) -> (Vec<Event>, usize) {
    events.sort_by(|a, b| {
        b.change_db
            .abs()
            .total_cmp(&a.change_db.abs())
            .then(a.source_us.cmp(&b.source_us))
    });
    let mut kept: Vec<Event> = Vec::new();
    for event in events {
        if kept
            .iter()
            .all(|e| (e.source_us - event.source_us).abs() >= gap)
        {
            kept.push(event);
        }
    }
    let count = kept.len();
    kept.truncate(limit);
    kept.sort_by_key(|e| e.source_us);
    (kept, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AudioStreamMeta, DecodeRoute, MediaMetadata};

    fn signal(values: Vec<f64>) -> Signal {
        Signal {
            energy: values.iter().map(|v| v * v).collect(),
            peak: values,
            first: 0,
            sample_rate: 1000,
            frames_per_peak: 1,
        }
    }

    fn args() -> AnalyzeAudioArgs {
        AnalyzeAudioArgs {
            media_id: uuid::Uuid::new_v4().to_string(),
            start_us: None,
            end_us: None,
            max_points: None,
            onset_threshold_db: None,
            media: None,
        }
    }

    #[test]
    fn validates_ranges_and_bounds_default_window() {
        let mut a = args();
        assert_eq!(window(&a, 90_000_000).unwrap(), (0, 60_000_000, 200, 6.0));
        a.start_us = Some(80_000_000);
        assert_eq!(window(&a, 90_000_000).unwrap().1, 90_000_000);
        a.start_us = Some(-1);
        assert!(window(&a, 90_000_000).is_err());
        a.start_us = Some(0);
        a.end_us = Some(60_000_001);
        assert!(window(&a, 90_000_000).is_err());
        a.end_us = Some(0);
        assert!(window(&a, 90_000_000).is_err());
        a.end_us = Some(90_000_001);
        assert!(window(&a, 90_000_000).is_err());
        a.end_us = None;
        a.max_points = Some(0);
        assert!(window(&a, 90_000_000).is_err());
        a.max_points = Some(1001);
        assert!(window(&a, 90_000_000).is_err());
        a.max_points = None;
        a.onset_threshold_db = Some(f64::NAN);
        assert!(window(&a, 90_000_000).is_err());
        a.start_us = Some(i64::MAX);
        a.end_us = Some(i64::MIN);
        assert!(window(&a, i64::MAX).is_err());
    }

    #[test]
    fn silence_and_constant_tone_do_not_invent_onsets() {
        for amp in [0.0, 0.25] {
            let report = signal(vec![amp; 4000]).analyze("m".into(), 123_456, 3_456_789, 17, 6.0);
            assert!(report.onsets.is_empty());
            assert!(report.energy_changes.is_empty());
            assert!(report.waveform.len() <= 17);
            assert_eq!(report.waveform.first().unwrap().start_us, 123_456);
            assert_eq!(report.waveform.last().unwrap().end_us, 3_456_789);
            assert!((report.rms_dbfs - db(amp * amp)).abs() < 0.001);
            assert!(!serde_json::to_string(&report).unwrap().contains("null"));
        }
    }

    #[test]
    fn finds_a_sustained_lift_and_drop_with_source_times() {
        let mut values = vec![0.02; 5000];
        values[2000..3500].fill(0.4);
        let s = signal(values);
        let r = s.analyze("m".into(), 1_000_000, 4_500_000, 80, 6.0);
        assert!(r
            .onsets
            .iter()
            .any(|e| (e.source_us - 2_000_000).abs() <= 10_000));
        assert!(r
            .energy_changes
            .iter()
            .any(|e| (e.source_us - 2_000_000).abs() <= 10_000 && e.change_db > 20.0));
        assert!(r
            .energy_changes
            .iter()
            .any(|e| (e.source_us - 3_500_000).abs() <= 10_000 && e.change_db < -20.0));
        let coarse = s.analyze("m".into(), 1_000_000, 4_500_000, 1, 6.0);
        assert_eq!(
            serde_json::to_value(&r.onsets).unwrap(),
            serde_json::to_value(&coarse.onsets).unwrap()
        );
        let middle = s.analyze("m".into(), 2_500_000, 3_000_000, 20, 6.0);
        assert!(
            middle.onsets.is_empty(),
            "a query boundary inside a loud passage is not an onset"
        );
    }

    #[test]
    fn rational_clock_does_not_drift_on_long_sources() {
        let mut s = signal(vec![0.1; 1000]);
        s.sample_rate = 22_050;
        s.frames_per_peak = 22;
        s.first = 20_000_000;
        let t = s.time(999);
        let expected = ((20_000_999_u128 * 22 * 1_000_000) / 22_050) as i64;
        assert_eq!(t, expected);
        let r = s.analyze("m".into(), s.time(0) + 37, s.time(1000) - 17, 29, 6.0);
        assert_eq!(r.waveform[0].start_us, s.time(0) + 37);
        assert_eq!(r.waveform.last().unwrap().end_us, s.time(1000) - 17);
    }

    #[test]
    fn strongest_events_are_bounded_sorted_and_counted() {
        let events = (0..200)
            .map(|i| Event {
                source_us: i * 100_000,
                change_db: 6.0 + i as f64 / 100.0,
                rms_dbfs: -12.0,
            })
            .collect();
        let (events, count) = select_events(events, 100_000, 128);
        assert_eq!(count, 200);
        assert_eq!(events.len(), 128);
        assert!(events.windows(2).all(|w| w[0].source_us < w[1].source_us));
        assert_eq!(events.last().unwrap().source_us, 19_900_000);
    }

    #[tokio::test]
    async fn reads_stereo_cache_and_refuses_missing_or_non_audio_media() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.peaks");
        let data = waveform::LevelData {
            channels: 2,
            peak_count: 1000,
            mins: vec![
                vec![waveform::quantize(-0.5); 1000],
                vec![waveform::quantize(-0.25); 1000],
            ],
            maxs: vec![
                vec![waveform::quantize(0.5); 1000],
                vec![waveform::quantize(0.25); 1000],
            ],
            rmss: vec![
                vec![waveform::quantize_rms(0.5); 1000],
                vec![waveform::quantize_rms(0.25); 1000],
            ],
        };
        waveform::write_peaks(&path, 2, &[(22, data)])
            .await
            .unwrap();
        let mut a = args();
        let media = MediaItem {
            id: uuid::Uuid::parse_str(&a.media_id).unwrap(),
            label: None,
            path_abs: dir.path().join("source.wav"),
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(990_000),
                audio: Some(AudioStreamMeta {
                    sample_rate: 22_050,
                    channels: 2,
                    codec: "pcm_f32le".into(),
                    start_pts_us: None,
                }),
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: Some(path.clone()),
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "audio-analysis-fixture".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        };
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        assert!(analyze_audio(&b, a)
            .await
            .unwrap_err()
            .message
            .contains("not found"));
        a = args();
        a.media_id = media.id.to_string();
        a.media = Some(media.clone());
        let result = analyze_audio(&b, a).await.unwrap();
        let value = serde_json::to_value(result).unwrap();
        let report: serde_json::Value =
            serde_json::from_str(value["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(
            (report["rms_dbfs"].as_f64().unwrap() - db((0.5_f64.powi(2) + 0.25_f64.powi(2)) / 2.0))
                .abs()
                < 0.01
        );
        assert!((report["peak_dbfs"].as_f64().unwrap() - db(0.25)).abs() < 0.01);
        assert_eq!(report["time_basis"], "source");
        let mut no_audio = media.clone();
        no_audio.metadata.audio = None;
        a = args();
        a.media_id = media.id.to_string();
        a.media = Some(no_audio);
        assert!(analyze_audio(&b, a)
            .await
            .unwrap_err()
            .message
            .contains("no audio"));
        std::fs::remove_file(path).unwrap();
        a = args();
        a.media_id = media.id.to_string();
        a.media = Some(media);
        assert!(analyze_audio(&b, a)
            .await
            .unwrap_err()
            .message
            .contains("waveform not generated"));
    }
}
