//! `LlamaMtmdSidecar` — one-shot `llama-mtmd-cli` child, one spawn per clip.
//!
//! Ingests ALL of a clip's sampled frames in a single invocation (model-load
//! cost amortized over the clip) and returns the full description. Disposable-
//! child pattern, matching whisper.cpp; no long-lived server. Shared by BOTH
//! local backends: Qwen3-VL and MiniCPM-V feed the SAME input (frames + injected
//! `<t s>` text markers — spike-proven that MiniCPM-V needs no `temporal_ids`),
//! and differ only in which [`RawDescription`] style the output is tagged as.
//!
//! ## Command shape
//!
//! ```text
//! llama-mtmd-cli -m MODEL --mmproj MMPROJ --image "p1,p2,..." -p PROMPT \
//!   --temp 0.1 -n 768 -ngl 999 -c 8192 --repeat-penalty 1.15 --repeat-last-n 320
//! ```
//!
//! Every knob here is load-bearing and each one's why lives at its own site:
//! [`build_args`] for the `--image` and `--no-display-prompt` landmines, `CTX`
//! and `REPEAT_PENALTY` for the two decoding guards.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;

use crate::compute_jobs::{ignore_model_phase, ModelObserver, ModelPhase};
use crate::inference::sidecar::{run_child, ChildRun};
use crate::inference_files::InferenceFiles;

use super::describer::{
    describe_hang_guard, DescribeRequest, Focus, Language, SceneDescriber, Task, TimedFrame,
};
use super::error::VlmError;
use super::parser::RawDescription;

// ── Validated sampling/decoding knobs (spike.mjs) ───────────────────────────
const TEMP: &str = "0.1";
const N_PREDICT: &str = "768";
const NGL: &str = "999"; // offload all layers when the build has a GPU backend
                         // MUST cap: the default follows the model's ~256K native ctx and OOMs the KV
                         // cache even with free VRAM; 8192 fits the downscaled frames + generation.
const CTX: &str = "8192";
// At low temp the model degenerates into repeating the last segment until `-n`,
// truncating the JSON; the penalty curbs the loop (the parser salvages the rest).
const REPEAT_PENALTY: &str = "1.15";
const REPEAT_LAST_N: &str = "320";
/// MTMD default media marker; images substitute in order where it appears.
const MEDIA_MARKER: &str = "<__media__>";

/// Which raw output style this local model produces — decides the
/// [`RawDescription`] tag so the parser layer dispatches correctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStyle {
    /// Qwen3-VL: a clean JSON array with discrete keyword tags.
    Qwen3VlJson,
    /// MiniCPM-V: JSON array with underscore-joined tags + a trailing empty
    /// segment (needs the splitting parser).
    MiniCpmVText,
}

/// One-shot local video-understanding sidecar. Fields come from the backend's
/// [`BackendConfig::Local`](super::config::BackendConfig::Local) entry.
pub struct LlamaMtmdSidecar {
    binary: PathBuf,
    model: PathBuf,
    mmproj: PathBuf,
    /// None = automatic, cpu = no offload, otherwise an exact llama device name.
    device: Option<String>,
    style: OutputStyle,
}

impl LlamaMtmdSidecar {
    pub fn new(
        binary: PathBuf,
        model: PathBuf,
        mmproj: PathBuf,
        device: Option<String>,
        style: OutputStyle,
    ) -> Self {
        Self {
            binary,
            model,
            mmproj,
            device,
            style,
        }
    }
}

#[async_trait]
impl SceneDescriber for LlamaMtmdSidecar {
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError> {
        self.describe_observed(req, &ignore_model_phase).await
    }

    async fn describe_observed(
        &self,
        req: DescribeRequest,
        observer: ModelObserver<'_>,
    ) -> Result<RawDescription, VlmError> {
        self.describe_verified(req, observer)
            .await
            .map(|(raw, _)| raw)
    }
}

