//! The normalized transcript shape every speech backend converges on.
//!
//! Backends emit different *styles* (SRT, whisper JSON, FunASR JSON); a
//! per-style [`parse`](super::parse) turns each into this one structure so
//! consumers (the `transcribe_clip` tool, the scene/content-analysis
//! word-transcript resource) see a single shape regardless of engine. The only
//! thing that differs across backends is [`WordTiming`] — the provenance of the
//! per-word timestamps — and it is inspectable.
//!
//! Timestamps are microseconds. As produced by a parser they are
//! **audio-slice-relative** (0 = first sample of the extracted window); the
//! tool layer calls [`Transcript::shift`] to place them on the timeline before
//! returning to the agent.

use serde::Serialize;

/// Provenance of the per-word timestamps in a [`Transcript`]. Downstream
/// text-editing reads this to know whether a word boundary is frame-trustworthy
/// (`Exact`, straight from an engine's token offsets) or approximate
/// (`InterpolatedFromCue`, derived by splitting a cue span across its words).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WordTiming {
    /// Word times come straight from the engine's per-token offsets.
    Exact,
    /// Word times were derived by distributing a cue span across its words by
    /// length — approximate, not sample-accurate.
    InterpolatedFromCue,
    /// No word-level timing available (segment granularity only).
    None,
}

/// One word with its own `[t_start_us, t_end_us]` span.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Word {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub text: String,
}

/// One transcript segment — an SRT cue, or a whisper `transcription[]` entry:
/// a timed span of text plus its constituent [`Word`]s.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Segment {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub text: String,
    pub words: Vec<Word>,
}

/// The single normalized shape produced by every backend after parsing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
    pub language: Option<String>,
    pub word_timing: WordTiming,
}

impl Transcript {
    /// Shift every segment and word timestamp forward by `offset_us` (the
    /// slice's timeline-absolute start), clamping at zero so a negative result
    /// never underflows.
    pub fn shift(&mut self, offset_us: i64) {
        for seg in &mut self.segments {
            seg.t_start_us = shift_us(seg.t_start_us, offset_us);
            seg.t_end_us = shift_us(seg.t_end_us, offset_us);
            for w in &mut seg.words {
                w.t_start_us = shift_us(w.t_start_us, offset_us);
                w.t_end_us = shift_us(w.t_end_us, offset_us);
            }
        }
    }
}

fn shift_us(base_us: i64, offset_us: i64) -> i64 {
    base_us.saturating_add(offset_us).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(a: i64, b: i64, t: &str) -> Word {
        Word {
            t_start_us: a,
            t_end_us: b,
            text: t.to_string(),
        }
    }

    fn sample() -> Transcript {
        Transcript {
            segments: vec![
                Segment {
                    t_start_us: 1_000_000,
                    t_end_us: 2_500_000,
                    text: "Hello world".into(),
                    words: vec![
                        word(1_000_000, 1_750_000, "Hello"),
                        word(1_750_000, 2_500_000, "world"),
                    ],
                },
                Segment {
                    t_start_us: 3_000_000,
                    t_end_us: 4_000_000,
                    text: "Bye".into(),
                    words: vec![word(3_000_000, 4_000_000, "Bye")],
                },
            ],
            language: Some("en".into()),
            word_timing: WordTiming::InterpolatedFromCue,
        }
    }

    #[test]
    fn shift_moves_segments_and_words_together() {
        let mut t = sample();
        t.shift(500_000);
        assert_eq!(t.segments[0].t_start_us, 1_500_000);
        assert_eq!(t.segments[0].t_end_us, 3_000_000);
        assert_eq!(t.segments[0].words[0].t_start_us, 1_500_000);
        assert_eq!(t.segments[0].words[1].t_end_us, 3_000_000);
        assert_eq!(t.segments[1].words[0].t_start_us, 3_500_000);
    }

    #[test]
    fn shift_clamps_at_zero() {
        let mut t = sample();
        t.shift(-5_000_000);
        for seg in &t.segments {
            assert!(seg.t_start_us >= 0 && seg.t_end_us >= 0);
            for w in &seg.words {
                assert!(w.t_start_us >= 0 && w.t_end_us >= 0);
            }
        }
    }

    #[test]
    fn word_timing_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&WordTiming::InterpolatedFromCue).unwrap(),
            "\"interpolated_from_cue\"",
        );
        assert_eq!(
            serde_json::to_string(&WordTiming::Exact).unwrap(),
            "\"exact\""
        );
        assert_eq!(
            serde_json::to_string(&WordTiming::None).unwrap(),
            "\"none\""
        );
    }
}
