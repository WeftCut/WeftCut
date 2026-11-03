//! A complete description run: cache identity, sampling, resumable chunks and
//! optional summary. No MCP types or serialized tool arguments cross this seam.
#[cfg(test)]
mod tests;
use super::{
    self as vlm,
    describer::{SceneDescriber, TimedFrame},
    description::DescSegment,
    BackendConfig, VlmBackend, VlmError,
};
use crate::{
    cache::CacheLayout,
    compute_jobs::{ComputePhase, JobReporter},
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, Weak},
};

#[derive(Debug, thiserror::Error)]
pub enum DescriptionError {
    #[error("{0}")]
    InvalidArgument(String),
    #[error(transparent)]
    Engine(#[from] VlmError),
    #[error("{0}")]
    Operation(String),
}

/// The caller resolves a layer to a source window; the runner owns the rest.
pub struct DescriptionRequest {
    pub source: PathBuf,
    pub source_hash: String,
    pub window: [i64; 2],
    pub fps: f64,
    pub focus: vlm::Focus,
    pub language: vlm::Language,
    pub purpose: vlm::DescriptionPurpose,
    pub refresh: bool,
}

pub struct DescriptionRunner {
    cache: CacheLayout,
    backend: VlmBackend,
    model: String,
    model_identity: String,
    frames_per_request: usize,
    concurrency: usize,
    describer: Arc<dyn SceneDescriber>,
    sampler: Arc<dyn FrameSampler>,
}

impl DescriptionRunner {
    pub fn new(
        cache: &CacheLayout,
        backend: VlmBackend,
        config: Option<&BackendConfig>,
        describer: Box<dyn SceneDescriber>,
    ) -> Self {
        let (frames_per_request, concurrency) = vlm::config::request_shape(config);
        Self {
            cache: cache.snapshot(),
            backend,
            model: vlm::model_label(backend, config),
            model_identity: vlm::resolve::cache_model_identity(backend, config),
            frames_per_request,
            concurrency,
            describer: Arc::from(describer),
            sampler: Arc::new(VideoFrames),
        }
    }

