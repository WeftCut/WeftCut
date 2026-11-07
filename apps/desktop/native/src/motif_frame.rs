//! Disposable straight-alpha RGBA8 frame cache (ADR 0078). Each frame is
//! independent: seeks never decode preceding frames. A read checks the frame
//! through zstd's content checksum and may downscale it (ADR 0154).
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Moves with any layout or codec change, together with the cache key namespace
/// (`motifFrameCacheKey`), so older files are collected instead of read.
const MAGIC: &[u8; 8] = b"WCMFRM03";
/// Magic, then width and height (little-endian u32). The band count and each
/// band's compressed length (u32) follow, then the bands' zstd frames in order.
const HEADER: usize = 16;
/// Rows go into at most this many bands, each its own zstd frame, so bands
/// encode and decode in parallel (ADR 0078). More bands than threads lets the
/// thread count change alone.
const BANDS: u32 = 8;
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

/// An eighth of the rows, rounded up to a multiple of 4 so that a band scales
/// by 2 or 4 without another band's rows. A short frame has fewer bands.
fn band_rows(h: u32) -> u32 {
    h.div_ceil(BANDS).next_multiple_of(4)
}

/// Threads one frame's bands share: one per eight hardware threads, at most
/// two. Three texture lanes decode at once, and more threads per frame made
/// the preview tick late during 4K playback; see
/// `docs/notes/motif-texture-upload-2026-11-07.md`.
fn band_threads() -> usize {
    static THREADS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *THREADS.get_or_init(|| {
        std::thread::available_parallelism().map_or(1, |n| (n.get() / 8).clamp(1, 2))
    })
}

/// Runs `work` on every item across at most `threads` threads; the first
/// failure wins. Results keep the items' order.
fn per_thread<I: Send, T: Send>(
    items: impl Iterator<Item = I>,
    threads: usize,
    work: impl Fn(I) -> anyhow::Result<T> + Sync,
) -> anyhow::Result<Vec<T>> {
    let items: Vec<I> = items.collect();
    let count = items.len();
    let threads = threads.clamp(1, count.max(1));
    let mut groups: Vec<Vec<(usize, I)>> = (0..threads).map(|_| Vec::new()).collect();
    for (i, item) in items.into_iter().enumerate() {
        groups[i % threads].push((i, item));
    }
    std::thread::scope(|s| {
        let work = &work;
        let handles: Vec<_> = groups
            .into_iter()
            .map(|group| {
                s.spawn(move || {
                    group
                        .into_iter()
                        .map(|(i, item)| work(item).map(|t| (i, t)))
                        .collect::<anyhow::Result<Vec<_>>>()
                })
            })
            .collect();
        let mut out: Vec<Option<T>> = (0..count).map(|_| None).collect();
        for handle in handles {
            for (i, t) in handle
                .join()
                .map_err(|_| anyhow::anyhow!("motif band thread panicked"))??
            {
                out[i] = Some(t);
            }
        }
        Ok(out
            .into_iter()
            .map(|t| t.expect("every item ran"))
            .collect())
    })
}

/// Band buffers kept between reads. A fresh buffer faults in every page, which
/// at 4K costs as much as decompressing into it. Idle buffers stay under
/// `limit` bytes in all, however many pools read; a band that does not fit is
/// allocated per read.
struct Scratch {
    kept: std::sync::Mutex<Vec<Vec<u8>>>,
    limit: usize,
}

/// Three texture lanes of two band threads at 4K, a decoded and a scaled
/// band each, fit.
static SCRATCH: Scratch = Scratch::new(32 << 20);

