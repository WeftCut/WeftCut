//! Console-window suppression for child-process spawns on Windows.
//!
//! A GUI-subsystem process — Electron, and the napi addon hosted inside it —
//! owns no console, so every ffmpeg/ffprobe spawn makes Windows allocate a
//! fresh conhost window that flashes on screen. `CREATE_NO_WINDOW` suppresses
//! the window in both dev and packaged builds, and is a no-op on macOS/Linux
//! where child processes have no window concept at all.
//!
//! LANDMINE: EVERY non-test ffmpeg/ffprobe spawn MUST call `.no_console_window()`.
//! A bare `Command::new(..)` re-introduces the popup. The codebase spawns through
//! both `std::process::Command` (sync probes) and `tokio::process::Command`
//! (async jobs/export), so the trait is implemented for both.

/// Suppress the Windows console window for a child-process spawn. Chainable on a
/// builder (`Command::new(..).no_console_window().args(..)`) or callable as a
/// statement on a `let mut cmd`. No-op off Windows.
pub(crate) trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

/// `CREATE_NO_WINDOW` — hides the child's console window while leaving its stdio
/// handles intact. (`DETACHED_PROCESS` would also hide it but severs stdio; we
/// depend on piped stdout/stderr to read ffprobe JSON and ffmpeg progress.)
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(windows)]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        // tokio re-exposes `creation_flags` as an inherent Windows-only method.
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

/// `Child::wait_with_output`, also handing each stderr line to `on_line` as it
/// arrives. A local model engine says on stderr when it has finished loading
/// and how far inference is, long before it exits; this is how a job reads
/// that without changing what the caller gets back. The child is owned, so
/// dropping the future drops it (and `kill_on_drop` reaps it) exactly as with
/// `wait_with_output`.
#[cfg(feature = "speech")]
pub(crate) async fn output_watching_stderr(
    mut child: tokio::process::Child,
    mut on_line: impl FnMut(&str) + Send,
) -> std::io::Result<std::process::Output> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Both pipes are drained concurrently, as `wait_with_output` does: a child
    // blocked on a full stdout pipe would otherwise never close stderr.
    let read_stdout = async {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout {
            out.read_to_end(&mut buf).await?;
        }
        Ok::<_, std::io::Error>(buf)
    };
    let read_stderr = async {
        let mut buf = Vec::new();
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err);
            loop {
                let start = buf.len();
                if reader.read_until(b'\n', &mut buf).await? == 0 {
                    break;
                }
                on_line(String::from_utf8_lossy(&buf[start..]).trim_end());
            }
        }
        Ok::<_, std::io::Error>(buf)
    };
    let (stdout, stderr) = tokio::try_join!(read_stdout, read_stderr)?;
    let status = child.wait().await?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(all(test, unix, feature = "speech"))]
mod tests {
    use std::process::Stdio;

    #[tokio::test]
    async fn stderr_lines_are_seen_live_and_both_streams_are_kept() {
        let child = tokio::process::Command::new("sh")
            .args(["-c", "echo out; echo one >&2; printf 'two' >&2; exit 3"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = Vec::new();
        let output = super::output_watching_stderr(child, |l| lines.push(l.to_string()))
            .await
            .unwrap();
        assert_eq!(lines, ["one", "two"]);
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"one\ntwo");
        assert_eq!(output.status.code(), Some(3));
    }
}
