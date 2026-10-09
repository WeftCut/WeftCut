//! Audio waveform peaks. Decodes the source to stereo f32 PCM via ffmpeg,
//! builds the finest min/max/RMS level, decimates it into a power-of-two
//! mipmap pyramid, and writes a compact binary file (VPEAKS) the timeline
//! can scan in one mmap at whatever zoom-appropriate resolution it needs.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::ffmpeg::ffmpeg_is_installed;
use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::process::NoConsoleWindow;

use crate::cache::{discard_temp, promote_temp, temp_path, CacheLayout};
use crate::state::{MediaItem, MediaKind};

pub const MAGIC: &[u8; 8] = b"VPEAKS\0\0";
pub const SAMPLE_RATE: u32 = 22_050;

/// On-disk format version, written into the header. Only the current
/// version has a reader; the cache filename's version tag (see
/// `cache::CacheLayout::waveform`) drives regeneration when the format
/// changes, so there is no legacy reader to keep in sync.
pub const FORMAT_VERSION: u32 = 4;
/// Finest stored LOD. Coarser levels halve this until ~1/sec.
pub const BASE_PEAKS_PER_SECOND: u32 = 1000;
pub const BASE_FRAMES_PER_PEAK: u32 = SAMPLE_RATE / BASE_PEAKS_PER_SECOND;
pub const MAX_CHANNELS: usize = 2;

const HEADER_FIXED_BYTES: u64 = 8 + 4 + 4 + 4 + 4; // magic+version+rate+channels+level_count
const LEVEL_ENTRY_BYTES: u64 = 4 + 4 + 8; // frames_per_peak + peak_count + data_offset

/// One resolution level's peaks for all channels, planar: `mins[ch]`,
/// `maxs[ch]`, `rmss[ch]`.
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct LevelData {
    pub channels: u32,
    pub peak_count: u32,
    pub mins: Vec<Vec<i16>>,
    pub maxs: Vec<Vec<i16>>,
    pub rmss: Vec<Vec<u16>>,
}

#[derive(Clone, Copy, Debug)]
pub struct PeakLevel {
    pub frames_per_peak: u32,
    pub peak_count: u32,
}

impl PeakLevel {
    pub fn peaks_per_second(self, sample_rate: u32) -> f64 {
        sample_rate as f64 / self.frames_per_peak as f64
    }
}

#[derive(Clone, Debug)]
pub struct PeaksHeader {
    pub sample_rate: u32,
    pub channels: u32,
    pub levels: Vec<PeakLevel>,
}

#[inline]
pub fn quantize(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

#[inline]
pub fn dequantize(v: i16) -> f32 {
    v as f32 / i16::MAX as f32
}

#[inline]
pub fn quantize_rms(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16
}

#[inline]
pub fn dequantize_rms(v: u16) -> f32 {
    v as f32 / u16::MAX as f32
}

/// Write a peaks file. `levels` is finest-first; each entry pairs a
/// PCM frames-per-peak with its channel-planar min/max/rms data.
#[cfg(test)]
pub async fn write_peaks(
    path: &std::path::Path,
    channels: u32,
    levels: &[(u32, LevelData)],
) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    // Compute data offsets: header + level table, then each level's bytes.
    let table_bytes = LEVEL_ENTRY_BYTES * levels.len() as u64;
    let mut offset = HEADER_FIXED_BYTES + table_bytes;
    let mut offsets = Vec::with_capacity(levels.len());
    for (_, d) in levels {
        offsets.push(offset);
        offset += (channels as u64) * (d.peak_count as u64) * 6; // min i16 + max i16 + rms u16 per window
    }

    let file = tokio::fs::File::create(path).await?;
    let mut writer = tokio::io::BufWriter::with_capacity(64 * 1024, file);
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&(levels.len() as u32).to_le_bytes());
    for (i, (frames_per_peak, d)) in levels.iter().enumerate() {
        buf.extend_from_slice(&frames_per_peak.to_le_bytes());
        buf.extend_from_slice(&d.peak_count.to_le_bytes());
        buf.extend_from_slice(&offsets[i].to_le_bytes());
    }
    for (_, d) in levels {
        for ch in 0..channels as usize {
            for w in 0..d.peak_count as usize {
                buf.extend_from_slice(&d.mins[ch][w].to_le_bytes());
                buf.extend_from_slice(&d.maxs[ch][w].to_le_bytes());
                buf.extend_from_slice(&d.rmss[ch][w].to_le_bytes());
                if buf.len() >= 64 * 1024 {
                    writer.write_all(&buf).await?;
                    buf.clear();
                }
            }
        }
    }

    writer.write_all(&buf).await?;
    writer.flush().await?;
    Ok(())
}

pub fn read_header(path: &std::path::Path) -> Result<PeaksHeader> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut fixed = [0u8; HEADER_FIXED_BYTES as usize];
    f.read_exact(&mut fixed).context("read fixed header")?;
    if &fixed[..8] != MAGIC {
        anyhow::bail!("bad magic in peaks file");
    }
    let version = u32::from_le_bytes(fixed[8..12].try_into().unwrap());
    if version != FORMAT_VERSION {
        anyhow::bail!("unsupported peaks version {version}");
    }
    let sample_rate = u32::from_le_bytes(fixed[12..16].try_into().unwrap());
    if sample_rate != SAMPLE_RATE {
        anyhow::bail!("unsupported sample rate in peaks file");
    }
    let channels = u32::from_le_bytes(fixed[16..20].try_into().unwrap());
    let level_count = u32::from_le_bytes(fixed[20..24].try_into().unwrap()) as usize;
    if channels == 0 || channels > MAX_CHANNELS as u32 || !(1..=32).contains(&level_count) {
        anyhow::bail!("invalid peaks channels or level count");
    }
    let file_len = f.metadata()?.len();
    let mut expected_offset = HEADER_FIXED_BYTES + level_count as u64 * LEVEL_ENTRY_BYTES;
    let mut table = vec![0u8; level_count * LEVEL_ENTRY_BYTES as usize];
    f.read_exact(&mut table).context("read level table")?;
    let mut levels = Vec::with_capacity(level_count);
    for i in 0..level_count {
        let base = i * LEVEL_ENTRY_BYTES as usize;
        let frames_per_peak = u32::from_le_bytes(table[base..base + 4].try_into().unwrap());
        if frames_per_peak == 0 {
            anyhow::bail!("invalid zero frames_per_peak for level {i}");
        }
        let peak_count = u32::from_le_bytes(table[base + 4..base + 8].try_into().unwrap());
        let data_offset = u64::from_le_bytes(table[base + 8..base + 16].try_into().unwrap());
        if peak_count == 0 || data_offset != expected_offset {
            anyhow::bail!("invalid peaks data span for level {i}");
        }
        if let Some(previous) = levels.last() {
            let previous: &PeakLevel = previous;
            if previous.frames_per_peak.checked_mul(2) != Some(frames_per_peak)
                || peak_count != previous.peak_count.div_ceil(2)
            {
                anyhow::bail!("inconsistent peaks pyramid at level {i}");
            }
        }
        expected_offset = expected_offset
            .checked_add(channels as u64 * peak_count as u64 * 6)
            .context("peaks file span overflow")?;
        if expected_offset > file_len {
            anyhow::bail!("truncated peaks data for level {i}");
        }
        levels.push(PeakLevel {
            frames_per_peak,
            peak_count,
        });
    }
    if expected_offset != file_len {
        anyhow::bail!("unexpected trailing peaks data");
    }
    Ok(PeaksHeader {
        sample_rate,
        channels,
        levels,
    })
}