impl Scratch {
    const fn new(limit: usize) -> Self {
        Self {
            kept: std::sync::Mutex::new(Vec::new()),
            limit,
        }
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, Vec<Vec<u8>>> {
        self.kept
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Runs `work` on `len` bytes of the smallest kept buffer that is long
    /// enough, else the longest, grown. The bytes hold whatever an earlier read
    /// left: `work` overwrites every one it hands on.
    fn with<T>(&self, len: usize, work: impl FnOnce(&mut [u8]) -> T) -> T {
        let mut buffer = {
            let mut kept = self.kept();
            let fits = (0..kept.len())
                .filter(|&i| kept[i].len() >= len)
                .min_by_key(|&i| kept[i].len());
            fits.or_else(|| (0..kept.len()).max_by_key(|&i| kept[i].len()))
                .map(|i| kept.swap_remove(i))
                .unwrap_or_default()
        };
        if buffer.len() < len {
            buffer.resize(len, 0);
        }
        let out = work(&mut buffer[..len]);
        let mut kept = self.kept();
        if kept.iter().map(Vec::len).sum::<usize>() + buffer.len() <= self.limit {
            kept.push(buffer);
        }
        out
    }

    fn clear(&self) {
        self.kept().clear();
    }
}

/// Frees the kept band buffers, for when no reader is left.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn release_scratch() {
    SCRATCH.clear();
}

/// zstd level 1 with its content checksum per band, the frame's only content
/// check: it is taken over the pixels as captured and verified over the pixels
/// a read restores, so it covers the file and the decompression alike.
pub(crate) fn encode(w: u32, h: u32, rgba: &[u8]) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(rgba.len() == byte_len(w, h)?, "invalid motif pixel length");
    let band = band_rows(h) as usize * w as usize * 4;
    let payloads = per_thread(rgba.chunks(band), band_threads(), |pixels| {
        let mut zstd = zstd::bulk::Compressor::new(1)?;
        zstd.set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))?;
        Ok(zstd.compress(pixels)?)
    })?;
    let mut out = Vec::with_capacity(
        HEADER + 4 + 4 * payloads.len() + payloads.iter().map(Vec::len).sum::<usize>(),
    );
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&(payloads.len() as u32).to_le_bytes());
    for payload in &payloads {
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    }
    for payload in &payloads {
        out.extend_from_slice(payload);
    }
    Ok(out)
}

/// A verified header: dimensions and one zstd frame per band of `rows` rows.
struct Frame<'a> {
    w: u32,
    h: u32,
    rows: usize,
    bands: Vec<&'a [u8]>,
}

/// zstd verifies each band's checksum while it decompresses. A band without
/// one is rejected: nothing else would notice its pixels changing.
fn parse(bytes: &[u8]) -> anyhow::Result<Frame<'_>> {
    anyhow::ensure!(
        bytes.len() >= HEADER + 4 && &bytes[..8] == MAGIC,
        "invalid motif frame header"
    );
    let number = |offset: usize| -> anyhow::Result<u32> {
        let field = bytes
            .get(offset..offset + 4)
            .ok_or_else(|| anyhow::anyhow!("invalid motif frame header"))?;
        Ok(u32::from_le_bytes(field.try_into().unwrap()))
    };
    let (w, h, count) = (number(8)?, number(12)?, number(HEADER)?);
    byte_len(w, h)?;
    let rows = band_rows(h);
    anyhow::ensure!(count == h.div_ceil(rows), "invalid motif band count");
    let mut payload = HEADER + 4 + 4 * count as usize;
    let mut bands = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let len = number(HEADER + 4 + 4 * i)? as usize;
        let band = bytes
            .get(payload..payload + len)
            .ok_or_else(|| anyhow::anyhow!("invalid motif frame length"))?;
        // Frame_Header_Descriptor bit 2 is Content_Checksum_flag (RFC 8878 3.1.1.1.1).
        anyhow::ensure!(
            band.len() > 4 && band[..4] == ZSTD_MAGIC && band[4] & 0x04 != 0,
            "motif frame has no checksum"
        );
        bands.push(band);
        payload += len;
    }
    anyhow::ensure!(payload == bytes.len(), "invalid motif frame length");
    Ok(Frame {
        w,
        h,
        rows: rows as usize,
        bands,
    })
}

