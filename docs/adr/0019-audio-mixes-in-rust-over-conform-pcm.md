---
status: accepted
---

# Audio mixes in Rust over a 48 kHz float conform cache

Date: 2026-06-10

## Context

Preview (Chromium decode, OS mixing of `<audio>` elements) and export (ffmpeg
lavfi `amix`) were two unrelated engines fed by two decoders, so `gain_db`,
`pan` and fades could not be made to agree, and `amix=normalize=0` hard-clipped
overlapping layers. A survey of desktop NLEs (Premiere, FCP, MLT, GES, Ardour,
Remotion, OpenCut) found: the canon is one declarative model with two thin
renderers; `OfflineAudioContext` allocates the full result buffer up front
(~1.4 GB per stereo hour, not bounded by `suspend()`); a conform-at-import cache
in the engine's working format (Premiere's CFA) removes per-use decode and
resample cost; float mixing with a single quantization and an explicit limiter
is the standard clipping answer.

## Decision

- **Conform cache.** Every audio-bearing source is converted once at import to
  48 kHz, f32, interleaved, channels capped at 2 (mono stays mono), in
  `Cache/audio/{blake3}.conform`. Preview and export read only conform: preview
  by `weftcut-media://` Range windows with no renderer decode, export by direct
  frame-offset reads.
- **Envelope contract.** Gain (dB → linear, times fade ramps) and pan are
  sampled on a 10 ms grid by the shared eval leaf; both renderers linearly
  interpolate the same control points (Web Audio `setValueCurveAtTime`, Rust
  per sample). Parity is by construction, guarded by cross-language goldens.
- **Preview** is a buffer-scheduled Web Audio graph driven by the audio clock.
- **Export** mixes f32 blocks in Rust from a `MixPlan`; ffmpeg only encodes,
  behind an always-on `alimiter` (−1 dB sample peak, auto-normalize off).

## Consequences

- Disk: ~1.4 GB per stereo source-hour (half for mono) on top of proxies,
  accepted for a zero-decode read path on both sides. The canonical conform is
  never LRU-swept (re-creating it is a full decode).
- Export audio is deterministic f32 math over deterministic bytes, so
  conformance asserts analytically (envelope RMS, channel ratios, summing).
- The envelope sampler and pan law are cross-language twins under golden
  fixtures.
- Import and export readiness wait on the conform job.

Rejected:

- **lavfi expression graph** (`volume='if(…)':eval=frame`, `afade`, `pan`):
  stepped per-frame gain, expression-size limits forcing quantization, and a
  linear-ramp preview that never matches the stepped export.
- **`OfflineAudioContext` export:** full-length upfront buffer; segmenting loses
  node state at seams.
- **All-TS export mix** (`decodeAudioData` in the export Worker): RAM scales
  with source size; the Worker has no Web Audio graph.
- **Native-rate conform:** pushes resampling into every playback and export.
