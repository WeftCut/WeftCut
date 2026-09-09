//! The normalized scene-description shape every backend converges on, plus the
//! range-lazy incremental cache value.
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

/// The range-lazy incremental cache value: which source ranges have been
/// described, and every segment described so far (source-absolute). A
/// `describe_clip` for a window whose `[in, out]` is already inside
/// `covered_ranges` reuses the stored segments with no engine spawn; an
/// uncovered window is computed, merged in, and re-stored.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DescriptionCache {
    /// Merged, sorted, non-overlapping `[start_us, end_us]` source spans that
    /// have been described.
    #[serde(default)]
    pub covered_ranges: Vec<[i64; 2]>,
    /// All described segments, source-absolute, sorted by `t_start_us`.
    #[serde(default)]
    pub segments: Vec<DescSegment>,
}

impl DescriptionCache {
    /// True when `[in_us, out_us]` lies entirely inside the covered union — the
    /// "no re-spawn" fast path (acceptance #2).
    pub fn covers(&self, in_us: i64, out_us: i64) -> bool {
        // Walk the merged ranges; the window is covered iff some single range
        // contains it (ranges are already merged so adjacency is folded).
        self.covered_ranges
            .iter()
            .any(|[a, b]| *a <= in_us && *b >= out_us)
    }

    /// Segments whose span intersects `[in_us, out_us]`, sorted by start — the
    /// view `describe_clip` / `media://{id}/description` returns for a window.
    pub fn segments_in(&self, in_us: i64, out_us: i64) -> Vec<DescSegment> {
        let mut out: Vec<DescSegment> = self
            .segments
            .iter()
            .filter(|s| s.t_start_us < out_us && s.t_end_us > in_us)
            .cloned()
            .collect();
        out.sort_by_key(|s| s.t_start_us);
        out
    }

    /// Merge a freshly-described window into the cache: drop any prior segments
    /// intersecting `[in_us, out_us]` (they are replaced by `fresh`), add the
    /// fresh segments, and fold `[in_us, out_us]` into `covered_ranges`.
    pub fn merge_window(&mut self, in_us: i64, out_us: i64, fresh: Vec<DescSegment>) {
        self.segments
            .retain(|s| !(s.t_start_us < out_us && s.t_end_us > in_us));
        self.segments.extend(fresh);
        self.segments.sort_by_key(|s| s.t_start_us);
        self.covered_ranges.push([in_us, out_us]);
        self.covered_ranges = merge_ranges(std::mem::take(&mut self.covered_ranges));
    }
}

/// Merge a list of `[start, end]` spans into sorted, non-overlapping ranges
/// (touching/overlapping spans fold together).
fn merge_ranges(mut ranges: Vec<[i64; 2]>) -> Vec<[i64; 2]> {
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

/// The content-addressed description cache key: `blake3(source_hash | backend |
/// model | fps_milli | focus | language | prompt_template_version)`. A change to
/// any input (different engine, different model file, different sampling rate,
/// different prompt focus, a different output language, or a prompt-template
/// bump) yields a fresh key, so stale descriptions are never reused.
///
/// `language` is in here for a sharper reason than the rest: [`Self::covers`]
/// short-circuits a covered window with no engine spawn, so sharing a key across
/// languages would hand English prose back to a Chinese request forever — the
/// one input whose omission is not merely wasteful but uncorrectable.
pub fn cache_key(
    source_hash: &str,
    backend: VlmBackend,
    model: &str,
    fps_milli: u32,
    focus: Focus,
    language: &Language,
) -> String {
    let mut h = blake3::Hasher::new();
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

    #[test]
    fn covers_only_when_a_single_range_contains_the_window() {
        let c = DescriptionCache {
            covered_ranges: vec![[0, 4_000_000], [8_000_000, 10_000_000]],
            segments: vec![],
        };
        assert!(c.covers(1_000_000, 3_000_000));
        assert!(c.covers(0, 4_000_000));
        // Spans the gap between two ranges → not covered.
        assert!(!c.covers(3_000_000, 9_000_000));
        assert!(!c.covers(4_000_000, 6_000_000));
    }

    #[test]
    fn merge_window_folds_ranges_and_replaces_overlapping_segments() {
        let mut c = DescriptionCache::default();
        c.merge_window(0, 2_000_000, vec![seg(0, 2_000_000, "first")]);
        assert_eq!(c.covered_ranges, vec![[0, 2_000_000]]);
        assert_eq!(c.segments.len(), 1);

        // Adjacent window folds into one contiguous covered range.
        c.merge_window(
            2_000_000,
            4_000_000,
            vec![seg(2_000_000, 4_000_000, "second")],
        );
        assert_eq!(c.covered_ranges, vec![[0, 4_000_000]]);
        assert_eq!(c.segments.len(), 2);

        // Re-describing an overlapping window replaces the old segment there.
        c.merge_window(0, 2_000_000, vec![seg(0, 2_000_000, "first-v2")]);
        assert_eq!(c.covered_ranges, vec![[0, 4_000_000]]);
        assert_eq!(c.segments.len(), 2);
        assert_eq!(c.segments[0].text, "first-v2");
    }

    #[test]
    fn segments_in_returns_only_intersecting_sorted() {
        let c = DescriptionCache {
            covered_ranges: vec![[0, 10_000_000]],
            segments: vec![seg(5_000_000, 7_000_000, "mid"), seg(0, 2_000_000, "early")],
        };
        let got = c.segments_in(1_000_000, 3_000_000);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "early");
        let both = c.segments_in(0, 10_000_000);
        assert_eq!(both.len(), 2);
        assert_eq!(both[0].text, "early"); // sorted by start
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
    fn cache_key_is_sensitive_to_every_input() {
        let en = Language::default();
        let key = |hash: &str, be, model: &str, fps, focus, lang: &Language| {
            cache_key(hash, be, model, fps, focus, lang)
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
        );
        let b = cache_key(
            "h",
            VlmBackend::Qwen3Vl,
            "m",
            1000,
            Focus::General,
            &Language::parse(Some("zh")),
        );
        assert_eq!(a, b);
    }
}
