//! `SceneDescriber` capability surface — a set of timed frames in, a
//! format-tagged [`RawDescription`] out.
//!
//! Twin of [`speech::transcriber`](crate::speech): the trait is deliberately
//! thin (a backend produces one raw output style, it does NOT normalize —
//! normalization is [`super::parser`]) and `Send + Sync + dyn`-compatible so the
//! resolver hands back a `Box<dyn SceneDescriber>` regardless of backend.
//!
//! **Input contract = a set of timed frames, not a video file.** The tool layer
//! samples frames from the source at `fps`, attaches each frame's window-relative
//! timestamp, and hands the same [`TimedFrame`] list to every backend (local
//! sidecar, BYO endpoint, cloud) — the per-backend adapter presents them the way
//! that engine expects. Keeping timestamps window-relative (0-based) here mirrors
//! how [`speech`](crate::speech) parsers emit slice-relative times and the tool
//! shifts onto the timeline; here the tool shifts onto source-absolute time.

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

use super::error::VlmError;
use super::parser::RawDescription;
use crate::compute_jobs::{ModelObserver, ModelPhase};

/// One sampled frame: its window-relative timestamp (0 = start of the requested
/// window) and the on-disk image the backend feeds to the model. The local
/// sidecar passes the path to `--image`; the HTTP backends read the file and
/// base64-encode it into an `image_url` content part.
#[derive(Debug, Clone)]
pub struct TimedFrame {
    /// Window-relative microseconds (0-based). The prompt renders this as
    /// `Frame at <t>s:` — the plain-text time signal Qwen3-VL / MiniCPM-V honor
    /// verbatim. The parser echoes these back; the tool shifts them by the
    /// source-window start to reach source-absolute time.
    pub t_us: i64,
    /// Extracted still for this timestamp — a JPEG from `frame_extract`; any
    /// format the engine reads works (the endpoint names the type from the
    /// extension, llama-mtmd sniffs the content).
    pub path: PathBuf,
}

/// Which prompt template to use — selects what the model is asked to emphasize
/// and, therefore, what populates `tags`. Part of the cache key (a different
/// focus is a different description).
///
/// The app's Video-understanding setting decides which one a gesture uses: the
/// host fills the tool's `focus` arg from it when the caller omits one, the way
/// it fills `language`. `General` is only what a caller with no app settings to
/// speak for resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// General timeline description (subjects, setting, action, shot type).
    General,
    /// Camera / shot-type emphasis — biases `tags` toward shot type, camera
    /// motion, framing.
    ShotType,
}

/// What an omitted `fps` resolves to, for a caller with no app settings to
/// speak for. The sampling analogue of [`Focus::General`] and
/// [`Language::DEFAULT_TAG`], and here for their reason: the `describe_clip`
/// tool and the `media://{id}/description` reader both take it from this one
/// place, so a bare-core write and a bare-core read land on one key.
pub const DEFAULT_FPS: f64 = 1.0;

impl Focus {
    /// Stable key fragment (part of the description cache key).
    pub fn as_str(self) -> &'static str {
        match self {
            Focus::General => "general",
            Focus::ShotType => "shot-type",
        }
    }

    /// Parse the tool's optional `focus` arg; unknown / absent → `General`.
    pub fn parse(s: Option<&str>) -> Focus {
        match s {
            Some("shot-type") | Some("shot_type") | Some("shot") => Focus::ShotType,
            _ => Focus::General,
        }
    }
}

/// The language the model must write its `text` and its `tags` in.
///
/// Part of the cache key, and it has to be: the range-lazy cache short-circuits
/// on `covers()`, so a window described in one language would be handed back
/// verbatim to a request in another — with no way to ever correct it. A language
/// is a different description of the same footage, exactly as a focus is.
///
/// Two fields because the two consumers want different strings. The prompt names
/// the language to the model (`"Simplified Chinese"`, not `"zh-CN"` — a BCP-47
/// tag is not a reliable instruction to a vision model), and the cache key wants
/// a CANONICAL tag, so `zh` and `zh-CN` share one entry instead of describing the
/// same source twice for the same prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Language {
    tag: String,
    name: String,
}

