//! Clip-compute jobs: phase reporting and cancellation for `transcribe_clip`
//! and `describe_clip` (#67).
//!
//! The TS host mints a `job_id` per job and injects it into the tool args. With
//! an id, the tool reports each phase on the backend's event sink as
//! [`EVENT_COMPUTE_JOB_PHASE`] and can be cancelled through
//! [`ComputeJobs::cancel`]. Without one (a bare-core caller) nothing is emitted
//! and nothing is registered, so the call behaves exactly as it did before.
//!
//! There is no terminal event: the tool call resolving is the terminal signal,
//! and the host already owns that promise. Cancelling drops the tool future;
//! every child it owns (ffmpeg, whisper.cpp, sherpa-onnx, llama-mtmd-cli) is
//! spawned with `kill_on_drop`, and an HTTP request is aborted by the drop, so
//! cancellation needs no cooperation from the work itself.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::oneshot;

use crate::events::{EventSink, EVENT_COMPUTE_JOB_PHASE};
use crate::resources::UserComputeBlock;

/// Where a clip-compute job is, as the host shows it. Serialized as
/// `{ "kind": "<snake_case>", ...fields }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputePhase {
    /// Waiting for admission; `reason` is the rule still refusing it
    /// ([`UserComputeBlock::as_str`]).
    Queued { reason: &'static str },
    /// Reading the source: frames sampled so far for a description, `0/1` then
    /// `1/1` for a transcription's audio slice.
    Extracting { done: u32, total: u32 },
    /// Peak-normalizing the transcription copy; only when that actually runs.
    Normalizing,
    /// A local engine is starting and loading its weights.
    LoadingModel,
    /// The model is working on the request. Counts only where the engine
    /// reports them (whisper.cpp's percent), never estimated.
    Inferring {
        #[serde(skip_serializing_if = "Option::is_none")]
        done: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u32>,
    },
}

/// What an inference backend can say about itself. A narrower vocabulary than
/// [`ComputePhase`] so engines cannot claim to be queued or extracting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelPhase {
    LoadingModel,
    Inferring {
        done: Option<u32>,
        total: Option<u32>,
    },
}

impl ModelPhase {
    pub const INFERRING: Self = Self::Inferring {
        done: None,
        total: None,
    };
}

impl From<ModelPhase> for ComputePhase {
    fn from(p: ModelPhase) -> Self {
        match p {
            ModelPhase::LoadingModel => Self::LoadingModel,
            ModelPhase::Inferring { done, total } => Self::Inferring { done, total },
        }
    }
}

/// How an inference backend reports [`ModelPhase`]s. Borrowed for the duration
/// of one request; a caller that does not care passes [`ignore_model_phase`].
pub type ModelObserver<'a> = &'a (dyn Fn(ModelPhase) + Send + Sync);

/// The no-op [`ModelObserver`], for callers outside a job (model verification,
/// the plain `transcribe` / `describe` entry points).
pub fn ignore_model_phase(_: ModelPhase) {}

/// Emits one job's phases. A no-op without a job id, so a tool body reports
/// unconditionally and stays free of `if let Some(id)` branches.
pub struct JobReporter {
    events: Arc<dyn EventSink>,
    job_id: Option<String>,
    /// Last phase sent. Engines repeat themselves (whisper.cpp's progress
    /// line, an admission observer re-reporting the active phase), and the
    /// contract is one event per change.
    last: Mutex<Option<ComputePhase>>,
}

impl JobReporter {
    pub fn new(events: Arc<dyn EventSink>, job_id: Option<String>) -> Self {
        Self {
            events,
            job_id,
            last: Mutex::new(None),
        }
    }

    pub fn phase(&self, phase: ComputePhase) {
        let Some(job_id) = &self.job_id else { return };
        {
            let mut last = self.last.lock().unwrap();
            if last.as_ref() == Some(&phase) {
                return;
            }
            *last = Some(phase.clone());
        }
        self.events.emit(
            EVENT_COMPUTE_JOB_PHASE,
            serde_json::json!({ "job_id": job_id, "phase": phase }),
        );
    }

    /// An observer for `resources::user_compute` admission: queued with the
    /// blocking reason while it waits, then `active` once admitted.
    pub fn admission(
        &self,
        active: ComputePhase,
    ) -> impl FnMut(Option<UserComputeBlock>) + Send + '_ {
        move |block| match block {
            Some(block) => self.phase(ComputePhase::Queued {
                reason: block.as_str(),
            }),
            None => self.phase(active.clone()),
        }
    }

    /// Forward a backend's [`ModelPhase`]s.
    pub fn model(&self, phase: ModelPhase) {
        self.phase(phase.into());
    }
}

