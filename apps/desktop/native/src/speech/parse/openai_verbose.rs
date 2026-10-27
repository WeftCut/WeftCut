//! OpenAI-compatible `response_format=verbose_json` → [`Transcript`].
//!
//! One wire shape, three placements of the word timestamps:
//!
//! - **OpenAI** (`timestamp_granularities[]=word`): `words` is a TOP-LEVEL array
//!   `[{ word, start, end }]` beside `segments`; each word is assigned to the
//!   segment its midpoint falls in.
//! - **whisper.cpp `whisper-server`, speaches, vLLM**: `words` per segment.
//! - **Anything else**: no words at all — each segment's span is distributed
//!   over its words by length, exactly as the SRT parser does
//!   ([`super::srt::split_cue_into_words`]), and honestly labelled
//!   [`WordTiming::InterpolatedFromCue`].
//!
//! Times are SECONDS (floats) on this wire. `word_timing` is `Exact` only when
//! every segment with text got its words from the server; one interpolated
//! segment makes the whole transcript interpolated, since a consumer reads the
//! flag for the transcript, not per segment.

use serde::Deserialize;

use super::srt::split_cue_into_words;
use super::TranscriptParser;
use crate::speech::error::SpeechError;
use crate::speech::transcript::{Segment, Transcript, Word, WordTiming};

pub struct OpenAiVerboseParser;

impl TranscriptParser for OpenAiVerboseParser {
    fn parse(&self, raw: &str) -> Result<Transcript, SpeechError> {
        let body: Verbose = serde_json::from_str(raw)
            .map_err(|e| SpeechError::Parse(format!("verbose_json: {e}")))?;
        let Some(raw_segments) = body.segments else {
            return Err(SpeechError::Parse(
                "verbose_json: response has no `segments` array".into(),
            ));
        };

        let top_words: Vec<Word> = body.words.iter().filter_map(to_word).collect();
        let mut segments = Vec::with_capacity(raw_segments.len());
        let mut all_exact = true;
        for (i, seg) in raw_segments.iter().enumerate() {
            let t_start_us = secs_to_us(seg.start);
            let t_end_us = secs_to_us(seg.end).max(t_start_us);
            let text = seg.text.trim().to_string();
            let mut words: Vec<Word> = seg.words.iter().filter_map(to_word).collect();
            if words.is_empty() && !top_words.is_empty() {
                // OpenAI: claim the top-level words whose midpoint lies in this
                // segment; the last segment also takes any that trail past it.
                let next_start = raw_segments.get(i + 1).map(|s| secs_to_us(s.start));
                words = top_words
                    .iter()
                    .filter(|w| {
                        let mid = (w.t_start_us + w.t_end_us) / 2;
                        let after_start = i == 0 || mid >= t_start_us;
                        let before_next = next_start.is_none_or(|n| mid < n);
                        after_start && before_next
                    })
                    .cloned()
                    .collect();
            }
            if words.is_empty() && !text.is_empty() {
                all_exact = false;
                words = split_cue_into_words(t_start_us, t_end_us, &text);
            }
            segments.push(Segment {
                t_start_us,
                t_end_us,
                text,
                words,
            });
        }

        let word_timing = if segments.iter().all(|s| s.words.is_empty()) {
            WordTiming::None
        } else if all_exact {
            WordTiming::Exact
        } else {
            WordTiming::InterpolatedFromCue
        };
        Ok(Transcript {
            segments,
            language: body.language.as_deref().and_then(language_code),
            word_timing,
        })
    }
}

/// The language as the rest of the speech module reports it: an ISO 639-1 code.
/// OpenAI answers with the English NAME (`"english"`); whisper-server and most
/// others already answer with the code. A name this table does not know is
/// kept as sent rather than guessed at.
fn language_code(raw: &str) -> Option<String> {
    let l = raw.trim().to_ascii_lowercase();
    if l.is_empty() || l == "auto" {
        return None;
    }
    const NAMES: &[(&str, &str)] = &[
        ("english", "en"),
        ("chinese", "zh"),
        ("mandarin", "zh"),
        ("cantonese", "yue"),
        ("japanese", "ja"),
        ("korean", "ko"),
        ("spanish", "es"),
        ("french", "fr"),
        ("german", "de"),
        ("portuguese", "pt"),
        ("russian", "ru"),
        ("italian", "it"),
        ("dutch", "nl"),
        ("arabic", "ar"),
        ("hindi", "hi"),
        ("vietnamese", "vi"),
        ("thai", "th"),
        ("indonesian", "id"),
        ("turkish", "tr"),
        ("polish", "pl"),
        ("ukrainian", "uk"),
    ];
    Some(
        NAMES
            .iter()
            .find(|(name, _)| *name == l)
            .map_or(l.clone(), |(_, code)| (*code).to_string()),
    )
}

fn to_word(w: &VerboseWord) -> Option<Word> {
    let text = w.word.trim();
    if text.is_empty() {
        return None;
    }
    let t_start_us = secs_to_us(w.start);
    Some(Word {
        t_start_us,
        t_end_us: secs_to_us(w.end).max(t_start_us),
        text: text.to_string(),
    })
}

fn secs_to_us(secs: f64) -> i64 {
    if secs.is_finite() {
        (secs.max(0.0) * 1_000_000.0).round() as i64
    } else {
        0
    }
}

// ── wire shape (tolerant: unknown fields ignored, missing ones default) ────

