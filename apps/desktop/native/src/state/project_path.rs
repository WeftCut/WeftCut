//! Project paths: where a file lives inside a project folder, in the one form
//! every OS can open, and the sanitizer that turns an outside file name into a
//! portable one.
//!
//! Twin of `src/shared/projectPath.ts`: both test against
//! `fixtures/project-paths.json`, so a rule changes in both or in neither.

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

/// Fits every common filesystem's name cap: ext4 counts 255 bytes, NTFS and
/// APFS 255 UTF-16 units, and a UTF-8 name never has fewer bytes than units.
pub const MAX_SEGMENT_BYTES: usize = 255;

/// Characters Windows refuses in a name; `/` because it separates segments.
const RESERVED_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// A path inside a project folder: `/`-separated segments, each one a name
/// Windows, macOS and Linux all accept and spell the same way (NFC).
///
/// No `AsRef<Path>` or `Deref` on purpose: [`ProjectRelPath::to_native`] is the
/// only way to an OS path, so `root.join(&rel)` cannot compile.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProjectRelPath(String);

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{path:?} is not a project path: {reason}")]
pub struct ProjectPathError {
    pub path: String,
    pub reason: &'static str,
}

impl ProjectRelPath {
    /// Joins `segments` with `/`; each one must be a portable name.
    pub fn of<I, S>(segments: I) -> Result<Self, ProjectPathError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut joined = String::new();
        for (i, segment) in segments.into_iter().enumerate() {
            let segment = segment.as_ref();
            if let Some(reason) = segment_problem(segment) {
                return Err(ProjectPathError {
                    path: segment.to_owned(),
                    reason,
                });
            }
            if i > 0 {
                joined.push('/');
            }
            joined.push_str(segment);
        }
        Self::try_from(joined)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `root` plus this path, one segment at a time, so the separator is the
    /// host's.
    pub fn to_native(&self, root: &Path) -> PathBuf {
        let mut out = root.to_path_buf();
        for segment in self.0.split('/') {
            out.push(segment);
        }
        out
    }

    /// This path with one more segment.
    pub fn join(&self, segment: &str) -> Result<Self, ProjectPathError> {
        if let Some(reason) = segment_problem(segment) {
            return Err(ProjectPathError {
                path: segment.to_owned(),
                reason,
            });
        }
        Ok(Self(format!("{}/{segment}", self.0)))
    }

    pub fn file_name(&self) -> &str {
        // Never empty: the invariant guarantees one non-empty segment.
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }
}

impl TryFrom<String> for ProjectRelPath {
    type Error = ProjectPathError;

    fn try_from(path: String) -> Result<Self, Self::Error> {
        let problem = if path.is_empty() {
            Some("empty")
        } else {
            path.split('/').find_map(segment_problem)
        };
        match problem {
            Some(reason) => Err(ProjectPathError { path, reason }),
            None => Ok(Self(path)),
        }
    }
}

impl FromStr for ProjectRelPath {
    type Err = ProjectPathError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::try_from(s.to_owned())
    }
}

impl From<ProjectRelPath> for String {
    fn from(path: ProjectRelPath) -> Self {
        path.0
    }
}

impl fmt::Display for ProjectRelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Why `segment` is not a portable name, or `None` when it is.
fn segment_problem(segment: &str) -> Option<&'static str> {
    if segment.is_empty() {
        return Some("empty segment");
    }
    if segment == "." || segment == ".." {
        return Some("dot segment");
    }
    if segment.len() > MAX_SEGMENT_BYTES {
        return Some("segment over 255 UTF-8 bytes");
    }
    if segment.chars().any(|c| RESERVED_CHARS.contains(&c)) {
        return Some("reserved character");
    }
    if segment.chars().any(|c| c < '\u{20}') {
        return Some("control character");
    }
    if segment.ends_with(['.', ' ']) {
        return Some("trailing dot or space");
    }
    if is_device_stem(stem(segment)) {
        return Some("Windows device name");
    }
    if !unicode_normalization::is_nfc(segment) {
        return Some("not NFC");
    }
    None
}

/// The part before the first `.`: Windows opens the device for `NUL`,
/// `nul.mp4` and `nul.x.y` alike.
fn stem(segment: &str) -> &str {
    segment.split('.').next().unwrap_or(segment)
}

fn is_device_stem(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => match upper.as_bytes() {
            [b'C', b'O', b'M', d] | [b'L', b'P', b'T', d] => (b'1'..=b'9').contains(d),
            _ => false,
        },
    }
}

