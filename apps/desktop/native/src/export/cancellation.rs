//! One admitted export per backend. Cancellation remains latched until the host
//! explicitly begins another job, including gaps between native stages.
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub struct ExportCancellation(Arc<Inner>);
#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
    active: AtomicUsize,
    changed: Notify,
}
pub struct Stage(ExportCancellation);
impl Drop for Stage {
    fn drop(&mut self) {
        self.0 .0.active.fetch_sub(1, Ordering::SeqCst);
        self.0 .0.changed.notify_waiters();
    }
}
impl ExportCancellation {
    pub fn begin(&self) -> Result<(), String> {
        if self.0.active.load(Ordering::SeqCst) != 0 {
            return Err("native export stage still active".into());
        }
        self.0.cancelled.store(false, Ordering::SeqCst);
        Ok(())
    }
    pub fn check(&self) -> anyhow::Result<()> {
        if self.is_cancelled() {
            anyhow::bail!("export cancelled");
        }
        Ok(())
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }
    pub fn stage(&self) -> Result<Stage, String> {
        self.0.active.fetch_add(1, Ordering::SeqCst);
        let stage = Stage(self.clone());
        self.check().map_err(|e| e.to_string())?;
        Ok(stage)
    }
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }
    pub async fn cancelled(&self) {
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            changed.await;
        }
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.0.active.load(Ordering::SeqCst) == 0 {
                return;
            }
            changed.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_is_latched_across_stages_and_waits_for_cleanup() {
        let state = ExportCancellation::default();
        let stage = state.stage().unwrap();
        state.cancel();
        state.cancelled().await;
        assert!(state.stage().is_err());
        assert!(state.begin().is_err());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), state.drained())
                .await
                .is_err()
        );
        drop(stage);
        state.drained().await;
        assert!(state.check().is_err());
        state.begin().unwrap();
        assert!(state.stage().is_ok());
    }
}
