//! Stable, opaque, time-sortable identifiers for every addressable entity.
//!
//! Type aliases (not newtypes) match the data-model doc; promote to newtypes
//! when the type-confusion cost shows up in code review.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use uuid::Uuid;

pub type MediaId = Uuid;
pub type CompositionId = Uuid;
pub type TrackId = Uuid;
pub type LayerId = Uuid;
pub type KeyframeId = Uuid;
pub type MarkerId = Uuid;
pub type CheckpointId = Uuid;
pub type OpId = Uuid;
pub type TransitionId = Uuid;
pub type LinkId = Uuid;
pub type EffectId = Uuid;

pub fn new_id() -> Uuid {
    if det::ENABLED.load(Ordering::Relaxed) {
        let n = det::COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        Uuid::from_u128(n as u128)
    } else {
        Uuid::now_v7()
    }
}

/// Process-global deterministic id mode for the differential replay driver.
/// OFF in production (default). Not thread-local: the driver runs commands
/// serially, so a global counter yields a stable sequence across tokio threads.
pub mod det {
    use super::{AtomicBool, AtomicU64, Ordering};
    pub(super) static ENABLED: AtomicBool = AtomicBool::new(false);
    pub(super) static COUNTER: AtomicU64 = AtomicU64::new(0);
    pub fn enable() {
        ENABLED.store(true, Ordering::Relaxed);
    }
    pub fn disable() {
        ENABLED.store(false, Ordering::Relaxed);
    }
    pub fn reset() {
        COUNTER.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod det_tests {
    use super::*;

    /// Set in the child process that actually runs the deterministic body.
    const CHILD_ENV: &str = "WEFTCUT_DET_IDS_CHILD";

    /// `det` is process-wide and lib tests share one process on parallel
    /// threads: another test's `new_id()` would advance the counter between
    /// the assertions, and that test would mint counter ids that can collide
    /// with its own `Uuid::from_u128(n)` fixtures. So the body runs in a fresh
    /// copy of this test binary filtered to this one test; the parent process
    /// never turns deterministic mode on.
    #[test]
    fn deterministic_mode_counts_from_one() {
        if std::env::var_os(CHILD_ENV).is_some() {
            det::reset();
            det::enable();
            assert_eq!(new_id().to_string(), "00000000-0000-0000-0000-000000000001");
            assert_eq!(new_id().to_string(), "00000000-0000-0000-0000-000000000002");
            det::disable();
            return;
        }
        // libtest names tests by their path inside the crate, without the crate name.
        let (_crate, module) = module_path!().split_once("::").unwrap();
        let name = format!("{module}::deterministic_mode_counts_from_one");
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([name.as_str(), "--exact", "--test-threads=1"])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "child failed:\n{stdout}\n{stderr}");
        // A filter that matches nothing also exits 0; require that the body ran.
        assert!(
            stdout.contains("1 passed"),
            "child did not run the test:\n{stdout}\n{stderr}"
        );
    }
}
