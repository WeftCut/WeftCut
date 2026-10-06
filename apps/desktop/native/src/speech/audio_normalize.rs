//! Explicit, per-request peak normalization of the transcription WAV only.
//! The source and the shared extraction cache are always read-only. A private
//! temporary copy survives until inference ends, then is removed by RAII.
use std::{path::PathBuf, process::Stdio};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::process::NoConsoleWindow;

const TARGET_DBFS: f64 = -3.0;
const MAX_GAIN_DB: f64 = 24.0;

#[derive(Debug, Serialize)]
pub struct NormalizationReport {
    pub input_peak_dbfs: Option<f64>,
    pub gain_db: f64,
    pub target_peak_dbfs: f64,
    pub max_gain_db: f64,
}

pub struct PreparedAudio {
    pub path: PathBuf,
    pub normalization: Option<NormalizationReport>,
    _directory: Option<tempfile::TempDir>,
}

fn parse_peak(stderr: &str) -> Result<Option<f64>> {
    let value = stderr
        .lines()
        .rev()
        .find_map(|line| {
            line.split_once("Peak level dB:")
                .map(|(_, value)| value.trim())
        })
        .context("ffmpeg did not report the audio peak")?;
    if value == "-inf" {
        return Ok(None);
    }
    let peak: f64 = value.parse().context("invalid audio peak")?;
    anyhow::ensure!(peak.is_finite(), "invalid audio peak");
    Ok(Some(peak))
}

fn report(peak: Option<f64>) -> NormalizationReport {
    NormalizationReport {
        input_peak_dbfs: peak,
        gain_db: peak.map_or(0.0, |p| (TARGET_DBFS - p).clamp(0.0, MAX_GAIN_DB)),
        target_peak_dbfs: TARGET_DBFS,
        max_gain_db: MAX_GAIN_DB,
    }
}

pub async fn prepare(path: PathBuf, normalize: bool) -> Result<PreparedAudio> {
    if !normalize {
        return Ok(PreparedAudio {
            path,
            normalization: None,
            _directory: None,
        });
    }
    let _permit = crate::jobs::ffmpeg_sem()
        .acquire()
        .await
        .context("acquire ffmpeg slot")?;
    let measured = crate::ffmpeg::command()
        .no_console_window()
        .kill_on_drop(true)
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(&path)
        .args([
            "-af",
            "astats=measure_perchannel=none:measure_overall=Peak_level",
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("measure transcription audio")?;
    anyhow::ensure!(
        measured.status.success(),
        "audio level measurement failed: {}",
        String::from_utf8_lossy(&measured.stderr)
    );
    let normalization = report(parse_peak(&String::from_utf8_lossy(&measured.stderr))?);
    // Silence and already-loud audio need no amplification. Report zero gain
    // rather than inventing a successful change or attenuating normal input.
    if normalization.gain_db == 0.0 {
        return Ok(PreparedAudio {
            path,
            normalization: Some(normalization),
            _directory: None,
        });
    }
    let directory = tempfile::Builder::new()
        .prefix("weftcut-transcription-")
        .tempdir()?;
    let output = directory.path().join("normalized.wav");
    let result = crate::ffmpeg::command()
        .no_console_window()
        .kill_on_drop(true)
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(&path)
        .args([
            "-af",
            &format!("volume={:.8}dB", normalization.gain_db),
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("normalize transcription copy")?;
    anyhow::ensure!(
        result.status.success() && crate::cache::cached_ok(&output),
        "transcription normalization failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(PreparedAudio {
        path: output,
        normalization: Some(normalization),
        _directory: Some(directory),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(amplitude: i16) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&32036_u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&16000_u32.to_le_bytes());
        bytes.extend_from_slice(&32000_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&32000_u32.to_le_bytes());
        for i in 0..16000 {
            let sample = ((i as f64 * std::f64::consts::TAU * 440.0 / 16000.0).sin()
                * amplitude as f64)
                .round() as i16;
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn gain_is_bounded_and_silence_or_loud_input_is_unchanged() {
        assert_eq!(report(Some(-26.0)).gain_db, 23.0);
        assert_eq!(report(Some(-70.0)).gain_db, 24.0);
        assert_eq!(report(Some(-1.0)).gain_db, 0.0);
        assert_eq!(report(None).gain_db, 0.0);
        assert_eq!(parse_peak("[astats] Peak level dB: -inf").unwrap(), None);
        assert!(parse_peak("missing").is_err());
        assert!(parse_peak("Peak level dB: NaN").is_err());
    }

    #[tokio::test]
    async fn original_mode_never_prepares_or_replaces_the_input() {
        let path = PathBuf::from("even-a-missing-file.wav");
        let prepared = prepare(path.clone(), false).await.unwrap();
        assert_eq!(prepared.path, path);
        assert!(prepared.normalization.is_none());
    }

    #[tokio::test]
    async fn normalization_changes_only_a_private_copy_and_preserves_sample_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("raw.wav");
        let original = wav(1600);
        std::fs::write(&path, &original).unwrap();
        let prepared = prepare(path.clone(), true).await.unwrap();
        assert_ne!(prepared.path, path);
        let report = prepared.normalization.as_ref().unwrap();
        assert!((report.gain_db - 23.23).abs() < 0.02, "{report:?}");
        let decoded = crate::ffmpeg::command()
            .args(["-v", "error", "-i"])
            .arg(&prepared.path)
            .args(["-f", "s16le", "-"])
            .output()
            .await
            .unwrap();
        assert!(decoded.status.success());
        assert_eq!(decoded.stdout.len(), 32000);
        let peak = decoded
            .stdout
            .as_chunks::<2>()
            .0
            .iter()
            .map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs())
            .max()
            .unwrap();
        assert!((20.0 * (peak as f64 / 32768.0).log10() - TARGET_DBFS).abs() < 0.01);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let output = prepared.path.clone();
        drop(prepared);
        assert!(!output.exists());
        assert!(path.exists());
        std::fs::write(&path, wav(0)).unwrap();
        let silent = prepare(path.clone(), true).await.unwrap();
        assert_eq!(silent.path, path);
        assert_eq!(silent.normalization.unwrap().gain_db, 0.0);
    }
}
