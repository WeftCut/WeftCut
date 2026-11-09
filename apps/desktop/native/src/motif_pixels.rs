//! Motif pixel formats on every OS: straightening a capture's premultiplied
//! pixels, premultiplying stored frames for the texture lane, PNGs, and the
//! one conversion export (`motif_convert`). The stored frame format itself
//! lives in `motif_frame.rs`.
use crate::motif_error::to_napi;
use crate::motif_frame::{
    band_rows, band_threads, byte_len, encode, encode_premultiplied, per_thread,
};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// The straight value of premultiplied channel `c` at alpha `a`, at index
/// `a << 8 | c`: `(c * 255 + a / 2) / a`, at most 255, and 0 where `a` is 0.
static STRAIGHT: [u8; 65536] = {
    let mut table = [0u8; 65536];
    let mut a = 1;
    while a < 256 {
        let mut c = 0;
        while c < 256 {
            let v = (c * 255 + a / 2) / a;
            table[a << 8 | c] = if v > 255 { 255 } else { v as u8 };
            c += 1;
        }
        a += 1;
    }
    table
};

/// Premultiplied RGBA (or BGRA) to straight RGBA in place, as the cache stores
/// pixels. Every premultiplied channel value survives a roundtrip.
pub(crate) fn straighten(rgba: &mut [u8], bgra: bool) {
    for px in rgba.as_chunks_mut::<4>().0 {
        if bgra {
            px.swap(0, 2);
        }
        match px[3] {
            255 => {}
            0 => px[..3].fill(0),
            alpha => {
                let row = &STRAIGHT[usize::from(alpha) << 8..][..256];
                for c in &mut px[..3] {
                    *c = row[usize::from(*c)];
                }
            }
        }
    }
}

/// Premultiplies straight `src` rows of `row` bytes into `dst` rows `pitch`
/// bytes apart.
#[cfg_attr(not(windows), allow(dead_code))] // only the texture lane uploads stored frames.
pub(crate) fn premultiply_rows(src: &[u8], dst: &mut [u8], row: usize, pitch: usize) {
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: the CPU supports AVX2.
        return unsafe { premultiply_rows_avx2(src, dst, row, pitch) };
    }
    premultiply_rows_inline(src, dst, row, pitch)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
#[cfg_attr(not(windows), allow(dead_code))]
unsafe fn premultiply_rows_avx2(src: &[u8], dst: &mut [u8], row: usize, pitch: usize) {
    premultiply_rows_inline(src, dst, row, pitch)
}

#[inline(always)]
#[cfg_attr(not(windows), allow(dead_code))]
fn premultiply_rows_inline(src: &[u8], dst: &mut [u8], row: usize, pitch: usize) {
    for (s, d) in src.chunks_exact(row).zip(dst.chunks_mut(pitch)) {
        premultiply_into(s, &mut d[..row]);
    }
}

/// Disk frames have straight alpha; Electron imports premultiplied textures.
/// `round(c * a / 255)` exactly, R and B in one multiply: neither 16-bit lane
/// carries into the next. Branch-free, so it vectorizes whatever the alpha.
#[inline(always)]
#[cfg_attr(not(windows), allow(dead_code))]
fn premultiply_into(src: &[u8], dst: &mut [u8]) {
    for (s, d) in src
        .as_chunks::<4>()
        .0
        .iter()
        .zip(dst.as_chunks_mut::<4>().0)
    {
        let x = u32::from_le_bytes(*s);
        let a = x >> 24;
        let rb = (x & 0x00FF_00FF) * a + 0x0080_0080;
        let rb = ((rb + ((rb >> 8) & 0x00FF_00FF)) >> 8) & 0x00FF_00FF;
        let g = ((x >> 8) & 0xFF) * a + 0x80;
        let g = ((g + (g >> 8)) >> 8) & 0xFF;
        *d = (rb | (g << 8) | (x & 0xFF00_0000)).to_le_bytes();
    }
}

/// Straight RGBA as a PNG, fast compression: these PNGs leave the app as
/// previews and covers, never as stored frames.
#[cfg_attr(not(windows), allow(dead_code))] // only the texture lane reads pixels natively.
pub(crate) fn encode_png(w: u32, h: u32, rgba: Vec<u8>) -> anyhow::Result<Vec<u8>> {
    use image::ImageEncoder;
    anyhow::ensure!(rgba.len() == byte_len(w, h)?, "invalid motif pixel length");
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)?;
    Ok(png)
}

