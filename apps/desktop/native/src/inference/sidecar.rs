//! The one-shot CLI child every local inference engine is run as — whisper.cpp
//! and sherpa-onnx for speech, llama-mtmd for description alike.
//!
//! Each engine builds its own argument vector, decides where its answer lands
//! and what a failure means for it (a CPU retry, a device it abandoned); what
//! is NOT engine-specific, and is easy to get wrong per engine, lives here once:
//!
//! - the **interactive-memory admission** (`resources::interactive`) sized from
//!   the model files the arguments name, held for the child's whole life;
//! - the **thread clamp** against the admitted allocation, applied after the
//!   admission wait and immediately before spawn (see [`ChildRun::threads`]);
//! - **conhost suppression** (`no_console_window`);
//! - **`kill_on_drop(true)`** (the same landmine as ffmpeg in `jobs/hwaccel.rs`):
//!   a timed-out or cancelled future drops the child, which reaps it;
//! - the **timeout** and the **exit status** classification, reported as a
//!   neutral [`SidecarFailure`] each subsystem maps onto its own error type with
//!   its own wording.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use tokio::process::Command;

use crate::compute_jobs::{ModelObserver, ModelPhase};
use crate::inference_files::program_path;
use crate::process::{output_watching_stderr, NoConsoleWindow};

/// Why a sidecar run produced no usable output. Neutral on purpose: speech maps
/// it to `SpeechError`, description to `VlmError`, each with the messages it
/// has always used.
#[derive(Debug)]
pub enum SidecarFailure {
    /// Admission, path resolution, or reading the child's pipes failed.
    Io(std::io::Error),
    /// The child could not be started (bad path, wrong architecture, …).
    Spawn { program: String, cause: String },
    /// The child ran longer than its hang guard and was killed.
    Timeout { secs: u64 },
    /// The child exited non-zero (`code: None` = killed by a signal); `stderr`
    /// is trimmed.
    Exit { code: Option<i32>, stderr: String },
}

/// A fully-specified one-shot child run.
pub struct ChildRun<'a> {
    /// The CLI binary to spawn.
    pub program: &'a Path,
    /// Private workspace for ASCII relative input/output aliases
    /// (`inference_files::InferenceFiles`).
    pub cwd: &'a Path,
    /// The engine's argument vector, before [`Self::threads`] is applied.
    pub args: Vec<OsString>,
    /// Hang guard: the child is killed and [`SidecarFailure::Timeout`] returned
    /// when it runs longer than this.
    pub timeout: Duration,
    /// Whether the engine's answer is on stdout. `false` sends stdout to null —
    /// the engine writes a file the caller reads back.
    pub capture_stdout: bool,
    /// Applies the admitted thread allocation to the arguments. Runs AFTER the
    /// admission wait, because argument preparation can precede that wait and a
    /// settings edit during it: an engine either clamps its own thread flag to
    /// it or appends one. Engine-specific flags, so the engine supplies it.
    pub threads: fn(&mut Vec<OsString>, u32),
    /// Reads one stderr line for the engine's own word that the model is
    /// loaded or how far inference is; a line it does not recognize changes
    /// nothing.
    pub stderr_phase: fn(&str) -> Option<ModelPhase>,
}

