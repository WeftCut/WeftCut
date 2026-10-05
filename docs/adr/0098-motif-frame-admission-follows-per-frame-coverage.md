---
status: accepted
---

# Motif frame admission follows per-frame coverage

ADR 0078 enabled three concurrent disk reads only when an entire Motif was
baked. The prewarmer applied that condition to all its current contents:
one incomplete Motif reduced even another content's saved-frame reads to one.
A long Motif could therefore have a fully saved playback window and still
receive the live-capture concurrency limit. ADR 0097's replenishment did not
remove this content-wide gate.

The prewarmer now registers the complete byte-bounded demand window, with
one cancellable background subscription per content/frame. It owns planning,
cache retention priority and stale-result disposal, not resource admission.
Replanning retains useful subscriptions and cancels obsolete ones. Pending
subscriptions contain request metadata; they do not preallocate pixel buffers.
The window also caps subscriptions at 256, round-robin across contents, so
tiny authored sizes cannot create thousands of promises in one idle callback.
There is no small opaque in-flight limit in front of acquisition: several
missing frames must not hide readable frames later in the window.

Behind the existing FrameBroker's cache hits and deduplication,
MotifFrameScheduler owns three disk-read slots and one capture slot, shared
by preview, prewarming, baking and transient parameter previews. Admission
consults exact frame coverage. Unknown directory coverage can still be probed;
known holes skip disk I/O. New successful writes wake admission so queued
requests can switch to disk reads. Read misses and failures relinquish the
read slot before entering the capture queue, and invalidate that frame's
coverage. They cannot turn three reads into three simultaneous captures.

Foreground subscribers promote shared queued work without duplicating it.
Background baking and speculative capture alternate when both have work, so
registering an entire prewarm window cannot strand the baker behind that
window. The main-process capture host remains serial and the GPU transport's
lease, acknowledgment and byte limits remain authoritative. Reads and
captures still share physical hardware; separate admission does not promise
freedom from GPU or disk contention.

Cancellation retires only the subscriber. A joined bake or another preview
can keep its producer alive. Queued abandoned work is rejected before I/O;
late admitted bitmaps are closed. A project reset fences both the scheduler's
queued/admitted work and producers awaiting inventory restoration. Resource
slots are released only when their actual operation settles.

This supersedes the full-content concurrency rule in ADRs 0078, 0096 and
0097. IdleBatchQueue remains the idle baker's bounded loop. The prewarmer's
initial demand registration still uses the existing idle callback; changing
that timing is a separate decision requiring measured evidence.

Validation crosses the real prewarmer, broker, inventory and acquisition
module with controlled read/capture completions. It covers partial coverage,
mixed contents, holes before readable frames, failed reads, newly saved queued
frames, foreground promotion, background bake progress, seek/disposal and
project resets. The Electron regression compares partially and completely
saved 30-second 1080p/60 fps content. Its saved prefix exceeds the 512 MiB L0
budget; playback crosses that budget while the partial case keeps baking.
A synthetic read delay makes overlapping admission observable. Those timings
are a regression gate, not a hardware throughput benchmark.
