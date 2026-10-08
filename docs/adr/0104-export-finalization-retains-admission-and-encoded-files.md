---
status: accepted
---

# Export finalization retains admission and encoded files

A completed video export must not lose its encoded work because its stream-copy
mux is admitted as a new task. On Linux, ordinary process-RSS hysteresis can
remain constrained after all production leases have drained (ADR 0101).

Before starting video production, export reserves 64 MiB for its stream-copy
finalization in the same native authority. This reservation holds no CPU slot. Production borrows those same 64 MiB as
part of its larger working-memory claim; releasing production atomically
returns them to finalization. The two sequential phases are not charged twice.
After production teardown, mux borrows one CPU slot against that reservation;
it allocates no second memory claim. Only a live, owner-scoped reservation can
continue under ordinary RSS pressure. New tasks still cannot enter. Critical
host pressure (available RAM below 256 MiB, recovery above 512 MiB) still rejects
the attempt. Occupied CPU capacity now waits for at most 15 seconds, matching
interactive admission. Queued finalization has priority over new compute claims
so background work cannot repeatedly steal a single processing slot. Waiting
holds no CPU slot or additional memory. Timeout, cancellation and owner teardown
remove that priority; a timeout retains encoded files for retry. This replaces
the initial immediate CPU refusal, which made completed exports fail during
short-lived background occupancy on three-core CI hosts.
Missing telemetry preserves pressure.
The memory target remains cooperative, not an OS-enforced hard cap.

The main process translates a renderer-owned opaque token into the native
reservation. Normal leases cannot act as continuations; duplicate mux attempts
cannot share one reservation. Reload/crash releases ownership, but a running mux
remains charged until its permit is dropped. A failed attempt returns its CPU
slot and retains the memory reservation for retry or explicit discard.

Audio is produced before video. After video encoding and encoder flush succeed,
both intermediate files are immutable. Finalization failure retains them and
offers Retry finishing export / Discard export. Retry performs only stream-copy
mux against those same files; it never reads a newer project or re-encodes audio
or video. An expected but missing audio file is an error, not a silent
video-only export. Settings can be opened without losing the pending retry.

Mux writes to a unique sibling temporary file and replaces the requested output
only after ffmpeg succeeds. A failure removes the incomplete sibling and leaves
any existing destination intact. Encoded inputs and the reservation are removed
on success or explicit discard. They are not part of the managed cache LRU.

Retry is local to the open editor session. The error panel cannot be dismissed
accidentally; closing the window warns that unfinished work will be discarded.
Editor teardown releases retained resources and cleans its intermediate files.
Crash/restart recovery is not promised by this change; abrupt process termination
can leave OS-temporary files. A durable export queue would need a persisted
manifest, startup recovery UI and storage accounting as a separate contract.

Regression coverage includes the unchanged 2304 MiB export and cancellation
cases, one processing slot, real pressure-gated failures followed by retry or
discard, preservation of an existing output, and native reservation lifecycle.
