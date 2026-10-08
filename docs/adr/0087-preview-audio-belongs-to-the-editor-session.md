---
status: accepted
---

# Preview audio belongs to the editor session

## Context

Preview audio already used canonical conform PCM, shared envelope evaluation,
and an audio-master clock (ADR 0019). Its control path was still owned by the
picture: `PlaybackEngine.play` waited for video lookahead, `pause` set a flag
whose effect reached sources on the next Pixi tick, and `CompositionNode`
owned per-layer mixers. Closing Preview destroyed the audio graph. The UI's
playing boolean described intent even while the clock was held for video.

These were ownership and scheduling problems. Replacing the PCM format,
audio model or export mixer would not address them.

## Decision

- `PreviewAudioEngine` owns preview transport state, the clock, the graph,
  per-instance mixers, bounded PCM preparation, and cancellation. The editor
  session creates/registers it and disposes it at session end. Preview panels
  attach and detach presentation only. Project replacement stops the old
  schedule; a render-target change uses the existing Moment projection.
- `PlaybackEngine` is the visual attachment: it reads the session clock and
  forwards seek/state events to the compositor. `Compositor` and
  `CompositionNode` neither own nor schedule audio.
- A 16 ms timer replenishes a three-second Web Audio schedule independently of
  Pixi/rAF. It is still on the renderer's JavaScript thread: this is ownership
  decoupling, not real-time thread isolation. Native audio and AudioWorklet
  migration are deferred to a separate project.
- Play resumes the AudioContext and prepares PCM intersecting the first
  100 ms of the requested position before releasing one common clock anchor
  10 ms in the future. Video readiness is not a start gate. A missing conform
  stays preparing; a ten-second deadline or read/device failure yields an
  explicit error. Play retries failed source opens.
- Source windows are one second, with at most eight cached buffers and eight
  scheduled/pending sources per mixer. Preparation includes upcoming Audio
  layers and Groups through `forEachLayer`; no visual node must exist first.
  Mixers outside lookahead are released. Pause keeps completed in-window PCM
  for reuse but aborts pending reads and invalidates their scheduling slots.
  Internally cancelled preparation returns an unready result: initial Play
  retries it before releasing the clock, while the refill timer prepares the
  current window on its next tick. Retired mixers cannot fail the current
  transport. Genuine read/device failures still enter error and log the
  exception name/message as text for Electron diagnostics.
- Pause synchronously stops/disconnects every scheduled source. Seek, pause,
  project replacement and disposal invalidate the request generation before
  any asynchronous completion can schedule audio. An edit's monitor-only
  preview does not move the audio clock or publish a different Moment.
- Observable states are paused, preparing, playing and error. `playing` means
  the prepared schedule has been submitted against a running AudioContext;
  it does not claim that a physical speaker is already audible. Intent is
  separate so a second play/pause gesture cancels preparation.
- The session subscribes directly to project snapshots, audio bake state and
  Role gain overrides. It also owns UI meter sampling and the MCP meter push.
  The transport, meters, and edits keep working with Preview closed.
- ADR 0019's conform/envelope contract, ADR 0063's baked effects and ADR 0066's
  unity Role meter taps remain unchanged. Export still mixes in Rust.

## Verification and limits

Transport tests exercise real AudioMixer scheduling with controlled Web Audio
nodes and reads: preparation, immediate pause, stale completion, repeated
commands, seek, source/bake changes, gating, nested Group instances, retry,
timeout, device interruption and timeline end. The visual attachment test
checks that replacing a panel does not dispose or pause the session.

The Electron acceptance test stops the real Pixi ticker, plays real conform
PCM, pauses before deliberately blocking the UI thread, and checks graph
silence. It then closes Preview, controls playback without a panel, and
reopens it while playing. It also injects a real conform fetch failure, checks
the compact toolbar status and centered controls, then retries using Play.
Controlled reads cover cancellation on cache eviction and clip retirement.
Existing pan parity tests remain in place.

Diagnostics separate PCM/context preparation time, synchronous stop-command
handling time, and AudioContext base/output latency estimates. They do not
measure physical speaker latency. A blocked JavaScript thread can still delay
input delivery and refill; Web Audio can continue an already submitted
schedule. This remaining limitation is the scope of the deferred second step.
