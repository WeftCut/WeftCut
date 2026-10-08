# Application resource management

Settings → Performance exposes four controls. Internal pool sizes, decoder
counts and texture slots are not independently editable UI settings.

| Control | Meaning |
| --- | --- |
| Memory target (1–256 GiB) | Cooperative app target; limits retention and expensive allocations. Brief overshoot is possible. |
| Processing effort | Low resource use / Balanced / High performance (低占用 / 均衡 / 高性能). Derives background concurrency and codec thread requests from available CPUs. Not a CPU-percentage hard cap. |
| Temporary cache space (0.25–1024 GiB) | Combined allowance for replaceable thumbnails, filmstrip, waveforms, animation frames and audio effects in cache roots visited this session. |
| Continue background processing during playback | When disabled, new background jobs wait for playback to stop. Running tasks drain safely. |

Defaults use detected RAM and available CPUs on Windows, macOS and Linux.
Automatic memory uses 35% of RAM, rounded to 256 MiB and bounded to 1–32 GiB.
Explicit values persist unchanged. Restore defaults re-enables automatic intent
and resets legacy preview preferences while keeping saved test evidence, decode
engine and playback resolution. Failed edits provide Retry; telemetry failure
never prevents editing.

Processing effort derives a controlled-job CPU budget from 25%, 50% or 85%
of available logical processors respectively, rounded down with a minimum of
one. Each task requests half that budget, bounded to 1–4 threads; the background
job-count ceiling is half the budget, bounded to 1–8. These are simultaneous
constraints, not promises of that many concurrent jobs: memory admission,
aggregate thread reservations, playback and pressure can reduce concurrency.
Changing effort applies to new work and newly opened decoder sessions; it does
not change memory/cache targets, media quality or existing worker thread counts.

## Retrying export finalization

Video export reserves its stream-copy tail before encoding. Production borrows
that same memory allowance and returns it when the worker is torn down, so the
two phases do not consume duplicate reservations. The tail owns no CPU slot
until it runs. Ordinary RSS pressure blocks new work but allows this admitted
export to finish. Critically low host memory still blocks the attempt. Temporary
CPU occupancy waits up to 15 seconds, with finalization ahead of new compute
tasks; a longer wait returns the retry panel without discarding encoded work.

If writing the final file fails after encoding, the export panel offers **Retry
finishing export** and **Discard export**. Retry reuses the encoded audio/video;
it does not encode the timeline again. Opening Performance settings preserves
this pending export. Mux writes a sibling temporary file and replaces the chosen
output only after success, preserving an older output on failure.

Keep the editor open to retry. This is session-local recovery, not recovery after
an application crash or restart. Success, explicit discard and editor cleanup
release the reservation and remove the encoded intermediates. Closing a window
with a pending retry asks before discarding it. See [ADR 0104](adr/0104-export-finalization-retains-admission-and-encoded-files.md).

## Authority and lifecycle

shared/resource-policy.ts validates intent and derives allocation. Main supplies
host facts, merges partial edits against the latest settings, atomically persists
them and publishes the effective allocation. Live telemetry never rewrites intent.

Already-landed media derivatives are adopted before processing admission. Cache
hits still publish readiness and restore media paths, but do not reserve a
background slot or report generation. Playback or memory pressure must not block
this bookkeeping. Missing/stale artifacts continue through normal admission.
Hydration of thumbnails, conforms and waveforms is independent of proxy builds.
Quick proxies survive reopen and are checked against their recipe and file
format. Artifact producers are shared by cache root, content identity, kind
and recipe; completion is delivered to each requesting media item.

Every project opening owns a generation and frozen cache root. Switch, reopen,
Save As and Close cancel old imports; native events and TS continuations are
checked before state updates. Cancellation retains leases until child teardown.
Interrupted provisional hashes and workspace copies resume on reopen. See ADR 0102.

The native resources::Governor is the single working-memory/processing admission
authority. Native jobs and Electron-held leases use the same ledger. Admission
precedes managed expensive allocation; release follows teardown, including
cancellation and errors. IPC owners cannot release other windows' leases. Full
navigation and renderer death return allocations and remove listeners.

Memory projection sets 25% aside for picture retention and 40% for admitted work.
Remaining headroom covers runtime/DOM, demuxers, code, driver overhead and
estimation error. Export stream capacity is charged within working memory, not
an additional independent pool. Picture targets are divided across registered
windows; each cannot claim a full app target. Legacy preview values remain
additional upper bounds, so raising the app target need not expand every cache.

