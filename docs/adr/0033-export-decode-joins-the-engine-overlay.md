---
status: accepted
---

# Export decode joins the engine overlay; the native lane is a credit-windowed session that never falls back mid-export

Date: 2026-08-05

## Context

- WebCodecs-only export decode sent every WebCodecs-blind source (ProRes,
  DNxHD, MPEG-2, VC-1) through its lossy libx264 full proxy, a generation loss
  preview had already removed.
- Preview decode is best-effort realtime (anchor + pump, frames may drop).
  Export needs exactly-once coverage of a presentation range for an encode loop
  that must never see a gap.
- Native frames cross main → renderer → Worker; unbounded production would
  hold hundreds of MB of 4K 10-bit frames in main.
- After the routing decision the full-proxy wait is skipped, so a fallback
  proxy may not exist.

## Decision

- **Routing is resolved once, at export start.** `ExportSettings.decodeEngine`
  (`auto`/`ffmpeg`/`webcodecs`) is persisted intent, independent of
  `encoderEngine`. `resolveExportDecodeRouting` is pure (setting × component
  presence × composite bit depth × persisted route) and emits a per-media table
  that rides the Worker init; the Worker is policy-free and nothing re-resolves.
  `auto` routes only `native-sw` routes native; an `ffmpeg` pin routes every
  source native as a fidelity promise; a missing component degrades the pin to
  `auto`.
- **A dedicated session API** (`export_sw`: `open`, `decodeRange(a, b)`,
  `close`). Rust owns GOP walking, reorder and EOS drain, and emits the range in
  presentation order.
- **Credit-window backpressure** (`DEFAULT_CREDIT_WINDOW` = 6). The producer
  parks with no credits; the consumer returns one credit per frame that leaves
  the export ring (consumed, evicted or freed). Credit returns bypass the
  command channel.
- **One ordered in-band channel.** Frames and control (`ExportSwMsg`:
  `frame`/`rangeEnd`/`ended`/`error`) travel together, relayed verbatim.
  `rangeEnd` is the presentation-finality proof that lets `ExportFrameStore`
  settle a target left in a one-microsecond timestamp-conversion gap. `decodeRange` dispatch never awaits
  `rangeEnd`, which would block credit returns and deadlock.
- **A backward range starts a new generation**: old frames, finality proof and
  credits are released before the re-seek.
- **Transport format follows the composite depth** (NV12 at 8-bit, I420P10 at
  10-bit, table-wide); frames convert in owned shaders (ADR 0032). The lane is
  software-only.
- **No mid-export fallback** across engines or sources. Seek overshoot is
  retried inside Rust; any surfaced session error fails the export ring loudly.

## Consequences

- Blind-spot sources export from originals: the ProRes differential gate holds
  native above proxy (SSIM 0.931 vs 0.892); wedge gates assert
  `nativeHandles ≥ 1` so a silent proxy fallback cannot pass.
- A `webcodecs` pin preserves the pre-overlay behavior, including the
  full-proxy wait for blind spots.
- One export opens one session per phase group; main keeps a registry so a
  renderer crash cannot strand decode threads (`closeAllExportSw`).
- 4:2:2 chroma halves before compositing (swscale to I420P10); a faithful
  ProRes 422 path needs a 4:2:2 transport format.
- Not built: one same-engine session rebuild before abort, and an abort
  message naming the source and suggesting a Lite re-run.

Rejected: reusing the preview anchor/pump protocol (cannot express
exactly-once); pull-per-frame (serializes decode behind encode); coupling
decode to `encoderEngine` (the two fail independently); silent proxy fallback
on session error (breaks the pin's promise; the proxy may not exist).
