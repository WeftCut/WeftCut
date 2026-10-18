//! Application-wide cooperative admission. Native jobs and Electron-held leases
//! share this ledger on every platform. A lease is returned only after teardown.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::logs::{LogBusSlot, LogCategory, LogEntryInput, LogLevel, LogSource};
mod export_plan;
mod memory;
pub use export_plan::interactive_export;

#[derive(Clone, Deserialize)]
pub struct Limits {
    pub cpu_threads: u32,
    pub task_threads: u32,
    pub background_jobs: u32,
    pub work_mib: u64,
    pub disk_cache_mib: u64,
    pub background_playback: bool,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            cpu_threads: 2,
            task_threads: 1,
            background_jobs: 1,
            work_mib: 1024,
            disk_cache_mib: 2048,
            background_playback: false,
        }
    }
}
#[derive(Clone, Copy)]
struct Claim {
    threads: u32,
    mib: u64,
    background: bool,
}
struct State {
    limits: Limits,
    next: u32,
    leases: HashMap<u32, Claim>,
    waiting: u32,
    finalization_waiting: u32,
    /// User-compute claims currently queued. While non-zero, no new background
    /// claim is admitted, so freed capacity goes to the person waiting.
    user_waiting: u32,
    playing: bool,
    pressured: bool,
    critical: bool,
    finalizations: HashMap<u32, FinalizationState>,
    production: HashMap<u32, u32>,
    plans: HashMap<u32, export_plan::ExportPlanState>,
    revision: u32,
}
#[derive(Default)]
struct FinalizationState {
    running: bool,
    production: Option<u32>,
    released: bool,
}
pub struct Governor {
    state: Mutex<State>,
    changed: Notify,
    preparation: Arc<tokio::sync::Semaphore>,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub active: usize,
    pub waiting: u32,
    pub reserved_mib: u64,
    pub cpu_threads: u32,
}
impl Governor {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                limits: Limits::default(),
                next: 0,
                leases: HashMap::new(),
                waiting: 0,
                finalization_waiting: 0,
                user_waiting: 0,
                playing: false,
                pressured: false,
                critical: false,
                finalizations: HashMap::new(),
                production: HashMap::new(),
                plans: HashMap::new(),
                revision: 0,
            }),
            changed: Notify::new(),
            preparation: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }
    fn configure(&self, limits: Limits) -> Result<(), String> {
        if limits.cpu_threads == 0
            || limits.cpu_threads > 1024
            || limits.task_threads == 0
            || limits.task_threads > limits.cpu_threads
            || limits.background_jobs == 0
            || limits.background_jobs > 64
            || limits.work_mib < 64
            || limits.disk_cache_mib < 256
        {
            return Err("Invalid resource allocation".into());
        }
        self.state.lock().unwrap().limits = limits;
        self.notify_change();
        Ok(())
    }
    fn notify_change(&self) {
        let mut s = self.state.lock().unwrap();
        s.revision = s.revision.wrapping_add(1);
        drop(s);
        self.changed.notify_waiters();
    }
    fn reserve(&self, claim: Claim) -> Option<u32> {
        self.reserve_for(claim, None)
    }
    fn reserve_for(&self, claim: Claim, finalization: Option<u32>) -> Option<u32> {
        let mut s = self.state.lock().unwrap();
        if let Some(id) = finalization.filter(|id| s.plans.contains_key(id)) {
            return Self::borrow_export(&mut s, id, claim);
        }
        let credit = if let Some(id) = finalization {
            let tail = s.finalizations.get(&id)?;
            if tail.running || tail.released || tail.production.is_some() || claim.mib < 64 {
                return None;
            }
            64
        } else {
            0
        };
        let bg = s.leases.values().filter(|c| c.background).count() as u32;
        if Self::fresh_claim_block(&s, claim, credit).is_some()
            || claim.background
                && (bg >= s.limits.background_jobs
                    || s.playing && !s.limits.background_playback
                    // Queued background work yields to user compute. Running
                    // derivatives keep their leases; only new admissions wait.
                    || s.user_waiting > 0)
        {
            return None;
        }
        let id = Self::insert_lease(&mut s, claim);
        if let Some(tail) = finalization {
            s.leases.get_mut(&tail).unwrap().mib = 0;
            s.finalizations.get_mut(&tail).unwrap().production = Some(id);
            s.production.insert(id, tail);
        }
        Some(id)
    }
    /// The rules every fresh claim shares, in the order a refusal is reported:
    /// pressure, then a waiting export finalization, then the CPU/memory ledger.
    /// One function for admission and for the user-compute refusal reason, so
    /// the reason named to the user is the rule that actually refused.
    fn fresh_claim_block(s: &State, claim: Claim, credit: u64) -> Option<UserComputeBlock> {
        let threads: u32 = s.leases.values().map(|c| c.threads).sum();
        let mib: u64 = s.leases.values().map(|c| c.mib).sum();
        // Background work leaves one compute slot for interactive work when
        // possible. Pressure closes admission; existing work drains safely.
        let cpu_limit = if claim.background && s.limits.cpu_threads > 1 {
            s.limits.cpu_threads - 1
        } else {
            s.limits.cpu_threads
        };
        if s.pressured {
            Some(UserComputeBlock::Memory)
        } else if claim.threads > 0 && s.finalization_waiting > 0 {
            Some(UserComputeBlock::Finalization)
        } else if threads.saturating_add(claim.threads) > cpu_limit
            || mib.saturating_sub(credit).saturating_add(claim.mib) > s.limits.work_mib
        {
            Some(UserComputeBlock::Budget)
        } else {
            None
        }
    }
    fn insert_lease(s: &mut State, claim: Claim) -> u32 {
        loop {
            s.next = s.next.wrapping_add(1).max(1);
            let id = s.next;
            if let std::collections::hash_map::Entry::Vacant(e) = s.leases.entry(id) {
                e.insert(claim);
                return id;
            }
        }
    }
    fn release(&self, id: u32) {
        let mut s = self.state.lock().unwrap();
        if Self::release_export(&mut s, id) {
            drop(s);
            self.notify_change();
            return;
        }
        if let Some(tail) = s.production.remove(&id) {
            let finalization = s.finalizations.get_mut(&tail).unwrap();
            if finalization.released {
                s.finalizations.remove(&tail);
                s.leases.remove(&tail);
            } else {
                finalization.production = None;
                s.leases.get_mut(&tail).unwrap().mib = 64;
            }
        }
        if let Some(finalization) = s.finalizations.get_mut(&id) {
            if finalization.running || finalization.production.is_some() {
                // A renderer can disappear while ffmpeg is still exiting. Keep
                // its live work charged until the running permit is dropped.
                finalization.released = true;
                return;
            }
        }
        s.finalizations.remove(&id);
        s.leases.remove(&id);
        drop(s);
        self.notify_change();
    }
    fn reserve_finalization(&self) -> Option<u32> {
        let id = self.reserve(Claim {
            threads: 0,
            mib: 64,
            background: false,
        })?;
        self.state
            .lock()
            .unwrap()
            .finalizations
            .insert(id, FinalizationState::default());
        Some(id)
    }
    fn start_finalization(
        self: &Arc<Self>,
        id: u32,
    ) -> Result<FinalizationPermit, FinalizationBlocked> {
        let mut s = self.state.lock().unwrap();
        Self::finish_export_production(&mut s, id)?;
        let reservation = s.finalizations.get(&id).ok_or(FinalizationBlocked::Failed(
            "Export finalization reservation expired",
        ))?;
        if reservation.running || reservation.released || reservation.production.is_some() {
            return Err(FinalizationBlocked::Failed(
                "Export finalization is already running or closed",
            ));
        }
        let threads: u32 = s.leases.values().map(|c| c.threads).sum();
        // This is continuation of admitted work, not a fresh memory claim.
        // Ordinary RSS hysteresis cannot strand it, but real host exhaustion
        // remains a hard refusal. Temporary CPU occupancy waits without a new
        // memory claim, ahead of fresh compute work.
        if s.critical {
            return Err(FinalizationBlocked::Failed("resource-capacity-exceeded: Not enough resources to finish exporting; retry when resources recover"));
        }
        if threads >= s.limits.cpu_threads {
            return Err(FinalizationBlocked::CpuBusy);
        }
        s.finalizations.get_mut(&id).unwrap().running = true;
        s.leases.get_mut(&id).unwrap().threads = 1;
        Ok(FinalizationPermit {
            governor: self.clone(),
            id,
        })
    }
    async fn acquire_finalization(self: &Arc<Self>, id: u32) -> Result<FinalizationPermit, String> {
        // Already admitted work needs a queue entry only while CPU is occupied.
        // A full background queue must not block an otherwise runnable tail.
        match self.start_finalization(id) {
            Ok(permit) => return Ok(permit),
            Err(FinalizationBlocked::Failed(message)) => return Err(message.into()),
            Err(FinalizationBlocked::CpuBusy) => {}
        }
        let waiting = {
            let mut s = self.state.lock().unwrap();
            if s.waiting >= 256 {
                return Err("resource-capacity-exceeded: Too many queued tasks; retry when current work finishes".into());
            }
            s.waiting += 1;
            s.finalization_waiting += 1;
            FinalizationWaiting(self.clone())
        };
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.start_finalization(id) {
                Ok(permit) => {
                    drop(waiting);
                    return Ok(permit);
                }
                Err(FinalizationBlocked::Failed(message)) => return Err(message.into()),
                Err(FinalizationBlocked::CpuBusy) => notified.await,
            }
        }
    }
    fn finish_finalization(&self, id: u32) {
        let mut s = self.state.lock().unwrap();
        let Some(reservation) = s.finalizations.get_mut(&id) else {
            return;
        };
        if reservation.released {
            s.finalizations.remove(&id);
            s.leases.remove(&id);
        } else {
            reservation.running = false;
            s.leases.get_mut(&id).unwrap().threads = 0;
        }
        drop(s);
        self.notify_change();
    }
    fn snapshot(&self) -> Snapshot {
        let s = self.state.lock().unwrap();
        Snapshot {
            active: s.leases.len(),
            waiting: s.waiting,
            reserved_mib: s.leases.values().map(|c| c.mib).sum(),
            cpu_threads: s.leases.values().map(|c| c.threads).sum(),
        }
    }
    async fn acquire_preparation(self: &Arc<Self>) -> Result<PreparationPermit, String> {
        // FIFO and held for the whole operation: batch probes enter before the
        // first hash, and preparation never fans out into concurrent disk reads.
        let lane = self
            .preparation
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let resources = self.acquire_threads(false, 128, Some(1)).await?;
        Ok(PreparationPermit {
            _resources: resources,
            _lane: lane,
        })
    }
    async fn acquire(self: &Arc<Self>, background: bool, mib: u64) -> Result<Permit, String> {
        self.acquire_threads(background, mib, None).await
    }
    async fn acquire_threads(
        self: &Arc<Self>,
        background: bool,
        mib: u64,
        threads: Option<u32>,
    ) -> Result<Permit, String> {
        let waiting = {
            let mut s = self.state.lock().unwrap();
            if s.waiting >= 256 {
                return Err("resource-capacity-exceeded: Too many queued tasks; retry when current work finishes".into());
            }
            s.waiting += 1;
            Waiting(self.clone())
        };
        loop {
            // Register before checking to avoid losing a concurrent release.
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let threads = {
                let s = self.state.lock().unwrap();
                if mib > s.limits.work_mib {
                    return Err(format!("resource-capacity-exceeded: Requested {mib} MiB working memory exceeds the {} MiB allowance; increase the memory target", s.limits.work_mib));
                }
                threads.unwrap_or(s.limits.task_threads).min(if background {
                    s.limits.cpu_threads.saturating_sub(1).max(1)
                } else {
                    s.limits.cpu_threads
                })
            };
            if let Some(id) = self.reserve(Claim {
                threads,
                mib,
                background,
            }) {
                drop(waiting);
                return Ok(Permit {
                    governor: self.clone(),
                    id,
                });
            }
            notified.await;
        }
    }
}
#[derive(Debug)]
enum FinalizationBlocked {
    CpuBusy,
    Failed(&'static str),
}
struct FinalizationWaiting(Arc<Governor>);
impl Drop for FinalizationWaiting {
    fn drop(&mut self) {
        {
            let mut s = self.0.state.lock().unwrap();
            s.waiting -= 1;
            s.finalization_waiting -= 1;
        }
        self.0.notify_change();
    }
}
struct Waiting(Arc<Governor>);
impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().waiting -= 1;
    }
}
pub struct Permit {
    governor: Arc<Governor>,
    id: u32,
}
/// User-visible import preparation uses the interactive reserve, but still
/// respects the common CPU/memory ledger, pressure and finalization priority.
/// The lane must live as long as the actual process/blocking worker.
pub(crate) struct PreparationPermit {
    _resources: Permit,
    _lane: tokio::sync::OwnedSemaphorePermit,
}
pub(crate) async fn import_preparation() -> anyhow::Result<PreparationPermit> {
    governor()
        .acquire_preparation()
        .await
        .map_err(anyhow::Error::msg)
}
/// The serial workspace copier hashes on one thread and uses a 1-MiB buffer
/// plus Tokio file buffers. Keep a small working-memory allowance, without
/// taking a transcode/background slot or holding the preparation FIFO lane.
/// Common CPU/memory limits, pressure and export finalization still apply.
pub(crate) async fn workspace_copy() -> anyhow::Result<Permit> {
    governor()
        .acquire_threads(false, 8, Some(1))
        .await
        .map_err(anyhow::Error::msg)
}
impl Permit {
    pub fn threads(&self) -> u32 {
        self.governor.state.lock().unwrap().leases[&self.id].threads
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.governor.release(self.id);
    }
}
pub struct FinalizationPermit {
    governor: Arc<Governor>,
    id: u32,
}
impl Drop for FinalizationPermit {
    fn drop(&mut self) {
        self.governor.finish_finalization(self.id);
    }
}
pub async fn continue_finalization(id: u32) -> Result<FinalizationPermit, String> {
    tokio::time::timeout(std::time::Duration::from_secs(15), governor().acquire_finalization(id))
        .await
        .map_err(|_| "resource-capacity-exceeded: Processing resources are busy; retry finishing the export when they recover".to_string())?
}
#[cfg_attr(test, allow(dead_code))]
#[napi]
pub fn resources_reserve_finalization() -> napi::Result<u32> {
    governor().reserve_finalization().ok_or_else(|| {
        napi::Error::from_reason(
            "resource-capacity-exceeded: Cannot reserve memory for export finalization",
        )
    })
}
pub fn governor() -> &'static Arc<Governor> {
    static INSTANCE: OnceLock<Arc<Governor>> = OnceLock::new();
    INSTANCE.get_or_init(Governor::new)
}
pub struct BackgroundGate;
/// Snapshot only, not an assertion of the reason for the entire wait. Limits
/// and playback may change while a request is queued.
pub(crate) fn background_diagnostic_state() -> serde_json::Value {
    governor().diagnostic_state()
}
impl Governor {
    fn diagnostic_state(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap();
        serde_json::json!({
            "playing": s.playing, "background_playback": s.limits.background_playback,
            "memory_pressure": s.pressured,
            "background_active": s.leases.values().filter(|c| c.background).count(),
            "background_limit": s.limits.background_jobs, "waiting": s.waiting,
            "user_compute_waiting": s.user_waiting,
            "finalization_waiting": s.finalization_waiting,
            "reserved_mib": s.leases.values().map(|c| c.mib).sum::<u64>(),
            "work_mib": s.limits.work_mib,
            "threads_active": s.leases.values().map(|c| c.threads).sum::<u32>(),
            "cpu_threads": s.limits.cpu_threads,
        })
    }
}
impl BackgroundGate {
    pub async fn acquire(&self) -> anyhow::Result<Permit> {
        // Bound pressure on the authority. Excess background work waits here;
        // queue capacity is backpressure, never a permanent task failure.
        static DISPATCH: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
        let _dispatch = DISPATCH
            .get_or_init(|| tokio::sync::Semaphore::new(32))
            .acquire()
            .await?;
        governor()
            .acquire(true, 128)
            .await
            .map_err(anyhow::Error::msg)
    }
}
/// Longest a user-compute claim waits for admission before it is refused with
/// the reason. Interactive's 15 s is sized for a frame or an export working set
/// that a draining derivative frees quickly; user compute instead waits out a
/// pressure hysteresis cycle or an export's mux, and is never allowed to
/// interrupt a running derivative to get in. Bounded all the same: a request
/// that cannot start must answer with its cause, not look hung (#67).
pub const USER_COMPUTE_WAIT: Duration = Duration::from_secs(60);
/// One ffmpeg child decoding a slice of audio or a single frame, the same
/// working-memory charge as a background derivative.
const USER_COMPUTE_MIB: u64 = 128;

