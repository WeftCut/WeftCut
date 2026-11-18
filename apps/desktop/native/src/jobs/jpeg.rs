//! The scale filter every JPEG derivative is made with: thumbnails, filmstrip
//! tiles and the MCP frame image.

use crate::state::VideoStreamMeta;

/// `scale` (an ffmpeg `scale=...` filter) extended to hand the JPEG encoder
/// BT.601 full-range YCbCr, converted from the source's own matrix.
///
/// A JPEG carries no colour description and every viewer decodes it as BT.601
/// full range. Left alone, ffmpeg expands the range but keeps the source's
/// matrix, so a BT.709 picture's pure red showed as about (229, 0, 0).
///
/// `original` is the ORIGINAL's video stream even when the frame is read from
/// a proxy: a YCbCr source's proxy keeps its matrix and declares only what the
/// source declared, and an RGB-coded source's proxy declares the matrix it was
/// converted into (`proxy::color_args`). For a source that declares none,
/// ffmpeg would assume BT.601 at every size, so the rule's matrix is given
/// explicitly.
pub fn scale_filter(scale: &str, original: Option<&VideoStreamMeta>) -> String {
    let input = original
        .and_then(VideoStreamMeta::undeclared_matrix)
        .unwrap_or("auto");
    format!("{scale}:in_color_matrix={input}:out_color_matrix=bt601:out_range=pc")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(width: u32, height: u32, pix_fmt: &str, matrix: Option<&str>) -> VideoStreamMeta {
        VideoStreamMeta {
            width,
            height,
            fps_num: 30,
            fps_den: 1,
            codec: "h264".into(),
            pix_fmt: pix_fmt.into(),
            start_pts_us: None,
            nb_frames: None,
            color_matrix: matrix.map(str::to_string),
            color_range: None,
            color_primaries: None,
            color_transfer: None,
        }
    }

    #[test]
    fn a_declared_matrix_is_left_for_ffmpeg_to_read_off_the_frame() {
        let v = video(1920, 1080, "yuv420p", Some("smpte170m"));
        assert_eq!(
            scale_filter("scale=320:-2", Some(&v)),
            "scale=320:-2:in_color_matrix=auto:out_color_matrix=bt601:out_range=pc"
        );
    }

    #[test]
    fn an_undeclared_matrix_is_the_rules_not_ffmpegs_bt601() {
        let hd = video(1280, 544, "yuv420p", None);
        assert!(scale_filter("scale=320:-2", Some(&hd)).contains("in_color_matrix=bt709"));
        let sd = video(720, 480, "yuv420p", None);
        assert!(scale_filter("scale=320:-2", Some(&sd)).contains("in_color_matrix=smpte170m"));
    }

    #[test]
    fn an_rgb_picture_has_no_matrix_to_assume() {
        for fmt in ["rgb24", "bgra", "gbrp", "pal8", "x2rgb10le"] {
            let v = video(1920, 1080, fmt, None);
            assert!(
                scale_filter("scale=320:-2", Some(&v)).contains("in_color_matrix=auto"),
                "{fmt}"
            );
        }
        assert!(scale_filter("scale=320:-2", None).contains("in_color_matrix=auto"));
    }

    fn ffmpeg(args: &[&std::ffi::OsStr]) -> Option<Vec<u8>> {
        let out = std::process::Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(args)
            .output()
            .ok()?;
        assert!(
            out.status.success(),
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        Some(out.stdout)
    }

    /// Pure red, encoded with the BT.709 matrix at a cropped HD size, once
    /// declaring its matrix and once declaring nothing. Each JPEG is read back
    /// the way a viewer reads one: BT.601, full range.
    #[test]
    fn bt709_red_is_red_in_the_jpeg_whether_the_source_declares_its_matrix_or_not() {
        use std::ffi::OsStr;
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            eprintln!("ffmpeg not on PATH — skipping the JPEG colour check");
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let declared = tmp.path().join("declared.mp4");
        let undeclared = tmp.path().join("undeclared.mp4");
        ffmpeg(&[
            "-f".as_ref(),
            "lavfi".as_ref(),
            "-i".as_ref(),
            "color=c=red:s=1280x544:r=30:d=0.2".as_ref(),
            "-vf".as_ref(),
            "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p".as_ref(),
            "-colorspace".as_ref(),
            "bt709".as_ref(),
            "-c:v".as_ref(),
            "libx264".as_ref(),
            "-preset".as_ref(),
            "ultrafast".as_ref(),
            declared.as_os_str(),
        ]);
        // 2 = unspecified: the same pictures with no colour description.
        ffmpeg(&[
            "-i".as_ref(),
            declared.as_os_str(),
            "-c".as_ref(),
            "copy".as_ref(),
            "-bsf:v".as_ref(),
            "h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2"
                .as_ref(),
            undeclared.as_os_str(),
        ]);
        for (src, matrix) in [(&declared, Some("bt709")), (&undeclared, None)] {
            let jpg = tmp.path().join("frame.jpg");
            let filter = scale_filter("scale=320:-2", Some(&video(1280, 544, "yuv420p", matrix)));
            ffmpeg(&[
                "-i".as_ref(),
                src.as_os_str(),
                "-frames:v".as_ref(),
                "1".as_ref(),
                "-vf".as_ref(),
                OsStr::new(&filter),
                "-q:v".as_ref(),
                "3".as_ref(),
                "-update".as_ref(),
                "1".as_ref(),
                "-f".as_ref(),
                "image2".as_ref(),
                jpg.as_os_str(),
            ]);
            let rgb = ffmpeg(&[
                "-i".as_ref(),
                jpg.as_os_str(),
                "-vf".as_ref(),
                "scale=in_color_matrix=bt601:in_range=pc,format=rgb24,crop=1:1".as_ref(),
                "-f".as_ref(),
                "rawvideo".as_ref(),
                "-".as_ref(),
            ])
            .unwrap();
            // Unconverted, the red channel reads about 229.
            assert!(
                rgb[0] >= 242 && rgb[1] <= 8 && rgb[2] <= 8,
                "declared matrix {matrix:?}: red read back as {rgb:?}"
            );
        }
    }

    /// The renderer's rules and these must not drift: both read the same
    /// cases (`ffprobeColorSpace.test.ts` is the other reader).
    #[test]
    fn the_size_and_rgb_rules_match_the_golden_the_renderer_reads() {
        #[derive(serde::Deserialize)]
        struct Case {
            width: u32,
            height: u32,
            hd: bool,
        }
        #[derive(serde::Deserialize)]
        struct PixFmt {
            pix_fmt: String,
            rgb: bool,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Golden {
            cases: Vec<Case>,
            pix_fmts: Vec<PixFmt>,
        }
        let golden: Golden = serde_json::from_str(include_str!(
            "../../../src/renderer/render/decoder/undeclaredColourGolden.fixture.json"
        ))
        .unwrap();
        assert!(!golden.cases.is_empty());
        for c in golden.cases {
            assert_eq!(
                VideoStreamMeta::undeclared_is_hd(c.width, c.height),
                c.hd,
                "{}x{}",
                c.width,
                c.height
            );
        }
        assert!(
            VideoStreamMeta::undeclared_is_hd(0, 0),
            "an unknown size reads as HD"
        );
        assert!(!golden.pix_fmts.is_empty());
        for c in golden.pix_fmts {
            assert_eq!(
                VideoStreamMeta::is_rgb_pix_fmt(&c.pix_fmt),
                c.rgb,
                "{}",
                c.pix_fmt
            );
        }
    }
}
