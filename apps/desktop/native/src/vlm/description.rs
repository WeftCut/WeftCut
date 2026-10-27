//! The normalized scene-description shape every backend converges on, plus the
//! cache of described runs.
//!
//! Twin of [`speech::transcript`](crate::speech): a per-backend
//! [`parser`](super::parser) turns each raw output style into [`DescSegment`]s
//! so consumers see one shape regardless of engine. As produced by a parser,
//! segment timestamps are **window-relative** (0 = first sampled frame of the
//! requested window); [`shift_segments`] places them on **source-absolute** time
//! before caching / returning — mirroring `Transcript::shift`, except the target
//! is source time (the cache is keyed by source content), not the timeline.

use serde::{Deserialize, Serialize};

use super::backend::VlmBackend;
use super::describer::{Focus, Language};

/// Bump when the prompt wording or the sampling contract changes so stale
/// cached descriptions (computed under an older prompt) are re-derived rather
/// than reused. Part of the description cache key.
///
/// 2: the prompt gained an output-language rule, so every v1 entry was written
/// under a prompt that never named a language.
pub const PROMPT_TEMPLATE_VERSION: u32 = 2;

/// One described span: a timestamped window of the clip plus the model's
/// free-text description and its extracted `tags`. Transcript-mirror
/// (`Segment`), with `tags` where `Segment` has `words`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DescSegment {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub text: String,
    pub tags: Vec<String>,
}

/// The tool result envelope `describe_clip` returns: the segments (source-
/// absolute µs) plus the `backend` + `model` that actually served the request
/// (so a fallback pick is visible, not silent — acceptance #3).
#[derive(Debug, Clone, Serialize)]
pub struct SceneDescription {
    pub backend: String,
    pub model: String,
    /// A few sentences over the whole window: clip descriptions only, once the
    /// window's run has finished and its summary request succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub segments: Vec<DescSegment>,
}

/// Shift every segment forward by `offset_us`, clamping at zero. Called with the
/// source-window start so window-relative parser output becomes source-absolute.
pub fn shift_segments(segments: &mut [DescSegment], offset_us: i64) {
    for s in segments {
        s.t_start_us = s.t_start_us.saturating_add(offset_us).max(0);
        s.t_end_us = s.t_end_us.saturating_add(offset_us).max(0);
    }
}

/// The description cache value: the RUNS that described this view of a source,
/// oldest first.
///
/// A run is one `describe_clip` over one window. It is described in chunks
/// (`vlm::chunk`), and `done` records the chunks that finished, so a run that
/// was cancelled or timed out keeps what it had and the same request resumes it.
/// Nothing a run answered for is ever deleted by another run: where runs
/// overlap, [`Self::view`] lets the newest one speak and CLIPS the older ones'
/// segments around it. That is what keeps coverage honest — every instant
/// `covered_ranges` claims is answered by the run that described it last, never
/// left as a hole a merge cut out of a segment that straddled it.
///
/// Reads accept the shape earlier builds stored (`{ covered_ranges, segments }`,
/// one merged list) and upgrade it to one finished run per covered range, so
/// prose described before this change is kept.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(from = "StoredCache")]
pub struct DescriptionCache {
    /// Oldest first; the last run is the newest.
    pub runs: Vec<Run>,
}

/// One described window. `segments` are source-absolute and lie inside the
/// chunks listed in `done`. They are stored as the model answered them; readers
/// see them through [`Run::tidied`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    /// The `[in, out]` source window the call asked for.
    pub window: [i64; 2],
    #[serde(default)]
    pub segments: Vec<DescSegment>,
    /// Merged, sorted source spans whose chunks finished.
    #[serde(default)]
    pub done: Vec<[i64; 2]>,
    /// A few sentences over the whole window, written once every chunk
    /// finished (clip runs only). Cleared whenever a chunk is (re)described, so
    /// it never speaks for segments it did not see.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// What a description file may hold: the current runs, or the single merged
/// list earlier builds wrote. Untagged, runs first; a file with neither field
/// reads as the empty legacy shape, i.e. an empty cache.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredCache {
    Runs {
        runs: Vec<Run>,
    },
    Legacy {
        #[serde(default)]
        covered_ranges: Vec<[i64; 2]>,
        #[serde(default)]
        segments: Vec<DescSegment>,
    },
}

impl From<StoredCache> for DescriptionCache {
    fn from(stored: StoredCache) -> Self {
        match stored {
            StoredCache::Runs { runs } => Self { runs },
            StoredCache::Legacy {
                covered_ranges,
                segments,
            } => Self::upgrade(covered_ranges, segments),
        }
    }
}

/// The `{ covered_ranges, segments, summaries }` answer every reader gets — the
/// `media://{id}/description` payload.
#[derive(Debug, Clone, Serialize)]
pub struct DescriptionView {
    pub covered_ranges: Vec<[i64; 2]>,
    pub segments: Vec<DescSegment>,
    /// Every run's summary, newest first, with the window it speaks for.
    pub summaries: Vec<RunSummary>,
}