/// One channel's min/max/rms windows for one LOD level.
pub struct PeaksRange {
    pub peaks_per_second: f64,
    pub min: Vec<i16>,
    pub max: Vec<i16>,
    pub rms: Vec<u16>,
}

/// Read `count` (min,max,rms) windows for one channel of one level, starting
/// at `start_peak`. Clamps the range to the level's peak_count. Returns the
/// level's peaks_per_second alongside the windows — the header is already
/// parsed here, so callers must not re-open the file just to resolve it.
pub fn read_range(
    path: &std::path::Path,
    level_idx: usize,
    channel: usize,
    start_peak: u32,
    count: u32,
) -> Result<PeaksRange> {
    use std::io::{Read, Seek, SeekFrom};
    let header = read_header(path)?;
    let level = *header
        .levels
        .get(level_idx)
        .ok_or_else(|| anyhow!("level {level_idx} out of range"))?;
    if channel >= header.channels as usize {
        anyhow::bail!(
            "channel {channel} out of range (file has {} channels)",
            header.channels
        );
    }
    let ch = channel;
    let start = start_peak.min(level.peak_count);
    let end = start.saturating_add(count).min(level.peak_count);
    let n = (end - start) as usize;
    if n == 0 {
        return Ok(PeaksRange {
            peaks_per_second: level.peaks_per_second(header.sample_rate),
            min: Vec::new(),
            max: Vec::new(),
            rms: Vec::new(),
        });
    }

    // data_offset lives in the on-disk table; recompute it the same way write did.
    let table_bytes = LEVEL_ENTRY_BYTES * header.levels.len() as u64;
    let mut level_start = HEADER_FIXED_BYTES + table_bytes;
    for l in &header.levels[..level_idx] {
        level_start += (header.channels as u64) * (l.peak_count as u64) * 6;
    }
    let channel_start = level_start + (ch as u64) * (level.peak_count as u64) * 6;
    let seek_to = channel_start + (start as u64) * 6;

    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    f.seek(SeekFrom::Start(seek_to))
        .context("seek peaks range")?;
    let mut bytes = vec![0u8; n * 6];
    f.read_exact(&mut bytes).context("read peaks range")?;
    let mut min = Vec::with_capacity(n);
    let mut max = Vec::with_capacity(n);
    let mut rms = Vec::with_capacity(n);
    for w in 0..n {
        let b = w * 6;
        min.push(i16::from_le_bytes([bytes[b], bytes[b + 1]]));
        max.push(i16::from_le_bytes([bytes[b + 2], bytes[b + 3]]));
        rms.push(u16::from_le_bytes([bytes[b + 4], bytes[b + 5]]));
    }
    Ok(PeaksRange {
        peaks_per_second: level.peaks_per_second(header.sample_rate),
        min,
        max,
        rms,
    })
}

/// What a peaks build decodes from: a media file (ffmpeg auto-discovers the
/// decoder) or a VCONF, whose raw f32 body needs the format spelled out.
#[derive(Clone, Copy)]
pub enum WaveformInput<'a> {
    Media(&'a MediaItem),
    Vconf { path: &'a Path, channels: u32 },
}

pub(super) fn cached_path(cache: &CacheLayout, media: &MediaItem) -> Option<PathBuf> {
    let path = cache.waveform(&media.file_hash_blake3);
    read_header(&path).is_ok().then_some(path)
}

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    cache.check_active()?;
    if let Some(path) = cached_path(cache, media) {
        return Ok(path);
    }
    let dest = cache.waveform(&media.file_hash_blake3);
    // At 48 kHz mono/stereo conform is a decode-only operation. Reusing its
    // PCM retains the original waveform's single resample and channel policy.
    // Other rates keep decoding the original to avoid double-resample drift.
    if media.metadata.audio.as_ref().is_some_and(|audio| {
        audio.sample_rate == super::conform::CONFORM_SAMPLE_RATE && audio.channels <= 2
    }) {
        if let Some(path) = super::conform::cached_path(cache, media) {
            let header = super::conform::read_header(&path)?;
            return run_from_input(
                cache,
                WaveformInput::Vconf {
                    path: &path,
                    channels: header.channels,
                },
                dest,
            )
            .await;
        }
    }
    run_from_input(cache, WaveformInput::Media(media), dest).await
}

