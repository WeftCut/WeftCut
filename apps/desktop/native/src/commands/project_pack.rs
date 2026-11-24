//! Packed projects (ADR 0178): one `.weftcut` file holding a project folder's
//! content, and the way back to a folder. Main decides which files go in
//! (`src/main/state/projectContent.ts`) and what an archive may hold; this
//! module writes and reads the bytes. A pack is a ZIP whose entries are all
//! stored as they are, with ZIP64 for any entry of 4 GiB or more, and a
//! manifest as its first entry.
//!
//! Neither direction leaves a partial result under its final name: a pack is
//! written to `<out>.part` and renamed, an unpack fills a dot-named sibling
//! folder and renames it. A cancelled or failed run removes what it wrote.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::state::project_path::{fold_case, ProjectRelPath};

/// The archive entry that lists every file and the exact time to give it back.
pub const MANIFEST_ENTRY: &str = "weftcut-pack.json";
/// Bump when a reader of an older format could misread a newer pack.
pub const PACK_FORMAT: u32 = 1;
/// The largest manifest or project.json an archive may hold: both are read
/// whole before anything is written.
const MAX_TEXT_ENTRY: u64 = 64 * 1024 * 1024;
/// Bounds an archive this module did not write before it is walked.
pub const MAX_ENTRIES: usize = 200_000;
/// ZIP sizes without ZIP64 are 32-bit.
const ZIP64_AT: u64 = 0xFFFF_FFFF;
const CHUNK: usize = 1024 * 1024;

/// One file of a pack: where it lives in the project folder, how many bytes it
/// has, and its modification time in milliseconds since the Unix epoch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackFile {
    pub path: ProjectRelPath,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackManifest {
    pub format: u32,
    pub app_version: String,
    pub schema_version: u32,
    pub files: Vec<PackFile>,
}

/// What main reads of a pack before choosing where to unpack it.
#[derive(Clone, Debug, Serialize)]
pub struct PackInspection {
    pub manifest: PackManifest,
    pub project_json: String,
    pub total_bytes: u64,
}

/// Bytes done of the run's total, for the work pill.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct PackProgress {
    pub done: u64,
    pub total: u64,
}

/// Why a run stopped. `Cancelled` is the caller's own request.
#[derive(Debug, PartialEq, Eq)]
pub enum PackError {
    Cancelled,
    Failed(String),
}

impl From<io::Error> for PackError {
    fn from(e: io::Error) -> Self {
        PackError::Failed(e.to_string())
    }
}

impl From<zip::result::ZipError> for PackError {
    fn from(e: zip::result::ZipError) -> Self {
        PackError::Failed(e.to_string())
    }
}

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PackError::Cancelled => f.write_str("cancelled"),
            PackError::Failed(m) => f.write_str(m),
        }
    }
}

fn failed(message: impl Into<String>) -> PackError {
    PackError::Failed(message.into())
}

/// A run's cancel flag and progress callback, checked between chunks.
pub struct Run<'a> {
    pub cancel: &'a AtomicBool,
    pub progress: &'a dyn Fn(PackProgress),
}

impl Run<'_> {
    fn check(&self) -> Result<(), PackError> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(PackError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Sets the flag when dropped: the async caller of a blocking run is dropped
/// on cancel, and the run sees the flag at its next chunk.
pub struct CancelOnDrop(pub Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    match meta.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        },
        Err(_) => 0,
    }
}

fn system_time(ms: i64) -> SystemTime {
    if ms >= 0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs())
    }
}

/// The ZIP entry time OS archive tools show: UTC, 2-second steps, clamped to
/// the 1980–2107 range the format holds. The manifest keeps the exact time.
fn zip_time(ms: i64) -> DateTime {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    if !(1980..=2107).contains(&year) {
        return DateTime::default();
    }
    DateTime::from_date_and_time(
        year as u16,
        month as u8,
        day as u8,
        (rem / 3600) as u8,
        (rem % 3600 / 60) as u8,
        (rem % 60) as u8,
    )
    .unwrap_or_default()
}

