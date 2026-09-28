//! Disposable, versioned straight-alpha RGBA8 cache. Each frame is independent:
//! seeks never decode preceding frames. PNG remains the portable fallback.
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
    let payload = if compressed {
        lz4_flex::block::compress(rgba)
    } else {
        rgba.to_vec()
    };
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&(u32::from(compressed)).to_le_bytes());
    out.extend_from_slice(blake3::hash(rgba).as_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

pub(crate) fn decode(bytes: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
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
        _ => anyhow::bail!("unsupported motif frame codec"),
    };
    anyhow::ensure!(rgba.len() == size, "invalid motif frame length");
    anyhow::ensure!(
        blake3::hash(&rgba).as_bytes() == &bytes[20..HEADER],
        "corrupt motif frame"
    );
    Ok((w, h, rgba))
}

#[napi(object)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type; exercised by the Electron conformance harness.
pub struct MotifPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Buffer,
}

pub(crate) fn read_pixels(path: &str) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    let limit = MAX_BYTES + MAX_BYTES / 255 + HEADER + 32;
    let file = std::fs::File::open(path)?;
    anyhow::ensure!(
        file.metadata()?.len() <= limit as u64,
        "motif cache file exceeds budget"
    );
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= limit, "motif cache file exceeds budget");
    decode(&bytes)
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
        for compressed in [false, true] {
            let bytes = encode(32, 32, &pixels, compressed).unwrap();
            assert_eq!(decode(&bytes).unwrap(), (32, 32, pixels.clone()));
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