/// What a conversion reads: straight RGBA, or a bitmap host's paint.
#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type.
pub enum MotifPixelSource {
    Rgba,
    PremultipliedBgra,
}

/// What a conversion makes: a stored frame, straight RGBA or a PNG.
#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type.
pub enum MotifPixelTarget {
    Frame,
    Rgba,
    Png,
}

/// A picture of exactly `width × height` pixels in `source`'s format.
pub(crate) struct Pixels {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) source: MotifPixelSource,
    pub(crate) data: Vec<u8>,
}

impl Pixels {
    /// The top `height` rows of `pixels`, rows `width` pixels each: a bitmap
    /// host's paint carries the marker rows below its picture.
    fn top_rows(
        pixels: &[u8],
        width: u32,
        height: u32,
        source: MotifPixelSource,
    ) -> anyhow::Result<Self> {
        let len = byte_len(width, height)?;
        anyhow::ensure!(
            pixels.len() >= len,
            "motif bitmap is smaller than its picture"
        );
        Ok(Self {
            width,
            height,
            source,
            data: pixels[..len].to_vec(),
        })
    }
}

/// Converts on the band threads (ADR 0159): a paint encoded as a stored frame
/// is straightened band by band by the thread that compresses it. Valid pairs
/// are rgba to frame and premultipliedBgra to frame or rgba; any other is the
/// caller's error, untagged.
pub(crate) fn convert(px: Pixels, to: MotifPixelTarget) -> anyhow::Result<Vec<u8>> {
    let Pixels {
        width,
        height,
        source,
        mut data,
    } = px;
    match (source, to) {
        (MotifPixelSource::Rgba, MotifPixelTarget::Frame) => encode(width, height, &data),
        (MotifPixelSource::PremultipliedBgra, MotifPixelTarget::Frame) => {
            encode_premultiplied(width, height, &mut data, true)
        }
        (MotifPixelSource::PremultipliedBgra, MotifPixelTarget::Rgba) => {
            let band = band_rows(height) as usize * width as usize * 4;
            per_thread(data.chunks_mut(band), band_threads(), |pixels| {
                straighten(pixels, true);
                Ok(())
            })?;
            Ok(data)
        }
        (from, to) => anyhow::bail!("motif pixels cannot convert from {from:?} to {to:?}"),
    }
}

