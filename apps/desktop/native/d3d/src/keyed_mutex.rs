//! A shared texture's keyed mutex, held for one access and given back on every
//! path out of it.

use std::fmt;

use windows::core::{Interface, HRESULT};
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

/// `WAIT_TIMEOUT` as `IDXGIKeyedMutex::AcquireSync` returns it: the other side
/// still holds the key after the wait.
///
/// LANDMINE: this and `WAIT_ABANDONED` are non-negative, so windows-rs's safe
/// `AcquireSync` (`HRESULT::ok`) turns both into `Ok(())`, indistinguishable
/// from holding the key. [`KeyedMutexGuard::acquire`] calls the vtable entry
/// and classifies the raw code instead.
const WAIT_TIMEOUT: i32 = 0x102;

/// `WAIT_ABANDONED`: the previous holder's device went away while it held the
/// key. DXGI leaves the surface and its mutex inconsistent then.
const WAIT_ABANDONED: i32 = 0x80;

/// Why an acquisition did not grant the key. In every case the key is not held
/// and must not be released.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquireError {
    /// The other side still held the key when the wait ran out.
    Timeout,
    /// The previous holder abandoned the key; the surface is inconsistent.
    Abandoned,
    /// Any other code: a failure, the device removed among them.
    Failed(HRESULT),
}

impl AcquireError {
    /// What a raw `AcquireSync` return code means. Only `S_OK` grants the key.
    pub(crate) fn classify(hr: HRESULT) -> Result<(), Self> {
        match hr.0 {
            0 => Ok(()),
            WAIT_TIMEOUT => Err(Self::Timeout),
            WAIT_ABANDONED => Err(Self::Abandoned),
            _ => Err(Self::Failed(hr)),
        }
    }
}

impl fmt::Display for AcquireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => f.write_str("timed out"),
            Self::Abandoned => f.write_str("abandoned"),
            Self::Failed(hr) => write!(f, "{hr:?}"),
        }
    }
}

impl std::error::Error for AcquireError {}

/// One key of a keyed mutex, held by this thread. [`release`](Self::release)
/// gives it back and reports a failure; `Drop` gives it back when `release`
/// never ran, so an early return or a panic in the access does not leave the
/// texture locked for the other process.
pub struct KeyedMutexGuard<'a> {
    mutex: &'a IDXGIKeyedMutex,
    key: u64,
    held: bool,
}

impl<'a> KeyedMutexGuard<'a> {
    /// Takes `key` of `mutex`, waiting at most `timeout_ms`.
    ///
    /// # Safety
    /// `mutex` must belong to a texture on a device this thread may use.
    pub unsafe fn acquire(
        mutex: &'a IDXGIKeyedMutex,
        key: u64,
        timeout_ms: u32,
    ) -> Result<Self, AcquireError> {
        // Raw vtable call: see `WAIT_TIMEOUT`.
        let hr = (Interface::vtable(mutex).AcquireSync)(Interface::as_raw(mutex), key, timeout_ms);
        AcquireError::classify(hr)?;
        Ok(Self {
            mutex,
            key,
            held: true,
        })
    }

    /// Gives the key back.
    pub fn release(mut self) -> windows::core::Result<()> {
        self.held = false;
        // SAFETY: a guard exists only after this thread acquired the key; the
        // borrow keeps the COM object alive.
        unsafe { self.mutex.ReleaseSync(self.key) }
    }
}

impl Drop for KeyedMutexGuard<'_> {
    fn drop(&mut self) {
        if self.held {
            // SAFETY: as in `release`. Its error is moot on this path.
            let _ = unsafe { self.mutex.ReleaseSync(self.key) };
        }
    }
}