impl LlamaMtmdSidecar {
    pub(crate) async fn describe_verified(
        &self,
        req: DescribeRequest,
        observer: ModelObserver<'_>,
    ) -> Result<(RawDescription, bool), VlmError> {
        let prompt = prompt_for(&req.frames, req.focus, &req.language, &req.task);
        let files = InferenceFiles::new()?;
        let mut frames = Vec::with_capacity(req.frames.len());
        for (i, frame) in req.frames.iter().enumerate() {
            // Keep the source's extension: the frames are JPEG now, and an
            // alias named `.png` would be a lie to anything that trusts it.
            let ext = frame
                .path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("png");
            frames.push(TimedFrame {
                t_us: frame.t_us,
                path: files
                    .input(&frame.path, &format!("frame-{i}.{ext}"))
                    .await?,
            });
        }
        // llama supports Unicode weights. Resolve relative config paths before
        // changing cwd, preserving split GGUFs and adjacent auxiliary files.
        let mut args = build_args(
            &std::path::absolute(&self.model)?,
            &std::path::absolute(&self.mmproj)?,
            &frames,
            &prompt,
        );
        apply_device(&mut args, self.device.as_deref());
        let timeout = describe_hang_guard(req.frames.len());
        let mut cpu = self.device.as_deref() == Some("cpu");
        let body = match run(&self.binary, &args, files.cwd(), timeout, observer).await {
            Ok(body) => body,
            Err(e) if self.device.is_none() && device_failure(&e) => {
                apply_device(&mut args, Some("cpu"));
                cpu = true;
                run(&self.binary, &args, files.cwd(), timeout, observer).await?
            }
            Err(e) => return Err(e),
        };
        Ok((
            match self.style {
                OutputStyle::Qwen3VlJson => RawDescription::JsonArray(body),
                OutputStyle::MiniCpmVText => RawDescription::MiniCpmVText(body),
            },
            cpu,
        ))
    }
}

fn device_failure(e: &VlmError) -> bool {
    match e {
        VlmError::EngineExit { stderr, .. } => {
            let s = stderr.to_lowercase();
            [
                "out of memory",
                "failed to allocate",
                "allocation failed",
                "vulkan error",
                "cuda error",
                "no device",
            ]
            .iter()
            .any(|text| s.contains(text))
        }
        _ => false,
    }
}

/// Verified against llama.cpp b10103 common/arg.cpp; CPU disables BOTH offloads.
fn apply_device(args: &mut Vec<OsString>, device: Option<&str>) {
    match device {
        Some("cpu") => {
            if let Some(i) = args.iter().position(|x| x == "-ngl") {
                args[i + 1] = "0".into();
            }
            args.extend([
                "--device".into(),
                "none".into(),
                "--no-mmproj-offload".into(),
            ]);
        }
        Some(name) => args.extend(["--device".into(), name.into()]),
        None => {}
    }
}

/// Build the timestamp-annotated multi-image prompt: interleaved `Frame at <t>s:`
/// text + one `<__media__>` marker per frame (images substitute in order), then
/// the JSON-array output instruction. `focus` biases what populates `tags`.
/// Mirrors `spike.mjs:buildPrompt` (validated on Qwen3-VL AND MiniCPM-V).
///
/// The INSTRUCTIONS stay English whatever `language` is: it names the language of
/// the answer, not of the asking. Both engines follow an English instruction more
/// reliably than a translated one, and the JSON keys must not move — so the
/// language rule is one line at the end, applying to the two free-text fields.
///
/// It is emitted unconditionally, English included. A default run's prompt is
/// then the same shape as every other run's, and a clip full of Chinese signage
/// cannot talk the model out of the language it was asked for. On-screen text is
/// the one thing kept in its own language — quoted inside a sentence in the
/// asked-for one, because a model shown a title card otherwise answered with the
/// card's words alone (ADR 0149).
pub fn build_prompt(frames: &[TimedFrame], focus: Focus, language: &Language) -> String {
    let mut lines = vec![
        "You are analyzing frames sampled from a single video clip.".to_string(),
        "Each frame below is labeled with its exact timestamp in seconds.".to_string(),
        "Describe what is happening across the clip as a timeline.".to_string(),
        String::new(),
    ];
    for f in frames {
        lines.push(format!("Frame at {:.2}s:", f.t_us as f64 / 1_000_000.0));
        lines.push(MEDIA_MARKER.to_string());
        lines.push(String::new());
    }
    lines.push("Return ONLY a JSON array, no prose. Each element:".to_string());
    lines.push(
        r#"{"t_start": <seconds>, "t_end": <seconds>, "text": "<what happens>", "tags": ["<keyword>", ...]}"#
            .to_string(),
    );
    lines.push("Rules:".to_string());
    lines.push(
        "- t_start and t_end MUST be chosen from the frame timestamps listed above.".to_string(),
    );
    lines.push(
        "- Merge adjacent frames that show the same action/scene into one segment.".to_string(),
    );
    lines.push(match focus {
        Focus::General => {
            "- tags: short visual keywords (subjects, setting, camera motion, shot type)."
        }
        Focus::ShotType => {
            "- tags: emphasize shot type and camera (e.g. close-up, wide, low-angle, pan, static, handheld)."
        }
    }.to_string());
    lines.push(format!(
        "- Write every \"text\" value and every tag in {lang}. Use no other language for them, except on-screen text (titles, signs, captions): quote it verbatim in its original language inside a description written in {lang}, never as the whole \"text\". The JSON keys stay in English.",
        lang = language.prompt_name(),
    ));
    lines.join("\n")
}