/// Build a peaks pyramid from `input` into `dest`. Splitting the destination
/// out of the input is what lets a baked effect-chain sibling get its own
/// peaks file (`CacheLayout::waveform_fx`) through the same pipeline.
pub async fn run_from_input(
    cache: &CacheLayout,
    input: WaveformInput<'_>,
    dest: PathBuf,
) -> Result<PathBuf> {
    cache.check_active()?;
    if let WaveformInput::Media(media) = input {
        if !matches!(media.kind, MediaKind::Video | MediaKind::Audio) {
            anyhow::bail!("waveform only valid for Video / Audio media");
        }
        if media.metadata.audio.is_none() && matches!(media.kind, MediaKind::Video) {
            // Video file without an audio stream — surfaced as a hard error so the
            // spawner can decide (it may still treat it as a no-op).
            anyhow::bail!("video media has no audio stream");
        }
    }

    if read_header(&dest).is_ok() {
        return Ok(dest);
    }

    cache.check_active()?;
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate waveform");
    }

    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let mut cmd = crate::ffmpeg::command_with_threads(1);
    cmd.no_console_window()
        // Reap on future-drop so no orphan keeps writing the shared temp; see
        // hwaccel.rs.
        .kill_on_drop(true)
        .args(["-hide_banner", "-nostats", "-loglevel", "error"]);
    match input {
        WaveformInput::Media(media) => {
            cmd.arg("-i").arg(&media.path_abs);
        }
        WaveformInput::Vconf { path, channels } => {
            let header = super::conform::read_header(path)?;
            anyhow::ensure!(
                header.channels == channels,
                "conform waveform channel mismatch"
            );
            cmd.args([
                "-skip_initial_bytes",
                &super::conform::HEADER_LEN.to_string(),
            ])
            .args([
                "-f",
                "f32le",
                "-ar",
                &super::conform::CONFORM_SAMPLE_RATE.to_string(),
                "-ac",
                &channels.to_string(),
            ])
            .arg("-i")
            .arg(path);
        }
    }
    let mut child = cmd
        .args([
            "-vn",
            "-threads",
            "1",
            "-ac",
            "2",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "f32le",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg for waveform")?;

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr_task = tokio::spawn(super::conform::drain_stderr(
        child.stderr.take().expect("stderr was piped"),
    ));
    let operation = async {
        // Downmix target is 2ch; a mono source still decodes to 2 identical channels
        // under `-ac 2`, so the reader/writer path is uniform.
        let channels = MAX_CHANNELS;
        // Anonymous files are unlinked/delete-on-close, including process death.
        let spool = dest
            .parent()
            .context("waveform destination has no parent")?;
        let finest = compute_finest_level(&mut stdout, channels, spool, cache).await?;

        let status = tokio::select! {
            result = child.wait() => result.context("await ffmpeg for waveform")?,
            _ = cache.cancelled() => anyhow::bail!("workspace cancelled"),
        };
        let stderr_bytes = (&mut stderr_task)
            .await
            .context("read waveform stderr task")??;
        if !status.success() {
            let stderr = String::from_utf8_lossy(&stderr_bytes);
            discard_temp(&dest);
            anyhow::bail!(
                "ffmpeg exited with {} for waveform: {}",
                status,
                stderr.trim()
            );
        }

        let pyramid = build_disk_pyramid(finest, spool, cache).await?;
        write_disk_peaks(&tmp, &pyramid, cache).await?;
        read_header(&tmp)?;
        anyhow::ensure!(!cache.is_cancelled(), "workspace cancelled");
        promote_temp(&dest)?;
        cache.notify_write();
        Ok(dest.clone())
    };
    // Finish each file operation before observing cancellation, so all file
    // handles have closed before the spool directory is removed on Windows.
    let result = operation.await;
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
        stderr_task.abort();
        discard_temp(&dest);
    }
    result
}

/// Decode interleaved stereo f32 PCM from ffmpeg's stdout into the finest
/// (highest-resolution) min/max/rms level. One peak window is
/// `SAMPLE_RATE / BASE_PEAKS_PER_SECOND` frames; `decimate`/`decimate_rms`/
/// `build_pyramid` derive every coarser LOD from this level, so it's the
/// only pass that touches the raw PCM stream.
async fn compute_finest_level(
    stdout: &mut (impl tokio::io::AsyncRead + Unpin),
    channels: usize,
    spool: &Path,
    cache: &CacheLayout,
) -> Result<DiskLevel> {
    let mut writers = Vec::with_capacity(channels);
    for _ in 0..channels {
        writers.push(tokio::io::BufWriter::with_capacity(
            64 * 1024,
            tokio::fs::File::from_std(tempfile::tempfile_in(spool)?),
        ));
    }
    let mut peak_count = 0u32;
    let frames_per_peak = BASE_FRAMES_PER_PEAK as usize;
    let mut mins: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut maxs: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut rmss: Vec<Vec<u16>> = vec![Vec::new(); channels];
    let mut cur_min = vec![f32::MAX; channels];
    let mut cur_max = vec![f32::MIN; channels];
    let mut cur_sq = vec![0.0f64; channels];
    let mut frames_in_window = 0usize;
    let mut ch = 0usize;

    // 64 KiB read chunks — multiple of 4 (one f32 = 4 bytes), big enough to
    // amortize syscall overhead.
    let mut buf = vec![0u8; 64 * 1024];
    let mut leftover = [0u8; 4];
    let mut leftover_len = 0usize;

    #[allow(clippy::too_many_arguments)]
    fn consume(
        sample: f32,
        channels: usize,
        ch: &mut usize,
        frames_in_window: &mut usize,
        frames_per_peak: usize,
        cur_min: &mut [f32],
        cur_max: &mut [f32],
        cur_sq: &mut [f64],
        mins: &mut [Vec<i16>],
        maxs: &mut [Vec<i16>],
        rmss: &mut [Vec<u16>],
    ) {
        cur_min[*ch] = cur_min[*ch].min(sample);
        cur_max[*ch] = cur_max[*ch].max(sample);
        cur_sq[*ch] += (sample as f64) * (sample as f64);
        *ch += 1;
        if *ch == channels {
            *ch = 0;
            *frames_in_window += 1;
            if *frames_in_window >= frames_per_peak {
                for c in 0..channels {
                    mins[c].push(quantize(if cur_min[c] == f32::MAX {
                        0.0
                    } else {
                        cur_min[c]
                    }));
                    maxs[c].push(quantize(if cur_max[c] == f32::MIN {
                        0.0
                    } else {
                        cur_max[c]
                    }));
                    rmss[c].push(quantize_rms(
                        (cur_sq[c] / frames_per_peak as f64).sqrt() as f32
                    ));
                    cur_min[c] = f32::MAX;
                    cur_max[c] = f32::MIN;
                    cur_sq[c] = 0.0;
                }
                *frames_in_window = 0;
            }
        }
    }

    loop {
        let n = tokio::select! {
            result = stdout.read(&mut buf) => result.context("read ffmpeg stdout")?,
            _ = cache.cancelled() => anyhow::bail!("workspace cancelled"),
        };
        if n == 0 {
            break;
        }
        let mut slice = &buf[..n];
        // Consume any leftover bytes from a prior read that didn't end on a
        // 4-byte boundary.
        if leftover_len > 0 {
            let need = 4 - leftover_len;
            let take = need.min(slice.len());
            leftover[leftover_len..leftover_len + take].copy_from_slice(&slice[..take]);
            leftover_len += take;
            slice = &slice[take..];
            if leftover_len < 4 {
                continue;
            }
            if leftover_len == 4 {
                let s = f32::from_le_bytes(leftover);
                consume(
                    s,
                    channels,
                    &mut ch,
                    &mut frames_in_window,
                    frames_per_peak,
                    &mut cur_min,
                    &mut cur_max,
                    &mut cur_sq,
                    &mut mins,
                    &mut maxs,
                    &mut rmss,
                );
            }
        }
        let aligned = slice.len() - (slice.len() % 4);
        for chunk in slice[..aligned].as_chunks::<4>().0 {
            let s = f32::from_le_bytes(*chunk);
            consume(
                s,
                channels,
                &mut ch,
                &mut frames_in_window,
                frames_per_peak,
                &mut cur_min,
                &mut cur_max,
                &mut cur_sq,
                &mut mins,
                &mut maxs,
                &mut rmss,
            );
        }
        peak_count = peak_count
            .checked_add(mins[0].len() as u32)
            .context("waveform exceeds VPEAKS peak count limit")?;
        flush_peak_chunk(&mut writers, &mut mins, &mut maxs, &mut rmss).await?;
        // Complete any in-flight filesystem writes before a cancellable pipe read.
        for writer in &mut writers {
            writer.flush().await?;
        }
        // Save trailing < 4 bytes for the next iteration.
        let tail = &slice[aligned..];
        leftover_len = tail.len();
        leftover[..leftover_len].copy_from_slice(tail);
    }
    // Flush a partial trailing window — divides by its actual frame count,
    // not `frames_per_peak`, since it never reached a full window.
    if frames_in_window > 0 {
        for c in 0..channels {
            mins[c].push(quantize(if cur_min[c] == f32::MAX {
                0.0
            } else {
                cur_min[c]
            }));
            maxs[c].push(quantize(if cur_max[c] == f32::MIN {
                0.0
            } else {
                cur_max[c]
            }));
            rmss[c].push(quantize_rms(
                (cur_sq[c] / frames_in_window as f64).sqrt() as f32
            ));
        }
    }
    if leftover_len != 0 || ch != 0 {
        anyhow::bail!("waveform PCM ended inside a sample or channel frame");
    }
    peak_count = peak_count
        .checked_add(mins[0].len() as u32)
        .context("waveform exceeds VPEAKS peak count limit")?;
    if peak_count == 0 {
        anyhow::bail!("waveform produced no audio frames");
    }
    flush_peak_chunk(&mut writers, &mut mins, &mut maxs, &mut rmss).await?;
    for writer in &mut writers {
        writer.flush().await?;
    }
    Ok(DiskLevel {
        frames_per_peak: BASE_FRAMES_PER_PEAK,
        peak_count,
        files: writers
            .into_iter()
            .map(|writer| writer.into_inner())
            .collect(),
    })
}

