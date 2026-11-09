//! The Motif core's per-process state on every OS: the tuning main hands it
//! (`motif_configure`), the band threads, the band buffers readers share, the
//! blocking-pool hop of its async exports. It depends on no other Motif
//! module but the error codes.
use crate::motif_error::to_napi;
use napi_derive::napi;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Threads one frame's bands share. Main resolves the count from the machine
/// (`bandThreadDivisor`, `maxBandThreads` in `src/shared/motifs/tuning.ts`)
/// and sets it with `motif_configure`; one until then.
static BAND_THREADS: AtomicUsize = AtomicUsize::new(1);

pub(crate) fn band_threads() -> usize {
    BAND_THREADS.load(Ordering::Relaxed)
}

#[napi(object)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type.
pub struct MotifConfig {
    /// `scratchIdleBytes` in `src/shared/motifs/tuning.ts`.
    pub scratch_idle_bytes: u32,
    /// The band thread count main resolved; zero counts as one.
    pub band_threads: u32,
}

/// Sets this process's share of the Motif tuning; main and the reader utility
/// each call it once, before their first frame read or write.
#[napi]
#[cfg_attr(test, allow(dead_code))] // napi registration is absent in a Rust unit-test executable.
pub fn motif_configure(config: MotifConfig) {
    configure(
        config.scratch_idle_bytes as usize,
        config.band_threads as usize,
    );
}

fn configure(scratch_idle_bytes: usize, band_threads: usize) {
    BAND_THREADS.store(band_threads.max(1), Ordering::Relaxed);
    SCRATCH.set_limit(scratch_idle_bytes);
}

/// Runs `work` on every item across at most `threads` threads; the first
/// failure wins. Results keep the items' order.
pub(crate) fn per_thread<I: Send, T: Send>(
    items: impl Iterator<Item = I>,
    threads: usize,
    work: impl Fn(I) -> anyhow::Result<T> + Sync,
) -> anyhow::Result<Vec<T>> {
    let items: Vec<I> = items.collect();
    let count = items.len();
    let threads = threads.clamp(1, count.max(1));
    let mut groups: Vec<Vec<(usize, I)>> = (0..threads).map(|_| Vec::new()).collect();
    for (i, item) in items.into_iter().enumerate() {
        groups[i % threads].push((i, item));
    }
    std::thread::scope(|s| {
        let work = &work;
        let handles: Vec<_> = groups
            .into_iter()
            .map(|group| {
                s.spawn(move || {
                    group
                        .into_iter()
                        .map(|(i, item)| work(item).map(|t| (i, t)))
                        .collect::<anyhow::Result<Vec<_>>>()
                })
            })
            .collect();
        let mut out: Vec<Option<T>> = (0..count).map(|_| None).collect();
        for handle in handles {
            for (i, t) in handle
                .join()
                .map_err(|_| anyhow::anyhow!("motif band thread panicked"))??
            {
                out[i] = Some(t);
            }
        }
        Ok(out
            .into_iter()
            .map(|t| t.expect("every item ran"))
            .collect())
    })
}

/// Band buffers kept between reads. A fresh buffer faults in every page, which
/// at 4K costs as much as decompressing into it. Idle buffers stay under
/// `limit` bytes in all, however many readers read; a band that does not fit
/// is allocated per read. The last `ScratchHold` to go frees them.
pub(crate) struct Scratch {
    kept: std::sync::Mutex<Vec<Vec<u8>>>,
    limit: AtomicUsize,
    holders: AtomicUsize,
}

/// Keeps nothing until `motif_configure` sets `scratchIdleBytes`.
pub(crate) static SCRATCH: Scratch = Scratch::new(0);

impl Scratch {
    const fn new(limit: usize) -> Self {
        Self {
            kept: std::sync::Mutex::new(Vec::new()),
            limit: AtomicUsize::new(limit),
            holders: AtomicUsize::new(0),
        }
    }

