//! Disposable straight-alpha RGBA8 frame cache (ADR 0078). Each frame is
//! independent: seeks never decode preceding frames. A read checks the frame
//! through zstd's content checksum and may downscale it (ADR 0154).
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Moves with any layout or codec change, together with the cache key namespace
/// (`motifFrameCacheKey`), so older files are collected instead of read.
const MAGIC: &[u8; 8] = b"WCMFRM02";
/// Magic, then width and height (little-endian u32), then one zstd frame.
const HEADER: usize = 16;
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
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

/// zstd level 1 with its content checksum, the frame's only content check: it
/// is taken over the pixels as captured and verified over the pixels a read
/// restores, so it covers the file and the decompression alike.
pub(crate) fn encode(w: u32, h: u32, rgba: &[u8]) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(rgba.len() == byte_len(w, h)?, "invalid motif pixel length");
    let mut zstd = zstd::bulk::Compressor::new(1)?;
    zstd.set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))?;
    let payload = zstd.compress(rgba)?;
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Dimensions, pixel byte length and zstd payload. zstd verifies the checksum
/// while it decompresses. A frame without one is rejected: nothing else would
/// notice its pixels changing.
fn parse(bytes: &[u8]) -> anyhow::Result<(u32, u32, usize, &[u8])> {
    anyhow::ensure!(
        bytes.len() > HEADER + 4 && &bytes[..8] == MAGIC,
        "invalid motif frame header"
    );
    let number = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let (w, h) = (number(8), number(12));
    let size = byte_len(w, h)?;
    let payload = &bytes[HEADER..];
    // Frame_Header_Descriptor bit 2 is Content_Checksum_flag (RFC 8878 3.1.1.1.1).
    anyhow::ensure!(
        payload[..4] == ZSTD_MAGIC && payload[4] & 0x04 != 0,
        "motif frame has no checksum"
    );
    Ok((w, h, size, payload))
}

fn decode(bytes: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    let (w, h, size, payload) = parse(bytes)?;
    let rgba = zstd::bulk::decompress(payload, size)?;
    anyhow::ensure!(rgba.len() == size, "invalid motif frame length");
    Ok((w, h, rgba))
}

/// Decode state one reader reuses frame after frame. A fresh output buffer per
/// frame costs more than the decompression at 4K: the kernel faults in every page.
pub(crate) struct FrameDecoder {
    zstd: zstd::bulk::Decompressor<'static>,
    rgba: Vec<u8>,
    scaled: Vec<u8>,
}

impl FrameDecoder {
    pub(crate) fn new() -> anyhow::Result<Self> {
        Ok(Self {
            zstd: zstd::bulk::Decompressor::new()?,
            rgba: Vec::new(),
            scaled: Vec::new(),
        })
    }

    fn decode(&mut self, bytes: &[u8]) -> anyhow::Result<(u32, u32)> {
        let (w, h, size, payload) = parse(bytes)?;
        self.rgba.resize(size, 0);
        // Into exactly `size` bytes: a payload that inflates further fails here.
        let written = self
            .zstd
            .decompress_to_buffer(payload, &mut self.rgba[..])?;
        anyhow::ensure!(written == size, "invalid motif frame length");
        Ok((w, h))
    }

    /// [`read_scaled`] into buffers kept for the next read.
    pub(crate) fn read_scaled(
        &mut self,
        path: &str,
        div: u32,
    ) -> anyhow::Result<(u32, u32, &[u8], MotifReadTiming)> {
        let (mut timing, (w, h)) = read_decoded(path, div, |bytes| self.decode(bytes))?;
        let start = std::time::Instant::now();
        let scaled = scale(&self.rgba, w, h, div)?;
        timing.scale_ms = elapsed_ms(start);
        Ok(match scaled {
            None => (w, h, &self.rgba[..], timing),
            Some((sw, sh, pixels)) => {
                self.scaled = pixels;
                (sw, sh, &self.scaled[..], timing)
            }
        })
    }
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
    Ok(scale(&rgba, w, h, div)?.unwrap_or((w, h, rgba)))
}