/// `(match prefix, canonical tag, name the prompt uses)`, in match order — a
/// longer prefix must precede the shorter one it extends, which is why every
/// Traditional-Chinese spelling sits above bare `zh`.
///
/// Deliberately short: the app ships two locales, and the rest are here because
/// the `language` arg is agent-visible and a BYO endpoint may serve any model.
/// An unrecognized tag is NOT coerced to English — it is passed to the model as
/// itself, which is the honest answer and the one a reader can diagnose.
const LANGUAGES: &[(&str, &str, &str)] = &[
    ("en", "en-US", "English"),
    ("zh-hant", "zh-Hant", "Traditional Chinese"),
    ("zh-tw", "zh-Hant", "Traditional Chinese"),
    ("zh-hk", "zh-Hant", "Traditional Chinese"),
    ("zh-mo", "zh-Hant", "Traditional Chinese"),
    ("zh", "zh-Hans", "Simplified Chinese"),
    ("ja", "ja", "Japanese"),
    ("ko", "ko", "Korean"),
    ("es", "es", "Spanish"),
    ("fr", "fr", "French"),
    ("de", "de", "German"),
    ("pt", "pt", "Portuguese"),
    ("ru", "ru", "Russian"),
];

impl Language {
    /// What an omitted `language` arg resolves to. English rather than "no
    /// instruction at all": one code path, so the prompt a default run sends is
    /// the prompt every run sends, and the model cannot be talked into the
    /// footage's own language by on-screen text.
    ///
    /// No TS twin: the renderer sends none of the three view arguments, and the
    /// host fills them from `vlm_config.json` (`main/mcp/server.ts`). This is the
    /// floor under that fill, not a value any UI restates.
    pub const DEFAULT_TAG: &'static str = "en-US";

    /// Parse a BCP-47-ish tag; absent → [`Self::DEFAULT_TAG`]. Case- and
    /// region-insensitive: matching is on a lowercased tag against a prefix that
    /// must end at a subtag boundary, so `zh-Hans-CN` finds `zh` and `english`
    /// does not find `en`.
    pub fn parse(s: Option<&str>) -> Language {
        let raw = s
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(Self::DEFAULT_TAG);
        let lower = raw.to_ascii_lowercase();
        for (prefix, tag, name) in LANGUAGES {
            let at_boundary = lower == *prefix
                || lower
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('-'));
            if at_boundary {
                return Language {
                    tag: (*tag).to_string(),
                    name: (*name).to_string(),
                };
            }
        }
        Language {
            tag: raw.to_string(),
            name: raw.to_string(),
        }
    }

    /// The canonical tag — the cache-key fragment.
    pub fn as_str(&self) -> &str {
        &self.tag
    }

    /// What the prompt calls this language to the model.
    pub fn prompt_name(&self) -> &str {
        &self.name
    }
}

impl Default for Language {
    fn default() -> Self {
        Language::parse(None)
    }
}

/// How long one describe request may run before it is abandoned — the hang
/// guard for EVERY engine, local sidecar and HTTP endpoint alike. NOT the
/// expected runtime, a ceiling that kills a wedged request. A cold local start
/// pays model-load + shader compile (~40s) and an 8B on CPU can run tens of
/// seconds per frame; a self-hosted server on modest hardware is no faster, so
/// an endpoint gets the same budget unless its model sets one (#69: a flat 180s
/// timed out a slow intranet server where the local engine would have waited).
pub fn describe_hang_guard(n_frames: usize) -> Duration {
    const FLOOR_SECS: u64 = 300;
    const PER_FRAME_SECS: u64 = 20;
    Duration::from_secs(FLOOR_SECS + (n_frames as u64).saturating_mul(PER_FRAME_SECS))
}