    /// A lower limit drops the kept buffers rather than choosing among them.
    fn set_limit(&self, limit: usize) {
        if self.limit.swap(limit, Ordering::Relaxed) > limit {
            self.clear();
        }
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, Vec<Vec<u8>>> {
        self.kept
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Runs `work` on `len` bytes of the smallest kept buffer that is long
    /// enough, else the longest, grown. The bytes hold whatever an earlier read
    /// left: `work` overwrites every one it hands on.
    pub(crate) fn with<T>(&self, len: usize, work: impl FnOnce(&mut [u8]) -> T) -> T {
        let mut buffer = {
            let mut kept = self.kept();
            let fits = (0..kept.len())
                .filter(|&i| kept[i].len() >= len)
                .min_by_key(|&i| kept[i].len());
            fits.or_else(|| (0..kept.len()).max_by_key(|&i| kept[i].len()))
                .map(|i| kept.swap_remove(i))
                .unwrap_or_default()
        };
        if buffer.len() < len {
            buffer.resize(len, 0);
        }
        let out = work(&mut buffer[..len]);
        let mut kept = self.kept();
        if kept.iter().map(Vec::len).sum::<usize>() + buffer.len()
            <= self.limit.load(Ordering::Relaxed)
        {
            kept.push(buffer);
        }
        out
    }

    fn clear(&self) {
        self.kept().clear();
    }

    #[cfg(test)]
    pub(crate) fn holders(&self) -> usize {
        self.holders.load(Ordering::SeqCst)
    }

    fn hold(&'static self) -> ScratchHold {
        self.holders.fetch_add(1, Ordering::SeqCst);
        ScratchHold(self)
    }
}

/// A reader's claim on the kept band buffers, a frame file reader's or an
/// upload pool's: while one is held the process keeps up to
/// `scratchIdleBytes` of them, and dropping the last frees them.
/// A read in flight holds one too, so buffers it returns after its reader
/// closed are freed with it.
pub(crate) struct ScratchHold(&'static Scratch);

impl ScratchHold {
    pub(crate) fn new() -> Self {
        SCRATCH.hold()
    }
}

impl Drop for ScratchHold {
    fn drop(&mut self) {
        if self.0.holders.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.clear();
        }
    }
}

/// Runs `work` on the blocking pool. A failure keeps its `[motif:<code>]`
/// tag; a panic there comes back untagged, as the caller's error.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> napi::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))?
        .map_err(to_napi)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motif_error::{coded, MotifCode};

    #[test]
    fn shared_threads_keep_the_items_order_and_report_the_first_failure() {
        for threads in [1, 2, 3, 8, 20] {
            let out = per_thread(0..8, threads, |i| Ok(i * 10)).unwrap();
            assert_eq!(
                out,
                (0..8).map(|i| i * 10).collect::<Vec<_>>(),
                "{threads} threads"
            );
            let error = per_thread(0..8, threads, |i| {
                anyhow::ensure!(i != 5, "item {i}");
                Ok(i)
            });
            assert_eq!(error.unwrap_err().to_string(), "item 5");
        }
        assert!(per_thread(std::iter::empty::<u8>(), 2, Ok)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn scratch_reuses_the_closest_buffer_and_keeps_at_most_its_limit() {
        let scratch = Scratch::new(100);
        let address = scratch.with(60, |b| b.as_ptr());
        // Shorter fits the kept buffer; longer grows it.
        assert_eq!(scratch.with(10, |b| (b.len(), b.as_ptr())), (10, address));
        assert_eq!(scratch.with(80, |b| b.len()), 80);
        assert_eq!(scratch.kept().iter().map(Vec::len).sum::<usize>(), 80);
        // Two at once: the second is fresh, and keeping both would pass 100.
        scratch.with(80, |_| scratch.with(30, |_| ()));
        let kept: Vec<usize> = scratch.kept().iter().map(Vec::len).collect();
        assert_eq!(kept, [30]);
        // The smallest that fits, not the first.
        scratch.clear();
        scratch.with(50, |_| scratch.with(20, |_| ()));
        let mut kept: Vec<(usize, *const u8)> = scratch
            .kept()
            .iter()
            .map(|b| (b.len(), b.as_ptr()))
            .collect();
        kept.sort();
        let [(20, small), (50, large)] = kept[..] else {
            panic!("{kept:?}")
        };
        assert_eq!(scratch.with(10, |b| b.as_ptr()), small);
        assert_eq!(scratch.with(30, |b| b.as_ptr()), large);
        // Over the limit alone: used, never kept.
        scratch.with(500, |b| assert_eq!(b.len(), 500));
        assert!(scratch.kept().iter().all(|b| b.len() <= 100));
        scratch.clear();
        assert!(scratch.kept().is_empty());
    }

    #[test]
    fn a_lower_scratch_limit_drops_the_kept_buffers() {
        let scratch = Scratch::new(100);
        scratch.with(60, |_| ());
        scratch.set_limit(200);
        assert_eq!(scratch.kept().len(), 1);
        scratch.set_limit(50);
        assert!(scratch.kept().is_empty());
        scratch.with(60, |_| ());
        assert!(scratch.kept().is_empty());
    }

    #[test]
    fn the_last_hold_to_go_frees_the_kept_buffers() {
        let scratch: &'static Scratch = Box::leak(Box::new(Scratch::new(100)));
        let (first, second) = (scratch.hold(), scratch.hold());
        scratch.with(60, |_| ());
        drop(first);
        assert_eq!(scratch.kept().len(), 1, "another hold keeps them");
        drop(second);
        assert!(scratch.kept().is_empty());
        let again = scratch.hold();
        scratch.with(60, |_| ());
        assert_eq!(scratch.kept().len(), 1);
        drop(again);
        assert!(scratch.kept().is_empty());
    }

    #[test]
    fn configure_sets_the_band_threads_and_the_idle_scratch() {
        // The process-wide statics: end on the unconfigured values, which
        // every other test also runs correctly under.
        configure(64 << 20, 3);
        assert_eq!(band_threads(), 3);
        assert_eq!(SCRATCH.limit.load(Ordering::Relaxed), 64 << 20);
        configure(0, 0);
        assert_eq!(band_threads(), 1);
        assert_eq!(SCRATCH.limit.load(Ordering::Relaxed), 0);
        assert!(SCRATCH.kept().is_empty());
    }

    #[tokio::test]
    async fn a_blocking_failure_keeps_its_tag_and_a_panic_is_untagged() {
        let miss = blocking(|| -> anyhow::Result<()> {
            Err(coded(MotifCode::Miss, anyhow::anyhow!("absent")))
        })
        .await
        .unwrap_err();
        assert_eq!(miss.reason, "[motif:miss] absent");
        let panicked = blocking(|| -> anyhow::Result<()> { panic!("synthetic") })
            .await
            .unwrap_err();
        assert!(
            !panicked.reason.starts_with("[motif:"),
            "{}",
            panicked.reason
        );
    }
}
