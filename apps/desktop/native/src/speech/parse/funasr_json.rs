//! sherpa-onnx-offline (FunASR Paraformer) JSON → [`Transcript`], with exact
//! per-token (Mandarin: per-character) timing, cut into readable cues.
//!
//! ## Wire contract with the sherpa-onnx-offline sidecar
//!
//! `sherpa-onnx-offline` prints ONE JSON object **to stdout** per input WAV (the
//! wav filename and progress/RTF logs go to stderr), so the sidecar captures
//! stdout verbatim and hands it here untouched — no unit conversion in the
//! backend. This path is NOT runnable in CI, so the schema below is pinned by a
//! committed capture of a real run ([`SAMPLE_LONG`]), exactly as
//! `whisper_json.rs` pins whisper.cpp's.
//!
//! The object is `OfflineRecognitionResult::AsJsonString`. We read only the four
//! fields we need (`text`, `timestamps`, `tokens`, optional `durations`) and
//! ignore the rest (`lang` is read best-effort; `emotion`, `event`,
//! `ys_log_probs`, `words`, `segment_*` are ignored):
//!
//! ```json
//! { "text": "对我做了介绍",
//!   "timestamps": [0.00, 0.32, 0.64, 0.96, 1.20, 1.52],   // SECONDS
//!   "tokens": ["对", "我", "做", "了", "介", "绍"] }
//! ```
//!
//! - `timestamps[i]` is the ONSET of `tokens[i]`, in **seconds** (sherpa prints
//!   them `std::fixed` at 2 decimals). We multiply by 1_000_000 to reach the
//!   microseconds the rest of the pipeline uses.
//! - `tokens` align 1:1 with `timestamps`. Paraformer-zh models Chinese per
//!   character; Latin arrives as BPE pieces marked by a `@@` SUFFIX (`ye@@`,
//!   `ster@@`, `day`). [`build_words`] merges those back into whole words,
//!   because the marker never appears in the engine's own `text` — a `Word` that
//!   kept it could not be located in the cue text that downstream word-span
//!   alignment searches, and every mixed zh/en cue would lose its timing.
//! - sherpa reports no token END. `durations` is in the schema but comes back
//!   EMPTY for Paraformer-zh, so [`build_words`] infers one and caps it at
//!   [`MAX_TOKEN_US`].
//!
//! ## Why this parser segments
//!
//! sherpa-onnx-offline returns one result per WAV and its CLI has no VAD flag,
//! so the engine hands over a whole clip as a single unpunctuated run — for a
//! five-minute interview, one caption layer holding a thousand characters. Every
//! other backend segments itself (whisper.cpp's `transcription[]`, SRT's cues),
//! so the one-cue-per-segment contract downstream had nothing to work with here
//! and faithfully produced one enormous cue.
//!
//! Splitting on punctuation is not available: the shipped `tokens.txt` holds
//! 8404 entries and not one CJK punctuation mark, so this model cannot emit a
//! sentence break. The signal it does carry is the silence between token onsets
//! — the same quantity a VAD thresholds. Measured against
//! `sherpa-onnx-vad-with-offline-asr` + silero on a 25.8 s mixed zh/en sample,
//! [`MIN_SILENCE_US`] reproduces that binary's segmentation exactly: the same
//! six runs, the same text in each, boundaries inside its speech padding —
//! [`MAX_CUE_CHARS`] then subdivides two of them for readability, and because
//! the caps only ever ADD a break, every boundary the VAD found survives into
//! the cues (which is what the test asserts). It gets there without a VAD
//! model, without a second process, and without the per-token
//! timing that the VAD binary's `start -- end: text` line output discards — it
//! offers no flag to keep them, so routing through it would drop this backend to
//! [`WordTiming::None`] and take caption text-correction down with it.

use serde::Deserialize;

use super::TranscriptParser;
use crate::speech::error::SpeechError;
use crate::speech::transcript::{Segment, Transcript, Word, WordTiming};

