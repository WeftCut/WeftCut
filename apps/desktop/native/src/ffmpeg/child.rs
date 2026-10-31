//! The only spawn path for ffmpeg / ffprobe children, and the one place that
//! decides how they end: [`FfmpegCommand`] builds, [`FfmpegChild`] (tokio) and
//! [`SyncFfmpegChild`] (`std::process`, for the export video sink and the sync
//! probes) own the running process. Both end it through the same stop sequence
//! (see [`STOP_GRACE`]), and both are bounded (see [`Bound`]).

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::pin::Pin;
use std::process::{ExitStatus, Output, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
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

/// How long a watched child may go without a sign of life before it is
/// stopped as stalled. Signs of life: a progress advance (`Progress`), input
/// taken or awaited (`Feed`), CPU use (`CpuUse`).
///
/// Progress alone cannot carry it: the slowest software encode the export
/// encoder registry selects (4K 10-bit libaom-av1 at `-cpu-used 4`, two
/// threads) went 78 s and more before its first frame, but never a second
/// below 7% of a core. A child wedged in a hardware session sleeps at 0%
/// (docs/notes/macos-runner-videotoolbox-kill-2026-10-31.md,
/// docs/notes/ffmpeg-stall-limit-2026-10-31.md).
pub(crate) const STALL_LIMIT: Duration = Duration::from_secs(60);

/// The CPU share, of one core, at which a quiet child counts as working.
/// Far above what a waiting ffmpeg spends printing its progress blocks.
const BUSY_SHARE: f64 = 0.01;

/// Leads the text of every stalled error. The renderer classifies a failed
/// export by it (`src/shared/ffmpeg-stall.ts`); keep the two identical.
pub(crate) const STALLED_TAG: &str = "ffmpeg-stalled";

/// What limits a child's run, declared at spawn. Every child has one.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Bound {
    /// For short commands. Past this wall clock the child is stopped and its
    /// wait fails with `io::ErrorKind::TimedOut`.
    Timeout(Duration),
    /// For transcodes, whose length follows the media: the progress watchdog.
    /// The child reports progress (`-progress`); when it shows no sign of life
    /// for this long (see [`STALL_LIMIT`]) it is stopped, and its wait fails
    /// with [`Stalled`].
    Stall(Duration),
}

impl Bound {
    /// The progress watchdog at [`STALL_LIMIT`].
    pub(crate) const fn watchdog() -> Self {
        Self::Stall(STALL_LIMIT)
    }
}

/// Why a watched child failed: its watchdog saw no sign of life for the stall
/// limit and stopped it. Carried in an `io::Error`; test with [`is_stalled`].
#[derive(Debug)]
pub(crate) struct Stalled {
    limit: Duration,
}

impl fmt::Display for Stalled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{STALLED_TAG}: ffmpeg made no progress for {} s and was stopped",
            self.limit.as_secs_f32()
        )
    }
}

impl std::error::Error for Stalled {}

/// Whether `error` is a watchdog's [`Stalled`].
pub(crate) fn is_stalled(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<Stalled>())
}

fn stalled(limit: Duration) -> io::Error {
    io::Error::other(Stalled { limit })
}

fn timed_out(limit: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("ffmpeg ran past its {}s limit", limit.as_secs()),
    )
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
    /// A watched child's `-progress` file, until its spawn claims it.
    progress: Option<PathBuf>,
}

impl FfmpegCommand {
    pub(crate) fn ffmpeg(bound: Bound) -> Self {
        Self::new(super::ffmpeg_path(), bound)
    }

    pub(crate) fn ffprobe(bound: Bound) -> Self {
        Self::new(super::ffprobe_path(), bound)
    }

    /// Any program under the owner's lifecycle, so tests can stand in for
    /// ffmpeg with a script. A watched one receives `-progress file:<path>`
    /// as its first two arguments.
    #[cfg(test)]
    pub(crate) fn program(program: impl AsRef<OsStr>, bound: Bound) -> Self {
        Self::new(program, bound)
    }

