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

use async_trait::async_trait;

use super::error::VlmError;
use super::parser::RawDescription;

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
    /// Extracted still (PNG) for this timestamp.
    pub path: PathBuf,
}

/// Which prompt template to use — selects what the model is asked to emphasize
/// and, therefore, what populates `tags`. Part of the cache key (a different
/// focus is a different description). `General` is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// General timeline description (subjects, setting, action, shot type).
    General,
    /// Camera / shot-type emphasis — biases `tags` toward shot type, camera
    /// motion, framing.
    ShotType,
}

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
    /// TWIN of `DEFAULT_LANGUAGE` in `renderer/describe/describeRun.ts` — see
    /// `Focus::parse`'s twin note in `DescribeDialog.tsx`.
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

/// A fully-specified describe request: the sampled frames, the prompt focus and
/// the language the answer must come back in.
#[derive(Debug, Clone)]
pub struct DescribeRequest {
    pub frames: Vec<TimedFrame>,
    pub focus: Focus,
    pub language: Language,
}

#[async_trait]
pub trait SceneDescriber: Send + Sync {
    /// Describe the request's frames and return one raw output style. Which
    /// style (which [`RawDescription`] variant) is the backend's choice — the
    /// parser layer normalizes it.
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError>;
}

#[cfg(test)]
mod tests {
    use super::*;

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
