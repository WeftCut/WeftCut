//! The registry and thread host every decode session runs on: one thread per
//! session, opened by a handshake, driven by a command channel, closed once.
//!
//! Owns the session lifecycle (reserve, open, commit, cancel, close, detach)
//! and the panic boundary. Does not own what a session does on its thread: the
//! pipeline's start closure builds its state there and returns the loop that
//! drives it.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::msg::DecodeMsg;
use crate::recover::{panic_message, LockExt};

/// How long `close` waits for a session thread to exit before detaching it.
/// A healthy thread clears this by orders of magnitude (the cancel flag stops
/// it at its next check), so the grace is only paid when the thread is wedged
/// inside a single ffmpeg call (dump-verified: d3d11va stuck under GPU
/// contention). Bounded because the caller is Electron's main thread, which
/// must see a short blip, never an AppHang.
pub(crate) const CLOSE_GRACE: Duration = Duration::from_millis(300);

/// Where one session's messages go: its own JS callback in the addon.
pub(crate) type Sink = Box<dyn Fn(DecodeMsg) + Send>;

/// Per-session state shared between the session thread and calls that must
/// not queue behind it on the command channel (see [`SessionRuntime::with`]).
pub(crate) trait SessionShared: Send + Sync + 'static {
    /// Runs on close after the cancel flag is set and the sink is silenced,
    /// before the command channel drops: wake whatever the session thread may
    /// be parked on.
    fn on_close(&self) {}
}

struct CtxInner {
    cancel: AtomicBool,
    /// `None` once the session is closed.
    sink: Mutex<Option<Sink>>,
}

/// A session thread's handle on its own sink and cancel flag.
#[derive(Clone)]
pub(crate) struct SessionCtx(Arc<CtxInner>);

impl SessionCtx {
    fn new(sink: Sink) -> Self {
        Self(Arc::new(CtxInner {
            cancel: AtomicBool::new(false),
            sink: Mutex::new(Some(sink)),
        }))
    }

    /// Send `msg` to this session's sink; dropped once the session is closed.
    /// The sink lock is held across the call, which is what lets `close` wait
    /// out an emit already in progress (see [`Self::silence`]).
    pub fn emit(&self, msg: DecodeMsg) {
        if let Some(sink) = self.0.sink.lock_recover().as_ref() {
            sink(msg);
        }
    }

    /// Set by close before anything else. Long decode work polls it and
    /// abandons what it was doing.
    pub fn cancelled(&self) -> bool {
        self.0.cancel.load(Ordering::Acquire)
    }

    pub(crate) fn cancel(&self) {
        self.0.cancel.store(true, Ordering::Release);
    }

    /// Drop the sink. Taking the lock waits for an emit in progress, so no
    /// message reaches the sink once this returns, even from a detached thread.
    fn silence(&self) {
        drop(self.0.sink.lock_recover().take());
    }

    /// A context outside any runtime, for driving a pipeline's loop directly.
    #[cfg(test)]
    pub(crate) fn for_test(sink: Sink) -> Self {
        Self::new(sink)
    }
}

/// Which teardown path `close` took. Split out so tests can tell a reaped
/// thread from a detached one; a plain `Ok` does not prove the thread exited.
#[derive(Debug, PartialEq, Eq)]
enum CloseOutcome {
    Reaped,
    /// Still busy at the deadline; it exits on its own once its blocking call
    /// returns and it sees the cancel flag.
    Detached,
}

struct Session<C, S> {
    tx: Sender<C>,
    shared: Arc<S>,
    ctx: SessionCtx,
    /// Nothing is ever sent: the paired sender lives in the thread's closure,
    /// so `Disconnected` means the thread body finished, panic included.
    done_rx: Receiver<()>,
    join: JoinHandle<()>,
}

enum Slot<C, S> {
    /// Reserved while the open handshake runs, outside the registry lock.
    Opening,
    Open(Session<C, S>),
}

/// The live sessions of one pipeline, keyed by the caller's id. `C` is the
/// pipeline's command type, `S` its per-session shared state.
pub(crate) struct SessionRuntime<C, S> {
    /// Names the pipeline in thread names and error strings.
    label: &'static str,
    sessions: Mutex<HashMap<String, Slot<C, S>>>,
}