/// Why [`ComputeJobs::run`] did not return the work's own output.
#[derive(Debug, PartialEq, Eq)]
pub enum JobStop {
    /// [`ComputeJobs::cancel`] was called for this job.
    Cancelled,
    /// Another live job already holds this id. Ids are minted per job by the
    /// host, so this is a host bug; refusing keeps the first job cancellable
    /// rather than silently orphaning it.
    Duplicate,
}

/// Live jobs by id. One per `Backend`; the host's cancel button and an MCP
/// `notifications/cancelled` both end up in [`ComputeJobs::cancel`].
#[derive(Default)]
pub struct ComputeJobs {
    live: Mutex<HashMap<String, Live>>,
    next: AtomicU64,
}

struct Live {
    /// Distinguishes this registration from a later one under the same id, so
    /// a cancelled job unwinding late cannot remove its successor's entry.
    seq: u64,
    cancel: oneshot::Sender<()>,
}

impl ComputeJobs {
    /// Run `work` as job `job_id`, cancellable until it finishes. Without an id
    /// it just runs. The registration is withdrawn on every exit path,
    /// including the caller dropping this future.
    pub async fn run<F: Future>(
        &self,
        job_id: Option<&str>,
        work: F,
    ) -> Result<F::Output, JobStop> {
        let Some(job_id) = job_id else {
            return Ok(work.await);
        };
        let mut registration = self.register(job_id)?;
        // Cancel wins a tie: a `cancel` that returned true must not be
        // followed by a result the canceller has already given up on. A closed
        // channel means the registry itself is gone, which is a cancel too.
        tokio::select! {
            biased;
            _ = &mut registration.cancelled => Err(JobStop::Cancelled),
            out = work => Ok(out),
        }
    }

    /// Cancel a live job. True when one was found; the job's future is dropped
    /// at its next poll and its call resolves as cancelled.
    pub fn cancel(&self, job_id: &str) -> bool {
        let live = self.live.lock().unwrap().remove(job_id);
        match live {
            // A failed send means the job finished between the lookup and
            // now; it is still the job the caller named, already over.
            Some(live) => live.cancel.send(()).is_ok(),
            None => false,
        }
    }

    #[cfg(test)]
    pub fn live_count(&self) -> usize {
        self.live.lock().unwrap().len()
    }

    fn register(&self, job_id: &str) -> Result<Registration<'_>, JobStop> {
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        let (cancel, cancelled) = oneshot::channel();
        let mut live = self.live.lock().unwrap();
        if live.contains_key(job_id) {
            return Err(JobStop::Duplicate);
        }
        live.insert(job_id.to_string(), Live { seq, cancel });
        Ok(Registration {
            jobs: self,
            job_id: job_id.to_string(),
            seq,
            cancelled,
        })
    }
}