/// One run's summary and the window it covers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunSummary {
    pub window: [i64; 2],
    pub text: String,
}

impl Run {
    pub fn new(window: [i64; 2]) -> Self {
        Self {
            window,
            segments: Vec::new(),
            done: Vec::new(),
            summary: None,
        }
    }

    /// Whether the finished chunks cover `[a, b]` entirely.
    pub fn has_done(&self, [a, b]: [i64; 2]) -> bool {
        self.done.iter().any(|[x, y]| *x <= a && *y >= b)
    }

    /// Whether every chunk of the window finished.
    pub fn is_complete(&self) -> bool {
        self.has_done(self.window)
    }

    /// Record a finished chunk: this run's segments inside it are replaced by
    /// `fresh` (one that straddles its edge keeps the part outside), and the
    /// chunk joins `done`.
    pub fn record_chunk(&mut self, chunk: [i64; 2], fresh: Vec<DescSegment>) {
        let old = std::mem::take(&mut self.segments);
        self.segments = clip_outside(old, &[chunk]);
        self.segments.extend(fresh);
        self.segments.sort_by_key(|s| s.t_start_us);
        self.done.push(chunk);
        self.done = merge_ranges(std::mem::take(&mut self.done));
        self.summary = None;
    }

    /// This run's segments as readers see them — a pure function of the run, so
    /// files written before it existed read tidied too. Inside each finished
    /// range (never across its edge: past it nothing was described):
    ///
    /// - the one-frame gaps a model leaves between segments are closed — a
    ///   segment's times are frame times, so it "ends" a frame before the next
    ///   one "starts", and a reader asking about the instant between gets
    ///   nothing. A gap of at most [`TIDY_GAP_US`] is given to the segment
    ///   before it; the first and last segments reach the range's edges the
    ///   same way, and a zero-length segment is stretched toward the next one
    ///   by at most as much;
    /// - consecutive segments that now touch and say the same thing are merged
    ///   ([`same_content`]): a small model asked for a timeline often answers one
    ///   line per frame, and ten identical one-second lines are one segment. The
    ///   merge keeps the first text and the union of tags.
    ///
    /// Per run and never across runs: a shot's run is that shot's answer, and
    /// two shots that read alike must stay two rows.
    pub fn tidied(&self) -> Vec<DescSegment> {
        let mut segments = self.segments.clone();
        segments.sort_by_key(|s| s.t_start_us);
        let mut out = Vec::with_capacity(segments.len());
        let mut rest = segments.into_iter().peekable();
        for &[a, b] in &self.done {
            // Segments before this range lie outside every finished range (an
            // upgraded legacy file may hold such prose): passed through as is.
            while rest.peek().is_some_and(|s| s.t_start_us < a) {
                out.push(rest.next().expect("peeked"));
            }
            let mut inside = Vec::new();
            while rest.peek().is_some_and(|s| s.t_start_us <= b) {
                inside.push(rest.next().expect("peeked"));
            }
            out.extend(tidy_range(inside, [a, b]));
        }
        out.extend(rest);
        out
    }
}

/// The widest gap [`Run::tidied`] closes: two frames at the default 1 fps. A
/// longer silence between segments is the model's own (a black frame it chose
/// not to describe) and stays.
pub const TIDY_GAP_US: i64 = 2_000_000;

/// [`Run::tidied`] over one finished range `[a, b]`; `segments` start inside it.
fn tidy_range(mut segments: Vec<DescSegment>, [a, b]: [i64; 2]) -> Vec<DescSegment> {
    let n = segments.len();
    for i in 0..n {
        let next = if i + 1 < n {
            segments[i + 1].t_start_us
        } else {
            b
        };
        let s = &mut segments[i];
        s.t_end_us = s.t_end_us.max(s.t_start_us);
        if s.t_end_us == s.t_start_us {
            s.t_end_us = next.min(s.t_start_us + TIDY_GAP_US).max(s.t_start_us);
        }
        if s.t_end_us < next && next - s.t_end_us <= TIDY_GAP_US {
            s.t_end_us = next;
        }
    }
    if let Some(first) = segments.first_mut() {
        if first.t_start_us > a && first.t_start_us - a <= TIDY_GAP_US {
            first.t_start_us = a;
        }
    }
    let mut out: Vec<DescSegment> = Vec::with_capacity(n);
    for s in segments {
        match out.last_mut() {
            Some(prev) if prev.t_end_us >= s.t_start_us && same_content(prev, &s) => {
                prev.t_end_us = prev.t_end_us.max(s.t_end_us);
                for tag in s.tags {
                    if !prev.tags.contains(&tag) {
                        prev.tags.push(tag);
                    }
                }
            }
            _ => out.push(s),
        }
    }
    out
}