#[derive(Deserialize)]
struct Verbose {
    #[serde(default)]
    language: Option<String>,
    /// `None` when the server ignored `verbose_json` (e.g. answered plain
    /// `{ "text": … }`) — the caller's cue to fall back to SRT.
    #[serde(default)]
    segments: Option<Vec<VerboseSegment>>,
    #[serde(default)]
    words: Vec<VerboseWord>,
}

#[derive(Deserialize)]
struct VerboseSegment {
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
    #[serde(default)]
    text: String,
    #[serde(default)]
    words: Vec<VerboseWord>,
}

#[derive(Deserialize)]
struct VerboseWord {
    #[serde(default)]
    word: String,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
}

/// Whether `body` is a verbose-JSON transcript at all (an object with a
/// `segments` array) — the endpoint's test for "the server honoured
/// `response_format=verbose_json`" before it commits to this parser.
pub fn is_verbose_json(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("segments").map(serde_json::Value::is_array))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(words: &[Word]) -> Vec<&str> {
        words.iter().map(|w| w.text.as_str()).collect()
    }

    /// OpenAI whisper-1 with `timestamp_granularities[]=word`: words at the top
    /// level, assigned to segments by midpoint.
    #[test]
    fn openai_top_level_words_are_exact_and_land_in_their_segments() {
        let t = OpenAiVerboseParser
            .parse(
                r#"{"task":"transcribe","language":"english","duration":4.0,
                "text":"Hello world. Bye now.",
                "segments":[
                  {"id":0,"seek":0,"start":0.0,"end":2.0,"text":" Hello world.","tokens":[1,2]},
                  {"id":1,"seek":0,"start":2.0,"end":4.0,"text":" Bye now.","tokens":[3,4]}],
                "words":[
                  {"word":"Hello","start":0.0,"end":0.8},
                  {"word":"world","start":0.8,"end":1.9},
                  {"word":"Bye","start":2.1,"end":2.6},
                  {"word":"now","start":2.6,"end":3.5}]}"#,
            )
            .unwrap();
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].text, "Hello world.");
        assert_eq!(texts(&t.segments[0].words), ["Hello", "world"]);
        assert_eq!(texts(&t.segments[1].words), ["Bye", "now"]);
        assert_eq!(t.segments[1].words[0].t_start_us, 2_100_000);
        assert_eq!(t.segments[1].t_end_us, 4_000_000);
    }

    /// whisper.cpp `whisper-server` / speaches: words inside each segment, with
    /// whisper's leading spaces.
    #[test]
    fn per_segment_words_are_exact() {
        let t = OpenAiVerboseParser
            .parse(
                r#"{"task":"transcribe","language":"en","duration":2.0,"text":" Hi there",
                "segments":[{"id":0,"text":" Hi there","start":0.0,"end":2.0,
                  "words":[{"word":" Hi","start":0.1,"end":0.5,"probability":0.9},
                           {"word":" there","start":0.5,"end":1.2,"probability":0.8}]}]}"#,
            )
            .unwrap();
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(texts(&t.segments[0].words), ["Hi", "there"]);
        assert_eq!(t.segments[0].words[0].t_start_us, 100_000);
    }

    /// A server that honours verbose_json but has no word timestamps: segment
    /// spans are distributed like SRT cues, per character for CJK.
    #[test]
    fn segments_without_words_interpolate_including_cjk() {
        let t = OpenAiVerboseParser
            .parse(
                r#"{"language":"chinese","segments":[
                  {"start":0.0,"end":3.0,"text":"对我做了介绍"}]}"#,
            )
            .unwrap();
        assert_eq!(t.word_timing, WordTiming::InterpolatedFromCue);
        assert_eq!(t.language.as_deref(), Some("zh"));
        let words = &t.segments[0].words;
        assert_eq!(texts(words), ["对", "我", "做", "了", "介", "绍"]);
        assert_eq!(words[0].t_start_us, 0);
        assert_eq!(words[5].t_end_us, 3_000_000);
    }

    #[test]
    fn one_wordless_segment_makes_the_transcript_interpolated() {
        let t = OpenAiVerboseParser
            .parse(
                r#"{"segments":[
                  {"start":0.0,"end":1.0,"text":"a","words":[{"word":"a","start":0.0,"end":1.0}]},
                  {"start":1.0,"end":2.0,"text":"b c"}]}"#,
            )
            .unwrap();
        assert_eq!(t.word_timing, WordTiming::InterpolatedFromCue);
        assert_eq!(t.language, None);
    }

    #[test]
    fn silence_has_no_segments_and_no_word_timing() {
        let t = OpenAiVerboseParser
            .parse(r#"{"language":"english","text":"","segments":[]}"#)
            .unwrap();
        assert!(t.segments.is_empty());
        assert_eq!(t.word_timing, WordTiming::None);
    }

    #[test]
    fn a_body_without_segments_is_not_verbose_json() {
        assert!(!is_verbose_json(r#"{"text":"hello"}"#));
        assert!(!is_verbose_json("1\n00:00:00,000 --> 00:00:01,000\nhi\n"));
        assert!(is_verbose_json(r#"{"segments":[]}"#));
        assert!(OpenAiVerboseParser.parse(r#"{"text":"hello"}"#).is_err());
    }

    #[test]
    fn unknown_language_names_are_kept_and_codes_pass_through() {
        assert_eq!(language_code("english").as_deref(), Some("en"));
        assert_eq!(language_code("ZH").as_deref(), Some("zh"));
        assert_eq!(language_code("klingon").as_deref(), Some("klingon"));
        assert_eq!(language_code("auto"), None);
        assert_eq!(language_code(" "), None);
    }
}
