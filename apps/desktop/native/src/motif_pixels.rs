//! Motif pixel formats on every OS: straightening a capture's premultiplied
//! pixels, premultiplying stored frames for the texture lane, and PNGs. The
//! stored frame format itself lives in `motif_frame.rs`.

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
    anyhow::ensure!(
        rgba.len() == crate::motif_frame::byte_len(w, h)?,
        "invalid motif pixel length"
    );
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)?;
    Ok(png)
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
}