/// Whether two neighbouring segments describe the same thing: their texts are
/// near-identical (character-bigram Dice ≥ 0.8 over the text with spaces and
/// punctuation dropped), or close (Dice ≥ 0.55) with mostly the same tags (tag
/// Jaccard ≥ 0.75). Character bigrams, not words, so CJK prose — unsegmented —
/// compares as well as English.
///
/// Set against a real 10-minute documentary run (Qwen3-VL 4B, 1 fps): the
/// repeats that merge score 1.0, rewordings of one shot ("女人继续给山羊挤奶，
/// 山羊低头" / "女人在给山羊挤奶，山羊侧身") 0.61 with identical tags, while two
/// different people in the same setting ("穿着毛衣…弯腰" / "穿着长外套…双手
/// 交叉") stay apart at 0.45 with tag Jaccard 0.2.
pub fn same_content(x: &DescSegment, y: &DescSegment) -> bool {
    let dice = bigram_dice(&x.text, &y.text);
    if dice >= 0.8 {
        return true;
    }
    if dice < 0.55 {
        return false;
    }
    let xs: std::collections::HashSet<&str> = x.tags.iter().map(String::as_str).collect();
    let ys: std::collections::HashSet<&str> = y.tags.iter().map(String::as_str).collect();
    let union = xs.union(&ys).count();
    union > 0 && xs.intersection(&ys).count() as f64 / union as f64 >= 0.75
}

/// Sørensen–Dice over character bigrams (multiset), text lowercased with
/// whitespace and punctuation removed. A one-character text is its own bigram.
fn bigram_dice(a: &str, b: &str) -> f64 {
    fn grams(t: &str) -> Vec<(char, char)> {
        let chars: Vec<char> = t
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect();
        match chars.len() {
            0 => Vec::new(),
            1 => vec![(chars[0], chars[0])],
            _ => chars.windows(2).map(|w| (w[0], w[1])).collect(),
        }
    }
    let (x, mut y) = (grams(a), grams(b));
    if x.is_empty() && y.is_empty() {
        return 1.0;
    }
    let total = x.len() + y.len();
    let mut shared = 0usize;
    for g in &x {
        if let Some(i) = y.iter().position(|h| h == g) {
            y.swap_remove(i);
            shared += 1;
        }
    }
    2.0 * shared as f64 / total as f64
}

impl DescriptionCache {
    /// Earlier builds' merged list → one finished run per covered range. A
    /// segment goes to the range holding its midpoint, else the nearest one: the
    /// upgrade never drops prose.
    fn upgrade(covered: Vec<[i64; 2]>, segments: Vec<DescSegment>) -> Self {
        let covered = merge_ranges(covered);
        let mut runs: Vec<Run> = covered
            .iter()
            .map(|r| Run {
                window: *r,
                segments: Vec::new(),
                done: vec![*r],
                summary: None,
            })
            .collect();
        for s in segments {
            let mid = s.t_start_us + (s.t_end_us - s.t_start_us) / 2;
            let distance = |[a, b]: [i64; 2]| {
                if mid < a {
                    a - mid
                } else if mid > b {
                    mid - b
                } else {
                    0
                }
            };
            match runs.iter_mut().min_by_key(|r| distance(r.window)) {
                Some(run) => run.segments.push(s),
                // Prose with no range at all: keep it in a run of its own span.
                None => runs.push(Run {
                    window: [s.t_start_us, s.t_end_us],
                    done: vec![[s.t_start_us, s.t_end_us]],
                    segments: vec![s],
                    summary: None,
                }),
            }
        }
        for run in &mut runs {
            run.segments.sort_by_key(|s| s.t_start_us);
        }
        Self { runs }
    }

    /// Every finished source span, merged across runs.
    pub fn covered_ranges(&self) -> Vec<[i64; 2]> {
        merge_ranges(self.runs.iter().flat_map(|r| r.done.clone()).collect())
    }

    /// True when `[in_us, out_us]` lies entirely inside the covered union — the
    /// "no re-spawn" fast path. Honest for a sub-window too: chunks sample at the
    /// requested fps whatever the window's length, so a finished run's density is
    /// the density the key names.
    pub fn covers(&self, in_us: i64, out_us: i64) -> bool {
        self.covered_ranges()
            .iter()
            .any(|[a, b]| *a <= in_us && *b >= out_us)
    }

    /// The segments readers see: each run [tidied](Run::tidied), then the
    /// newest run that finished an instant speaks for it, and an older run's
    /// segment keeps only the instants no newer run finished — clipped to them,
    /// split around a newer run inside it, dropped when nothing is left. Sorted
    /// by start.
    pub fn view(&self) -> Vec<DescSegment> {
        let mut claimed: Vec<[i64; 2]> = Vec::new();
        let mut out = Vec::new();
        for run in self.runs.iter().rev() {
            out.extend(clip_outside(run.tidied(), &claimed));
            claimed.extend(run.done.iter().copied());
            claimed = merge_ranges(claimed);
        }
        out.sort_by_key(|s| s.t_start_us);
        out
    }

    /// The `{ covered_ranges, segments, summaries }` answer for the whole
    /// source.
    pub fn view_payload(&self) -> DescriptionView {
        DescriptionView {
            covered_ranges: self.covered_ranges(),
            segments: self.view(),
            summaries: self
                .runs
                .iter()
                .rev()
                .filter_map(|r| {
                    r.summary.as_ref().map(|text| RunSummary {
                        window: r.window,
                        text: text.clone(),
                    })
                })
                .collect(),
        }
    }