/// Silence that ends a cue, in microseconds — the hole between one token's end
/// and the next token's onset. 0.5 s is silero-vad's own `min_silence_duration`
/// default, and this measures the same thing on the timestamps the ASR already
/// produced (see the module note for the run that verified the two agree).
const MIN_SILENCE_US: i64 = 500_000;

/// Upper bound on one token's spoken length when `durations` is absent, in
/// microseconds. Paraformer reports onsets only, so a token's end has to come
/// from the NEXT onset — which across a pause would stretch a sentence's last
/// syllable over the whole silence, and leaves the final token of all with no
/// successor and therefore zero width. A zero-width word is not cosmetic:
/// `timingFor` in textCorrection.ts voids a caption whose words include one, so
/// every Paraformer cue was losing its timing metadata. 0.3 s sits well above a
/// Mandarin syllable or a BPE piece (both ~0.12–0.20 s in the committed
/// capture) while still ending the cue on the speech.
const MAX_TOKEN_US: i64 = 300_000;

/// Readability caps for one cue: the span and the character count past which a
/// run gets broken up even though no gap in it reached [`MIN_SILENCE_US`].
/// Without them a passage of continuous speech — a read voiceover, a fast
/// talker — would still land as one unreadable layer, which is the defect this
/// parser exists to prevent. 6 s is the long-standing subtitle convention; 24
/// characters is roughly the one-and-a-half lines of CJK that reads as a
/// caption rather than a paragraph, and matches what the mainstream editors
/// put on screen. The count is characters, not display columns, so a mixed
/// zh/en cue is measured a little generously — erring toward fewer, longer
/// cues rather than chopping Latin text that reads fine at that length.
///
/// The character cap is the one that actually fires on natural speech: on the
/// committed capture it subdivides two of the six silence-delimited runs, and
/// both new breaks land on a phrase boundary the speaker paused at too briefly
/// to clear [`MIN_SILENCE_US`]. A run with no acoustic hole ANYWHERE has no
/// evidence to break on and falls to the midpoint tie-break in [`emit_cue`],
/// which in CJK can land inside a word; that is the price of guaranteeing a
/// readable cue, and it is bounded to runs that were already too long.
const MAX_CUE_US: i64 = 6_000_000;
const MAX_CUE_CHARS: usize = 24;

pub struct FunAsrParser;

impl TranscriptParser for FunAsrParser {
    fn parse(&self, raw: &str) -> Result<Transcript, SpeechError> {
        let result: FunAsrResult = serde_json::from_str(raw.trim())
            .map_err(|e| SpeechError::Parse(format!("sherpa-onnx-offline JSON: {e}")))?;

        let words = build_words(&result.tokens, &result.timestamps, &result.durations);
        let text = result.text.trim().to_string();

        // Cue text is rebuilt from the tokens, so a cue's words are exactly the
        // characters of its own text. Guard that rebuild against a token stream
        // that is NOT a faithful decomposition of the engine's `text`: a future
        // model, a different BPE marker, or an inverse-text-normalization pass
        // that rewrites `text` alone would otherwise make every rebuilt cue
        // quietly wrong. When the whole-transcript rebuild disagrees, fall back
        // to one segment carrying the engine's own text — what this parser
        // produced before it segmented at all, and still correct, just coarse.
        //
        // A result with no usable timestamps yields NO segments, text or not: a
        // cue that cannot be placed on the timeline is not a cue. It used to
        // become a zero-width segment, which `apply_transcripts` then refused
        // outright, failing a whole multi-clip run over one such clip.
        let segments = if words.is_empty() {
            Vec::new()
        } else if squash_ws(&join_words(&words)) == squash_ws(&text) {
            split_into_cues(words)
        } else {
            let t_start_us = words[0].t_start_us;
            let t_end_us = words[words.len() - 1].t_end_us;
            vec![Segment {
                t_start_us,
                t_end_us,
                text,
                words,
            }]
        };

        Ok(Transcript {
            segments,
            language: result.lang.filter(|l| !l.is_empty() && l != "auto"),
            word_timing: WordTiming::Exact,
        })
    }
}