struct DiskLevel {
    frames_per_peak: u32,
    peak_count: u32,
    files: Vec<tokio::fs::File>,
}

async fn flush_peak_chunk(
    writers: &mut [tokio::io::BufWriter<tokio::fs::File>],
    mins: &mut [Vec<i16>],
    maxs: &mut [Vec<i16>],
    rmss: &mut [Vec<u16>],
) -> Result<()> {
    let mut bytes = Vec::with_capacity(mins[0].len() * 6);
    for (ch, writer) in writers.iter_mut().enumerate() {
        bytes.clear();
        for i in 0..mins[ch].len() {
            bytes.extend_from_slice(&mins[ch][i].to_le_bytes());
            bytes.extend_from_slice(&maxs[ch][i].to_le_bytes());
            bytes.extend_from_slice(&rmss[ch][i].to_le_bytes());
        }
        writer.write_all(&bytes).await?;
        mins[ch].clear();
        maxs[ch].clear();
        rmss[ch].clear();
    }
    Ok(())
}

/// Disk-backed equivalent of build_pyramid. Only a reader and writer buffer
/// are resident; quantization and odd-window self-pairing match V4 exactly.
async fn build_disk_pyramid(
    finest: DiskLevel,
    spool: &Path,
    cache: &CacheLayout,
) -> Result<Vec<DiskLevel>> {
    let mut levels = vec![finest];
    loop {
        let previous = levels.last().unwrap();
        if previous.peak_count <= 1 || previous.frames_per_peak >= SAMPLE_RATE {
            break;
        }
        let mut files = Vec::with_capacity(previous.files.len());
        for input in &previous.files {
            let mut source = input.try_clone().await?;
            source.seek(std::io::SeekFrom::Start(0)).await?;
            let mut reader = tokio::io::BufReader::with_capacity(64 * 1024, source);
            let mut writer = tokio::io::BufWriter::with_capacity(
                64 * 1024,
                tokio::fs::File::from_std(tempfile::tempfile_in(spool)?),
            );
            for i in (0..previous.peak_count).step_by(2) {
                if i % 4096 == 0 {
                    writer.flush().await?;
                    cache.check_active()?;
                }
                let mut a = [0u8; 6];
                reader.read_exact(&mut a).await?;
                let mut b = a;
                if i + 1 < previous.peak_count {
                    reader.read_exact(&mut b).await?;
                }
                let min = i16::from_le_bytes([a[0], a[1]]).min(i16::from_le_bytes([b[0], b[1]]));
                let max = i16::from_le_bytes([a[2], a[3]]).max(i16::from_le_bytes([b[2], b[3]]));
                let ar = dequantize_rms(u16::from_le_bytes([a[4], a[5]])) as f64;
                let br = dequantize_rms(u16::from_le_bytes([b[4], b[5]])) as f64;
                let rms = quantize_rms(((ar * ar + br * br) / 2.0).sqrt() as f32);
                writer.write_all(&min.to_le_bytes()).await?;
                writer.write_all(&max.to_le_bytes()).await?;
                writer.write_all(&rms.to_le_bytes()).await?;
            }
            writer.flush().await?;
            files.push(writer.into_inner());
        }
        levels.push(DiskLevel {
            frames_per_peak: previous.frames_per_peak * 2,
            peak_count: previous.peak_count.div_ceil(2),
            files,
        });
    }
    Ok(levels)
}

