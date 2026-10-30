//! Disposable, versioned straight-alpha RGBA8 cache. Each frame is independent:
//! seeks never decode preceding frames. PNG remains the portable fallback.
//! Codec 0 is raw, 1 is LZ4 (read only), 2 is zstd level 1 (ADR 0145).
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

pub(crate) fn decode(bytes: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    let (w, h, rgba) = unpack(bytes)?;
    verify(bytes, &rgba)?;
    Ok((w, h, rgba))
}

/// Header + decompression. Stage split exists for the #62 transport bench.
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

/// Alpha-weighted box downscale of straight RGBA by an integer divisor: a fully
/// transparent texel carries no colour. Rounds half up, like the bench's JS
/// reference (`downscale.mjs`), so both produce identical bytes.
pub(crate) fn downscale(
    rgba: &[u8],
    w: u32,
    h: u32,
    div: u32,
) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    anyhow::ensure!((1..=8).contains(&div), "invalid motif scale divisor");
    anyhow::ensure!(
        w % div == 0 && h % div == 0,
        "motif size is not divisible by the scale divisor"
    );
    let (ow, oh, d) = (w / div, h / div, div as usize);
    let (stride, n) = (w as usize * 4, div * div);
    let mut out = vec![0u8; ow as usize * oh as usize * 4];
    for (y, row) in out.chunks_exact_mut(ow as usize * 4).enumerate() {
        let block = &rgba[y * d * stride..(y + 1) * d * stride];
        for (x, px) in row.chunks_exact_mut(4).enumerate() {
            let (mut a, mut r, mut g, mut b) = (0u32, 0u32, 0u32, 0u32);
            for line in block.chunks_exact(stride) {
                for s in line[x * d * 4..(x + 1) * d * 4].chunks_exact(4) {
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

/// Stage times of one read, in milliseconds (#62 transport bench).
#[napi(object)]
#[derive(Clone, Copy, Default)]
pub struct MotifReadTiming {
    pub read_ms: f64,
    pub decode_ms: f64,
    pub hash_ms: f64,
    pub scale_ms: f64,
}

fn elapsed_ms(start: std::time::Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// `read_pixels` followed by `downscale`, timed per stage.
pub(crate) fn read_scaled(
    path: &str,
    div: u32,
) -> anyhow::Result<(u32, u32, Vec<u8>, MotifReadTiming)> {
    let mut timing = MotifReadTiming::default();
    let start = std::time::Instant::now();
    let bytes = read_file(path)?;
    timing.read_ms = elapsed_ms(start);
    let start = std::time::Instant::now();
    let (w, h, rgba) = unpack(&bytes)?;
    timing.decode_ms = elapsed_ms(start);
    let start = std::time::Instant::now();
    verify(&bytes, &rgba)?;
    timing.hash_ms = elapsed_ms(start);
    if div == 1 {
        return Ok((w, h, rgba, timing));
    }
    let start = std::time::Instant::now();
    let (w, h, rgba) = downscale(&rgba, w, h, div)?;
    timing.scale_ms = elapsed_ms(start);
    Ok((w, h, rgba, timing))
}

#[napi(object)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type; exercised by the Electron conformance harness.
pub struct MotifPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Buffer,
}

pub(crate) fn read_pixels(path: &str) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    decode(&read_file(path)?)
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

/// The caller authorizes the path. File IO and decompression stay off main's JS thread.
#[napi]
#[cfg_attr(test, allow(dead_code))] // napi registration is absent in a Rust unit-test executable.
pub async fn motif_read_frame(path: String) -> napi::Result<MotifPixels> {
    tokio::task::spawn_blocking(move || {
        let (width, height, rgba) = read_pixels(&path)?;
        Ok::<_, anyhow::Error>(MotifPixels {
            width,
            height,
            rgba: rgba.into(),
        })
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(object)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type; exercised by the #62 transport bench.
pub struct MotifScaledPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Buffer,
    pub timing: MotifReadTiming,
}

/// Read, verify and downscale on the blocking pool (#62 transport bench).
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
        let block = [
            255, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 128, 0, 255, 0, 255,
        ];
        let (w, h, out) = downscale(&block, 2, 2, 2).unwrap();
        assert_eq!((w, h), (1, 1));
        // r = 255·255 / 638, g = 255·255 / 638, b = 255·128 / 638, a = 638 / 4.
        assert_eq!(out, [102, 102, 51, 160]);
        assert_eq!(
            downscale(&[9, 9, 9, 0].repeat(16), 4, 4, 4).unwrap().2,
            [0, 0, 0, 0]
        );
        assert!(downscale(&block, 2, 2, 3).is_err());
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
