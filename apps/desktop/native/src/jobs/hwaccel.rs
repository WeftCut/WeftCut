//! Platform hardware decode helpers for ffmpeg proxy jobs: the per-OS
//! `-hwaccel` selection and the runner that falls back to software decode.

use std::process::Output;

use anyhow::{Context, Result};
use tracing::{info, warn};

use crate::ffmpeg::{Bound, FfmpegCommand};

/// Native ffmpeg `-hwaccel` name for the current OS, if any.
pub fn preferred_hwaccel() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        Some("d3d11va")
    }
    #[cfg(target_os = "macos")]
    {
        Some("videotoolbox")
    }
    #[cfg(target_os = "linux")]
    {
        Some("vaapi")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Append hardware-decode flags immediately before `-i`.
pub fn push_hwaccel_args(cmd: &mut FfmpegCommand) {
    let Some(accel) = preferred_hwaccel() else {
        return;
    };
    cmd.args(["-hwaccel", accel]);
    #[cfg(target_os = "linux")]
    {
        cmd.args(["-vaapi_device", "/dev/dri/renderD128"]);
    }
}

/// Run an ffmpeg transcode command, trying hardware decode first when
/// available. `build` receives `use_hw=true` for the first attempt.
pub async fn output_with_hw_decode_fallback_scoped<F>(
    cache: &crate::cache::CacheLayout,
    label: &str,
    mut build: F,
) -> Result<Output>
where
    F: FnMut(bool, &mut FfmpegCommand),
{
    if preferred_hwaccel().is_some() {
        let mut cmd = crate::ffmpeg::command(Bound::TemporarilyUnbounded);
        build(true, &mut cmd);
        let output = cache
            .command_output(&mut cmd)
            .await
            .with_context(|| format!("spawn ffmpeg for {label} (hw decode)"))?;
        if output.status.success() {
            info!("{label}: hardware decode succeeded");
            return Ok(output);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!(
            "{label}: hardware decode failed, retrying with software decode: {}",
            stderr.trim()
        );
    }

    let mut cmd = crate::ffmpeg::command(Bound::TemporarilyUnbounded);
    build(false, &mut cmd);
    if preferred_hwaccel().is_some() {
        info!("{label}: software decode fallback");
    } else {
        info!("{label}: software decode (no hwaccel on this platform)");
    }
    cache
        .command_output(&mut cmd)
        .await
        .with_context(|| format!("spawn ffmpeg for {label} (sw decode)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_hwaccel_is_set_on_supported_platforms() {
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        assert!(preferred_hwaccel().is_some());
    }
}