    fn new(program: impl AsRef<OsStr>, bound: Bound) -> Self {
        let mut command = tokio::process::Command::new(program);
        command.no_console_window();
        // A file rather than a pipe leaves every caller's stdout and stderr
        // as they were: some read media from stdout, some parse stderr.
        let progress = matches!(bound, Bound::Stall(_)).then(|| {
            let path = std::env::temp_dir().join(format!(
                "weftcut-ffmpeg-progress-{}.txt",
                uuid::Uuid::new_v4()
            ));
            let mut url = OsString::from("file:");
            url.push(&path);
            // A global option, so it may lead the argv.
            command.arg("-progress").arg(url);
            path
        });
        Self {
            command,
            bound,
            policy: StopPolicy {
                grace: STOP_GRACE,
                stdin_is_input: false,
            },
            stdio_set: [false; 3],
            progress,
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

    fn timeout(&self) -> Option<(Duration, Instant)> {
        match self.bound {
            Bound::Timeout(limit) => Some((limit, Instant::now() + limit)),
            Bound::Stall(_) => None,
        }
    }

    /// The watch a `Bound::Stall` child runs under, with its progress file.
    /// The file names this one spawn, so a watched command spawns once.
    fn watch(&mut self) -> io::Result<Option<Arc<Watch>>> {
        let Bound::Stall(limit) = self.bound else {
            return Ok(None);
        };
        let progress = self
            .progress
            .take()
            .ok_or_else(|| io::Error::other("a watched ffmpeg command spawns only once"))?;
        Ok(Some(Watch::new(limit, self.policy.grace, progress)))
    }

    /// Spawn on the tokio runtime.
    pub(crate) fn spawn(&mut self) -> io::Result<FfmpegChild> {
        let watch = self.watch()?;
        let child = self.command.spawn()?;
        let target = Target::of_tokio(&child);
        let owner = FfmpegChild {
            handle: Some(Handle {
                child,
                watch: watch.clone(),
            }),
            stop: Stop::new(self.policy),
            timeout: self.timeout(),
        };
        if let Some(watch) = watch {
            // On failure the owner drops, which stops the child.
            watch.start(target?)?;
        }
        Ok(owner)
    }

    /// Spawn and collect the exit status and both pipes, like
    /// `Command::output`.
    pub(crate) async fn output(&mut self) -> io::Result<Output> {
        self.default_stdio_for_output();
        self.spawn()?.output().await
    }

    /// Spawn as a `std::process` child, for callers that block.
    pub(crate) fn spawn_sync(&mut self) -> io::Result<SyncFfmpegChild> {
        let watch = self.watch()?;
        let child = self.command.as_std_mut().spawn()?;
        let target = Target::of_std(&child);
        let owner = SyncFfmpegChild {
            handle: Some(Handle {
                child,
                watch: watch.clone(),
            }),
            stop: Stop::new(self.policy),
            timeout: self.timeout(),
        };
        if let Some(watch) = watch {
            watch.start(target)?;
        }
        Ok(owner)
    }

    /// Blocking [`Self::output`].
    pub(crate) fn output_sync(&mut self) -> io::Result<Output> {
        self.default_stdio_for_output();
        self.spawn_sync()?.output()
    }
}

const OWNED: &str = "child is owned until drop";

/// A running ffmpeg / ffprobe child on the tokio runtime. Dropping it while the
/// child runs stops the child off the dropping thread (see the `Drop` impl), so
/// dropping a future that holds one is a cancel.
pub(crate) struct FfmpegChild {
    /// `Some` until `Drop` hands a still-running child to the stop thread.
    handle: Option<Handle<tokio::process::Child>>,
    stop: Stop,
    /// A `Bound::Timeout`'s limit and deadline.
    timeout: Option<(Duration, Instant)>,
}

impl FfmpegChild {
    fn handle(&mut self) -> &mut Handle<tokio::process::Child> {
        self.handle.as_mut().expect(OWNED)
    }

    pub(crate) fn take_stdin(&mut self) -> Option<AsyncFfmpegStdin> {
        let handle = self.handle();
        let pipe = handle.child.stdin.take()?;
        Some(AsyncFfmpegStdin {
            pipe,
            feeder: Feeder::new(handle.watch.clone()),
        })
    }

    pub(crate) fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.handle().child.stdout.take()
    }

    pub(crate) fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.handle().child.stderr.take()
    }