/// A fully-specified describe request: the sampled frames, the prompt focus,
/// the language the answer must come back in, and what is asked of them.
#[derive(Debug, Clone)]
pub struct DescribeRequest {
    pub frames: Vec<TimedFrame>,
    pub focus: Focus,
    pub language: Language,
    pub task: Task,
}

/// What a request asks of its frames. Both engines take both: the summary rides
/// the same frames-in seam because the local `llama-mtmd-cli` has no one-shot
/// text-only mode (without an image it opens an interactive chat), and frames
/// let the model check the outline against the footage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Task {
    /// The timestamped segment array (`parser::parse_raw`).
    #[default]
    Timeline,
    /// A few sentences over the whole window, given frames sampled evenly
    /// across it and the run's own timeline as `outline` (one line per segment,
    /// window-relative seconds). Read by `parser::parse_summary`.
    Summary { outline: String },
}

#[async_trait]
pub trait SceneDescriber: Send + Sync {
    /// Describe the request's frames and return one raw output style. Which
    /// style (which [`RawDescription`] variant) is the backend's choice — the
    /// parser layer normalizes it.
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError>;

    /// [`describe`](Self::describe), reporting the engine's phase. The default
    /// suits an HTTP endpoint: one request, in flight from the start, against a
    /// server whose model load is not ours to see (or to stop: cancelling drops
    /// the request, never the server). The local sidecar overrides it.
    async fn describe_observed(
        &self,
        req: DescribeRequest,
        observer: ModelObserver<'_>,
    ) -> Result<RawDescription, VlmError> {
        observer(ModelPhase::INFERRING);
        self.describe(req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hang_guard_scales_with_frame_count() {
        assert!(describe_hang_guard(16) > describe_hang_guard(1));
        assert!(describe_hang_guard(0).as_secs() >= 300);
    }

    #[test]
    fn language_absent_or_blank_is_the_default() {
        assert_eq!(Language::parse(None).as_str(), Language::DEFAULT_TAG);
        assert_eq!(Language::parse(Some("   ")).as_str(), Language::DEFAULT_TAG);
        assert_eq!(Language::default().as_str(), Language::DEFAULT_TAG);
    }

    #[test]
    fn language_canonicalizes_spellings_that_share_a_prompt() {
        // Every spelling the app or an OS may hand us for one language keys ONE
        // cache entry — the whole point of canonicalizing rather than hashing
        // the raw tag.
        for tag in ["zh", "zh-CN", "zh-Hans", "zh-hans-cn", "ZH-Hans"] {
            let l = Language::parse(Some(tag));
            assert_eq!(l.as_str(), "zh-Hans", "{tag}");
            assert_eq!(l.prompt_name(), "Simplified Chinese", "{tag}");
        }
        for tag in ["zh-TW", "zh-Hant", "zh-HK", "zh-MO"] {
            assert_eq!(Language::parse(Some(tag)).as_str(), "zh-Hant", "{tag}");
        }
        for tag in ["en", "en-US", "en-GB"] {
            assert_eq!(Language::parse(Some(tag)).as_str(), "en-US", "{tag}");
        }
    }

    #[test]
    fn language_matches_only_at_a_subtag_boundary() {
        // "english" starts with "en" but is not the `en` subtag; coercing it
        // would hide a caller's typo behind a plausible answer.
        assert_eq!(Language::parse(Some("english")).as_str(), "english");
        assert_eq!(Language::parse(Some("eng")).as_str(), "eng");
    }

    #[test]
    fn language_passes_an_unknown_tag_through_verbatim() {
        let l = Language::parse(Some("nl-NL"));
        assert_eq!(l.as_str(), "nl-NL");
        // Named to the model as itself rather than silently as English.
        assert_eq!(l.prompt_name(), "nl-NL");
    }
}
