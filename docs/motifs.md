# Motifs

A Motif is a parameterized, time-varying overlay (a lower-third, a countdown, a
title card) placed as a `Motif` layer. It is **a real web page** — any
HTML/CSS/SVG/canvas/WebGL — rendered by one path: an offscreen Electron window
driven to a time `t` over the DevTools Protocol (CDP) and captured to a bitmap
([ADR 0017](adr/0017-motifs-cdp-webcap-clock-takeover.md)). The export Worker
has no DOM, so main captures and the Worker receives bitmaps; preview and
export read the same frames.

This doc covers how a Motif becomes pixels. The author-facing contract is
[`motif-authoring.md`](motif-authoring.md); agent/file workflows are
[`motif-workspaces.md`](motif-workspaces.md); the layer data model is
[`data-model.md`](data-model.md); the generic compositor is
[`render.md`](render.md). A Motif carries no audio.

## Determinism

> **A Motif renders as a pure function of time.** It never advances itself;
> the harness owns the clock and drives the page to each composition frame.

The runtime (`renderer/render/motifs/runtime.ts`) is injected at document start,
before any Motif code:

| Animation source | How it is pinned to `t` |
|---|---|
| CSS animations/transitions, WAAPI | `document.getAnimations()` → `pause()` + `currentTime = tMs` |
| GSAP and other rAF tweens, canvas/WebGL loops | `requestAnimationFrame` + `performance.now` owned; the controlled rAF queue is flushed |
| `setTimeout` / `setInterval` / `Date.now` | stubbed to the virtual clock |

`__motifRender(t, props, meta)` runs setup (once per props), `frame(t)` and the
seek. Captures take the paint carrying the frame's id (marker rows, below), so
an author never tunes a wait. The seek only pauses and sets
`currentTime`; cancelling or committing a finished animation would remove it
from `getAnimations()` and break seeking back. A time source cached before the
runtime installs, or one it does not own, is out of contract. 2D/DOM captures
are byte-identical across runs and OSes, so conformance asserts exact bytes;
GPU scenes are repeatable per machine only.

## Parameter UI

The property panel shows either a form generated from `props_schema` or the
Motif's own `params.html`; presence of that file beside `index.html` is the
only switch.

**Generated form (default).** One row per prop by type — text (textarea when
`multiline`), color swatch, number with steppers, `enum` dropdown — in the
schema's authored key order, labelled with the key title-cased (`bg_color` →
"Bg Color"). Labels are not localized: Motif keys are arbitrary. Each row
commits one key per gesture; the color swatch is debounced so an OS color-dialog
drag does not flood the serial capture queue. The picker's props form uses the
same generator.

**`params.html`.** The catalog carries `has_params_ui`, which main derives by
stat'ing the file (built-ins once at boot; user Motifs on every listing). It
never enters the manifest. Adding or deleting the file switches the panel on the
next catalog refresh (the Motif watcher triggers one). Of the built-ins only
`text-fx` ships a page; `src/shared/motifs/builtin/text-fx/params.html` is the
reference (13 props in hand-ordered sections, bilingual labels off
`init.locale`, conditional rows, RGB + alpha → `#rrggbbaa`, presets that commit
three colors at once).

The panel frames `motif://<id>/params.html?v=<catalog revision>` with
`sandbox="allow-scripts"` and no `allow-same-origin`; `?v=` changes on any Motif
file change, so on-disk edits reload the page. Consequences for the page:

- The origin is opaque: storage APIs and cookies throw; inbound
  `event.origin` is `"null"`.
- No network: the params CSP is `default-src 'none'` with `motif:` for
  scripts/styles/images/fonts, plus inline and `data:`. Relative URLs resolve to
  `motif://<id>/…`.
- The editor's CSP grants `frame-src motif:` only, so a parameter page is the
  only framed context in the app ([`security.md`](security.md)).
- The frame is transparent; the page paints itself from `themeTokens`.

| Verb | Direction | Payload | When |
|---|---|---|---|
| `motif:init` | host → page | `{ motifId, layerId, props, schema, locale, themeTokens }` | each loaded document, on the frame's `load` |
| `motif:propsChanged` | host → page | `{ props }` | props changed from outside the page (undo/redo, agent, other surface) |
| `motif:preview` | page → host | `{ props }` patch | mid-gesture |
| `motif:commit` | page → host | `{ props }` patch | gesture end |
| `motif:resize` | page → host | `{ height }` px | content height changed |

`init.props` are the committed props, leniently canonicalized; `schema` is the
`props_schema` verbatim. **Nothing the page sends is believed:** the sender must
be the frame's own window, payloads are shape-checked, undeclared keys dropped,
and values lenient-canonicalized (invalid → schema default); anything else is
ignored silently.