/// Clip computation a person or agent asked for and is waiting on: the audio
/// slice and normalization behind transcription and the frames behind
/// description. Named in admission diagnostics and refusals.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserComputeCaller {
    AudioExtract,
    AudioNormalize,
    FrameExtract,
}
impl UserComputeCaller {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AudioExtract => "audio_extract",
            Self::AudioNormalize => "audio_normalize",
            Self::FrameExtract => "frame_extract",
        }
    }
    fn task(self) -> &'static str {
        match self {
            Self::AudioExtract => "extracting clip audio",
            Self::AudioNormalize => "normalizing clip audio",
            Self::FrameExtract => "sampling clip frames",
        }
    }
}

/// Why a user-compute claim is not admitted yet. These are the only rules the
/// lane obeys: it ignores the background job cap and the playback gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserComputeBlock {
    /// Measured process-tree memory is under pressure; admission is closed
    /// for everything until it recovers.
    Memory,
    /// An admitted export is waiting to finish (mux); it goes first.
    Finalization,
    /// The CPU or working-memory budget is held by other leases.
    Budget,
}
impl UserComputeBlock {
    /// Stable wire tag, surfaced as a queued job's `reason`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Finalization => "finalization",
            Self::Budget => "budget",
        }
    }
}

/// Workspace log for admission diagnostics. Installed once with the backend's
/// slot, which follows workspace switches; absent in unit tests, where rows
/// are dropped exactly as the slot drops them before a workspace opens.
static DIAGNOSTICS: OnceLock<LogBusSlot> = OnceLock::new();
pub(crate) fn install_diagnostics(slot: LogBusSlot) {
    let _ = DIAGNOSTICS.set(slot);
}

