//! ElevenLabs Scribe JSON → [`Transcript`], with exact per-word timing, cut
//! into readable cues.
//!
//! ```json
//! { "language_code": "eng", "text": "Hi there.",
//!   "words": [ { "text": "Hi",     "start": 0.1, "end": 0.4, "type": "word" },
//!              { "text": " ",      "start": 0.4, "end": 0.5, "type": "spacing" },
//!              { "text": "there.", "start": 0.5, "end": 0.9, "type": "word" } ] }
//! ```
//!
//! Times are SECONDS and may be `null`. Scribe writes CJK one character per
//! entry, and punctuation either as its own `word` entry (one that can span a
//! whole pause) or glued to the front of the next word (`"。Finally,"`). A mark
//! is never a timed word: it joins the word before it, whose times stay its
//! own, so a pause stays a gap between words and still ends a cue. `spacing`
//! entries carry no word but say where the cue text has a space; `audio_event`
//! entries are dropped.
//!
//! Scribe returns one flat word list. Cues are cut at its sentence ends, then
//! within a sentence the way the FunASR parser cuts its own
//! ([`split_into_cues`]) — at silences, then by span and width — with a width
//! that counts a CJK character as two columns, since Scribe's output is as
//! often spaced text as CJK.

use serde::Deserialize;

use super::funasr_json::{split_into_cues, CueLimits};
use super::{is_cjk_char, TranscriptParser};
use crate::speech::error::SpeechError;
use crate::speech::transcript::{Transcript, Word, WordTiming};

/// One subtitle line: 42 columns (the broadcast convention for spaced text,
/// 21 CJK characters) over at most 6 s.
const CUE_LIMITS: CueLimits = CueLimits {
    max_us: 6_000_000,
    max_width: 42,
    width: columns,
};

pub struct ElevenLabsParser;

impl TranscriptParser for ElevenLabsParser {
    fn parse(&self, raw: &str) -> Result<Transcript, SpeechError> {
        let body: Body = serde_json::from_str(raw.trim())
            .map_err(|e| SpeechError::Parse(format!("ElevenLabs Scribe JSON: {e}")))?;
        let tokens = tokenize(body.words);
        let spaced: Vec<bool> = tokens.iter().map(|t| t.space_before).collect();
        let words = timed(tokens);
        let word_timing = if words.is_empty() {
            WordTiming::None
        } else {
            WordTiming::Exact
        };
        let mut segments: Vec<_> = sentences(words)
            .into_iter()
            .flat_map(|sentence| split_into_cues(sentence, &CUE_LIMITS))
            .collect();
        // The split keeps every word once and in order, so the flags line up.
        let mut at = 0;
        for seg in &mut segments {
            let mut text = String::new();
            for (k, w) in seg.words.iter().enumerate() {
                if k > 0 && spaced[at + k] {
                    text.push(' ');
                }
                text.push_str(&w.text);
            }
            at += seg.words.len();
            seg.text = text;
        }
        Ok(Transcript {
            segments,
            language: body.language_code.as_deref().and_then(language_code),
            word_timing,
        })
    }
}

/// A word before its times are settled.
struct Token {
    text: String,
    start: Option<i64>,
    end: Option<i64>,
    space_before: bool,
}

/// Words from Scribe's entries, with punctuation attached as the module note
/// describes. A mark with no word before it (a transcript that opens on `。`)
/// is dropped; opening marks (`“`, `(`) wait for the word after them.
fn tokenize(entries: Vec<Entry>) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    let mut spaced = false;
    let mut opening = String::new();
    for e in entries {
        match e.kind.as_str() {
            "word" => {}
            "spacing" => {
                spaced = true;
                continue;
            }
            _ => continue,
        }
        let raw = e.text.trim();
        let lead = raw
            .char_indices()
            .find(|(_, c)| !is_closing(*c))
            .map_or(raw.len(), |(i, _)| i);
        let (closing, rest) = raw.split_at(lead);
        if let Some(prev) = tokens.last_mut() {
            prev.text.push_str(closing);
        }
        if rest.is_empty() {
            continue;
        }
        if !rest.chars().any(char::is_alphanumeric) {
            if rest.starts_with(is_opening) {
                opening.push_str(rest);
            } else if let Some(prev) = tokens.last_mut() {
                prev.text.push_str(rest);
            }
            continue;
        }
        tokens.push(Token {
            text: std::mem::take(&mut opening) + rest,
            start: e.start.map(secs_to_us),
            end: e.end.map(secs_to_us),
            space_before: spaced && !tokens.is_empty(),
        });
        spaced = false;
    }
    tokens
}

