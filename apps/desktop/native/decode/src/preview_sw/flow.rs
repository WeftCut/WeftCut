//! Credits cover native -> napi -> Electron IPC -> renderer acceptance. The
//! frame cache has its own budget; a receipt is not a GPU completion fence.
use crate::recover::LockExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

#[derive(Default)]
struct Credits {
    enabled: bool,
    next: u32,
    frames: HashMap<u32, usize>,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct PreviewFlow {
    pub request_id: AtomicU32,
    credits: Mutex<Credits>,
}

impl PreviewFlow {
    pub fn enable(&self) {
        self.credits.lock_recover().enabled = true;
    }

    pub fn enabled(&self) -> bool {
        self.credits.lock_recover().enabled
    }

    pub fn current(&self, request_id: u32) -> bool {
        self.request_id.load(Ordering::Acquire) == request_id
    }

    pub fn acquire(&self, bytes: usize) -> Option<u32> {
        let mut c = self.credits.lock_recover();
        if !c.enabled {
            return Some(0); // standalone native callers retain the legacy contract
        }
        // One oversized frame is allowed so high resolutions cannot deadlock.
        // At most one additional decoded frame is held by the session cursor.
        if c.frames.len() >= 8
            || (!c.frames.is_empty() && c.bytes.saturating_add(bytes) > 32 * 1024 * 1024)
        {
            return None;
        }
        loop {
            c.next = c.next.wrapping_add(1).max(1);
            if !c.frames.contains_key(&c.next) {
                break;
            }
        }
        let token = c.next;
        c.frames.insert(token, bytes);
        c.bytes += bytes;
        Some(token)
    }

    pub fn release(&self, token: u32) -> bool {
        let mut c = self.credits.lock_recover();
        if let Some(bytes) = c.frames.remove(&token) {
            c.bytes -= bytes;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_receipts_bound_bytes_and_frames_without_duplicate_credit() {
        let f = PreviewFlow::default();
        f.enable();
        let a = f.acquire(12 * 1024 * 1024).unwrap();
        let b = f.acquire(12 * 1024 * 1024).unwrap();
        assert!(f.acquire(12 * 1024 * 1024).is_none());
        assert!(f.release(a));
        assert!(!f.release(a));
        assert!(f.acquire(12 * 1024 * 1024).is_some());
        assert!(f.release(b));
        let f = PreviewFlow::default();
        f.enable();
        for _ in 0..8 {
            assert!(f.acquire(1).is_some());
        }
        assert!(f.acquire(1).is_none());
    }
    #[test]
    fn seek_does_not_forgive_unreceived_frames_and_large_frames_make_progress() {
        let f = PreviewFlow::default();
        f.enable();
        let token = f.acquire(64 * 1024 * 1024).unwrap();
        f.request_id.store(2, Ordering::Release);
        assert!(!f.current(1));
        assert!(f.current(2));
        assert!(f.acquire(1).is_none());
        f.release(token);
        assert!(f.acquire(64 * 1024 * 1024).is_some());
    }
}
