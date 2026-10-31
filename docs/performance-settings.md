# Application resource management

One cooperative resource authority governs memory, CPU threads and temporary
disk on Windows, macOS and Linux ([ADR 0101](adr/0101-cross-platform-application-resource-authority.md)).
Settings → Performance exposes intent only; pool sizes, decoder counts and
texture slots are not user settings.

| Control | Meaning |
| --- | --- |
| Memory target (1–256 GiB) | Cooperative app target; limits retention and expensive allocations. Brief overshoot is possible. |
| Processing effort | Low / Balanced / High. Derives controlled-job threads from available CPUs; not a CPU-percentage cap. |
| Temporary cache space (0.25–1024 GiB) | Combined allowance for replaceable thumbnails, filmstrips, waveforms, Motif frames and audio-effect bakes in cache roots visited this session. |
| Continue background processing during playback | Off: new background jobs wait for playback to stop; running tasks drain. |

## Derivation

`shared/resource-policy.ts` validates intent (`ResourcePolicy`, version 2) and
derives the `ResourceAllocation`; `null` fields are automatic.

- **Memory**: automatic = 35 % of RAM, rounded down to 256 MiB, clamped to
  1–32 GiB. Picture retention gets 25 %, admitted work 40 %; the rest is
  headroom for runtime/DOM, demuxers, drivers and estimation error. Export
  stream capacity (12.5 %, ≥ 64 MiB) is charged *within* working memory.
  Picture targets are divided across registered windows.
- **Effort**: CPU budget = 25 / 50 / 85 % of logical processors (≥ 1). Each task
  requests half of it (1–4 threads); the background job ceiling is half of it
  (1–8). These are simultaneous limits, not promised concurrency. Changes apply
  to new work and newly opened decoder sessions only.
- **Disk**: automatic = 10 % of the total size of the open Workspace's disk
  (profile disk before one opens), rounded to 256 MiB, clamped to 4–64 GiB;
  re-measured when a Workspace opens ([ADR 0150](adr/0150-temporary-cache-space-follows-disk-size.md)).

Restore defaults returns intent to automatic and resets legacy preview
preferences; saved test evidence, decode engine and playback resolution are
kept. Opening Settings writes nothing. Failed edits stay visibly unsaved with
Retry; telemetry failure never blocks editing.

## Authority and lifecycle

- Main supplies host facts, merges partial edits against the latest settings,
  persists atomically, then publishes the allocation. Live telemetry never
  rewrites intent.
- Each process holds one read-only runtime snapshot (`resourceAllocation()`,
  `performanceSettings()`), published only by settings bootstrap/commit (main)
  and hydration (renderer). Consumers read it at admission or maintenance
  time, never at module init. Lowering a value governs new work and safe
  eviction; it never revokes a live lease, texture or displayed picture.
- The native `resources::Governor` is the single working-memory/processing
  ledger for native jobs and Electron-held leases. Admission precedes the
  allocation; release follows teardown, including cancellation and errors.
  IPC owners cannot release other windows' leases; navigation and renderer
  death return allocations.
- IPC and the NAPI entry reject non-integer, out-of-range and non-finite
  thread/memory claims before conversion, so large JS numbers cannot wrap into a
  smaller reservation.

## Admission lanes

| Lane | Rule |
| --- | --- |
| Background | Leaves one interactive slot when more than one exists. A 32-slot entry gate keeps fan-out below the native 256-waiter queue limit; waits are cancellable. |
| Import preparation | Serial, one thread / 128 MiB; uses the interactive reserve, so metadata, hashing, GOP probes, conforms and waveforms proceed during playback. Long transcodes and thumbnails stay background. |
| Import lookahead | The renderer keeps at most `max(1, min(cpu_threads, floor(work_mib / 128)))` paths in flight; pressure pauses submission, setting changes resize it. Bounds request buildup, not execution concurrency. |
| Workspace copy | Separate serial queue, one thread / 8 MiB; does not wait for transcode slots or the preparation lane. |
| Interactive | On-demand frames, audio effects, audio export, mux. Waits time out after 15 s; renderer requests fail promptly. |
| User compute | Clip compute a person or agent waits on; 60 s wait, ignores the background cap and playback gate ([ADR 0120](adr/0120-compute-a-person-waits-on-has-its-own-admission-lane.md)). |
| Export finalization | Stream-copy tail reserved before encoding and lent to production; runs ahead of new compute; ordinary RSS pressure does not block it, critical host memory does ([ADR 0104](adr/0104-export-finalization-retains-admission-and-encoded-files.md)). |