/// The form two names are compared in for "already taken": a folder on
/// Windows or macOS holds one of `Clip.mp4` and `clip.mp4`, never both.
pub fn fold_case(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

/// A portable file name for `name` that no existing name takes.
/// `taken` receives a candidate already passed through [`fold_case`] and
/// answers whether a name with that folded form exists (on disk or reserved).
///
/// Rewrites what a project path refuses: reserved and control characters
/// become `_`, a trailing `.`/space goes, a device stem gains `_` (`CON.mp4` →
/// `CON_.mp4`), nothing left becomes `media`, and the name is cut to
/// [`MAX_SEGMENT_BYTES`] keeping its extension. A taken name gets `-2`, `-3`…
/// before the extension.
pub fn portable_file_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let clean = clean_name(name);
    let (stem, ext) = split_ext(&clean);
    let mut n: u32 = 1;
    loop {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = fit(stem, &suffix, ext);
        if !taken(&fold_case(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// `name` with every refused form rewritten; not yet length-capped.
fn clean_name(name: &str) -> String {
    let replaced: String = name
        .nfc()
        .map(|c| {
            if c < '\u{20}' || RESERVED_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return "media".to_owned();
    }
    let stem_len = stem(trimmed).len();
    if is_device_stem(&trimmed[..stem_len]) {
        format!("{}_{}", &trimmed[..stem_len], &trimmed[stem_len..])
    } else {
        trimmed.to_owned()
    }
}

/// Splits off the last `.ext`. An extension over half the cap counts as stem,
/// so cutting the stem for the cap always leaves a long, non-device stem.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= MAX_SEGMENT_BYTES / 2 => name.split_at(i),
        _ => (name, ""),
    }
}

/// `stem + suffix + ext` within the cap, the stem cut on a char boundary.
fn fit(stem: &str, suffix: &str, ext: &str) -> String {
    let budget = MAX_SEGMENT_BYTES - suffix.len() - ext.len();
    let mut cut = stem.len().min(budget);
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    let joined = format!("{}{suffix}{ext}", &stem[..cut]);
    // A cut with no extension can end in `.`/space or leave a device stem.
    clean_name(&joined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[derive(Deserialize)]
    struct Vectors {
        valid: Vec<String>,
        invalid: Vec<Invalid>,
        #[serde(rename = "portableFileName")]
        portable_file_name: Vec<Portable>,
    }

    #[derive(Deserialize)]
    struct Invalid {
        path: String,
        why: String,
    }

    #[derive(Deserialize)]
    struct Portable {
        name: String,
        taken: Vec<String>,
        out: String,
    }

    fn vectors() -> Vectors {
        let raw = include_str!("../../../fixtures/project-paths.json");
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn every_valid_vector_parses_and_round_trips_through_serde() {
        for path in vectors().valid {
            let parsed: ProjectRelPath = path
                .parse()
                .unwrap_or_else(|e| panic!("{path:?} should parse: {e}"));
            assert_eq!(parsed.as_str(), path);
            let json = serde_json::to_string(&parsed).unwrap();
            assert_eq!(json, serde_json::to_string(&path).unwrap());
            let back: ProjectRelPath = serde_json::from_str(&json).unwrap();
            assert_eq!(back, parsed);
        }
    }

    #[test]
    fn every_invalid_vector_is_refused() {
        for Invalid { path, why } in vectors().invalid {
            assert!(
                path.parse::<ProjectRelPath>().is_err(),
                "{path:?} should be refused ({why})"
            );
            let json = serde_json::to_string(&path).unwrap();
            assert!(
                serde_json::from_str::<ProjectRelPath>(&json).is_err(),
                "{path:?} should not deserialize ({why})"
            );
        }
    }

    #[test]
    fn portable_file_name_matches_every_vector() {
        for Portable { name, taken, out } in vectors().portable_file_name {
            let folded: HashSet<String> = taken.iter().map(|t| fold_case(t)).collect();
            let got = portable_file_name(&name, &|f| folded.contains(f));
            assert_eq!(got, out, "portable_file_name({name:?}, taken {taken:?})");
        }
    }

    #[test]
    fn portable_file_name_always_yields_a_valid_segment() {
        let long_ext = format!("a.{}", "e".repeat(200));
        let spaces_after_device = format!("COM1{}x", " ".repeat(300));
        let wide = "视".repeat(100) + ".mp4";
        for name in [
            "a\u{1}b",
            "...",
            "nul.x.y",
            long_ext.as_str(),
            spaces_after_device.as_str(),
            wide.as_str(),
        ] {
            let got = portable_file_name(name, &|_| false);
            assert_eq!(segment_problem(&got), None, "{name:?} → {got:?}");
            let suffixed = portable_file_name(name, &|f| f == fold_case(&got));
            assert_eq!(segment_problem(&suffixed), None, "{name:?} → {suffixed:?}");
            assert_ne!(fold_case(&suffixed), fold_case(&got));
        }
    }

    #[test]
    fn to_native_stays_under_root() {
        let root = Path::new("/home/u/Project");
        for path in vectors().valid {
            let rel: ProjectRelPath = path.parse().unwrap();
            let native = rel.to_native(root);
            assert!(native.starts_with(root), "{native:?} under {root:?}");
            let inside: Vec<_> = native.strip_prefix(root).unwrap().components().collect();
            assert_eq!(inside.len(), path.split('/').count());
            assert!(inside
                .iter()
                .all(|c| matches!(c, std::path::Component::Normal(_))));
        }
    }

    #[test]
    fn join_and_of_check_each_segment() {
        let media = ProjectRelPath::of(["Media"]).unwrap();
        let clip = media.join("clip.mp4").unwrap();
        assert_eq!(clip.as_str(), "Media/clip.mp4");
        assert_eq!(clip.file_name(), "clip.mp4");
        assert_eq!(ProjectRelPath::of(["Media", "clip.mp4"]).unwrap(), clip);
        assert!(media.join("sub/clip.mp4").is_err());
        assert!(media.join("..").is_err());
        assert!(ProjectRelPath::of(["Media/sub"]).is_err());
        assert!(ProjectRelPath::of(Vec::<&str>::new()).is_err());
    }

    #[test]
    fn a_media_item_with_a_backslash_path_does_not_deserialize() {
        #[derive(Deserialize)]
        struct Item {
            path_rel: Option<ProjectRelPath>,
        }
        let ok: Item = serde_json::from_str(r#"{"path_rel":"Media/x.mp4"}"#).unwrap();
        assert_eq!(ok.path_rel.unwrap().as_str(), "Media/x.mp4");
        assert!(serde_json::from_str::<Item>(r#"{"path_rel":"Media\\x.mp4"}"#).is_err());
    }
}
