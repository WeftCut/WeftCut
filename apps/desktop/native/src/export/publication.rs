//! Only completed files cross the publication boundary. Both paths stay on one
//! filesystem; unsupported no-replace operations fail without a copy fallback.
use anyhow::{Context, Result};
use std::{
    io,
    path::{Path, PathBuf},
};

#[cfg(windows)]
fn rename_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS},
    };
    let s: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let t: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { MoveFileExW(PCWSTR(s.as_ptr()), PCWSTR(t.as_ptr()), MOVE_FILE_FLAGS(0)) }
        .map_err(|_| io::Error::last_os_error())
}

#[cfg(unix)]
fn rename_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let s = CString::new(source.as_os_str().as_bytes())?;
    let t = CString::new(target.as_os_str().as_bytes())?;
    // The raw syscall, not glibc's renameat2 wrapper: that wrapper only exists
    // from glibc 2.28, and the Linux addon is linked against an older sysroot
    // so it loads on older distros.
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            s.as_ptr(),
            libc::AT_FDCWD,
            t.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(s.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn publish_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(()), // staging cleanup is separate from the commit point
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(_) => rename_noreplace(source, target),
    }
}

/// Probe success AND collision behavior in the actual destination directory.
/// The same operation is used at publication, including its rename fallback.
pub fn prepare(output: &Path) -> Result<String> {
    let parent = output.parent().context("output has no directory")?;
    {
        let source = tempfile::Builder::new()
            .prefix(".weftcut-probe-")
            .tempfile_in(parent)?;
        let source = source.into_temp_path();
        std::fs::write(&source, b"completed")?;
        let target = tempfile::Builder::new()
            .prefix(".weftcut-probe-")
            .tempfile_in(parent)?
            .into_temp_path();
        std::fs::write(&target, b"existing")?;
        let operation = publish_noreplace;
        if operation(&source, &target).is_ok() || std::fs::read(&target)? != b"existing" {
            anyhow::bail!("destination cannot safely publish without overwriting");
        }
        std::fs::remove_file(&target)?;
        operation(&source, &target).context("destination lacks atomic no-overwrite publication")?;
        if std::fs::read(&target)? != b"completed" {
            anyhow::bail!("publication probe failed");
        }
    }
    let extension = output
        .extension()
        .and_then(|v| v.to_str())
        .context("output needs an extension")?;
    let staged = tempfile::Builder::new()
        .prefix(".weftcut-export-")
        .suffix(&format!(".{extension}"))
        .tempfile_in(parent)?
        .into_temp_path();
    let path = staged.keep().context("retain export staging")?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublishArgs {
    pub staging: PathBuf,
    pub output: PathBuf,
    pub policy: String,
}

/// A staged export may carry macOS UF_HIDDEN. Hard-linking or renaming the
/// staging file preserves its flags, even under a user-visible final filename.
/// Clear only UF_HIDDEN before publication so Finder shows completed exports.
/// If clearing fails, do not publish a file that Finder would hide.
#[cfg(target_os = "macos")]
fn hidden_flag_error_hint(errno: Option<i32>) -> &'static str {
    match errno {
        Some(code) if code == libc::ENOTSUP || code == libc::EOPNOTSUPP => {
            "This filesystem does not support changing macOS file flags; try a local macOS-formatted volume"
        }
        Some(code) if code == libc::EPERM || code == libc::EACCES => {
            "macOS denied permission to change file flags; check output-folder ownership and permissions"
        }
        Some(libc::EROFS) => {
            "The destination volume is read-only; choose a writable output location"
        }
        _ => {
            "Check the destination volume's permissions and support for macOS file flags"
        }
    }
}

#[cfg(target_os = "macos")]
fn hidden_flag_error(path: &Path, source: io::Error) -> anyhow::Error {
    anyhow::anyhow!(
        "Cannot clear macOS UF_HIDDEN on staged export {}: {}. {}. The export was not published.",
        path.display(),
        source,
        hidden_flag_error_hint(source.raw_os_error())
    )
}

#[cfg(target_os = "macos")]
fn clear_staging_hidden_flag(path: &Path) -> Result<()> {
    use std::os::{fd::AsRawFd, macos::fs::MetadataExt};

    let file = std::fs::File::open(path).with_context(|| {
        format!(
            "open staged export {} to inspect macOS file flags",
            path.display()
        )
    })?;
    let flags = file
        .metadata()
        .with_context(|| format!("read macOS file flags of staged export {}", path.display()))?
        .st_flags();
    if flags & libc::UF_HIDDEN != 0 {
        let result = unsafe { libc::fchflags(file.as_raw_fd(), flags & !libc::UF_HIDDEN) };
        if result != 0 {
            return Err(hidden_flag_error(path, io::Error::last_os_error()));
        }
    }
    Ok(())
}