/// Writes a band's packed rows into rows `pitch` bytes apart, as the caller
/// stores pixels (the texture lane premultiplies them).
pub(crate) type Store<'a> = dyn Fn(&[u8], &mut [u8]) + Sync + 'a;

impl Frame<'_> {
    fn scaled(&self, div: u32) -> (u32, u32) {
        (self.w.div_ceil(div), self.h.div_ceil(div))
    }

    /// Decompresses the bands in parallel, scales each by `div` and writes it
    /// into its rows of `out`, which are `pitch` bytes apart (the last need
    /// only be a row long). `store` writes a band on its thread while it is
    /// still in cache; without one the rows are copied as they are.
    fn decode_into(
        &self,
        div: u32,
        out: &mut [u8],
        pitch: usize,
        store: Option<&Store<'_>>,
    ) -> anyhow::Result<()> {
        let (w, h) = self.scaled(div);
        let row = w as usize * 4;
        assert!(
            pitch >= row && out.len() == pitch * (h as usize - 1) + row,
            "motif output does not match the frame"
        );
        let chunks: Vec<&mut [u8]> = out.chunks_mut(self.rows / div as usize * pitch).collect();
        assert_eq!(chunks.len(), self.bands.len(), "a band per output chunk");
        let put = |pixels: &[u8], rows: &mut [u8]| match store {
            Some(store) => store(pixels, rows),
            None => copy_rows(pixels, rows, row, pitch),
        };
        per_thread(
            self.bands.iter().zip(chunks).enumerate(),
            band_threads(),
            |(i, (payload, rows))| {
                let lines = self.rows.min(self.h as usize - i * self.rows);
                if div == 1 && store.is_none() && pitch == row {
                    return inflate(payload, rows);
                }
                SCRATCH.with(lines * self.w as usize * 4, |band| {
                    inflate(payload, band)?;
                    if div == 1 {
                        put(band, rows);
                    } else {
                        SCRATCH.with(lines.div_ceil(div as usize) * row, |scaled| {
                            scale_into(band, self.w, lines as u32, div, scaled);
                            put(scaled, rows);
                        });
                    }
                    Ok(())
                })
            },
        )?;
        Ok(())
    }
}

/// Into exactly `out`: a band that inflates to more or less fails.
fn inflate(payload: &[u8], out: &mut [u8]) -> anyhow::Result<()> {
    let written = zstd::bulk::decompress_to_buffer(payload, out)?;
    anyhow::ensure!(written == out.len(), "invalid motif frame length");
    Ok(())
}

fn copy_rows(src: &[u8], dst: &mut [u8], row: usize, pitch: usize) {
    for (s, d) in src.chunks_exact(row).zip(dst.chunks_mut(pitch)) {
        d[..row].copy_from_slice(s);
    }
}

/// Alpha-weighted box downscale of straight RGBA by 2 or 4 (ADR 0154) into
/// `out`, `ceil(w / div)` × `ceil(h / div)`: a fully transparent texel carries
/// no colour, and a partial edge block averages only the texels it covers.
/// Rounds half up, so every lane produces the same bytes
/// (`tests/fixtures/motif-downscale-vectors.json`). Writes every byte of `out`,
/// which may hold an earlier frame's pixels.
fn scale_into(rgba: &[u8], w: u32, h: u32, div: u32, out: &mut [u8]) {
    let (ow, oh) = (w.div_ceil(div) as usize, h.div_ceil(div) as usize);
    let (w, h, d, stride) = (w as usize, h as usize, div as usize, w as usize * 4);
    assert!(
        matches!(div, 2 | 4) && rgba.len() == w * h * 4 && out.len() == ow * oh * 4,
        "invalid motif downscale"
    );
    for (y, row) in out.chunks_exact_mut(ow * 4).enumerate() {
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
            let colour = |c: u32| {
                if a == 0 {
                    0
                } else {
                    ((2 * c + a) / (2 * a)) as u8
                }
            };
            *px = [
                colour(r),
                colour(g),
                colour(b),
                ((2 * a + n) / (2 * n)) as u8,
            ];
        }
    }
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
    /// Decompression with its checksums, scaling, and whatever the reader does
    /// with each band as it decodes.
    pub decode_ms: f64,
}

