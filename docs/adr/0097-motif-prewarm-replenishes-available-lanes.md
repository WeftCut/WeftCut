---
status: accepted
---

# Motif prewarming replenishes available lanes

Persisted Motif playback can hold an old bitmap while composite submission
continues at 60 fps. Local traces attributed the latency to persisted frame
reads and texture delivery, rather than broker clones or Pixi texture binding.
Three concurrent reads were admitted as a batch: one slow completion prevented
the idle queue from replenishing its already free slots. Fixed round-robin GPU
lane assignment introduced a second wait even when another lane was acknowledged.

The existing IdleBatchQueue now counts admitted items and replenishes available
capacity on scheduled idle callbacks. The configured batch size is the maximum
number of items in flight. Each item's completion or failure returns capacity;
there is still only one pending idle callback. A batch's progress notification
still fires when all items pulled by that callback have settled. Dynamic limits
are checked at admission, so switching from persisted reads to live capture
does not admit new work above the smaller limit.

MotifPrewarmer owns a set of in-flight content/frame addresses. Replanning skips
those addresses rather than occupying a free slot with another subscriber to
the same broker job. Completion and failure remove the address. The existing
target-window check still closes obsolete results after seek or disposal.

MotifGpuTransport hands an available lane to the oldest waiting producer rather
than reserving a particular busy lane. Availability follows the existing lease
acknowledgment, timeout retirement or failure cleanup. No unacknowledged texture
is overwritten. Generation fencing, import accounting, the three-lane limit
and GPU byte budget remain authoritative.

Native straight-to-premultiplied RGBA conversion skips multiplication for
opaque pixels and clears RGB for fully transparent pixels. Intermediate alpha
uses the existing rounded formula. A test compares every channel value at every
alpha against that formula. Cache files remain straight alpha; their format
and the consumer read-completion barrier are unchanged.

Validation includes deterministic regressions for a slow sibling, replanning
with reads in flight and an available GPU lane beside a held lease. On the local
1080p/60 fps workload, isolated cached upload median fell from 8.68 to 6.14 ms.
Three repeated pressure-segment passes had maximum outdated holds of 262–369 ms
before and 155–213 ms after; the 100 ms diagnostic target was **not** reached.
A full warm playback's maximum Motif hold was 66.5 ms versus 120.6 ms in the
preceding audit, with zero video decode drops and approximately unchanged CPU.
First playback still held a Motif for 230 ms; there is no demonstrated cold
playback improvement. These are local texture-binding observations, not display
scan-out measurements or a portable latency guarantee. CPU-pixel transport and
GPU completion polling changes were investigated but were not adopted.
