//! Shared one-shot CLI-sidecar transcription helper.
//!
//! Every *local* speech backend (whisper.cpp, FunASR via sherpa-onnx) has the
//! same shape: feed the `extract_audio_window` 16 kHz mono
//! WAV to a spawned CLI child, wait for it to finish, and read one transcript
//! body back — either off stdout or out of a sidecar file the engine wrote.
//! The child itself — admission, conhost suppression, `kill_on_drop`, the
//! timeout kill and the exit classification — is the one every local inference
//! engine shares ([`inference::sidecar`](crate::inference::sidecar), mapped to
//! [`SpeechError`] here). This module owns what both SPEECH engines share on
//! top of it: the thread-flag clamp, where the transcript body lands, the
//! device-fallback check and the hang guard scaled to the clip.
//!
//! A backend supplies only the binary, the built argument vector, where the
//! body lands ([`OutputSink`]), and which [`RawTranscript`] variant to tag it
//! as — both engines reuse [`SidecarRun`] and [`probe_liveness`] verbatim.
//!
//! Parsing/normalization is deliberately NOT here — the returned
//! [`RawTranscript`] is handed to [`parse_raw`](crate::speech::parse::parse_raw)
//! untouched, so ms/centisecond unit contracts stay owned by the parser layer.

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use crate::compute_jobs::{ModelObserver, ModelPhase};
use crate::inference::sidecar::{run_child, ChildRun};
use crate::speech::error::SpeechError;
use crate::speech::parse::{RawTranscript, TranscriptFormat};
use crate::speech::SpeechBackend;

/// An explicitly pinned NON-CPU device, plus the engine's own stderr markers
/// for "I could not use it and ran on the CPU instead".
///
/// Both bundled runtimes report that fallback and still **exit 0**:
/// `whisper-cli` prints `whisper_backend_init_gpu: no GPU found` for a
/// `--device N` it has no GPU for, and `sherpa-onnx-offline` prints
/// `... Fallback to cpu!` both for an unsupported `--provider` string and for a
/// valid one its build lacks (`Available providers: CPUExecutionProvider`).
/// Trusting the exit code alone therefore reports a pinned device that never
/// ran — and model verification would persist that claim. An explicit device is
/// strict (ADR 0064), so the fallback must surface as a failure the user can act
/// on, while `None` (automatic) keeps whatever the engine chose.
pub struct DevicePin {
    /// Attribution for the resulting [`SpeechError::Provider`].
    pub backend: SpeechBackend,
    /// The device string as the user wrote it, echoed back in the error.
    pub device: String,
    /// Case-insensitive substrings; the engine's wording, not ours.
    pub markers: &'static [&'static str],
}

/// Where a sidecar deposits its transcript body.
pub enum OutputSink {
    /// The engine prints the transcript to stdout; the helper captures it.
    Stdout,
    /// The engine writes a sidecar file at this exact path; the helper reads it
    /// back after a successful exit. whisper.cpp's `-of <prefix>` + `-ojf` /
    /// `-osrt` lands here (the format flag appends `.json` / `.srt`).
    File(PathBuf),
}

/// A fully-specified one-shot sidecar transcription run.
pub struct SidecarRun {
    /// The CLI binary to spawn (e.g. `whisper-cli`).
    pub program: PathBuf,
    /// Private workspace for ASCII relative input/output aliases.
    pub cwd: PathBuf,
    /// The complete, ordered argument vector.
    pub args: Vec<OsString>,
    /// Hang-guard: kill the child and error with [`SpeechError::Timeout`] if it
    /// runs longer than this. See [`scaled_timeout`].
    pub timeout: Duration,
    /// Where the transcript body will be read from.
    pub output: OutputSink,
    /// Which [`RawTranscript`] variant to tag the body as — must match what the
    /// engine's flags produce (whisper `-ojf` → [`TranscriptFormat::WhisperJson`]).
    pub format: TranscriptFormat,
    /// Set when the caller pinned an explicit non-CPU device; see [`DevicePin`].
    pub device_pin: Option<DevicePin>,
    /// Reads one stderr line for the engine's own word that the model is
    /// loaded or how far inference is. Engine-specific wording, so the backend
    /// supplies it; a line it does not recognize changes nothing.
    pub stderr_phase: fn(&str) -> Option<ModelPhase>,
}

