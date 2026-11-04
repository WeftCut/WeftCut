//! The reaper: a small process that outlives the app only to end the app's
//! ffmpeg children, however the app ended.
//!
//! The addon starts one per app process and keeps the write end of its stdin.
//! For each ffmpeg / ffprobe child it writes `+<pid> <start>`, and `-<pid>`
//! once it has reaped it. The kernel closes that pipe when the app exits —
//! normally, by a crash or by SIGKILL — so end of input is the app's death.
//! The reaper then runs the same stop the addon would ([`sweep`]): SIGTERM,
//! up to [`STOP_GRACE`], then SIGKILL.
//!
//! Without it a child outlives an app that dies with work in flight: the
//! in-process stop's kill comes from a thread that dies with the app, and a
//! child wedged in a hardware session ignores the SIGTERM it did get
//! (docs/notes/macos-runner-videotoolbox-kill-2026-10-31.md).
//!
//! Unix only. Windows puts the children in a kill-on-close job instead
//! (`crate::ffmpeg::guard` in the addon).

use std::collections::HashMap;
use std::io::BufRead;
use std::time::Duration;

/// How long a child asked to exit gets before it is killed. The addon's own
/// stop uses the same grace.
pub const STOP_GRACE: Duration = Duration::from_secs(2);

/// The executable's file name, beside the addon.
pub const BINARY: &str = "weftcut-reaper";

/// The line that hands the reaper a child.
pub fn adopt_line(pid: u32, start: u64) -> String {
    format!("+{pid} {start}\n")
}

/// The line that takes a reaped child back.
pub fn release_line(pid: u32) -> String {
    format!("-{pid}\n")
}

/// The children handed over and not taken back, each with its start time.
/// The start time is what makes a pid this child rather than whatever process
/// reused the number since.
#[derive(Debug, Default)]
pub struct Children(HashMap<u32, u64>);

impl Children {
    /// Apply one protocol line. Anything else is ignored: the reaper must
    /// keep serving whatever the addon version.
    pub fn apply(&mut self, line: &str) {
        if let Some(rest) = line.strip_prefix('+') {
            let mut fields = rest.split(' ');
            if let (Some(Ok(pid)), Some(Ok(start))) = (
                fields.next().map(str::parse),
                fields.next().map(|field| field.trim_end().parse()),
            ) {
                self.0.insert(pid, start);
            }
        } else if let Some(pid) = line.strip_prefix('-') {
            if let Ok(pid) = pid.trim_end().parse() {
                self.0.remove(&pid);
            }
        }
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Read the addon's lines until its end of the pipe closes, then stop every
/// child still handed over. Returns once they are gone.
pub fn serve(input: impl BufRead) -> Children {
    let mut children = Children::default();
    for line in input.lines() {
        match line {
            Ok(line) => children.apply(&line),
            // A read error is as final as EOF: the addon can no longer speak.
            Err(_) => break,
        }
    }
    #[cfg(unix)]
    sweep(&children, STOP_GRACE);
    children
}

/// A process as the kernel reports it: when it started, and whether it has
/// exited and waits only to be reaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    /// Microseconds since the epoch on macOS, clock ticks since boot on Linux.
    /// Only compared, never interpreted.
    pub start: u64,
    pub zombie: bool,
}

/// `pid`'s identity, or `None` if there is no such process (or this OS cannot
/// tell, in which case nothing is ever signalled).
#[cfg(target_os = "linux")]
pub fn identity(pid: u32) -> Option<Identity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // `pid (comm) state ...`: comm may hold spaces and parentheses, so the
    // fields are counted from the last ')'. State is field 3, starttime 22.
    let fields: Vec<&str> = stat
        .get(stat.rfind(')')? + 1..)?
        .split_whitespace()
        .collect();
    Some(Identity {
        start: fields.get(19)?.parse().ok()?,
        zombie: *fields.first()? == "Z",
    })
}

#[cfg(target_os = "macos")]
pub fn identity(pid: u32) -> Option<Identity> {
    /// `pbi_status` of a process that has exited but is not reaped
    /// (<sys/proc.h>).
    const SZOMB: u32 = 5;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is a proc_bsdinfo of the size passed.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    Some(Identity {
        start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
        zombie: info.pbi_status == SZOMB,
    })
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn identity(_pid: u32) -> Option<Identity> {
    None
}

/// The start time to register for a child that is not reaped yet.
#[cfg(unix)]
pub fn start_time(pid: u32) -> Option<u64> {
    identity(pid).map(|identity| identity.start)
}

/// Stop every child that is still the process it was: SIGTERM, up to `grace`
/// for them to exit, then SIGKILL the rest.
#[cfg(unix)]
pub fn sweep(children: &Children, grace: Duration) {
    use std::time::Instant;
    let running = |&(pid, start): &(u32, u64)| {
        identity(pid).is_some_and(|now| now.start == start && !now.zombie)
    };
    let signal = |pid: u32, signal: libc::c_int| {
        // SAFETY: a plain syscall. `running` has just matched the start time,
        // so the pid is the child, not a reuse.
        unsafe {
            libc::kill(pid as libc::pid_t, signal);
        }
    };
    let mut left: Vec<(u32, u64)> = children
        .0
        .iter()
        .map(|(&pid, &start)| (pid, start))
        .filter(running)
        .collect();
    for &(pid, _) in &left {
        signal(pid, libc::SIGTERM);
    }
    let kill_at = Instant::now() + grace;
    while !left.is_empty() && Instant::now() < kill_at {
        std::thread::sleep(Duration::from_millis(20));
        left.retain(running);
    }
    for entry in left {
        if running(&entry) {
            signal(entry.0, libc::SIGKILL);
        }
    }
}

/// Let nothing but the addon's pipe decide when the reaper acts, and hold
/// nothing of the app's open:
///
/// - Interrupts and termination requests are ignored. The app's process group
///   gets the same Ctrl-C or SIGTERM as the app, and the reaper is what runs
///   after it. SIGKILL still ends it.
/// - Every descriptor but stdio is closed. The app's own (a test runner's
///   pipes, say) would otherwise stay open as long as the reaper runs.
#[cfg(unix)]
pub fn detach() {
    for signal in [libc::SIGINT, libc::SIGHUP, libc::SIGTERM, libc::SIGPIPE] {
        // SAFETY: installing SIG_IGN has no preconditions.
        unsafe {
            libc::signal(signal, libc::SIG_IGN);
        }
    }
    let listing = if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    };
    let open: Vec<libc::c_int> = std::fs::read_dir(listing)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    // The listing's own descriptor is closed by now; closing its number again
    // fails harmlessly.
    for fd in open.into_iter().filter(|&fd| fd > 2) {
        // SAFETY: nothing in this process uses these descriptors.
        unsafe {
            libc::close(fd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_adopt_and_release() {
        let mut children = Children::default();
        children.apply(adopt_line(10, 77).trim_end());
        children.apply(adopt_line(11, 78).trim_end());
        children.apply(release_line(10).trim_end());
        assert_eq!(children.0.get(&11), Some(&78));
        assert!(!children.0.contains_key(&10));
        // Unknown and malformed lines leave the set alone.
        for line in ["", "+", "+12", "+x 1", "-y", "?13 4"] {
            children.apply(line);
        }
        assert_eq!(children.len(), 1);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_live_process_has_a_stable_identity() {
        let me = std::process::id();
        let first = identity(me).expect("this process");
        assert!(!first.zombie);
        assert_eq!(identity(me), Some(first));
    }
}
