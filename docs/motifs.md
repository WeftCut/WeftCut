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
seek. Captures take the paint carrying the frame's id (marker row, below), so
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

`main/motif/capture.ts` owns one lazily created offscreen `BrowserWindow`,
reused across Motifs, frames and layers. It loads the capture host page beside
the Motif's `index.html`, which frames the Motif at the capture size above one
marker row; the runtime runs in both and forwards the entry points. Requesting
another Motif navigates the same window (runtime re-injected, readiness
re-probed). The host sets
`Emulation.setDeviceMetricsOverride` (any resolution) and a transparent default
background so `background: transparent` stays real alpha.

- **Output.** Every capture is the paint whose marker row carries the frame's
  id (`OffscreenFrames`). Windows: OSR shared textures, copied into the Motif
  transport pool
  ([ADR 0078](adr/0078-motifs-cache-pixels-and-transfer-persistent-textures.md)).
  Elsewhere: the paint's bitmap, straightened natively and sent as RGBA
  ([ADR 0159](adr/0159-motif-captures-are-pipelined-paints.md)). No capture
  takes a screenshot; PNGs (MCP previews, covers) are encoded from the leased
  pixels. A failure of the texture output itself (lease, GPU copy, readback)
  switches the session to bitmaps; a timeout, disk error, capacity refusal,
  superseded request or Motif failure never does. `WEFTCUT_MOTIF_CAPTURE=bitmap`
  forces bitmaps for diagnosis.
- **One serial chain, pipelined.** Renders are serialized in queue order; a
  render returns once its frame has committed, and the next frame of the same
  page renders while up to three earlier ones are still on their way to a paint
  (ADR 0159). A navigation or resize waits for those paints. A frame the
  compositor skipped (a later id painted first) renders again. Sprite requests
  carry a coalesce key: a newer request replaces a queued older one from the
  same sprite (the replaced waiter rejects as superseded). Foreground tickets run
  first; a background ticket waiting 2 s gets one frame between them.
- **Deadlines.** Every CDP command goes through the host's timed `send`
  (5 s); awaited setup gets 30 s; the renderer's capture transport allows 60 s
  so it does not pre-empt setup. A timeout throws `MotifCaptureTimeoutError` and
  tears the host down for rebuild.
- **Failure latching.** A Motif whose script throws fails its lane
  (`motifId` + `contentHash`) until an edit changes the hash or an explicit
  retry. A timeout is probation: one more attempt on the rebuilt host; a second
  consecutive timeout latches the lane, a success clears it. Load cannot be told
  from an infinite loop, and a heavy 1080p page normally takes ~1 s, so one
  slow frame must not lose a Motif for the session (measured on a 2-core Linux
  box: a 3.5 s frame timed out under load and rendered in 4.8 s once it lifted).
  Other mid-render transport failures (detached debugger, crashed renderer)
  still latch at once.
- **Bitmap host canvases** are forced CPU-backed (`willReadFrequently`) by
  `bitmapCanvasRuntime.ts` (ADR 0078): the marker cannot see a missing
  accelerated canvas layer.

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

**L1 — lookahead.** `MotifPrewarmer` fills L0 ahead of the playhead during
playback and while paused. Identical contents dedupe; `planPrewarmTargets`
splits the byte budget across contents by per-frame cost and orders
playhead-first, then forward, then a few earlier frames; retention follows the
same priority so the next frame to play is not evicted. It registers at most 256
cancellable subscriptions, round-robin across contents. Results outside the
latest window are closed. For content main is preparing, lookahead only reads
persisted frames; otherwise it may capture its window.

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