/// Admit user-initiated clip computation (see [`UserComputeCaller`]). Unlike
/// [`BackgroundGate`] it is not held back by the background job cap or by
/// playback, and while it waits no new background work is admitted; unlike
/// [`interactive`] it waits up to [`USER_COMPUTE_WAIT`]. Pressure, export
/// finalization and the CPU/memory budget still apply, and running work is
/// never interrupted. `observer` hears the blocking reason when the claim first
/// fails to admit and whenever it changes, then `None` once admitted, also when
/// admitted at once: a job's phase moves from queued (or nothing) to its work
/// on that `None`. Dropping the future withdraws the claim.
pub async fn user_compute(
    caller: UserComputeCaller,
    observer: impl FnMut(Option<UserComputeBlock>) + Send,
) -> Result<Permit, String> {
    let empty = LogBusSlot::new();
    governor()
        .acquire_user_compute_announced(
            caller,
            USER_COMPUTE_WAIT,
            observer,
            DIAGNOSTICS.get().unwrap_or(&empty),
        )
        .await
}
impl Governor {
    /// [`Self::acquire_user_compute`] plus the `None` for an admission that
    /// never waited, which the inner loop has no reason to report.
    async fn acquire_user_compute_announced(
        self: &Arc<Self>,
        caller: UserComputeCaller,
        wait: Duration,
        mut observer: impl FnMut(Option<UserComputeBlock>) + Send,
        log: &LogBusSlot,
    ) -> Result<Permit, String> {
        let mut waited = false;
        let mut seen = |block| {
            waited = true;
            observer(block);
        };
        let permit = self
            .acquire_user_compute(caller, wait, &mut seen, log)
            .await?;
        // After a wait the observer has already heard the closing `None`.
        if !waited {
            observer(None);
        }
        Ok(permit)
    }
    async fn acquire_user_compute(
        self: &Arc<Self>,
        caller: UserComputeCaller,
        wait: Duration,
        observer: &mut (dyn FnMut(Option<UserComputeBlock>) + Send),
        log: &LogBusSlot,
    ) -> Result<Permit, String> {
        let trace = AdmissionTrace {
            governor: self.clone(),
            log: log.clone(),
            caller,
            queued: Instant::now(),
        };
        let first = match self.try_user_compute() {
            Ok(Ok(id)) => {
                trace.emit(LogLevel::Debug, "admitted", None, None);
                return Ok(self.permit(id));
            }
            Ok(Err(block)) => block,
            Err(message) => {
                trace.emit(LogLevel::Warn, "refused", None, Some(&message));
                return Err(message);
            }
        };
        let mut waiting = {
            let mut s = self.state.lock().unwrap();
            if s.waiting >= 256 {
                drop(s);
                let message = "resource-capacity-exceeded: Too many queued tasks; retry when current work finishes".to_string();
                trace.emit(LogLevel::Warn, "refused", Some(first), Some(&message));
                return Err(message);
            }
            // Raising the count only narrows background admission, so no
            // waiter needs waking; the guard notifies when it falls again.
            s.waiting += 1;
            s.user_waiting += 1;
            UserComputeWaiting {
                trace,
                reason: first,
                settled: false,
            }
        };
        waiting
            .trace
            .emit(LogLevel::Info, "waiting", Some(first), None);
        observer(Some(first));
        let outcome = tokio::time::timeout(wait, async {
            loop {
                // Register before checking to avoid losing a concurrent release.
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                match self.try_user_compute()? {
                    Ok(id) => return Ok::<u32, String>(id),
                    Err(block) if block != waiting.reason => {
                        waiting.reason = block;
                        observer(Some(block));
                    }
                    Err(_) => {}
                }
                notified.await;
            }
        })
        .await;
        match outcome {
            Ok(Ok(id)) => {
                let permit = self.permit(id);
                waiting.settle(LogLevel::Info, "admitted", None);
                observer(None);
                Ok(permit)
            }
            Ok(Err(message)) => {
                waiting.settle(LogLevel::Warn, "refused", Some(&message));
                Err(message)
            }
            Err(_) => {
                let message = self.user_compute_refusal(&mut waiting, wait);
                waiting.settle(LogLevel::Warn, "refused", Some(&message));
                Err(message)
            }
        }
    }
    /// Full CPU like interactive work: the lane competes for the slot that
    /// background leaves free. Same task-thread claim as other ffmpeg work,
    /// because `task_threads()` caps every new command by the smallest live
    /// claim, and a one-thread lease would throttle unrelated derivatives.
    fn user_compute_claim(s: &State) -> Claim {
        Claim {
            threads: s.limits.task_threads.min(s.limits.cpu_threads),
            mib: USER_COMPUTE_MIB,
            background: false,
        }
    }
    /// One admission attempt under one lock, so a refusal carries the rule
    /// that refused it. The outer error is a claim that can never fit.
    fn try_user_compute(&self) -> Result<Result<u32, UserComputeBlock>, String> {
        let mut s = self.state.lock().unwrap();
        if USER_COMPUTE_MIB > s.limits.work_mib {
            return Err(format!("resource-capacity-exceeded: Requested {USER_COMPUTE_MIB} MiB working memory exceeds the {} MiB allowance; increase the memory target", s.limits.work_mib));
        }
        let claim = Self::user_compute_claim(&s);
        Ok(match Self::fresh_claim_block(&s, claim, 0) {
            Some(block) => Err(block),
            None => Ok(Self::insert_lease(&mut s, claim)),
        })
    }
    /// Name the rule still refusing at expiry, falling back to the last one
    /// seen if capacity freed in the instant after the deadline.
    fn user_compute_refusal(&self, waiting: &mut UserComputeWaiting, wait: Duration) -> String {
        let s = self.state.lock().unwrap();
        let claim = Self::user_compute_claim(&s);
        let reason = Self::fresh_claim_block(&s, claim, 0).unwrap_or(waiting.reason);
        waiting.reason = reason;
        let head = format!(
            "resource-capacity-exceeded: Waited {} s before {}",
            wait.as_secs_f64(),
            waiting.trace.caller.task()
        );
        match reason {
            UserComputeBlock::Memory => format!("{head}: memory is under pressure. Close other work or wait for memory to recover, then retry"),
            UserComputeBlock::Finalization => format!("{head}: an export is finishing and goes first. Retry when the export completes"),
            UserComputeBlock::Budget => {
                let others = s.leases.len();
                let background = s.leases.values().filter(|c| c.background).count();
                format!("{head}: the CPU and memory budget is held by {others} other lease(s), {background} of them background processing such as proxy generation. Retry when it finishes, or raise Processing effort or the Memory target in Settings")
            }
        }
    }
    fn permit(self: &Arc<Self>, id: u32) -> Permit {
        Permit {
            governor: self.clone(),
            id,
        }
    }
}
/// One user-compute admission as logged: who asked, and since when.
struct AdmissionTrace {
    governor: Arc<Governor>,
    log: LogBusSlot,
    caller: UserComputeCaller,
    queued: Instant,
}
impl AdmissionTrace {
    fn emit(
        &self,
        level: LogLevel,
        status: &str,
        reason: Option<UserComputeBlock>,
        error: Option<&str>,
    ) {
        if self.log.current().is_none() {
            return;
        }
        self.log.emit(LogEntryInput {
            level,
            category: LogCategory::Job,
            source: LogSource::System,
            message: format!("Clip compute admission: {}", self.caller.as_str()),
            details: Some(serde_json::json!({
                "schema": 1, "caller": self.caller.as_str(), "status": status,
                "queued_ms": self.queued.elapsed().as_secs_f64() * 1000.0,
                "reason": reason.map(UserComputeBlock::as_str), "error": error,
                "admission": self.governor.diagnostic_state(),
            })),
            ..Default::default()
        });
    }
}
/// Holds a user-compute claim's place in the queue. Dropping it, on admission,
/// refusal or cancellation of the waiting future, withdraws the claim and lets
/// background admission resume; an unsettled drop is logged as cancelled.
struct UserComputeWaiting {
    trace: AdmissionTrace,
    reason: UserComputeBlock,
    settled: bool,
}
impl UserComputeWaiting {
    /// Withdraw from the queue first, so the logged snapshot shows the state
    /// the claim leaves behind.
    fn settle(mut self, level: LogLevel, status: &str, error: Option<&str>) {
        self.settled = true;
        self.withdraw();
        self.trace.emit(level, status, Some(self.reason), error);
    }
    fn withdraw(&mut self) {
        {
            let mut s = self.trace.governor.state.lock().unwrap();
            s.waiting -= 1;
            s.user_waiting -= 1;
        }
        self.trace.governor.notify_change();
    }
}
impl Drop for UserComputeWaiting {
    fn drop(&mut self) {
        if !self.settled {
            self.withdraw();
            let reason = Some(self.reason);
            self.trace.emit(LogLevel::Info, "cancelled", reason, None);
        }
    }
}
pub async fn interactive(mib: u64) -> Result<Permit, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        governor().acquire(false, mib),
    )
    .await
    .map_err(|_| {
        "resource-capacity-exceeded: Resources are busy. Stop playback or wait for other processing, then retry".to_string()
    })?
}
/// Model weights plus working space. Offloaded weights remain conservatively
/// charged here: shared-memory GPUs do not get a second independent RAM budget.
pub fn model_memory_mib(args: &[std::ffi::OsString], cwd: &std::path::Path) -> u64 {
    let mut bytes = 0u64;
    for (index, arg) in args.iter().enumerate() {
        let text = arg.to_string_lossy();
        let candidate = if ["-m", "--model", "--mmproj"].contains(&text.as_ref()) {
            args.get(index + 1).map(std::path::PathBuf::from)
        } else {
            text.strip_prefix("--paraformer=")
                .map(std::path::PathBuf::from)
        };
        if let Some(path) = candidate {
            let absolute = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            if let Ok(metadata) = std::fs::metadata(absolute) {
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    256 + bytes.saturating_mul(2).div_ceil(1024 * 1024)
}
pub fn task_threads() -> u32 {
    let state = governor().state.lock().unwrap();
    // A task may construct a command after awaiting I/O. A settings increase
    // must not let that command exceed its already-admitted thread claim.
    state
        .leases
        .values()
        .filter(|claim| claim.threads > 0)
        .fold(state.limits.task_threads, |limit, claim| {
            limit.min(claim.threads)
        })
}
pub fn disk_cache_bytes() -> u64 {
    governor().state.lock().unwrap().limits.disk_cache_mib * 1024 * 1024
}

#[cfg_attr(test, allow(dead_code))] // NAPI exports have no callers in the Rust test binary.
#[napi]
pub fn resources_configure(json: String) -> napi::Result<()> {
    let limits =
        serde_json::from_str(&json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    governor()
        .configure(limits)
        .map_err(napi::Error::from_reason)?;
    Ok(())
}
#[cfg_attr(test, allow(dead_code))] // NAPI exports have no callers in the Rust test binary.
#[napi]
pub async fn resources_cache_written(immediate: bool) {
    if immediate {
        crate::cache::sweep_all_soon();
    } else {
        crate::cache::notify_resource_cache_write();
    }
}
/// Protect referenced Motif frame directories while their Workspace session is
/// open. They still count towards the target; main pauses new bake writes when
/// its retained artifacts cannot fit rather than evicting and regenerating them.
#[cfg_attr(test, allow(dead_code))]
#[napi]
pub fn resources_retain_raster(paths: Vec<String>) -> napi::Result<()> {
    let paths: Vec<std::path::PathBuf> = paths.into_iter().map(Into::into).collect();
    if paths.iter().any(|p| !p.is_absolute()) {
        return Err(napi::Error::from_reason(
            "Raster retention requires absolute directories",
        ));
    }
    crate::cache::disk_lru::retain_raster_directories(paths);
    Ok(())
}
#[cfg_attr(test, allow(dead_code))] // NAPI exports have no callers in the Rust test binary.
#[napi]
pub fn resources_reserve(
    threads: f64,
    memory_mib: f64,
    finalization: Option<u32>,
) -> napi::Result<u32> {
    // NAPI's uint32 conversion silently wraps large JS numbers and truncates
    // fractions. Validate doubles before conversion so every entry into the
    // authority rejects invalid claims instead of admitting fewer resources.
    if !threads.is_finite()
        || threads.fract() != 0.0
        || !(0.0..=1024.0).contains(&threads)
        || !memory_mib.is_finite()
        || memory_mib.fract() != 0.0
        || !(1.0..=f64::from(u32::MAX)).contains(&memory_mib)
    {
        return Err(napi::Error::from_reason("Invalid resource request"));
    }
    governor()
        .reserve_for(
            Claim {
                threads: threads as u32,
                mib: memory_mib as u64,
                background: false,
            },
            finalization,
        )
        .ok_or_else(|| {
            napi::Error::from_reason("Resource capacity is busy or the memory target is too small")
        })
}
#[cfg_attr(test, allow(dead_code))] // NAPI exports have no callers in the Rust test binary.
#[napi]
pub fn resources_release(id: u32) {
    governor().release(id);
}
#[cfg_attr(test, allow(dead_code))] // NAPI exports have no callers in the Rust test binary.
#[napi]
pub fn resources_activity(playing: bool, pressured: bool, critical: Option<bool>) {
    let mut s = governor().state.lock().unwrap();
    let critical = critical.unwrap_or(pressured);
    if (s.playing, s.pressured, s.critical) == (playing, pressured, critical) {
        return;
    }
    s.playing = playing;
    s.pressured = pressured;
    s.critical = critical;
    drop(s);
    governor().notify_change();
}
#[cfg_attr(test, allow(dead_code))] // NAPI exports have no callers in the Rust test binary.
#[napi]
pub fn resources_snapshot() -> String {
    serde_json::to_string(&governor().snapshot()).unwrap()
}

/// Same process-tree sampler on Windows, macOS and Linux. RSS/working sets can
/// include shared pages; this is a pressure signal, not a claim of unique RAM.
/// Runs off the Electron thread. Parent traversal includes ffmpeg/model children.
#[cfg_attr(test, allow(dead_code))] // NAPI exports have no callers in the Rust test binary.
#[napi]
pub async fn resources_memory() -> napi::Result<ResourceMemorySample> {
    tokio::task::spawn_blocking(|| {
        use sysinfo::{MemoryRefreshKind, ProcessesToUpdate, System};
        let mut system = System::new();
        system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_memory_refresh());
        let root = sysinfo::Pid::from_u32(std::process::id());
        if system.process(root).is_none() {
            return Err(napi::Error::from_reason("Process memory unavailable"));
        }
        let mut owned = std::collections::HashSet::from([root]);
        loop {
            let before = owned.len();
            for (pid, process) in system.processes() {
                if process
                    .parent()
                    .is_some_and(|parent| owned.contains(&parent))
                {
                    owned.insert(*pid);
                }
            }
            if before == owned.len() {
                break;
            }
        }
        let process_mib = owned
            .iter()
            .filter_map(|pid| system.process(*pid))
            .map(|process| process.memory())
            .sum::<u64>() as f64
            / 1048576.0;
        Ok(ResourceMemorySample {
            process_mib,
            available_mib: memory::available_memory(&system),
        })
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
}

#[napi(object)]
pub struct ResourceMemorySample {
    pub process_mib: f64,
    pub available_mib: Option<f64>,
}

fn process_memory_refresh() -> sysinfo::ProcessRefreshKind {
    // Linux tasks share their process's address space. Counting their RSS as
    // child processes multiplies Electron memory by its number of threads.
    sysinfo::ProcessRefreshKind::nothing()
        .with_memory()
        .without_tasks()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_reservations_reject_wrapping_truncation_and_nonfinite_values() {
        for memory in [
            0.0,
            -1.0,
            1.5,
            f64::from(u32::MAX) + 1.0,
            f64::from(u32::MAX) + 65.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(resources_reserve(0.0, memory, None).is_err());
        }
        for threads in [-1.0, 1.5, 1025.0, 4294967296.0, f64::NAN, f64::INFINITY] {
            assert!(resources_reserve(threads, 64.0, None).is_err());
        }
    }
    #[test]
    fn memory_sampling_excludes_thread_entries() {
        // sysinfo enables Linux tasks even in ProcessRefreshKind::nothing().
        // They share process RSS; including them charges it once per thread.
        assert!(!process_memory_refresh().tasks());
    }
    #[tokio::test]
    async fn import_preparation_uses_one_slot_while_long_jobs_and_playback_are_active() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 13,
            task_threads: 4,
            background_jobs: 6,
            ..Limits::default()
        })
        .unwrap();
        let mut long_jobs = Vec::new();
        for _ in 0..3 {
            long_jobs.push(g.acquire(true, 128).await.unwrap());
        }
        g.state.lock().unwrap().playing = true;
        let preparation = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            g.acquire_preparation(),
        )
        .await
        .expect("import preparation must not wait for a long transcode or playback to finish")
        .unwrap();
        assert_eq!(preparation._resources.threads(), 1);
        assert_eq!(g.snapshot().cpu_threads, 13);
        drop(preparation);
        drop(long_jobs);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn import_preparation_is_serial_and_cancelled_waiters_release_the_lane() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        let g = Governor::new();
        let first = g.acquire_preparation().await.unwrap();
        let mut second = Box::pin(g.acquire_preparation());
        assert!(matches!(
            second
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        assert_eq!(g.snapshot().active, 1);
        drop(second); // workspace cancellation while waiting for the lane
        drop(first);
        let next = g.acquire_preparation().await.unwrap();
        assert_eq!(g.snapshot().cpu_threads, 1);
        drop(next);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn import_preparation_respects_pressure_memory_and_single_cpu_limits() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 1,
            task_threads: 1,
            work_mib: 128,
            ..Limits::default()
        })
        .unwrap();
        let long = g.acquire(true, 128).await.unwrap();
        let mut pending = Box::pin(g.acquire_preparation());
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        assert_eq!(g.snapshot().cpu_threads, 1);
        drop(long);
        g.state.lock().unwrap().pressured = true;
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        drop(pending); // cancellation while holding lane, but waiting for resources
        assert_eq!(g.snapshot().waiting, 0);
        g.state.lock().unwrap().pressured = false;
        let memory = g
            .reserve(Claim {
                threads: 0,
                mib: 64,
                background: false,
            })
            .unwrap();
        let mut pending = Box::pin(g.acquire_preparation());
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        g.release(memory);
        drop(pending.await.unwrap());
        assert_eq!(g.snapshot().active, 0);
        assert_eq!(g.snapshot().waiting, 0);
    }
    #[tokio::test]
    async fn memory_sampling_does_not_multiply_rss_by_live_threads() {
        // Other tests spawn ffmpeg/model children concurrently. Isolate this
        // process tree so the comparison is about threads, not those jobs.
        const CHILD: &str = "WEFTCUT_MEMORY_SAMPLE_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "resources::tests::memory_sampling_does_not_multiply_rss_by_live_threads",
                ])
                .env(CHILD, "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        // Exercise the sampler itself with an Electron-like threaded process.
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                })
            })
            .collect();
        let sample = resources_memory().await;
        let mut reference = sysinfo::System::new();
        let root = sysinfo::Pid::from_u32(std::process::id());
        reference.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[root]),
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_memory()
                .without_tasks(),
        );
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        let sample = sample.unwrap();
        let rss_mib = reference.process(root).unwrap().memory() as f64 / 1048576.0;
        assert!(sample.process_mib > 0.0);
        // Allow sampling/allocator drift, but never one full RSS per thread.
        assert!(
            sample.process_mib < rss_mib * 2.0,
            "{} vs {rss_mib}",
            sample.process_mib
        );
        assert!(sample.available_mib.is_some_and(|mib| mib > 0.0));
    }
    #[test]
    fn admitted_export_can_finish_under_rss_pressure_without_reserving_a_cpu_slot() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 1,
            task_threads: 1,
            ..Limits::default()
        })
        .unwrap();
        let id = g.reserve_finalization().unwrap();
        assert_eq!(g.snapshot().cpu_threads, 0);
        let production = g
            .reserve(Claim {
                threads: 1,
                mib: 200,
                background: false,
            })
            .unwrap();
        g.state.lock().unwrap().pressured = true;
        assert!(g.reserve_finalization().is_none());
        assert!(g.start_finalization(id).is_err());
        g.release(production);
        let permit = g.start_finalization(id).unwrap();
        assert_eq!(g.snapshot().reserved_mib, 64);
        assert_eq!(g.snapshot().cpu_threads, 1);
        assert!(g.start_finalization(id).is_err());
        drop(permit);
        assert_eq!(g.snapshot().cpu_threads, 0);
        // An unsuccessful mux leaves a retryable reservation, not a CPU lease.
        drop(g.start_finalization(id).unwrap());
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
        assert!(g.start_finalization(id).is_err());
    }
    #[test]
    fn production_transfers_the_same_memory_envelope_to_mux() {
        let g = Governor::new();
        g.configure(Limits {
            work_mib: 512,
            ..Limits::default()
        })
        .unwrap();
        let id = g.reserve_finalization().unwrap();
        let production = g
            .reserve_for(
                Claim {
                    threads: 0,
                    mib: 512,
                    background: false,
                },
                Some(id),
            )
            .unwrap();
        assert_eq!(g.snapshot().reserved_mib, 512);
        assert!(g.start_finalization(id).is_err());
        assert!(g
            .reserve_for(
                Claim {
                    threads: 0,
                    mib: 64,
                    background: false
                },
                Some(id)
            )
            .is_none());
        g.state.lock().unwrap().pressured = true;
        g.release(production);
        assert_eq!(g.snapshot().reserved_mib, 64);
        drop(g.start_finalization(id).unwrap());
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn finalization_waits_for_one_slot_and_precedes_fresh_compute() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 1,
            task_threads: 1,
            ..Limits::default()
        })
        .unwrap();
        let id = g.reserve_finalization().unwrap();
        let busy = g.acquire(true, 128).await.unwrap();
        let pending = g.acquire_finalization(id);
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
        assert_eq!(g.snapshot().waiting, 1);
        // Releasing the occupied slot cannot let another producer jump ahead.
        drop(busy);
        assert!(g
            .reserve(Claim {
                threads: 1,
                mib: 64,
                background: false
            })
            .is_none());
        let permit = tokio::time::timeout(std::time::Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(g.snapshot().waiting, 0);
        assert_eq!(g.snapshot().reserved_mib, 64);
        assert_eq!(g.snapshot().cpu_threads, 1);
        drop(permit);
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
        assert!(g.acquire(true, 128).await.is_ok());
    }
    #[tokio::test]
    async fn admitted_finalization_can_finish_while_the_background_queue_is_full() {
        let g = Governor::new();
        let id = g.reserve_finalization().unwrap();
        g.state.lock().unwrap().playing = true;
        let mut queued = tokio::task::JoinSet::new();
        for _ in 0..256 {
            let g = g.clone();
            queued.spawn(async move { g.acquire(true, 64).await });
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while g.snapshot().waiting < 256 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let permit = g.acquire_finalization(id).await.unwrap();
        assert_eq!(g.snapshot().cpu_threads, 1);
        assert_eq!(g.snapshot().waiting, 256);
        queued.abort_all();
        while queued.join_next().await.is_some() {}
        assert_eq!(g.snapshot().waiting, 0);
        drop(permit);
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn cancelling_or_expiring_a_waiting_finalization_restores_admission() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 1,
            task_threads: 1,
            ..Limits::default()
        })
        .unwrap();
        let busy = g.acquire(true, 128).await.unwrap();
        let id = g.reserve_finalization().unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            g.acquire_finalization(id)
        )
        .await
        .is_err());
        assert_eq!(g.snapshot().waiting, 0);
        assert_eq!(g.state.lock().unwrap().finalization_waiting, 0);
        let pending = g.acquire_finalization(id);
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
        g.release(id);
        assert!(pending.await.err().unwrap().contains("expired"));
        assert_eq!(g.snapshot().waiting, 0);
        drop(busy);
        assert!(g.acquire(true, 128).await.is_ok());
    }
    #[tokio::test]
    async fn impossible_working_claim_fails_instead_of_waiting_for_a_release() {
        let g = Governor::new();
        g.configure(Limits {
            work_mib: 409,
            ..Limits::default()
        })
        .unwrap();
        let result =
            tokio::time::timeout(std::time::Duration::from_millis(50), g.acquire(true, 509))
                .await
                .unwrap();
        let error = result.err().unwrap();
        assert!(error.contains("resource-capacity-exceeded"));
        assert!(error.contains("increase the memory target"));
        assert_eq!(g.snapshot().waiting, 0);
        assert_eq!(g.snapshot().active, 0);
    }
    #[test]
    fn renderer_exit_releases_production_and_finalization_in_either_order() {
        for tail_first in [true, false] {
            let g = Governor::new();
            let id = g.reserve_finalization().unwrap();
            let production = g
                .reserve_for(
                    Claim {
                        threads: 0,
                        mib: 200,
                        background: false,
                    },
                    Some(id),
                )
                .unwrap();
            if tail_first {
                g.release(id);
                g.release(production);
            } else {
                g.release(production);
                g.release(id);
            }
            assert_eq!(g.snapshot().active, 0);
        }
    }

    #[test]
    fn host_exhaustion_blocks_continuations_and_owner_exit_cannot_uncharge_live_mux() {
        let g = Governor::new();
        let id = g.reserve_finalization().unwrap();
        g.state.lock().unwrap().critical = true;
        assert!(g.start_finalization(id).is_err());
        g.state.lock().unwrap().critical = false;
        let permit = g.start_finalization(id).unwrap();
        g.release(id);
        assert_eq!(g.snapshot().reserved_mib, 64);
        drop(permit);
        assert_eq!(g.snapshot().reserved_mib, 0);
        assert!(g.start_finalization(id).is_err());
    }

    #[test]
    fn total_admission_survives_limit_reduction_and_double_release() {
        let g = Governor::new();
        let a = g
            .reserve(Claim {
                threads: 1,
                mib: 600,
                background: false,
            })
            .unwrap();
        assert!(g
            .reserve(Claim {
                threads: 1,
                mib: 600,
                background: false
            })
            .is_none());
        g.configure(Limits {
            work_mib: 128,
            ..Limits::default()
        })
        .unwrap();
        assert_eq!(g.snapshot().reserved_mib, 600);
        assert!(g
            .reserve(Claim {
                threads: 0,
                mib: 1,
                background: false
            })
            .is_none());
        g.release(a);
        g.release(a);
        assert_eq!(g.snapshot().reserved_mib, 0);
    }
    #[tokio::test]
    async fn cancellation_removes_waiter_and_release_wakes_work() {
        let g = Governor::new();
        let id = g
            .reserve(Claim {
                threads: 2,
                mib: 1,
                background: false,
            })
            .unwrap();
        let task = tokio::spawn({
            let g = g.clone();
            async move { g.acquire(false, 128).await }
        });
        tokio::task::yield_now().await;
        assert_eq!(g.snapshot().waiting, 1);
        task.abort();
        let _ = task.await;
        assert_eq!(g.snapshot().waiting, 0);
        let task = tokio::spawn({
            let g = g.clone();
            async move { g.acquire(false, 128).await }
        });
        g.release(id);
        let permit = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(g.snapshot().active, 1);
        drop(permit);
        assert_eq!(g.snapshot().active, 0);
    }
    #[test]
    fn resident_memory_and_processing_share_capacity_without_deadlocking_one_core() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 1,
            task_threads: 1,
            work_mib: 512,
            ..Limits::default()
        })
        .unwrap();
        let decoder = g
            .reserve(Claim {
                threads: 0,
                mib: 200,
                background: false,
            })
            .unwrap();
        let export = g
            .reserve(Claim {
                threads: 1,
                mib: 200,
                background: false,
            })
            .unwrap();
        assert!(g
            .reserve(Claim {
                threads: 0,
                mib: 113,
                background: false
            })
            .is_none());
        g.state.lock().unwrap().pressured = true;
        g.release(export);
        assert!(g
            .reserve(Claim {
                threads: 1,
                mib: 100,
                background: false
            })
            .is_none());
        g.state.lock().unwrap().pressured = false;
        let recovered = g
            .reserve(Claim {
                threads: 1,
                mib: 100,
                background: false,
            })
            .unwrap();
        g.release(recovered);
        g.release(decoder);
        assert_eq!(g.snapshot().reserved_mib, 0);
    }

    type Seen = Arc<Mutex<Vec<Option<UserComputeBlock>>>>;
    fn spawn_user_compute(
        g: &Arc<Governor>,
        wait: Duration,
    ) -> (tokio::task::JoinHandle<Result<Permit, String>>, Seen) {
        let seen = Seen::default();
        let task = tokio::spawn({
            let (g, seen) = (g.clone(), seen.clone());
            async move {
                let mut observer = |block| seen.lock().unwrap().push(block);
                let log = LogBusSlot::new();
                g.acquire_user_compute(UserComputeCaller::AudioExtract, wait, &mut observer, &log)
                    .await
            }
        });
        (task, seen)
    }
    async fn until(mut ready: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !ready() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition not reached");
    }
    fn user_waiting(g: &Governor) -> u32 {
        g.state.lock().unwrap().user_waiting
    }
    #[tokio::test]
    async fn user_compute_admits_while_background_is_saturated_and_playback_runs() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 8,
            task_threads: 2,
            background_jobs: 1,
            ..Limits::default()
        })
        .unwrap();
        let proxy = g.acquire(true, 128).await.unwrap();
        g.state.lock().unwrap().playing = true;
        let (task, seen) = spawn_user_compute(&g, Duration::from_millis(200));
        let permit = tokio::time::timeout(Duration::from_millis(100), task)
            .await
            .expect("user compute must not wait for the background cap or playback")
            .unwrap()
            .unwrap();
        assert_eq!(permit.threads(), 2);
        assert!(seen.lock().unwrap().is_empty(), "admitted without waiting");
        assert_eq!(g.snapshot().waiting, 0);
        drop(permit);
        drop(proxy);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn user_compute_is_refused_under_pressure_after_its_bounded_wait() {
        let g = Governor::new();
        g.state.lock().unwrap().pressured = true;
        let (task, seen) = spawn_user_compute(&g, Duration::from_millis(30));
        let error = task.await.unwrap().err().unwrap();
        assert!(error.starts_with("resource-capacity-exceeded: "), "{error}");
        assert!(error.contains("extracting clip audio"), "{error}");
        assert!(error.contains("memory is under pressure"), "{error}");
        assert_eq!(*seen.lock().unwrap(), [Some(UserComputeBlock::Memory)]);
        assert_eq!(g.snapshot().waiting, 0);
        assert_eq!(user_waiting(&g), 0);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn waiting_user_compute_holds_back_new_background_work_only() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 4,
            task_threads: 1,
            background_jobs: 4,
            work_mib: 256,
            ..Limits::default()
        })
        .unwrap();
        let resident = g
            .reserve(Claim {
                threads: 0,
                mib: 200,
                background: false,
            })
            .unwrap();
        let small = |background| Claim {
            threads: 1,
            mib: 50,
            background,
        };
        let (task, seen) = spawn_user_compute(&g, Duration::from_secs(1));
        until(|| user_waiting(&g) == 1).await;
        // The small background claim fits the ledger, but must not take the
        // capacity a person is waiting for. Interactive work is unaffected.
        assert!(g.reserve(small(true)).is_none());
        let interactive = g.reserve(small(false)).unwrap();
        g.release(interactive);
        g.release(resident);
        let permit = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            [Some(UserComputeBlock::Budget), None]
        );
        assert_eq!(user_waiting(&g), 0);
        let background = g.reserve(small(true)).expect("background resumes");
        g.release(background);
        drop(permit);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn cancelling_a_waiting_user_compute_restores_background_admission() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 4,
            task_threads: 1,
            background_jobs: 4,
            work_mib: 256,
            ..Limits::default()
        })
        .unwrap();
        let resident = g
            .reserve(Claim {
                threads: 0,
                mib: 200,
                background: false,
            })
            .unwrap();
        let mut observer = |_| {};
        let log = LogBusSlot::new();
        let mut pending = Box::pin(g.acquire_user_compute(
            UserComputeCaller::FrameExtract,
            Duration::from_secs(60),
            &mut observer,
            &log,
        ));
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        assert_eq!(user_waiting(&g), 1);
        assert_eq!(g.snapshot().waiting, 1);
        // A background waiter held back only by the queued user claim must be
        // woken when that claim is withdrawn.
        let background = tokio::spawn({
            let g = g.clone();
            async move { g.acquire_threads(true, 50, Some(1)).await }
        });
        until(|| g.snapshot().waiting == 2).await;
        drop(pending);
        assert_eq!(user_waiting(&g), 0);
        let permit = tokio::time::timeout(Duration::from_secs(1), background)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(g.snapshot().waiting, 0);
        drop(permit);
        g.release(resident);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn user_compute_refusal_names_the_rule_still_blocking_at_expiry() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 2,
            task_threads: 2,
            ..Limits::default()
        })
        .unwrap();
        // Budget: a background proxy holds the slot the claim needs.
        let proxy = g.acquire(true, 128).await.unwrap();
        let (task, seen) = spawn_user_compute(&g, Duration::from_millis(30));
        let error = task.await.unwrap().err().unwrap();
        assert!(error.starts_with("resource-capacity-exceeded: "), "{error}");
        assert!(
            error.contains("held by 1 other lease(s), 1 of them background processing such as proxy generation"),
            "{error}"
        );
        assert_eq!(*seen.lock().unwrap(), [Some(UserComputeBlock::Budget)]);
        drop(proxy);
        // Finalization: an admitted export waiting for its mux goes first.
        let busy = g
            .reserve(Claim {
                threads: 2,
                mib: 1,
                background: false,
            })
            .unwrap();
        let id = g.reserve_finalization().unwrap();
        let mut mux = Box::pin(g.acquire_finalization(id));
        assert!(matches!(
            mux.as_mut().poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        g.release(busy);
        let (task, seen) = spawn_user_compute(&g, Duration::from_millis(30));
        let error = task.await.unwrap().err().unwrap();
        assert!(error.contains("an export is finishing"), "{error}");
        assert_eq!(
            *seen.lock().unwrap(),
            [Some(UserComputeBlock::Finalization)]
        );
        drop(mux);
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
        assert_eq!(g.snapshot().waiting, 0);
        assert_eq!(user_waiting(&g), 0);
    }
    #[tokio::test]
    async fn user_compute_observer_follows_the_blocking_reason() {
        let g = Governor::new();
        g.configure(Limits {
            work_mib: 256,
            ..Limits::default()
        })
        .unwrap();
        let resident = g
            .reserve(Claim {
                threads: 0,
                mib: 200,
                background: false,
            })
            .unwrap();
        let (task, seen) = spawn_user_compute(&g, Duration::from_secs(1));
        let seen_len = || seen.lock().unwrap().len();
        until(|| seen_len() == 1).await;
        g.state.lock().unwrap().pressured = true;
        g.notify_change();
        until(|| seen_len() == 2).await;
        // A wake-up that changes nothing about the reason is not reported.
        g.notify_change();
        tokio::task::yield_now().await;
        g.state.lock().unwrap().pressured = false;
        g.notify_change();
        until(|| seen_len() == 3).await;
        g.release(resident);
        drop(task.await.unwrap().unwrap());
        use UserComputeBlock::{Budget, Memory};
        assert_eq!(
            *seen.lock().unwrap(),
            [Some(Budget), Some(Memory), Some(Budget), None]
        );
    }
    #[tokio::test]
    async fn announced_user_compute_reports_admission_exactly_once() {
        let g = Governor::new();
        g.configure(Limits {
            work_mib: 256,
            ..Limits::default()
        })
        .unwrap();
        let log = LogBusSlot::new();
        let seen = Seen::default();
        let observer = |block| seen.lock().unwrap().push(block);
        let caller = UserComputeCaller::FrameExtract;
        let wait = Duration::from_secs(1);
        drop(
            g.acquire_user_compute_announced(caller, wait, observer, &log)
                .await
                .unwrap(),
        );
        assert_eq!(*seen.lock().unwrap(), [None], "admitted at once");
        seen.lock().unwrap().clear();
        let resident = g
            .reserve(Claim {
                threads: 0,
                mib: 200,
                background: false,
            })
            .unwrap();
        let task = tokio::spawn({
            let (g, seen) = (g.clone(), seen.clone());
            async move {
                let observer = |block| seen.lock().unwrap().push(block);
                g.acquire_user_compute_announced(caller, wait, observer, &LogBusSlot::new())
                    .await
            }
        });
        until(|| user_waiting(&g) == 1).await;
        g.release(resident);
        drop(task.await.unwrap().unwrap());
        assert_eq!(
            *seen.lock().unwrap(),
            [Some(UserComputeBlock::Budget), None]
        );
    }
    /// A job queued for admission is reported as queued with the reason, and
    /// cancelling it withdraws both the job and the claim, so background work
    /// is no longer held back for a person who has given up.
    #[tokio::test]
    async fn cancelling_a_job_queued_for_user_compute_withdraws_job_and_claim() {
        use crate::compute_jobs::{ComputeJobs, ComputePhase, JobReporter, JobStop};
        let g = Governor::new();
        g.state.lock().unwrap().pressured = true;
        let sink = Arc::new(crate::events::VecEventSink::new());
        let jobs = Arc::new(ComputeJobs::default());
        let task = tokio::spawn({
            let (g, jobs, sink) = (g.clone(), jobs.clone(), sink.clone());
            async move {
                let job = JobReporter::new(sink, Some("j".into()));
                let log = LogBusSlot::new();
                let admission = g.acquire_user_compute_announced(
                    UserComputeCaller::AudioExtract,
                    USER_COMPUTE_WAIT,
                    job.admission(ComputePhase::Extracting { done: 0, total: 1 }),
                    &log,
                );
                jobs.run(Some("j"), admission).await.map(|r| r.is_ok())
            }
        });
        until(|| user_waiting(&g) == 1).await;
        assert!(jobs.cancel("j"));
        assert_eq!(task.await.unwrap(), Err(JobStop::Cancelled));
        assert_eq!(user_waiting(&g), 0);
        assert_eq!(g.snapshot().waiting, 0);
        assert_eq!(jobs.live_count(), 0);
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(
            events[0].1,
            serde_json::json!({ "job_id": "j", "phase": { "kind": "queued", "reason": "memory" } })
        );
    }
    #[tokio::test]
    async fn user_compute_admission_is_logged_with_queue_time_and_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let log = LogBusSlot::new();
        let bus =
            crate::logs::LogBus::spawn(dir.path(), Arc::new(crate::events::VecEventSink::new()));
        log.install(bus.clone());
        let g = Governor::new();
        let mut observer = |_| {};
        let caller = UserComputeCaller::AudioNormalize;
        drop(
            g.acquire_user_compute(caller, Duration::from_millis(30), &mut observer, &log)
                .await
                .unwrap(),
        );
        g.state.lock().unwrap().pressured = true;
        let refused = g
            .acquire_user_compute(caller, Duration::from_millis(30), &mut observer, &log)
            .await;
        assert!(refused.is_err());
        {
            let cancelled =
                g.acquire_user_compute(caller, Duration::from_secs(60), &mut observer, &log);
            assert!(tokio::time::timeout(Duration::from_millis(10), cancelled)
                .await
                .is_err());
        }
        let rows = bus.list();
        let rows: Vec<_> = rows
            .iter()
            .map(|row| {
                let d = row.details.as_ref().unwrap();
                assert_eq!(row.message, "Clip compute admission: audio_normalize");
                assert_eq!(d["caller"], "audio_normalize");
                assert!(d["admission"]["memory_pressure"].is_boolean());
                (
                    row.level,
                    d["status"].as_str().unwrap().to_string(),
                    d.clone(),
                )
            })
            .collect();
        let statuses: Vec<_> = rows.iter().map(|r| (r.0, r.1.as_str())).collect();
        assert_eq!(
            statuses,
            [
                (LogLevel::Debug, "admitted"),
                (LogLevel::Info, "waiting"),
                (LogLevel::Warn, "refused"),
                (LogLevel::Info, "waiting"),
                (LogLevel::Info, "cancelled"),
            ]
        );
        let refused = &rows[2].2;
        assert_eq!(refused["reason"], "memory");
        assert!(refused["queued_ms"].as_f64().unwrap() >= 30.0);
        assert!(refused["error"]
            .as_str()
            .unwrap()
            .starts_with("resource-capacity-exceeded: "));
        assert_eq!(rows[4].2["admission"]["user_compute_waiting"], 0);
    }
    #[test]
    fn user_compute_block_wire_tags_are_stable() {
        use UserComputeBlock::*;
        let tags = [Memory, Finalization, Budget].map(UserComputeBlock::as_str);
        assert_eq!(tags, ["memory", "finalization", "budget"]);
    }

    #[test]
    fn background_reserves_interactive_capacity_and_respects_playback() {
        let g = Governor::new();
        assert!(g
            .reserve(Claim {
                threads: 2,
                mib: 1,
                background: true
            })
            .is_none());
        g.state.lock().unwrap().playing = true;
        assert!(g
            .reserve(Claim {
                threads: 1,
                mib: 1,
                background: true
            })
            .is_none());
        assert!(g
            .reserve(Claim {
                threads: 1,
                mib: 1,
                background: false
            })
            .is_some());
    }
}