/// Zip sherpa's parallel `tokens` / `timestamps` (and optional `durations`) into
/// words, merging BPE continuation pieces (`ye@@` + `ster@@` + `day` →
/// `yesterday`, spanning the first piece's onset to the last piece's end).
///
/// Token i's end: `durations[i]` when the model reports one (uncapped — that is
/// the engine's own measurement), else the next onset clamped to
/// [`MAX_TOKEN_US`], else — for the final token, which has no successor —
/// exactly [`MAX_TOKEN_US`]. Every word comes out strictly wider than zero.
/// Empty/whitespace tokens are skipped.
fn build_words(tokens: &[String], timestamps: &[f64], durations: &[f64]) -> Vec<Word> {
    let n = tokens.len().min(timestamps.len());
    let use_durations = durations.len() >= n;
    let mut words: Vec<Word> = Vec::with_capacity(n);
    // The word still open because its last piece carried the `@@` marker.
    let mut open: Option<Word> = None;
    for i in 0..n {
        let raw = tokens[i].trim();
        if raw.is_empty() {
            continue;
        }
        let (piece, joins_next) = match raw.strip_suffix("@@") {
            Some(head) => (head, true),
            None => (raw, false),
        };
        let t_start_us = secs_to_us(timestamps[i]);
        let t_end_us = if use_durations {
            secs_to_us(timestamps[i] + durations[i])
        } else if i + 1 < n {
            secs_to_us(timestamps[i + 1]).min(t_start_us + MAX_TOKEN_US)
        } else {
            t_start_us + MAX_TOKEN_US
        }
        .max(t_start_us + 1);
        match &mut open {
            Some(w) => {
                w.text.push_str(piece);
                w.t_end_us = t_end_us;
            }
            None => {
                open = Some(Word {
                    t_start_us,
                    t_end_us,
                    text: piece.to_string(),
                })
            }
        }
        if !joins_next {
            push_word(&mut words, open.take());
        }
    }
    // A trailing `@@` with nothing after it (truncated output) still lands.
    push_word(&mut words, open.take());
    words
}

fn push_word(words: &mut Vec<Word>, word: Option<Word>) {
    if let Some(w) = word {
        if !w.text.is_empty() {
            words.push(w);
        }
    }
}

/// Cut a flat word list into cues at every silence of at least
/// [`MIN_SILENCE_US`]. Each run is then handed to [`emit_cue`], which enforces
/// the readability caps.
fn split_into_cues(words: Vec<Word>) -> Vec<Segment> {
    let mut cues = Vec::new();
    let mut run: Vec<Word> = Vec::new();
    for w in words {
        let ends_the_cue = run
            .last()
            .is_some_and(|p| w.t_start_us - p.t_end_us >= MIN_SILENCE_US);
        if ends_the_cue {
            emit_cue(&mut cues, std::mem::take(&mut run));
        }
        run.push(w);
    }
    emit_cue(&mut cues, run);
    cues
}

/// Push one run as a cue, splitting it first if it is too long to read.
///
/// The cut goes at the run's WIDEST interior hole, not at the cap itself: once
/// no gap reached [`MIN_SILENCE_US`], the longest breath left is the best break
/// available, and slicing mid-phrase at an arbitrary character count is the
/// worst. Ties break toward the middle of the run, so a stretch of perfectly
/// even speech halves instead of shedding one word at a time. Recurses, so a
/// long monologue comes apart at its N largest pauses rather than just one.
fn emit_cue(cues: &mut Vec<Segment>, run: Vec<Word>) {
    if run.is_empty() {
        return;
    }
    let t_start_us = run[0].t_start_us;
    let t_end_us = run[run.len() - 1].t_end_us;
    let text = join_words(&run);
    if run.len() > 1 && (t_end_us - t_start_us > MAX_CUE_US || text.chars().count() > MAX_CUE_CHARS)
    {
        let mid = (run.len() / 2) as i64;
        let at = (1..run.len())
            .max_by_key(|&i| {
                (
                    run[i].t_start_us - run[i - 1].t_end_us,
                    -(i as i64 - mid).abs(),
                )
            })
            .expect("run.len() > 1 leaves at least one interior boundary");
        let mut head = run;
        let tail = head.split_off(at);
        emit_cue(cues, head);
        emit_cue(cues, tail);
        return;
    }
    cues.push(Segment {
        t_start_us,
        t_end_us,
        text,
        words: run,
    });
}