    /// The summary of the run over exactly `window`, if it has one. Tests only:
    /// the tool reads the run itself, which it also needs to know is whole.
    #[cfg(test)]
    pub fn summary_for(&self, window: [i64; 2]) -> Option<&str> {
        self.runs
            .iter()
            .find(|r| r.window == window)
            .and_then(|r| r.summary.as_deref())
    }

    /// [`Self::view`]'s segments intersecting `[in_us, out_us]` — what
    /// `describe_clip` answers for a window.
    pub fn segments_in(&self, in_us: i64, out_us: i64) -> Vec<DescSegment> {
        self.view()
            .into_iter()
            .filter(|s| intersects(s, in_us, out_us))
            .collect()
    }

    /// Forget the run over exactly `window` (`describe_clip { refresh: true }`).
    /// Other runs, including ones overlapping it, are untouched.
    pub fn discard(&mut self, window: [i64; 2]) {
        self.runs.retain(|r| r.window != window);
    }

    /// The run over exactly `window`, made the newest (the chunks about to be
    /// described are the latest word on their span); created when absent, so an
    /// unfinished run is resumed rather than restarted.
    pub fn run_for(&mut self, window: [i64; 2]) -> &mut Run {
        let run = match self.runs.iter().position(|r| r.window == window) {
            Some(i) => self.runs.remove(i),
            None => Run::new(window),
        };
        self.runs.push(run);
        self.runs.last_mut().expect("just pushed")
    }
}

/// A segment's span meets `[in_us, out_us]`; a zero-length segment meets the
/// window it sits in.
fn intersects(s: &DescSegment, in_us: i64, out_us: i64) -> bool {
    if s.t_start_us == s.t_end_us {
        return s.t_start_us >= in_us && s.t_start_us <= out_us;
    }
    s.t_start_us < out_us && s.t_end_us > in_us
}

/// The parts of each segment outside `claimed` (merged, sorted), text and tags
/// unchanged. A zero-length segment survives when its instant is unclaimed.
fn clip_outside(segments: Vec<DescSegment>, claimed: &[[i64; 2]]) -> Vec<DescSegment> {
    if claimed.is_empty() {
        return segments;
    }
    let mut out = Vec::with_capacity(segments.len());
    for s in segments {
        if s.t_start_us >= s.t_end_us {
            let t = s.t_start_us;
            if !claimed.iter().any(|[a, b]| *a <= t && t < *b) {
                out.push(s);
            }
            continue;
        }
        let mut from = s.t_start_us;
        for [a, b] in claimed {
            if *b <= from {
                continue;
            }
            if *a >= s.t_end_us {
                break;
            }
            if *a > from {
                out.push(DescSegment {
                    t_start_us: from,
                    t_end_us: *a,
                    ..s.clone()
                });
            }
            from = from.max(*b);
            if from >= s.t_end_us {
                break;
            }
        }
        if from < s.t_end_us {
            out.push(DescSegment {
                t_start_us: from,
                ..s
            });
        }
    }
    out
}

/// Merge a list of `[start, end]` spans into sorted, non-overlapping ranges
/// (touching/overlapping spans fold together).
pub fn merge_ranges(mut ranges: Vec<[i64; 2]>) -> Vec<[i64; 2]> {
    ranges.sort_by_key(|r| r[0]);
    let mut out: Vec<[i64; 2]> = Vec::with_capacity(ranges.len());
    for [a, b] in ranges {
        if let Some(last) = out.last_mut() {
            if a <= last[1] {
                last[1] = last[1].max(b);
                continue;
            }
        }
        out.push([a, b]);
    }
    out
}

/// The sampling rate in the unit [`cache_key`] wants: milli-fps, rounded.
///
/// ONE conversion, called by the `describe_clip` tool and by the
/// `media://{id}/description` reader alike. Two spellings of `fps * 1000.0`
/// would be two keys for one view, and the divergence is SILENT: the tool writes
/// under one key, the resource reads under the other, and every source reports
/// as undescribed with nothing to diagnose.
pub fn fps_milli(fps: f64) -> u32 {
    (fps * 1000.0).round() as u32
}

/// Cache ownership, independent of prompt focus. A clip description never
/// satisfies an individual shot request, even when their source spans match.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DescriptionPurpose {
    #[default]
    Clip,
    Shot,
}

impl DescriptionPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clip => "clip",
            Self::Shot => "shot",
        }
    }
}

