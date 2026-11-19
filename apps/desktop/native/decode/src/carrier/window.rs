//! Bounded byte frames in flight, one lease per frame. A lease covers a frame
//! from the moment the session emits it until the consumer hands it back; it is
//! not a GPU completion fence.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};

use super::runtime::SessionShared;
use crate::recover::LockExt;

#[derive(Default)]
struct WindowState {
    /// Last lease granted; the next grant counts on from here.
    next: u32,
    /// Leases in flight and the bytes each one covers.
    leases: HashMap<u32, usize>,
    bytes: usize,
    closed: bool,
}

/// Bounds a session's frames in flight by count and, optionally, by bytes.
/// Every frame takes a lease before it is emitted and the consumer returns it
/// by id, so a duplicate or stale return cannot widen the window.
pub(crate) struct ByteWindow {
    max_frames: usize,
    /// 0 = no byte bound.
    max_bytes: usize,
    state: Mutex<WindowState>,
    room: Condvar,
}

impl ByteWindow {
    /// `max_frames` is at least 1. A frame larger than `max_bytes` still gets a
    /// lease when nothing else is in flight, so a high resolution cannot
    /// deadlock the session; it then travels alone.
    pub fn new(max_frames: u32, max_bytes: usize) -> Self {
        Self {
            max_frames: max_frames.max(1) as usize,
            max_bytes,
            state: Mutex::new(WindowState::default()),
            room: Condvar::new(),
        }
    }

    /// A lease for a frame of `bytes`, or `None` when the window is full or
    /// closed. Never blocks.
    pub fn try_acquire(&self, bytes: usize) -> Option<u32> {
        let mut st = self.state.lock_recover();
        if st.closed || !self.fits(&st, bytes) {
            return None;
        }
        Some(grant(&mut st, bytes))
    }