async fn write_disk_peaks(path: &Path, levels: &[DiskLevel], cache: &CacheLayout) -> Result<()> {
    let channels = levels[0].files.len() as u32;
    let mut writer =
        tokio::io::BufWriter::with_capacity(64 * 1024, tokio::fs::File::create(path).await?);
    writer.write_all(MAGIC).await?;
    writer.write_all(&FORMAT_VERSION.to_le_bytes()).await?;
    writer.write_all(&SAMPLE_RATE.to_le_bytes()).await?;
    writer.write_all(&channels.to_le_bytes()).await?;
    writer
        .write_all(&(levels.len() as u32).to_le_bytes())
        .await?;
    let mut offset = HEADER_FIXED_BYTES + LEVEL_ENTRY_BYTES * levels.len() as u64;
    for level in levels {
        writer
            .write_all(&level.frames_per_peak.to_le_bytes())
            .await?;
        writer.write_all(&level.peak_count.to_le_bytes()).await?;
        writer.write_all(&offset.to_le_bytes()).await?;
        offset += channels as u64 * level.peak_count as u64 * 6;
    }
    for level in levels {
        for channel in &level.files {
            let mut reader = channel.try_clone().await?;
            reader.seek(std::io::SeekFrom::Start(0)).await?;
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                writer.flush().await?;
                cache.check_active()?;
                let count = reader.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                writer.write_all(&buffer[..count]).await?;
            }
        }
    }
    writer.flush().await?;
    Ok(())
}

/// Halve resolution by pairwise min/max. An odd trailing window is paired
/// with itself so `out_len == mins.len().div_ceil(2)`.
#[cfg(test)]
fn decimate(mins: &[i16], maxs: &[i16]) -> (Vec<i16>, Vec<i16>) {
    let out_len = mins.len().div_ceil(2);
    let mut dmin = Vec::with_capacity(out_len);
    let mut dmax = Vec::with_capacity(out_len);
    let mut i = 0;
    while i < mins.len() {
        let j = (i + 1).min(mins.len() - 1);
        dmin.push(mins[i].min(mins[j]));
        dmax.push(maxs[i].max(maxs[j]));
        i += 2;
    }
    (dmin, dmax)
}

/// Halve resolution by pairwise RMS-of-RMS: `sqrt((a² + b²) / 2)` is the RMS
/// of the two equal-length windows concatenated. An odd trailing window
/// pairs with itself, which reduces to the identity (`sqrt((a²+a²)/2) = a`),
/// matching `decimate`'s self-pairing convention.
#[cfg(test)]
fn decimate_rms(rmss: &[u16]) -> Vec<u16> {
    let out_len = rmss.len().div_ceil(2);
    let mut out = Vec::with_capacity(out_len);
    let mut i = 0;
    while i < rmss.len() {
        let j = (i + 1).min(rmss.len() - 1);
        let a = dequantize_rms(rmss[i]) as f64;
        let b = dequantize_rms(rmss[j]) as f64;
        out.push(quantize_rms((((a * a) + (b * b)) / 2.0).sqrt() as f32));
        i += 2;
    }
    out
}

/// Build the finest-first LOD pyramid. The on-disk timebase is the exact
/// number of source PCM frames represented by each peak; each subsequent
/// level doubles that value while its peak_count is halved via
/// `decimate`, down to ~1/sec (or a single window, whichever is reached first).
#[cfg(test)]
fn build_pyramid(finest: LevelData) -> Vec<(u32, LevelData)> {
    let channels = finest.channels as usize;
    let mut out: Vec<(u32, LevelData)> = vec![(BASE_FRAMES_PER_PEAK, finest)];
    let mut frames_per_peak = BASE_FRAMES_PER_PEAK;
    loop {
        let (_, prev) = out.last().unwrap();
        if prev.peak_count <= 1 || frames_per_peak >= SAMPLE_RATE {
            break;
        }
        let mut mins = Vec::with_capacity(channels);
        let mut maxs = Vec::with_capacity(channels);
        let mut rmss = Vec::with_capacity(channels);
        for c in 0..channels {
            let (dmin, dmax) = decimate(&prev.mins[c], &prev.maxs[c]);
            mins.push(dmin);
            maxs.push(dmax);
            rmss.push(decimate_rms(&prev.rmss[c]));
        }
        let peak_count = mins[0].len() as u32;
        frames_per_peak = frames_per_peak.saturating_mul(2);
        out.push((
            frames_per_peak,
            LevelData {
                channels: channels as u32,
                peak_count,
                mins,
                maxs,
                rmss,
            },
        ));
    }
    out
}

/// Max-abs peaks plus their exact PCM timebase for compatibility consumers
/// such as pause detection and the legacy whole-waveform command.
pub struct PeaksFile {
    pub peaks: Vec<f32>,
    pub sample_rate: u32,
    pub frames_per_peak: u32,
}

