//! The only spawn path for ffmpeg / ffprobe children, and the one place that
//! decides how they end: [`FfmpegCommand`] builds, [`FfmpegChild`] (tokio) and
//! [`SyncFfmpegChild`] (`std::process`, for the export video sink and the sync
//! probes) own the running process. Both end it through the same stop sequence;
//! see [`STOP_GRACE`].

use std::ffi::OsStr;
use std::io::{self, Read};
use std::process::{ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

use tracing::warn;

use crate::process::NoConsoleWindow;

/// How long a child asked to exit gets before it is killed.
///
/// LANDMINE: a child may hold a hardware encode/decode session (which one is a
/// run-time fact: hwaccel fallback, encoder registry), and a SIGKILLed
/// VideoToolbox session hangs the next one on the macOS CI VM. So on Unix a
/// stop is always stdin EOF, then SIGTERM, then this grace, and only then a
/// kill (Windows: see `StopPolicy::stdin_is_input`). See
/// docs/notes/macos-runner-videotoolbox-kill-2026-10-31.md.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// What limits a child's run, declared at spawn.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Bound {
    /// Past this wall clock the child is stopped and its wait fails with
    /// `io::ErrorKind::TimedOut`.
    Timeout(Duration),
    /// No limit. Only for children that have neither a timeout nor a progress
    /// watchdog yet; it disappears once they all do, so add no new uses.
    TemporarilyUnbounded,
}

#[derive(Debug, Clone, Copy)]
struct StopPolicy {
    grace: Duration,
    /// Windows has no SIGTERM: a child reading its media from stdin is asked
    /// to exit by EOF and gets the grace; any other is terminated at once.
    stdin_is_input: bool,
}

/// Builder for an ffmpeg / ffprobe child. Console-window suppression is
/// applied here, so call sites never need it.
pub(crate) struct FfmpegCommand {
    command: tokio::process::Command,
    bound: Bound,
    policy: StopPolicy,
    /// Which of stdin, stdout, stderr the caller set, so `output` can default
    /// the rest the way `std::process::Command::output` does.
    stdio_set: [bool; 3],
}

impl FfmpegCommand {
    pub(crate) fn ffmpeg(bound: Bound) -> Self {
        Self::new(super::ffmpeg_path(), bound)
    }

    pub(crate) fn ffprobe(bound: Bound) -> Self {
        Self::new(super::ffprobe_path(), bound)
    }

    /// Any program under the owner's lifecycle, so tests can stand in for
    /// ffmpeg with a script.
    #[cfg(test)]
    pub(crate) fn program(program: impl AsRef<OsStr>, bound: Bound) -> Self {
        Self::new(program, bound)
    }

    fn new(program: impl AsRef<OsStr>, bound: Bound) -> Self {
        let mut command = tokio::process::Command::new(program);
        command.no_console_window();
        Self {
            command,
            bound,
            policy: StopPolicy {
                grace: STOP_GRACE,
                stdin_is_input: false,
            },
            stdio_set: [false; 3],
        }
    }

    pub(crate) fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self {
        self.command.arg(arg);
        self
    }