/// Refuses a set of paths two of which one case-insensitive volume would hold
/// as one name, or that names one path both a file and a folder.
fn check_unambiguous<'a>(
    paths: impl IntoIterator<Item = &'a ProjectRelPath>,
) -> Result<(), PackError> {
    let mut nodes: HashMap<String, (String, bool)> = HashMap::new();
    for path in paths {
        let segments: Vec<&str> = path.as_str().split('/').collect();
        for i in 1..=segments.len() {
            let prefix = segments[..i].join("/");
            let is_dir = i < segments.len();
            let key = fold_case(&prefix);
            match nodes.get(&key) {
                Some((name, dir)) if name != &prefix || *dir != is_dir || !is_dir => {
                    return Err(failed(format!("{prefix} collides with {name}")));
                }
                Some(_) => {}
                None => {
                    nodes.insert(key, (prefix, is_dir));
                }
            }
        }
    }
    Ok(())
}

fn copy_counted(
    from: &mut impl Read,
    to: &mut impl Write,
    expected: u64,
    run: &Run<'_>,
    done: &mut u64,
    total: u64,
) -> Result<u64, PackError> {
    let mut buf = vec![0u8; CHUNK];
    let mut copied: u64 = 0;
    loop {
        run.check()?;
        let n = from.read(&mut buf)?;
        if n == 0 {
            return Ok(copied);
        }
        copied += n as u64;
        if copied > expected {
            return Ok(copied);
        }
        to.write_all(&buf[..n])?;
        *done += n as u64;
        (run.progress)(PackProgress { done: *done, total });
    }
}

/// The sibling a run writes before its rename: `<dir>/.<name>.<id>.part`.
fn part_path(target: &Path) -> Result<PathBuf, PackError> {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| failed(format!("{} has no file name", target.display())))?;
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    Ok(parent.join(format!(".{name}.{}.part", uuid::Uuid::new_v4().simple())))
}

/// Writes the files `files` of the project folder `root` to the pack `out`,
/// replacing a file already there only once the new pack is complete. Each
/// file is read as it is now; one that changes size while it is copied fails
/// the pack.
pub fn pack(
    root: &Path,
    out: &Path,
    files: &[ProjectRelPath],
    app_version: &str,
    schema_version: u32,
    run: &Run<'_>,
) -> Result<PackManifest, PackError> {
    pack_with(root, out, files, app_version, schema_version, run, ZIP64_AT)
}

fn pack_with(
    root: &Path,
    out: &Path,
    files: &[ProjectRelPath],
    app_version: &str,
    schema_version: u32,
    run: &Run<'_>,
    zip64_at: u64,
) -> Result<PackManifest, PackError> {
    check_unambiguous(files)?;
    let mut listed = Vec::with_capacity(files.len());
    for path in files {
        let meta = fs::symlink_metadata(path.to_native(root))
            .map_err(|e| failed(format!("{path}: {e}")))?;
        if !meta.is_file() {
            return Err(failed(format!("{path} is not a file")));
        }
        listed.push(PackFile {
            path: path.clone(),
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
        });
    }
    let manifest = PackManifest {
        format: PACK_FORMAT,
        app_version: app_version.to_owned(),
        schema_version,
        files: listed,
    };
    let part = part_path(out)?;
    let result = write_pack(root, &part, &manifest, run, zip64_at).and_then(|()| {
        replace_file(&part, out)?;
        Ok(())
    });
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result.map(|()| manifest)
}

fn write_pack(
    root: &Path,
    part: &Path,
    manifest: &PackManifest,
    run: &Run<'_>,
    zip64_at: u64,
) -> Result<(), PackError> {
    let file = File::create_new(part)?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(CHUNK, file));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let text = serde_json::to_vec_pretty(manifest).map_err(|e| failed(e.to_string()))?;
    zip.start_file(MANIFEST_ENTRY, stored)?;
    zip.write_all(&text)?;
    let total: u64 = manifest.files.iter().map(|f| f.size).sum();
    let mut done = 0u64;
    (run.progress)(PackProgress { done, total });
    for entry in &manifest.files {
        run.check()?;
        let options = stored
            .large_file(entry.size >= zip64_at)
            .last_modified_time(zip_time(entry.mtime_ms));
        zip.start_file(entry.path.as_str(), options)?;
        let mut source = File::open(entry.path.to_native(root))?;
        let copied = copy_counted(&mut source, &mut zip, entry.size, run, &mut done, total)?;
        if copied != entry.size {
            return Err(failed(format!(
                "{} changed while it was packed",
                entry.path
            )));
        }
    }
    let writer = zip.finish()?;
    let file = writer.into_inner().map_err(|e| failed(e.to_string()))?;
    file.sync_all()?;
    Ok(())
}