pub fn publish(args: PublishArgs) -> Result<String> {
    if args.staging.parent() != args.output.parent() {
        anyhow::bail!("publication must stay in the destination directory");
    }
    if !std::fs::metadata(&args.staging)?.is_file() || std::fs::metadata(&args.staging)?.len() == 0
    {
        anyhow::bail!("export produced no output");
    }
    #[cfg(target_os = "macos")]
    clear_staging_hidden_flag(&args.staging)
        .context("make staged export visible before publication")?;
    if args.policy == "overwrite" {
        #[cfg(unix)]
        std::fs::rename(&args.staging, &args.output)?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::{
                core::PCWSTR,
                Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING},
            };
            let s: Vec<u16> = args
                .staging
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let t: Vec<u16> = args
                .output
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            unsafe {
                MoveFileExW(
                    PCWSTR(s.as_ptr()),
                    PCWSTR(t.as_ptr()),
                    MOVEFILE_REPLACE_EXISTING,
                )
            }
            .map_err(|_| io::Error::last_os_error())?;
        }
        return Ok(args.output.to_string_lossy().into_owned());
    }
    if args.policy != "rename" && args.policy != "fail" {
        anyhow::bail!("invalid publication policy");
    }
    for number in 0..10_000 {
        let target = if number == 0 {
            args.output.clone()
        } else {
            let stem = args
                .output
                .file_stem()
                .context("output name")?
                .to_string_lossy();
            let ext = args
                .output
                .extension()
                .context("output extension")?
                .to_string_lossy();
            args.output
                .with_file_name(format!("{stem} ({number}).{ext}"))
        };
        match publish_noreplace(&args.staging, &target) {
            Ok(()) => return Ok(target.to_string_lossy().into_owned()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && args.policy == "rename" => {
                continue
            }
            Err(e) => return Err(e).context("publish completed export"),
        }
    }
    anyhow::bail!("too many output name conflicts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn hidden_flag_errors_identify_volume_and_permission_failures() {
        let path = Path::new("/Volumes/External/.weftcut-export-test.mp4");
        for (errno, expected) in [
            (libc::ENOTSUP, "does not support changing macOS file flags"),
            (libc::EPERM, "denied permission"),
            (libc::EACCES, "denied permission"),
            (libc::EROFS, "read-only"),
            (libc::EINVAL, "Check the destination volume"),
        ] {
            let source = io::Error::from_raw_os_error(errno);
            // The N-API boundary renders anyhow's full chain with {e:#}.
            let error = hidden_flag_error(path, source)
                .context("make staged export visible before publication");
            let message = format!("{error:#}");
            assert!(
                message.contains("make staged export visible before publication"),
                "{message}"
            );
            assert!(message.contains(&path.display().to_string()), "{message}");
            assert!(message.contains(expected), "{message}");
            assert!(message.contains("UF_HIDDEN"), "{message}");
            assert!(
                message.contains("The export was not published"),
                "{message}"
            );
            assert!(message.contains(&format!("os error {errno}")), "{message}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn publishing_clears_only_hidden_flag_and_preserves_existing_files() {
        use std::os::{fd::AsRawFd, macos::fs::MetadataExt};

        let dir = tempfile::tempdir().unwrap();
        // Test both hidden and visible staging files through every publishing
        // policy. UF_NODUMP is an unrelated user flag that must survive.
        for (index, (policy, hidden, collision)) in [
            ("fail", true, false),
            ("overwrite", true, true),
            ("rename", true, true),
            ("fail", false, false),
            ("overwrite", false, true),
            ("rename", false, true),
        ]
        .into_iter()
        .enumerate()
        {
            let output = dir.path().join(format!("clip-{index}.mp4"));
            if collision {
                std::fs::write(&output, b"previous output").unwrap();
            }
            let staging = PathBuf::from(prepare(&output).unwrap());
            std::fs::write(&staging, b"completed video").unwrap();
            let file = std::fs::File::open(&staging).unwrap();
            let initial_flags = file.metadata().unwrap().st_flags();
            let staged_flags = (initial_flags | libc::UF_NODUMP) & !libc::UF_HIDDEN
                | if hidden { libc::UF_HIDDEN } else { 0 };
            assert_eq!(unsafe { libc::fchflags(file.as_raw_fd(), staged_flags) }, 0);
            assert_eq!(file.metadata().unwrap().st_flags(), staged_flags);
            drop(file);

            let published = PathBuf::from(
                publish(PublishArgs {
                    staging,
                    output: output.clone(),
                    policy: policy.into(),
                })
                .unwrap(),
            );
            let expected = if policy == "rename" {
                dir.path().join(format!("clip-{index} (1).mp4"))
            } else {
                output.clone()
            };
            assert_eq!(published, expected);
            assert_eq!(std::fs::read(&published).unwrap(), b"completed video");
            assert_eq!(
                std::fs::metadata(&published).unwrap().st_flags(),
                staged_flags & !libc::UF_HIDDEN
            );
            if policy == "rename" {
                assert_eq!(std::fs::read(&output).unwrap(), b"previous output");
            }
        }
    }

    #[test]
    fn native_rename_fallback_refuses_collisions_and_moves_complete_files() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("stage");
        let target = d.path().join("complete");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(&target, b"old").unwrap();
        assert!(rename_noreplace(&source, &target).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"new");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        std::fs::remove_file(&target).unwrap();
        rename_noreplace(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }
    #[test]
    fn probe_and_publish_preserve_existing_files() {
        let d = tempfile::tempdir().unwrap();
        let output = d.path().join("clip.mp4");
        std::fs::write(&output, b"original").unwrap();
        let staging = PathBuf::from(prepare(&output).unwrap());
        std::fs::write(&staging, b"complete").unwrap();
        assert!(publish(PublishArgs {
            staging: staging.clone(),
            output: output.clone(),
            policy: "fail".into()
        })
        .is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"original");
        let actual = publish(PublishArgs {
            staging: staging.clone(),
            output: output.clone(),
            policy: "rename".into(),
        })
        .unwrap();
        assert_eq!(PathBuf::from(actual), d.path().join("clip (1).mp4"));
        assert_eq!(std::fs::read(&output).unwrap(), b"original");
        assert!(std::fs::read_dir(d.path()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".weftcut-probe-")));
    }
}
