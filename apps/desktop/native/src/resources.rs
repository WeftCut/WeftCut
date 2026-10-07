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
        let mut s = self.state.lock().unwrap();
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
            || mib.saturating_add(claim.mib) > s.limits.work_mib
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
                return Some(id);
            }
        }
    }
    fn release(&self, id: u32) {
        self.state.lock().unwrap().leases.remove(&id);
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
pub fn resources_reserve(threads: u32, memory_mib: u32) -> napi::Result<u32> {
    governor()
        .reserve(Claim {
            threads,
            mib: u64::from(memory_mib),
            background: false,
        })
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
pub fn resources_activity(playing: bool, pressured: bool) {
    let mut s = governor().state.lock().unwrap();
    s.playing = playing;
    s.pressured = pressured;
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
pub async fn resources_memory() -> napi::Result<f64> {
    tokio::task::spawn_blocking(|| {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
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
        Ok(owned
            .iter()
            .filter_map(|pid| system.process(*pid))
            .map(|process| process.memory())
            .sum::<u64>() as f64
            / 1048576.0)
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
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