    pub(crate) fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.command.args(args);
        self
    }

    pub(crate) fn stdin(&mut self, cfg: Stdio) -> &mut Self {
        self.command.stdin(cfg);
        self.stdio_set[0] = true;
        self
    }

    pub(crate) fn stdout(&mut self, cfg: Stdio) -> &mut Self {
        self.command.stdout(cfg);
        self.stdio_set[1] = true;
        self
    }

    pub(crate) fn stderr(&mut self, cfg: Stdio) -> &mut Self {
        self.command.stderr(cfg);
        self.stdio_set[2] = true;
        self
    }

    /// Pipe stdin as the media ffmpeg reads (`-i -`).
    pub(crate) fn media_on_stdin(&mut self) -> &mut Self {
        self.policy.stdin_is_input = true;
        self.stdin(Stdio::piped())
    }

    /// `std::process::Command::output`'s defaults for any stdio left unset:
    /// no stdin, both outputs captured.
    fn default_stdio_for_output(&mut self) {
        let [stdin, stdout, stderr] = self.stdio_set;
        if !stdin {
            self.command.stdin(Stdio::null());
        }
        if !stdout {
            self.command.stdout(Stdio::piped());
        }
        if !stderr {
            self.command.stderr(Stdio::piped());
        }
    }

    #[cfg(test)]
    pub(crate) fn grace(&mut self, grace: Duration) -> &mut Self {
        self.policy.grace = grace;
        self
    }

    fn deadline(&self) -> Option<Instant> {
        match self.bound {
            Bound::Timeout(limit) => Some(Instant::now() + limit),
            Bound::TemporarilyUnbounded => None,
        }
    }

    /// Spawn on the tokio runtime.
    pub(crate) fn spawn(&mut self) -> io::Result<FfmpegChild> {
        let child = self.command.spawn()?;
        Ok(FfmpegChild {
            child: Some(child),
            stop: Stop::new(self.policy),
            bound: self.bound,
            deadline: self.deadline(),
        })
    }

    /// Spawn and collect the exit status and both pipes, like
    /// `Command::output`.
    pub(crate) async fn output(&mut self) -> io::Result<Output> {
        self.default_stdio_for_output();
        self.spawn()?.output().await
    }

    /// Spawn as a `std::process` child, for callers that block.
    pub(crate) fn spawn_sync(&mut self) -> io::Result<SyncFfmpegChild> {
        let child = self.command.as_std_mut().spawn()?;
        Ok(SyncFfmpegChild {
            child: Some(child),
            stop: Stop::new(self.policy),
            bound: self.bound,
            deadline: self.deadline(),
        })
    }

    /// Blocking [`Self::output`].
    pub(crate) fn output_sync(&mut self) -> io::Result<Output> {
        self.default_stdio_for_output();
        self.spawn_sync()?.output()
    }
}

/// A running ffmpeg / ffprobe child on the tokio runtime. Dropping it while the
/// child runs stops the child off the dropping thread (see the `Drop` impl), so
/// dropping a future that holds one is a cancel.
pub(crate) struct FfmpegChild {
    /// `Some` until `Drop` hands a still-running child to the stop thread.
    child: Option<tokio::process::Child>,
    stop: Stop,
    bound: Bound,
    deadline: Option<Instant>,
}

impl FfmpegChild {
    fn child(&mut self) -> &mut tokio::process::Child {
        self.child.as_mut().expect("child is owned until drop")
    }

    pub(crate) fn take_stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child().stdin.take()
    }

    pub(crate) fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child().stdout.take()
    }

    pub(crate) fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child().stderr.take()
    }

    /// Wait for the child to exit. Past a [`Bound::Timeout`] the child is
    /// stopped and this fails with `io::ErrorKind::TimedOut`.
    pub(crate) async fn wait(&mut self) -> io::Result<ExitStatus> {
        let Some(deadline) = self.deadline else {
            return self.child().wait().await;
        };
        let deadline = tokio::time::Instant::from_std(deadline);
        if let Ok(status) = tokio::time::timeout_at(deadline, self.child().wait()).await {
            return status;
        }
        self.stop().await?;
        Err(timed_out(self.bound))
    }

    /// Close stdin, then wait for the exit status while draining stdout and
    /// stderr concurrently (a child blocked on a full pipe never exits), like
    /// `Child::wait_with_output`.
    pub(crate) async fn output(mut self) -> io::Result<Output> {
        drop(self.take_stdin());
        let stdout = self.take_stdout();
        let stderr = self.take_stderr();
        let (status, stdout, stderr) =
            tokio::join!(self.wait(), read_pipe(stdout), read_pipe(stderr));
        Ok(Output {
            status: status?,
            stdout: stdout?,
            stderr: stderr?,
        })
    }

    /// End the child: stdin EOF and SIGTERM, up to the grace to exit, then a
    /// kill. Returns once the child is reaped; on an exited child it returns
    /// the status at once.
    pub(crate) async fn stop(&mut self) -> io::Result<ExitStatus> {
        let child = self.child.as_mut().expect("child is owned until drop");
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        let kill_at = tokio::time::Instant::from_std(self.stop.request(child));
        if let Ok(status) = tokio::time::timeout_at(kill_at, child.wait()).await {
            return status;
        }
        let _ = child.start_kill();
        child.wait().await
    }
}

impl Drop for FfmpegChild {
    /// LANDMINE: a dropped owner must end its child. An orphaned ffmpeg keeps
    /// writing its deterministic `<dest>.tmp`, and the next build of the same
    /// derivative interleaves with it and dies at promote.
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let kill_at = self.stop.request(&mut child);
        finish_in_background(child, kill_at);
    }
}