/// Renames `part` over `target`. Windows refuses a rename onto an existing
/// file, so one there goes first; the new pack is complete by then.
fn replace_file(part: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(part, target) {
        Ok(()) => Ok(()),
        Err(_) if target.is_file() => {
            fs::remove_file(target)?;
            fs::rename(part, target)
        }
        Err(e) => Err(e),
    }
}

fn read_text<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str) -> Result<String, PackError> {
    let entry = archive
        .by_name(name)
        .map_err(|_| failed(format!("the pack holds no {name}")))?;
    if entry.size() > MAX_TEXT_ENTRY {
        return Err(failed(format!(
            "{name} is larger than a pack's {name} can be"
        )));
    }
    let mut text = String::new();
    entry.take(MAX_TEXT_ENTRY).read_to_string(&mut text)?;
    Ok(text)
}

/// Reads the manifest and project.json of the pack `archive` and checks that
/// its entries are exactly the files the manifest lists, each a project path
/// under one of `allowed_top` and at the size the manifest gives. Writes
/// nothing.
pub fn inspect(archive: &Path, allowed_top: &[String]) -> Result<PackInspection, PackError> {
    let mut zip = ZipArchive::new(BufReader::new(File::open(archive)?))
        .map_err(|e| failed(format!("not a WeftCut pack: {e}")))?;
    let (manifest, project_json) = validate(&mut zip, allowed_top)?;
    let total_bytes = manifest.files.iter().map(|f| f.size).sum();
    Ok(PackInspection {
        manifest,
        project_json,
        total_bytes,
    })
}

fn validate<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    allowed_top: &[String],
) -> Result<(PackManifest, String), PackError> {
    if zip.len() > MAX_ENTRIES + 1 {
        return Err(failed("the pack has more entries than a project can"));
    }
    let manifest: PackManifest = serde_json::from_str(&read_text(zip, MANIFEST_ENTRY)?)
        .map_err(|e| failed(format!("the pack's manifest is unreadable: {e}")))?;
    if manifest.format != PACK_FORMAT {
        return Err(failed(format!(
            "the pack is format {}, this app reads format {PACK_FORMAT}",
            manifest.format
        )));
    }
    let allowed: HashSet<&str> = allowed_top.iter().map(String::as_str).collect();
    let mut expected: HashMap<&str, u64> = HashMap::new();
    for file in &manifest.files {
        let top = file.path.as_str().split('/').next().unwrap_or_default();
        if !allowed.contains(top) {
            return Err(failed(format!("{} is not project content", file.path)));
        }
        if expected.insert(file.path.as_str(), file.size).is_some() {
            return Err(failed(format!("{} is listed twice", file.path)));
        }
    }
    check_unambiguous(manifest.files.iter().map(|f| &f.path))?;
    let mut seen = 0usize;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i)?;
        let name = entry
            .name()
            .map_err(|e| failed(e.to_string()))?
            .into_owned();
        if name == MANIFEST_ENTRY || (entry.is_dir() && entry.size() == 0) {
            continue;
        }
        if entry.is_symlink() {
            return Err(failed(format!("{name} is a link")));
        }
        match expected.get(name.as_str()) {
            Some(&size)
                if size == entry.size() && entry.compression() == CompressionMethod::Stored =>
            {
                seen += 1
            }
            Some(_) => return Err(failed(format!("{name} is not as the manifest lists it"))),
            None => return Err(failed(format!("{name} is not in the manifest"))),
        }
    }
    if seen != expected.len() {
        return Err(failed("the pack lacks files its manifest lists"));
    }
    let project_json = read_text(zip, "project.json")?;
    Ok((manifest, project_json))
}

