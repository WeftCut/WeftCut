---
status: accepted
---

# Motif preparation belongs to the Workspace session

Background ordering is subsequently updated by [ADR 0109](0109-motif-preparation-finishes-clips-in-timeline-order.md)
to finish clips in timeline order with explicit move-to-front priority. The
measurements below describe the original bounded-rotation implementation.

The renderer's full-content baker rotated contents after every frame, while
main's single capture host retained only one loaded page. Large collections of
independent Motifs repeatedly paid navigation, setup and the first-surface fence.
Its work also depended on the preview lifecycle, and its successful-frame set
could outlive files evicted by the native disk quota.

Main now owns a Motif preparation module: declarative content/range demands,
inventory, scheduling, retry state, persistence and coverage notifications. The
renderer retains descriptor/range projection, L0 prewarming and status display.
It submits committed inputs and observes results; unmounting or reloading the
preview does not own cancellation. A Workspace session, including same-project
reopen and Save As, retires old work. Storage is bound to that opening's root
and generation before work is queued. Admission stays closed through actor
replacement and media relinking, not merely until native directory commit.
Main announces when admission reopens. Clients redeclare their latest matching
project demand, including when a failed switch restores the same generation;
an old plan signature cannot suppress recovery into an empty coordinator.

Automatic preparation requests the used content interval through composition
clocks, trims and retiming. Explicit Pre-bake requests the complete content and
can retry a failed request. Overlapping requests merge by the existing content
identity. Full content duration, authored dimensions, props, frame rate and the
capture runtime remain render inputs; demand ranges do not change the cache
key. `.wfrm` files and existing caches remain compatible.

The scheduler holds lazy range cursors instead of materializing every frame.
It gives a content up to 30 frames or 1,000 ms of warm work per turn. The first
frame's cold initialization is excluded from that time quantum: otherwise a
page taking longer than the quantum to initialize still rotates after every
frame. Every frame returns to the main capture queue, so foreground demand can
interleave; one slow frame remains bounded by the capture host's stage timeouts.
Waiting contents rotate fairly.
The one-second budget bounds background fairness, not foreground response:
foreground requests still interleave after each frame. A 250 ms budget allowed
only a few warm frames for expensive content and repeatedly paid page startup.
The capture queue also ages background tickets after two seconds, granting one
frame even under sustained foreground traffic when background work is allowed.
We retain one capture host: a pool would add
resident page/graphics memory and requires separate throughput evidence.

Persistence-only demand captures, encodes and atomically writes in main/native
without importing a texture into the editor or allocating an ImageBitmap there.
Overlapping display/persistence requests share work within a bound store; a
foreground join promotes a queued background producer. A stale subscriber
cannot invalidate a surviving display request. GPU encoding failures retain the
PNG compatibility route. Resource leases and texture-consumption fences remain
authoritative.

For content with main-owned demand, renderer prewarming reads saved frames and
waits for missing coverage instead of starting another background capture.
Foreground subscribers can promote that waiting request immediately. Without
main demand, prewarming retains its bounded live-capture fallback. This avoids
two independent background producers alternating pages on the same host.

Progress distinguishes queued, baking, paused, retrying, error and ready.
Only a currently in-flight frame marks its content baking; partially completed
content returns to queued between frames and while another content has the turn.
Paused names playback policy, memory pressure, admission capacity or disk space.
Transient failures receive finite backoff; project updates do not reset failure
budgets. Deliberate retries reopen the corresponding capture failure lane.
Ready means the demanded range is persisted. RAM warming is displayed
separately and never claims durable completion. Full RAM coverage displays
"Preview ready" instead of a perpetual full-progress warming state; eviction
can return it to warming. Read misses/corruption and
foreground writes update the same coverage authority. Header inventory is cheap;
payload checksums remain verified by the existing reader.

Referenced raster directories are retained by the native disk sweeper while
the workspace uses them. Retention is process-local and still counts towards
the temporary-cache target. Incoming workspaces initially retain the whole
raster root before discovery; unresolved catalog entries cannot authorize
collection. Validated discovery narrows retention to live content, with
in-flight writes protected through completion. New background work checks the
next frame's worst-case encoded size; the bound store checks actual encoded
growth before atomic writes, including export's optional cache writes. A quota
shortfall pauses that content instead of evicting useful frames and repeatedly
rebuilding them. Existing retained artifacts can exceed a reduced target;
non-growing replacement is allowed. This is cooperative retention, not a
hard filesystem quota or a guarantee of completion with insufficient space.

This supersedes ADR 0016's renderer-owned baker and full-content automatic
planning, and extends ADRs 0078, 0080, 0098 and 0101 without replacing their
pixel format, export credit window, read admission or resource authority.

Validation covers content affinity and fairness (including costly cold starts),
partial restoration, explicit retry, quota recovery, concurrent inventory and
writes, live GC, stale sessions, renderer remount and transparent frame fidelity.
Local real-project measurements use a copied project and isolated user-data
directory; the original project's completed raster cache is not removed.

### Local validation (2026-10-09, Windows)

The reference project contains 61 content identities at 1920×1080/60 fps. An
isolated copy started with no raster cache, stopped after approximately 600
persisted frames, and resumed in a new Electron process. All 10,337 demanded
frames completed: 48.1 seconds before interruption and 735.9 seconds after
restart, with zero capture failures and 614 page loads across both phases.
These are local elapsed measurements, not a controlled speedup comparison.

The final build restored every content to ready in 5.8 seconds after opening,
with zero captures and unchanged cache file sizes/mtimes. The raster cache used
4,579,249,568 bytes (4.26 GiB). The isolated profile allowed 16 GiB; the user's
existing 2 GiB policy was unchanged and cannot retain that complete working set.
An 8 GiB allowance accommodates this measured cache plus headroom. Original
project bytes and cache file sizes/mtimes were unchanged throughout the run.

Pixel sampling compared 106 common frames across 53 content identities with
the existing cache. Maximum channel difference was 3/255; at most 0.01919% of
pixels differed in a sampled frame, with identical alpha. The project-copy
test covered Motif preparation; its unavailable media reference was not relinked.
Separate Electron tests cover transparent-frame fidelity and export.

Final regression results: 9,063 Vitest tests in 665 files, 15 native disk-cache
tests, and 12 Electron bake/playback/export tests passed, including failed
workspace-switch recovery. TypeScript checks, native build and Electron build
passed. The four-content Electron affinity case completed 240 frames with
240 captures, 16 page loads and no failures.