/// A running ffmpeg child owned through `std::process`, for code that blocks
/// (the export video sink's writer threads, the sync probes). Same lifecycle as
/// [`FfmpegChild`]: dropping it while the child runs stops the child on a
/// background thread.
pub(crate) struct SyncFfmpegChild {
    /// `Some` until `Drop` hands a still-running child to the stop thread.
    child: Option<std::process::Child>,
    stop: Stop,
    bound: Bound,
    deadline: Option<Instant>,
}

impl SyncFfmpegChild {
    fn child(&mut self) -> &mut std::process::Child {
        self.child.as_mut().expect("child is owned until drop")
    }

    pub(crate) fn take_stdin(&mut self) -> Option<std::process::ChildStdin> {
        self.child().stdin.take()
    }

    pub(crate) fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child().stderr.take()
    }

    /// `Child::try_wait`. Past a [`Bound::Timeout`] the child is stopped
    /// (blocking for up to the grace) and this fails with
    /// `io::ErrorKind::TimedOut`.
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = self.child().try_wait()? {
            return Ok(Some(status));
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.stop()?;
            return Err(timed_out(self.bound));
        }
        Ok(None)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        let deadline = self.deadline;
        let child = self.child();
        if deadline.is_none() {
            return child.wait();
        }
        if let Some(status) = poll_exit(child, deadline)? {
            return Ok(status);
        }
        self.stop()?;
        Err(timed_out(self.bound))
    }

    /// Blocking [`FfmpegChild::output`].
    pub(crate) fn output(mut self) -> io::Result<Output> {
        drop(self.take_stdin());
        let stdout = self.child().stdout.take();
        let stderr = self.child().stderr.take();
        std::thread::scope(|scope| {
            let stdout = stdout.map(|pipe| scope.spawn(move || read_pipe_sync(pipe)));
            let stderr = stderr.map(|pipe| scope.spawn(move || read_pipe_sync(pipe)));
            let status = self.wait();
            let join = |reader: Option<std::thread::ScopedJoinHandle<io::Result<Vec<u8>>>>| {
                reader.map_or(Ok(Vec::new()), |reader| {
                    reader
                        .join()
                        .unwrap_or_else(|_| Err(io::Error::other("pipe reader panicked")))
                })
            };
            let (stdout, stderr) = (join(stdout), join(stderr));
            Ok(Output {
                status: status?,
                stdout: stdout?,
                stderr: stderr?,
            })
        })
    }

    /// Blocking [`FfmpegChild::stop`]: blocks for up to the grace plus the
    /// reap.
    pub(crate) fn stop(&mut self) -> io::Result<ExitStatus> {
        let child = self.child.as_mut().expect("child is owned until drop");
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        let kill_at = self.stop.request(child);
        finish_blocking(child, kill_at)
    }
}

impl Drop for SyncFfmpegChild {
    /// See the landmine on `FfmpegChild`'s `Drop`.
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let kill_at = self.stop.request(&mut child);
        finish_in_background(child, kill_at);
    }
}

fn timed_out(bound: Bound) -> io::Error {
    let limit = match bound {
        Bound::Timeout(limit) => limit,
        Bound::TemporarilyUnbounded => Duration::ZERO,
    };
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("ffmpeg ran past its {}s limit", limit.as_secs()),
    )
}

async fn read_pipe(pipe: Option<impl tokio::io::AsyncRead + Unpin>) -> io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut bytes).await?;
    }
    Ok(bytes)
}

fn read_pipe_sync(mut pipe: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// What the stop sequence needs from a process handle, so the tokio owner, the
/// `std` owner and the background stop thread all run [`Stop`].
trait Process {
    fn close_stdin(&mut self);
    /// `None` once the child is reaped.
    #[cfg(unix)]
    fn pid(&self) -> Option<u32>;
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>;
    fn kill(&mut self) -> io::Result<()>;
}

impl Process for tokio::process::Child {
    fn close_stdin(&mut self) {
        drop(self.stdin.take());
    }
    #[cfg(unix)]
    fn pid(&self) -> Option<u32> {
        self.id()
    }
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        tokio::process::Child::try_wait(self)
    }
    fn kill(&mut self) -> io::Result<()> {
        self.start_kill()
    }
}