impl SidecarRun {
    /// Spawn, wait (bounded by `timeout`), and return the tagged
    /// [`RawTranscript`]. Errors: [`SpeechError::Spawn`] if the child cannot
    /// start, [`SpeechError::Timeout`] if it overruns, [`SpeechError::EngineExit`]
    /// on a non-zero exit. `observer` hears what [`Self::stderr_phase`] reads
    /// while the child runs. The child itself is
    /// [`inference::sidecar::run_child`](crate::inference::sidecar::run_child)'s.
    pub async fn run(self, observer: ModelObserver<'_>) -> Result<RawTranscript, SpeechError> {
        let output = run_child(
            ChildRun {
                program: &self.program,
                cwd: &self.cwd,
                args: self.args,
                timeout: self.timeout,
                capture_stdout: matches!(self.output, OutputSink::Stdout),
                threads: |args, threads| clamp_threads(args, threads),
                stderr_phase: self.stderr_phase,
            },
            observer,
        )
        .await?;
        // A zero exit is not proof the pinned device ran — check before the
        // transcript is accepted, so a fallback cannot pass as a device success.
        if let Some(pin) = &self.device_pin {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some(report) = abandoned_device(&stderr, pin.markers) {
                return Err(SpeechError::Provider {
                    provider: pin.backend,
                    message: format!(
                        "device \"{}\" was not used — the runtime reported: {report}. \
                         Use a runtime built for this device, or select cpu/automatic.",
                        pin.device
                    ),
                });
            }
        }
        let body = read_body(&self.output, &output.stdout, &output.stderr).await?;
        Ok(wrap(self.format, body))
    }
}

/// Clamp the speech engines' thread flags (whisper.cpp `-t N`, sherpa-onnx
/// `--num-threads=N`) to the admitted allocation. Argument preparation can
/// precede an admission wait and a settings edit, so the shared runner applies
/// this against the admitted allocation immediately before spawn.
fn clamp_threads(args: &mut [OsString], threads: u32) {
    for index in 0..args.len() {
        if args[index] == "-t" && index + 1 < args.len() {
            let requested = args[index + 1]
                .to_string_lossy()
                .parse::<u32>()
                .unwrap_or(threads);
            args[index + 1] = requested.clamp(1, threads).to_string().into();
        } else if let Some(requested) = args[index].to_string_lossy().strip_prefix("--num-threads=")
        {
            let requested = requested.parse::<u32>().unwrap_or(threads);
            args[index] = format!("--num-threads={}", requested.clamp(1, threads)).into();
        }
    }
}

