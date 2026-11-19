//! Imported source media. The media pool is content-addressed by blake3 so
//! relink-by-content works when files move.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::decode_route::DecodeRoute;
use super::ids::MediaId;
use super::project_path::ProjectRelPath;
use super::time::TimeUs;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: MediaId,
    pub label: Option<String>,
    /// Where this process opens the file: `path_rel` under the project
    /// folder when that is set, else the outside file it was imported from.
    pub path_abs: PathBuf,
    /// The copy inside the project folder (`Media/...`), `None` while the
    /// file is outside it or its copy is still pending.
    pub path_rel: Option<ProjectRelPath>,
    pub kind: MediaKind,
    pub metadata: MediaMetadata,
    /// Where preview and export each decode this source from, plus the
    /// readiness of any proxy.
    pub decode_route: DecodeRoute,
    pub waveform_path: Option<PathBuf>,
    /// Canonical conformed PCM (VCONF; see `jobs::conform`). `None` until
    /// the conform job lands. Serde-defaulted so pre-conform projects load.
    #[serde(default)]
    pub conform_path: Option<PathBuf>,
    pub thumbnails_dir: Option<PathBuf>,
    pub file_hash_blake3: String,
    pub file_size: u64,
    pub file_mtime: u64,
    pub imported_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MediaKind {
    Video,
    Audio,
    Image,
    Subtitle,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MediaMetadata {
    /// Normalized content duration in microseconds. Timeline source windows
    /// (`src_in_us/src_out_us`) are expressed in this content-time domain where
    /// 0 means the visible/playable start of the source, not necessarily
    /// container PTS 0.
    pub duration_us: Option<TimeUs>,
    /// Container PTS that maps to normalized content-time 0. Diagnostic and
    /// decode-mapping metadata; older projects default to 0/None.
    #[serde(default)]
    pub start_pts_us: Option<TimeUs>,
    /// Raw ffprobe duration before subtracting any non-zero start offset. Kept
    /// for diagnostics/backwards reasoning; UI should use `duration_us`.
    #[serde(default)]
    pub container_duration_us: Option<TimeUs>,
    pub video: Option<VideoStreamMeta>,
    pub audio: Option<AudioStreamMeta>,
    /// ffprobe `format.format_name` — the demuxer/container (e.g. "gif",
    /// "webp_pipe", "mov,mp4,m4a,...", "avif"). `detect_kind` reads it to tell
    /// an animated still-image container (→ Image) from a movie that merely
    /// carries an image codec (motion-JPEG .avi → Video). `#[serde(default)]`
    /// keeps older `.vproj` files loadable.
    #[serde(default)]
    pub container_format: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VideoStreamMeta {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub codec: String,
    pub pix_fmt: String,
    /// Container PTS for this stream's first content sample, if ffprobe reports
    /// it. Video decoders use this to map normalized source time to packets.
    #[serde(default)]
    pub start_pts_us: Option<TimeUs>,
    /// Demuxer-reported frame count (ffprobe `nb_frames`), when the container
    /// carries one. `Some(1)` marks a single-frame stream — how `detect_kind`
    /// tells a still image from an animated GIF. `None` when the demuxer
    /// doesn't report it (common for png/webp pipes and many mp4s).
    #[serde(default)]
    pub nb_frames: Option<u64>,
    /// Color tags from the container/bitstream (ffprobe names). `color_matrix`
    /// corresponds to ffprobe's `color_space` key (YCbCr matrix coefficients,
    /// e.g. "bt709", "smpte170m") — named `matrix` here to avoid conflation with
    /// the broader "color space" concept; `color_range` is "tv"/"pc";
    /// `color_primaries`/`color_transfer` follow ffprobe naming directly. `None`
    /// when the source declares no value (or declares "unknown").
    #[serde(default)]
    pub color_matrix: Option<String>,
    #[serde(default)]
    pub color_range: Option<String>,
    #[serde(default)]
    pub color_primaries: Option<String>,
    #[serde(default)]
    pub color_transfer: Option<String>,
}

impl VideoStreamMeta {
    /// Whether a picture of this size that declares no colour reads as HD
    /// (BT.709) or SD (SMPTE 170M). An unknown size reads as HD. The renderer's
    /// `undeclaredIsHd` is the same rule for the decode lanes; both are held to
    /// `undeclaredColourGolden.fixture.json`.
    pub fn undeclared_is_hd(width: u32, height: u32) -> bool {
        width == 0 || height == 0 || width >= 1280 || height > 576
    }

    /// The YCbCr matrix an ffmpeg conversion must be told for this source and
    /// its proxies, or `None` when ffmpeg reads the right one off the frame: the
    /// stream declares it, or the picture is RGB and has none.
    pub fn undeclared_matrix(&self) -> Option<&'static str> {
        if self.color_matrix.is_some() || self.is_rgb() {
            return None;
        }
        Some(if Self::undeclared_is_hd(self.width, self.height) {
            "bt709"
        } else {
            "smpte170m"
        })
    }

    /// Whether the picture is RGB-coded: its samples are RGB, not YCbCr.
    pub fn is_rgb(&self) -> bool {
        Self::is_rgb_pix_fmt(&self.pix_fmt)
    }

    /// ffmpeg's RGB pixel formats, packed (`rgb24`, `bgra`, `x2rgb10le`),
    /// planar (`gbrp`) and palettised. The renderer's `isRgbCoded` is the same
    /// test for the decode lanes; both are held to
    /// `undeclaredColourGolden.fixture.json`.
    pub fn is_rgb_pix_fmt(f: &str) -> bool {
        f.contains("rgb") || f.contains("bgr") || f.starts_with("gbr") || f == "pal8"
    }
}

/// Which proxy recipe a source takes. Each recipe has its own versions, which
/// are part of a proxy's cache file name, so changing one recipe re-encodes that recipe's proxies and no others.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyRecipe {
    /// The proxy keeps the source's YCbCr matrix and range.
    Ycbcr,
    /// An RGB-coded source, converted into the YCbCr its proxy declares
    /// (`jobs::proxy::RGB_PROXY_COLOR`).
    Rgb,
}