`FrameBroker` deduplicates identical requests and serves L0 hits; each consumer
gets its own bitmap clone, and cancelling one consumer never closes another's
frame. Behind it, `MotifFrameScheduler` admits work for preview, lookahead,
baking and transient parameter previews with **three disk-read slots and one
capture slot**. Admission consults exact per-frame coverage: known holes skip
disk I/O, unknown coverage is probed, and a new write wakes queued requests so
they read instead of capture. A read miss releases its read slot before joining
the capture queue and invalidates that frame's coverage. Foreground subscribers
promote queued work; background baking and speculative capture alternate. A
project reset fences queued and admitted work. Main's `MotifCaptureService`
likewise shares overlapping display and persistence captures.

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
  rather than retiring it. Decoded bands go through buffers every reader
  shares, at most 32 MiB of them idle. If no slot can be used, main answers
  `unavailable` and the read takes the utility lane.
- **macOS, Linux and the Windows fallback — utility lane.** One app-wide
  utility process (`motif-reader-host.ts`, started on first use, restarted with
  backoff) runs the core and posts scaled RGBA on a `MessagePortMain` to the
  document's `motifReaderWorker.ts`, which makes the bitmap. Requests name
  `(hash, frame, scaleDiv)`; the utility resolves them under the raster root and
  workspace generation main gives it and reports misses to main with that
  generation.

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
full content and moves it (or a Group's Motifs) to the front. Clips finish in
timeline order (start time, then track/layer order).
Renderer reload and preview disposal do not cancel main's work; close, reopen
and Save As retire the session, and admitted writes cannot publish into the next
one. In the renderer, `MotifFrameService` projects committed layers into
demands and maps main's snapshots into the baked-key index and layer status;
`MotifBakeClient` carries the IPC.

- **One rule for what reaches the disk.** Every captured frame with a cache
  address is stored, whoever captured it; the setting only decides whether frames
  nobody has asked for are generated. Disk use is limited by the temporary cache
  space, not by the setting.
- **Persistence owns no display bitmap.** On Windows a native worker reads the
  OSR texture inside the lease and encodes `.wfrm` after it; a bitmap is
  straightened natively and encoded the same way. The write is atomic before
  main marks the frame complete.
- **Every stored frame goes through `MotifFrameWriteQueue`**
  ([ADR 0158](adr/0158-stored-frames-leave-the-capture-lease.md)). At most two
  frames hold pixels, one write per address. A frame someone asked to keep (bake,
  export) waits for a slot inside its lease, which is the backpressure on capture.
- **A live capture stores itself:** a committed preview frame offers itself at its
  cache address and is skipped when both slots are taken, under memory pressure or
  when the cache has no room. It is the tail of a foreground capture, so the
  *background processing during playback* setting does not stop it, and a failed
  write reaches neither the display nor the GPU path. Replays then read instead of
  capturing again. Parameter previews have no cache address and store nothing. A
  session whose texture readback failed stores nothing live: its display texture
  has no pixels main can read.
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
resource admission or disk capacity; `ready` means the requested range is
persisted. The renderer adds `warming` for L0-only coverage. The timeline status
dot and the property panel show these; idle and ready need no panel row.

## Compositor

`MotifSprite` receives the layer-relative time `tInLayerUs`, maps it to a frame
with `frameIndexInLayer` on the exact rational grid (never `round(µs·fps)`),
clamps to the content, obtains the frame through L0 → reader → capture, and
binds it as its texture. It draws a reduced bitmap at the Motif's logical size,
so geometry, anchors and the gizmo do not change with the divisor.

## Export

The export Worker never captures or touches filesystem IPC. `MotifFrameProducer`
(`renderer/render/worker/motifStream.ts`) plans the content frames each output
frame needs (trims, nested Groups, retiming), reads them through the reader or
requests a foreground capture, and transfers owned bitmaps to the Worker. Credits
return only when the Worker has composited and closed a packet's bitmaps, not on
transfer. The window is at most three output frames
(`resourcePlan.motifFrames`) and a byte budget from the export resource plan;
each task reserves twice its pixels (readback or persistence), and a single
frame over the budget fails with the resource-capacity error. Export does not
wait for background baking.

A missing frame is captured with the same host and frame-grid inputs as preview
and stored through the write queue, joining an overlapping bake. A cache-write
failure keeps the valid pixels and only logs; a capture failure fails the
export. Cancelling stops admission and keeps completed cache files.

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
