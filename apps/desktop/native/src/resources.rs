//! Application-wide cooperative admission. Native jobs and Electron-held leases
//! share this ledger on every platform. A lease is returned only after teardown.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
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
        let threads: u32 = s.leases.values().map(|c| c.threads).sum();
        let mib: u64 = s.leases.values().map(|c| c.mib).sum();
        let bg = s.leases.values().filter(|c| c.background).count() as u32;
        // Background work leaves one compute slot for interactive work when
        // possible. Pressure closes admission; existing work drains safely.
        let cpu_limit = if claim.background && s.limits.cpu_threads > 1 {
            s.limits.cpu_threads - 1
        } else {
            s.limits.cpu_threads
        };
        if s.pressured
            || claim.threads > 0 && s.finalization_waiting > 0
            || threads.saturating_add(claim.threads) > cpu_limit
            || mib.saturating_sub(credit).saturating_add(claim.mib) > s.limits.work_mib
            || claim.background
                && (bg >= s.limits.background_jobs || s.playing && !s.limits.background_playback)
        {
            return None;
        }
        loop {
            s.next = s.next.wrapping_add(1).max(1);
            let id = s.next;
            if let std::collections::hash_map::Entry::Vacant(e) = s.leases.entry(id) {
                e.insert(claim);
                if let Some(tail) = finalization {
                    s.leases.get_mut(&tail).unwrap().mib = 0;
                    s.finalizations.get_mut(&tail).unwrap().production = Some(id);
                    s.production.insert(id, tail);
                }
                return Some(id);
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
    let s = governor().state.lock().unwrap();
    serde_json::json!({
        "playing": s.playing, "background_playback": s.limits.background_playback,
        "memory_pressure": s.pressured,
        "background_active": s.leases.values().filter(|c| c.background).count(),
        "background_limit": s.limits.background_jobs, "waiting": s.waiting,
        "reserved_mib": s.leases.values().map(|c| c.mib).sum::<u64>(),
        "work_mib": s.limits.work_mib,
        "threads_active": s.leases.values().map(|c| c.threads).sum::<u32>(),
        "cpu_threads": s.limits.cpu_threads,
    })
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