/// Unpacks the pack `archive` into the new folder `target`, which must not
/// exist yet (an empty folder is taken). Each file gets the manifest's
/// modification time back, so the project opens without hashing its media
/// again. Answers the number of files written.
pub fn unpack(
    archive: &Path,
    target: &Path,
    allowed_top: &[String],
    run: &Run<'_>,
) -> Result<usize, PackError> {
    if let Ok(mut entries) = fs::read_dir(target) {
        if entries.next().is_some() {
            return Err(failed(format!("{} is not empty", target.display())));
        }
    } else if target.exists() {
        return Err(failed(format!("{} is not a folder", target.display())));
    }
    let mut zip = ZipArchive::new(BufReader::new(File::open(archive)?))
        .map_err(|e| failed(format!("not a WeftCut pack: {e}")))?;
    let (manifest, _) = validate(&mut zip, allowed_top)?;
    let staging = part_path(target)?;
    let result = extract(&mut zip, &manifest, &staging, run).and_then(|()| {
        if target.exists() {
            fs::remove_dir(target)?;
        }
        fs::rename(&staging, target)?;
        Ok(())
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|()| manifest.files.len())
}

fn extract<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    manifest: &PackManifest,
    staging: &Path,
    run: &Run<'_>,
) -> Result<(), PackError> {
    fs::create_dir(staging)?;
    let total: u64 = manifest.files.iter().map(|f| f.size).sum();
    let mut done = 0u64;
    (run.progress)(PackProgress { done, total });
    for file in &manifest.files {
        run.check()?;
        let dest = file.path.to_native(staging);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut entry = zip.by_name(file.path.as_str())?;
        let mut out = BufWriter::with_capacity(CHUNK, File::create_new(&dest)?);
        // Reading the entry to its end checks its CRC-32: a corrupt entry
        // fails here.
        let copied = copy_counted(&mut entry, &mut out, file.size, run, &mut done, total)?;
        if copied != file.size {
            return Err(failed(format!(
                "{} is not as the manifest lists it",
                file.path
            )));
        }
        let out = out.into_inner().map_err(|e| failed(e.to_string()))?;
        out.sync_all()?;
        drop(out);
        filetime::set_file_mtime(
            &dest,
            filetime::FileTime::from_system_time(system_time(file.mtime_ms)),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn top() -> Vec<String> {
        [
            "project.json",
            "Media",
            "Motifs",
            "Fonts",
            "Styles",
            "TASTE.md",
            "export.json",
            "view.json",
            ".gitignore",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    fn p(s: &str) -> ProjectRelPath {
        ProjectRelPath::try_from(s.to_owned()).unwrap()
    }

    fn put(root: &Path, rel: &str, bytes: &[u8], mtime_ms: i64) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        filetime::set_file_mtime(
            &path,
            filetime::FileTime::from_system_time(system_time(mtime_ms)),
        )
        .unwrap();
    }

    /// A small project: project.json, a clip in a subfolder, a Motif.
    fn project(root: &Path) -> Vec<ProjectRelPath> {
        put(
            root,
            "project.json",
            b"{\"schema_version\":7}",
            1_700_000_000_123,
        );
        put(root, "Media/sub/clip.mp4", &[7u8; 3000], 1_600_000_000_456);
        put(
            root,
            "Motifs/title/index.html",
            b"<html></html>",
            1_650_000_000_000,
        );
        put(
            root,
            "Cache/proxies/clip.mp4",
            b"machine-local",
            1_650_000_000_000,
        );
        vec![
            p("project.json"),
            p("Media/sub/clip.mp4"),
            p("Motifs/title/index.html"),
        ]
    }

    fn quiet() -> (AtomicBool, impl Fn(PackProgress)) {
        (AtomicBool::new(false), |_| {})
    }

    #[test]
    fn a_pack_unpacks_to_the_same_files_with_the_same_times() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let files = project(&src);
        let out = dir.path().join("demo.weftcut");
        let (cancel, progress) = quiet();
        let run = Run {
            cancel: &cancel,
            progress: &progress,
        };
        pack(&src, &out, &files, "1.0.0", 7, &run).unwrap();

        let dst = dir.path().join("dst");
        assert_eq!(unpack(&out, &dst, &top(), &run).unwrap(), files.len());
        for f in &files {
            let a = fs::metadata(f.to_native(&src)).unwrap();
            let b = fs::metadata(f.to_native(&dst)).unwrap();
            assert_eq!(
                fs::read(f.to_native(&src)).unwrap(),
                fs::read(f.to_native(&dst)).unwrap(),
                "{f}"
            );
            assert_eq!(
                mtime_ms(&a),
                mtime_ms(&b),
                "{f} keeps its modification time"
            );
        }
        assert!(!dst.join("Cache").exists(), "only the listed files travel");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty(), "no staging left behind");
    }

    #[test]
    fn an_entry_written_as_zip64_unpacks() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let files = project(&src);
        let out = dir.path().join("demo.weftcut");
        let (cancel, progress) = quiet();
        let run = Run {
            cancel: &cancel,
            progress: &progress,
        };
        // Every entry over 0 bytes takes the ZIP64 form a 4 GiB file needs.
        pack_with(&src, &out, &files, "1.0.0", 7, &run, 1).unwrap();
        let dst = dir.path().join("dst");
        unpack(&out, &dst, &top(), &run).unwrap();
        assert_eq!(
            fs::read(dst.join("Media/sub/clip.mp4")).unwrap(),
            vec![7u8; 3000]
        );
    }

    #[test]
    fn progress_ends_at_the_total_of_the_listed_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let files = project(&src);
        let total: u64 = files
            .iter()
            .map(|f| fs::metadata(f.to_native(&src)).unwrap().len())
            .sum();
        let seen = Mutex::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let progress = |p: PackProgress| seen.lock().unwrap().push(p);
        pack(
            &src,
            &dir.path().join("a.weftcut"),
            &files,
            "1.0.0",
            7,
            &Run {
                cancel: &cancel,
                progress: &progress,
            },
        )
        .unwrap();
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.last(), Some(&PackProgress { done: total, total }));
        assert!(
            seen.windows(2).all(|w| w[0].done <= w[1].done),
            "progress never goes back"
        );
    }

    #[test]
    fn a_cancelled_pack_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let files = project(&src);
        let out = dir.path().join("demo.weftcut");
        let cancel = AtomicBool::new(false);
        let progress = |p: PackProgress| {
            if p.done > 0 {
                cancel.store(true, Ordering::Relaxed)
            }
        };
        let err = pack(
            &src,
            &out,
            &files,
            "1.0.0",
            7,
            &Run {
                cancel: &cancel,
                progress: &progress,
            },
        )
        .unwrap_err();
        assert_eq!(err, PackError::Cancelled);
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("src")]);
    }

    #[test]
    fn a_cancelled_unpack_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let files = project(&src);
        let out = dir.path().join("demo.weftcut");
        let (cancel, progress) = quiet();
        pack(
            &src,
            &out,
            &files,
            "1.0.0",
            7,
            &Run {
                cancel: &cancel,
                progress: &progress,
            },
        )
        .unwrap();
        let stop = AtomicBool::new(false);
        let progress = |p: PackProgress| {
            if p.done > 0 {
                stop.store(true, Ordering::Relaxed)
            }
        };
        let dst = dir.path().join("dst");
        assert_eq!(
            unpack(
                &out,
                &dst,
                &top(),
                &Run {
                    cancel: &stop,
                    progress: &progress
                }
            )
            .unwrap_err(),
            PackError::Cancelled
        );
        let mut names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec!["demo.weftcut", "src"]);
    }

    #[test]
    fn unpack_refuses_a_folder_that_holds_files() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let files = project(&src);
        let out = dir.path().join("demo.weftcut");
        let (cancel, progress) = quiet();
        let run = Run {
            cancel: &cancel,
            progress: &progress,
        };
        pack(&src, &out, &files, "1.0.0", 7, &run).unwrap();
        let dst = dir.path().join("dst");
        put(&dst, "notes.txt", b"mine", 0);
        assert!(matches!(
            unpack(&out, &dst, &top(), &run),
            Err(PackError::Failed(_))
        ));
        assert_eq!(fs::read(dst.join("notes.txt")).unwrap(), b"mine");
        let empty = dir.path().join("empty");
        fs::create_dir(&empty).unwrap();
        unpack(&out, &empty, &top(), &run).unwrap();
        assert!(
            empty.join("project.json").is_file(),
            "an empty folder is taken"
        );
    }

    /// Writes a ZIP by hand: `entries` after a manifest listing `listed`.
    fn handmade(
        path: &Path,
        listed: &[(&str, u64)],
        entries: &[(&str, &[u8])],
        link: Option<&str>,
    ) {
        let manifest = serde_json::json!({
            "format": PACK_FORMAT, "app_version": "1.0.0", "schema_version": 7,
            "files": listed.iter().map(|(p, s)| serde_json::json!({ "path": p, "size": s, "mtime_ms": 0 })).collect::<Vec<_>>(),
        });
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file(MANIFEST_ENTRY, stored).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        for (name, bytes) in entries {
            zip.start_file(*name, stored).unwrap();
            zip.write_all(bytes).unwrap();
        }
        if let Some(name) = link {
            zip.add_symlink(name, "/etc/passwd", stored).unwrap();
        }
        zip.finish().unwrap();
    }

    fn refused(listed: &[(&str, u64)], entries: &[(&str, &[u8])], link: Option<&str>) {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("bad.weftcut");
        handmade(&archive, listed, entries, link);
        let (cancel, progress) = quiet();
        let dst = dir.path().join("dst");
        assert!(
            inspect(&archive, &top()).is_err(),
            "inspect refuses {listed:?}"
        );
        assert!(
            unpack(
                &archive,
                &dst,
                &top(),
                &Run {
                    cancel: &cancel,
                    progress: &progress
                }
            )
            .is_err(),
            "unpack refuses {listed:?}"
        );
        assert!(!dst.exists(), "nothing written for {listed:?}");
    }

    #[test]
    fn a_pack_this_app_did_not_write_is_checked_before_anything_is_written() {
        let pj: &[u8] = b"{}";
        // A path that leaves the folder, through `..` or as an absolute path.
        refused(
            &[("project.json", 2), ("../evil", 1)],
            &[("project.json", pj), ("../evil", b"x")],
            None,
        );
        refused(
            &[("project.json", 2)],
            &[("project.json", pj), ("/etc/evil", b"x")],
            None,
        );
        // A file outside the project content.
        refused(
            &[("project.json", 2), ("Cache/x", 1)],
            &[("project.json", pj), ("Cache/x", b"x")],
            None,
        );
        // Two names one case-insensitive volume holds as one.
        refused(
            &[("project.json", 2), ("Media/a.mp4", 1), ("Media/A.mp4", 1)],
            &[
                ("project.json", pj),
                ("Media/a.mp4", b"x"),
                ("Media/A.mp4", b"y"),
            ],
            None,
        );
        // An entry the manifest does not list, or a size it does not give.
        refused(
            &[("project.json", 2)],
            &[("project.json", pj), ("Media/extra.mp4", b"x")],
            None,
        );
        refused(
            &[("project.json", 2), ("Media/a.mp4", 5)],
            &[("project.json", pj), ("Media/a.mp4", b"x")],
            None,
        );
        // A listed file the archive lacks.
        refused(
            &[("project.json", 2), ("Media/a.mp4", 1)],
            &[("project.json", pj)],
            None,
        );
        // A link, even one the manifest lists at its target's length.
        refused(
            &[("project.json", 2), ("Media/link", 11)],
            &[("project.json", pj)],
            Some("Media/link"),
        );
        // No project.json.
        refused(&[("Media/a.mp4", 1)], &[("Media/a.mp4", b"x")], None);
    }

    #[test]
    fn inspect_answers_the_manifest_and_project_json() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let files = project(&src);
        let out = dir.path().join("demo.weftcut");
        let (cancel, progress) = quiet();
        pack(
            &src,
            &out,
            &files,
            "1.2.3",
            7,
            &Run {
                cancel: &cancel,
                progress: &progress,
            },
        )
        .unwrap();
        let seen = inspect(&out, &top()).unwrap();
        assert_eq!(seen.manifest.schema_version, 7);
        assert_eq!(seen.manifest.app_version, "1.2.3");
        assert_eq!(seen.project_json, "{\"schema_version\":7}");
        assert_eq!(
            seen.total_bytes,
            files
                .iter()
                .map(|f| fs::metadata(f.to_native(&src)).unwrap().len())
                .sum::<u64>()
        );
    }

    #[test]
    fn a_pack_refuses_two_files_one_volume_would_merge() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        put(&src, "project.json", b"{}", 0);
        put(&src, "Media/a.mp4", b"x", 0);
        let (cancel, progress) = quiet();
        let run = Run {
            cancel: &cancel,
            progress: &progress,
        };
        let err = pack(
            &src,
            &dir.path().join("a.weftcut"),
            &[p("project.json"), p("Media/a.mp4"), p("Media/A.mp4")],
            "1",
            7,
            &run,
        );
        assert!(matches!(err, Err(PackError::Failed(_))));
    }

    #[test]
    fn zip_times_are_the_civil_utc_time() {
        // 2023-11-14T22:13:20Z
        let t = zip_time(1_700_000_000_000);
        assert_eq!(
            (
                t.year(),
                t.month(),
                t.day(),
                t.hour(),
                t.minute(),
                t.second()
            ),
            (2023, 11, 14, 22, 13, 20)
        );
        assert_eq!(
            zip_time(0),
            DateTime::default(),
            "before 1980 the format has no time"
        );
    }
}
