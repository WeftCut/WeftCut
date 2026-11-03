//! Ends our ffmpeg / ffprobe children whatever ends the app.
//!
//! The owner in [`super::child`] stops a child it lets go of: stdin EOF,
//! SIGTERM, a grace, then a kill from a background thread. That last step
//! dies with the app. An app that exits (or is killed) with a child in flight
//! leaves the child running, and one wedged in a hardware session ignores the
//! SIGTERM it got — on the macOS CI VM it then held the test runner's pipes
//! until the run timed out.
//!
//! So every child is also handed, at spawn, to something that outlives the
//! app and acts on its death:
//!
//! - macOS / Linux: the reaper process (`weftcut-reaper`, beside this addon;
//!   see `reaper/src/lib.rs`). The kernel closes its input when the app exits,
//!   however it exits, and it then runs the same stop for every child not yet
//!   reaped.
//! - Windows: a job object that kills its processes when its last handle
//!   closes, which is the app's exit. Windows has no SIGTERM, so this is the
//!   kill the owner would have used.
//!
//! A child is taken back when its owner lets go of the reaped process
//! ([`Adopted`]'s drop).

#[cfg(all(test, unix))]
pub(super) use unix::held;
#[cfg(unix)]
pub(super) use unix::{adopt, Adopted};
#[cfg(windows)]
pub(super) use windows_job::{adopt, Adopted};

#[cfg(unix)]
mod unix {
    use std::collections::HashMap;
    use std::ffi::{CStr, OsStr};
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

    use tracing::warn;
    use weftcut_reaper::{adopt_line, release_line, start_time, BINARY};

    /// A child the reaper holds. Dropping it takes the child back; drop it
    /// only once the child is reaped (or its owner is gone with it).
    pub(in crate::ffmpeg) struct Adopted {
        pid: u32,
    }

    impl Drop for Adopted {
        fn drop(&mut self) {
            let mut reaper = lock();
            reaper.children.remove(&self.pid);
            reaper.send(&release_line(self.pid));
        }
    }

    /// Hand a running, unreaped child to the reaper. `None` if it has already
    /// exited.
    pub(in crate::ffmpeg) fn adopt(pid: u32) -> Option<Adopted> {
        let start = start_time(pid)?;
        let mut reaper = lock();
        reaper.children.insert(pid, start);
        reaper.send(&adopt_line(pid, start));
        Some(Adopted { pid })
    }

    static REAPER: LazyLock<Mutex<Reaper>> = LazyLock::new(|| {
        Mutex::new(Reaper {
            process: None,
            binary: None,
            children: HashMap::new(),
        })
    });

