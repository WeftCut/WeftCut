---
status: accepted
---

# Motif preview retains useful work while demand advances

A 60 fps composite can repeatedly submit an unchanged Motif texture. Local
transition traces reproduced 310–477 ms holds, with content 19–29 frames behind,
while submission p99 stayed around 19 ms. Exact-target acceptance treated every
forward playback tick as a discontinuity: an ordinary asynchronous result was
already obsolete on arrival. Composite FPS alone did not expose the failure.

Each MotifSprite owns a MotifPlaybackCursor. Its interface accepts a descriptor
and playback state, invalidates a discontinuity, exposes a diagnostic snapshot,
and disposes its subscription. It owns demand coalescing, request epochs, frame
selection and retry backoff. The sprite owns texture updates and bitmap pins;
the existing FrameBroker owns shared acquisition, cancellation and owned clones.
No scheduler or request state is distributed among the callers.

During forward playback, one request is admitted per instance and subsequent
demand replaces a single latest target. A completed frame may advance the
visible bitmap even after demand has moved forward. Cache hits can overtake
that request; neither an older result nor its failure can roll back or delay
the newer binding. A miss can use a newer cached frame within three frames of
the target while still requesting the exact target. Selection never displays
a future frame or moves backwards during continuous forward playback.

Pause, seek (including a seek to the same target), content identity changes,
overlay changes, suspension and disposal revoke the old subscription. The
broker cancels only that subscriber; another preview or bake sharing the
producer retains ownership. A stale owned result is closed. Each instance has
its own subscription key, including repeated placements of the same Group.
Paused/scrubbing demand accepts only the exact target. Export keeps its existing
exact injected-frame path. Retry backoff remains finite and recoverable.

MotifFrameService admits prewarm content visible now or within the next 500 ms.
The existing composition walk supplies Group-trimmed root spans; future content
is sampled at its actual entry time. Baking still sees the whole timeline.
Prewarm plans share the existing byte cap by content identity and round-robin
different instance windows of that identity. Three recent frames remain eligible
for late completions. A frame that cannot fit its share gets no speculative
allocation. The existing live-capture limit and three-read persisted pipeline
are unchanged; there is no new transport, worker, quality ladder or global queue.

Compositor snapshots, PerfHUD and playback-perf JSON expose visible Motif target
and bound frames, lag, current/peak hold time, pending work and completion/discard
counts. Hold time applies while playing with unresolved or outdated content;
a content-duration cap holding its correct last frame reports zero. These are
texture-binding diagnostics, not proof of physical display scan-out.

Validation covers coalesced forward progress, pause/seek epochs, repeated Group
instances, stale failure recovery, cache ownership, byte limits and trimmed
prewarm entry. Real Electron tests inject an 80 ms bitmap-delivery delay and
check continuing content progress, monotonic frames, changed canvas pixels and
exact paused convergence, alongside eviction/unload/failure recovery and disk GC.
In three fresh-process runs of the reported local transition, sampled incoming
content lag and outdated holds were zero; submission p99 was 19.2–19.8 ms.
Two uninterrupted 42.5-second playback passes after warmup retained 16.67 ms
mean composite cadence and 18.9–19.4 ms p99 (previous local baseline:
19.5–19.7 ms), with no intervals over 50 ms, long tasks or decode drops. Mean
process CPU was 6.3–6.4% versus 7.1–7.5%; peak private memory was approximately
2.54–2.57 GiB versus 2.58–2.61 GiB. The video path remained native GPU. These
small differences establish no observed regression, not a portable speedup.
Repeated hot reloads contaminated an earlier timing run; performance comparisons
must restart the app consistently. These measurements are local evidence, not
a guarantee that arbitrary live Motifs can render within a display frame.