/// Settle each token's times. A missing time is borrowed from the neighbours
/// — the previous word's end, the next timed word's start — rather than
/// dropping the word, whose text the cue would then lose. Every word comes out
/// strictly wider than zero: downstream caption timing voids a cue holding a
/// zero-width word.
fn timed(tokens: Vec<Token>) -> Vec<Word> {
    let next_known: Vec<Option<i64>> = {
        let mut out = vec![None; tokens.len()];
        let mut next = None;
        for (i, t) in tokens.iter().enumerate().rev() {
            out[i] = next;
            if let Some(s) = t.start.or(t.end) {
                next = Some(s);
            }
        }
        out
    };
    let mut words = Vec::with_capacity(tokens.len());
    let mut prev_end: Option<i64> = None;
    for (t, next) in tokens.into_iter().zip(next_known) {
        let t_start_us = t
            .start
            .or(prev_end.filter(|p| t.end.is_none_or(|e| *p <= e)))
            .or(t.end)
            .or(next)
            .unwrap_or(0);
        let t_end_us = t
            .end
            .or(next.filter(|n| *n > t_start_us))
            .unwrap_or(t_start_us)
            .max(t_start_us + 1);
        prev_end = Some(t_end_us);
        words.push(Word {
            t_start_us,
            t_end_us,
            text: t.text,
        });
    }
    words
}

/// Marks that close what comes before them, which Scribe sometimes glues to
/// the front of the next word.
fn is_closing(c: char) -> bool {
    matches!(
        c,
        ',' | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | '…'
            | ')'
            | ']'
            | '}'
            | '”'
            | '’'
            | '»'
            | '›'
            | '。'
            | '，'
            | '、'
            | '！'
            | '？'
            | '；'
            | '：'
            | '）'
            | '］'
            | '｝'
            | '」'
            | '』'
            | '》'
            | '〉'
            | '】'
            | '〕'
            | '〗'
            | '｡'
            | '､'
    )
}

/// Marks that open what comes after them.
fn is_opening(c: char) -> bool {
    matches!(
        c,
        '(' | '['
            | '{'
            | '“'
            | '‘'
            | '«'
            | '‹'
            | '"'
            | '\''
            | '¿'
            | '¡'
            | '（'
            | '［'
            | '｛'
            | '「'
            | '『'
            | '《'
            | '〈'
            | '【'
            | '〔'
            | '〖'
    )
}

/// Marks that end a sentence.
fn ends_sentence(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '…' | '。' | '！' | '？' | '｡')
}

/// The word list cut after every word whose text ends a sentence, closing
/// quotes and brackets aside (`slow。”`). Unlike FunASR, Scribe punctuates, so
/// a cue never has to run across a sentence end, nor break inside a sentence
/// that fits, wherever the widest pause in a run falls.
fn sentences(words: Vec<Word>) -> Vec<Vec<Word>> {
    let mut out = vec![Vec::new()];
    for w in words {
        let ends = w
            .text
            .chars()
            .rev()
            .find(|&c| !matches!(c, '”' | '’' | '"' | '\'' | ')' | '）' | '」' | '』' | '»'))
            .is_some_and(ends_sentence);
        out.last_mut().expect("never empty").push(w);
        if ends {
            out.push(Vec::new());
        }
    }
    out.retain(|s| !s.is_empty());
    out
}

/// Display columns: a CJK character or full-width mark is two.
fn columns(s: &str) -> usize {
    s.chars()
        .map(|c| {
            if is_cjk_char(c) || matches!(c, '\u{3000}'..='\u{303F}' | '\u{FF00}'..='\u{FFEF}') {
                2
            } else {
                1
            }
        })
        .sum()
}