/// Liveness probe for a local speech engine: the shared
/// [`inference::sidecar::probe_liveness`](crate::inference::sidecar::probe_liveness)
/// with speech's errors. Used by `probe_backend`'s Settings "Test" button.
pub async fn probe_liveness(
    program: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<(), SpeechError> {
    Ok(crate::inference::sidecar::probe_liveness(program, args, timeout).await?)
}

/// The engine's own fallback line, if any marker appears in `stderr` — returned
/// verbatim (trimmed) so the error quotes the runtime rather than paraphrasing
/// it. Case-insensitive: the two runtimes differ in punctuation and casing, and
/// a build could change either. Pure, so the contract is testable without a GPU
/// (this box has none, which is exactly why the bug shipped).
fn abandoned_device(stderr: &str, markers: &[&str]) -> Option<String> {
    let haystack = stderr.to_lowercase();
    let hit = markers
        .iter()
        .find(|m| haystack.contains(&m.to_lowercase()))?;
    let needle = hit.to_lowercase();
    // Quote the whole reporting line: the marker alone omits the engine's reason
    // ("Available providers: …"), which is the actionable half.
    stderr
        .lines()
        .find(|line| line.to_lowercase().contains(&needle))
        .map(|line| line.trim().to_owned())
}

/// Read the transcript body from wherever the engine put it. For
/// [`OutputSink::File`] a missing file (engine exited OK but wrote nothing we
/// can find) surfaces as an `Io` error naming the path, rather than a bare
/// "file not found".
async fn read_body(
    output: &OutputSink,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<String, SpeechError> {
    match output {
        OutputSink::Stdout => Ok(String::from_utf8_lossy(stdout).into_owned()),
        OutputSink::File(path) => tokio::fs::read_to_string(path).await.map_err(|e| {
            SpeechError::Io(std::io::Error::new(
                e.kind(),
                format!(
                    "engine exited successfully but cannot read output {}: {e}; engine stderr: {}",
                    path.display(),
                    String::from_utf8_lossy(stderr).trim()
                ),
            ))
        }),
    }
}

/// Tag a raw body with its declared style.
fn wrap(format: TranscriptFormat, body: String) -> RawTranscript {
    RawTranscript::tagged(format, body)
}

/// A generous hang-guard timeout scaled to the clip length — NOT the expected
/// runtime, a ceiling that kills a wedged child. 16 kHz mono `pcm_s16le` is
/// 32 KB/s (see [`audio_extract`](crate::speech::audio_extract)), so we recover
/// the clip's seconds from the WAV size and allow 10× realtime on top of a 60 s
/// floor: whisper.cpp on CPU with a large model runs near realtime, so 10× is
/// comfortable headroom and small models finish far inside it. Shared by every
/// local sidecar since they all consume the same WAV. A stat failure falls back
/// to the floor (never zero).
pub async fn scaled_timeout(wav_path: &Path) -> Duration {
    let bytes = tokio::fs::metadata(wav_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    scaled_timeout_from_bytes(bytes)
}

fn scaled_timeout_from_bytes(wav_bytes: u64) -> Duration {
    const BYTES_PER_SEC: u64 = 32_000; // 16 kHz * 1 ch * 2 bytes/sample
    const WAV_HEADER_BYTES: u64 = 44;
    const FLOOR_SECS: u64 = 60;
    const REALTIME_FACTOR: u64 = 10;
    let audio_secs = wav_bytes.saturating_sub(WAV_HEADER_BYTES) / BYTES_PER_SEC;
    Duration::from_secs(FLOOR_SECS + audio_secs.saturating_mul(REALTIME_FACTOR))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared child's failures keep speech's own variants (and therefore
    /// its wording): an exit is `EngineExit` with the code and trimmed stderr,
    /// a signal kill has no code, a hang is `Timeout`, a bad path is `Spawn`.
    #[test]
    fn child_failures_map_to_speech_errors() {
        use crate::inference::sidecar::SidecarFailure as F;
        match SpeechError::from(F::Exit {
            code: Some(3),
            stderr: "model load failed".into(),
        }) {
            SpeechError::EngineExit { code, stderr } => {
                assert_eq!(code, Some(3));
                assert_eq!(stderr, "model load failed");
            }
            other => panic!("expected EngineExit, got {other:?}"),
        }
        let signal = SpeechError::from(F::Exit {
            code: None,
            stderr: "killed".into(),
        });
        assert_eq!(
            signal.to_string(),
            "speech engine exited with a signal: killed"
        );
        assert!(matches!(
            SpeechError::from(F::Timeout { secs: 60 }),
            SpeechError::Timeout { secs: 60 }
        ));
        assert!(matches!(
            SpeechError::from(F::Spawn {
                program: "whisper-cli".into(),
                cause: "not found".into()
            }),
            SpeechError::Spawn { .. }
        ));
    }

    /// The two runtimes report an abandoned device pin at exit 0, so the stderr
    /// scan is the only thing standing between "ran on the CPU" and a persisted
    /// claim that a GPU was verified. Real captured lines from the pinned
    /// builds: whisper-cli 1.9.1 `--device 7` and sherpa-onnx 1.13.4
    /// `--provider=cuda` / `--provider=0`.
    #[test]
    fn engine_reported_cpu_fallback_is_detected_and_quoted_whole() {
        let whisper = "whisper_init_with_params_no_state: gpu_device = 7\n\
                       whisper_backend_init_gpu: no GPU found\n";
        assert_eq!(
            abandoned_device(whisper, &["no GPU found"]).as_deref(),
            Some("whisper_backend_init_gpu: no GPU found"),
        );
        // Case-insensitive, and the quoted line carries sherpa's reason.
        let sherpa = "session.cc:GetSessionOptionsImpl:324 Please compile with \
                      -DSHERPA_ONNX_ENABLE_GPU=ON. Available providers: \
                      CPUExecutionProvider, . Fallback to cpu!\n";
        let hit = abandoned_device(sherpa, &["fallback to cpu"]).expect("detected");
        assert!(
            hit.contains("Available providers"),
            "keeps the reason: {hit}"
        );
        assert!(abandoned_device(
            "Unsupported string: 0. Fallback to cpu",
            &["fallback to cpu"]
        )
        .is_some());
    }

    /// An automatic run prints its own device chatter; nothing here may trip on
    /// it, and a CPU pin legitimately reports "no GPU found" too — which is why
    /// only an explicit NON-cpu pin supplies markers at all.
    #[test]
    fn ordinary_engine_logs_are_not_a_fallback_report() {
        let ok = "whisper_backend_init_gpu: using CUDA backend\n\
                  ggml_cuda_init: found 1 CUDA devices\n";
        assert!(abandoned_device(ok, &["no GPU found"]).is_none());
        assert!(abandoned_device(ok, &["fallback to cpu"]).is_none());
        assert!(abandoned_device("", &["no GPU found"]).is_none());
        assert!(abandoned_device("no GPU found", &[]).is_none());
    }

    #[test]
    fn wrap_tags_body_by_format() {
        assert_eq!(
            wrap(TranscriptFormat::Srt, "body".into()),
            RawTranscript::Srt("body".into()),
        );
        assert_eq!(
            wrap(TranscriptFormat::WhisperJson, "{}".into()),
            RawTranscript::WhisperJson("{}".into()),
        );
        assert_eq!(
            wrap(TranscriptFormat::FunAsrJson, "{}".into()),
            RawTranscript::FunAsrJson("{}".into()),
        );
    }

    #[tokio::test]
    async fn read_body_stdout_returns_captured_bytes() {
        let body = read_body(&OutputSink::Stdout, b"hello stdout", &[])
            .await
            .expect("stdout body");
        assert_eq!(body, "hello stdout");
    }

    /// The whisper.cpp file-output path: an engine writes a `-ojf` sidecar file;
    /// we read it back verbatim, wrap it, and it parses to exact word times.
    /// Exercises read → wrap → `parse_raw` without spawning a real engine.
    #[tokio::test]
    async fn read_body_file_then_wrap_parses_exact_words() {
        use crate::speech::parse::parse_raw;
        use crate::speech::transcript::WordTiming;

        const OJF: &str = r#"{
            "result": { "language": "en" },
            "transcription": [
                { "offsets": { "from": 0, "to": 2000 }, "text": " Hi there",
                  "tokens": [
                    { "text": " Hi",    "offsets": { "from": 0,    "to": 900 } },
                    { "text": " there", "offsets": { "from": 900,  "to": 2000 } }
                  ] }
            ]
        }"#;
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.json");
        std::fs::write(&out, OJF).unwrap();

        let body = read_body(&OutputSink::File(out), &[], &[])
            .await
            .expect("read sidecar file");
        let raw = wrap(TranscriptFormat::WhisperJson, body);
        assert!(matches!(raw, RawTranscript::WhisperJson(_)));

        let t = parse_raw(raw).expect("parse");
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.segments[0].words.len(), 2);
        assert_eq!(t.segments[0].words[0].text, "Hi");
        assert_eq!(t.segments[0].words[0].t_end_us, 900_000); // 900 ms → µs
    }

    #[tokio::test]
    async fn read_body_missing_file_errors_with_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        let err = read_body(
            &OutputSink::File(missing.clone()),
            &[],
            b"failed to open output for writing",
        )
        .await
        .expect_err("missing file");
        let msg = format!("{err}");
        assert!(msg.contains("failed to open output for writing"));
        assert!(
            msg.contains("nope.json"),
            "error should name the path: {msg}"
        );
    }

    #[test]
    fn scaled_timeout_has_a_floor_and_scales_with_length() {
        // Empty/tiny WAV → floor only.
        assert_eq!(scaled_timeout_from_bytes(0).as_secs(), 60);
        assert_eq!(scaled_timeout_from_bytes(44).as_secs(), 60);
        // 10 s of audio = 44-byte header + 10 * 32_000 = 320_044 bytes →
        // 60 + 10*10 = 160 s.
        assert_eq!(scaled_timeout_from_bytes(44 + 320_000).as_secs(), 160);
        // Longer clip → strictly larger ceiling (monotonic).
        assert!(
            scaled_timeout_from_bytes(44 + 3_200_000) > scaled_timeout_from_bytes(44 + 320_000)
        );
    }
}