    /// Dropping this future cancels outstanding work. Completed chunks remain
    /// persisted; a failed summary can be retried without describing them again.
    pub async fn describe(
        &self,
        request: DescriptionRequest,
        job: &JobReporter,
    ) -> Result<vlm::SceneDescription, DescriptionError> {
        let fps = request.fps;
        if !(fps.is_finite() && fps > 0.0 && fps <= 30.0) {
            return Err(DescriptionError::InvalidArgument(format!(
                "fps {fps} must be in (0.0, 30.0]"
            )));
        }
        let focus = request.focus;
        // Unknown tags are passed to the model as themselves rather than refused:
        // the BYO endpoint may serve a model that knows a language this build has
        // no name for, and a refusal here would be this layer overruling it.
        let language = request.language;
        let fps_milli = vlm::fps_milli(fps);

        let key = vlm::cache_key(
            &request.source_hash,
            self.backend,
            &self.model_identity,
            fps_milli,
            focus,
            &language,
            request.purpose,
        );
        let file = DescriptionFile::new(self.cache.description(&key));

        // Load the prior runs; a window already covered is answered with NO engine
        // spawn unless the caller asked for a fresh run. A refresh forgets the
        // window's run here and on disk with its first finished chunk, so a call
        // that fails before one keeps the old run.
        let mut cache = file.read().await;
        let window = request.window;
        if request.refresh {
            cache.discard(window);
        }

        let (frames_per_request, concurrency) = (self.frames_per_request, self.concurrency);
        let describer = self.describer.clone();
        // A clip's window gets a summary once its run is whole — when it is longer
        // than one request's frames, i.e. when its timeline is long enough to need
        // one. A shot, and a short clip, are read in full: one more engine run
        // (a model load, locally) would only restate them.
        let frames_in_window = (window[1] - window[0]) as f64 / 1_000_000.0 * fps;
        let summarize = matches!(request.purpose, vlm::DescriptionPurpose::Clip)
            && frames_in_window.round() as usize > frames_per_request;
        // `(done, total)` steps the summary reports as: after the chunks when they
        // run, alone when the chunks are already cached.
        let mut summary_step = (0, 1);
        if request.refresh || !cache.covers(window[0], window[1]) {
            // Every chunk at the requested fps; a window too long for one call is
            // refused here, before any frame is sampled.
            let chunks =
                vlm::frame_extract::plan_chunks(window[0], window[1], fps, frames_per_request)
                    .map_err(DescriptionError::InvalidArgument)?;
            let total = chunks.len() as u32;
            summary_step = (total, total + 1);
            let run = describe_chunks(
                job,
                &file,
                &mut cache,
                ChunkedDescribe {
                    window,
                    sampler: self.sampler.clone(),
                    chunks,
                    describer: describer.clone(),
                    concurrency,
                    source: request.source.clone(),
                    focus,
                    language: language.clone(),
                    extra_steps: u32::from(summarize),
                    refresh: request.refresh,
                },
            );
            run.await?;
        }
        let summary = if summarize {
            summarize_run(
                job,
                &file,
                &mut cache,
                SummaryWork {
                    window,
                    sampler: self.sampler.clone(),
                    describer,
                    frames: frames_per_request.min(SUMMARY_FRAMES),
                    fps,
                    source: request.source.clone(),
                    focus,
                    language,
                    step: summary_step,
                },
            )
            .await?
        } else {
            None
        };

        let result = vlm::SceneDescription {
            backend: self.backend.as_str().to_string(),
            model: self.model.clone(),
            summary,
            segments: cache.segments_in(window[0], window[1]),
        };
        Ok(result)
    }
}

// Internal seam: production samples the video, module tests supply timed frames
// without needing ffmpeg, a model install or the MCP transport.
#[async_trait::async_trait]
trait FrameSampler: Send + Sync {
    async fn sample(
        &self,
        source: &Path,
        start: i64,
        dest: &Path,
        anchors: &[i64],
        progress: Option<(&JobReporter, u32, u32)>,
    ) -> Result<Vec<TimedFrame>, VlmError>;
}
struct VideoFrames;
#[async_trait::async_trait]
impl FrameSampler for VideoFrames {
    async fn sample(
        &self,
        source: &Path,
        start: i64,
        dest: &Path,
        anchors: &[i64],
        progress: Option<(&JobReporter, u32, u32)>,
    ) -> Result<Vec<TimedFrame>, VlmError> {
        vlm::frame_extract::sample_frames(
            source,
            start,
            dest,
            anchors,
            |block| {
                if let Some((job, offset, total)) = progress {
                    job.admission(ComputePhase::Extracting {
                        done: offset,
                        total,
                    })(block);
                }
            },
            |done| {
                if let Some((job, offset, total)) = progress {
                    job.phase(ComputePhase::Extracting {
                        done: offset + done as u32,
                        total,
                    });
                }
            },
        )
        .await
    }
}

/// One description file, shared by every call over the same source and view.
/// A write re-reads the file and applies only this call's change, under a
/// process-wide lock per file: two calls over different windows each persist
/// their own run, where writing back a copy read at the start would drop the
/// other's.
struct DescriptionFile {
    dest: PathBuf,
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl DescriptionFile {
    fn new(dest: PathBuf) -> Self {
        let lock = file_lock(&dest);
        Self { dest, lock }
    }

    /// The runs the file holds; a missing or unreadable file holds none.
    async fn read(&self) -> vlm::DescriptionCache {
        match tokio::fs::read(&self.dest).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => vlm::DescriptionCache::default(),
        }
    }

    /// Apply `change` to what the file holds now and persist it, so a cancel
    /// or a later failure keeps it. Answers the runs as written, other calls'
    /// included.
    async fn update(
        &self,
        change: impl FnOnce(&mut vlm::DescriptionCache),
    ) -> Result<vlm::DescriptionCache, DescriptionError> {
        let _held = self.lock.lock().await;
        let mut cache = self.read().await;
        change(&mut cache);
        write_description_atomic(&self.dest, &cache)
            .await
            .map_err(|e| DescriptionError::Operation(format!("persist description: {e:#}")))?;
        Ok(cache)
    }
}

/// The lock for one description file, alive while any call holds it.
fn file_lock(dest: &Path) -> Arc<tokio::sync::Mutex<()>> {
    type Locks = std::sync::Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>;
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(dest).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(dest.to_path_buf(), Arc::downgrade(&lock));
    lock
}

/// Persist a `DescriptionCache` JSON atomically (temp → promote), mirroring
/// `write_voiceover_atomic`.
async fn write_description_atomic(
    dest: &Path,
    cache: &vlm::DescriptionCache,
) -> Result<(), anyhow::Error> {
    use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path};
    use anyhow::Context;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(cache).context("serialize description cache")?;
    let tmp = temp_path(dest);
    let _ = tokio::fs::remove_file(&tmp).await;
    tokio::fs::write(&tmp, &body)
        .await
        .with_context(|| format!("write {}", tmp.display()))?;
    if !cached_ok(&tmp) {
        discard_temp(dest);
        anyhow::bail!("description cache is empty after write");
    }
    promote_temp(dest)?;
    Ok(())
}

