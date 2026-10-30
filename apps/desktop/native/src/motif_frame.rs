//! Disposable, versioned straight-alpha RGBA8 cache. Each frame is independent:
//! seeks never decode preceding frames. PNG remains the portable fallback.
//! Codec 0 is raw, 1 is LZ4 (read only), 2 is zstd level 1 (ADR 0145).
//! A read verifies BLAKE3 over the pixels and may downscale them (ADR 0154).
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

const MAGIC: &[u8; 8] = b"WCMFRM01";
const HEADER: usize = 52;
const MAX_BYTES: usize = 256 * 1024 * 1024;

fn byte_len(w: u32, h: u32) -> anyhow::Result<usize> {
    anyhow::ensure!(
        w > 0 && h > 0 && w <= 8192 && h <= 8192,
        "invalid motif dimensions"
    );
    let n = w as usize * h as usize * 4;
    anyhow::ensure!(n <= MAX_BYTES, "motif frame exceeds budget");
    Ok(n)
}

pub(crate) fn encode(w: u32, h: u32, rgba: &[u8], compressed: bool) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(rgba.len() == byte_len(w, h)?, "invalid motif pixel length");
    let (codec, payload) = if compressed {
        (2u32, zstd::bulk::compress(rgba, 1)?)
    } else {
        (0, rgba.to_vec())
    };
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&codec.to_le_bytes());
    out.extend_from_slice(blake3::hash(rgba).as_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

#[cfg(test)]
fn decode(bytes: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    let (w, h, rgba) = unpack(bytes)?;
    verify(bytes, &rgba)?;
    Ok((w, h, rgba))
}

/// Header and decompression; `verify` checks the result.
fn unpack(bytes: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    anyhow::ensure!(
        bytes.len() >= HEADER && &bytes[..8] == MAGIC,
        "invalid motif frame header"
    );
    let number = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let (w, h) = (number(8), number(12));
    let size = byte_len(w, h)?;
    let rgba = match number(16) {
        0 => bytes[HEADER..].to_vec(),
        1 => lz4_flex::block::decompress(&bytes[HEADER..], size)?,
        2 => zstd::bulk::decompress(&bytes[HEADER..], size)?,
        _ => anyhow::bail!("unsupported motif frame codec"),
    };
    anyhow::ensure!(rgba.len() == size, "invalid motif frame length");
    Ok((w, h, rgba))
}

fn verify(bytes: &[u8], rgba: &[u8]) -> anyhow::Result<()> {
    anyhow::ensure!(
        blake3::hash(rgba).as_bytes() == &bytes[20..HEADER],
        "corrupt motif frame"
    );
    Ok(())
}

/// Alpha-weighted box downscale of straight RGBA by 1, 2 or 4 (ADR 0154): a
/// fully transparent texel carries no colour. The output is `ceil(w / div)` ×
/// `ceil(h / div)`; a partial edge block averages only the texels it covers.
/// Rounds half up, so every lane produces the same bytes
/// (`tests/fixtures/motif-downscale-vectors.json`). `div` 1 returns `rgba` as is.
pub(crate) fn downscale(
    rgba: Vec<u8>,
    w: u32,
    h: u32,
    div: u32,
) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    anyhow::ensure!(
        matches!(div, 1 | 2 | 4),
        "invalid motif scale divisor {div}"
    );
    anyhow::ensure!(
        rgba.len() == w as usize * h as usize * 4,
        "invalid motif pixel length"
    );
    if div == 1 {
        return Ok((w, h, rgba));
    }
    let (ow, oh) = (w.div_ceil(div), h.div_ceil(div));
    let (w, h, d, stride) = (w as usize, h as usize, div as usize, w as usize * 4);
    let mut out = vec![0u8; ow as usize * oh as usize * 4];
    for (y, row) in out.chunks_exact_mut(ow as usize * 4).enumerate() {
        let lines = &rgba[y * d * stride..((y + 1) * d).min(h) * stride];
        let covered = lines.len() / stride;
        for (x, px) in row.chunks_exact_mut(4).enumerate() {
            let (x0, x1) = (x * d, ((x + 1) * d).min(w));
            let n = ((x1 - x0) * covered) as u32;
            let (mut a, mut r, mut g, mut b) = (0u32, 0u32, 0u32, 0u32);
            for line in lines.chunks_exact(stride) {
                for s in line[x0 * 4..x1 * 4].chunks_exact(4) {
                    let alpha = u32::from(s[3]);
                    a += alpha;
                    r += u32::from(s[0]) * alpha;
                    g += u32::from(s[1]) * alpha;
                    b += u32::from(s[2]) * alpha;
                }
            }
            if a != 0 {
                px[0] = ((2 * r + a) / (2 * a)) as u8;
                px[1] = ((2 * g + a) / (2 * a)) as u8;
                px[2] = ((2 * b + a) / (2 * a)) as u8;
            }
            px[3] = ((2 * a + n) / (2 * n)) as u8;
        }
    }
    Ok((ow, oh, out))
}