Background jobs leave an interactive processing slot when more than one exists.
Native queues admit at most 256 waiters; a 32-slot background entry gate keeps
bulk import fan-out below that limit, with cancellation while waiting. Oversized
jobs fail with an actionable error. Interactive waits time out after 15 seconds;
renderer allocation requests fail promptly when unavailable. Resident decoders
retain memory leases and per-session thread caps, but not an exclusive job slot
while idle, so a single-core allocation can still start export.

IPC and the native entry validate integer thread/memory claims before NAPI
conversion. Out-of-range, fractional and non-finite native claims are rejected;
large JavaScript numbers cannot wrap into a smaller working-memory reservation.

WebCodecs export reserves a fixed per-source window before opening the decoder:
24 frames in flight plus 16 estimated codec-private/reorder surfaces and 64 MiB
of context overhead. Frame estimates use coded dimensions and 4 bytes/pixel
(8 for the 10-bit lane). Pending packets, live pictures and asynchronous copies
share the 24 credits; dispatch does not acquire additional memory. Consumption
returns credits locally and wakes a parked producer, including across 60-frame
planning blocks. Long GOPs therefore do not need to be retained in full. The
window is internal and fixed for a session; the first version has no adaptive
sizing or global scheduling in the per-frame path. Targets below the combined
base working set can still fail admission. The 1 GiB settings floor is for
lighter workloads, not a guarantee of 1080p source export: it projects to
409 MiB of working memory, while a 1080p/8-bit WebCodecs window (381 MiB) plus
the export composition worker (128 MiB) already needs 509 MiB before the native
encoder. Insufficient admission reports recovery options without changing the
target or reducing output quality.

GOP preroll is discarded behind the requested source time, retaining its lower
PTS neighbour. Planning blocks split at source activation/deactivation on the
output frame grid, so sequential short clips never reserve simultaneous decoder
windows just because they fall in the same 60-frame block. Inactive sessions
close before later sources open. Cancellation and terminal errors wake pending
consumers/producers, and asynchronous copies
retain their lease until their frames close. Small diagnostic records preserve
packet counts, per-source peak credits and capacity-wait time across reuse.

Process-tree resident memory (Electron and native children) is sampled once per
second through sysinfo on all three OSes. Linux thread entries are excluded:
they share the owning process's RSS and must not each charge it again.
Shared mappings between separate processes may still be counted twice;
this is a conservative pressure signal, not unique physical RAM or dedicated
VRAM usage. The same sample reports available system RAM, including reclaimable
pages; raw free pages (notably on macOS) are not a pressure signal. macOS uses
checked Mach VM free, inactive and purgeable pages without subtracting compressor
occupancy. Failed or invalid host queries report unavailable rather than zero.
Brief sample failures preserve known pressure. Process and host readings expire
independently after 10 seconds, including while a query is hung; stale results
are discarded. Expired readings are reported as unavailable and stop contributing
pressure, while the native reservation ledger continues limiting work.
Usage above target or available system memory below 256 MiB closes new admission
and halves picture retention. The app signal recovers below 80% of target; the
host signal recovers above 512 MiB. Both must recover or expire to reopen admission.
See [ADR 0106](adr/0106-memory-telemetry-expires-and-macos-counts-reclaimable-pages.md).

Export suspends preview and releases its idle decoder leases before preparation
or native encoder admission. Preview resumes after the whole pipeline, including
sink finish/cancel and finalization, on success or failure. Waiting until the
export worker starts can deadlock encoder admission behind preview's leases.
CI uses the same defaults and pressure policy as the app; platform sampling
errors must not be hidden behind larger test-only budgets or longer timeouts.

Lowering a setting governs new work and safe eviction. Existing resources remain
charged until released. The app never kills an export or closes a displayed
picture to force the target. Chromium and GPU drivers own opaque allocations;
thread requests, bounded queues, estimates and pressure feedback do not create
an OS-enforced whole-process RAM, CPU-percentage or dedicated-VRAM hard cap.

## Coverage

