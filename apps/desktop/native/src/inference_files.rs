//! Files crossing a local inference CLI boundary.
//!
//! Windows whisper.cpp/sherpa use narrow argv/file APIs. Passing an OsString
//! faithfully to CreateProcessW does not stop the child's CRT losing Unicode.
//! Give those engines ASCII relative names in a private working directory;
//! the OS can set that directory even when TEMP/user names contain Unicode.
//! Images use aliases on every OS because llama's --image splits on commas.
//! Never change the parent's current directory or the user's source files.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) struct InferenceFiles {
    dir: Arc<tempfile::TempDir>,
}

impl InferenceFiles {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            dir: Arc::new(
                tempfile::Builder::new()
                    .prefix("weftcut-inference-")
                    .tempdir()?,
            ),
        })
    }

    pub fn cwd(&self) -> &Path {
        self.dir.path()
    }

    /// Read-only input alias. Hard links avoid copying multi-GB weights; copy
    /// is the fallback for different volumes/filesystems without hard links.
    /// The blocking task retains the temp dir if its caller is cancelled during
    /// a copy, so cleanup happens after the file handle is closed.
    pub async fn input(&self, source: &Path, name: &str) -> io::Result<PathBuf> {
        validate_name(name)?;
        let source = std::path::absolute(source)?;
        let relative = PathBuf::from(name);
        let dest = self.cwd().join(&relative);
        let dir = Arc::clone(&self.dir);
        tokio::task::spawn_blocking(move || {
            let _keep_alive = dir;
            // Link the target, not a relative symlink that would point somewhere
            // different after it is placed in the inference workspace.
            let source = std::fs::canonicalize(&source).map_err(|e| {
                io::Error::new(
                    e.kind(),
                    format!("resolve inference input {}: {e}", source.display()),
                )
            })?;
            link_or_copy(&source, &dest, |from, to| std::fs::hard_link(from, to))
        })
        .await
        .map_err(io::Error::other)??;
        Ok(relative)
    }

    /// Only the legacy Windows speech engines require weight aliases. Retain
    /// native paths elsewhere (including adjacent auxiliary model files).
    pub async fn speech_model(&self, source: &Path, name: &str) -> io::Result<PathBuf> {
        let absolute = std::path::absolute(source)?;
        if cfg!(windows) && !absolute.as_os_str().is_ascii() {
            self.input(&absolute, name).await
        } else {
            Ok(absolute)
        }
    }
}

fn validate_name(name: &str) -> io::Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "inference alias must be a plain ASCII filename",
        ));
    }
    Ok(())
}

fn link_or_copy(
    source: &Path,
    dest: &Path,
    link: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    // Never overwrite an existing alias (including a hard link to a source).
    match link(source, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(link_error) => {
            let copy = || {
                let mut input = std::fs::File::open(source)?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dest)?;
                io::copy(&mut input, &mut output)?;
                Ok(())
            };
            copy().map_err(|e: io::Error| {
                io::Error::new(
                    e.kind(),
                    format!(
                        "prepare inference input {}: {e} (hard link unavailable: {link_error})",
                        source.display()
                    ),
                )
            })
        }
    }
}

/// Resolve a configured relative executable before changing the child's cwd.
/// Bare command names still use PATH lookup.
pub(crate) fn program_path(program: &Path) -> io::Result<PathBuf> {
    if program.components().count() == 1 && !program.exists() {
        Ok(program.to_owned())
    } else {
        std::path::absolute(program)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unicode_temp_root_and_inputs_get_safe_relative_names_and_cleanup() {
        let root = tempfile::Builder::new()
            .prefix("测试, 日本語 café 🐱 ")
            .tempdir()
            .unwrap();
        let source = root.path().join("原始, 音声.wav");
        std::fs::write(&source, b"original content").unwrap();
        let files = InferenceFiles {
            dir: Arc::new(tempfile::tempdir_in(root.path()).unwrap()),
        };
        let cwd = files.cwd().to_owned();
        let alias = files.input(&source, "audio.wav").await.unwrap();
        assert_eq!(alias, Path::new("audio.wav"));
        assert_eq!(std::fs::read(cwd.join(alias)).unwrap(), b"original content");
        drop(files);
        assert!(!cwd.exists());
        assert_eq!(std::fs::read(source).unwrap(), b"original content");
    }

    #[test]
    fn cross_volume_fallback_copies_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let dest = dir.path().join("alias");
        std::fs::write(&source, b"weights").unwrap();
        let no_links =
            |_: &Path, _: &Path| Err(io::Error::new(io::ErrorKind::Unsupported, "no hard links"));
        link_or_copy(&source, &dest, no_links).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"weights");
        assert_eq!(
            link_or_copy(&source, &dest, no_links).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"weights");
    }

    #[tokio::test]
    async fn concurrent_runs_do_not_collide_or_change_parent_cwd() {
        let original_cwd = std::env::current_dir().unwrap();
        let source = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(source.path(), b"input").unwrap();
        let a = InferenceFiles::new().unwrap();
        let b = InferenceFiles::new().unwrap();
        let (x, y) = tokio::join!(
            a.input(source.path(), "input.wav"),
            b.input(source.path(), "input.wav")
        );
        assert_eq!(x.unwrap(), y.unwrap());
        assert_ne!(a.cwd(), b.cwd());
        assert_eq!(std::env::current_dir().unwrap(), original_cwd);
    }

    #[tokio::test]
    async fn missing_input_names_original_path_and_alias_cannot_escape() {
        let files = InferenceFiles::new().unwrap();
        let missing = files.cwd().join("不存在.wav");
        assert!(files
            .input(&missing, "input.wav")
            .await
            .unwrap_err()
            .to_string()
            .contains("不存在.wav"));
        for name in ["../escape", "a,b.png", "中文.png", "", "..", "C:\\x"] {
            assert_eq!(
                files.input(&missing, name).await.unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn relative_executable_resolves_before_changing_child_cwd() {
        let relative = Path::new("runtime/engine.exe");
        assert_eq!(
            program_path(relative).unwrap(),
            std::path::absolute(relative).unwrap()
        );
        assert_eq!(
            program_path(Path::new("nonexistent-engine-on-path")).unwrap(),
            Path::new("nonexistent-engine-on-path")
        );
    }

    #[tokio::test]
    async fn unicode_speech_weights_are_aliased_only_for_legacy_windows_engines() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("模型.bin");
        std::fs::write(&source, b"weights").unwrap();
        let files = InferenceFiles::new().unwrap();
        let path = files.speech_model(&source, "model.bin").await.unwrap();
        if cfg!(windows) {
            assert_eq!(path, Path::new("model.bin"));
            assert_eq!(std::fs::read(files.cwd().join(path)).unwrap(), b"weights");
        } else {
            assert_eq!(path, source);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relative_symlink_input_still_refers_to_original_content() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("target.png"), b"image").unwrap();
        let source = root.path().join("source.png");
        std::os::unix::fs::symlink("target.png", &source).unwrap();
        let files = InferenceFiles::new().unwrap();
        let alias = files.input(&source, "frame.png").await.unwrap();
        assert_eq!(std::fs::read(files.cwd().join(alias)).unwrap(), b"image");
    }
}