Gesture model (`renderer/properties/motifParamsHost.ts`):

- `preview` never touches project state. The patch lands in a per-layer overlay
  merged at the canonicalization choke point, so it changes the on-screen frame
  and its cache key only — never lookahead, main preparation, bake status or
  export. Overlay frames live in `sharedMotifOverlayCache`, a separate LRU under
  the same Motif RAM allowance, so gesture ticks cannot evict committed frames;
  it is wiped when the gesture ends.
- Previews: the first applies immediately, the rest coalesce to one per 250 ms
  (capture costs ~80–100 ms, serialized). An unchanged value costs no recapture.
- `commit` is one `update_layer_params`, one history entry, however many keys.
  The overlay's committed keys clear only once the mutation settles.
- A page's own commit is not echoed as `propsChanged`; undo is.
- `resize` is clamped to 80–1200 px; the frame starts at 240 px.
- Selecting another layer, swapping the Motif or a watcher reload disposes the
  host and drops pending previews.

## Capture host

A capture host (`main/motif/captureHost.ts`) is one offscreen `BrowserWindow`
showing one Motif content version, reused across frames and layers of it. It
loads the capture host page beside the Motif's `index.html`, which frames the
Motif at the capture size above its marker rows; the runtime runs in both and
forwards the entry points. Another Motif or content version gets another window
(ADR 0159): only a window's first document keeps alpha on a bitmap host. The
host sets `Emulation.setDeviceMetricsOverride` (any resolution) and a
transparent default background so `background: transparent` stays real alpha.

`MotifCapturer` (`capture.ts`) is the one entry point. It orders captures in a
queue (`captureQueue.ts`) onto a pool of hosts (`hostPool.ts`): at most one
host per Motif content version and texture kind, and `captureHosts` (default 2)
in all. A capture whose Motif has no host takes a free slot, else replaces the
least recently used host that is not rendering: that host's frames in flight
drain, it closes, and only then does the new one open. With one host, every
switch to another Motif replaces it.