| Owner | Enforcement |
| --- | --- |
| Native thumbnails, waveform, conform, proxies, scene analysis, speech extraction | Shared background admission and FFmpeg thread requests. |
| Import metadata/GOP probes and source hashing | Shared background admission, in-flight source deduplication and session cancellation; metadata probes have a timeout. |
| On-demand frame/filmstrip extraction, audio effects, audio export and mux | Interactive admission, bounded waits and child-lifetime permits. |
| Native export video sink | Dimension-based working reservation through finish/cancel; encoder thread caps. |
| Native preview/export decode on all platforms | Metadata-based reservation before session open; thread cap captured at worker creation. Software and hardware copy-back share the gate. |
| Renderer/worker WebCodecs decode | Resolution-based reservation before decoder creation; worker requests relay to main. Export pending packets, decoded frames and 10-bit copies share accounting, requesting capacity before long-GOP dispatch and returning it after consumption. Chromium controls internal threads. |
| Windows shared-texture transport | Video/animation byte ledger charged to global working memory; retired imports retain charges until final release. An additional platform adapter, not the portable authority. |
| Preview pictures | Video rings, animation including gesture overlays, filmstrip, media posters and waveform share retention. Safe trimming keeps pinned pictures accounted. Waveform metadata is bounded and project-pruned. |
| Renderer source capability probes | Coalesced by source identity, at most two active, decoder/input leases and cancellation on project changes. |
| Renderer export | Composition/encoder working frames and streamed animation reserve before canvas/worker creation. Byte backpressure rejects oversized animation packets before allocation. |
| Playback audio | Per-source bounded PCM lookahead reserved before open and released on disposal. |
| Local speech/video models | Weight/workspace estimate before spawn; thread arguments capped again after admission; CPU fallback reacquires through the same gate. |
| File import/archive extraction | Copy/hash/extract holds a shared permit; queued import respects cancellation. |
| Replaceable disk derivatives | Global LRU across registered roots, including renderer animation stores; writes and settings changes trigger maintenance. |

Browser composition, DOM/JS heaps, codec-private surfaces and driver allocations
are covered by aggregate pressure feedback and headroom, not exact accounting.
Processing effort bounds controlled jobs/thread requests, not the sum of CPU
utilization across every browser/native thread. Network transfers retain their
existing bounded/streaming behavior; this setting is not a bandwidth limiter.

## Disk safety

The disk setting covers replaceable temporary derivatives, not all installation
or workspace bytes. Source media, project files, models, canonical audio conforms,
proxies and paid/generated assets remain protected. Unvisited or disconnected
workspace roots are not searched or deleted. Export output size follows format
and duration, not a cache preference.

Sweeps may temporarily exceed target while writes complete and evict to 90% of
target. Fresh empty temp directories survive before a writer opens its first
file. Filmstrip destination directories are retained because a writer may be
about to use them. Cache readers regenerate evicted derivatives; source assets
are never sacrificed to satisfy a quota.

Cache sweeps skip symbolic links at the cache root, category roots and nested
entries. Linked external files are neither charged to the quota nor traversed
for eviction. This protects existing links; it is not a filesystem sandbox
against another process concurrently replacing directories during a sweep.

## Compatibility and optional measurements

resource_policy is independent of legacy performance_policy. Old preview cache
numbers never become total application memory. Existing APIs and test profiles
remain compatibility inputs beneath the global ceiling. Opening Settings writes
nothing; resource edits do not alter decode quality, export format or models.

Windows adapter diagnostics and the optional H.264 4K/60 benchmark retain their
narrow scope. Saving evidence is separate from applying it; reset retains it.
Settings also reports Electron's active graphics-adapter identity independently
of native capacity measurements. Apple Silicon adapters show shared graphics
memory; this does not invent dedicated VRAM or increase the application budget.
The isolated benchmark reserves its full fixed workload in the parent authority
before launch and releases it on exit/cancel; it cannot bypass the app target.
Applying a test cannot bypass global admission or certify macOS/Linux, other
codecs or whole-app memory. See [calibration protocol](controlled-playback-calibration.md).

## Verification

Policy/persistence tests cover machine scaling, migration, restart, invalid edits
and resets. Native tests cover combined memory, single-core mixed workloads,
pressure recovery, limit reduction and cancellation. IPC tests cover ownership,
reload and crashes. Cache tests cover retained references, multiple disk roots
and concurrent writers. Electron E2E checks controls, persistence, real native
admission, process-tree telemetry and reload cleanup without platform skips.
These tests join the existing Windows/macOS/Linux CI matrix. Local Windows
results do not constitute macOS/Linux execution evidence.

See [ADR 0101](adr/0101-cross-platform-application-resource-authority.md).