impl ProxyRecipe {
    /// The full proxy's version. Bump a recipe's whenever its ffmpeg args
    /// change in a way that affects playback, scrub or colour: the master's
    /// cache name carries the version (`CacheLayout::proxy`), so an older
    /// master is never adopted and the job re-encodes it.
    ///
    /// Format: export master, source-resolution H.264 capped at 2160p, High
    /// profile, `-bf 0` (PTS=DTS), short fixed GOP, the colour tags asserted
    /// with `+write_colr` so mediabunny reads a `colr` atom. See ADR 0011,
    /// 0014 and docs/preview.md §Proxies. Rgb 8: the conversion to
    /// `RGB_PROXY_COLOR` with tags to match.
    pub const fn full_version(self) -> u32 {
        match self {
            Self::Ycbcr => 7,
            Self::Rgb => 8,
        }
    }

    /// The quick proxy's version, bumped by the same rule. Recipe: 720p cap,
    /// short scrub GOP (docs/preview.md §Proxies), colour tags and `colr` as
    /// for the full proxy. Rgb 5: the conversion to `RGB_PROXY_COLOR`.
    pub const fn quick_version(self) -> u32 {
        match self {
            Self::Ycbcr => 4,
            Self::Rgb => 5,
        }
    }
}

impl MediaItem {
    pub fn proxy_recipe(&self) -> ProxyRecipe {
        if self
            .metadata
            .video
            .as_ref()
            .is_some_and(VideoStreamMeta::is_rgb)
        {
            ProxyRecipe::Rgb
        } else {
            ProxyRecipe::Ycbcr
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioStreamMeta {
    pub sample_rate: u32,
    pub channels: u8,
    pub codec: String,
    /// Container PTS for this stream's first content sample, if ffprobe reports
    /// it. Conformed audio is already written in normalized time today; this is
    /// persisted for diagnostics and future direct-audio decode paths.
    #[serde(default)]
    pub start_pts_us: Option<TimeUs>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_item_round_trips_decode_route() {
        let json = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "label": null, "path_abs": "clip.mp4", "path_rel": null, "kind": "Video",
            "metadata": { "duration_us": null, "video": null, "audio": null },
            "decode_route": { "route": "direct-export", "quick_proxy": null },
            "waveform_path": null, "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": "abc", "file_size": 1, "file_mtime": 0,
            "imported_at": "2026-05-29T00:00:00Z"
        });
        let item: MediaItem = serde_json::from_value(json).unwrap();
        assert_eq!(
            item.decode_route,
            DecodeRoute::DirectExport { quick_proxy: None }
        );
    }
}
