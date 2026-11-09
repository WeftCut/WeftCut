//! Motif pixel conversions on every OS: PNGs and the one conversion export
//! (`motif_convert`), built on the alpha steps (`motif_alpha.rs`) and the
//! stored frame format (`motif_frame.rs`).
use crate::motif_alpha::straighten;
use crate::motif_error::to_napi;
use crate::motif_frame::{band_rows, byte_len, encode, encode_premultiplied};
use crate::motif_runtime::{band_threads, blocking, per_thread};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Straight RGBA as a PNG, fast compression: these PNGs leave the app as
/// previews and covers, never as stored frames.
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

/// What a conversion reads: straight RGBA, a bitmap host's paint, or an
/// RGBA-format texture read back (premultiplied, RGBA order).
#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type.
pub enum MotifPixelSource {
    Rgba,
    PremultipliedBgra,
    PremultipliedRgba,
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
/// are rgba to frame, premultipliedBgra to frame, rgba or png, and
/// premultipliedRgba to frame or png; any other is the caller's error,
/// untagged.
pub(crate) fn convert(px: Pixels, to: MotifPixelTarget) -> anyhow::Result<Vec<u8>> {
    use MotifPixelSource::{PremultipliedBgra, PremultipliedRgba, Rgba};
    let Pixels {
        width,
        height,
        source,
        mut data,
    } = px;
    let bgra = source == PremultipliedBgra;
    match (source, to) {
        (Rgba, MotifPixelTarget::Frame) => encode(width, height, &data),
        (PremultipliedBgra | PremultipliedRgba, MotifPixelTarget::Frame) => {
            encode_premultiplied(width, height, &mut data, bgra)
        }
        (PremultipliedBgra, MotifPixelTarget::Rgba) => {
            straighten_bands(width, height, &mut data, bgra)?;
            Ok(data)
        }
        (PremultipliedBgra | PremultipliedRgba, MotifPixelTarget::Png) => {
            straighten_bands(width, height, &mut data, bgra)?;
            encode_png(width, height, data)
        }
        (from, to) => anyhow::bail!("motif pixels cannot convert from {from:?} to {to:?}"),
    }
}

/// `straighten` on the band threads, one band each.
fn straighten_bands(width: u32, height: u32, data: &mut [u8], bgra: bool) -> anyhow::Result<()> {
    let band = band_rows(height) as usize * width as usize * 4;
    per_thread(data.chunks_mut(band), band_threads(), |pixels| {
        straighten(pixels, bgra);
        Ok(())
    })?;
    Ok(())
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
    blocking(move || convert(px, to).map(Buffer::from)).await
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
        assert_eq!(
            convert(bgra(&paint), MotifPixelTarget::Png).unwrap(),
            encode_png(w, h, straight.clone()).unwrap()
        );
        // The same texels in RGBA order straighten to the same picture.
        let mut paint_rgba = paint.clone();
        for px in paint_rgba.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
        }
        let premultiplied_rgba = picture(MotifPixelSource::PremultipliedRgba, &paint_rgba, w, h);
        assert_eq!(
            convert(premultiplied_rgba, MotifPixelTarget::Frame).unwrap(),
            encode(w, h, &straight).unwrap()
        );
        let premultiplied_rgba = picture(MotifPixelSource::PremultipliedRgba, &paint_rgba, w, h);
        assert_eq!(
            convert(premultiplied_rgba, MotifPixelTarget::Png).unwrap(),
            encode_png(w, h, straight).unwrap()
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
            (MotifPixelSource::PremultipliedRgba, MotifPixelTarget::Rgba),
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