fn elapsed_ms(start: std::time::Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Reads and parses `path`, then `decode`s it, timed. An invalid `div` is the
/// caller's error and is rejected before the file is read; any later failure
/// is a miss (`FRAME_ERROR`).
fn read<T>(
    path: &str,
    div: u32,
    decode: impl FnOnce(&Frame) -> anyhow::Result<T>,
) -> anyhow::Result<(T, MotifReadTiming)> {
    anyhow::ensure!(
        matches!(div, 1 | 2 | 4),
        "invalid motif scale divisor {div}"
    );
    let mut timing = MotifReadTiming::default();
    let out = from_file(|| {
        let start = std::time::Instant::now();
        let bytes = read_file(path)?;
        timing.read_ms = elapsed_ms(start);
        let start = std::time::Instant::now();
        let out = decode(&parse(&bytes)?)?;
        timing.decode_ms = elapsed_ms(start);
        Ok(out)
    })?;
    Ok((out, timing))
}

/// Reads, verifies and downscales one frame into a buffer of its own.
pub(crate) fn read_scaled(
    path: &str,
    div: u32,
) -> anyhow::Result<(u32, u32, Vec<u8>, MotifReadTiming)> {
    let ((w, h, rgba), timing) = read(path, div, |frame| {
        let (w, h) = frame.scaled(div);
        let mut rgba = vec![0; w as usize * h as usize * 4];
        frame.decode_into(div, &mut rgba, w as usize * 4, None)?;
        Ok((w, h, rgba))
    })?;
    Ok((w, h, rgba, timing))
}

/// Reads, verifies and downscales one frame into `out`, rows `pitch` bytes
/// apart, each band through `store`. A frame that is not `size` once scaled is
/// a miss.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn read_into(
    path: &str,
    div: u32,
    size: (u32, u32),
    out: &mut [u8],
    pitch: usize,
    store: &Store<'_>,
) -> anyhow::Result<MotifReadTiming> {
    let ((), timing) = read(path, div, |frame| {
        let (w, h) = frame.scaled(div);
        anyhow::ensure!(
            (w, h) == size,
            "scaled frame {w}x{h} does not fit {}x{}",
            size.0,
            size.1
        );
        frame.decode_into(div, out, pitch, Some(store))
    })?;
    Ok(timing)
}

