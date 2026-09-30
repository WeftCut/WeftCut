---
status: accepted
---

# Preview demand and buffered pictures survive transport changes

A cold cut could clear the previous scene before its incoming video had a
texture. Separately, hardware readmission disposed a prewarmed software
session, including its decoded ring. Preloading could therefore finish and
still leave the cut waiting on a fresh decoder. The priority plan also omitted
Group instances, although composition and export already understood them.

Preview now uses one demand plan for active acquisition, upcoming preloading
and protected pool keys. It uses `forEachLayerInTime`, including Group trims
and instance paths, to request the source time actually visible at the cut.
Active demand is acquired before speculation, even on a first visit before
the compositor has created a sprite. The existing bounded speculation and
main-process hardware admission limits remain authoritative.

Before changing a populated scene, the node checks incoming video readiness,
recursing through Groups. A cold or backward-target clip without a usable
frame keeps the previous complete scene while its request progresses. Empty
timeline intervals still clear normally, unsupported clips still surface
their existing status, and initial mounting can draw non-video content while
waiting. This is picture continuity, not a clock stall: audio remains master,
and a held picture is still counted as a late layer.

The Standard engine refills from ring coverage. Its native transports already
decode a 500 ms horizon autonomously; another request is needed when forward
coverage falls below 150 ms, not on every display tick. Anchor eviction still
runs every tick, and the byte budget remains a separate capacity brake. Cold
opens in both engines discard superseded targets; the hardware transport also
deduplicates identical requests, explicitly re-armed after a ring flush.

After retained hardware leases have actually closed, a transient software
spill may retry hardware **inside the existing `FfmpegSource`**. Its ring and
sprite identity survive. No reclaimed capacity means no retry. Priority and
handle identity are checked again after the asynchronous closes. Callbacks
from a replaced transport cannot insert frames, report EOF or trigger recovery
on its replacement. Overlapping output replaces the old snapshot at the same
PTS, releasing its storage and preserving frame-fate accounting.

Trade-offs: the 150 ms low-water mark assumes the producer can refill faster
than playback under ordinary load; it cannot make an overloaded decoder real
time. A late incoming frame can briefly hold the previous composition. Neither
mechanism changes the GPU slot completion/ack contract, increases the hardware
budget, or changes export decode policy.

Regression coverage lives in `Compositor.decodePriority.test.ts`,
`previewDecodePriority.test.ts`, `FfmpegSource.test.ts`,
`SourceDecoderPool.test.ts`, `FrameRing.test.ts` and `GpuTransport.test.ts`.
The real hardware/software pixel-order gates remain
`e2e/electron/preview-gpu-order.spec.ts`.