/// The prompt `task` asks of `frames`: [`build_prompt`]'s timeline or
/// [`build_summary_prompt`]'s summary.
pub fn prompt_for(frames: &[TimedFrame], focus: Focus, language: &Language, task: &Task) -> String {
    match task {
        Task::Timeline => build_prompt(frames, focus, language),
        Task::Summary { outline } => build_summary_prompt(frames, outline, language),
    }
}

/// Where a summary prompt's instruction tail starts — the outline and the
/// output rules, which the endpoint sends after its image parts.
pub const SUMMARY_TAIL: &str = "A detailed pass already described";

/// The summary prompt: frames sampled evenly across the whole window, the run's
/// own timeline as an outline, and a request for two to four sentences as one
/// JSON string. JSON rather than bare prose so a chatty preamble or an echoed
/// prompt cannot pass for the answer (`parser::parse_summary`); the template is
/// deliberately not valid JSON, so an echo of it never parses as one either.
/// English instructions, the answer's language named once — as in
/// [`build_prompt`].
pub fn build_summary_prompt(frames: &[TimedFrame], outline: &str, language: &Language) -> String {
    let mut lines = vec![
        "You are analyzing frames sampled evenly across a single video clip.".to_string(),
        "Each frame below is labeled with its exact timestamp in seconds.".to_string(),
        String::new(),
    ];
    for f in frames {
        lines.push(format!("Frame at {:.2}s:", f.t_us as f64 / 1_000_000.0));
        lines.push(MEDIA_MARKER.to_string());
        lines.push(String::new());
    }
    lines.push(format!(
        "{SUMMARY_TAIL} the clip as this timeline (seconds from the clip's start):"
    ));
    lines.push(outline.to_string());
    lines.push(String::new());
    lines.push("Return ONLY a JSON object, no other prose:".to_string());
    lines.push(r#"{"summary": <two to four sentences, as one JSON string>}"#.to_string());
    lines.push("Rules:".to_string());
    lines.push(
        "- Summarize the whole clip: what it is about, how it unfolds, where it takes place. Do not list every shot."
            .to_string(),
    );
    lines.push("- Keep to what the frames and the timeline show; add nothing else.".to_string());
    lines.push(format!(
        "- Write the summary in {}. Use no other language, whatever language appears in the frames or the timeline. The JSON key stays in English.",
        language.prompt_name(),
    ));
    lines.join("\n")
}

/// Build the `llama-mtmd-cli` argument vector. Free function (paths borrowed) so
/// the CLI contract — comma-joined `--image`, the capped `-c`, the repeat
/// penalty — is unit-testable without a running binary (the only automated pin
/// on this contract; the end-to-end run needs a GPU + a multi-GB model).
///
/// Landmine: never add `--no-display-prompt` — it is an invalid arg in this
/// build and the child fails; the parser strips the prompt echo instead.
pub fn build_args(
    model: &Path,
    mmproj: &Path,
    frames: &[TimedFrame],
    prompt: &str,
) -> Vec<OsString> {
    // Landmine: ONE comma-separated --image value; repeated --image keeps only
    // the last. InferenceFiles supplies relative ASCII aliases: even a comma
    // in TEMP or a username must never become a separator here.
    let mut image = OsString::new();
    for (i, f) in frames.iter().enumerate() {
        if i > 0 {
            image.push(",");
        }
        image.push(f.path.as_os_str());
    }

    vec![
        "-m".into(),
        model.as_os_str().to_owned(),
        "--mmproj".into(),
        mmproj.as_os_str().to_owned(),
        "--image".into(),
        image,
        "-p".into(),
        prompt.into(),
        "--temp".into(),
        TEMP.into(),
        "-n".into(),
        N_PREDICT.into(),
        "-ngl".into(),
        NGL.into(),
        "-c".into(),
        CTX.into(),
        "--repeat-penalty".into(),
        REPEAT_PENALTY.into(),
        "--repeat-last-n".into(),
        REPEAT_LAST_N.into(),
    ]
}

/// Spawn the one-shot child, wait (bounded by `timeout`), capture stdout as the
/// raw body. The child — admission, conhost guard, `kill_on_drop` (a timed-out
/// or cancelled future drops the child → reaped), exit classification — is the
/// one every local engine shares
/// ([`inference::sidecar`](crate::inference::sidecar)), mapped to [`VlmError`].
/// `observer` hears the load, then [`stderr_phase`]'s reading of the child's
/// log; a CPU retry loads again.
async fn run(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    timeout: Duration,
    observer: ModelObserver<'_>,
) -> Result<String, VlmError> {
    observer(ModelPhase::LoadingModel);
    let output = run_child(
        ChildRun {
            program,
            cwd,
            args: args.to_vec(),
            timeout,
            capture_stdout: true,
            threads: append_threads,
            stderr_phase,
        },
        observer,
    )
    .await?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// llama-mtmd-cli takes the admitted allocation as two appended flags: the
/// arguments [`build_args`] produces never carry a thread count of their own.
fn append_threads(args: &mut Vec<OsString>, threads: u32) {
    let threads = threads.to_string();
    args.extend(
        ["--threads", &threads, "--threads-batch", &threads]
            .into_iter()
            .map(OsString::from),
    );
}

/// llama-mtmd-cli's stderr, read for the job phase. The multimodal helper logs
/// `encoding image slice...` once both the model and the projector are loaded
/// and the frames go in; from there the run is inference. Image slices are
/// not frames (MiniCPM-V splits one image into several), so no count is read.
fn stderr_phase(line: &str) -> Option<ModelPhase> {
    line.contains("encoding image")
        .then_some(ModelPhase::INFERRING)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_reports_inference_once_images_are_encoded() {
        assert_eq!(stderr_phase("load_tensors: offloading 36 layers"), None);
        assert_eq!(
            stderr_phase("encoding image slice..."),
            Some(ModelPhase::INFERRING)
        );
    }

    #[test]
    fn cpu_disables_model_and_projector_offload_without_changing_weights() {
        let mut args = build_args(
            Path::new("model.gguf"),
            Path::new("vision.gguf"),
            &[],
            "test",
        );
        apply_device(&mut args, Some("cpu"));
        let values = as_strings(&args);
        assert!(values.windows(2).any(|p| p == ["-ngl", "0"]));
        assert!(values.windows(2).any(|p| p == ["--device", "none"]));
        assert!(values.contains(&"--no-mmproj-offload".to_string()));
        assert!(values.windows(2).any(|p| p == ["-m", "model.gguf"]));
        assert!(values.windows(2).any(|p| p == ["--mmproj", "vision.gguf"]));
    }

    #[test]
    fn only_device_resource_failures_are_eligible_for_cpu_retry() {
        assert!(device_failure(&VlmError::EngineExit {
            code: Some(1),
            stderr: "failed to allocate Vulkan buffer".into()
        }));
        assert!(!device_failure(&VlmError::EngineExit {
            code: Some(1),
            stderr: "invalid model format".into()
        }));
        assert!(!device_failure(&VlmError::Timeout { secs: 30 }));
    }

    fn frame(t_us: i64, name: &str) -> TimedFrame {
        TimedFrame {
            t_us,
            path: PathBuf::from(name),
        }
    }

    fn as_strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }
    fn after(args: &[String], flag: &str) -> String {
        let i = args.iter().position(|a| a == flag).expect("flag present");
        args[i + 1].clone()
    }

    #[test]
    fn images_are_one_comma_separated_arg() {
        let frames = vec![
            frame(0, "a.png"),
            frame(1_000_000, "b.png"),
            frame(2_000_000, "c.png"),
        ];
        let args = build_args(Path::new("/m.gguf"), Path::new("/mm.gguf"), &frames, "P");
        let s = as_strings(&args);
        // Exactly one --image flag, value is the comma-joined list.
        assert_eq!(s.iter().filter(|a| *a == "--image").count(), 1);
        assert_eq!(after(&s, "--image"), "a.png,b.png,c.png");
    }

    #[test]
    fn encodes_every_spike_landmine() {
        let frames = vec![frame(0, "a.png")];
        let s = as_strings(&build_args(
            Path::new("/m.gguf"),
            Path::new("/mm.gguf"),
            &frames,
            "P",
        ));
        assert_eq!(after(&s, "-m"), "/m.gguf");
        assert_eq!(after(&s, "--mmproj"), "/mm.gguf");
        assert_eq!(after(&s, "-c"), "8192"); // capped context (KV-OOM guard)
        assert_eq!(after(&s, "--temp"), "0.1");
        assert_eq!(after(&s, "-n"), "768");
        assert_eq!(after(&s, "--repeat-penalty"), "1.15");
        assert_eq!(after(&s, "--repeat-last-n"), "320");
        // No --no-display-prompt (invalid in this build).
        assert!(!s.iter().any(|a| a == "--no-display-prompt"));
    }

    #[test]
    fn prompt_interleaves_one_marker_per_frame_with_timestamps() {
        let frames = vec![frame(0, "a.png"), frame(2_500_000, "b.png")];
        let p = build_prompt(&frames, Focus::General, &Language::default());
        assert_eq!(p.matches(MEDIA_MARKER).count(), 2);
        assert!(p.contains("Frame at 0.00s:"));
        assert!(p.contains("Frame at 2.50s:"));
        assert!(p.contains("Return ONLY a JSON array"));
    }

    #[test]
    fn shot_type_focus_changes_the_tag_instruction() {
        let frames = vec![frame(0, "a.png")];
        let general = build_prompt(&frames, Focus::General, &Language::default());
        let shot = build_prompt(&frames, Focus::ShotType, &Language::default());
        assert!(general.contains("subjects, setting"));
        assert!(shot.contains("shot type and camera"));
    }

    #[test]
    fn prompt_names_the_output_language_and_keeps_the_instructions_english() {
        let frames = vec![frame(0, "a.png")];
        let zh = build_prompt(&frames, Focus::General, &Language::parse(Some("zh-CN")));
        // The language is named the way a model understands it, not as a tag.
        assert!(zh.contains("in Simplified Chinese"));
        assert!(!zh.contains("zh-CN"));
        // On-screen text is quoted as it appears, inside a description in the
        // asked-for language — never handed back as the description itself.
        assert!(zh.contains("quote it verbatim in its original language inside a description written in Simplified Chinese"));
        // …and the surrounding contract is untouched: same JSON shape, same
        // timestamp rule, so a translated answer still parses.
        assert!(zh.contains("Return ONLY a JSON array"));
        assert!(zh.contains("t_start and t_end MUST be chosen"));
        // Emitted for English too — one prompt shape for every run.
        let en = build_prompt(&frames, Focus::General, &Language::default());
        assert!(en.contains("in English"));
        assert_ne!(en, zh);
    }

    #[test]
    fn the_summary_prompt_carries_frames_outline_and_language() {
        let frames = vec![frame(0, "a.jpg"), frame(30_000_000, "b.jpg")];
        let task = Task::Summary {
            outline: "[0.0–12.0s] a title card".into(),
        };
        let p = prompt_for(
            &frames,
            Focus::General,
            &Language::parse(Some("zh-CN")),
            &task,
        );
        assert_eq!(p.matches(MEDIA_MARKER).count(), 2);
        assert!(p.contains("Frame at 30.00s:"));
        assert!(p.contains("[0.0–12.0s] a title card"));
        assert!(p.contains("Return ONLY a JSON object"));
        assert!(p.contains("in Simplified Chinese"));
        // Its own template never parses as an answer.
        let template = p.lines().find(|l| l.starts_with(r#"{"summary""#)).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(template).is_err());
        // Everything an endpoint sends after the images starts at the outline.
        let tail = &p[p.find(SUMMARY_TAIL).unwrap()..];
        assert!(tail.contains("a title card") && tail.contains("Simplified Chinese"));
        assert!(!tail.contains(MEDIA_MARKER));
        // The timeline task is the prompt it always was.
        assert_eq!(
            prompt_for(
                &frames,
                Focus::General,
                &Language::default(),
                &Task::Timeline
            ),
            build_prompt(&frames, Focus::General, &Language::default())
        );
    }

    #[test]
    fn language_rule_is_inside_the_shared_trailing_instruction() {
        // The BYO/cloud path reuses everything from "Return ONLY a JSON array"
        // onward (`endpoint::trailing_instruction`), so the language line has to
        // sit after that landmark or the networked engines would silently keep
        // answering in English.
        let frames = vec![frame(0, "a.png")];
        let p = build_prompt(&frames, Focus::General, &Language::parse(Some("ja")));
        let anchor = p.find("Return ONLY a JSON array").expect("anchor");
        assert!(p.find("in Japanese").expect("language line") > anchor);
    }

    /// Opt-in LIVE smoke of the whole local path — frame extraction → the exact
    /// `llama-mtmd-cli` command → stdout capture → parser. `#[ignore]` by default
    /// (needs a GPU-class machine + a multi-GB GGUF), same stance as the
    /// real-ffmpeg smokes. Set the four `WEFTCUT_VLM_*` env vars and run:
    /// `cargo test --features test-noop -- --ignored --nocapture live_qwen_describe`.
    #[tokio::test]
    #[ignore = "live: needs llama-mtmd-cli + Qwen GGUF + mmproj + a video (WEFTCUT_VLM_* env)"]
    async fn live_qwen_describe() {
        use super::super::describer::{DescribeRequest, Focus, Language};
        use super::super::frame_extract::{plan_anchors, sample_frames};
        use super::super::parser::parse_raw;

        let (Ok(cli), Ok(model), Ok(mmproj), Ok(video)) = (
            std::env::var("WEFTCUT_VLM_CLI"),
            std::env::var("WEFTCUT_VLM_MODEL"),
            std::env::var("WEFTCUT_VLM_MMPROJ"),
            std::env::var("WEFTCUT_VLM_VIDEO"),
        ) else {
            eprintln!("live_qwen_describe skipped — set WEFTCUT_VLM_CLI/MODEL/MMPROJ/VIDEO");
            return;
        };

        let tmp = tempfile::tempdir().unwrap();
        // Sample the first 8 seconds at 1 fps (window-relative anchors).
        let anchors = plan_anchors(0, 8_000_000, 1.0);
        let frames = sample_frames(
            std::path::Path::new(&video),
            0,
            tmp.path(),
            &anchors,
            |_| {},
            |_| {},
        )
        .await
        .expect("frame sampling");
        eprintln!("live_qwen_describe: extracted {} frames", frames.len());

        let sidecar = LlamaMtmdSidecar::new(
            cli.into(),
            model.into(),
            mmproj.into(),
            None,
            OutputStyle::Qwen3VlJson,
        );
        let raw = sidecar
            .describe(DescribeRequest {
                frames,
                focus: Focus::General,
                // Overridable from the env so the live smoke can eyeball a
                // non-English answer, which is the only way this path's language
                // rule is ever actually observed.
                language: Language::parse(std::env::var("WEFTCUT_VLM_LANGUAGE").ok().as_deref()),
                task: Task::Timeline,
            })
            .await
            .expect("describe");
        let segs = parse_raw(raw).expect("parse");
        eprintln!("live_qwen_describe: {} segments", segs.len());
        for s in &segs {
            eprintln!(
                "  [{:.2}s..{:.2}s] {}  tags={:?}",
                s.t_start_us as f64 / 1e6,
                s.t_end_us as f64 / 1e6,
                s.text,
                s.tags
            );
        }
        assert!(!segs.is_empty(), "expected at least one described segment");
    }
}