/// The language as the rest of the speech module reports it: ISO 639-1 where
/// one exists. Scribe answers ISO 639-3 (`"zho"`, `"eng"`); a code this table
/// does not know is kept as sent rather than guessed at.
fn language_code(raw: &str) -> Option<String> {
    let l = raw.trim().to_ascii_lowercase();
    if l.is_empty() {
        return None;
    }
    const CODES: &[(&str, &str)] = &[
        ("eng", "en"),
        ("zho", "zh"),
        ("cmn", "zh"),
        ("jpn", "ja"),
        ("kor", "ko"),
        ("spa", "es"),
        ("fra", "fr"),
        ("deu", "de"),
        ("por", "pt"),
        ("rus", "ru"),
        ("ita", "it"),
        ("nld", "nl"),
        ("ara", "ar"),
        ("hin", "hi"),
        ("vie", "vi"),
        ("tha", "th"),
        ("ind", "id"),
        ("tur", "tr"),
        ("pol", "pl"),
        ("ukr", "uk"),
    ];
    Some(
        CODES
            .iter()
            .find(|(long, _)| *long == l)
            .map_or(l.clone(), |(_, short)| (*short).to_string()),
    )
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
struct Body {
    #[serde(default)]
    language_code: Option<String>,
    #[serde(default)]
    words: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start: Option<f64>,
    #[serde(default)]
    end: Option<f64>,
    #[serde(rename = "type", default = "word_kind")]
    kind: String,
}

fn word_kind() -> String {
    "word".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::transcript::Segment;

    fn parse(json: &str) -> Transcript {
        ElevenLabsParser.parse(json).expect("parses")
    }

    fn texts(words: &[Word]) -> Vec<&str> {
        words.iter().map(|w| w.text.as_str()).collect()
    }

    fn all_words(t: &Transcript) -> Vec<&Word> {
        t.segments.iter().flat_map(|s| &s.words).collect()
    }

    /// The contract every cue keeps, whatever the input: words wider than
    /// zero, inside their cue's span, each findable in the cue text.
    fn assert_well_formed(segments: &[Segment]) {
        for seg in segments {
            assert!(seg.t_end_us > seg.t_start_us, "{seg:?}");
            let mut from = 0;
            for w in &seg.words {
                assert!(w.t_end_us > w.t_start_us, "{w:?}");
                assert!(w.t_start_us >= seg.t_start_us && w.t_end_us <= seg.t_end_us);
                let at = seg.text[from..]
                    .find(&w.text)
                    .unwrap_or_else(|| panic!("{:?} not in {:?}", w.text, seg.text));
                from += at + w.text.len();
            }
        }
    }

    #[test]
    fn spaced_words_keep_their_spaces_and_lose_the_spacing_entries() {
        let t = parse(
            r#"{"language_code":"eng","language_probability":0.98,"text":"Hello, world.",
              "words":[
                {"text":"Hello,","start":0.10,"end":0.52,"type":"word","logprob":-0.1},
                {"text":" ","start":0.52,"end":0.60,"type":"spacing","logprob":0.0},
                {"text":"world.","start":0.60,"end":1.05,"type":"word","logprob":-0.2}],
              "audio_duration_secs":1.2,"transcription_id":"tx-0001"}"#,
        );
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.segments.len(), 1);
        assert_eq!(t.segments[0].text, "Hello, world.");
        assert_eq!(texts(&t.segments[0].words), ["Hello,", "world."]);
        assert_eq!(t.segments[0].words[0].t_start_us, 100_000);
        assert_eq!(t.segments[0].words[1].t_end_us, 1_050_000);
        assert_well_formed(&t.segments);
    }

    /// A comma entry spanning a pause joins the character before it without
    /// stretching it, so the pause still ends the cue.
    #[test]
    fn cjk_punctuation_spanning_a_pause_attaches_without_bridging_it() {
        let t = parse(
            r#"{"language_code":"zho","text":"你好，世界。","words":[
                {"text":"你","start":1.00,"end":1.30,"type":"word"},
                {"text":"好","start":1.30,"end":1.64,"type":"word"},
                {"text":"，","start":1.64,"end":2.42,"type":"word"},
                {"text":"世","start":2.42,"end":2.70,"type":"word"},
                {"text":"界","start":2.70,"end":3.00,"type":"word"},
                {"text":"。","start":3.00,"end":3.10,"type":"word"}]}"#,
        );
        assert_eq!(t.language.as_deref(), Some("zh"));
        let words = all_words(&t);
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["你", "好，", "世", "界。"]
        );
        assert_eq!(words[1].t_end_us, 1_640_000, "the mark adds no time");
        assert_eq!(t.segments.len(), 2, "the pause ends the cue");
        assert_eq!(t.segments[0].text, "你好，");
        assert_eq!(t.segments[1].text, "世界。");
        assert_well_formed(&t.segments);
    }

    #[test]
    fn punctuation_glued_to_the_next_word_moves_back_and_trailing_marks_stay() {
        let t = parse(
            r#"{"language_code":"eng","words":[
                {"text":"It","start":0.0,"end":0.2,"type":"word"},
                {"text":" ","start":0.2,"end":0.25,"type":"spacing"},
                {"text":"was","start":0.25,"end":0.5,"type":"word"},
                {"text":" ","start":0.5,"end":0.55,"type":"spacing"},
                {"text":"slow。”","start":0.55,"end":0.9,"type":"word"},
                {"text":"。Finally,","start":0.9,"end":1.4,"type":"word"},
                {"text":" ","start":1.4,"end":1.45,"type":"spacing"},
                {"text":"“","start":1.45,"end":1.5,"type":"word"},
                {"text":"done","start":1.5,"end":1.8,"type":"word"}]}"#,
        );
        let words = all_words(&t);
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["It", "was", "slow。”。", "Finally,", "“done"]
        );
        assert_eq!(words[3].t_start_us, 900_000);
        let cues: Vec<&str> = t.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(cues, ["It was slow。”。", "Finally, “done"]);
        assert_well_formed(&t.segments);
    }

    #[test]
    fn audio_events_are_dropped() {
        let t = parse(
            r#"{"words":[
                {"text":"Yes","start":0.0,"end":0.3,"type":"word"},
                {"text":" ","start":0.3,"end":0.4,"type":"spacing"},
                {"text":"(laughter)","start":0.4,"end":1.2,"type":"audio_event"},
                {"text":" ","start":1.2,"end":1.3,"type":"spacing"},
                {"text":"no","start":1.3,"end":1.5,"type":"word"}]}"#,
        );
        assert!(!t.segments.iter().any(|s| s.text.contains("laughter")));
        assert_eq!(
            all_words(&t)
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>(),
            ["Yes", "no"]
        );
        assert_eq!(t.language, None);
    }

    /// A word without times keeps its text and takes the gap its neighbours
    /// leave; one with only a start ends where the next word starts.
    #[test]
    fn missing_times_are_borrowed_from_the_neighbours() {
        let t = parse(
            r#"{"words":[
                {"text":"a","start":0.0,"end":0.4,"type":"word"},
                {"text":" ","start":null,"end":null,"type":"spacing"},
                {"text":"b","start":null,"end":null,"type":"word"},
                {"text":" ","start":null,"end":null,"type":"spacing"},
                {"text":"c","start":0.8,"end":null,"type":"word"},
                {"text":" ","start":null,"end":null,"type":"spacing"},
                {"text":"d","start":1.0,"end":1.3,"type":"word"}]}"#,
        );
        let words = all_words(&t);
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c", "d"]
        );
        assert_eq!((words[1].t_start_us, words[1].t_end_us), (400_000, 800_000));
        assert_eq!(
            (words[2].t_start_us, words[2].t_end_us),
            (800_000, 1_000_000)
        );
        assert_well_formed(&t.segments);
    }

    #[test]
    fn silence_has_no_segments_and_no_word_timing() {
        let t = parse(r#"{"language_code":"eng","text":"","words":[]}"#);
        assert!(t.segments.is_empty());
        assert_eq!(t.word_timing, WordTiming::None);
    }

    /// Continuous speech with no pause still comes apart under the cue
    /// width; a CJK run is measured two columns a character.
    #[test]
    fn a_long_unbroken_run_is_cut_under_the_cue_limits() {
        let mut entries = Vec::new();
        for i in 0..30 {
            let s = i as f64 * 0.3;
            entries.push(format!(
                r#"{{"text":"word{i}","start":{s},"end":{},"type":"word"}}"#,
                s + 0.25
            ));
            entries.push(r#"{"text":" ","type":"spacing"}"#.to_string());
        }
        let t = parse(&format!(r#"{{"words":[{}]}}"#, entries.join(",")));
        assert!(t.segments.len() > 1);
        for seg in &t.segments {
            assert!(
                columns(&seg.text) <= CUE_LIMITS.max_width || seg.words.len() == 1,
                "{:?}",
                seg.text
            );
        }
        assert_eq!(all_words(&t).len(), 30, "no word lost to the cuts");
        assert_well_formed(&t.segments);
        assert_eq!(columns("你好"), 4);
        assert_eq!(columns("hi，"), 4);
    }

    #[test]
    fn cues_break_at_sentence_ends_not_inside_a_sentence() {
        // No pause reaches the silence threshold, and the CJK sentence's
        // widest gap falls before its last character.
        let t = parse(
            r#"{"words":[
            {"text":"Again.","start":0.0,"end":0.4,"type":"word"},
            {"text":"然","start":0.45,"end":0.6,"type":"word"},
            {"text":"后","start":0.6,"end":0.75,"type":"word"},
            {"text":"压","start":0.75,"end":0.9,"type":"word"},
            {"text":"低","start":0.9,"end":1.05,"type":"word"},
            {"text":"一","start":1.05,"end":1.2,"type":"word"},
            {"text":"点","start":1.45,"end":1.6,"type":"word"},
            {"text":"。","start":1.6,"end":2.4,"type":"word"},
            {"text":"Done","start":2.45,"end":2.7,"type":"word"},
            {"text":" ","type":"spacing"},
            {"text":"now.”","start":2.75,"end":3.0,"type":"word"},
            {"text":"Next","start":3.05,"end":3.3,"type":"word"}]}"#,
        );
        let cues: Vec<&str> = t.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(cues, ["Again.", "然后压低一点。", "Done now.”", "Next"]);
        assert_well_formed(&t.segments);
    }

    #[test]
    fn iso_639_3_codes_reduce_to_639_1_and_others_pass_through() {
        assert_eq!(language_code("zho").as_deref(), Some("zh"));
        assert_eq!(language_code("ENG").as_deref(), Some("en"));
        assert_eq!(language_code("yue").as_deref(), Some("yue"));
        assert_eq!(language_code(" "), None);
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        assert!(matches!(
            ElevenLabsParser.parse("not json"),
            Err(SpeechError::Parse(_))
        ));
    }
}