/// One max-abs track folded across EVERY channel of the level nearest
/// 100 peaks/sec. The fold is load-bearing: a dual-mono take with the voice on
/// one channel only reads as end-to-end quiet when a consumer looks at channel
/// 0 alone, so pause detection would swallow the whole clip.
pub fn read_peaks_file(path: &std::path::Path) -> Result<PeaksFile> {
    let header = read_header(path)?;
    if header.channels == 0 {
        anyhow::bail!("peaks file has no channels");
    }
    // Pick the level nearest 100 peaks/sec while remaining at or above it.
    // Crucially, return that level's exact rational timebase rather than
    // resampling it to a nominal integer rate.
    const TARGET_PEAKS_PER_SECOND: f64 = 100.0;
    let (level_idx, level) = header
        .levels
        .iter()
        .enumerate()
        .rfind(|(_, l)| l.peaks_per_second(header.sample_rate) >= TARGET_PEAKS_PER_SECOND)
        .map(|(i, l)| (i, *l))
        .unwrap_or((0, header.levels[0]));

    let mut peaks = vec![0.0f32; level.peak_count as usize];
    for ch in 0..header.channels as usize {
        let range = read_range(path, level_idx, ch, 0, level.peak_count)?;
        for (slot, (&min, &max)) in peaks.iter_mut().zip(range.min.iter().zip(&range.max)) {
            *slot = slot.max(dequantize(min).abs().max(dequantize(max).abs()));
        }
    }
    Ok(PeaksFile {
        peaks,
        sample_rate: header.sample_rate,
        frames_per_peak: level.frames_per_peak,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::cached_ok;
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;
    use tokio::process::Command;

    use crate::state::{new_id, AudioStreamMeta, DecodeRoute, MediaKind, MediaMetadata};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// 1-second 1 kHz sine wave WAV via lavfi.
    async fn make_test_audio(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=1",
                "-ac",
                "1",
                "-ar",
                "44100",
            ])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("test fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    /// A reader deliberately splitting f32 values at every possible boundary.
    struct FragmentedPcm {
        bytes: std::io::Cursor<Vec<u8>>,
        chunk: usize,
    }
    impl tokio::io::AsyncRead for FragmentedPcm {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let mut bytes = [0u8; 8192];
            let count = self.chunk.min(buf.remaining()).min(bytes.len());
            let n = std::io::Read::read(&mut self.bytes, &mut bytes[..count])?;
            buf.put_slice(&bytes[..n]);
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn streamed_pyramid_matches_v4_reference_bytes_across_chunks_and_odd_tails() {
        for chunk in [1, 3, 8191] {
            let dir = TempDir::new().unwrap();
            let cache = CacheLayout::new(dir.path().join("cache"));
            // Several decode chunks, non-power-of-two window count and a partial
            // final window exercise cross-chunk extrema/RMS and odd self-pairs.
            let frames = 22 * 513 + 7;
            let pcm: Vec<[f32; 2]> = (0..frames)
                .map(|i| {
                    [
                        ((i * 13 % 97) as f32 - 48.0) / 64.0,
                        if i % 71 == 0 { -0.9 } else { 0.125 },
                    ]
                })
                .collect();
            let bytes = pcm
                .iter()
                .flat_map(|frame| frame.iter().flat_map(|v| v.to_le_bytes()))
                .collect();
            let mut reader = FragmentedPcm {
                bytes: std::io::Cursor::new(bytes),
                chunk,
            };
            let fine = compute_finest_level(&mut reader, 2, dir.path(), &cache)
                .await
                .unwrap();
            let levels = build_disk_pyramid(fine, dir.path(), &cache).await.unwrap();
            let actual = dir.path().join("stream.peaks");
            write_disk_peaks(&actual, &levels, &cache).await.unwrap();
            let mut reference = LevelData {
                channels: 2,
                peak_count: pcm.len().div_ceil(BASE_FRAMES_PER_PEAK as usize) as u32,
                mins: vec![vec![], vec![]],
                maxs: vec![vec![], vec![]],
                rmss: vec![vec![], vec![]],
            };
            for window in pcm.chunks(BASE_FRAMES_PER_PEAK as usize) {
                for ch in 0..2 {
                    reference.mins[ch].push(quantize(
                        window.iter().map(|f| f[ch]).fold(f32::MAX, f32::min),
                    ));
                    reference.maxs[ch].push(quantize(
                        window.iter().map(|f| f[ch]).fold(f32::MIN, f32::max),
                    ));
                    let squares: f64 = window.iter().map(|f| (f[ch] as f64).powi(2)).sum();
                    reference.rmss[ch]
                        .push(quantize_rms((squares / window.len() as f64).sqrt() as f32));
                }
            }
            let expected = dir.path().join("reference.peaks");
            write_peaks(&expected, 2, &build_pyramid(reference))
                .await
                .unwrap();
            assert_eq!(
                std::fs::read(&actual).unwrap(),
                std::fs::read(&expected).unwrap(),
                "chunk {chunk}"
            );
            assert!(read_header(&actual).is_ok());
        }
    }

    #[tokio::test]
    async fn cancelling_pcm_read_closes_spool_writers_before_directory_cleanup() {
        struct CancelAtEnd {
            bytes: std::io::Cursor<Vec<u8>>,
            owner: CacheLayout,
        }
        impl tokio::io::AsyncRead for CancelAtEnd {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                let mut chunk = [0u8; 8192];
                let count = chunk.len().min(buf.remaining());
                let n = std::io::Read::read(&mut self.bytes, &mut chunk[..count])?;
                if n == 0 {
                    self.owner.end_session();
                    return std::task::Poll::Pending;
                }
                buf.put_slice(&chunk[..n]);
                std::task::Poll::Ready(Ok(()))
            }
        }
        let dir = TempDir::new().unwrap();
        let owner = CacheLayout::new(dir.path().join("cache"));
        let snapshot = owner.snapshot();
        let mut reader = CancelAtEnd {
            bytes: std::io::Cursor::new(vec![0; 128 * 1024]),
            owner,
        };
        let spool = tempfile::Builder::new()
            .prefix("waveform-")
            .tempdir_in(dir.path())
            .unwrap();
        let spool_path = spool.path().to_owned();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let _spool = spool;
            compute_finest_level(&mut reader, 2, &spool_path, &snapshot).await
        })
        .await
        .expect("cancellation must wake a blocked PCM read");
        assert!(result.is_err());
        assert!(
            !spool_path.exists(),
            "no open writer may prevent Windows temp cleanup"
        );
    }

    #[tokio::test]
    async fn peaks_validator_rejects_unbounded_tables_truncation_bad_offsets_and_channels() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("file.peaks");
        let data = LevelData {
            channels: 1,
            peak_count: 2,
            mins: vec![vec![-1; 2]],
            maxs: vec![vec![1; 2]],
            rmss: vec![vec![1; 2]],
        };
        write_peaks(&path, 1, &[(BASE_FRAMES_PER_PEAK, data)])
            .await
            .unwrap();
        let valid = std::fs::read(&path).unwrap();
        assert!(read_header(&path).is_ok());
        for (offset, replacement) in [(20, u32::MAX), (16, 0), (16, 99), (12, 0), (28, 0)] {
            let mut bad = valid.clone();
            bad[offset..offset + 4].copy_from_slice(&replacement.to_le_bytes());
            std::fs::write(&path, bad).unwrap();
            assert!(
                read_header(&path).is_err(),
                "offset {offset}, replacement {replacement}"
            );
        }
        let mut bad = valid.clone();
        bad[32..40].copy_from_slice(&u64::MAX.to_le_bytes());
        std::fs::write(&path, bad).unwrap();
        assert!(read_header(&path).is_err());
        std::fs::write(&path, &valid[..valid.len() - 1]).unwrap();
        assert!(read_header(&path).is_err());
        std::fs::write(&path, &valid).unwrap();
        assert_eq!(read_range(&path, 0, 0, 1, u32::MAX).unwrap().min, vec![-1]);
    }

    #[tokio::test]
    async fn waveform_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping waveform smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let audio = tmp.path().join("source.wav");
        make_test_audio(&audio).await.expect("test fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("source.wav".into()),
            path_abs: audio,
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 44100,
                    channels: 1,
                    codec: "pcm_s16le".into(),
                    start_pts_us: None,
                }),
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef-wf".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let path = run(&cache, &media).await.expect("waveform run");
        assert!(cached_ok(&path));
        assert!(path.to_string_lossy().ends_with(".v4.peaks"));

        let header = read_header(&path).expect("header");
        assert_eq!(header.channels, 2);
        assert_eq!(header.sample_rate, SAMPLE_RATE);
        assert_eq!(header.levels[0].frames_per_peak, BASE_FRAMES_PER_PEAK);
        // ~1s source at 1000/sec ≈ ~1000 finest windows (±a few for alignment).
        assert!(
            (990..=1010).contains(&header.levels[0].peak_count),
            "expected ~1000 finest peaks, got {}",
            header.levels[0].peak_count
        );

        // Constant 1 kHz sine: every finest window has a full cycle, so max ≈ const,
        // well above the noise floor and below clipping.
        let range = read_range(&path, 0, 0, 0, header.levels[0].peak_count).expect("range");
        let peak = range
            .max
            .iter()
            .map(|v| dequantize(*v))
            .fold(0.0_f32, f32::max);
        assert!(peak > 0.05, "peak {peak} too low — pipeline likely broken");
        assert!(peak <= 1.01, "peak {peak} clipped");

        // Constant-amplitude sine: per-window RMS should converge on peak/sqrt(2)
        // once averaged across the whole clip (individual windows wobble with
        // cycle-boundary phase).
        let avg_rms = range
            .rms
            .iter()
            .map(|v| dequantize_rms(*v) as f64)
            .sum::<f64>()
            / range.rms.len() as f64;
        let ratio = avg_rms / peak as f64;
        assert!(
            (ratio - 0.707).abs() < 0.05,
            "rms/peak ratio {ratio} not close to 1/sqrt(2)"
        );
    }

    #[tokio::test]
    async fn canonical_48k_conform_reuse_preserves_waveform_bytes_and_channel_policy() {
        if !ffmpeg_available() {
            return;
        }
        let dir = TempDir::new().unwrap();
        let cache = CacheLayout::new(dir.path().join("cache"));
        cache.ensure_dirs().unwrap();
        for (ext, channels) in [("wav", 1), ("flac", 2), ("m4a", 2)] {
            let source = dir.path().join(format!("tone.{ext}"));
            let status = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=731:sample_rate=48000:duration=0.137",
                    "-ac",
                    &channels.to_string(),
                ])
                .arg(&source)
                .status()
                .await
                .unwrap();
            assert!(status.success());
            let media = MediaItem {
                id: new_id(),
                label: None,
                path_abs: source.clone(),
                path_rel: None,
                kind: MediaKind::Audio,
                metadata: MediaMetadata {
                    duration_us: Some(137_000),
                    audio: Some(AudioStreamMeta {
                        sample_rate: 48000,
                        channels,
                        codec: ext.into(),
                        start_pts_us: None,
                    }),
                    ..Default::default()
                },
                decode_route: DecodeRoute::Bypass,
                waveform_path: None,
                conform_path: None,
                thumbnails_dir: None,
                file_hash_blake3: format!("reuse-{ext}"),
                file_size: 0,
                file_mtime: 0,
                imported_at: Utc::now(),
            };
            let direct = run(&cache, &media).await.unwrap();
            let expected = std::fs::read(&direct).unwrap();
            super::super::conform::run(&cache, &media).await.unwrap();
            std::fs::remove_file(&direct).unwrap();
            // The only usable input is the canonical conform; a fallback to
            // compressed-source decode now fails this test.
            std::fs::remove_file(source).unwrap();
            let reused = run(&cache, &media).await.unwrap();
            assert_eq!(
                std::fs::read(&reused).unwrap(),
                expected,
                "{ext}/{channels}ch"
            );
            std::fs::write(&reused, &expected[..40]).unwrap();
            assert!(cached_path(&cache, &media).is_none());
            let repaired = run(&cache, &media).await.unwrap();
            assert_eq!(std::fs::read(repaired).unwrap(), expected, "repair {ext}");
            assert!(std::fs::read_dir(reused.parent().unwrap())
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("waveform-")));
        }
    }

    #[tokio::test]
    async fn rejects_video_without_audio() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "noaudio".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let err = run(&cache, &media).await.expect_err("video without audio");
        assert!(format!("{err:#}").contains("no audio stream"));
    }

    #[test]
    fn v4_write_read_header_and_range() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("test.v4.peaks");

        // Two levels, stereo. Finest: 4 windows; coarse: 2 windows.
        let fine = LevelData {
            channels: 2,
            peak_count: 4,
            mins: vec![vec![-1000, -2000, -3000, -4000], vec![-10, -20, -30, -40]],
            maxs: vec![vec![1000, 2000, 3000, 4000], vec![10, 20, 30, 40]],
            rmss: vec![vec![100, 200, 300, 400], vec![1, 2, 3, 4]],
        };
        let coarse = LevelData {
            channels: 2,
            peak_count: 2,
            mins: vec![vec![-2000, -4000], vec![-20, -40]],
            maxs: vec![vec![2000, 4000], vec![20, 40]],
            rmss: vec![vec![150, 350], vec![1, 3]],
        };
        let levels = vec![
            (BASE_FRAMES_PER_PEAK, fine),
            (BASE_FRAMES_PER_PEAK * 2, coarse),
        ];
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async { write_peaks(&path, 2, &levels).await })
            .unwrap();

        let header = read_header(&path).expect("header");
        assert_eq!(header.channels, 2);
        assert_eq!(header.levels.len(), 2);
        assert_eq!(header.sample_rate, SAMPLE_RATE);
        assert_eq!(header.levels[0].frames_per_peak, BASE_FRAMES_PER_PEAK);
        assert_eq!(header.levels[0].peak_count, 4);
        assert_eq!(header.levels[1].frames_per_peak, BASE_FRAMES_PER_PEAK * 2);

        // Range read: level 0, channel 1, windows [1,3). The level's pps rides
        // along so callers don't need a second header read; rms round-trips
        // alongside min/max.
        let range = read_range(&path, 0, 1, 1, 2).expect("range");
        assert_eq!(
            range.peaks_per_second,
            SAMPLE_RATE as f64 / BASE_FRAMES_PER_PEAK as f64
        );
        assert_eq!(range.min, vec![-20, -30]);
        assert_eq!(range.max, vec![20, 30]);
        assert_eq!(range.rms, vec![2, 3]);

        // Coarse level reports its own pps.
        let range = read_range(&path, 1, 0, 0, 2).expect("coarse range");
        assert_eq!(
            range.peaks_per_second,
            SAMPLE_RATE as f64 / (BASE_FRAMES_PER_PEAK * 2) as f64
        );
        assert_eq!(range.rms, vec![150, 350]);

        // Clamp past the end.
        let range = read_range(&path, 0, 0, 3, 10).expect("clamped range");
        assert_eq!(range.min, vec![-4000]);
        assert_eq!(range.rms, vec![400]);

        // Fully past-end start_peak -> empty result (start clamps to peak_count,
        // n = 0) but pps is still reported.
        let range = read_range(&path, 0, 0, 10, 5).expect("past-end start");
        assert_eq!(
            range.peaks_per_second,
            SAMPLE_RATE as f64 / BASE_FRAMES_PER_PEAK as f64
        );
        assert!(range.min.is_empty() && range.max.is_empty() && range.rms.is_empty());

        // Out-of-range channel is an error, not a silent clamp.
        assert!(read_range(&path, 0, 5, 0, 2).is_err());
    }

    /// A dual-mono take with the voice on the right channel only: reading
    /// channel 0 alone reports digital quiet end to end, which pause detection
    /// would then swallow whole. The fold across channels is what keeps the
    /// speech visible.
    #[test]
    fn read_peaks_file_folds_every_channel() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("right-only.v4.peaks");

        let silent_left = vec![0i16; 4];
        let loud_right = vec![i16::MAX / 2; 4];
        let level = LevelData {
            channels: 2,
            peak_count: 4,
            mins: vec![silent_left.clone(), loud_right.iter().map(|v| -v).collect()],
            maxs: vec![silent_left, loud_right],
            rmss: vec![vec![0; 4], vec![u16::MAX / 2; 4]],
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async { write_peaks(&path, 2, &[(BASE_FRAMES_PER_PEAK, level)]).await })
            .unwrap();

        let file = read_peaks_file(&path).expect("read folded peaks");
        assert_eq!(file.peaks.len(), 4);
        assert_eq!(file.sample_rate, SAMPLE_RATE);
        assert_eq!(file.frames_per_peak, BASE_FRAMES_PER_PEAK);
        for p in &file.peaks {
            assert!(
                (*p - 0.5).abs() < 0.01,
                "right-channel speech must survive the fold, got {p}"
            );
        }
    }

    #[test]
    fn decimate_halves_and_preserves_envelope() {
        // 4 windows -> 2 windows. Each output min/max spans its two children.
        let mins = vec![-3, -1, -7, -2];
        let maxs = vec![2, 5, 1, 9];
        let (dmin, dmax) = decimate(&mins, &maxs);
        assert_eq!(dmin, vec![-3, -7]); // min(-3,-1)=-3 ; min(-7,-2)=-7
        assert_eq!(dmax, vec![5, 9]); // max(2,5)=5 ; max(1,9)=9

        // RMS-of-RMS: sqrt((0.6² + 0.8²) / 2) = sqrt(0.5) = 1/sqrt(2) ≈ 0.707.
        // "0.707" is a 3-decimal display rounding of 1/sqrt(2) (0.70710678...);
        // at u16 precision that display truncation alone is ~7 quanta, so the
        // tolerance covers it, not just decimation rounding.
        let rmss = vec![quantize_rms(0.6), quantize_rms(0.8)];
        let drms = decimate_rms(&rmss)[0];
        let expected = quantize_rms(0.707);
        assert!(
            (drms as i32 - expected as i32).abs() <= 10,
            "decimate_rms({rmss:?})[0] = {drms}, expected ~{expected}"
        );
    }

    #[test]
    fn read_peaks_file_returns_exact_timebase_and_maxabs() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("c.v4.peaks");
        // Finest level at 1000/sec, 1000 windows, channel 0 has a big negative
        // excursion so max-abs must pick up |min|, not just max.
        let mut mins = vec![0i16; 1000];
        let mut maxs = vec![0i16; 1000];
        mins[500] = quantize(-0.9);
        maxs[10] = quantize(0.4);
        let rmss = vec![vec![0u16; 1000]];
        let finest = LevelData {
            channels: 1,
            peak_count: 1000,
            mins: vec![mins],
            maxs: vec![maxs],
            rmss,
        };
        let pyramid = build_pyramid(finest);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async { write_peaks(&path, 1, &pyramid).await })
            .unwrap();

        let peaks_file = read_peaks_file(&path).expect("compat read");
        assert_eq!(peaks_file.sample_rate, SAMPLE_RATE);
        assert_eq!(peaks_file.frames_per_peak, BASE_FRAMES_PER_PEAK * 8);
        // The selected exact level is 22050/176 = 125.284... peaks/sec.
        assert_eq!(peaks_file.peaks.len(), 125);
        let big = peaks_file.peaks.iter().cloned().fold(0.0_f32, f32::max);
        assert!(
            (big - 0.9).abs() < 0.05,
            "max-abs lost the negative excursion: {big}"
        );
    }

    #[test]
    fn build_pyramid_is_finest_first_and_shrinks() {
        let finest = LevelData {
            channels: 1,
            peak_count: 8,
            mins: vec![vec![-1; 8]],
            maxs: vec![vec![1; 8]],
            rmss: vec![vec![quantize_rms(0.5); 8]],
        };
        let pyramid = build_pyramid(finest);
        assert_eq!(pyramid[0].0, BASE_FRAMES_PER_PEAK);
        // Frames per peak strictly increases while peak_count shrinks.
        for w in pyramid.windows(2) {
            assert_eq!(w[1].0, w[0].0 * 2, "timebase must double exactly");
            assert!(w[1].1.peak_count <= w[0].1.peak_count);
            assert_eq!(w[1].1.rmss[0].len(), w[1].1.peak_count as usize);
        }
        assert!(pyramid.last().unwrap().1.peak_count >= 1);
    }

    #[test]
    fn long_duration_lods_preserve_exact_pcm_timebase() {
        // Same decoded frame count as the 124.9s regression asset. Every LOD
        // must cover the source with less than one peak of tail padding.
        let source_frames: u64 = 2_754_663;
        let finest_count = source_frames.div_ceil(BASE_FRAMES_PER_PEAK as u64) as usize;
        let finest = LevelData {
            channels: 1,
            peak_count: finest_count as u32,
            mins: vec![vec![0; finest_count]],
            maxs: vec![vec![0; finest_count]],
            rmss: vec![vec![0; finest_count]],
        };
        let pyramid = build_pyramid(finest);
        for (frames_per_peak, level) in pyramid {
            let covered_frames = level.peak_count as u64 * frames_per_peak as u64;
            assert!(covered_frames >= source_frames);
            assert!(
                covered_frames - source_frames < frames_per_peak as u64,
                "level {frames_per_peak} padded by more than one peak"
            );
            let pps = SAMPLE_RATE as f64 / frames_per_peak as f64;
            let covered_seconds = level.peak_count as f64 / pps;
            let exact_seconds = covered_frames as f64 / SAMPLE_RATE as f64;
            assert!((covered_seconds - exact_seconds).abs() < 1e-12);
        }
    }
}