    /// Wait for the child to exit. Past a [`Bound::Timeout`] the child is
    /// stopped and this fails with `io::ErrorKind::TimedOut`; a child its
    /// watchdog stopped fails with [`Stalled`].
    pub(crate) async fn wait(&mut self) -> io::Result<ExitStatus> {
        let deadline = self.timeout.map(|(_, deadline)| deadline);
        if let Some(status) = self.exit_by(deadline).await? {
            return self.handle().verdict(status);
        }
        self.stop().await?;
        Err(timed_out(
            self.timeout.map_or(Duration::ZERO, |(limit, _)| limit),
        ))
    }

    /// Wait for the exit until `deadline`; `None` once it passes.
    async fn exit_by(&mut self, deadline: Option<Instant>) -> io::Result<Option<ExitStatus>> {
        let handle = self.handle();
        if handle.watch.is_none() {
            let exit = handle.child.wait();
            let Some(deadline) = deadline else {
                return exit.await.map(Some);
            };
            let deadline = tokio::time::Instant::from_std(deadline);
            return match tokio::time::timeout_at(deadline, exit).await {
                Ok(status) => status.map(Some),
                Err(_) => Ok(None),
            };
        }
        // A watched child is reaped only through `Handle::try_wait`.
        let mut nap = Duration::from_millis(1);
        loop {
            if let Some(status) = handle.try_wait()? {
                return Ok(Some(status));
            }
            let now = Instant::now();
            if deadline.is_some_and(|deadline| now >= deadline) {
                return Ok(None);
            }
            tokio::time::sleep(deadline.map_or(nap, |deadline| nap.min(deadline - now))).await;
            nap = (nap * 2).min(MAX_NAP);
        }
    }

    /// Close stdin, then wait for the exit status while draining stdout and
    /// stderr concurrently (a child blocked on a full pipe never exits), like
    /// `Child::wait_with_output`.
    pub(crate) async fn output(mut self) -> io::Result<Output> {
        drop(self.handle().child.stdin.take());
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
        let handle = self.handle.as_mut().expect(OWNED);
        if let Some(status) = handle.try_wait()? {
            return Ok(status);
        }
        let kill_at = self.stop.request(handle);
        if let Some(status) = self.exit_by(Some(kill_at)).await? {
            return Ok(status);
        }
        let _ = self.handle().kill();
        Ok(self
            .exit_by(None)
            .await?
            .expect("waited without a deadline"))
    }
}

impl Drop for FfmpegChild {
    /// LANDMINE: a dropped owner must end its child. An orphaned ffmpeg keeps
    /// writing its deterministic `<dest>.tmp`, and the next build of the same
    /// derivative interleaves with it and dies at promote.
    fn drop(&mut self) {
        let Some(mut handle) = self.handle.take() else {
            return;
        };
        if matches!(handle.try_wait(), Ok(Some(_))) {
            return;
        }
        let kill_at = self.stop.request(&mut handle);
        finish_in_background(handle, kill_at);
    }
}

/// A running ffmpeg child owned through `std::process`, for code that blocks
/// (the export video sink's writer threads, the sync probes). Same lifecycle as
/// [`FfmpegChild`]: dropping it while the child runs stops the child on a
/// background thread.
pub(crate) struct SyncFfmpegChild {
    /// `Some` until `Drop` hands a still-running child to the stop thread.
    handle: Option<Handle<std::process::Child>>,
    stop: Stop,
    /// A `Bound::Timeout`'s limit and deadline.
    timeout: Option<(Duration, Instant)>,
}

impl SyncFfmpegChild {
    fn handle(&mut self) -> &mut Handle<std::process::Child> {
        self.handle.as_mut().expect(OWNED)
    }

    pub(crate) fn take_stdin(&mut self) -> Option<FfmpegStdin> {
        let handle = self.handle();
        let pipe = handle.child.stdin.take()?;
        Some(FfmpegStdin {
            pipe,
            feeder: Feeder::new(handle.watch.clone()),
        })
    }