/// Every failure that comes from the file itself starts with this prefix: the
/// caller treats it as a miss (absent or invalid frame), not a transport failure.
pub(crate) const FRAME_ERROR: &str = "motif-frame: ";

fn from_file<T>(read: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    read().map_err(|e| anyhow::anyhow!("{FRAME_ERROR}{e:#}"))
}

/// Stage times of one read, in milliseconds.
#[napi(object)]
#[derive(Clone, Copy, Debug, Default)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type; read by `perf.motifs`.
pub struct MotifReadTiming {
    pub read_ms: f64,
    pub decode_ms: f64,
    pub hash_ms: f64,
    pub scale_ms: f64,
}

fn elapsed_ms(start: std::time::Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Read, decompress, verify and downscale one frame, timed per stage. An
/// invalid `div` is the caller's error and is rejected before the file is read.
pub(crate) fn read_scaled(
    path: &str,
    div: u32,
) -> anyhow::Result<(u32, u32, Vec<u8>, MotifReadTiming)> {
    anyhow::ensure!(
        matches!(div, 1 | 2 | 4),
        "invalid motif scale divisor {div}"
    );
    let mut timing = MotifReadTiming::default();
    let (w, h, rgba) = from_file(|| {
        let start = std::time::Instant::now();
        let bytes = read_file(path)?;
        timing.read_ms = elapsed_ms(start);
        let start = std::time::Instant::now();
        let (w, h, rgba) = unpack(&bytes)?;
        timing.decode_ms = elapsed_ms(start);
        let start = std::time::Instant::now();
        verify(&bytes, &rgba)?;
        timing.hash_ms = elapsed_ms(start);
        Ok((w, h, rgba))
    })?;
    let start = std::time::Instant::now();
    let (w, h, rgba) = downscale(rgba, w, h, div)?;
    timing.scale_ms = elapsed_ms(start);
    Ok((w, h, rgba, timing))
}

fn read_file(path: &str) -> anyhow::Result<Vec<u8>> {
    // Bounds both LZ4 and zstd's worst case (zstd's is MAX_BYTES / 256 + framing).
    let limit = MAX_BYTES + MAX_BYTES / 255 + HEADER + 32;
    let file = std::fs::File::open(path)?;
    anyhow::ensure!(
        file.metadata()?.len() <= limit as u64,
        "motif cache file exceeds budget"
    );
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= limit, "motif cache file exceeds budget");
    Ok(bytes)
}

#[napi(object)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type; exercised by the Electron conformance harness.
pub struct MotifScaledPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Buffer,
    pub timing: MotifReadTiming,
}

