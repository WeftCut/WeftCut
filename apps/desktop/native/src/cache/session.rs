//! Workspace lifetime, shared by frozen job snapshots.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[derive(Debug)]
pub struct Session {
    pub generation: u32,
    cancelled: AtomicBool,
    changed: tokio::sync::Notify,
}
impl Session {
    pub fn new(generation: u32) -> Self {
        Self {
            generation,
            cancelled: AtomicBool::new(false),
            changed: tokio::sync::Notify::new(),
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
    pub async fn cancelled(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}
pub(super) struct ScopedEvents {
    pub cache: super::CacheLayout,
    pub events: Arc<dyn crate::events::EventSink>,
}
impl crate::events::EventSink for ScopedEvents {
    fn emit(&self, event: &str, mut payload: serde_json::Value) {
        if self.cache.is_cancelled() {
            return;
        }
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "workspace_generation".into(),
                self.cache.generation().into(),
            );
        } else if payload.is_array() {
            payload = serde_json::json!({"workspace_generation": self.cache.generation(), "entries": payload});
        }
        self.events.emit(event, payload);
    }
}