impl Process for std::process::Child {
    fn close_stdin(&mut self) {
        drop(self.stdin.take());
    }
    #[cfg(unix)]
    fn pid(&self) -> Option<u32> {
        Some(self.id())
    }
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        std::process::Child::try_wait(self)
    }
    fn kill(&mut self) -> io::Result<()> {
        std::process::Child::kill(self)
    }
}

/// The stop sequence: close stdin, SIGTERM (Unix), wait up to the grace, kill,
/// reap. `request` runs the first two steps; the owners and
/// [`finish_blocking`] wait out the rest.
struct Stop {
    policy: StopPolicy,
    /// Set by the first `request`, so a stop that is itself cancelled (its
    /// owner dropped mid-grace) keeps its original kill time.
    kill_at: Option<Instant>,
}

impl Stop {
    fn new(policy: StopPolicy) -> Self {
        Self {
            policy,
            kill_at: None,
        }
    }

    /// Ask a running, unreaped child to exit, without blocking. Returns the
    /// instant after which it is killed.
    fn request(&mut self, process: &mut impl Process) -> Instant {
        if let Some(kill_at) = self.kill_at {
            return kill_at;
        }
        process.close_stdin();
        let grace = self.ask_to_exit(process);
        *self.kill_at.insert(Instant::now() + grace)
    }