/// A job's place in the registry, withdrawn on drop.
struct Registration<'a> {
    jobs: &'a ComputeJobs,
    job_id: String,
    seq: u64,
    cancelled: oneshot::Receiver<()>,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        let mut live = self.jobs.live.lock().unwrap();
        if live.get(&self.job_id).is_some_and(|l| l.seq == self.seq) {
            live.remove(&self.job_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::VecEventSink;

    fn phases(sink: &VecEventSink) -> Vec<serde_json::Value> {
        sink.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == EVENT_COMPUTE_JOB_PHASE)
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    #[test]
    fn phase_payloads_have_the_contract_shape() {
        let sink = Arc::new(VecEventSink::new());
        let job = JobReporter::new(sink.clone(), Some("j1".into()));
        job.phase(ComputePhase::Queued { reason: "budget" });
        job.phase(ComputePhase::Extracting { done: 0, total: 3 });
        job.phase(ComputePhase::Normalizing);
        job.phase(ComputePhase::LoadingModel);
        job.phase(ModelPhase::INFERRING.into());
        job.phase(ComputePhase::Inferring {
            done: Some(40),
            total: Some(100),
        });
        let kinds: Vec<_> = phases(&sink)
            .into_iter()
            .map(|p| p["phase"].clone())
            .collect();
        assert_eq!(
            kinds,
            [
                serde_json::json!({ "kind": "queued", "reason": "budget" }),
                serde_json::json!({ "kind": "extracting", "done": 0, "total": 3 }),
                serde_json::json!({ "kind": "normalizing" }),
                serde_json::json!({ "kind": "loading_model" }),
                serde_json::json!({ "kind": "inferring" }),
                serde_json::json!({ "kind": "inferring", "done": 40, "total": 100 }),
            ]
        );
        assert!(phases(&sink).iter().all(|p| p["job_id"] == "j1"));
    }

    #[test]
    fn reporter_is_silent_without_a_job_id_and_skips_repeats() {
        let sink = Arc::new(VecEventSink::new());
        JobReporter::new(sink.clone(), None).phase(ComputePhase::LoadingModel);
        assert!(sink.names().is_empty());
        let job = JobReporter::new(sink.clone(), Some("j".into()));
        job.phase(ComputePhase::LoadingModel);
        job.phase(ComputePhase::LoadingModel);
        assert_eq!(phases(&sink).len(), 1);
    }

    #[test]
    fn admission_observer_maps_blocks_to_queued_then_the_active_phase() {
        let sink = Arc::new(VecEventSink::new());
        let job = JobReporter::new(sink.clone(), Some("j".into()));
        let mut observer = job.admission(ComputePhase::Normalizing);
        observer(Some(UserComputeBlock::Memory));
        observer(Some(UserComputeBlock::Finalization));
        observer(None);
        let kinds: Vec<_> = phases(&sink)
            .into_iter()
            .map(|p| p["phase"].clone())
            .collect();
        assert_eq!(
            kinds,
            [
                serde_json::json!({ "kind": "queued", "reason": "memory" }),
                serde_json::json!({ "kind": "queued", "reason": "finalization" }),
                serde_json::json!({ "kind": "normalizing" }),
            ]
        );
    }

    #[tokio::test]
    async fn run_without_an_id_registers_nothing() {
        let jobs = ComputeJobs::default();
        assert_eq!(jobs.run(None, async { 7 }).await, Ok(7));
        assert_eq!(jobs.live_count(), 0);
    }

    #[test]
    fn cancelling_an_unknown_job_finds_nothing() {
        assert!(!ComputeJobs::default().cancel("nope"));
    }

    #[tokio::test]
    async fn cancel_drops_the_work_and_withdraws_the_job() {
        let jobs = Arc::new(ComputeJobs::default());
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Flag(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Flag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let task = tokio::spawn({
            let (jobs, flag) = (jobs.clone(), Flag(dropped.clone()));
            async move {
                jobs.run(Some("j"), async move {
                    let _flag = flag;
                    std::future::pending::<()>().await
                })
                .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while jobs.live_count() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(jobs.cancel("j"));
        assert!(!jobs.cancel("j"), "a job is cancelled once");
        assert_eq!(task.await.unwrap(), Err(JobStop::Cancelled));
        assert!(dropped.load(Ordering::SeqCst), "the work future is dropped");
        assert_eq!(jobs.live_count(), 0);
    }

    #[tokio::test]
    async fn a_finished_or_dropped_job_leaves_the_registry_empty() {
        let jobs = ComputeJobs::default();
        assert_eq!(jobs.run(Some("a"), async { 1 }).await, Ok(1));
        assert_eq!(jobs.live_count(), 0);
        assert!(!jobs.cancel("a"));
        // The caller abandoning the call is an exit path too.
        let pending = jobs.run(Some("b"), std::future::pending::<()>());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), pending)
                .await
                .is_err()
        );
        assert_eq!(jobs.live_count(), 0);
    }

    #[tokio::test]
    async fn a_live_id_is_not_taken_twice() {
        let jobs = ComputeJobs::default();
        let first = jobs.register("j").unwrap();
        assert!(matches!(jobs.register("j"), Err(JobStop::Duplicate)));
        drop(first);
        assert_eq!(jobs.run(Some("j"), async { 2 }).await, Ok(2));
    }

    #[tokio::test]
    async fn a_late_drop_does_not_withdraw_a_successor_under_the_same_id() {
        let jobs = ComputeJobs::default();
        let first = jobs.register("j").unwrap();
        assert!(jobs.cancel("j"));
        let second = jobs.register("j").unwrap();
        drop(first);
        assert_eq!(jobs.live_count(), 1);
        drop(second);
        assert_eq!(jobs.live_count(), 0);
    }
}