/// Admit, spawn, wait (bounded by the timeout) and classify. A successful
/// return is a zero exit; its `Output` still carries stdout and stderr, because
/// a zero exit is not always the whole story (speech checks stderr for a device
/// the engine silently abandoned). `observer` hears what
/// [`ChildRun::stderr_phase`] reads while the child runs.
pub async fn run_child(
    mut run: ChildRun<'_>,
    observer: ModelObserver<'_>,
) -> Result<Output, SidecarFailure> {
    let _resources =
        crate::resources::interactive(crate::resources::model_memory_mib(&run.args, run.cwd))
            .await
            .map_err(|e| SidecarFailure::Io(std::io::Error::other(e)))?;
    (run.threads)(&mut run.args, crate::resources::task_threads());
    let child = Command::new(program_path(run.program).map_err(SidecarFailure::Io)?)
        .no_console_window() // Windows: no conhost flash under Electron.
        .kill_on_drop(true) // dropped future (timeout/cancel) reaps the child.
        .current_dir(run.cwd)
        .args(&run.args)
        .stdin(Stdio::null())
        .stdout(if run.capture_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| SidecarFailure::Spawn {
            program: run.program.display().to_string(),
            cause: e.to_string(),
        })?;

    // `output_watching_stderr` consumes the `Child` (it is moved into this
    // future). If `timeout` elapses, or the job is cancelled, tokio drops the
    // future → drops the owned `Child` → `kill_on_drop` kills the process. That
    // is why the `Err(_elapsed)` arm needs no explicit `.kill()`.
    let stderr_phase = run.stderr_phase;
    let watched = output_watching_stderr(child, |line| {
        if let Some(phase) = stderr_phase(line) {
            observer(phase);
        }
    });
    let output = match tokio::time::timeout(run.timeout, watched).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(SidecarFailure::Io(e)),
        Err(_elapsed) => {
            return Err(SidecarFailure::Timeout {
                secs: run.timeout.as_secs(),
            })
        }
    };
    exit_result(
        output.status.success(),
        output.status.code(),
        &output.stderr,
    )?;
    Ok(output)
}

/// Liveness probe for a local engine: spawn `<program> <args>` (typically
/// `--help`) and treat "the process started and finished within `timeout`" as
/// alive. The exit code is **ignored on purpose** — `--help` / `--version`
/// conventions differ across engines and builds, so this only distinguishes a
/// runnable binary from a bad path / wrong arch ([`SidecarFailure::Spawn`]) or
/// a wedged binary ([`SidecarFailure::Timeout`]).
pub async fn probe_liveness(
    program: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<(), SidecarFailure> {
    let child = Command::new(program)
        .no_console_window()
        .kill_on_drop(true)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| SidecarFailure::Spawn {
            program: program.display().to_string(),
            cause: e.to_string(),
        })?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(SidecarFailure::Io(e)),
        Err(_elapsed) => Err(SidecarFailure::Timeout {
            secs: timeout.as_secs(),
        }),
    }
}

/// Classify a finished child's status into success or [`SidecarFailure::Exit`].
/// Pure so the mapping is unit-testable without spawning a real engine.
fn exit_result(success: bool, code: Option<i32>, stderr: &[u8]) -> Result<(), SidecarFailure> {
    if success {
        Ok(())
    } else {
        Err(SidecarFailure::Exit {
            code,
            stderr: String::from_utf8_lossy(stderr).trim().to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_exit_is_success() {
        assert!(exit_result(true, Some(0), b"").is_ok());
    }

    #[test]
    fn nonzero_exit_carries_code_and_trimmed_stderr() {
        match exit_result(false, Some(3), b"  model load failed\n") {
            Err(SidecarFailure::Exit { code, stderr }) => {
                assert_eq!(code, Some(3));
                assert_eq!(stderr, "model load failed"); // trimmed
            }
            other => panic!("expected Exit, got {other:?}"),
        }
    }

    #[test]
    fn signal_kill_is_an_exit_with_no_code() {
        // A child killed by a signal reports `status.code() == None`.
        assert!(matches!(
            exit_result(false, None, b"killed"),
            Err(SidecarFailure::Exit { code: None, .. })
        ));
    }

    #[tokio::test]
    async fn a_missing_program_is_a_spawn_failure_naming_it() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("no-such-engine");
        match probe_liveness(&program, &[], Duration::from_secs(5)).await {
            Err(SidecarFailure::Spawn { program: p, .. }) => assert!(p.contains("no-such-engine")),
            other => panic!("expected Spawn, got {other:?}"),
        }
    }
}