Resident decoders keep memory leases and per-session thread caps but no
exclusive job slot while idle, so a single-core allocation can still start an
export. Already-landed derivatives are adopted before admission (no slot, no
generation report). Thumbnail publication retries transient file contention up
to six attempts (50–800 ms backoff); Workspace changes interrupt the wait.

## Export working set

WebCodecs export reserves a fixed per-source window before opening a decoder:
24 frames in flight + 16 codec-private/reorder surfaces + 64 MiB context, at
4 bytes/pixel of coded size (8 for the 10-bit lane). Pending packets, live
pictures and async copies share the 24 credits; consumption returns them.
Planning blocks split at source activation on the output frame grid, so
sequential clips never hold simultaneous decoder windows. The 1 GiB memory
floor does not guarantee 1080p export: it projects to 409 MiB of work, while a
1080p/8-bit window (381 MiB) plus the composition worker (128 MiB) needs 509 MiB.
Refusal reports recovery options; it never lowers output quality.

Export suspends preview and releases its idle decoder leases before
preparation; preview resumes after sink finish/cancel and finalization.
Waiting for the worker to start instead can deadlock encoder admission.

## Memory telemetry and pressure

Process-tree RSS (Electron plus native children; Linux thread entries
excluded) and host available memory are sampled once per second through
sysinfo. This is a conservative pressure signal, not unique physical RAM or VRAM.

- macOS host availability = Mach VM free + inactive + purgeable pages ×
  page size, **without** subtracting compressor pages: sysinfo 0.37 subtracts
  them, which saturated to zero and blocked all admission on an idle Mac.
- Failed or invalid samples are *unavailable*, distinct from a valid zero.
- Each signal expires independently after 10 s (`MEMORY_SAMPLE_TTL_MS`, under
  the 15 s interactive deadline), including while a query hangs; late results
  are discarded. Expired signals stop contributing pressure; the reservation
  ledger keeps limiting work.
- RSS above target, or host available below 256 MiB (critical), closes new
  admission and halves picture retention. Recovery: RSS below 80 % of target;
  host above 512 MiB.

CI uses the same defaults and pressure policy as the app; do not hide platform
sampling errors behind larger test budgets or longer timeouts.

## Coverage

| Owner | Enforcement |
| --- | --- |
| Native thumbnails, waveform, conform, proxies, scene analysis, speech extraction | Background admission and FFmpeg thread requests. |
| Import probes and source hashing | Background admission, in-flight deduplication, session cancellation; probes time out. |
| Native export video sink | Dimension-based reservation through finish/cancel; encoder thread caps. |
| Native preview/export decode | Metadata-based reservation before open; thread cap fixed at worker creation. |
| Renderer/worker WebCodecs decode | Resolution-based reservation before decoder creation; worker requests relay to main. |
| Windows shared-texture transport | Video+animation byte ledger charged to working memory; retired imports stay charged until final release. |
| Preview pictures | Video rings, animation, filmstrip, posters and waveforms share retention; pinned pictures stay accounted. |
| Renderer source probes | Coalesced per source, at most two active, leased, cancelled on project change. |
| Renderer export | Composition/encoder frames and streamed animation reserve before canvas/worker creation. |
| Playback audio | Per-source bounded PCM lookahead reserved before open. |
| Local speech/video models | Weight/workspace estimate before spawn; threads capped after admission; CPU fallback re-acquires. |
| Replaceable disk derivatives | Global LRU across registered roots; writes and setting changes trigger maintenance. |

Browser composition, JS heaps, codec-private surfaces and driver allocations
are covered only by pressure feedback and headroom.

## Disk cache safety

The disk setting covers replaceable derivatives only. Source media, project
files, models, canonical audio conforms, proxies and paid/generated assets are
never evicted; unvisited or disconnected Workspace roots are not searched.
Sweeps may briefly exceed the target and evict to 90 % of it. Fresh empty temp
directories and filmstrip destinations survive (a writer may be about to use
them). Sweeps skip symbolic links at every level and do not charge linked
files; this is not a sandbox against concurrent directory replacement.

## Legacy preview budgets