/// Most frames a summary request carries. Fewer than a chunk's: the outline
/// rides in the same context, and the local engine's is capped at 8192 tokens.
const SUMMARY_FRAMES: usize = 8;

/// Most characters of outline a summary prompt carries. A longer timeline keeps
/// every k-th line, so the whole window is still represented.
const SUMMARY_OUTLINE_CHARS: usize = 3000;

/// What a window's summary request needs, and the progress step it reports as.
struct SummaryWork {
    window: [i64; 2],
    sampler: Arc<dyn FrameSampler>,
    describer: Arc<dyn SceneDescriber>,
    frames: usize,
    fps: f64,
    source: PathBuf,
    focus: vlm::Focus,
    language: vlm::Language,
    step: (u32, u32),
}

/// The summary of the run over exactly `work.window`: the stored one, or — when
/// that run is whole and has none (just finished, an older file, or a summary
/// that failed last time) — one more request over frames sampled evenly across
/// the window plus the run's own tidied timeline, persisted on the run.
///
/// A summary that cannot be had is not the call's failure: the segments stand
/// on their own, so it is logged and the answer goes without one. A cancel
/// still cancels (the future is dropped). No run over exactly this window (a
/// sub-window answered from a wider one) has no summary of its own.
async fn summarize_run(
    job: &JobReporter,
    file: &DescriptionFile,
    cache: &mut vlm::DescriptionCache,
    work: SummaryWork,
) -> Result<Option<String>, DescriptionError> {
    use crate::compute_jobs::ModelPhase;

    let Some(run) = cache.runs.iter().find(|r| r.window == work.window) else {
        return Ok(None);
    };
    if let Some(summary) = &run.summary {
        return Ok(Some(summary.clone()));
    }
    let tidied = run.tidied();
    if !run.is_complete() || tidied.is_empty() {
        return Ok(None);
    }
    let outline = summary_outline(&tidied, work.window[0]);
    let (done, total) = work.step;
    let attempt = async {
        let tmp = chunk_dir()?;
        // Evenly across the whole window, at most `frames` of them.
        let anchors = vlm::frame_extract::plan_anchors_capped(
            work.window[0],
            work.window[1],
            work.fps,
            work.frames,
        );
        let frames = work
            .sampler
            .sample(
                &work.source,
                work.window[0],
                tmp.path(),
                &anchors,
                Some((job, 0, anchors.len() as u32)),
            )
            .await?;
        let raw = work
            .describer
            .describe_observed(
                vlm::DescribeRequest {
                    frames,
                    focus: work.focus,
                    language: work.language.clone(),
                    task: vlm::Task::Summary { outline },
                },
                &|phase| {
                    job.model(match phase {
                        ModelPhase::Inferring { .. } => ModelPhase::Inferring {
                            done: Some(done),
                            total: Some(total),
                        },
                        other => other,
                    })
                },
            )
            .await?;
        vlm::parse_summary(raw).map_err(DescriptionError::Engine)
    };
    match attempt.await {
        Ok(summary) => {
            // Only onto a run still whole: a refresh of the window that began
            // meanwhile has not earned it.
            *cache = file
                .update(|c| {
                    if let Some(run) = c.runs.iter_mut().find(|r| r.window == work.window) {
                        if run.is_complete() {
                            run.summary = Some(summary.clone());
                        }
                    }
                })
                .await?;
            Ok(Some(summary))
        }
        Err(e) => {
            tracing::warn!(
                "description: summary of [{}, {}] failed, answering without one: {}",
                work.window[0],
                work.window[1],
                e
            );
            Ok(None)
        }
    }
}

