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

Waveform construction spools levels to disk with bounded buffers. Compatible
48 kHz mono/stereo inputs reuse canonical audio conforms; other input formats
retain source decoding to preserve existing waveform values. Renderer posters
share picture retention accounting, probe inputs acquire decoder resources,
and project changes prune source metadata and cancel obsolete consumers.

Tradeoffs: waveform generation adds temporary disk I/O; validated disk reuse is
still subject to later eviction or external modification; browser codec heaps
remain covered by cooperative estimates and measured pressure (ADR 0101).
See [audio.md](../audio.md) and [performance-settings.md](../performance-settings.md).