/// The caller authorizes the path. Read, verify and downscale run on the
/// blocking pool; a `motif-frame: ` error is a miss.
#[napi]
#[cfg_attr(test, allow(dead_code))] // napi registration is absent in a Rust unit-test executable.
pub async fn motif_read_frame_scaled(path: String, div: u32) -> napi::Result<MotifScaledPixels> {
    tokio::task::spawn_blocking(move || {
        let (width, height, rgba, timing) = read_scaled(&path, div)?;
        Ok::<_, anyhow::Error>(MotifScaledPixels {
            width,
            height,
            rgba: rgba.into(),
            timing,
        })
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
#[cfg_attr(test, allow(dead_code))] // napi registration is absent in a Rust unit-test executable.
pub async fn motif_encode_png(png: Buffer, compressed: bool) -> napi::Result<Buffer> {
    let png = png.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut reader =
            image::ImageReader::with_format(std::io::Cursor::new(png), image::ImageFormat::Png);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(MAX_BYTES as u64);
        reader.limits(limits);
        let img = reader.decode()?.into_rgba8();
        encode(img.width(), img.height(), &img, compressed).map(Buffer::from)
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

use std::io::Read;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_codecs_preserve_every_alpha_and_rgb_byte() {
        let pixels: Vec<u8> = (0..4096).map(|i| ((i * 73) % 256) as u8).collect();
        for (compressed, codec) in [(false, 0), (true, 2)] {
            let bytes = encode(32, 32, &pixels, compressed).unwrap();
            assert_eq!(bytes[16..20], u32::to_le_bytes(codec));
            assert_eq!(decode(&bytes).unwrap(), (32, 32, pixels.clone()));
        }
    }

    #[test]
    fn reads_frames_written_by_the_former_lz4_codec() {
        let pixels: Vec<u8> = (0..4096).map(|i| ((i * 31) % 256) as u8).collect();
        let mut bytes = encode(32, 32, &pixels, false).unwrap();
        bytes.truncate(HEADER);
        bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&lz4_flex::block::compress(&pixels));
        assert_eq!(decode(&bytes).unwrap(), (32, 32, pixels));
    }

    #[test]
    fn rejects_a_payload_that_inflates_past_its_dimensions() {
        let mut bytes = encode(2, 2, &[23; 16], true).unwrap();
        bytes.truncate(HEADER);
        bytes.extend_from_slice(&zstd::bulk::compress(&[23; 20], 1).unwrap());
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn downscale_weights_colour_by_alpha_and_rounds_half_up() {
        // One 2×2 block: opaque red, transparent white, half-alpha blue, opaque green.
        let block = vec![
            255, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 128, 0, 255, 0, 255,
        ];
        // r = 255·255 / 638, g = 255·255 / 638, b = 255·128 / 638, a = 638 / 4.
        assert_eq!(
            downscale(block, 2, 2, 2).unwrap(),
            (1, 1, vec![102, 102, 51, 160])
        );
        assert_eq!(
            downscale([9, 9, 9, 0].repeat(16), 4, 4, 4).unwrap(),
            (1, 1, vec![0, 0, 0, 0])
        );
    }

    #[test]
    fn partial_edge_blocks_average_only_the_texels_they_cover() {
        // 3×3 opaque greys at div 2: blocks of 4, 2, 2 and 1 texels.
        let image: Vec<u8> = [10, 20, 31, 40, 50, 60, 70, 81, 90]
            .iter()
            .flat_map(|&v| [v, v, v, 255])
            .collect();
        let grey = |v: u8| [v, v, v, 255];
        assert_eq!(
            downscale(image, 3, 3, 2).unwrap(),
            (2, 2, [grey(30), grey(46), grey(76), grey(90)].concat())
        );
        // 5×3 at div 4: the right block covers one column of three texels, so
        // its alpha is (10 + 20 + 31) / 3, not / 16.
        let image: Vec<u8> = (0..15)
            .flat_map(|i| match (i % 5, i / 5) {
                (4, y) => [200, 200, 200, [10, 20, 31][y]],
                _ => [9, 9, 9, 0],
            })
            .collect();
        assert_eq!(
            downscale(image, 5, 3, 4).unwrap(),
            (2, 1, vec![0, 0, 0, 0, 200, 200, 200, 20])
        );
    }

    #[test]
    fn downscale_by_one_returns_the_same_buffer() {
        let pixels: Vec<u8> = (0..24).collect();
        let address = pixels.as_ptr();
        let (w, h, out) = downscale(pixels, 3, 2, 1).unwrap();
        assert_eq!((w, h, out.as_ptr()), (3, 2, address));
        assert_eq!(out, (0..24).collect::<Vec<u8>>());
    }

    #[test]
    fn downscale_rejects_other_divisors_and_wrong_lengths() {
        for div in [0, 3, 8] {
            assert!(downscale(vec![0; 64], 4, 4, div).is_err());
            assert!(read_scaled("absent.wfrm", div)
                .unwrap_err()
                .to_string()
                .starts_with("invalid motif scale divisor"));
        }
        assert!(downscale(vec![0; 60], 4, 4, 2).is_err());
    }

    #[test]
    fn downscale_matches_the_shared_reference_vectors() {
        #[derive(serde::Deserialize)]
        struct Expected {
            width: u32,
            height: u32,
            rgba: Vec<u8>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            width: u32,
            height: u32,
            div: u32,
            rgba: Vec<u8>,
            expected: Expected,
        }
        #[derive(serde::Deserialize)]
        struct Vectors {
            cases: Vec<Case>,
        }
        let vectors: Vectors = serde_json::from_str(include_str!(
            "../tests/fixtures/motif-downscale-vectors.json"
        ))
        .unwrap();
        assert!(vectors.cases.iter().any(|c| c.div == 2));
        assert!(vectors.cases.iter().any(|c| c.div == 4));
        for case in vectors.cases {
            let got = downscale(case.rgba, case.width, case.height, case.div).unwrap();
            let want = (
                case.expected.width,
                case.expected.height,
                case.expected.rgba,
            );
            assert_eq!(got, want, "{}", case.name);
        }
    }

    fn write_frame(dir: &std::path::Path, bytes: &[u8]) -> String {
        let path = dir.join("0.wfrm");
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn file_failures_are_rejected_before_scaling_with_the_frame_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let pixels: Vec<u8> = (0..4096).map(|i| ((i * 73) % 256) as u8).collect();
        for compressed in [false, true] {
            let mut bytes = encode(32, 32, &pixels, compressed).unwrap();
            let path = write_frame(dir.path(), &bytes);
            assert_eq!(read_scaled(&path, 1).unwrap().2, pixels);
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
            let path = write_frame(dir.path(), &bytes);
            for div in [1, 2, 4] {
                let error = read_scaled(&path, div).unwrap_err().to_string();
                assert!(error.starts_with(FRAME_ERROR), "{error}");
            }
            let path = write_frame(dir.path(), &bytes[..(HEADER + bytes.len()) / 2]);
            assert!(read_scaled(&path, 2)
                .unwrap_err()
                .to_string()
                .starts_with(FRAME_ERROR));
        }
        let absent = dir.path().join("absent.wfrm");
        let error = read_scaled(&absent.to_string_lossy(), 2).unwrap_err();
        assert!(error.to_string().starts_with(FRAME_ERROR), "{error}");
    }

    #[test]
    fn lz4_frames_scale() {
        let dir = tempfile::tempdir().unwrap();
        let pixels: Vec<u8> = (0..4096).map(|i| ((i * 31) % 256) as u8).collect();
        let mut bytes = encode(32, 32, &pixels, false).unwrap();
        bytes.truncate(HEADER);
        bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&lz4_flex::block::compress(&pixels));
        let path = write_frame(dir.path(), &bytes);
        for div in [2, 4] {
            let (w, h, rgba, _) = read_scaled(&path, div).unwrap();
            assert_eq!(
                (w, h, rgba),
                downscale(pixels.clone(), 32, 32, div).unwrap()
            );
        }
    }

    #[test]
    fn rejects_corruption_truncation_and_unbounded_dimensions() {
        let bytes = encode(2, 2, &[23; 16], true).unwrap();
        for length in 0..bytes.len() {
            assert!(decode(&bytes[..length]).is_err());
        }
        let mut corrupt = bytes.clone();
        corrupt[20] ^= 1;
        assert!(decode(&corrupt).is_err());
        corrupt = bytes;
        corrupt[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&corrupt).is_err());
    }
}
