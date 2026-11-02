# Export WebCodecs tail alignment — findings (2026-07-22/23)

Closed investigation of three platform-specific export-tail symptoms. Kept
because the platform facts below are still relied on and the workarounds look
removable without them.

## Findings

- **Linux "tail +1" (closed by non-reproduction).** The Lite/WebCodecs proxy
  leg of `export-prores-fidelity.spec.ts` gate B once had a tail sample
  best-match `source[N+1]`. On the original Linux/RTX 3050 host (Electron
  42.4.1, ffmpeg n7.1) on main: 10/10 runs passed (300 frames on both legs,
  every sample aligned), plus 9/9 on 24/25/50/60, 30000/1001, 60000/1001,
  start PTS 3.2 s, B-frames + edit list, and a mid-frame range end. The failure
  left no artifacts, so the root cause is unproven. Likely fixes: the
  `REORDER_MARGIN` lead-in and the frame-identity rework below. VFR is not
  covered; the analyzer and the composition grid assume CFR.
- **Frame identity bug (fixed, deterministic N→N+1 shape).** The export store
  evicted on `pts + duration <= target`. Independently quantized durations
  left a 1 µs gap (PTS 66 666, next 100 000, target 99 999), which evicted the
  lower neighbour so `frameAt()` returned the future frame. Now: identity is
  the greatest `PTS <= target`, eviction keeps that lower neighbour, and
  readiness needs an exact PTS, a strictly later PTS, or EOS. A stable −1 µs
  target/PTS difference on every third 30 fps frame is normal and harmless.
- **One clock.** Mediabunny 1.45.4 truncates seconds to microseconds
  (`microsecondTimestamp`) while the old dispatch code rounded, so one packet
  could be scheduled at 0 µs and emitted at −1 µs. `DecodeClock` now derives
  scheduling from the actual `EncodedVideoChunk` timestamp, and the native
  adapters share Rust `media_time` with TS/Rust golden vectors. Mediabunny's
  public packet API is still float seconds, a remaining precision boundary.
- **macOS reorder-tail hold-back.** Chromium's macOS prefer-software H.264
  decoder withholds the last 2 frames of each fed window (4 with B-frames) even
  with `-bf 0` input. This is legal WebCodecs behavior: pending output may wait
  for more input, only `flush()` must drain, and `decodeQueueSize === 0` does
  not mean the output is complete. `REORDER_MARGIN = 16` extra packets is an
  empirical bound, not a spec guarantee. Flush only at true EOS, concurrently
  with consumers releasing frames; awaiting flush inside `decodeRange()` can
  deadlock on pool slots.
- **Linux hardware frames read black.** On the Linux/NVIDIA host, hardware BGRA
  `VideoFrame`s read as pure black through `drawImage`, `createImageBitmap`,
  WebGL and `copyTo()`, in a Window or a Worker; software I420 was correct.
  This is a Chromium/driver interop defect; `preferSoftware` is the
  correctness fallback.
- **The `hardwareAcceleration` hint is mandatory in Chromium.** A
  `prefer-hardware` encoder request fails outright where no hardware encoder
  exists (all Linux), so the export omits the hint unless the user pins
  software (`encoderHwHint`).

## If a tail misalignment reappears

Capture in one run: source/proxy/output `ffprobe -show_packets -show_frames`;
per tail grid point, the target PTS, the ring's lower/future entries before and
after eviction, the selected frame and which readiness branch released the
waiter; encoder input and output timestamps. Repeat ≥10 times: a stable offset
points to a deterministic boundary bug, a drifting one to a timing race.