/// The top `height` rows of `pixels`, `width` pixels each, converted from
/// `from` to `to` (`convert`) on the blocking pool.
#[napi]
#[cfg_attr(test, allow(dead_code))] // napi registration is absent in a Rust unit-test executable.
pub async fn motif_convert(
    pixels: Buffer,
    width: u32,
    height: u32,
    from: MotifPixelSource,
    to: MotifPixelTarget,
) -> napi::Result<Buffer> {
    let px = Pixels::top_rows(&pixels, width, height, from).map_err(to_napi)?;
    tokio::task::spawn_blocking(move || convert(px, to).map(Buffer::from))
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))?
        .map_err(to_napi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_png_keeps_every_straight_rgba_byte() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 37 % 256) as u8).collect();
        let png = encode_png(3, 2, rgba.clone()).unwrap();
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .into_rgba8();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
        assert_eq!(decoded.into_raw(), rgba);
    }

    #[test]
    fn the_straight_table_is_the_rounded_quotient_for_every_channel_and_alpha() {
        for alpha in 0..=255u32 {
            for channel in 0..=255u32 {
                let mut pixel = [channel as u8, channel as u8, channel as u8, alpha as u8];
                straighten(&mut pixel, false);
                let want = (channel * 255 + alpha / 2)
                    .checked_div(alpha)
                    .unwrap_or(0)
                    .min(255) as u8;
                assert_eq!(
                    pixel,
                    [want, want, want, alpha as u8],
                    "c={channel} a={alpha}"
                );
            }
        }
    }

    #[test]
    fn every_valid_premultiplied_channel_roundtrips_exactly() {
        for alpha in 0..=255u32 {
            for channel in 0..=alpha {
                let mut pixel = [channel as u8, 0, 0, alpha as u8];
                straighten(&mut pixel, false);
                assert_eq!((u32::from(pixel[0]) * alpha + 127) / 255, channel);
                assert_eq!(pixel[3], alpha as u8);
            }
        }
    }

    #[test]
    fn bgra_is_reordered_and_transparent_rgb_is_cleared() {
        let mut pixels = [16, 32, 64, 128, 20, 30, 40, 0];
        straighten(&mut pixels, true);
        assert_eq!(pixels, [128, 64, 32, 128, 0, 0, 0, 0]);
    }

    #[test]
    fn premultiplication_rounds_every_alpha_and_channel_to_nearest() {
        let mut pixels = Vec::new();
        for alpha in 0..=255u8 {
            for channel in 0..=255u8 {
                pixels.extend_from_slice(&[channel, 255 - channel, channel ^ 127, alpha]);
            }
        }
        let mut expected = pixels.clone();
        for px in expected.as_chunks_mut::<4>().0 {
            let alpha = u32::from(px[3]);
            for c in &mut px[..3] {
                *c = ((u32::from(*c) * alpha + 127) / 255) as u8;
            }
        }
        // Scalar and dispatched (AVX2 where present) alike.
        let row = 256 * 4;
        for premultiply in [premultiply_rows, premultiply_rows_inline] {
            let mut out = vec![0; pixels.len()];
            premultiply(&pixels, &mut out, row, row);
            assert_eq!(out, expected);
        }
    }

    #[test]
    fn premultiplication_writes_rows_at_the_pitch_and_leaves_the_padding() {
        let src = [[10, 20, 30, 128], [200, 100, 50, 255]].concat();
        let mut dst = [7u8; 12];
        premultiply_rows(&src, &mut dst, 4, 8);
        assert_eq!(dst, [5, 10, 15, 128, 7, 7, 7, 7, 200, 100, 50, 255]);
    }

    fn picture(source: MotifPixelSource, data: &[u8], width: u32, height: u32) -> Pixels {
        Pixels::top_rows(data, width, height, source).unwrap()
    }

    /// `w`×`h` texels of noise, every fifth one fully transparent with colour.
    fn noise(w: u32, h: u32, seed: u32) -> Vec<u8> {
        let mut state = seed.wrapping_mul(2654435761) | 1;
        (0..w * h)
            .flat_map(|i| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let [r, g, b, a] = state.to_le_bytes();
                [r, g, b, if i % 5 == 0 { 0 } else { a }]
            })
            .collect()
    }

    #[test]
    fn each_valid_pair_converts_as_its_steps_do() {
        let (w, h) = (16, 21);
        let paint = noise(w, h, 3);
        let mut straight = paint.clone();
        straighten(&mut straight, true);
        let rgba = |data: &[u8]| picture(MotifPixelSource::Rgba, data, w, h);
        let bgra = |data: &[u8]| picture(MotifPixelSource::PremultipliedBgra, data, w, h);
        assert_eq!(
            convert(bgra(&paint), MotifPixelTarget::Rgba).unwrap(),
            straight
        );
        assert_eq!(
            convert(bgra(&paint), MotifPixelTarget::Frame).unwrap(),
            encode(w, h, &straight).unwrap()
        );
        assert_eq!(
            convert(rgba(&straight), MotifPixelTarget::Frame).unwrap(),
            encode(w, h, &straight).unwrap()
        );
    }

    #[test]
    fn only_the_top_rows_are_the_picture() {
        let (w, h) = (4, 3);
        let mut paint = noise(w, h + 1, 5);
        let marker = paint.split_off((w * h * 4) as usize);
        let mut with_marker = paint.clone();
        with_marker.extend_from_slice(&marker);
        for source in [MotifPixelSource::Rgba, MotifPixelSource::PremultipliedBgra] {
            assert_eq!(picture(source, &with_marker, w, h).data, paint);
            let short = Pixels::top_rows(&paint[..paint.len() - 1], w, h, source);
            assert!(short.is_err());
        }
    }

    #[test]
    fn any_other_pair_is_the_callers_error_untagged() {
        let px = |source| picture(source, &[0; 16], 2, 2);
        for (source, to) in [
            (MotifPixelSource::Rgba, MotifPixelTarget::Rgba),
            (MotifPixelSource::Rgba, MotifPixelTarget::Png),
            (MotifPixelSource::PremultipliedBgra, MotifPixelTarget::Png),
        ] {
            let error = convert(px(source), to).unwrap_err();
            assert_eq!(
                crate::motif_error::code_of(&error),
                None,
                "{source:?} to {to:?}"
            );
        }
        let oversized = Pixels::top_rows(&[0; 16], 8193, 1, MotifPixelSource::Rgba);
        assert_eq!(crate::motif_error::code_of(&oversized.err().unwrap()), None);
    }
}
