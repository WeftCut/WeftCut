//! Long audio on a network engine is transcribed in pieces cut at quiet points.
//!
//! An upload has limits a local sidecar never meets: OpenAI refuses more than
//! 25 MB (13 minutes of the 16 kHz mono WAV every engine is fed), a
//! self-hosted server has a limit of its own, and one request over an hour of
//! audio is one timeout away from losing all of it. So a network engine
//! ([`Locality::is_network`](super::Locality::is_network)) receives at most
//! [`PIECE_SECS`] at a time: each cut sits at the quietest
//! [`QUIET_WINDOW_MS`] window within [`SEARCH_SECS`] of a piece boundary, so it
//! falls in a pause rather than through a word, and a tail shorter than
//! [`MIN_TAIL_SECS`] joins the piece before it. Pieces run one after another;
//! their transcripts are shifted by each piece's start and concatenated.
//!
//! [`plan_pieces`] is pure (PCM in, sample ranges out) so where the cuts land is
//! testable without an engine; [`transcribe_network`] is the orchestration the
//! tool layer calls. Local engines never come here: they read the file
//! themselves and have neither an upload cap nor a network timeout.

use std::ops::Range;
use std::path::Path;

use super::error::SpeechError;
use super::parse::parse_raw;
use super::transcriber::{TranscribeRequest, Transcriber};
use super::transcript::{Transcript, WordTiming};
use crate::compute_jobs::{ModelObserver, ModelPhase};

/// The sample rate every engine is fed (`audio_extract`): 16 kHz mono s16le.
const SAMPLE_RATE: usize = 16_000;
/// Longest piece one request carries.
pub const PIECE_SECS: usize = 600;
/// How far either side of a piece boundary a cut may move to find a pause.
pub const SEARCH_SECS: usize = 30;
/// Width of the window whose energy decides where the quietest point is.
pub const QUIET_WINDOW_MS: usize = 200;
/// A remainder shorter than this joins the piece before it instead of being a
/// request of its own.
pub const MIN_TAIL_SECS: usize = 60;

/// Plan the pieces for `pcm` (little-endian s16 samples, 16 kHz mono): sample
/// ranges covering it exactly, in order. Audio no longer than [`PIECE_SECS`] is
/// one piece.
pub fn plan_pieces(pcm: &[u8]) -> Vec<Range<usize>> {
    let n = pcm.len() / 2;
    let piece = PIECE_SECS * SAMPLE_RATE;
    if n <= piece {
        return std::iter::once(0..n).collect();
    }
    let search = SEARCH_SECS * SAMPLE_RATE;
    let mut cuts = Vec::new();
    let mut start = 0;
    while start + piece < n {
        let target = start + piece;
        let lo = target - search;
        let hi = (target + search).min(n);
        let cut = quietest_point(pcm, lo, hi, target).unwrap_or(target);
        cuts.push(cut);
        start = cut;
    }
    let mut pieces: Vec<Range<usize>> = Vec::with_capacity(cuts.len() + 1);
    let mut from = 0;
    for cut in cuts {
        pieces.push(from..cut);
        from = cut;
    }
    pieces.push(from..n);
    if pieces.len() > 1
        && pieces
            .last()
            .is_some_and(|p| p.len() < MIN_TAIL_SECS * SAMPLE_RATE)
    {
        let tail = pieces.pop().expect("len > 1");
        pieces.last_mut().expect("len > 1").end = tail.end;
    }
    pieces
}

/// The middle of the lowest-energy [`QUIET_WINDOW_MS`] window inside
/// `[lo, hi)`, stepping a quarter window at a time; among equally quiet windows
/// the one nearest `target` (the piece boundary), so audio with no pause at all
/// keeps its pieces full length. `None` when the range is narrower than one
/// window.
fn quietest_point(pcm: &[u8], lo: usize, hi: usize, target: usize) -> Option<usize> {
    let window = QUIET_WINDOW_MS * SAMPLE_RATE / 1000;
    if hi < lo + window {
        return None;
    }
    // Prefix sums of squared samples over [lo, hi): any window's energy is one
    // subtraction.
    let mut prefix = Vec::with_capacity(hi - lo + 1);
    prefix.push(0u64);
    let mut acc = 0u64;
    for i in lo..hi {
        let s = i64::from(sample(pcm, i));
        acc += (s * s) as u64;
        prefix.push(acc);
    }
    let step = (window / 4).max(1);
    let mut best: Option<(u64, usize, usize)> = None;
    let mut at = 0;
    while at + window <= hi - lo {
        let energy = prefix[at + window] - prefix[at];
        let mid = lo + at + window / 2;
        let off = mid.abs_diff(target);
        if best.is_none_or(|(e, _, o)| energy < e || (energy == e && off < o)) {
            best = Some((energy, mid, off));
        }
        at += step;
    }
    best.map(|(_, mid, _)| mid)
}