    pub(crate) fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.handle().child.stderr.take()
    }

    /// `Child::try_wait`. Past a [`Bound::Timeout`] the child is stopped
    /// (blocking for up to the grace) and this fails with
    /// `io::ErrorKind::TimedOut`; a child its watchdog stopped fails with
    /// [`Stalled`].
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let handle = self.handle();
        if let Some(status) = handle.try_wait()? {
            return handle.verdict(status).map(Some);
        }
        if let Some((limit, deadline)) = self.timeout {
            if Instant::now() >= deadline {
                self.stop()?;
                return Err(timed_out(limit));
            }
        }
        Ok(None)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        let timeout = self.timeout;
        let handle = self.handle();
        if let Some(status) = poll_exit(handle, timeout.map(|(_, deadline)| deadline))? {
            return handle.verdict(status);
        }
        self.stop()?;
        Err(timed_out(
            timeout.map_or(Duration::ZERO, |(limit, _)| limit),
        ))
    }

    /// Blocking [`FfmpegChild::output`].
    pub(crate) fn output(mut self) -> io::Result<Output> {
        let child = &mut self.handle().child;
        drop(child.stdin.take());
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
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
        let handle = self.handle.as_mut().expect(OWNED);
        if let Some(status) = handle.try_wait()? {
            return Ok(status);
        }
        let kill_at = self.stop.request(handle);
        finish_blocking(handle, kill_at)
    }
}

impl Drop for SyncFfmpegChild {
    /// See the landmine on `FfmpegChild`'s `Drop`.
    fn drop(&mut self) {
        let Some(mut handle) = self.handle.take() else {
            return;
        };
        if matches!(handle.try_wait(), Ok(Some(_))) {
            return;
        }
        let kill_at = self.stop.request(&mut handle);
        finish_in_background(handle, kill_at);
    }
}

/// The stdin of an ffmpeg child, for a caller that feeds it (the export video
/// sink). Idle, it holds a watched child's stall clock (see `Feed`); once the
/// watchdog has stopped the child, a failed write reports [`Stalled`] rather
/// than the broken pipe. Dropping it is the child's EOF.
pub(crate) struct FfmpegStdin {
    pipe: std::process::ChildStdin,
    feeder: Feeder,
}

impl Write for FfmpegStdin {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.feeder.set(Feed::Writing);
        let written = self.pipe.write(buf);
        self.feeder.set(Feed::Idle);
        written.map_err(|error| self.feeder.error(error))
    }

    fn flush(&mut self) -> io::Result<()> {
        self.pipe.flush()
    }
}

/// [`FfmpegStdin`] on the tokio runtime.
pub(crate) struct AsyncFfmpegStdin {
    pipe: tokio::process::ChildStdin,
    feeder: Feeder,
}

impl tokio::io::AsyncWrite for AsyncFfmpegStdin {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.pipe).poll_write(cx, buf) {
            Poll::Pending => {
                this.feeder.set(Feed::Writing);
                Poll::Pending
            }
            Poll::Ready(written) => {
                this.feeder.set(Feed::Idle);
                Poll::Ready(written.map_err(|error| this.feeder.error(error)))
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().pipe).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().pipe).poll_shutdown(cx)
    }
}

/// The stall-clock side of a taken stdin; a no-op for an unwatched child.
struct Feeder(Option<Arc<Watch>>);

impl Feeder {
    fn new(watch: Option<Arc<Watch>>) -> Self {
        let feeder = Self(watch);
        feeder.set(Feed::Idle);
        feeder
    }

    fn set(&self, feed: Feed) {
        if let Some(watch) = &self.0 {
            watch.feed(feed);
        }
    }

    fn error(&self, error: io::Error) -> io::Error {
        self.0
            .as_ref()
            .and_then(|watch| watch.stalled())
            .unwrap_or(error)
    }
}

impl Drop for Feeder {
    fn drop(&mut self) {
        self.set(Feed::Closed);
    }
}

/// Where a watched child's stdin stands, as its stall clock sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Feed {
    /// The owner still holds stdin, or it is not piped. The clock runs.
    Untaken,
    /// The caller holds stdin and is not writing. The child waits for input,
    /// which is not a stall, so the clock holds. Each write that returns has
    /// also been consumed, which counts as progress.
    Idle,
    /// A write is blocked on the child. The clock runs.
    Writing,
    /// The caller closed stdin and the child is flushing. The clock runs.
    Closed,
}

/// A child process and its watch, if any.
///
/// LANDMINE: every reap goes through `try_wait` here, under the watch lock,
/// and dropping the handle releases the watch under the same lock. That is
/// what keeps the watchdog from signalling a reaped (possibly reused) pid or a
/// closed process handle.
struct Handle<C: Process> {
    child: C,
    watch: Option<Arc<Watch>>,
}

impl<C: Process> Handle<C> {
    /// A reaped child's result: its status, or [`Stalled`] if the watchdog
    /// stopped it.
    fn verdict(&self, status: ExitStatus) -> io::Result<ExitStatus> {
        match self.watch.as_ref().and_then(|watch| watch.stalled()) {
            Some(stalled) => Err(stalled),
            None => Ok(status),
        }
    }
}