    #[cfg(unix)]
    fn ask_to_exit(&self, process: &mut impl Process) -> Duration {
        if let Some(pid) = process.pid() {
            // SAFETY: a plain syscall. The child is not reaped yet (its pid is
            // still ours), so the signal cannot reach a reused pid.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        self.policy.grace
    }

    #[cfg(not(unix))]
    fn ask_to_exit(&self, process: &mut impl Process) -> Duration {
        if self.policy.stdin_is_input {
            return self.policy.grace;
        }
        let _ = process.kill();
        Duration::ZERO
    }
}

/// The waiting half of [`Stop`] for a caller that may block: up to `kill_at`
/// for the child to exit, then a kill, then the reap.
fn finish_blocking(process: &mut impl Process, kill_at: Instant) -> io::Result<ExitStatus> {
    if let Some(status) = poll_exit(process, Some(kill_at))? {
        return Ok(status);
    }
    let _ = process.kill();
    poll_exit(process, None).map(|status| status.expect("polled without a deadline"))
}

/// Poll `try_wait` with a short backoff, until exit or `deadline`. This works
/// for a tokio child on a thread outside the runtime, which cannot `.await`.
fn poll_exit(
    process: &mut impl Process,
    deadline: Option<Instant>,
) -> io::Result<Option<ExitStatus>> {
    let mut nap = Duration::from_millis(1);
    loop {
        if let Some(status) = process.try_wait()? {
            return Ok(Some(status));
        }
        let now = Instant::now();
        if deadline.is_some_and(|deadline| now >= deadline) {
            return Ok(None);
        }
        let remaining = deadline.map_or(nap, |deadline| deadline - now);
        std::thread::sleep(nap.min(remaining));
        nap = (nap * 2).min(Duration::from_millis(20));
    }
}

/// Finish a stop on a thread of its own: the dropping thread may be a runtime
/// worker, and may not be inside a runtime at all.
fn finish_in_background(mut process: impl Process + Send + 'static, kill_at: Instant) {
    let spawned = std::thread::Builder::new()
        .name("ffmpeg-stop".into())
        .spawn(move || {
            if let Err(error) = finish_blocking(&mut process, kill_at) {
                warn!("could not reap a stopped ffmpeg child: {error}");
            }
        });
    if let Err(error) = spawned {
        warn!("could not start the ffmpeg stop thread: {error}");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::ExitStatusExt;

    use tokio::io::AsyncBufReadExt;

    use super::*;

    /// `sh -c script` under the owner. The script prints `ready` once its traps
    /// are set, so a test never signals it before it can ignore the signal.
    fn sh(script: &str, grace: Duration) -> FfmpegCommand {
        let mut command = FfmpegCommand::program("sh", Bound::TemporarilyUnbounded);
        command
            .args(["-c", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .grace(grace);
        command
    }

    async fn spawn_ready(command: &mut FfmpegCommand) -> FfmpegChild {
        let mut child = command.spawn().unwrap();
        let mut stdout = tokio::io::BufReader::new(child.take_stdout().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim(), "ready");
        child
    }

    fn reaped(pid: u32) -> bool {
        // A zombie still answers signal 0; only a reaped pid is gone.
        unsafe { libc::kill(pid as libc::pid_t, 0) == -1 }
    }

    #[tokio::test]
    async fn a_child_that_exits_on_sigterm_stops_well_within_the_grace() {
        let mut child = spawn_ready(&mut sh(
            "echo ready; exec sleep 30",
            Duration::from_secs(10),
        ))
        .await;
        let started = Instant::now();
        let status = child.stop().await.unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(status.signal(), Some(libc::SIGTERM));
    }

    #[tokio::test]
    async fn a_child_that_ignores_sigterm_is_killed_after_the_grace() {
        let grace = Duration::from_millis(300);
        let mut child =
            spawn_ready(&mut sh("trap '' TERM; echo ready; exec sleep 30", grace)).await;
        let started = Instant::now();
        let status = child.stop().await.unwrap();
        assert!(started.elapsed() >= grace, "{:?}", started.elapsed());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    #[tokio::test]
    async fn stdin_eof_reaches_a_child_that_reads_its_input_from_stdin() {
        // TERM is ignored, so only EOF on stdin can end it before the grace.
        let mut command = sh(
            "trap '' TERM; echo ready; cat >/dev/null; exit 3",
            Duration::from_secs(10),
        );
        command.media_on_stdin();
        let mut child = spawn_ready(&mut command).await;
        let started = Instant::now();
        let status = child.stop().await.unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(status.code(), Some(3));
    }

    #[tokio::test]
    async fn dropping_a_running_owner_reaps_the_child_without_blocking() {
        let mut child = spawn_ready(&mut sh(
            "trap '' TERM; echo ready; exec sleep 30",
            Duration::from_millis(300),
        ))
        .await;
        let pid = child.child().id().unwrap();
        let started = Instant::now();
        drop(child);
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "{:?}",
            started.elapsed()
        );
        let until = Instant::now() + Duration::from_secs(5);
        while !reaped(pid) {
            assert!(Instant::now() < until, "child {pid} was never reaped");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn the_sync_owner_runs_the_same_stop_and_drop() {
        let ready = |child: &mut SyncFfmpegChild| {
            let mut line = String::new();
            BufReader::new(child.child().stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            assert_eq!(line.trim(), "ready");
        };
        let grace = Duration::from_millis(300);
        let script = "trap '' TERM; echo ready; exec sleep 30";

        let mut child = sh(script, grace).spawn_sync().unwrap();
        ready(&mut child);
        let started = Instant::now();
        assert_eq!(child.stop().unwrap().signal(), Some(libc::SIGKILL));
        assert!(started.elapsed() >= grace, "{:?}", started.elapsed());

        let mut child = sh(script, grace).spawn_sync().unwrap();
        ready(&mut child);
        let pid = child.child().id();
        let started = Instant::now();
        drop(child);
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "{:?}",
            started.elapsed()
        );
        let until = Instant::now() + Duration::from_secs(5);
        while !reaped(pid) {
            assert!(Instant::now() < until, "child {pid} was never reaped");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[tokio::test]
    async fn a_timeout_stops_the_child_and_fails_the_wait() {
        let mut command = FfmpegCommand::program("sh", Bound::Timeout(Duration::from_millis(200)));
        command
            .args(["-c", "exec sleep 30"])
            .grace(Duration::from_secs(10));
        let started = Instant::now();
        let error = command.output().await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );

        let mut command = FfmpegCommand::program("sh", Bound::Timeout(Duration::from_millis(200)));
        command
            .args(["-c", "exec sleep 30"])
            .stdout(Stdio::piped())
            .grace(Duration::from_secs(10));
        let error = command.output_sync().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn output_collects_status_and_both_pipes() {
        let mut command = FfmpegCommand::program("sh", Bound::TemporarilyUnbounded);
        command
            .args(["-c", "echo out; echo err >&2; exit 4"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = command.output().await.unwrap();
        assert_eq!(output.status.code(), Some(4));
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"err\n");
        let output = command.output_sync().unwrap();
        assert_eq!(output.status.code(), Some(4));
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"err\n");
    }
}