fn sample(pcm: &[u8], i: usize) -> i16 {
    i16::from_le_bytes([pcm[2 * i], pcm[2 * i + 1]])
}

/// The PCM payload of a 16 kHz mono s16 WAV, or `None` for any other format
/// (which is then sent whole — splitting is an optimization, never a
/// requirement). Walks the RIFF chunks rather than assuming a 44-byte header:
/// ffmpeg writes a `LIST` chunk before `data`.
pub fn pcm_of_wav(wav: &[u8]) -> Option<&[u8]> {
    if wav.len() < 12 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let mut at = 12;
    let mut format_ok = false;
    while at + 8 <= wav.len() {
        let id = &wav[at..at + 4];
        let len = u32::from_le_bytes(wav[at + 4..at + 8].try_into().ok()?) as usize;
        let body = at + 8;
        if id == b"fmt " {
            let f = wav.get(body..body + 16)?;
            let tag = u16::from_le_bytes([f[0], f[1]]);
            let channels = u16::from_le_bytes([f[2], f[3]]);
            let rate = u32::from_le_bytes([f[4], f[5], f[6], f[7]]);
            let bits = u16::from_le_bytes([f[14], f[15]]);
            format_ok = tag == 1 && channels == 1 && rate as usize == SAMPLE_RATE && bits == 16;
        } else if id == b"data" {
            // ffmpeg streaming to a pipe can leave the length unset; take the rest.
            let end = body.saturating_add(len).min(wav.len());
            return format_ok.then(|| &wav[body..end - (end - body) % 2]);
        }
        at = body + len + (len & 1);
    }
    None
}

/// A 16 kHz mono s16le WAV around `pcm`.
pub fn wav_of_pcm(pcm: &[u8]) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE as u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

/// [`wav_of_pcm`] over samples — for synthetic probe audio.
pub fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    wav_of_pcm(&pcm)
}

/// Transcribe `req` on a network engine: in one request when the audio fits a
/// piece, else piece by piece, reporting `Inferring { done, total }` before
/// each. The result is in the WAV's own time base (0 = its first sample), like
/// a single request's — the caller's playback-rate and timeline shifts apply
/// unchanged. Dropping the future drops the request in flight, so a cancel
/// still ends it.
pub async fn transcribe_network(
    transcriber: &dyn Transcriber,
    req: TranscribeRequest,
    observer: ModelObserver<'_>,
) -> Result<Transcript, SpeechError> {
    let wav = tokio::fs::read(&req.audio_path).await?;
    let pieces = pcm_of_wav(&wav).map(|pcm| (pcm, plan_pieces(pcm)));
    let Some((pcm, pieces)) = pieces.filter(|(_, p)| p.len() > 1) else {
        drop(wav);
        let raw = transcriber.transcribe_observed(req, observer).await?;
        return parse_raw(raw);
    };

    let dir = tempfile::Builder::new()
        .prefix("weftcut-stt-pieces")
        .tempdir()?;
    let total = pieces.len() as u32;
    let mut parts = Vec::with_capacity(pieces.len());
    for (i, range) in pieces.iter().enumerate() {
        observer(ModelPhase::Inferring {
            done: Some(i as u32),
            total: Some(total),
        });
        let path = dir.path().join(format!("piece-{i:03}.wav"));
        write_piece(&path, &pcm[range.start * 2..range.end * 2]).await?;
        let raw = transcriber
            .transcribe(TranscribeRequest {
                audio_path: path.clone(),
                ..req.clone()
            })
            .await?;
        let mut part = parse_raw(raw)?;
        part.shift(samples_to_us(range.start));
        parts.push(part);
        // A piece is read once; do not hold an hour of audio twice on disk.
        let _ = tokio::fs::remove_file(&path).await;
    }
    Ok(concat(parts))
}

async fn write_piece(path: &Path, pcm: &[u8]) -> Result<(), SpeechError> {
    tokio::fs::write(path, wav_of_pcm(pcm)).await?;
    Ok(())
}

fn samples_to_us(samples: usize) -> i64 {
    (samples as i64).saturating_mul(1_000_000) / SAMPLE_RATE as i64
}

