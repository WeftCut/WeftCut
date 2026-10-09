---
status: accepted
---

# Import work belongs to a workspace session

Opening a project, reopening the same directory, saving elsewhere and closing
must end the previous opening's asynchronous work. A content hash identifies
bytes, but cannot identify which project should receive a completion.

Each opening has a generation. Native tasks capture an immutable cache root
and cancellation scope before admission. Main invalidates import continuations
when a lifecycle transition begins, serializes transitions, and filters native
events by generation before actor writes. Cancellation releases resource leases
after child processes have exited. Audio-effects preparation follows the same
opening/closing boundary for both UI and MCP operations.

Reusable artifacts outlive an opening. Quick proxies persist across reopen;
recipe versions and file validation determine reuse. Cache hydration runs before
resource admission and independently of proxy construction, so pressure cannot
hide already valid waveforms, conforms or thumbnails. A missing derivative is
regenerated on demand. Provisional import identities and interrupted source
copies resume after reopening.

Concurrent requests share one producer per cache root, content hash, artifact
kind and recipe version, while every media subscriber receives its completion.
A new generation waits for a cancelled producer to release a shared output
before taking over. A bounded admission gate absorbs bulk fan-out before the
global resource ledger; task count alone must not turn a valid import into a
permanent queue-overflow failure. Metadata probes and source hashing also pass
through admission.

User-visible import preparation (metadata, source hash, GOP probe, canonical
audio and waveform) shares a FIFO single-operation lane. It claims one CPU
thread and 128 MiB from the same authority, using the interactive reserve so
long transcodes and paused background admission during playback cannot starve
it. Pressure, memory limits and export finalization priority still apply;
single-thread codec commands match the claim. Proxies and thumbnails retain
background admission. Workspace copies use their own single-worker FIFO and
claim one CPU thread for inline hashing plus 8 MiB for bounded copy/file buffers.
They can use the interactive reserve without taking a transcode slot or holding
the preparation lane. Playback does not pause copying; CPU/memory limits,
pressure and export finalization priority still apply. Cancelling a copy or
retiring its workspace interrupts admission waits as well as running copies.

The UI keeps one rolling request queue across picker/drop selections. Its
lookahead window is bounded by the smaller of allocated CPU slots and the number
of 128-MiB preparation claims the working-memory allowance could hold (at least
one request). This is a conservative backpressure policy, not a measured optimum
or a second execution scheduler; native admission remains authoritative. A
completion immediately admits another path without waiting for its selection's
slowest file. Selections share capacity and rotate fairly. Allocation changes
resize the window, while memory pressure stops new submissions until it clears.
Failure stops the affected selection's unsent paths and drains its active
siblings before reporting the error. Workspace change (including same-project
reopen) retires all obsolete unsent paths.

Waveform construction spools levels to disk with bounded buffers. Compatible
48 kHz mono/stereo inputs reuse canonical audio conforms; other input formats
retain source decoding to preserve existing waveform values. Renderer posters
share picture retention accounting, probe inputs acquire decoder resources,
and project changes prune source metadata and cancel obsolete consumers.

Tradeoffs: waveform generation adds temporary disk I/O; validated disk reuse is
still subject to later eviction or external modification; browser codec heaps
remain covered by cooperative estimates and measured pressure (ADR 0101).
See [audio.md](../audio.md) and [performance-settings.md](../performance-settings.md).
