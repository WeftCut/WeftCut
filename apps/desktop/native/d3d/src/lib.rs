//! The D3D11 pieces the decode addon's GPU preview (`decode/src/preview_gpu`)
//! and the core addon's Motif transport (`src/d3d.rs`, `src/motif_gpu.rs`)
//! share: [`SharedTexture`], a texture another process opens by its NT handle;
//! [`KeyedMutexGuard`], that texture's keyed mutex held across one access; the
//! handle's wire bytes; and the adapter LUID string.
//!
//! Does not create devices: the decode addon draws on ffmpeg's d3d11va device,
//! the core addon builds its own.
#![cfg(windows)]

mod keyed_mutex;
mod texture;

pub use keyed_mutex::{AcquireError, KeyedMutexGuard};
pub use texture::{CreateError, SharedTexture};

use windows::Win32::Foundation::{HANDLE, LUID};

/// An NT handle as it crosses to JS: its value in 8 little-endian bytes.
pub fn handle_to_bytes(handle: HANDLE) -> [u8; 8] {
    (handle.0 as usize as u64).to_le_bytes()
}

/// The handle `bytes` carry, or `None` unless they are exactly 8 bytes.
pub fn handle_from_bytes(bytes: &[u8]) -> Option<HANDLE> {
    let bits: [u8; 8] = bytes.try_into().ok()?;
    Some(HANDLE(u64::from_le_bytes(bits) as usize as *mut _))
}

/// An adapter's LUID as `high:low`, each part eight lowercase hex digits.
///
/// LANDMINE: the GPU preview's decoder adapter and the core addon's hardware
/// probe both report this string, and the settings page matches one against
/// the other; a second formatter would let them drift apart.
pub fn luid_string(luid: LUID) -> String {
    format!("{:08x}:{:08x}", luid.HighPart as u32, luid.LowPart)
}

#[cfg(test)]
mod tests;
