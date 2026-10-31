---
status: accepted
---

# Audio effects are baked conform siblings, named by the chain that produced them

Date: 2026-09-08

## Context

- An ffmpeg audio filter graph over 48 kHz f32 runs at ~300× realtime (ten
  minutes of stereo in ~2 s). Rendering a whole clip up front is cheaper than a
  realtime insert and removes "what if it cannot keep up", where an audio
  dropout is worse than a dropped frame.
- Both mixers already read only the conform (ADR 0019). A processed file with
  the same header, rate, channel count and frame count is consumable by both
  unchanged.
- A persisted artifact path reads the same before and after its file
  disappears, so derived artifacts must not be written into the project.

## Decision

- An Audio layer's `audio.*` effects in `Layer.effects` are rendered once,
  offline, by ffmpeg from the media conform into a sibling
  `Cache/audio/{media_hash}.fx-{sig16}.conform` (plus
  `Cache/waveforms/{media_hash}.fx-{sig16}.v4.peaks`). Both mixers read the
  sibling. Visual effects stay per-frame Pixi filters (ADR 0027).
- The name is a pure function of (media hash, conform format version,
  effective chain): sha256 of a canonical string computed only in TS. Equal
  chains on the same media share one artifact; an empty effective chain plays
  the raw conform. Nothing about bake state is persisted; disk existence is
  the truth.
- The bake must preserve frame count exactly (1:1 sample alignment, so readers
  use the raw conform's offsets); a graph that changes it fails. All bake-graph
  times are counted in samples.
- The effect catalog is TS; Rust exposes only generic primitives (measure RMS,
  bake a `filter_complex`, build peaks) and inspects neither graph nor
  signature.
- Effects run before clip gain, pan, fades and role gain, so mix edits never
  re-bake. Audio effect params are static (no keyframes).
- Preview is stale-while-revalidate; export waits and refuses rather than
  falling back to unprocessed audio.

## Consequences

- One conform-sized file per distinct chain (~230 MB per ten stereo minutes).
  `.fx-*` siblings are LRU units; the canonical conform beside them is not.
  Cache hits refresh mtime so a playing artifact does not age out.
- One file serves preview and export, so one measurement of an export verifies
  what the preview plays.
- Adding an effect is one TS catalog entry; no Rust, IPC, undo or schema work.

Rejected: realtime insert (AudioWorklet or in-mixer DSP, per effect on both
engines); a typed `AudioParams.effects` map (`Layer.effects` already has the
command/undo/MCP surface); baking only affected spans (needs a conform format
with a start frame); persisting the artifact path.
