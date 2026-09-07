// The conform-format facts an audio effect chain has to agree with, on both
// sides of the process boundary.
//
// LANDMINE: both constants are TWINS of `native/src/jobs/conform.rs`
// (`CONFORM_FORMAT_VERSION`, `CONFORM_SAMPLE_RATE`) and must track it — no test
// enforces the match. A bake reads the conform body raw
// (`-skip_initial_bytes 28 -f f32le -ar <rate>`), so a wrong rate here silently
// resamples and a stale version bakes from a layout that no longer exists.
// See ADR 0063 and docs/audio.md § The conform cache.

/// Rides in the canonical chain string, so a conform-format bump invalidates
/// every baked sibling: re-conformed input is different audio under an
/// unchanged chain.
export const CONFORM_FORMAT_VERSION = 1;

/// The one lattice every audio time in a bake graph is expressed on. Trims are
/// counted in samples on it (see denoise's stage), never in seconds.
export const CONFORM_SAMPLE_RATE = 48_000;