impl<C: Process> Process for Handle<C> {
    fn close_stdin(&mut self) {
        self.child.close_stdin();
    }
    #[cfg(unix)]
    fn pid(&self) -> Option<u32> {
        self.child.pid()
    }
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let Some(watch) = &self.watch else {
            return self.child.try_wait();
        };
        let mut state = watch.lock();
        let status = self.child.try_wait()?;
        if status.is_some() {
            watch.release(&mut state);
        }
        Ok(status)
    }
    fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }
}

impl<C: Process> Drop for Handle<C> {
    fn drop(&mut self) {
        if let Some(watch) = &self.watch {
            watch.release(&mut watch.lock());
        }
    }
}

/// The progress watchdog of one `Bound::Stall` child, shared by its owner, its
/// stdin and the `ffmpeg-watch` thread that reads its progress file.
struct Watch {
    limit: Duration,
    grace: Duration,
    /// The child's `-progress` file.
    progress: PathBuf,
    state: Mutex<WatchState>,
}

struct WatchState {
    /// The last sign of life; the clock runs from here.
    alive_at: Instant,
    feed: Feed,
    stalled: bool,
    /// The owner reaped the child or let its handle go. The watchdog never
    /// signals it again, and exits.
    released: bool,
}

impl Watch {
    fn new(limit: Duration, grace: Duration, progress: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            limit,
            grace,
            progress,
            state: Mutex::new(WatchState {
                alive_at: Instant::now(),
                feed: Feed::Untaken,
                stalled: false,
                released: false,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, WatchState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The owner is done with the child. The progress file goes now, not when
    /// the watch thread next wakes, which a process exit may never see.
    fn release(&self, state: &mut WatchState) {
        if !std::mem::replace(&mut state.released, true) {
            let _ = std::fs::remove_file(&self.progress);
        }
    }

    fn stalled(&self) -> Option<io::Error> {
        self.lock().stalled.then(|| stalled(self.limit))
    }

    fn feed(&self, feed: Feed) {
        let mut state = self.lock();
        state.feed = feed;
        if feed != Feed::Writing {
            state.alive_at = Instant::now();
        }
    }

    fn start(self: &Arc<Self>, target: Target) -> io::Result<()> {
        let watch = self.clone();
        std::thread::Builder::new()
            .name("ffmpeg-watch".into())
            .spawn(move || watch.run(target))
            .map(drop)
    }

    fn run(&self, target: Target) {
        let tick = (self.limit / 4).clamp(Duration::from_millis(5), Duration::from_millis(250));
        let mut progress = ProgressFile::new(self.progress.clone());
        let mut cpu = CpuUse::new(target.pid);
        let mut stopping = false;
        loop {
            std::thread::sleep(tick);
            let advanced = progress.poll();
            let (alive_at, released) = {
                let mut state = self.lock();
                // A child that reported its end is exiting, not stalled.
                if advanced || state.feed == Feed::Idle || progress.counters.ended {
                    state.alive_at = Instant::now();
                }
                (state.alive_at, state.released)
            };
            if released {
                break;
            }
            let quiet = alive_at.elapsed();
            if stopping || quiet < self.limit / 2 {
                cpu.forget();
                continue;
            }
            // CPU use from half the limit on decides whether the quiet child
            // is working; sampled twice per quiet stretch, off the lock.
            if !cpu.marked() {
                cpu.mark();
                continue;
            }
            if quiet < self.limit {
                continue;
            }
            let busy = cpu.busy();
            let mut state = self.lock();
            if state.released {
                break;
            }
            if state.alive_at != alive_at {
                continue;
            }
            if busy {
                state.alive_at = Instant::now();
                cpu.forget();
                continue;
            }
            state.stalled = true;
            warn!(
                "ffmpeg showed no sign of life for {} s; stopping it",
                self.limit.as_secs_f32()
            );
            target.terminate();
            drop(state);
            self.kill_after_grace(target);
            stopping = true;
        }
    }

    /// The rest of the stop sequence the watchdog can run without owning the
    /// child: the grace, then a kill. The owner reaps.
    fn kill_after_grace(&self, target: Target) {
        let kill_at = Instant::now() + self.grace;
        loop {
            let state = self.lock();
            if state.released {
                return;
            }
            let now = Instant::now();
            if now >= kill_at {
                target.kill();
                return;
            }
            drop(state);
            std::thread::sleep((kill_at - now).min(MAX_NAP));
        }
    }
}

/// How the watchdog reaches a child it does not own: by pid (signals on Unix,
/// CPU use everywhere), and by process handle on Windows. Signalled only under
/// the watch lock while the watch is unreleased (see `Handle`).
#[derive(Clone, Copy)]
struct Target {
    pid: u32,
    #[cfg(windows)]
    handle: usize,
}

impl Target {
    fn of_tokio(child: &tokio::process::Child) -> io::Result<Self> {
        let gone = || io::Error::other("ffmpeg exited before its watch started");
        Ok(Self {
            pid: child.id().ok_or_else(gone)?,
            #[cfg(windows)]
            handle: child.raw_handle().ok_or_else(gone)? as usize,
        })
    }

    fn of_std(child: &std::process::Child) -> Self {
        Self {
            pid: child.id(),
            #[cfg(windows)]
            handle: std::os::windows::io::AsRawHandle::as_raw_handle(child) as usize,
        }
    }

    /// Unix: SIGTERM. Windows has no such request, so it terminates.
    fn terminate(self) {
        // SAFETY: plain syscalls on a child that is not reaped yet, so the pid
        // or handle is still this child's (see `Handle`).
        #[cfg(unix)]
        unsafe {
            libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
        }
        #[cfg(windows)]
        unsafe {
            use windows::Win32::{Foundation::HANDLE, System::Threading::TerminateProcess};
            let _ = TerminateProcess(HANDLE(self.handle as *mut std::ffi::c_void), 1);
        }
    }

    /// Unix: SIGKILL. Windows: `terminate` already ended it.
    fn kill(self) {
        // SAFETY: as in `terminate`.
        #[cfg(unix)]
        unsafe {
            libc::kill(self.pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// The CPU time a quiet child uses, which tells a slow child from a stuck
/// one: an encoder deep in its lookahead computes, one wedged in a hardware
/// session sleeps.
struct CpuUse {
    system: sysinfo::System,
    pid: sysinfo::Pid,
    /// When the current quiet stretch was first sampled, and the CPU time
    /// then (`None` if the OS did not answer).
    mark: Option<(Instant, Option<u64>)>,
}

impl CpuUse {
    fn new(pid: u32) -> Self {
        Self {
            system: sysinfo::System::new(),
            pid: sysinfo::Pid::from_u32(pid),
            mark: None,
        }
    }

    /// CPU-milliseconds the child has used so far.
    fn used_ms(&mut self) -> Option<u64> {
        self.system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[self.pid]),
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_cpu()
                .without_tasks(),
        );
        self.system
            .process(self.pid)
            .map(sysinfo::Process::accumulated_cpu_time)
    }

    fn marked(&self) -> bool {
        self.mark.is_some()
    }

    fn mark(&mut self) {
        self.mark = Some((Instant::now(), self.used_ms()));
    }

    fn forget(&mut self) {
        self.mark = None;
    }

    /// Whether the child used at least [`BUSY_SHARE`] of a core since the
    /// mark. Unknown counts as idle.
    fn busy(&mut self) -> bool {
        let Some((at, Some(before))) = self.mark else {
            return false;
        };
        let elapsed_ms = at.elapsed().as_secs_f64() * 1000.0;
        self.used_ms()
            .is_some_and(|now| now.saturating_sub(before) as f64 >= elapsed_ms * BUSY_SHARE)
    }
}

/// What a watched child has appended to its `-progress` file so far.
struct ProgressFile {
    path: PathBuf,
    /// Opened once ffmpeg has created the file.
    file: Option<File>,
    /// The unfinished last line.
    partial: Vec<u8>,
    counters: Progress,
}

impl ProgressFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            partial: Vec::new(),
            counters: Progress::default(),
        }
    }

    /// Read what was appended since the last call. True if it advanced.
    fn poll(&mut self) -> bool {
        if self.file.is_none() {
            self.file = File::open(&self.path).ok();
        }
        let Some(file) = self.file.as_mut() else {
            return false;
        };
        let mut appended = Vec::new();
        let _ = file.read_to_end(&mut appended);
        let mut advanced = false;
        for byte in appended {
            if byte == b'\n' {
                advanced |= self.counters.line(&self.partial);
                self.partial.clear();
            } else {
                self.partial.push(byte);
            }
        }
        advanced
    }
}

/// ffmpeg's progress counters. It writes a block of `key=value` lines every
/// `-stats_period` (0.5 s) whether or not anything moved, including while an
/// encoder is wedged, so a block alone is no sign of life: only a rise in
/// `frame` (video) or `out_time_us` (any output) is.
struct Progress {
    frame: u64,
    out_time_us: i64,
    /// `progress=end`: the run is over and ffmpeg is exiting.
    ended: bool,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            frame: 0,
            out_time_us: i64::MIN,
            ended: false,
        }
    }
}