    /// A lease for a frame of `bytes`, parking until there is room. `None` once
    /// the window is closed, including while parked.
    pub fn acquire(&self, bytes: usize) -> Option<u32> {
        let mut st = self.state.lock_recover();
        loop {
            if st.closed {
                return None;
            }
            if self.fits(&st, bytes) {
                return Some(grant(&mut st, bytes));
            }
            st = self.room.wait(st).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Hand a lease back. An unknown or already-returned lease changes nothing
    /// and returns `false`.
    pub fn release(&self, lease: u32) -> bool {
        let mut st = self.state.lock_recover();
        let Some(bytes) = st.leases.remove(&lease) else {
            return false;
        };
        st.bytes -= bytes;
        drop(st);
        self.room.notify_all();
        true
    }

    /// Refuse every later acquire and wake a parked one.
    pub fn close(&self) {
        self.state.lock_recover().closed = true;
        self.room.notify_all();
    }

    fn fits(&self, st: &WindowState, bytes: usize) -> bool {
        st.leases.len() < self.max_frames
            && (self.max_bytes == 0
                || st.leases.is_empty()
                || st.bytes.saturating_add(bytes) <= self.max_bytes)
    }
}

/// Leases are never 0 and never one still in flight, so a late return of an
/// old lease can only miss, never release a newer frame. At most `max_frames`
/// are in flight, so the search ends after a few steps.
fn grant(st: &mut WindowState, bytes: usize) -> u32 {
    loop {
        st.next = st.next.wrapping_add(1).max(1);
        if !st.leases.contains_key(&st.next) {
            break;
        }
    }
    st.leases.insert(st.next, bytes);
    st.bytes += bytes;
    st.next
}

/// Closing a session wakes a producer parked on its window.
impl SessionShared for ByteWindow {
    fn on_close(&self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    /// How long a test gives a parked acquire to show it is not parked. Only a
    /// negative reads after it: a slower machine makes the check weaker, never red.
    const PARKED: Duration = Duration::from_millis(100);

    #[test]
    fn frame_bound_holds_and_a_release_makes_room() {
        let w = ByteWindow::new(3, 0);
        let a = w.try_acquire(1).unwrap();
        w.try_acquire(1).unwrap();
        w.try_acquire(1).unwrap();
        assert_eq!(w.try_acquire(1), None, "a fourth frame exceeds max_frames");
        assert!(w.release(a));
        assert!(w.try_acquire(1).is_some(), "the returned lease made room");
    }

    #[test]
    fn byte_bound_holds_inclusively() {
        let w = ByteWindow::new(8, 100);
        w.try_acquire(60).unwrap();
        assert_eq!(w.try_acquire(41), None, "60 + 41 exceeds 100 bytes");
        assert!(
            w.try_acquire(40).is_some(),
            "60 + 40 fills the bound exactly"
        );
    }

    #[test]
    fn zero_max_bytes_bounds_frames_only() {
        let w = ByteWindow::new(2, 0);
        w.try_acquire(usize::MAX / 4).unwrap();
        w.try_acquire(usize::MAX / 4).unwrap();
        assert_eq!(w.try_acquire(1), None);
    }

    #[test]
    fn an_oversized_frame_travels_alone() {
        let w = ByteWindow::new(8, 100);
        let big = w
            .try_acquire(500)
            .expect("an empty window admits an oversized frame");
        assert_eq!(w.try_acquire(1), None, "nothing travels beside it");
        assert!(w.release(big));
        let small = w.try_acquire(1).unwrap();
        assert_eq!(
            w.try_acquire(500),
            None,
            "an oversized frame waits while anything else is in flight"
        );
        assert!(w.release(small));
    }

    #[test]
    fn duplicate_and_foreign_releases_do_not_widen_the_window() {
        let w = ByteWindow::new(2, 0);
        let a = w.try_acquire(1).unwrap();
        w.try_acquire(1).unwrap();
        assert!(w.release(a));
        assert!(
            !w.release(a),
            "a second return of the same lease is ignored"
        );
        assert!(!w.release(0), "0 is never a lease");
        assert!(!w.release(a.wrapping_add(1000)), "a lease never granted");
        w.try_acquire(1).unwrap();
        assert_eq!(
            w.try_acquire(1),
            None,
            "two leases in flight after the ignored returns"
        );
    }

    #[test]
    fn leases_skip_zero_and_in_flight_ids_across_wrap_around() {
        let w = ByteWindow::new(4, 0);
        let first = w.try_acquire(1).unwrap();
        assert_eq!(first, 1);
        w.state.lock_recover().next = u32::MAX - 1;
        assert_eq!(w.try_acquire(1), Some(u32::MAX));
        let wrapped = w.try_acquire(1).unwrap();
        assert_ne!(wrapped, 0, "0 is never granted");
        assert_ne!(
            wrapped, first,
            "a lease still in flight is never granted twice"
        );
    }

    #[test]
    fn a_release_wakes_a_parked_acquire() {
        let w = Arc::new(ByteWindow::new(1, 0));
        let held = w.acquire(1).unwrap();
        let w2 = Arc::clone(&w);
        let parked = thread::spawn(move || w2.acquire(1));
        thread::sleep(PARKED);
        assert!(!parked.is_finished(), "acquire returned on a full window");
        assert!(w.release(held));
        assert!(parked.join().unwrap().is_some());
    }

    #[test]
    fn close_wakes_a_parked_acquire_and_refuses_later_ones() {
        let w = Arc::new(ByteWindow::new(1, 0));
        w.acquire(1).unwrap();
        let w2 = Arc::clone(&w);
        let parked = thread::spawn(move || w2.acquire(1));
        thread::sleep(PARKED);
        assert!(!parked.is_finished(), "acquire returned on a full window");
        w.close();
        assert_eq!(
            parked.join().unwrap(),
            None,
            "the parked acquire woke empty"
        );
        assert_eq!(w.acquire(1), None);
        assert_eq!(w.try_acquire(1), None);
    }
}