    fn lock() -> MutexGuard<'static, Reaper> {
        REAPER.lock().unwrap_or_else(PoisonError::into_inner)
    }

    struct Reaper {
        /// The running reaper and its input, started with the first child.
        process: Option<(Child, ChildStdin)>,
        /// Resolved once: `Some(None)` when there is no reaper to start.
        binary: Option<Option<PathBuf>>,
        /// What the reaper holds: each child's pid and start time. Kept here
        /// too, so a reaper that died can be replaced with all of it.
        children: HashMap<u32, u64>,
    }

    impl Reaper {
        /// Tell the reaper; `children` already reflects `line`. A reaper that
        /// is gone (it never runs out of input on its own) is replaced.
        fn send(&mut self, line: &str) {
            if let Some((_, input)) = &mut self.process {
                if input.write_all(line.as_bytes()).is_ok() {
                    return;
                }
                warn!("the ffmpeg reaper exited; starting another");
                if let Some((mut process, _)) = self.process.take() {
                    let _ = process.kill();
                    let _ = process.wait();
                }
            }
            self.start();
        }

        /// Start a reaper holding every current child.
        fn start(&mut self) {
            let Some(binary) = self.binary.get_or_insert_with(locate).clone() else {
                return;
            };
            // Nothing of the app's stdio: the reaper must not hold a parent's
            // pipes open after the app exits.
            let spawned = Command::new(&binary)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            let mut process = match spawned {
                Ok(process) => process,
                Err(error) => {
                    warn!(
                        "could not start the ffmpeg reaper {}: {error}; ffmpeg children will outlive an app that dies",
                        binary.display()
                    );
                    self.binary = Some(None);
                    return;
                }
            };
            let mut input = process.stdin.take().expect("stdin is piped");
            let held: String = self
                .children
                .iter()
                .map(|(&pid, &start)| adopt_line(pid, start))
                .collect();
            if input.write_all(held.as_bytes()).is_ok() {
                self.process = Some((process, input));
            } else {
                warn!("the ffmpeg reaper exited at start");
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }

    /// The reaper beside this addon (the `.node`, or a test binary).
    fn locate() -> Option<PathBuf> {
        let path = this_image()?.parent()?.join(BINARY);
        if path.is_file() {
            return Some(path);
        }
        warn!(
            "no ffmpeg reaper at {}; ffmpeg children will outlive an app that dies",
            path.display()
        );
        None
    }

    /// The file this code was loaded from.
    fn this_image() -> Option<PathBuf> {
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        let here = this_image as fn() -> Option<PathBuf> as *const libc::c_void;
        // SAFETY: dladdr fills `info` for an address inside a loaded image;
        // `here` is one of ours.
        if unsafe { libc::dladdr(here, &mut info) } == 0 || info.dli_fname.is_null() {
            return None;
        }
        // SAFETY: a non-null dli_fname is a NUL-terminated path owned by the
        // loader for the life of the image.
        let name = unsafe { CStr::from_ptr(info.dli_fname) };
        Some(PathBuf::from(OsStr::from_bytes(name.to_bytes())))
    }

    #[cfg(test)]
    pub(in crate::ffmpeg) fn held(pid: u32) -> Option<u64> {
        lock().children.get(&pid).copied()
    }
}

#[cfg(windows)]
mod windows_job {
    use std::sync::OnceLock;

    use tracing::warn;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A child in the job. Nothing to undo: an exited process leaves the job
    /// by itself.
    pub(in crate::ffmpeg) struct Adopted;

    /// Put a running child in the app's kill-on-close job. `process` is its
    /// process handle.
    pub(in crate::ffmpeg) fn adopt(process: usize) -> Option<Adopted> {
        let job = job()?;
        // SAFETY: both handles are open: the job for the app's life, the
        // process because its owner has not reaped it.
        let assigned =
            unsafe { AssignProcessToJobObject(job, HANDLE(process as *mut std::ffi::c_void)) };
        match assigned {
            Ok(()) => Some(Adopted),
            Err(error) => {
                warn!("could not put an ffmpeg child in the app's job: {error}; it will outlive an app that dies");
                None
            }
        }
    }

    /// The job, created once and never closed: the app's exit closes it, and
    /// that is what kills what is left in it. Not inheritable, so no child
    /// keeps it open.
    fn job() -> Option<HANDLE> {
        static JOB: OnceLock<Option<usize>> = OnceLock::new();
        let job = (*JOB.get_or_init(|| {
            // SAFETY: plain Win32 calls; the limits struct outlives the call
            // that reads it.
            unsafe {
                let job = match CreateJobObjectW(None, PCWSTR::null()) {
                    Ok(job) => job,
                    Err(error) => {
                        warn!("could not create the ffmpeg job: {error}; ffmpeg children will outlive an app that dies");
                        return None;
                    }
                };
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if let Err(error) = set {
                    warn!("could not make the ffmpeg job kill on close: {error}; ffmpeg children will outlive an app that dies");
                    let _ = CloseHandle(job);
                    return None;
                }
                Some(job.0 as usize)
            }
        }))?;
        Some(HANDLE(job as *mut std::ffi::c_void))
    }
}