`performance_policy` / `performance_budget` (preview cache, GPU buffer budget,
decoder limit, buffer frames) predate the resource authority and remain
compatibility inputs with no UI: legacy values are extra upper bounds beneath
the app ceiling and never become total app memory. Their runtime fields live in
`shared/performance-settings.ts` (`PERFORMANCE_FIELDS`); the default hardware
preview budget is 5 sessions and 3 × 3840 × 2160 coded pixels
([playback-perf findings](notes/playback-perf-findings-2026-07.md#hardware-admission)).
Automatic legacy budgets: cache = RAM/8 within 512 MiB and the 1728 MiB
baseline (scaled above 32 GiB RAM); GPU transport = dedicated VRAM/8, else
416 MiB. These are heuristics, not measured optima. The shared-texture limit
covers transport textures only, not total VRAM.

## Computer test (experimental, Windows)

**Settings → Performance → Test this computer** measures simultaneous H.264
4K/60 playback in an isolated Electron calibration host that builds scenes in
memory and reuses the production decode, GPU IPC, `Compositor` and
`PlaybackEngine` (no project, import or derivative jobs). macOS reports it
unavailable (`platform`); Linux hides it unless a saved profile exists.

- Protocol v1 (`shared/playback-calibration.ts`): always runs counts 1–8 in
  order; nothing (hardware, history, user budgets, earlier cells) selects a
  start or skips a cell. Per cell: start at 2 s, 1.5 s warm-up, 8 s sample,
  4×2 layout in a 3840×2160/60 fps composition on a 1280×720 canvas.
  Thresholds (≤ 2 % dropped+late, ≤ 100 ms longest hold) are experimental.
- Decoder identity comes from each session's D3D11 device; missing identity,
  device change, software fallback or a broken pipeline invalidates the cell.
- The parent reserves the run's full working set in the authority before
  launch; insufficient capacity rejects the whole run. A 6-minute watchdog
  bounds it; app exit cancels it.
- Recommendation: the contiguous passing prefix sets `maximum`
  (`preview_gpu_sessions`, `preview_gpu_pixel_area`); only `maximum` is applied.
  All-slow yields a one-video *conservative* result, not a pass; invalid or
  missing cells yield none.
- **Save recommendation** stores the profile (recommendation, current cache
  budget, machine id, app version, protocol). **Apply test profile** applies it
  as throughput guards; it is disabled when machine/build/protocol differ.
  Restore defaults keeps the profile; **Clear test record** deletes it. A test
  never certifies other codecs, macOS/Linux or whole-app memory.
- Reference media is generated on first use with the bundled FFmpeg into the
  app cache (`performance-calibration/`) and reused only when recipe, FFmpeg
  hash, size and SHA-256 match. Run reports go to the OS temp directory under
  `weftcut-performance-calibration/run-*`.

Developer runner (from `apps/desktop`, after `napi:build:decode` and
`build:e2e`): `npm run bench:calibration:reference`, then
`npm run bench:calibration:controlled [-- --plan-only]`. Reports land in
`.scratch/performance-calibration/controlled-<timestamp>/`; the CLI never
applies settings. Past observations:
[calibration observations](notes/performance-calibration-observations-2026-10-05.md).

## Hardware view and diagnostics

The Performance page starts with CPU, system memory and the devices reported
by open preview decode sessions (read from the live preview handle, so probes
and Chromium's rendering adapter cannot masquerade as decode use). On Linux a
**Hardware diagnostics** dialog shows per-device identity (DRM sysfs, PCI
database), memory sources (NVML if loadable, amdgpu sysfs, i915/xe regions;
Intel free-memory counters deliberately omitted), browser render API status
and per-backend codec probes. Missing libraries or permissions leave values
unknown with a reason; nothing is privileged or guessed.

Inventory is cached for 10 s. **Test acceleration** runs 640×360 8-bit
H.264/HEVC/VP9 fixtures through the production Standard-engine probes and the
FFmpeg encoder registry probes, in a utility process under common admission,
with a 90 s deadline that kills the process group. Results measure
availability, not throughput, and do not poison production capability caches.
Electron's active graphics adapter is shown independently of native capacity;
Apple Silicon shows shared graphics memory, never an invented dedicated VRAM.
These views never change the saved policy or decoder selection. The
**Shared texture transfer buffers** counter is hidden on copy-back platforms.