fn read_file(path: &str) -> anyhow::Result<Vec<u8>> {
    // Each band adds a length field and its own zstd frame header and checksum.
    let limit = HEADER + 4 + zstd::zstd_safe::compress_bound(MAX_BYTES) + BANDS as usize * 64;
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

    /// A file of `w`×`h` holding these zstd frames as its bands.
    fn with_bands(w: u32, h: u32, bands: &[Vec<u8>]) -> Vec<u8> {
        let mut out = MAGIC.to_vec();
        for n in [w, h, bands.len() as u32] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        for band in bands {
            out.extend_from_slice(&(band.len() as u32).to_le_bytes());
        }
        bands.iter().for_each(|band| out.extend_from_slice(band));
        out
    }

    fn checked(pixels: &[u8]) -> Vec<u8> {
        let mut zstd = zstd::bulk::Compressor::new(1).unwrap();
        zstd.set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))
            .unwrap();
        zstd.compress(pixels).unwrap()
    }

    fn decode(bytes: &[u8]) -> anyhow::Result<(u32, u32, Vec<u8>)> {
        let frame = parse(bytes)?;
        let mut rgba = vec![0; frame.w as usize * frame.h as usize * 4];
        frame.decode_into(1, &mut rgba, frame.w as usize * 4, None)?;
        Ok((frame.w, frame.h, rgba))
    }

    /// The whole frame scaled at once: what every band-wise read must equal.
    fn downscale(rgba: Vec<u8>, w: u32, h: u32, div: u32) -> (u32, u32, Vec<u8>) {
        if div == 1 {
            return (w, h, rgba);
        }
        let (ow, oh) = (w.div_ceil(div), h.div_ceil(div));
        let mut out = vec![0; ow as usize * oh as usize * 4];
        scale_into(&rgba, w, h, div, &mut out);
        (ow, oh, out)
    }

    fn write_frame(dir: &std::path::Path, bytes: &[u8]) -> String {
        let path = dir.join("0.wfrm");
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn preserves_every_alpha_and_rgb_byte_behind_a_checksum() {
        let pixels = pattern(73);
        let bytes = encode(32, 32, &pixels).unwrap();
        let frame = parse(&bytes).unwrap();
        assert_eq!((frame.bands.len(), frame.rows), (8, 4));
        for band in &frame.bands {
            assert_eq!(&band[..4], &ZSTD_MAGIC);
            assert_ne!(band[4] & 0x04, 0, "content checksum flag");
        }
        assert_eq!(decode(&bytes).unwrap(), (32, 32, pixels));
    }

    #[test]
    fn bands_are_whole_scale_blocks_and_at_most_eight() {
        assert_eq!(
            (band_rows(2160), 2160u32.div_ceil(band_rows(2160))),
            (272, 8)
        );
        assert_eq!(
            (band_rows(1080), 1080u32.div_ceil(band_rows(1080))),
            (136, 8)
        );
        for h in 1..=600 {
            let (rows, count) = (band_rows(h), h.div_ceil(band_rows(h)));
            assert!(rows % 4 == 0 && (1..=BANDS).contains(&count), "{h}");
            assert!((count - 1) * rows < h, "{h}: no empty band");
        }
    }

    #[test]
    fn shared_threads_keep_the_items_order_and_report_the_first_failure() {
        for threads in [1, 2, 3, 8, 20] {
            let out = per_thread(0..8, threads, |i| Ok(i * 10)).unwrap();
            assert_eq!(
                out,
                (0..8).map(|i| i * 10).collect::<Vec<_>>(),
                "{threads} threads"
            );
            let error = per_thread(0..8, threads, |i| {
                anyhow::ensure!(i != 5, "item {i}");
                Ok(i)
            });
            assert_eq!(error.unwrap_err().to_string(), "item 5");
        }
        assert!(per_thread(std::iter::empty::<u8>(), 2, Ok)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_band_counts_other_than_the_rows_imply_and_trailing_bytes() {
        // 9 rows of 2 texels: bands of 4, 4 and 1 rows.
        let image = pattern(9)[..9 * 8].to_vec();
        let split = |rows: &[usize]| -> Vec<Vec<u8>> {
            let mut at = 0;
            rows.iter()
                .map(|&n| {
                    at += n * 8;
                    checked(&image[at - n * 8..at])
                })
                .collect()
        };
        let three = split(&[4, 4, 1]);
        assert_eq!(decode(&with_bands(2, 9, &three)).unwrap().2, image);
        let five = split(&[2, 2, 2, 2, 1]);
        assert!(decode(&with_bands(2, 9, &five)).is_err());
        assert!(decode(&with_bands(2, 9, &three[..2])).is_err());
        assert!(decode(&with_bands(2, 9, &[])).is_err());
        let mut trailing = with_bands(2, 9, &three);
        trailing.push(0);
        assert!(decode(&trailing).is_err());
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
        let bare = with_bands(32, 4, &[zstd::bulk::compress(&pixels[..512], 1).unwrap()]);
        assert!(decode(&bare)
            .unwrap_err()
            .to_string()
            .contains("no checksum"));
        assert!(decode(&with_bands(32, 4, &[checked(&pixels[..512])])).is_ok());
        let mut former = encode(32, 32, &pixels).unwrap();
        former[..8].copy_from_slice(b"WCMFRM01");
        assert!(decode(&former).is_err());
    }

    #[test]
    fn rejects_a_payload_that_inflates_past_its_dimensions() {
        assert!(decode(&with_bands(2, 2, &[checked(&[23; 20])])).is_err());
        assert!(decode(&with_bands(2, 2, &[checked(&[23; 8]), checked(&[23; 12])])).is_err());
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
    fn downscale_weights_colour_by_alpha_and_rounds_half_up() {
        // One 2×2 block: opaque red, transparent white, half-alpha blue, opaque green.
        let block = vec![
            255, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 128, 0, 255, 0, 255,
        ];
        // r = 255·255 / 638, g = 255·255 / 638, b = 255·128 / 638, a = 638 / 4.
        assert_eq!(downscale(block, 2, 2, 2), (1, 1, vec![102, 102, 51, 160]));
        assert_eq!(
            downscale([9, 9, 9, 0].repeat(16), 4, 4, 4),
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
            downscale(image, 3, 3, 2),
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
            downscale(image, 5, 3, 4),
            (2, 1, vec![0, 0, 0, 0, 200, 200, 200, 20])
        );
    }

    #[test]
    fn downscale_matches_the_shared_reference_vectors_whole_and_from_a_file() {
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
        let dir = tempfile::tempdir().unwrap();
        for case in vectors.cases {
            let path = write_frame(
                dir.path(),
                &encode(case.width, case.height, &case.rgba).unwrap(),
            );
            let want = (
                case.expected.width,
                case.expected.height,
                case.expected.rgba,
            );
            let (w, h, rgba, _) = read_scaled(&path, case.div).unwrap();
            assert_eq!((w, h, rgba), want, "{} from a file", case.name);
            let got = downscale(case.rgba, case.width, case.height, case.div);
            assert_eq!(got, want, "{}", case.name);
        }
    }

    #[test]
    fn band_by_band_scaling_matches_the_whole_frame() {
        let dir = tempfile::tempdir().unwrap();
        // Heights around band and block edges; widths with partial blocks.
        for (w, h) in [
            (5, 1),
            (3, 7),
            (7, 9),
            (6, 33),
            (17, 70),
            (9, 135),
            (31, 271),
        ] {
            let pixels = noise(w, h, w * 1000 + h);
            let path = write_frame(dir.path(), &encode(w, h, &pixels).unwrap());
            for div in [1, 2, 4] {
                let (sw, sh, rgba, _) = read_scaled(&path, div).unwrap();
                assert_eq!(
                    (sw, sh, rgba),
                    downscale(pixels.clone(), w, h, div),
                    "{w}x{h} div {div}"
                );
            }
        }
    }

    #[test]
    fn invalid_divisors_are_the_callers_error() {
        for div in [0, 3, 8] {
            let mut out = [0; 4];
            for error in [
                read_scaled("absent.wfrm", div).map(|_| ()),
                read_into("absent.wfrm", div, (1, 1), &mut out, 4, &|_, _| {}).map(|_| ()),
            ] {
                assert!(error
                    .unwrap_err()
                    .to_string()
                    .starts_with("invalid motif scale divisor"));
            }
        }
    }

    #[test]
    fn file_failures_are_misses_with_the_frame_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let pixels = pattern(73);
        let mut bytes = encode(32, 32, &pixels).unwrap();
        let path = write_frame(dir.path(), &bytes);
        assert_eq!(read_scaled(&path, 1).unwrap().2, pixels);
        // The last byte belongs to the last band's checksum.
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        let path = write_frame(dir.path(), &bytes);
        let mut out = vec![0; 32 * 32 * 4];
        for div in [1, 2, 4] {
            let (w, h) = (32 / div, 32 / div);
            let out = &mut out[..(w * h * 4) as usize];
            for error in [
                read_scaled(&path, div).map(|_| ()),
                read_into(&path, div, (w, h), out, w as usize * 4, &|_, _| {}).map(|_| ()),
            ] {
                let error = error.unwrap_err().to_string();
                assert!(error.starts_with(FRAME_ERROR), "{error}");
            }
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

    /// Reads through `read_into` into rows `pitch` bytes apart, padding marked,
    /// and returns the packed rows after checking the padding was not touched.
    fn read_padded(path: &str, div: u32, (w, h): (u32, u32)) -> anyhow::Result<Vec<u8>> {
        let row = w as usize * 4;
        let pitch = row + 12;
        let mut out = vec![0xA5; pitch * (h as usize - 1) + row];
        read_into(path, div, (w, h), &mut out, pitch, &|src, dst| {
            copy_rows(src, dst, row, pitch)
        })?;
        for line in out.chunks(pitch) {
            assert!(line[row..].iter().all(|&b| b == 0xA5), "padding written");
        }
        Ok(out
            .chunks(pitch)
            .flat_map(|line| &line[..row])
            .copied()
            .collect())
    }

    #[test]
    fn a_read_into_rows_apart_matches_a_read_of_its_own_whatever_came_before() {
        let dir = tempfile::tempdir().unwrap();
        // Opaque colour, then transparent noise into the same kept buffers: no
        // byte of an earlier frame may survive, transparent texels included.
        let opaque = [200, 100, 50, 255].repeat(37 * 70);
        for (w, h, pixels) in [
            (37, 70, opaque),
            (37, 70, noise(37, 70, 7)),
            (8, 9, noise(8, 9, 3)),
        ] {
            let path = write_frame(dir.path(), &encode(w, h, &pixels).unwrap());
            for div in [1, 2, 4] {
                let (sw, sh, fresh, _) = read_scaled(&path, div).unwrap();
                assert_eq!(
                    read_padded(&path, div, (sw, sh)).unwrap(),
                    fresh,
                    "{w}x{h} div {div}"
                );
            }
        }
    }

    #[test]
    fn a_read_into_refuses_a_frame_of_another_size_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_frame(dir.path(), &encode(32, 32, &pattern(73)).unwrap());
        let mut out = vec![0; 16 * 16 * 4];
        let refused = read_into(&path, 1, (16, 16), &mut out, 16 * 4, &|_, _| {
            panic!("handed over")
        })
        .unwrap_err()
        .to_string();
        assert!(
            refused.starts_with(FRAME_ERROR) && refused.ends_with("does not fit 16x16"),
            "{refused}"
        );
        assert!(read_into(&path, 2, (16, 16), &mut out, 16 * 4, &|_, _| {}).is_ok());
    }

    #[test]
    fn scratch_reuses_the_closest_buffer_and_keeps_at_most_its_limit() {
        let scratch = Scratch::new(100);
        let address = scratch.with(60, |b| b.as_ptr());
        // Shorter fits the kept buffer; longer grows it.
        assert_eq!(scratch.with(10, |b| (b.len(), b.as_ptr())), (10, address));
        assert_eq!(scratch.with(80, |b| b.len()), 80);
        assert_eq!(scratch.kept().iter().map(Vec::len).sum::<usize>(), 80);
        // Two at once: the second is fresh, and keeping both would pass 100.
        scratch.with(80, |_| scratch.with(30, |_| ()));
        let kept: Vec<usize> = scratch.kept().iter().map(Vec::len).collect();
        assert_eq!(kept, [30]);
        // The smallest that fits, not the first.
        scratch.clear();
        scratch.with(50, |_| scratch.with(20, |_| ()));
        let mut kept: Vec<(usize, *const u8)> = scratch
            .kept()
            .iter()
            .map(|b| (b.len(), b.as_ptr()))
            .collect();
        kept.sort();
        let [(20, small), (50, large)] = kept[..] else {
            panic!("{kept:?}")
        };
        assert_eq!(scratch.with(10, |b| b.as_ptr()), small);
        assert_eq!(scratch.with(30, |b| b.as_ptr()), large);
        // Over the limit alone: used, never kept.
        scratch.with(500, |b| assert_eq!(b.len(), 500));
        assert!(scratch.kept().iter().all(|b| b.len() <= 100));
        scratch.clear();
        assert!(scratch.kept().is_empty());
    }
}