- **Output.** Every capture is the paint whose marker rows carry the frame's
  id and its canvas witness (`OffscreenFrames`, `shared/motifs/frameMarker.ts`):
  a new window's first commit can show the id without any canvas, and that
  frame renders again. Windows: OSR shared textures, copied into the Motif
  transport pool
  ([ADR 0078](adr/0078-motifs-cache-pixels-and-transfer-persistent-textures.md)).
  Elsewhere: the paint's bitmap, straightened natively and sent as RGBA
  ([ADR 0159](adr/0159-motif-captures-are-pipelined-paints.md)). No capture
  takes a screenshot; PNGs (MCP previews, covers) are encoded from the leased
  pixels. A surface over the [texture limit](#limits) gets a bitmap host for
  that size only. A `device` failure or an uncoded one, which comes from the
  texture output itself (lease, GPU copy, readback), switches the session to bitmaps;
  every other [failure code](#failure-codes) (a timeout, disk error, capacity
  refusal, held mutex, superseded request or Motif failure) never does.
  `WEFTCUT_MOTIF_CAPTURE=bitmap` forces bitmaps for diagnosis.
- **Pipelined.** Each host renders one frame at a time; different hosts
  render at once. A render returns once its frame has committed, and the next
  frame on the same host renders while up to three earlier ones are still on
  their way to a paint (ADR 0159). A resize waits for that host's paints. A
  frame the compositor skipped (a later id painted first) renders again from
  the head of its class, as the same ticket.
- **Dispatched at a free slot.** A capture stays queued until a host can take
  its frame: its own host is not rendering and has room among its frames in
  flight, or a slot is free, or a host can be replaced. The order is decided
  then, so a `current` capture queued after `ahead` ones goes first at the
  next free slot; a running frame is never preempted. Every capture states a
  [priority](#admission): `current` first, then `ahead`, then `background`,
  and a `background` capture waiting 2 s gets one frame between higher ones.
  Within a class, a capture whose Motif has a host goes before one whose Motif
  has none until that Motif has waited `hostAffinityMs` (250 ms) without a
  host; then the latter ranks as if queued when its Motif began waiting. The
  wait is the Motif's, so a scrub that cancels and re-sends its `current`
  capture every tick does not restart it. When Motifs outnumber hosts, a host
  serves them in runs rather than being replaced every frame; affinity never
  crosses a class.
  A `current` capture whose Motif has a host thus waits for the `current`
  captures ahead of it (export frames are `current` too), at most one aged
  `background` frame, then the render step in progress and one paint on its
  host; a resize first drains that host's frames in flight. One whose Motif
  has none can wait `hostAffinityMs`, then for the replaced host to drain and
  a new window to build. A capture waiting for its busy host keeps
  that host from being replaced by captures ranked below it, while the other
  hosts go on serving them. A queued capture moves when its priority changes,
  up or down, and leaves the queue when its request is cancelled (it rejects
  as superseded); a running one finishes and its caller drops what it no
  longer wants. On quit every queued capture rejects `closed` at once. Each
  renderer document keeps at most `captureRequests` (2) `ahead` and
  `background` captures in the queue and every `current` one
  ([Admission](#admission)), so main orders the near future without holding
  lookahead past the transport deadline
  ([ADR 0161](adr/0161-main-orders-motif-captures-over-a-pool-of-capture-hosts.md)).
- **Deadlines.** Every CDP command goes through the host's timed `send`
  (5 s); awaited setup gets 30 s. A timeout rejects with code `timeout` and
  closes the host; the next capture opens another. A host's failure fails only
  the frames rendered on it. The renderer's capture transport allows 60 s so
  it does not pre-empt setup; when it gives up, it withdraws the capture from
  main's queue.
- **Failure latching** (`lanePolicy.ts`). A Motif whose script throws fails
  its lane (`motifId` + `contentHash`) until an edit changes the hash or an explicit
  retry. A timeout is probation: one more attempt on the rebuilt host; a second
  consecutive timeout latches the lane, a success clears it. Load cannot be told
  from an infinite loop, and a heavy 1080p page normally takes ~1 s, so one
  slow frame must not lose a Motif for the session (measured on a 2-core Linux
  box: a 3.5 s frame timed out under load and rendered in 4.8 s once it lifted).
  Other mid-render transport failures (detached debugger, crashed renderer)
  still latch at once. A thrown script, a frame that never becomes ready and a
  latched lane reject with code `content`.
- **Bitmap host canvases** are forced CPU-backed (`willReadFrequently`) by
  `bitmapCanvasRuntime.ts` (ADR 0078): Electron's bitmap backend omitted an
  accelerated 2D layer after navigation.

## Frame cache

Frames are identified by content, not placement. The key
(`motifFrameCacheKey`, `renderer/render/motifs/motifFrames.ts`) is
`surface-v7 | motifId | version | contentHash | renderW | renderH | fpsNum |
fpsDen | contentDurationFrames | canonicalProps [| mediaKeys]`.

- `contentHash` covers the manifest, HTML and every companion path and bytes,
  so any source edit re-captures; a built-in with no hash keys stably.
- Not in the key: layer transform and opacity (applied by the sprite) and the
  window position `src_in_us` (frames are absolute content-frame indices, so
  trimming reuses them). The held tail of `content_duration_s` collapses to the
  last content frame.
- Distinct frame indices are distinct entries even if their pixels match.

**L0 — RAM.** `MotifFrameCache` (`frameCache.ts`) is a byte-bounded LRU of
bitmaps keyed `(cacheKey, frame, scaleDiv)`, budgeted by the `motif_cache_mib`
performance setting (default 512 MiB). The Playback Resolution divisor is part
of an entry's identity: a resolution change misses and refills rather than
clearing. A live capture exists only at full size and serves every divisor.
Eviction removes membership at once but closes a bitmap only when its last
sprite releases it. L0 keeps per-content frame counts for O(1) coverage queries.

**L1 — lookahead.** `planMotifDemand` (`motifDemand.ts`) plans the frames to
fill L0 ahead of the playhead during playback and while paused, and
`MotifPrewarmer` requests them. Identical contents dedupe; the plan splits the
byte budget across contents by per-frame cost and orders playhead-first, then
forward, then a few earlier frames; retention follows the same priority so the
next frame to play is not evicted. It holds at most 256 requests, round-robin
across contents: `ahead` for frames at or after a playhead, `background` for
history behind it, each ranked by its place in the plan. A replan aborts
requests outside the latest window and re-classes and re-ranks the ones it
keeps: a frame the playhead passed drops to `background`, and a seek back
raises kept history to `ahead` with the plan's rank. A request still waiting in
the renderer's send window is sent in that order; main never sees the rank, and
moves a capture already in its queue to the back of its new class. For content
main is preparing, lookahead only reads persisted frames; otherwise it may
capture its window.

**L2 — disk.** One `.wfrm` per frame under
`<workspace>/Cache/raster/<hash>/<frame>.wfrm`, where `<hash>` is
`hashCacheKey` (two FNV-1a-64 lanes, 32 hex chars) of the key: a 16-byte header
(magic `WCMFRM03`, dimensions), the band count and lengths, then straight RGBA8
in up to eight bands of rows, each a zstd level-1 frame with its content
checksum, the frame's only content check (ADR 0078). A band's rows are a
multiple of 4, so each band decodes and scales on its own, in parallel. Files are
atomically replaced and disposable. A format change moves the key namespace, so
older directories are collected rather than read.

### Admission

Every renderer consumer gets a frame through `motifFrameSource.ts`:
`peekMotifFrame` for a synchronous L0 hit, `acquireMotifFrame(descriptor,
{ scaleDiv, priority, order?, signal, owner?, purpose?, finalizationToken? })`
for any frame. The descriptor carries the cache identity and the capture
inputs. It returns `{ lease, setPriority(priority, order?) }`; `setPriority`
re-classes and re-ranks the request while it is pending. A frame comes back as
a lease: a preview lease pins its L0 bitmap until `release`, so
eviction never closes a frame a sprite has bound; an export lease owns its
bitmap. Callers never learn whether a frame was read or captured, or which
divisor L0 stored it under.

Priorities, highest first: `current` (the frame on screen, an export frame),
`ahead` (lookahead at or after the playhead), `background` (lookahead behind
it). A `current` request from an `owner` supersedes that owner's previous one;
aborting a request's signal withdraws it. `order` ranks a request within its
class, lowest first; unranked ones go last. Identical requests (lane, cache
key, frame, divisor, finalization token) share one job at the highest priority
and lowest order of its subscribers, and a priority change, up or down, or a
cancel reaches main as a control of that capture request. The job publishes a preview result to L0 once and pins it
for each subscriber; a result nobody wants any more is closed unpublished.
Parameter-preview frames use the overlay lane: no cache address, never read,
never stored. Export frames never enter L0.

`MotifFrameScheduler` admits jobs with **three disk-read slots and a capture
send window**, `current` before `ahead` before `background`. A `current`
capture is sent to main at once, never held behind lookahead. `ahead` and
`background` captures are sent lowest order first, ties in arrival order,
while fewer than `captureRequests` (2) of them are in main. One promoted to
`current` there keeps its place until it settles, and one demoted from
`current` there takes a place, so later lookahead waits for both. Export work takes neither: the export
stream's byte budget bounds it, and its frames pipeline. Admission
consults exact per-frame coverage: known holes skip disk I/O, unknown coverage
is probed, and a new write wakes queued requests so they read instead of
capture. A read miss drops the frame from coverage, releases its read slot and
captures; a `stored` reply reads the frame. The first capture of a job goes
without `afterMiss`, so main stats the store, and a stale miss of a stored
frame is answered `stored` and read again without a capture. Once main has
answered `stored`, every later capture of that job is `afterMiss`, which main
never answers `stored`: it captures and offers a write like any display. A
skipped live write leaves the file as it was; the miss already dropped the
frame from main's coverage, so preparation counts it as missing. A `stored`
reply to one anyway rejects with code `miss`, which the cursor retries with
backoff, so a corrupt file costs two reads and one capture and cannot cycle
between `stored` and a failed read. A read's transport error rejects and never
captures. A stored or persisted reply records the frame in coverage even when
nobody wants it any more, but never across a project reset. Content main is
preparing is captured only for `current` demand. Committed and export requests
wait for the baked-key inventory. A project reset supersedes queued and admitted
work.

In main, each capture request (`motif:capture`) names itself with a request id,
its priority, and optionally its cache address, `store: 'keep'` (export) and
`afterMiss`; `motif:capture-control` changes the priority of a request or
cancels it by `(sender, request id)`. A withdrawn request is answered
`{ kind: 'superseded' }` rather than thrown, so a routine cancel logs nothing;
the renderer's transport rejects it as a `superseded` MotifError. `MotifFrameJobs` holds one job per cache
address of the workspace store
([ADR 0160](adr/0160-one-request-for-a-motif-frame-one-job-per-cache-address.md)):

- A display without `afterMiss` first stats the store; a stored frame answers
  every such display `stored`. Persistence and `afterMiss` displays never take
  that answer and go on to capture.
- Until the capture's lease, any request joins the job, whose capture runs at
  the highest priority of the requests left; the last one leaving cancels it.
- At the lease every display gets pixels: on Windows its own GPU copy, on a
  bitmap host one straightened picture for all. A persistence request or a kept
  display makes the write one that waits for a slot; otherwise the displays
  offer a [live write](#preparation-l2-baking). A display that was not kept
  does not wait for the write.
- A request after the lease waits for the write: once written, a display is
  answered `stored` (an `afterMiss` one captures again) and persistence is done;
  a failed or skipped write starts a new job.
- A capture failure with its own code fails every request; a `device` or
  uncoded failure before the lease moves the session to bitmaps and captures
  again for all. One in the readback after the lease (an unsupported texture,
  an encoder that cannot open, a texture leased before the switch) moves the
  session first and captures again for persistence, as a bitmap. A failed
  write fails persistence with its code, keeps the pixels displays already
  have and reports a kept display not persisted.
- A job reserves its capture memory once, when its capture reaches a host,
  borrowed from the plan of the first export in it then; an export joining
  later is not charged. A queued job holds nothing, a refusal fails every
  request `capacity` there, and a job nobody wants by then is superseded
  before it takes a host, without reserving. While an export holds its plan,
  editor captures are refused `capacity`, answered
  `{ kind: 'capacity', detail }` like `superseded` and turned back into a
  `capacity` MotifError at the preload frame port; the preview cursor and the
  lookahead back off on `previewRetryMs`, and export frames are charged to the
  plan.

Captures without a cache address (parameter previews, the e2e hook) and PNG
captures (MCP, covers, the Motif panel's preview, all `background`) are never
shared.

### Reading stored frames

One `MotifFrameReader` per document owns every stored-frame read
([ADR 0154](adr/0154-motif-frames-are-read-at-preview-scale-through-one-reader.md)):
read `(cacheKey, frame, scaleDiv)` → `ImageBitmap`, or null when the frame is
absent or fails verification. Preview reads at `playbackScaleDiv` (1 / 2 / 4);
export and finalization read at 1. A native core reads, decompresses (zstd
verifies the checksum as it goes) and downscales (alpha-weighted box, size
rounded up). At most three reads are in flight per document.

- **Windows — texture lane.** Main's `MotifGpuTransport` uploads the scaled
  frame into a D3D11 slot sized for the divisor. Before acknowledging the slot,
  preload proves Chromium's copy out of it has run: it draws one pixel of the
  bitmap on an accelerated canvas and reads that pixel back
  (`motifReadBarrier.ts`). Both sides take the slot's keyed mutex with key 0,
  which excludes but does not order, so the ack must wait; a CPU-backed canvas
  would read the whole frame back instead
  ([read path](notes/motif-texture-read-path-2026-11-06.md)). A free lane goes
  to the oldest waiter. Pool memory is `motif_gpu_mib` (default 128 MiB) across at
  most `motif_gpu_sessions` (default 8) size/format pools, or the shared
  `gpu_buffer_mib` when shared allocation is on; allocation waits at most
  250 ms. A pool that reads stored frames counts twice its slot: it also holds
  the staging texture its frames are premultiplied into. A lane the budget
  cannot give a pool of its own takes the next idle pool of the same shape
  rather than retiring it. A read the lane does not serve is
  answered `unavailable` with a reason, and takes the utility lane. `read`
  concerns that read alone: a frame over the [texture limit](#limits), the
  GPU budget or its 250 ms wait, a held file or mutex, a failed upload.
  `lane` means the lane is off for the document: its pool's GPU device, a
  shared-texture import or its send to the page failed. Main then answers
  every read `lane` before opening the file, and the document's reader stops
  asking until the lane is reset: `MotifGpuTransport.close` for the document
  (a navigation, a new document, an export's preparation) turns it on again
  and sends `motif:texture-lane-reset` with the document's lane generation. A
  `lane` answer from an older generation is ignored, as the answer and the
  reset reach the page by different routes.
- **macOS, Linux and the Windows fallback — utility lane.** One app-wide
  utility process (`motif-reader-host.ts`, started on first use, restarted with
  backoff) runs the core and posts scaled RGBA on a `MessagePortMain` to the
  document's `motifReaderWorker.ts`, which makes the bitmap. Requests name
  `(hash, frame, scaleDiv)`; the utility resolves them under the raster root and
  workspace generation main gives it and reports misses to main with that
  generation.

Decoded bands go through band buffers the readers of a process share. A process
keeps up to `scratchIdleBytes` of them idle (32 MiB) while it has an open
reader, and frees them when its last reader closes. The utility holds its one
frame file reader while any document has a port to it; on Windows, main's
upload pools are its readers (a copy pool decodes nothing).

A transport failure (the utility exits, a port or slot fails) is not a miss: the
reader restarts the lane and retries once, then preview keeps its previous frame
and export fails, without marking the file bad. Reader counters and stage
medians appear as `motifReader` in the compositor perf snapshot.

### Preparation (L2 baking)

Main's `MotifBakeWorkspace` binds frame storage and preparation to one Workspace
session; its `MotifBakeCoordinator` owns inventory, queued ranges, progress,
pauses, bounded retries and collection
([ADR 0108](adr/0108-motif-preparation-belongs-to-the-workspace-session.md)).
Automatic demand covers used ranges when the `prebake_motifs` setting
("Pre-bake all motif content", default off) is on; **Pre-bake now** on a layer demands its
full content and moves it (or the Motifs a Group holds when the request is first
seen) to the front. The window holds the choice for the Workspace session, across
preview rebuilds, and drops it when its layer is deleted; undo restores the layer,
not the choice. The choice belongs to the requested layer: deleting a Group
requested with Pre-bake now drops the full-content demand for every Motif it
expanded to, even one that stays in the project. Clips finish in
timeline order (start time, then track/layer order). Up to three frames of the
current clip are in the capture queue at once (ADR 0159); the order is decided
again as each settles.
Renderer reload and preview disposal do not cancel main's work; close, reopen
and Save As retire the session, and admitted writes cannot publish into the next
one. In the renderer, `prebakeIntents` holds the window's Pre-bake now choices;
`motifDemand` turns committed layers and those choices into the preparation plan
and, with main's snapshots, into layer status (pure functions);
`MotifDemandSession` applies both, and the lookahead plan, and maps snapshots
into the baked-key index;
`MotifBakeClient` carries the IPC.

- **One rule for what reaches the disk.** Every captured frame with a cache
  address is stored, whoever captured it; the setting only decides whether frames
  nobody has asked for are generated. Disk use is limited by the temporary cache
  space, not by the setting.
- **Persistence owns no display bitmap.** Inside the lease a native worker
  reads the OSR texture (Windows) or the paint's bitmap is copied; after it,
  each band is straightened by the thread that compresses it into `.wfrm`. A
  display's live write encodes the picture it already straightened. The write
  is atomic before main marks the frame complete.
- **Every stored frame goes through `MotifFrameWriteQueue`**
  ([ADR 0158](adr/0158-stored-frames-leave-the-capture-lease.md)). At most two
  frames hold pixels. A frame someone asked to keep (bake, export) waits for a
  slot inside its lease, which is the backpressure on capture. One write per
  address is the job table's: every write of an address is its job's
  ([Admission](#admission), ADR 0160).
- **A live capture stores itself:** a committed preview frame offers itself at its
  cache address and is skipped when both slots are taken, under memory pressure or
  when the cache has no room. It is the tail of a foreground capture, so the
  *background processing during playback* setting does not stop it, and a failed
  write reaches neither the display nor the GPU path. Replays then read instead of
  capturing again. Parameter previews have no cache address and store nothing. A
  session whose texture readback failed stores nothing live: its display texture
  has no pixels main can read. A readback refused for a held mutex, the texture
  limit or a closed reader costs a display that frame's receipt and fails a
  bake's frame; the next frame reads its texture again.
- **Inventory is stat-only.** On open, a frame counts when `<n>.wfrm` is a
  regular file larger than the 16-byte header; files are never opened. The
  first open of a file after boot costs ~6 ms on the Windows bench (Defender),
  which made a 10,337-frame project take 61 s to inventory; stat takes 0.73 s
  ([footprint findings](../poc/motif-frame-cache/FOOTPRINT-FINDINGS.md)). A
  corrupt file counts as covered until read; the read miss drops it and
  re-captures. `ready` requires coverage of the demanded ranges, so an
  interrupted bake resumes at its holes.
- **Collection.** Hash directories no live key references are collected, but
  never while any Motif layer is unresolvable against the current catalog
  (`liveRasterKeys.ts`): "can't resolve now" is not "orphaned", and wrongly
  deleted frames cost minutes of serial re-capture.
  The native disk sweeper retains referenced directories; insufficient
  temporary space pauses growth instead of evicting and regenerating.

Status: main reports `queued | baking | paused | retrying | ready | error` with
completed/requested counts; `paused` names playback policy, memory pressure,
resource admission or disk capacity (a `capacity` or `disk` failure); a
`content` failure is `error` at once, any other retries a bounded number of
times; `ready` means the requested range is persisted. The renderer adds `warming` for L0-only coverage. The timeline status
dot and the property panel show these; idle and ready need no panel row.

## Limits

`native/src/motif_limits.rs` holds the fixed sizes and
`shared/motifs/limits.ts` mirrors them; main and the reader utility refuse to
start when the addon's `motifLimits()` differ from the mirror, or when it lacks
a Motif export (`loadMotifNative`).

- **A frame** is at most 8192 pixels on each side, 256 MiB of straight RGBA
  (`fitsMotifFrame`). Manifests, bake plans, stored headers and the native
  encoder and reader all check it.
- **A GPU texture** is at most 128 MiB (`fitsMotifTexture`): a pool's one slot
  plus, for a pool that reads stored frames, its staging texture; and the
  capture host's surface, marker rows included, which the bake reads back. A
  full-size 8K frame does not fit.

A frame over the texture limit never turns a lane off: its read takes the
utility lane, and its capture gets a bitmap host (the host is rebuilt when the
size asks for the other kind). A smaller frame of the same Motif gets the
texture host again. Only a failure of the GPU path itself is sticky: a
`device` failure of a pool, or a shared-texture import or send, turns the
texture lane off for that document; a `device` or uncoded failure of the
capture output moves the session to bitmaps.

## Tuning

The Motif frame path's performance numbers (frames and reads in flight,
capture rate, write slots, GPU lanes, band threads, lookahead size and more)
were measured on few machines, so they are tunable per run:
`WEFTCUT_MOTIF_TUNING=readsInFlight=4,writeSlots=3`. `MOTIF_TUNING_SPEC` in
`shared/motifs/tuning.ts` is the list: each key's default, the range an
override may take, and where the default was measured. An entry naming no key,
or a value outside its range, keeps the default and is reported in one warning
at startup. The counts and times this page gives for these keys are their
defaults.

Main reads the variable once (`main/motif/tuning.ts`), before any Motif module
exists, and hands the result to its modules, to renderer windows and the reader
utility on their argv. In each of the two processes that load the native core,
`loadMotifNative` (`main/motif/native.ts`) gives it its share once. Protocol
deadlines and retry schedules (`MOTIF_DEADLINES`, beside them) and the
[limits](#limits) are not tunable.

## Failure codes

A Motif failure is a `MotifError` (`shared/motifs/errors.ts`) with one code:
`superseded`, `closed`, `miss`, `content`, `timeout`, `capacity`, `disk`,
`oversize`, `transient`, `device` or `transport`. napi, `ipcMain.handle` and
message ports carry only a message, so the code travels as a
`[motif:<code>] detail` tag (the native side: `native/src/motif_error.rs`),
decoded once where a message enters a process: the native adapter
(`main/motif/native.ts`, in main and the reader utility), the preload frame
port and the renderer's frame transport.
In-process code checks the code, never the message. The app-wide
`resource-capacity-exceeded` refusal becomes `capacity` where a Motif path
meets it.

A stored frame the native read cannot use is a `miss`; one another process
holds open (Windows sharing violation, or a busy header read) is `transient`,
which sends a texture-lane read to the utility lane (`unavailable`, reason
`read`) and keeps the frame in coverage.

## Compositor

`MotifSprite` receives the layer-relative time `tInLayerUs`, maps it to a frame
with `frameIndexInLayer` on the exact rational grid (never `round(µs·fps)`),
clamps to the content, and binds the frame its `MotifPlaybackCursor` gets: an L0
hit (`peekMotifFrame`), else a `current` request the cursor owns. The sprite
holds the bound frame's lease and releases the previous one after binding. A
frame the cursor gets binds only when the sprite presents, so a held scene
keeps drawing the frame it showed. It
draws a reduced bitmap at the Motif's logical size, so geometry, anchors and the
gizmo do not change with the divisor.

A Motif behind its target keeps showing its latest earlier frame, as a late
video frame does. A visible Motif with no frame of its target's content at or
before the target (a first visit, a jump back, new props) would show nothing
over a black canvas, so the preview keeps its last picture instead, for up to
`previewHoldMs` (500 ms) or until the Motif's capture fails, then presents
without it. The scene gate is the one a video clip's first visit uses
(`CompositionNode` §canPresentClipsAt); it moves the Motif's demand but never
its texture. Export waits for every frame and never holds.

## Export

The export Worker never captures or touches filesystem IPC. `MotifFrameProducer`
(`renderer/render/worker/motifStream.ts`) plans the content frames each output
frame needs (trims, nested Groups, retiming), gets each through one
`acquireMotifFrame` (purpose `export`, `current`, full size, the export's
finalization token), and transfers the owned bitmaps to the Worker. A request
waits for the baked-key inventory, reads a covered frame, and otherwise asks
main to capture and keep it; main may answer that the frame is already stored,
and the request reads it. Credits return only when the Worker has composited and
closed a packet's bitmaps, not on transfer. The window is at most three output
frames (`resourcePlan.motifFrames`) and a byte budget from the export resource
plan; each task reserves twice its pixels (readback or persistence), and a
single frame over the budget fails with the resource-capacity error. Export does
not wait for background baking.

A missing frame is captured with the same host and frame-grid inputs as preview
and kept by main, sharing one capture with a bake or preview of the same frame
queued at the time ([Admission](#admission)). A failed
write leaves that frame uncached and the export keeps its pixels; a capture
failure fails the export. Cancelling stops admission and keeps completed cache files.

## User Motifs

User Motifs live under `<dataRoot>/motifs/`, shared by all projects, and render
through the same path as built-ins. Lifecycle in the property panel:

- **Built-in** → "Duplicate & edit" forks a draft (built-ins cannot be
  overwritten). **Installed** → Edit opens a working draft targeting it, and the
  selected layer swaps onto the draft.
- **Update** republishes the draft over its target and bumps the version; every
  placement in every project re-renders (the key is source-derived). Layers in
  this project that referenced the draft rebind to the target with props
  lenient-migrated, in one undo step. **Save as new** publishes a separate id;
  **Discard** swaps the layer back and deletes the draft.
- A placed draft has a source panel (edit HTML + island, Apply). The Motif store
  is watched: saving any Motif file externally resyncs the catalog and
  re-captures.

Because updates are live, a layer's `motif_version` is only a seen-at marker.
On project open a mismatch raises a one-time **"Motifs changed since you placed
them"** notice and a status-log entry (`main/motif/staleness.ts`); dismissing it
bumps the markers in one undo step. There is no global reverse index of which
projects use a Motif. A project referencing a deleted Motif shows an error
placeholder.

**Import Motif** takes a `.zip`; **Export Motif ZIP** writes `<motif-id>/` with
every companion file (private draft metadata omitted). Library cards offer
Export, and Delete in the context menu (not for built-ins). Limits and
directory workspaces: [`motif-workspaces.md`](motif-workspaces.md).

Library **covers** are default-props PNGs captured at the poster time at 30 fps,
scaled to fit 480×270, cached under `<dataRoot>/cache/motif-covers/` and
invalidated by package or runtime changes. Covers are derived local data,
independent of placed props, project fps and frame bakes.

## Agent surface

`add_layers` (kind `motif`) places a Motif by props only and resolves built-ins, installed
Motifs and drafts. `list_motifs` (mirrored by `motifs://current`) returns the
manifest-only catalog with `status` (`builtin | installed | draft`),
`revision` and `target_id`; a draft with a proposal carries `publication`.
Authoring uses `open_motif_draft`, `read_motif`, `update_motif_files`,
`preview_motif`, `install_motif`, `export_motif` and `delete_motif`
([`motif-workspaces.md`](motif-workspaces.md)). `install_motif` only proposes:
the user approves or rejects the proposal on its card in the Motifs panel
(ADR 0046). Agents never drive the renderer directly.

## Security

User Motifs are untrusted documents; the capture host is the trust boundary:
a dedicated offscreen window, no preload and no Node on the `motif:` origin, and
the render CSP (`main/motif/protocol.ts`):
`default-src 'none'; script-src 'unsafe-inline' 'self' 'wasm-unsafe-eval';
style-src 'unsafe-inline' 'self'; connect-src 'self' data: blob:; img-src 'self'
data: blob:; font-src 'self' data:; worker-src 'self' blob:`. Pages are offline
and cannot read other Motifs; plain JS eval stays blocked.

Dedicated local/Blob Workers and WASM exist so 3D decoders (Draco, KTX2/Basis)
can initialize during setup. The runtime limits managed Workers to eight and
retires them after setup; that is a lifecycle contract, not a security boundary.
The bundled Basis transcoder is rebuilt without dynamic execution rather than
granting `'unsafe-eval'` ([`motif-three-model.md`](motif-three-model.md)).

- Manifests are validated at write/import (`Manifest`/`PropSpec`: `size`
  bounds, well-formed `props_schema`, finite positive durations).
- Capture deadlines fail a hung frame and rebuild the host (above).
- The `motif:` resolver rejects `..`, absolute and separator escapes and
  confirms the path stays under the Motif's directory.
- Minted ids never shadow a built-in or the reserved `drafts/` segment; the
  manifest's own `id`/`version` are ignored.
- The parameter page runs inside the editor window in its own sandbox
  ([Parameter UI](#parameter-ui), [`security.md`](security.md)).

Residual risk: a Chromium renderer exploit (mitigated by the isolated offline
host); a determinism-violating Motif renders wrong but harmlessly.