/// Join the pieces' transcripts, already shifted onto the whole WAV's time
/// base. `word_timing` is the pieces' common provenance; pieces that disagree
/// make it `InterpolatedFromCue` (the weaker claim that is still true of every
/// word), and silent pieces have no say. The language is the first one any
/// piece reported.
pub fn concat(parts: Vec<Transcript>) -> Transcript {
    let mut timing: Option<WordTiming> = None;
    let mut language = None;
    let mut segments = Vec::new();
    for part in parts {
        if !part.segments.is_empty() {
            timing = match timing {
                None => Some(part.word_timing),
                Some(t) if t == part.word_timing => Some(t),
                Some(_) => Some(WordTiming::InterpolatedFromCue),
            };
        }
        if language.is_none() {
            language = part.language;
        }
        segments.extend(part.segments);
    }
    Transcript {
        segments,
        language,
        word_timing: timing.unwrap_or(WordTiming::None),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::speech::parse::RawTranscript;
    use crate::speech::transcript::{Segment, Word};

    const SR: usize = SAMPLE_RATE;

    /// `secs` of loud noise-ish signal, with silent gaps at the given
    /// `(start_s, len_ms)` spots.
    fn pcm(secs: f64, gaps: &[(f64, usize)]) -> Vec<u8> {
        let n = (secs * SR as f64) as usize;
        let mut samples: Vec<i16> = (0..n)
            .map(|i| if i % 7 < 3 { 8_000 } else { -8_000 })
            .collect();
        for &(at, ms) in gaps {
            let a = (at * SR as f64) as usize;
            let b = (a + ms * SR / 1000).min(n);
            samples[a..b].iter_mut().for_each(|s| *s = 0);
        }
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn short_audio_is_one_piece() {
        let one = plan_pieces(&pcm(30.0, &[]));
        assert_eq!((one.len(), one[0].start, one[0].end), (1, 0, 30 * SR));
        let exactly = pcm(PIECE_SECS as f64, &[]);
        assert_eq!(plan_pieces(&exactly).len(), 1);
    }

    #[test]
    fn the_cut_lands_in_a_silence_off_the_boundary() {
        // A 400 ms pause 17 s before the 600 s boundary.
        let audio = pcm(900.0, &[(583.0, 400)]);
        let pieces = plan_pieces(&audio);
        assert_eq!(pieces.len(), 2);
        let cut_s = pieces[0].end as f64 / SR as f64;
        assert!((583.0..583.4).contains(&cut_s), "cut at {cut_s}s");
        assert_eq!(pieces[1].start, pieces[0].end, "contiguous");
        assert_eq!(pieces[1].end, 900 * SR, "covers everything");
    }

    #[test]
    fn without_a_pause_the_cut_still_stays_in_the_search_window() {
        let pieces = plan_pieces(&pcm(1300.0, &[]));
        assert_eq!(pieces.len(), 3);
        for (i, p) in pieces.iter().take(2).enumerate() {
            let target = p.start + PIECE_SECS * SR;
            let off = p.end.abs_diff(target);
            assert!(off <= SEARCH_SECS * SR, "cut {i} is {off} samples off");
            // Uniform signal: no window is quieter, so the boundary itself wins
            // (within one step) rather than the first window of the search.
            assert!(off <= QUIET_WINDOW_MS * SR / 1000, "cut {i} drifted {off}");
        }
    }

    #[test]
    fn a_short_tail_joins_the_piece_before_it() {
        // 630 s: the remainder after a ~600 s cut is ~30 s < MIN_TAIL_SECS.
        let pieces = plan_pieces(&pcm(630.0, &[]));
        assert_eq!(
            (pieces.len(), pieces[0].start, pieces[0].end),
            (1, 0, 630 * SR)
        );
    }

    #[test]
    fn wav_round_trips_and_other_formats_are_not_split() {
        let data = pcm(1.0, &[]);
        let wav = wav_of_pcm(&data);
        assert_eq!(pcm_of_wav(&wav), Some(&data[..]));
        // Stereo → not ours to split.
        let mut stereo = wav.clone();
        stereo[22] = 2;
        assert_eq!(pcm_of_wav(&stereo), None);
        assert_eq!(pcm_of_wav(b"not a wav"), None);
        // A LIST chunk before `data` (ffmpeg's habit) is skipped.
        let mut listed = wav[..36].to_vec();
        listed.extend_from_slice(b"LIST");
        listed.extend_from_slice(&4u32.to_le_bytes());
        listed.extend_from_slice(b"INFO");
        listed.extend_from_slice(&wav[36..]);
        assert_eq!(pcm_of_wav(&listed), Some(&data[..]));
    }

    fn seg(a: i64, b: i64, text: &str) -> Segment {
        Segment {
            t_start_us: a,
            t_end_us: b,
            text: text.into(),
            words: vec![Word {
                t_start_us: a,
                t_end_us: b,
                text: text.into(),
            }],
        }
    }

    #[test]
    fn concat_keeps_order_first_language_and_the_weakest_shared_timing() {
        let t = |segs: Vec<Segment>, lang: Option<&str>, timing| Transcript {
            segments: segs,
            language: lang.map(Into::into),
            word_timing: timing,
        };
        let joined = concat(vec![
            t(vec![seg(0, 1, "a")], Some("en"), WordTiming::Exact),
            t(vec![], Some("fr"), WordTiming::None), // silent piece: no say
            t(vec![seg(5, 6, "b")], None, WordTiming::Exact),
        ]);
        assert_eq!(joined.word_timing, WordTiming::Exact);
        assert_eq!(joined.language.as_deref(), Some("en"));
        assert_eq!(joined.segments.len(), 2);
        let mixed = concat(vec![
            t(vec![seg(0, 1, "a")], None, WordTiming::Exact),
            t(vec![seg(5, 6, "b")], None, WordTiming::InterpolatedFromCue),
        ]);
        assert_eq!(mixed.word_timing, WordTiming::InterpolatedFromCue);
        assert_eq!(concat(vec![]).word_timing, WordTiming::None);
    }

    /// Answers each piece with one SRT cue spanning its whole duration, and
    /// records the durations it was sent.
    struct PieceEcho(Mutex<Vec<usize>>);

    #[async_trait]
    impl Transcriber for PieceEcho {
        async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError> {
            let wav = tokio::fs::read(&req.audio_path).await?;
            let n = pcm_of_wav(&wav).expect("piece is a WAV").len() / 2;
            self.0.lock().unwrap().push(n);
            let secs = n / SR;
            Ok(RawTranscript::Srt(format!(
                "1\n00:00:00,000 --> 00:{:02}:{:02},000\npiece\n",
                secs / 60,
                secs % 60
            )))
        }
    }

    #[tokio::test]
    async fn long_audio_is_sent_in_pieces_and_shifted_back_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.wav");
        tokio::fs::write(
            &path,
            wav_of_pcm(&pcm(1300.0, &[(598.0, 400), (1199.0, 400)])),
        )
        .await
        .unwrap();
        let echo = PieceEcho(Mutex::new(Vec::new()));
        let phases = Mutex::new(Vec::new());
        let t = transcribe_network(
            &echo,
            TranscribeRequest {
                audio_path: path,
                language: None,
                want_word_timing: true,
            },
            &|p| phases.lock().unwrap().push(p),
        )
        .await
        .unwrap();

        let sent = echo.0.lock().unwrap().clone();
        assert_eq!(sent.len(), 3);
        assert_eq!(
            sent.iter().sum::<usize>(),
            1300 * SR,
            "every sample sent once"
        );
        assert_eq!(t.segments.len(), 3);
        // The second piece's cue starts where the first piece ended.
        let first_end_us = samples_to_us(sent[0]);
        assert_eq!(t.segments[1].t_start_us, first_end_us);
        assert!((598_000_000..598_400_000).contains(&first_end_us));
        assert_eq!(
            *phases.lock().unwrap(),
            (0..3)
                .map(|i| ModelPhase::Inferring {
                    done: Some(i),
                    total: Some(3)
                })
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn short_audio_is_one_observed_request() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("short.wav");
        tokio::fs::write(&path, wav_of_pcm(&pcm(5.0, &[])))
            .await
            .unwrap();
        let echo = PieceEcho(Mutex::new(Vec::new()));
        let phases = Mutex::new(Vec::new());
        let t = transcribe_network(
            &echo,
            TranscribeRequest {
                audio_path: path,
                language: None,
                want_word_timing: true,
            },
            &|p| phases.lock().unwrap().push(p),
        )
        .await
        .unwrap();
        assert_eq!(echo.0.lock().unwrap().len(), 1);
        assert_eq!(t.segments.len(), 1);
        assert_eq!(*phases.lock().unwrap(), vec![ModelPhase::INFERRING]);
    }
}