/// Content-addressed key over purpose, source, engine, model, sampling, focus,
/// language and prompt version. A versioned namespace excludes old mixed entries.
pub fn cache_key(
    source_hash: &str,
    backend: VlmBackend,
    model: &str,
    fps_milli: u32,
    focus: Focus,
    language: &Language,
    purpose: DescriptionPurpose,
) -> String {
    let mut h = blake3::Hasher::new();
    // Old entries mixed both purposes and cannot be assigned safely to either.
    h.update(b"description-purpose-v1\0");
    h.update(purpose.as_str().as_bytes());
    h.update(b"\0");
    h.update(source_hash.as_bytes());
    h.update(b"\0");
    h.update(backend.as_str().as_bytes());
    h.update(b"\0");
    h.update(model.as_bytes());
    h.update(b"\0");
    h.update(&fps_milli.to_le_bytes());
    h.update(b"\0");
    h.update(focus.as_str().as_bytes());
    h.update(b"\0");
    h.update(language.as_str().as_bytes());
    h.update(b"\0");
    h.update(&PROMPT_TEMPLATE_VERSION.to_le_bytes());
    h.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(a: i64, b: i64, text: &str) -> DescSegment {
        DescSegment {
            t_start_us: a,
            t_end_us: b,
            text: text.into(),
            tags: vec![],
        }
    }

    #[test]
    fn shift_moves_segments_and_clamps_at_zero() {
        let mut s = vec![seg(0, 1_000_000, "a"), seg(1_000_000, 2_000_000, "b")];
        shift_segments(&mut s, 5_000_000);
        assert_eq!(s[0].t_start_us, 5_000_000);
        assert_eq!(s[1].t_end_us, 7_000_000);
        shift_segments(&mut s, -100_000_000);
        assert!(s.iter().all(|x| x.t_start_us >= 0 && x.t_end_us >= 0));
    }

    fn done(window: [i64; 2], segments: Vec<DescSegment>) -> Run {
        Run {
            window,
            segments,
            done: vec![window],
            summary: None,
        }
    }

    #[test]
    fn covers_only_when_a_single_merged_range_contains_the_window() {
        let c = DescriptionCache {
            runs: vec![
                done([0, 4_000_000], vec![]),
                done([8_000_000, 10_000_000], vec![]),
            ],
        };
        assert!(c.covers(1_000_000, 3_000_000));
        assert!(c.covers(0, 4_000_000));
        // Spans the gap between two ranges → not covered.
        assert!(!c.covers(3_000_000, 9_000_000));
        assert!(!c.covers(4_000_000, 6_000_000));
        // Adjacent runs fold into one covered span.
        let c = DescriptionCache {
            runs: vec![
                done([0, 4_000_000], vec![]),
                done([4_000_000, 6_000_000], vec![]),
            ],
        };
        assert!(c.covers(3_000_000, 5_000_000));
    }

    #[test]
    fn an_unfinished_run_covers_only_its_finished_chunks() {
        let mut c = DescriptionCache::default();
        let run = c.run_for([0, 8_000_000]);
        run.record_chunk([0, 4_000_000], vec![seg(0, 4_000_000, "first")]);
        assert!(!run.is_complete());
        assert!(c.covers(0, 4_000_000));
        assert!(!c.covers(0, 8_000_000));
        // Resuming finds the same run, not a fresh one.
        let run = c.run_for([0, 8_000_000]);
        assert!(run.has_done([0, 4_000_000]));
        run.record_chunk(
            [4_000_000, 8_000_000],
            vec![seg(4_000_000, 8_000_000, "second")],
        );
        assert!(run.is_complete());
        assert_eq!(c.runs.len(), 1);
        assert_eq!(c.segments_in(0, 8_000_000).len(), 2);
    }

    #[test]
    fn recording_a_chunk_again_replaces_only_its_own_span() {
        let mut run = Run::new([0, 8_000_000]);
        run.record_chunk([0, 8_000_000], vec![seg(0, 8_000_000, "whole")]);
        run.record_chunk(
            [2_000_000, 4_000_000],
            vec![seg(2_000_000, 4_000_000, "redo")],
        );
        let spans: Vec<_> = run
            .segments
            .iter()
            .map(|s| (s.t_start_us, s.t_end_us, s.text.as_str()))
            .collect();
        assert_eq!(
            spans,
            [
                (0, 2_000_000, "whole"),
                (2_000_000, 4_000_000, "redo"),
                (4_000_000, 8_000_000, "whole"),
            ]
        );
    }

    #[test]
    fn the_newest_run_speaks_and_older_segments_are_clipped_around_it() {
        let c = DescriptionCache {
            runs: vec![
                done(
                    [0, 10_000_000],
                    vec![
                        seg(0, 3_000_000, "before"),
                        seg(3_000_000, 9_000_000, "straddler"),
                        seg(9_000_000, 10_000_000, "after"),
                        seg(5_000_000, 6_000_000, "swallowed"),
                    ],
                ),
                done(
                    [4_000_000, 7_000_000],
                    vec![seg(4_000_000, 7_000_000, "newer")],
                ),
            ],
        };
        let spans: Vec<_> = c
            .view()
            .into_iter()
            .map(|s| (s.t_start_us, s.t_end_us, s.text))
            .collect();
        assert_eq!(
            spans,
            [
                (0, 3_000_000, "before".to_string()),
                // Split around the newer run, both halves kept: no hole.
                (3_000_000, 4_000_000, "straddler".to_string()),
                (4_000_000, 7_000_000, "newer".to_string()),
                (7_000_000, 9_000_000, "straddler".to_string()),
                (9_000_000, 10_000_000, "after".to_string()),
            ]
        );
        assert_eq!(c.view_payload().covered_ranges, vec![[0, 10_000_000]]);
    }

    fn tagged(a: i64, b: i64, text: &str, tags: &[&str]) -> DescSegment {
        DescSegment {
            t_start_us: a,
            t_end_us: b,
            text: text.into(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
        }
    }

    fn spans(segments: &[DescSegment]) -> Vec<(i64, i64, &str)> {
        segments
            .iter()
            .map(|s| (s.t_start_us, s.t_end_us, s.text.as_str()))
            .collect()
    }

    const S: i64 = 1_000_000;

    /// Lifted from a real 1 fps run over a documentary: a 16 s chunk answered
    /// one line per frame — ten identical ones, then five more.
    #[test]
    fn a_line_per_frame_tidies_into_one_segment_per_shot() {
        let mut segments: Vec<_> = (0..10)
            .map(|i| {
                tagged(
                    192 * S + S / 2 + i * S,
                    193 * S + S / 2 + i * S,
                    "一双黑色皮鞋和一个大行李箱",
                    &["皮鞋", "行李箱"],
                )
            })
            .collect();
        segments.extend((0..5).map(|i| {
            tagged(
                202 * S + S / 2 + i * S,
                203 * S + S / 2 + i * S,
                "一堆白色方块",
                &["白色方块"],
            )
        }));
        let run = Run {
            window: [192 * S, 208 * S],
            segments,
            done: vec![[192 * S, 208 * S]],
            summary: None,
        };
        assert_eq!(
            spans(&run.tidied()),
            [
                // Pulled back to the chunk's start, through to the next shot.
                (192 * S, 202 * S + S / 2, "一双黑色皮鞋和一个大行李箱"),
                // Out to the chunk's end.
                (202 * S + S / 2, 208 * S, "一堆白色方块"),
            ]
        );
        // Stored as answered: the tidy is a reading, not a rewrite.
        assert_eq!(run.segments.len(), 15);
    }

    #[test]
    fn rewordings_merge_and_different_subjects_do_not() {
        let tags = ["女人", "山羊", "挤奶"];
        let a = tagged(0, S, "女人继续给山羊挤奶，山羊低头。", &tags);
        let b = tagged(S, 2 * S, "女人在给山羊挤奶，山羊侧身。", &tags);
        let c = tagged(
            2 * S,
            3 * S,
            "女人用挤奶器给山羊挤奶。",
            &["女人", "山羊", "挤奶器", "挤奶"],
        );
        assert!(same_content(&a, &b));
        // A new detail (the milking machine) is a new segment.
        assert!(!same_content(&b, &c));
        let sweater = tagged(
            0,
            S,
            "一个穿着毛衣和帽子的人在户外弯腰，似乎在整理或系紧鞋子。",
            &["户外", "弯腰", "系鞋"],
        );
        let coat = tagged(
            S,
            2 * S,
            "一个穿着长外套和帽子的人在户外，双手交叉在胸前，似乎在调整外套。",
            &["户外", "调整外套", "帽子"],
        );
        assert!(!same_content(&sweater, &coat));
        // English compares the same way.
        assert!(same_content(
            &seg(0, S, "A red title card."),
            &seg(S, 2 * S, "a red title card")
        ));
        let run = Run {
            window: [0, 3 * S],
            segments: vec![a, b, c],
            done: vec![[0, 3 * S]],
            summary: None,
        };
        let tidied = run.tidied();
        assert_eq!(tidied.len(), 2);
        assert_eq!(tidied[0].t_end_us, 2 * S);
        assert_eq!(tidied[1].tags, ["女人", "山羊", "挤奶器", "挤奶"]);
    }

    #[test]
    fn tidying_never_crosses_an_unfinished_chunk_or_a_long_silence() {
        let run = Run {
            window: [0, 20 * S],
            segments: vec![
                seg(S / 2, 3 * S, "first"),
                seg(3 * S + S / 2, 3 * S + S / 2, "instant"),
                seg(10 * S + S / 2, 11 * S, "resumed"),
                seg(15 * S, 16 * S, "after a silence"),
            ],
            // [4, 10) never finished.
            done: vec![[0, 4 * S], [10 * S, 20 * S]],
            summary: None,
        };
        assert_eq!(
            spans(&run.tidied()),
            [
                (0, 3 * S + S / 2, "first"),
                // Zero-length: stretched to its range's end, not past it.
                (3 * S + S / 2, 4 * S, "instant"),
                // 4 s gaps are the model's own silences and stay, before the
                // next segment and before the range's end alike.
                (10 * S, 11 * S, "resumed"),
                (15 * S, 16 * S, "after a silence"),
            ]
        );
    }

    #[test]
    fn the_view_tidies_each_run_and_never_merges_two() {
        // Two shots described alike stay two rows.
        let c = DescriptionCache {
            runs: vec![
                done(
                    [0, 4 * S],
                    vec![seg(S / 2, 3 * S + S / 2, "a red title card")],
                ),
                done(
                    [4 * S, 8 * S],
                    vec![seg(4 * S + S / 2, 7 * S + S / 2, "a red title card")],
                ),
            ],
        };
        assert_eq!(
            spans(&c.view()),
            [
                (0, 4 * S, "a red title card"),
                (4 * S, 8 * S, "a red title card"),
            ]
        );
    }

    #[test]
    fn a_summary_is_cleared_by_new_chunks_and_listed_newest_first() {
        let mut c = DescriptionCache::default();
        let run = c.run_for([0, 8 * S]);
        run.record_chunk([0, 8 * S], vec![seg(0, 8 * S, "whole")]);
        run.summary = Some("older".into());
        let run = c.run_for([0, 4 * S]);
        run.record_chunk([0, 4 * S], vec![seg(0, 4 * S, "part")]);
        run.summary = Some("newer".into());
        let payload = c.view_payload();
        assert_eq!(
            payload.summaries,
            [
                RunSummary {
                    window: [0, 4 * S],
                    text: "newer".into()
                },
                RunSummary {
                    window: [0, 8 * S],
                    text: "older".into()
                },
            ]
        );
        assert_eq!(c.summary_for([0, 8 * S]), Some("older"));
        // Re-describing a chunk makes the summary stale: gone.
        c.run_for([0, 8 * S])
            .record_chunk([0, 4 * S], vec![seg(0, 4 * S, "redo")]);
        assert_eq!(c.summary_for([0, 8 * S]), None);
        // Older files without the field read; an absent summary is not written.
        let json = serde_json::to_value(&c).unwrap();
        assert!(json["runs"][1].get("summary").is_none());
        let back: DescriptionCache = serde_json::from_value(json).unwrap();
        assert_eq!(back.summary_for([0, 4 * S]), Some("newer"));
    }

    #[test]
    fn discard_forgets_only_the_exact_window() {
        let mut c = DescriptionCache {
            runs: vec![
                done([0, 10_000_000], vec![seg(0, 10_000_000, "whole")]),
                done([0, 2_000_000], vec![seg(0, 2_000_000, "part")]),
            ],
        };
        c.discard([0, 2_000_000]);
        assert_eq!(c.runs.len(), 1);
        assert_eq!(c.segments_in(0, 2_000_000)[0].text, "whole");
    }

    #[test]
    fn the_merged_shape_earlier_builds_wrote_upgrades_without_losing_prose() {
        let legacy = serde_json::json!({
            "covered_ranges": [[0, 4_000_000], [8_000_000, 10_000_000]],
            "segments": [
                { "t_start_us": 0, "t_end_us": 4_000_000, "text": "a", "tags": [] },
                { "t_start_us": 8_000_000, "t_end_us": 10_000_000, "text": "b", "tags": ["x"] },
                // Outside every range (a hand-edited file): kept, nearest run.
                { "t_start_us": 5_000_000, "t_end_us": 5_500_000, "text": "stray", "tags": [] },
            ],
        });
        let c: DescriptionCache = serde_json::from_value(legacy).unwrap();
        assert_eq!(c.runs.len(), 2);
        assert!(c.runs.iter().all(Run::is_complete));
        assert_eq!(
            c.covered_ranges(),
            vec![[0, 4_000_000], [8_000_000, 10_000_000]]
        );
        let texts: Vec<_> = c
            .runs
            .iter()
            .flat_map(|r| &r.segments)
            .map(|s| s.text.as_str())
            .collect();
        assert_eq!(texts.len(), 3);
        assert!(texts.contains(&"stray"));
        // Round-trips in the runs shape.
        let again: DescriptionCache =
            serde_json::from_slice(&serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!(again.runs, c.runs);
        // An empty or unrelated object is an empty cache.
        let empty: DescriptionCache = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(empty.runs.is_empty());
    }

    proptest::proptest! {
        /// For every instant a run finished, the view answers with exactly the
        /// (tidied) segments of the NEWEST run that finished it — never an older
        /// run's, never nothing when that run had something to say.
        #[test]
        fn the_newest_finishing_run_answers_every_instant(
            raw in proptest::collection::vec(
                (0i64..20, 1i64..10, proptest::collection::vec((0i64..20, 1i64..6), 0..4)),
                1..6,
            ),
        ) {
            let runs: Vec<Run> = raw
                .iter()
                .enumerate()
                .map(|(i, (a, len, segs))| {
                    let window = [*a, a + len];
                    let segments = segs
                        .iter()
                        .map(|(s, l)| {
                            let start = (*s).clamp(window[0], window[1]);
                            let end = (start + l).min(window[1]);
                            seg(start, end, &format!("r{i}"))
                        })
                        .collect();
                    done(window, segments)
                })
                .collect();
            let c = DescriptionCache { runs: runs.clone() };
            let view = c.view();
            for t2 in 0..60i64 {
                // Half-steps: an instant strictly inside a unit span.
                let t = t2 as f64 / 2.0 + 0.25;
                let inside = |a: i64, b: i64| (a as f64) <= t && t < (b as f64);
                let Some((i, owner)) = runs
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, r)| r.done.iter().any(|d| inside(d[0], d[1])))
                else {
                    continue;
                };
                let tag = format!("r{i}");
                let expected = owner.tidied().iter().filter(|s| inside(s.t_start_us, s.t_end_us)).count();
                let got: Vec<_> = view.iter().filter(|s| inside(s.t_start_us, s.t_end_us)).collect();
                proptest::prop_assert_eq!(got.len(), expected, "t={} owner={}", t, tag);
                proptest::prop_assert!(got.iter().all(|s| s.text == tag), "t={} owner={}", t, tag);
            }
        }
    }

    /// The `describe_clip` tool and the `media://{id}/description` reader both
    /// key on this, so a rounding change silently re-keys every description ever
    /// cached. Pinned here rather than at either caller — one home for the fact.
    #[test]
    fn fps_milli_rounds_to_the_key_unit() {
        assert_eq!(fps_milli(1.0), 1000);
        assert_eq!(fps_milli(2.5), 2500);
        assert_eq!(fps_milli(0.1), 100);
        // Rounds rather than truncates: 0.3 is not representable in binary, so
        // `as u32` alone would key 0.3 fps as 299.
        assert_eq!(fps_milli(0.3), 300);
        assert_eq!(fps_milli(30.0), 30_000);
    }

    #[test]
    fn clip_coverage_cannot_satisfy_a_shot_request() {
        let root = tempfile::tempdir().unwrap();
        let key = |purpose| {
            cache_key(
                "source",
                VlmBackend::Qwen3Vl,
                "model",
                1000,
                Focus::General,
                &Language::default(),
                purpose,
            )
        };
        let clip_path = root.path().join(key(DescriptionPurpose::Clip));
        let shot_path = root.path().join(key(DescriptionPurpose::Shot));
        let mut clip = DescriptionCache::default();
        clip.run_for([0, 10_000_000])
            .record_chunk([0, 10_000_000], vec![seg(0, 10_000_000, "whole clip")]);
        std::fs::write(&clip_path, serde_json::to_vec(&clip).unwrap()).unwrap();
        assert!(!shot_path.exists());
        let mut shot = DescriptionCache::default();
        shot.run_for([0, 1_000_000])
            .record_chunk([0, 1_000_000], vec![seg(0, 1_000_000, "close-up")]);
        std::fs::write(&shot_path, serde_json::to_vec(&shot).unwrap()).unwrap();
        let restored: DescriptionCache =
            serde_json::from_slice(&std::fs::read(clip_path).unwrap()).unwrap();
        assert_eq!(restored.segments_in(0, 1_000_000)[0].text, "whole clip");
        assert!(restored.covers(0, 10_000_000));
        let restored: DescriptionCache =
            serde_json::from_slice(&std::fs::read(shot_path).unwrap()).unwrap();
        assert_eq!(restored.segments_in(0, 1_000_000)[0].text, "close-up");
        assert!(!restored.covers(0, 10_000_000));
    }

    #[test]
    fn cache_key_is_sensitive_to_every_input() {
        let en = Language::default();
        let key = |hash: &str, be, model: &str, fps, focus, lang: &Language| {
            cache_key(hash, be, model, fps, focus, lang, DescriptionPurpose::Clip)
        };
        let base = key("h", VlmBackend::Qwen3Vl, "m", 1000, Focus::General, &en);
        assert_eq!(
            base,
            key("h", VlmBackend::Qwen3Vl, "m", 1000, Focus::General, &en)
        );
        assert_ne!(
            base,
            key("h2", VlmBackend::Qwen3Vl, "m", 1000, Focus::General, &en)
        );
        assert_ne!(
            base,
            key("h", VlmBackend::MiniCpmV, "m", 1000, Focus::General, &en)
        );
        assert_ne!(
            base,
            key("h", VlmBackend::Qwen3Vl, "m2", 1000, Focus::General, &en)
        );
        assert_ne!(
            base,
            key("h", VlmBackend::Qwen3Vl, "m", 2000, Focus::General, &en)
        );
        assert_ne!(
            base,
            key("h", VlmBackend::Qwen3Vl, "m", 1000, Focus::ShotType, &en)
        );
        let zh = Language::parse(Some("zh-CN"));
        assert_ne!(
            base,
            key("h", VlmBackend::Qwen3Vl, "m", 1000, Focus::General, &zh)
        );
    }

    #[test]
    fn cache_key_follows_the_canonical_language_not_its_spelling() {
        // `zh` / `zh-CN` / `zh-Hans` produce one prompt, so they must produce
        // one entry — otherwise switching between two spellings of the same UI
        // language would re-run a 20-second model over described footage.
        let a = cache_key(
            "h",
            VlmBackend::Qwen3Vl,
            "m",
            1000,
            Focus::General,
            &Language::parse(Some("zh-CN")),
            DescriptionPurpose::Clip,
        );
        let b = cache_key(
            "h",
            VlmBackend::Qwen3Vl,
            "m",
            1000,
            Focus::General,
            &Language::parse(Some("zh")),
            DescriptionPurpose::Clip,
        );
        assert_eq!(a, b);
    }
}