impl<C: Send + 'static, S: SessionShared> SessionRuntime<C, S> {
    pub fn new(label: &'static str) -> Self {
        Self {
            label,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Open session `id`: spawn its thread and run `start` there with the
    /// session's context and command receiver. `start` builds the session's
    /// state on that thread (decoder objects are not `Send`) and returns the
    /// open info plus the loop that drives the session; the loop ends when the
    /// receiver disconnects, which is how close reaches it. Blocks until
    /// `start` returns, so a failed open surfaces here.
    ///
    /// An id that is open or opening is refused before `sink` or `start` is
    /// used, so a duplicate can never disturb the live session.
    pub fn open<I, L>(
        &self,
        id: &str,
        sink: Sink,
        shared: Arc<S>,
        start: impl FnOnce(SessionCtx, Receiver<C>) -> Result<(I, L), String> + Send + 'static,
    ) -> Result<I, String>
    where
        I: Send + 'static,
        L: FnOnce(),
    {
        let label = self.label;
        {
            let mut sessions = self.sessions.lock_recover();
            if sessions.contains_key(id) {
                return Err(format!("{label} session '{id}' is already open"));
            }
            sessions.insert(id.to_string(), Slot::Opening);
        }

        let ctx = SessionCtx::new(sink);
        let (cmd_tx, cmd_rx) = mpsc::channel::<C>();
        let (init_tx, init_rx) = mpsc::channel::<Result<I, String>>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let thread_ctx = ctx.clone();
        let sid = id.to_string();
        let spawned = thread::Builder::new()
            .name(format!("{label}-{id}"))
            .spawn(move || {
                // Held, never used: its drop, on return and on unwind, is the
                // done signal `close` bounds its wait on.
                let _done_tx = done_tx;
                let run = match catch_unwind(AssertUnwindSafe(|| start(thread_ctx.clone(), cmd_rx)))
                {
                    Ok(Ok((info, run))) => {
                        if init_tx.send(Ok(info)).is_err() {
                            return;
                        }
                        run
                    }
                    Ok(Err(e)) => {
                        let _ = init_tx.send(Err(e));
                        return;
                    }
                    Err(payload) => {
                        let _ = init_tx.send(Err(format!(
                            "{label} session '{sid}' panicked while opening: {}",
                            panic_message(&*payload)
                        )));
                        return;
                    }
                };
                // A panic must not end the thread silently (JS would wait for
                // messages that never come). The loop's state is dropped by
                // the unwind and never touched again, which is what makes the
                // `AssertUnwindSafe` sound.
                if let Err(payload) = catch_unwind(AssertUnwindSafe(run)) {
                    thread_ctx.emit(DecodeMsg::Error {
                        message: format!("{label} decode panicked: {}", panic_message(&*payload)),
                        terminal: true,
                    });
                }
            });
        let join = match spawned {
            Ok(join) => join,
            Err(e) => {
                self.sessions.lock_recover().remove(id);
                return Err(format!("spawn {label} session thread failed: {e}"));
            }
        };

        let reply = init_rx.recv();
        let mut sessions = self.sessions.lock_recover();
        match reply {
            Ok(Ok(info)) => {
                sessions.insert(
                    id.to_string(),
                    Slot::Open(Session {
                        tx: cmd_tx,
                        shared,
                        ctx,
                        done_rx,
                        join,
                    }),
                );
                Ok(info)
            }
            Ok(Err(e)) => {
                sessions.remove(id);
                drop(sessions);
                // The thread returns right after replying.
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                sessions.remove(id);
                drop(sessions);
                let _ = join.join();
                Err(format!("{label} session '{id}' thread exited before init"))
            }
        }
    }

    /// Queue `cmd` for the session's loop.
    pub fn send(&self, id: &str, cmd: C) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let label = self.label;
        match sessions.get(id) {
            Some(Slot::Open(s)) => {
                s.tx.send(cmd)
                    .map_err(|_| format!("{label} session '{id}' thread is gone"))
            }
            _ => Err(format!("no {label} session '{id}'")),
        }
    }

    /// Run `f` on the session's shared state, outside the registry lock and
    /// without queueing behind the session's commands.
    pub fn with<R>(&self, id: &str, f: impl FnOnce(&S) -> R) -> Result<R, String> {
        let shared = match self.sessions.lock_recover().get(id) {
            Some(Slot::Open(s)) => Arc::clone(&s.shared),
            _ => return Err(format!("no {} session '{id}'", self.label)),
        };
        Ok(f(&shared))
    }

    /// Close the session: remove it, set its cancel flag, silence its sink,
    /// run its close hook, drop its command sender, then wait [`CLOSE_GRACE`]
    /// for the thread to exit and detach it if it has not. Returns promptly
    /// either way; nothing the session emits afterwards reaches its sink.
    pub fn close(&self, id: &str) -> Result<(), String> {
        self.close_with_grace(id, CLOSE_GRACE).map(|_| ())
    }

    fn close_with_grace(&self, id: &str, grace: Duration) -> Result<CloseOutcome, String> {
        let label = self.label;
        let session = {
            let mut sessions = self.sessions.lock_recover();
            match sessions.remove(id) {
                Some(Slot::Open(s)) => s,
                Some(Slot::Opening) => {
                    sessions.insert(id.to_string(), Slot::Opening);
                    return Err(format!("no {label} session '{id}'"));
                }
                None => return Err(format!("no {label} session '{id}'")),
            }
        };
        let Session {
            tx,
            shared,
            ctx,
            done_rx,
            join,
        } = session;
        ctx.cancel();
        ctx.silence();
        shared.on_close();
        drop(tx);
        // Bounded on the done signal, never on `join()`, which has no timeout.
        match done_rx.recv_timeout(grace) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                join.join().map_err(|_| {
                    format!("{label} session '{id}' thread panicked during teardown")
                })?;
                Ok(CloseOutcome::Reaped)
            }
            Err(RecvTimeoutError::Timeout) => {
                tracing::warn!(
                    session = %id,
                    pipeline = label,
                    grace_ms = grace.as_millis() as u64,
                    "decode session close: thread still busy after grace; detaching"
                );
                drop(join);
                Ok(CloseOutcome::Detached)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_wait::wait_for;

    /// A liveness bound for something that must happen, like `wait_for`'s.
    const MUST_HAPPEN: Duration = Duration::from_secs(30);

    #[derive(Debug, PartialEq)]
    enum Seen {
        Mark(u32),
        Error { message: String, terminal: bool },
        Other,
    }

    type Log = Arc<Mutex<Vec<Seen>>>;

    fn recording_sink() -> (Sink, Log) {
        let log: Log = Arc::default();
        let log2 = Arc::clone(&log);
        let sink: Sink = Box::new(move |msg| {
            log2.lock().unwrap().push(match msg {
                DecodeMsg::Mark { a_us, .. } => Seen::Mark(a_us as u32),
                DecodeMsg::Error { message, terminal } => Seen::Error { message, terminal },
                _ => Seen::Other,
            });
        });
        (sink, log)
    }

    fn mark(n: u32) -> DecodeMsg {
        DecodeMsg::Mark {
            a_us: n as f64,
            b_us: n as f64,
        }
    }

    fn len(log: &Log) -> usize {
        log.lock().unwrap().len()
    }

    #[derive(Default)]
    struct Hook {
        closed: AtomicBool,
    }

    impl SessionShared for Hook {
        fn on_close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    type Rt = SessionRuntime<u32, Hook>;

    /// Open a session whose loop echoes every command as a `Mark`.
    fn open_echo(rt: &Rt, id: &str, sink: Sink) -> Result<(), String> {
        rt.open(id, sink, Arc::default(), |ctx, rx: Receiver<u32>| {
            Ok(((), move || {
                while let Ok(n) = rx.recv() {
                    ctx.emit(mark(n));
                }
            }))
        })
    }

    #[test]
    fn messages_reach_their_own_session_sink_in_order() {
        let rt = Rt::new("test");
        let (sink_a, log_a) = recording_sink();
        let (sink_b, log_b) = recording_sink();
        open_echo(&rt, "a", sink_a).unwrap();
        open_echo(&rt, "b", sink_b).unwrap();
        for n in 0..20 {
            rt.send("a", n).unwrap();
            rt.send("b", 100 + n).unwrap();
        }
        assert!(wait_for(|| len(&log_a) == 20 && len(&log_b) == 20));
        assert_eq!(
            *log_a.lock().unwrap(),
            (0..20).map(Seen::Mark).collect::<Vec<_>>()
        );
        assert_eq!(
            *log_b.lock().unwrap(),
            (100..120).map(Seen::Mark).collect::<Vec<_>>()
        );
        rt.close("a").unwrap();
        rt.close("b").unwrap();
    }

    #[test]
    fn a_duplicate_id_is_refused_before_the_new_session_starts() {
        let rt = Rt::new("test");
        let (sink_live, log_live) = recording_sink();
        let (sink_dup, log_dup) = recording_sink();
        open_echo(&rt, "s", sink_live).unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let started2 = Arc::clone(&started);
        let err = rt
            .open("s", sink_dup, Arc::default(), move |_ctx, _rx| {
                started2.store(true, Ordering::SeqCst);
                Ok(((), || {}))
            })
            .unwrap_err();
        assert!(err.contains("already open"), "{err}");
        assert!(!started.load(Ordering::SeqCst), "the duplicate's start ran");
        // The live session still reaches its own sink, not the duplicate's.
        rt.send("s", 7).unwrap();
        assert!(wait_for(|| len(&log_live) == 1));
        assert_eq!(*log_live.lock().unwrap(), vec![Seen::Mark(7)]);
        assert!(log_dup.lock().unwrap().is_empty());
        rt.close("s").unwrap();
    }

    /// Open `id` on its own thread with a start that reports it has begun and
    /// then waits on the returned gate. The open returns once the gate opens.
    fn open_gated(
        rt: &Arc<Rt>,
        id: &'static str,
    ) -> (Sender<()>, thread::JoinHandle<Result<(), String>>) {
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let rt2 = Arc::clone(rt);
        let opener = thread::spawn(move || {
            let (sink, _log) = recording_sink();
            rt2.open(id, sink, Arc::default(), move |_ctx, rx: Receiver<u32>| {
                entered_tx.send(()).unwrap();
                gate_rx.recv().unwrap();
                Ok(((), move || while rx.recv().is_ok() {}))
            })
        });
        entered_rx
            .recv_timeout(MUST_HAPPEN)
            .expect("the gated open never reached its start");
        (gate_tx, opener)
    }

    #[test]
    fn a_slow_open_does_not_block_other_sessions() {
        let rt = Arc::new(Rt::new("test"));
        let (gate, opener) = open_gated(&rt, "slow");
        // While "slow" sits inside its handshake, another session opens, is
        // served and closes. A registry lock held across the handshake would
        // park this thread until the gate opens, which only happens below.
        let rt2 = Arc::clone(&rt);
        let other = thread::spawn(move || {
            let (sink, log) = recording_sink();
            open_echo(&rt2, "fast", sink).unwrap();
            rt2.send("fast", 1).unwrap();
            assert!(wait_for(|| len(&log) == 1));
            rt2.close("fast").unwrap();
        });
        assert!(
            wait_for(|| other.is_finished()),
            "another session's open/send/close waited behind a slow open"
        );
        other.join().unwrap();
        gate.send(()).unwrap();
        opener.join().unwrap().expect("the slow open completes");
        rt.close("slow").unwrap();
    }

    #[test]
    fn an_id_in_its_open_handshake_is_neither_reopened_nor_reachable() {
        let rt = Arc::new(Rt::new("test"));
        let (gate, opener) = open_gated(&rt, "s");
        let (sink, log) = recording_sink();
        let err = open_echo(&rt, "s", sink).unwrap_err();
        assert!(err.contains("already open"), "{err}");
        assert!(rt.send("s", 1).is_err(), "a reservation takes no commands");
        assert!(rt.close("s").is_err(), "a reservation is not closable");
        gate.send(()).unwrap();
        opener.join().unwrap().expect("the first open completes");
        rt.close("s").unwrap();
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn a_panic_becomes_one_terminal_error_and_the_id_reopens() {
        let rt = Rt::new("test");
        let (sink, log) = recording_sink();
        rt.open("s", sink, Arc::default(), |_ctx, rx: Receiver<u32>| {
            Ok(((), move || {
                if rx.recv().is_ok() {
                    panic!("boom in a session loop");
                }
            }))
        })
        .unwrap();
        rt.send("s", 1).unwrap();
        assert!(wait_for(|| len(&log) >= 1));
        assert_eq!(
            rt.close_with_grace("s", CLOSE_GRACE),
            Ok(CloseOutcome::Reaped)
        );
        let seen = log.lock().unwrap();
        assert_eq!(seen.len(), 1, "one message after a panic: {seen:?}");
        match &seen[0] {
            Seen::Error { message, terminal } => {
                assert!(
                    message.contains("panicked") && message.contains("boom"),
                    "{message}"
                );
                assert!(terminal, "a panic ends the session");
            }
            other => panic!("expected a terminal error, got {other:?}"),
        }
        drop(seen);
        let (sink, _log) = recording_sink();
        open_echo(&rt, "s", sink).expect("the id reopens after close");
        rt.close("s").unwrap();
    }

    #[test]
    fn a_panic_while_opening_fails_the_open_and_frees_the_id() {
        let rt = Rt::new("test");
        let (sink, _log) = recording_sink();
        let err = rt
            .open(
                "s",
                sink,
                Arc::default(),
                |_ctx, _rx| -> Result<((), fn()), String> { panic!("boom in a start") },
            )
            .unwrap_err();
        assert!(err.contains("panicked while opening"), "{err}");
        let (sink, _log) = recording_sink();
        open_echo(&rt, "s", sink).expect("the id is free after a failed open");
        rt.close("s").unwrap();
    }

    #[test]
    fn close_reaps_a_healthy_thread_and_refuses_an_unknown_id() {
        let rt = Rt::new("test");
        let (sink, _log) = recording_sink();
        open_echo(&rt, "s", sink).unwrap();
        assert_eq!(
            rt.close_with_grace("s", CLOSE_GRACE),
            Ok(CloseOutcome::Reaped)
        );
        assert!(rt.close("s").is_err(), "a second close finds nothing");
        assert!(rt.send("s", 1).is_err());
        assert!(rt.with("s", |_| ()).is_err());
    }

    #[test]
    fn close_cancels_runs_the_hook_and_detaches_a_wedged_thread() {
        let rt = Rt::new("test");
        let (sink, log) = recording_sink();
        let hook = Arc::new(Hook::default());
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let (after_tx, after_rx) = mpsc::channel::<bool>();
        rt.open(
            "s",
            sink,
            Arc::clone(&hook),
            move |ctx, rx: Receiver<u32>| {
                Ok(((), move || {
                    if rx.recv().is_ok() {
                        // Stands in for a decode call that ignores the flag and
                        // the channel until the test lets it go.
                        entered_tx.send(()).unwrap();
                        gate_rx.recv().unwrap();
                        let cancelled = ctx.cancelled();
                        ctx.emit(mark(1));
                        after_tx.send(cancelled).unwrap();
                    }
                }))
            },
        )
        .unwrap();
        rt.send("s", 0).unwrap();
        entered_rx.recv_timeout(MUST_HAPPEN).unwrap();

        assert_eq!(
            rt.close_with_grace("s", CLOSE_GRACE),
            Ok(CloseOutcome::Detached)
        );
        assert!(
            hook.closed.load(Ordering::SeqCst),
            "close ran the session's hook"
        );

        gate_tx.send(()).unwrap();
        let cancelled = after_rx
            .recv_timeout(MUST_HAPPEN)
            .expect("the wedged thread resumed");
        assert!(cancelled, "the thread saw the cancel flag close set");
        assert!(
            log.lock().unwrap().is_empty(),
            "the detached thread's emit reached the sink"
        );
    }

    #[test]
    fn with_reaches_the_shared_state_while_the_loop_is_busy() {
        let rt = Rt::new("test");
        let (sink, _log) = recording_sink();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        rt.open("s", sink, Arc::default(), move |_ctx, rx: Receiver<u32>| {
            Ok(((), move || {
                if rx.recv().is_ok() {
                    entered_tx.send(()).unwrap();
                    let _ = gate_rx.recv();
                }
            }))
        })
        .unwrap();
        rt.send("s", 0).unwrap();
        entered_rx.recv_timeout(MUST_HAPPEN).unwrap();
        rt.with("s", |hook| hook.closed.store(true, Ordering::SeqCst))
            .expect("with does not queue behind the busy loop");
        gate_tx.send(()).unwrap();
        rt.close("s").unwrap();
    }
}
