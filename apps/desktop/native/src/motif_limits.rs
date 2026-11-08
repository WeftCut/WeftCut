//! The fixed sizes a Motif frame, GPU texture and pool must fit. One source
//! for the native core; `src/shared/motifs/limits.ts` mirrors it and main
//! checks the two agree when it loads the addon (docs/motifs.md#limits).
use napi_derive::napi;

/// The largest width or height of a stored frame, in pixels.
pub(crate) const MAX_DIMENSION: u32 = 8192;
/// A stored frame's straight RGBA bytes: `MAX_DIMENSION²` at four bytes a pixel.
pub(crate) const MAX_FRAME_BYTES: u32 = 256 * 1024 * 1024;
/// One GPU allocation: a pool's slots plus its staging texture, or an OSR
/// texture read back. Half a full-size 8K frame: such a frame takes the
/// utility lane and the bitmap host instead.
pub(crate) const MAX_TEXTURE_BYTES: u32 = 128 * 1024 * 1024;
/// Slots one GPU pool may hold.
pub(crate) const MAX_POOL_SLOTS: u32 = 4;

/// Whether `textures` RGBA8 textures of `width × height` fit `MAX_TEXTURE_BYTES`.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows GPU paths allocate textures.
pub(crate) fn textures_fit(width: u32, height: u32, textures: u32) -> bool {
    width > 0
        && height > 0
        && u64::from(width) * u64::from(height) * 4 * u64::from(textures)
            <= u64::from(MAX_TEXTURE_BYTES)
}

#[napi(object)]
#[cfg_attr(test, allow(dead_code))] // Host-only wire type; main compares it with `MOTIF_LIMITS`.
pub struct MotifLimits {
    pub max_dimension: u32,
    pub max_frame_bytes: u32,
    pub max_texture_bytes: u32,
    pub max_pool_slots: u32,
}

/// The limits this addon was built with, for main's check against its mirror.
#[napi]
#[cfg_attr(test, allow(dead_code))] // napi registration is absent in a Rust unit-test executable.
pub fn motif_limits() -> MotifLimits {
    MotifLimits {
        max_dimension: MAX_DIMENSION,
        max_frame_bytes: MAX_FRAME_BYTES,
        max_texture_bytes: MAX_TEXTURE_BYTES,
        max_pool_slots: MAX_POOL_SLOTS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limits_are_their_mirrors_values() {
        // LANDMINE: twin of `src/shared/motifs/limits.test.ts`; change both.
        assert_eq!(MAX_DIMENSION, 8192);
        assert_eq!(MAX_FRAME_BYTES, 256 * 1024 * 1024);
        assert_eq!(MAX_TEXTURE_BYTES, 128 * 1024 * 1024);
        assert_eq!(MAX_POOL_SLOTS, 4);
        assert_eq!(
            u64::from(MAX_DIMENSION) * u64::from(MAX_DIMENSION) * 4,
            u64::from(MAX_FRAME_BYTES)
        );
    }

    #[test]
    fn textures_fit_up_to_exactly_the_texture_bytes() {
        assert!(textures_fit(8192, 4096, 1));
        assert!(!textures_fit(8192, 4097, 1));
        assert!(textures_fit(4096, 4096, 2));
        assert!(!textures_fit(4096, 4097, 2));
        assert!(!textures_fit(8192, 8192, 1));
        assert!(!textures_fit(0, 1, 1));
        assert!(!textures_fit(1, 0, 1));
    }
}