/// The run's timeline as the summary prompt quotes it: one `[a–b s] text` line
/// per segment, in seconds from the window's start (the frames' clock). Over
/// [`SUMMARY_OUTLINE_CHARS`], every k-th line is kept so the outline still spans
/// the whole window.
fn summary_outline(segments: &[vlm::description::DescSegment], start_us: i64) -> String {
    let secs = |us: i64| (us - start_us) as f64 / 1_000_000.0;
    let lines: Vec<String> = segments
        .iter()
        .map(|s| {
            format!(
                "[{:.1}–{:.1}s] {}",
                secs(s.src_start_us),
                secs(s.src_end_us),
                s.text.replace('\n', " ")
            )
        })
        .collect();
    let total: usize = lines.iter().map(|l| l.chars().count() + 1).sum();
    let stride = total.div_ceil(SUMMARY_OUTLINE_CHARS).max(1);
    let mut out = String::new();
    for line in lines.iter().step_by(stride) {
        if out.chars().count() + line.chars().count() + 1 > SUMMARY_OUTLINE_CHARS {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// One description run's work: its window, the chunk plan, and what every
/// chunk request needs.
struct ChunkedDescribe {
    window: [i64; 2],
    sampler: Arc<dyn FrameSampler>,
    chunks: Vec<vlm::frame_extract::Chunk>,
    describer: Arc<dyn SceneDescriber>,
    concurrency: usize,
    source: PathBuf,
    focus: vlm::Focus,
    language: vlm::Language,
    /// Steps after the chunks that the `Inferring` count includes (the summary).
    extra_steps: u32,
    /// The window's prior run is forgotten on disk with the first chunk persisted.
    refresh: bool,
}

/// Describe the run over `work.window` chunk by chunk, persisting after each:
/// the run is resumed when an earlier call over the same window left it
/// unfinished (its finished chunks are skipped), and a cancel or a failing
/// chunk keeps the chunks that finished.
///
/// A local engine runs one chunk at a time and reports frame sampling and the
/// engine's own phases; an endpoint may have up to `concurrency` chunk requests
/// in flight (a `JoinSet`, aborted with the job when it is dropped). Either way
/// `Inferring` counts finished chunks out of the plan's.
async fn describe_chunks(
    job: &JobReporter,
    file: &DescriptionFile,
    cache: &mut vlm::DescriptionCache,
    work: ChunkedDescribe,
) -> Result<(), DescriptionError> {
    use crate::compute_jobs::ModelPhase;

    let total_chunks = work.chunks.len() as u32;
    let pending: Vec<vlm::frame_extract::Chunk> = {
        let run = cache.run_for(work.window);
        work.chunks
            .into_iter()
            .filter(|c| !run.has_done(c.window))
            .collect()
    };
    let mut finished = total_chunks - pending.len() as u32;
    let steps = total_chunks + work.extra_steps;
    let mut discard = work.refresh;
    let window = work.window;
    let mut record = |c: &mut vlm::DescriptionCache, chunk: [i64; 2], fresh: Vec<DescSegment>| {
        if std::mem::take(&mut discard) {
            c.discard(window);
        }
        c.run_for(window).record_chunk(chunk, fresh);
    };

    if work.concurrency <= 1 || pending.len() <= 1 {
        let total_frames: u32 = pending.iter().map(|c| c.anchors.len() as u32).sum();
        let mut sampled = 0u32;
        for chunk in pending {
            let tmp = chunk_dir()?;
            let frames = work
                .sampler
                .sample(
                    &work.source,
                    chunk.window[0],
                    tmp.path(),
                    &chunk.anchors,
                    Some((job, sampled, total_frames)),
                )
                .await?;
            sampled += chunk.anchors.len() as u32;
            let raw = work
                .describer
                .describe_observed(
                    vlm::DescribeRequest {
                        frames,
                        focus: work.focus,
                        language: work.language.clone(),
                        task: vlm::Task::Timeline,
                    },
                    // The engine's own phases, with the chunk count it cannot see.
                    &|phase| {
                        job.model(match phase {
                            ModelPhase::Inferring { .. } => ModelPhase::Inferring {
                                done: Some(finished),
                                total: Some(steps),
                            },
                            other => other,
                        })
                    },
                )
                .await?;
            let fresh = chunk_segments(raw, chunk.window)?;
            *cache = file.update(|c| record(c, chunk.window, fresh)).await?;
            finished += 1;
        }
        return Ok(());
    }

    job.phase(ComputePhase::Inferring {
        done: Some(finished),
        total: Some(steps),
    });
    let mut queue = pending.into_iter();
    let mut in_flight = tokio::task::JoinSet::new();
    loop {
        while in_flight.len() < work.concurrency {
            let Some(chunk) = queue.next() else { break };
            let describer = work.describer.clone();
            let source = work.source.clone();
            let sampler = work.sampler.clone();
            let (focus, language) = (work.focus, work.language.clone());
            in_flight.spawn(async move {
                let result = async {
                    let tmp = chunk_dir()?;
                    let frames = sampler
                        .sample(&source, chunk.window[0], tmp.path(), &chunk.anchors, None)
                        .await?;
                    let raw = describer
                        .describe(vlm::DescribeRequest {
                            frames,
                            focus,
                            language,
                            task: vlm::Task::Timeline,
                        })
                        .await?;
                    Ok::<_, DescriptionError>(raw)
                }
                .await;
                (chunk, result)
            });
        }
        let Some(joined) = in_flight.join_next().await else {
            break;
        };
        let (chunk, result) =
            joined.map_err(|e| DescriptionError::Operation(format!("describe chunk: {e}")))?;
        let fresh = chunk_segments(result?, chunk.window)?;
        *cache = file.update(|c| record(c, chunk.window, fresh)).await?;
        finished += 1;
        job.phase(ComputePhase::Inferring {
            done: Some(finished),
            total: Some(steps),
        });
    }
    Ok(())
}

/// A per-chunk frame directory, RAII-cleaned once its request is answered.
fn chunk_dir() -> Result<tempfile::TempDir, DescriptionError> {
    tempfile::Builder::new()
        .prefix("weftcut-vlm")
        .tempdir()
        .map_err(|e| DescriptionError::Operation(format!("temp dir: {e}")))
}

/// Parse one chunk's answer and place it on source time: the parser's times are
/// chunk-relative, so they shift by the chunk's start and are held inside the
/// chunk (a model may run a segment past its last frame).
fn chunk_segments(
    raw: vlm::parser::RawDescription,
    [start, end]: [i64; 2],
) -> Result<Vec<vlm::description::DescSegment>, DescriptionError> {
    let mut fresh = vlm::parse_raw(raw)?;
    vlm::shift_segments(&mut fresh, start);
    for s in &mut fresh {
        s.src_start_us = s.src_start_us.clamp(start, end);
        s.src_end_us = s.src_end_us.clamp(s.src_start_us, end);
    }
    Ok(fresh)
}

#[cfg(test)]
mod summary_outline_tests {
    use super::{summary_outline, SUMMARY_OUTLINE_CHARS};
    use crate::vlm::description::DescSegment;

    fn seg(a: i64, b: i64, text: &str) -> DescSegment {
        DescSegment {
            src_start_us: a,
            src_end_us: b,
            text: text.into(),
            tags: vec![],
        }
    }

    #[test]
    fn the_outline_is_on_the_frames_clock() {
        let outline = summary_outline(
            &[
                seg(10_000_000, 12_500_000, "a title\ncard"),
                seg(12_500_000, 20_000_000, "sheep"),
            ],
            10_000_000,
        );
        assert_eq!(outline, "[0.0–2.5s] a title card\n[2.5–10.0s] sheep");
    }

    #[test]
    fn a_long_outline_thins_out_but_still_spans_the_window() {
        let segments: Vec<_> = (0..600)
            .map(|i| {
                seg(
                    i * 1_000_000,
                    (i + 1) * 1_000_000,
                    "一群羊在山坡上吃草，背景是山丘和开阔的田野",
                )
            })
            .collect();
        let outline = summary_outline(&segments, 0);
        assert!(outline.chars().count() <= SUMMARY_OUTLINE_CHARS);
        assert!(outline.starts_with("[0.0–1.0s]"));
        // Kept lines are spread to the end, not cut off after the first minutes.
        let last = outline.lines().last().unwrap();
        let start: f64 = last[1..last.find('–').unwrap()].parse().unwrap();
        assert!(start > 500.0, "{last}");
    }
}