impl Progress {
    /// Take one line. True if it advanced a counter.
    fn line(&mut self, line: &[u8]) -> bool {
        let Ok(line) = std::str::from_utf8(line) else {
            return false;
        };
        let Some((key, value)) = line.trim().split_once('=') else {
            return false;
        };
        match key {
            "frame" => value.parse().is_ok_and(|frame: u64| {
                let advanced = frame > self.frame;
                self.frame = self.frame.max(frame);
                advanced
            }),
            // `out_time_ms` is the same microsecond count under an old name.
            "out_time_us" | "out_time_ms" => value.parse().is_ok_and(|time: i64| {
                let advanced = time > self.out_time_us;
                self.out_time_us = self.out_time_us.max(time);
                advanced
            }),
            "progress" => {
                self.ended |= value == "end";
                false
            }
            _ => false,
        }
    }
}

/// The longest nap between exit polls.
const MAX_NAP: Duration = Duration::from_millis(20);

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
        nap = (nap * 2).min(MAX_NAP);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_rising_frame_or_output_time_is_progress() {
        let mut progress = Progress::default();
        let block = |progress: &mut Progress, text: &str| {
            text.lines().fold(false, |advanced, line| {
                progress.line(line.as_bytes()) | advanced
            })
        };
        // Before any output: counters at zero or N/A.
        assert!(!block(
            &mut progress,
            "frame=0\nout_time_us=N/A\nprogress=continue"
        ));
        assert!(block(
            &mut progress,
            "frame=5\nout_time_us=100000\nprogress=continue"
        ));
        // A repeated block is what a wedged encoder prints.
        assert!(!block(
            &mut progress,
            "frame=5\nout_time_us=100000\nprogress=continue"
        ));
        // Audio-only output moves only the time.
        assert!(block(
            &mut progress,
            "out_time_us=200000\nout_time_ms=200000"
        ));
        assert!(!progress.ended);
        assert!(!block(&mut progress, "frame=5\nprogress=end"));
        assert!(progress.ended);
        assert!(!progress.line(b"not a progress line"));
    }

    #[test]
    fn the_stalled_error_carries_the_tag_the_renderer_matches() {
        let error = stalled(Duration::from_secs(400));
        assert!(is_stalled(&error));
        assert!(error.to_string().starts_with("ffmpeg-stalled: "), "{error}");
        assert!(!is_stalled(&timed_out(Duration::from_secs(1))));
        assert!(!is_stalled(&io::Error::other("ffmpeg exited 1")));
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::ExitStatusExt;
    use std::path::Path;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    use super::*;

    /// `sh -c script` under the owner. The script prints `ready` once its traps
    /// are set, so a test never signals it before it can ignore the signal.
    fn sh(script: &str, grace: Duration) -> FfmpegCommand {
        let mut command = FfmpegCommand::program("sh", Bound::Timeout(Duration::from_secs(60)));
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
        let pid = child.handle().child.id().unwrap();
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
            BufReader::new(child.handle().child.stdout.take().unwrap())
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
        let pid = child.handle().child.id();
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
        let mut command = FfmpegCommand::program("sh", Bound::Timeout(Duration::from_secs(60)));
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

    const LIMIT: Duration = Duration::from_millis(300);

    /// A stand-in ffmpeg: a script that finds its progress file where the
    /// owner puts it (`-progress file:<path>` leads the argv) and runs `body`
    /// with `$progress` set.
    fn fake_ffmpeg(dir: &Path, body: &str) -> FfmpegCommand {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("ffmpeg");
        std::fs::write(
            &script,
            format!("#!/bin/sh\nprogress=\"${{2#file:}}\"\n{body}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = FfmpegCommand::program(script, Bound::Stall(LIMIT));
        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .grace(Duration::from_millis(200));
        command
    }

    /// Three advancing blocks, then asleep: what a child wedged in a
    /// hardware session looks like (its repeated blocks are `Progress`'s).
    const GOES_QUIET: &str = "\
        for frame in 1 2 3; do printf 'frame=%s\\nprogress=continue\\n' $frame >> \"$progress\"; sleep 0.05; done\n\
        exec sleep 30";

    /// No progress at all, but a core's worth of work, for well past the
    /// limit: an encoder filling its lookahead. `kill -0` is a builtin, so
    /// the loop never forks.
    const BUSY_WITHOUT_PROGRESS: &str = "\
        sleep 1.5 & timer=$!\n\
        while kill -0 $timer 2>/dev/null; do :; done\n\
        printf 'frame=1\\nprogress=end\\n' >> \"$progress\"";

    /// Advancing for well past the limit, then a clean end.
    const KEEPS_ADVANCING: &str = "\
        frame=0; while [ $frame -lt 20 ]; do frame=$((frame + 1)); printf 'frame=%s\\nout_time_us=%s\\nprogress=continue\\n' $frame $((frame * 33333)) >> \"$progress\"; sleep 0.05; done\n\
        printf 'progress=end\\n' >> \"$progress\"";

    fn assert_stopped_as_stalled(error: io::Error, started: Instant) {
        assert!(is_stalled(&error), "{error}");
        let elapsed = started.elapsed();
        assert!(elapsed >= LIMIT, "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    }

    #[tokio::test]
    async fn the_watchdog_stops_a_child_whose_progress_stops_advancing() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let mut child = fake_ffmpeg(dir.path(), GOES_QUIET).spawn().unwrap();
        assert_stopped_as_stalled(child.wait().await.unwrap_err(), started);

        let started = Instant::now();
        let mut child = fake_ffmpeg(dir.path(), GOES_QUIET).spawn_sync().unwrap();
        let error = loop {
            match child.try_wait() {
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Ok(Some(status)) => panic!("exited on its own: {status}"),
                Err(error) => break error,
            }
        };
        assert_stopped_as_stalled(error, started);
        assert!(child.handle.as_mut().unwrap().try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn the_watchdog_leaves_a_child_that_keeps_advancing() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let mut command = fake_ffmpeg(dir.path(), KEEPS_ADVANCING);
        let progress = command.progress.clone().unwrap();
        let status = command.output().await.unwrap().status;
        assert!(status.success(), "{status}");
        assert!(started.elapsed() > 2 * LIMIT, "{:?}", started.elapsed());
        // Removed at the reap, not when the watch thread next wakes.
        assert!(!progress.exists(), "{}", progress.display());

        let mut command = fake_ffmpeg(dir.path(), KEEPS_ADVANCING);
        let progress = command.progress.clone().unwrap();
        let status = command.output_sync().unwrap().status;
        assert!(status.success(), "{status}");
        assert!(!progress.exists(), "{}", progress.display());
    }

    #[tokio::test]
    async fn the_watchdog_leaves_a_child_that_is_busy_without_progress() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let status = fake_ffmpeg(dir.path(), BUSY_WITHOUT_PROGRESS)
            .output()
            .await
            .unwrap()
            .status;
        assert!(status.success(), "{status}");
        assert!(started.elapsed() > 3 * LIMIT, "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_child_waiting_for_input_is_not_stalled_but_one_that_stops_reading_is() {
        let dir = tempfile::tempdir().unwrap();
        // Never reads stdin, never reports progress.
        let mut command = fake_ffmpeg(dir.path(), "exec sleep 30");
        command.media_on_stdin();
        let mut child = command.spawn().unwrap();
        let mut stdin = child.take_stdin().unwrap();
        // Held stdin with nothing to write: the child is starved, not stalled.
        tokio::time::sleep(3 * LIMIT).await;
        assert!(child.handle().try_wait().unwrap().is_none());
        // A write the child never takes is blocked on it.
        let started = Instant::now();
        let error = stdin.write_all(&vec![0; 8 << 20]).await.unwrap_err();
        assert_stopped_as_stalled(error, started);
        assert!(is_stalled(&child.wait().await.unwrap_err()));
    }
}
