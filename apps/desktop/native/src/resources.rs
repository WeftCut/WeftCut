//! Application-wide cooperative admission. Native jobs and Electron-held leases
//! share this ledger on every platform. A lease is returned only after teardown.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

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
    playing: bool,
    pressured: bool,
    critical: bool,
    finalizations: HashMap<u32, FinalizationState>,
    production: HashMap<u32, u32>,
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
                playing: false,
                pressured: false,
                critical: false,
                finalizations: HashMap::new(),
                production: HashMap::new(),
            }),
            changed: Notify::new(),
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
        self.changed.notify_waiters();
        Ok(())
    }
    fn reserve(&self, claim: Claim) -> Option<u32> {
        self.reserve_for(claim, None)
    }
    fn reserve_for(&self, claim: Claim, finalization: Option<u32>) -> Option<u32> {
        let mut s = self.state.lock().unwrap();
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
        self.changed.notify_waiters();
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
    fn start_finalization(self: &Arc<Self>, id: u32) -> Result<FinalizationPermit, String> {
        let mut s = self.state.lock().unwrap();
        let reservation = s
            .finalizations
            .get(&id)
            .ok_or("Export finalization reservation expired")?;
        if reservation.running || reservation.released || reservation.production.is_some() {
            return Err("Export finalization is already running or closed".into());
        }
        let threads: u32 = s.leases.values().map(|c| c.threads).sum();
        // This is continuation of admitted work, not a fresh memory claim.
        // Ordinary RSS hysteresis cannot strand it, but real host exhaustion
        // and CPU occupancy still reject it explicitly, retaining the files.
        if s.critical || threads >= s.limits.cpu_threads {
            return Err("resource-capacity-exceeded: Not enough resources to finish exporting; retry when resources recover".into());
        }
        s.finalizations.get_mut(&id).unwrap().running = true;
        s.leases.get_mut(&id).unwrap().threads = 1;
        Ok(FinalizationPermit {
            governor: self.clone(),
            id,
        })
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
        self.changed.notify_waiters();
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
    async fn acquire(self: &Arc<Self>, background: bool, mib: u64) -> Result<Permit, String> {
        let waiting = {
            let mut s = self.state.lock().unwrap();
            if s.waiting >= 256 {
                return Err("Too many queued tasks; retry when current work finishes".into());
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
                    return Err(format!("Task requires at least {mib} MiB of working memory; increase the memory target"));
                }
                s.limits.task_threads.min(if background {
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
pub fn continue_finalization(id: u32) -> Result<FinalizationPermit, String> {
    governor().start_finalization(id)
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
        "Resources are busy. Stop playback or wait for other processing, then retry".to_string()
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
    s.playing = playing;
    s.pressured = pressured;
    s.critical = critical.unwrap_or(pressured);
    drop(s);
    governor().changed.notify_waiters();
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
            // Free pages exclude reclaimable caches (especially on macOS).
            // Admission needs usable RAM, not the OS's current free-page list.
            available_mib: system.available_memory() as f64 / 1048576.0,
        })
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
}

#[napi(object)]
pub struct ResourceMemorySample {
    pub process_mib: f64,
    pub available_mib: f64,
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
        assert!(sample.available_mib > 0.0);
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