/// Re-join words the way sherpa's own detokenizer does, so a cue's text matches
/// the engine's `text` character for character: Chinese runs together, and a
/// space goes wherever a Latin word abuts anything. Pinned by [`SAMPLE_LONG`],
/// whose rebuild is asserted equal to the `text` the engine printed beside it.
fn join_words(words: &[Word]) -> String {
    let mut out = String::new();
    for w in words {
        let piece = w.text.trim();
        if piece.is_empty() {
            continue;
        }
        if !out.is_empty() && (is_latin(out.chars().next_back()) || is_latin(piece.chars().next()))
        {
            out.push(' ');
        }
        out.push_str(piece);
    }
    out
}

fn is_latin(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric())
}

fn squash_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn secs_to_us(secs: f64) -> i64 {
    (secs * 1_000_000.0).round() as i64
}

// ── sherpa-onnx-offline result deserialization (tolerant: unknown fields
//    ignored, missing fields default) ──────────────────────────────────────
#[derive(Deserialize)]
struct FunAsrResult {
    /// The engine's own detokenized transcript. No longer the source of cue text
    /// — cues are rebuilt from `tokens` so each carries only its own words — but
    /// still read, as the reference [`join_words`] is checked against.
    #[serde(default)]
    text: String,
    /// Per-token ONSET times, in SECONDS.
    #[serde(default)]
    timestamps: Vec<f64>,
    /// Optional per-token durations, in SECONDS. EMPTY for Paraformer-zh; used
    /// only when it aligns with `timestamps`.
    #[serde(default)]
    durations: Vec<f64>,
    #[serde(default)]
    tokens: Vec<String>,
    /// Present for language-aware models (e.g. SenseVoice); empty for
    /// Paraformer-zh.
    #[serde(default)]
    lang: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // A committed sherpa-onnx-offline Paraformer-zh sample: full `text`, a
    // per-character `timestamps` array (seconds), and the matching `tokens`.
    // Extra fields (`lang`, `emotion`, `event`, `words`) are present to prove
    // they're ignored tolerantly.
    const SAMPLE: &str = r#"{
        "lang": "",
        "emotion": "",
        "event": "",
        "text": "对我做了介绍",
        "timestamps": [0.00, 0.32, 0.64, 0.96, 1.20, 1.52],
        "tokens": ["对", "我", "做", "了", "介", "绍"],
        "words": []
    }"#;

    /// A REAL `sherpa-onnx-offline` capture: Paraformer-zh on 25.8 s of mixed
    /// Mandarin/English built by concatenating four of the model's own
    /// `test_wavs` with 0.8 s of silence between them. `durations` comes back
    /// empty, `tokens` carry BPE `@@` pieces for the English, and there is not
    /// one punctuation mark in 115 characters — every property this
    /// parser has to cope with, in the engine's own words.
    const SAMPLE_LONG: &str = r#"{
        "lang": "", "emotion": "", "event": "",
        "text": "对我做了介绍啊那么我想说的是呢大家如果对我的研究感兴趣呢重点呢想谈三个问题首先呢就是这一轮全球金融动荡的表现深入的分析这一次全球金融动荡背后的根源 yesterday was 星期一 today is tuesday 明天是星期三",
        "timestamps": [
            0.32, 0.50, 0.62, 0.74, 0.86, 1.02, 1.32, 1.74, 1.92, 2.12, 2.22, 2.36,
            2.52, 2.64, 2.76, 3.18, 3.36, 3.54, 3.62, 3.78, 3.86, 3.94, 4.04, 4.12,
            4.26, 4.40, 4.60, 4.78, 6.54, 6.70, 6.82, 6.96, 7.12, 7.32, 7.42, 7.62,
            7.72, 8.50, 8.68, 8.86, 9.00, 9.16, 9.40, 9.52, 9.64, 9.84, 9.98, 10.18,
            10.28, 10.42, 10.52, 10.64, 10.80, 11.00, 12.62, 12.86, 12.98, 13.14,
            13.40, 13.86, 14.06, 14.24, 14.74, 15.02, 15.22, 15.32, 15.50, 15.62,
            15.80, 15.90, 16.02, 16.16, 16.26, 17.94, 18.24, 18.48, 18.82, 19.92,
            20.10, 20.40, 21.20, 21.72, 22.38, 22.68, 22.80, 23.42, 23.64, 23.94,
            24.52, 24.72, 24.96
        ],
        "durations": [],
        "tokens": [
            "对", "我", "做", "了", "介", "绍", "啊", "那", "么", "我", "想", "说", "的", "是", "呢",
            "大", "家", "如", "果", "对", "我", "的", "研", "究", "感", "兴", "趣", "呢", "重", "点",
            "呢", "想", "谈", "三", "个", "问", "题", "首", "先", "呢", "就", "是", "这", "一", "轮",
            "全", "球", "金", "融", "动", "荡", "的", "表", "现", "深", "入", "的", "分", "析", "这",
            "一", "次", "全", "球", "金", "融", "动", "荡", "背", "后", "的", "根", "源", "ye@@",
            "ster@@", "day", "was", "星", "期", "一", "today", "is", "tu@@", "es@@",
            "day", "明", "天", "是", "星", "期", "三"
        ],
        "ys_log_probs": [], "words": []
    }"#;

    #[test]
    fn parses_char_level_exact_words_secs_to_us() {
        let t = FunAsrParser.parse(SAMPLE).expect("parse");
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.language, None, "empty lang → None");
        // No gap in this sample reaches MIN_SILENCE_US and it is well under both
        // caps, so it stays one cue — the shape this parser always produced.
        assert_eq!(t.segments.len(), 1);
        let seg = &t.segments[0];
        assert_eq!(seg.text, "对我做了介绍");
        // Six characters, six words — char-granular, granularity-agnostic Word.
        assert_eq!(seg.words.len(), 6);
        assert_eq!(seg.words[0].text, "对");
        assert_eq!(seg.words[0].t_start_us, 0);
        // The next onset is 0.32 s away, past MAX_TOKEN_US, so "对" ends on its
        // cap 20 ms short of it rather than being credited with the whole gap.
        assert_eq!(seg.words[0].t_end_us, MAX_TOKEN_US);
        assert_eq!(seg.words[1].text, "我");
        assert_eq!(seg.words[1].t_start_us, 320_000); // 0.32 s → µs
                                                      // The last token has no successor, so it takes the MAX_TOKEN_US tail
                                                      // rather than the zero width that used to void the cue's timing.
        assert_eq!(seg.words[5].text, "绍");
        assert_eq!(seg.words[5].t_start_us, 1_520_000);
        assert_eq!(seg.words[5].t_end_us, 1_520_000 + MAX_TOKEN_US);
        assert!(
            seg.words.iter().all(|w| w.t_end_us > w.t_start_us),
            "no zero-width word survives: textCorrection.ts voids a cue that has one"
        );
        // Segment spans first word start .. last word end.
        assert_eq!(seg.t_start_us, 0);
        assert_eq!(seg.t_end_us, 1_520_000 + MAX_TOKEN_US);
    }

    /// The whole point of this parser's segmentation, measured rather than
    /// assumed: `sherpa-onnx-vad-with-offline-asr` + silero cut the committed
    /// 25.8 s capture into these six runs, and [`MIN_SILENCE_US`] finds the
    /// same six from the timestamps alone — boundaries within the VAD's speech
    /// padding (its first run opens at 0.294 s where the first token's onset is
    /// 0.32 s). Before this, the same JSON produced ONE cue of 87 words.
    ///
    /// Asserted as containment, not equality, because the readability caps then
    /// subdivide two of these runs. That direction is the durable property: a
    /// cap only ever ADDS a break inside a run, so retuning [`MAX_CUE_CHARS`]
    /// can never dissolve a boundary the VAD agreed with.
    #[test]
    fn a_real_capture_is_cut_where_the_vad_binary_cuts_it() {
        const VAD_RUNS: [(i64, i64); 6] = [
            (320_000, 5_080_000),
            (6_540_000, 11_300_000),
            (12_620_000, 16_560_000),
            (17_940_000, 19_120_000),
            (19_920_000, 20_700_000),
            (21_200_000, 25_260_000),
        ];
        let t = FunAsrParser.parse(SAMPLE_LONG).expect("parse");
        assert_eq!(
            t.word_timing,
            WordTiming::Exact,
            "per-token timing survives"
        );
        let starts: Vec<i64> = t.segments.iter().map(|s| s.t_start_us).collect();
        let ends: Vec<i64> = t.segments.iter().map(|s| s.t_end_us).collect();
        for (start, end) in VAD_RUNS {
            assert!(starts.contains(&start), "a cue still opens at {start}");
            assert!(ends.contains(&end), "a cue still closes at {end}");
        }
    }

    /// The cues as they reach the timeline. Two of the six silence-delimited
    /// runs are over [`MAX_CUE_CHARS`], and both come apart at a phrase
    /// boundary the speaker paused at too briefly to clear [`MIN_SILENCE_US`] —
    /// which is exactly what the widest-hole rule in [`emit_cue`] is for.
    #[test]
    fn the_caps_subdivide_a_long_run_at_its_phrase_boundary() {
        let t = FunAsrParser.parse(SAMPLE_LONG).expect("parse");
        let got: Vec<(i64, i64, &str)> = t
            .segments
            .iter()
            .map(|s| (s.t_start_us, s.t_end_us, s.text.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (320_000, 3_060_000, "对我做了介绍啊那么我想说的是呢"),
                (3_180_000, 5_080_000, "大家如果对我的研究感兴趣呢"),
                (6_540_000, 8_020_000, "重点呢想谈三个问题"),
                (8_500_000, 11_300_000, "首先呢就是这一轮全球金融动荡的表现"),
                (
                    12_620_000,
                    16_560_000,
                    "深入的分析这一次全球金融动荡背后的根源"
                ),
                (17_940_000, 19_120_000, "yesterday was"),
                (19_920_000, 20_700_000, "星期一"),
                (21_200_000, 25_260_000, "today is tuesday 明天是星期三"),
            ]
        );
        for seg in &t.segments {
            assert!(
                seg.text.chars().count() <= MAX_CUE_CHARS
                    && seg.t_end_us - seg.t_start_us <= MAX_CUE_US,
                "every cue reaching the timeline fits a caption: {seg:?}"
            );
        }
    }

    /// Every cue must be placeable and internally consistent, because
    /// `apply_transcripts` refuses a non-positive span outright and
    /// `readCaptionTiming` / `timingFor` refuse a word that is zero-width or
    /// reaches past its cue.
    #[test]
    fn every_cue_is_positive_and_holds_its_own_words() {
        let t = FunAsrParser.parse(SAMPLE_LONG).expect("parse");
        for seg in &t.segments {
            assert!(seg.t_end_us > seg.t_start_us, "placeable cue: {seg:?}");
            assert!(!seg.words.is_empty());
            assert_eq!(seg.words[0].t_start_us, seg.t_start_us);
            assert_eq!(seg.words[seg.words.len() - 1].t_end_us, seg.t_end_us);
            for w in &seg.words {
                assert!(w.t_end_us > w.t_start_us, "zero-width word: {w:?}");
                assert!(w.t_start_us >= seg.t_start_us && w.t_end_us <= seg.t_end_us);
                assert!(
                    seg.text.contains(w.text.trim()),
                    "word {:?} must be locatable in its own cue text {:?}",
                    w.text,
                    seg.text
                );
            }
        }
    }

    /// The BPE marker is a JOIN instruction, not text. `ye@@ ster@@ day` is one
    /// word spanning all three pieces — and critically its text is `yesterday`,
    /// which is what appears in the cue; a `Word` reading `ye@@` could never be
    /// found there, and textCorrection.ts would drop the cue's timing entirely.
    #[test]
    fn bpe_continuation_pieces_merge_into_one_word() {
        let t = FunAsrParser.parse(SAMPLE_LONG).expect("parse");
        let english = t
            .segments
            .iter()
            .find(|s| s.text == "yesterday was")
            .expect("the zh/en cue");
        let texts: Vec<&str> = english.words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, vec!["yesterday", "was"]);
        assert!(
            !t.segments
                .iter()
                .any(|s| s.text.contains("@@") || s.words.iter().any(|w| w.text.contains("@@"))),
            "no marker survives into a cue"
        );
        // Spans the first piece's onset to the last piece's end, not one piece's.
        assert_eq!(english.words[0].t_start_us, 17_940_000);
        assert!(english.words[0].t_end_us > 18_400_000);
    }

    /// The rebuild is only trusted because it reproduces what the engine itself
    /// printed. This is the assertion that lets cue text come from tokens.
    #[test]
    fn rejoining_every_token_reproduces_the_engine_text() {
        let raw: serde_json::Value = serde_json::from_str(SAMPLE_LONG).expect("json");
        let t = FunAsrParser.parse(SAMPLE_LONG).expect("parse");
        let words: Vec<Word> = t.segments.iter().flat_map(|s| s.words.clone()).collect();
        assert_eq!(
            squash_ws(&join_words(&words)),
            squash_ws(raw["text"].as_str().expect("text")),
        );
    }

    #[test]
    fn optional_durations_give_true_word_ends() {
        let json = r#"{
            "text": "你好",
            "timestamps": [0.10, 0.50],
            "durations": [0.30, 0.40],
            "tokens": ["你", "好"]
        }"#;
        let t = FunAsrParser.parse(json).expect("parse");
        let w = &t.segments[0].words;
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].t_start_us, 100_000);
        assert_eq!(w[0].t_end_us, 400_000); // 0.10 + 0.30 = 0.40 s
        assert_eq!(w[1].t_start_us, 500_000);
        // The engine's own duration is taken verbatim — MAX_TOKEN_US caps only
        // the end this parser INFERS, never one the model measured.
        assert_eq!(w[1].t_end_us, 900_000); // 0.50 + 0.40 = 0.90 s
    }

    /// A pause at or over MIN_SILENCE_US ends the cue; one under it does not.
    /// Measured from the previous token's END, so the tail counts: onsets 0.0
    /// and 0.7 are 0.7 s apart but only 0.4 s of that is silence.
    #[test]
    fn a_silence_ends_a_cue_and_a_short_pause_does_not() {
        let near = r#"{"text":"你好","timestamps":[0.0,0.7],"tokens":["你","好"]}"#;
        assert_eq!(
            FunAsrParser.parse(near).expect("parse").segments.len(),
            1,
            "0.7 s onset gap is only 0.4 s of silence after the 0.3 s tail"
        );
        let far = r#"{"text":"你好","timestamps":[0.0,0.9],"tokens":["你","好"]}"#;
        let t = FunAsrParser.parse(far).expect("parse");
        assert_eq!(t.segments.len(), 2, "0.6 s of silence splits");
        assert_eq!(t.segments[0].text, "你");
        assert_eq!(t.segments[1].text, "好");
    }

    /// Continuous speech with no qualifying silence still has to come apart, or
    /// a read voiceover lands as one unreadable layer. The cut goes at the
    /// widest interior hole, not at the character the cap fell on.
    #[test]
    fn an_unbroken_run_splits_at_its_widest_hole() {
        // 40 characters 0.2 s apart, with one 0.75 s hole after the 12th — that
        // hole is 0.45 s of silence, UNDER MIN_SILENCE_US, so only the cap can
        // break this run, and it must choose that hole to break it at.
        let mut tokens = Vec::new();
        let mut stamps = Vec::new();
        let mut at = 0.0_f64;
        for i in 0..40 {
            tokens.push("\"字\"".to_string());
            stamps.push(format!("{at:.2}"));
            at += if i == 11 { 0.75 } else { 0.2 };
        }
        let text: String = "字".repeat(40);
        let json = format!(
            r#"{{"text":"{text}","timestamps":[{}],"tokens":[{}]}}"#,
            stamps.join(","),
            tokens.join(",")
        );
        let t = FunAsrParser.parse(&json).expect("parse");
        assert!(t.segments.len() > 1, "40 chars must not stay one cue");
        assert_eq!(
            t.segments[0].text.chars().count(),
            12,
            "the first cut lands on the widest hole, after the 12th character"
        );
        for seg in &t.segments {
            assert!(
                seg.text.chars().count() <= MAX_CUE_CHARS,
                "cap held: {seg:?}"
            );
            assert!(
                seg.t_end_us - seg.t_start_us <= MAX_CUE_US,
                "cap held: {seg:?}"
            );
        }
        assert_eq!(
            t.segments
                .iter()
                .map(|s| s.text.chars().count())
                .sum::<usize>(),
            40,
            "splitting loses no characters"
        );
    }

    /// If the tokens stop being a faithful decomposition of `text` — a new BPE
    /// marker, an ITN pass that rewrites `text` alone — cue text rebuilt from
    /// them would be quietly wrong. Degrade to the coarse-but-correct shape
    /// instead: one cue carrying the engine's own sentence.
    #[test]
    fn a_token_stream_that_does_not_rebuild_the_text_falls_back_to_one_cue() {
        let json = r#"{
            "text": "2024 年",
            "timestamps": [0.0, 0.3, 1.4],
            "tokens": ["二", "零", "年"]
        }"#;
        let t = FunAsrParser.parse(json).expect("parse");
        assert_eq!(
            t.segments.len(),
            1,
            "no segmentation on an untrusted rebuild"
        );
        assert_eq!(t.segments[0].text, "2024 年", "the engine's text is kept");
    }

    #[test]
    fn language_tag_is_carried_when_present() {
        let json = r#"{"lang":"zh","text":"好","timestamps":[0.0],"tokens":["好"]}"#;
        let t = FunAsrParser.parse(json).expect("parse");
        assert_eq!(t.language.as_deref(), Some("zh"));
    }

    #[test]
    fn silent_clip_yields_no_segments() {
        let json = r#"{"text":"","timestamps":[],"tokens":[]}"#;
        let t = FunAsrParser.parse(json).expect("parse");
        assert!(t.segments.is_empty());
        assert_eq!(t.word_timing, WordTiming::Exact);
    }

    /// Text without timestamps cannot be placed, so it is not a cue. It used to
    /// become a zero-width segment that `apply_transcripts` then refused, taking
    /// a whole multi-clip run down with it.
    #[test]
    fn text_without_timestamps_yields_no_segments() {
        let json = r#"{"text":"喂","timestamps":[],"tokens":[]}"#;
        assert!(FunAsrParser.parse(json).expect("parse").segments.is_empty());
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        let err = FunAsrParser.parse("{not json").expect_err("should fail");
        assert!(matches!(err, SpeechError::Parse(_)));
    }
}