/// [`downscale`] without taking the input; `None` when `div` is 1.
fn scale(rgba: &[u8], w: u32, h: u32, div: u32) -> anyhow::Result<Option<(u32, u32, Vec<u8>)>> {
    anyhow::ensure!(
        matches!(div, 1 | 2 | 4),
        "invalid motif scale divisor {div}"
    );
    anyhow::ensure!(
        rgba.len() == w as usize * h as usize * 4,
        "invalid motif pixel length"
    );
    if div == 1 {
        return Ok(None);
    }
    let (ow, oh) = (w.div_ceil(div), h.div_ceil(div));
    let (w, h, d, stride) = (w as usize, h as usize, div as usize, w as usize * 4);
    let mut out = vec![0u8; ow as usize * oh as usize * 4];
    for (y, row) in out.chunks_exact_mut(ow as usize * 4).enumerate() {
        let lines = &rgba[y * d * stride..((y + 1) * d).min(h) * stride];
        let covered = lines.len() / stride;
        for (x, px) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let (x0, x1) = (x * d, ((x + 1) * d).min(w));
            let n = ((x1 - x0) * covered) as u32;
            let (mut a, mut r, mut g, mut b) = (0u32, 0u32, 0u32, 0u32);
            for line in lines.chunks_exact(stride) {
                for s in line[x0 * 4..x1 * 4].as_chunks::<4>().0 {
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
    Ok(Some((ow, oh, out)))
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
    /// Decompression, checksum included.
    pub decode_ms: f64,
    pub scale_ms: f64,
}

fn elapsed_ms(start: std::time::Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Read, decompress (verifying) and downscale one frame, timed per stage. An
/// invalid `div` is the caller's error and is rejected before the file is read.
pub(crate) fn read_scaled(
    path: &str,
    div: u32,
) -> anyhow::Result<(u32, u32, Vec<u8>, MotifReadTiming)> {
    let (mut timing, (w, h, rgba)) = read_decoded(path, div, decode)?;
    let start = std::time::Instant::now();
    let (w, h, rgba) = downscale(rgba, w, h, div)?;
    timing.scale_ms = elapsed_ms(start);
    Ok((w, h, rgba, timing))
}

/// The file read and `decode` of [`read_scaled`], timed; scaling is the caller's.
fn read_decoded<T>(
    path: &str,
    div: u32,
    decode: impl FnOnce(&[u8]) -> anyhow::Result<T>,
) -> anyhow::Result<(MotifReadTiming, T)> {
    anyhow::ensure!(
        matches!(div, 1 | 2 | 4),
        "invalid motif scale divisor {div}"
    );
    let mut timing = MotifReadTiming::default();
    let frame = from_file(|| {
        let start = std::time::Instant::now();
        let bytes = read_file(path)?;
        timing.read_ms = elapsed_ms(start);
        let start = std::time::Instant::now();
        let frame = decode(&bytes)?;
        timing.decode_ms = elapsed_ms(start);
        Ok(frame)
    })?;
    Ok((timing, frame))
}

fn read_file(path: &str) -> anyhow::Result<Vec<u8>> {
    let limit = HEADER + zstd::zstd_safe::compress_bound(MAX_BYTES);
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

/// The caller authorizes the path. The read runs on the blocking pool; a
/// `motif-frame: ` error is a miss.
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
pub async fn motif_encode_png(png: Buffer) -> napi::Result<Buffer> {
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
        encode(img.width(), img.height(), &img).map(Buffer::from)
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

use std::io::Read;

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(multiplier: usize) -> Vec<u8> {
        (0..4096).map(|i| ((i * multiplier) % 256) as u8).collect()
    }

    #[test]
    fn preserves_every_alpha_and_rgb_byte_behind_a_checksum() {
        let pixels = pattern(73);
        let bytes = encode(32, 32, &pixels).unwrap();
        assert_eq!(&bytes[HEADER..HEADER + 4], &ZSTD_MAGIC);
        assert_ne!(bytes[HEADER + 4] & 0x04, 0, "content checksum flag");
        assert_eq!(decode(&bytes).unwrap(), (32, 32, pixels));
    }

    #[test]
    fn no_flipped_bit_yields_other_pixels() {
        let pixels = pattern(73);
        let bytes = encode(32, 32, &pixels).unwrap();
        for bit in 0..bytes.len() * 8 {
            let mut corrupt = bytes.clone();
            corrupt[bit / 8] ^= 1 << (bit % 8);
            if let Ok((w, h, rgba)) = decode(&corrupt) {
                assert_eq!((w, h, rgba), (32, 32, pixels.clone()), "bit {bit}");
            }
        }
    }

    #[test]
    fn rejects_a_frame_without_a_checksum_or_in_a_former_format() {
        let pixels = pattern(31);
        let header = &encode(32, 32, &pixels).unwrap()[..HEADER];
        let bare = [header, &zstd::bulk::compress(&pixels, 1).unwrap()].concat();
        assert!(decode(&bare)
            .unwrap_err()
            .to_string()
            .contains("no checksum"));
        let mut former = encode(32, 32, &pixels).unwrap();
        former[..8].copy_from_slice(b"WCMFRM01");
        assert!(decode(&former).is_err());
    }

    #[test]
    fn rejects_a_payload_that_inflates_past_its_dimensions() {
        let header = &encode(2, 2, &[23; 16]).unwrap()[..HEADER];
        let longer = &encode(5, 1, &[23; 20]).unwrap()[HEADER..];
        assert!(decode(&[header, longer].concat()).is_err());
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
        let pixels = pattern(73);
        let mut bytes = encode(32, 32, &pixels).unwrap();
        let path = write_frame(dir.path(), &bytes);
        assert_eq!(read_scaled(&path, 1).unwrap().2, pixels);
        for div in [2, 4] {
            let (w, h, rgba, _) = read_scaled(&path, div).unwrap();
            assert_eq!(
                (w, h, rgba),
                downscale(pixels.clone(), 32, 32, div).unwrap()
            );
        }
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
        let absent = dir.path().join("absent.wfrm");
        let error = read_scaled(&absent.to_string_lossy(), 2).unwrap_err();
        assert!(error.to_string().starts_with(FRAME_ERROR), "{error}");
    }

    #[test]
    fn rejects_corruption_truncation_and_unbounded_dimensions() {
        let bytes = encode(2, 2, &[23; 16]).unwrap();
        for length in 0..bytes.len() {
            assert!(decode(&bytes[..length]).is_err());
        }
        let mut corrupt = bytes;
        corrupt[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&corrupt).is_err());
    }

    #[test]
    fn a_reused_decoder_reads_what_a_fresh_read_reads() {
        let dir = tempfile::tempdir().unwrap();
        let mut decoder = FrameDecoder::new().unwrap();
        let large = pattern(73);
        let small: Vec<u8> = pattern(31)[..256].to_vec();
        // Larger, smaller, larger again: no bytes of an earlier frame survive.
        for (w, h, pixels) in [(32, 32, &large), (8, 8, &small), (32, 32, &large)] {
            let path = write_frame(dir.path(), &encode(w, h, pixels).unwrap());
            for div in [1, 2, 4] {
                let (fw, fh, fresh, _) = read_scaled(&path, div).unwrap();
                let (rw, rh, reused, _) = decoder.read_scaled(&path, div).unwrap();
                assert_eq!((rw, rh, reused), (fw, fh, &fresh[..]), "{w}x{h} div {div}");
            }
        }
    }

    #[test]
    fn a_reused_decoder_rejects_what_a_fresh_read_rejects() {
        let dir = tempfile::tempdir().unwrap();
        let mut decoder = FrameDecoder::new().unwrap();
        let pixels = pattern(73);
        let bytes = encode(32, 32, &pixels).unwrap();
        let path = write_frame(dir.path(), &bytes);
        decoder.read_scaled(&path, 1).unwrap();
        let header = &encode(2, 2, &[23; 16]).unwrap()[..HEADER];
        let longer = &encode(5, 1, &[23; 20]).unwrap()[HEADER..];
        // The last byte belongs to the content checksum.
        let mut corrupt = bytes.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        for bad in [
            [header, longer].concat(),
            corrupt,
            bytes[..bytes.len() - 1].to_vec(),
        ] {
            let path = write_frame(dir.path(), &bad);
            let error = decoder.read_scaled(&path, 1).unwrap_err().to_string();
            assert!(error.starts_with(FRAME_ERROR), "{error}");
        }
    }
}
