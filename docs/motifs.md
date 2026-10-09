# Motifs

A Motif is a parameterized, time-varying overlay — a lower-third, a countdown, an
animated title card, a callout. The user picks one from the catalog, fills in its
props, and drops it on the timeline as a `Motif` layer; from then on it must
produce correct pixels at every composition frame, in both the live preview and
the export.

A Motif is **a real web page** — arbitrary HTML/CSS/SVG/canvas/WebGL and animation
libraries. There is exactly one rendering path, internally called **webcap**: the
page is driven to a precise time `t` and captured to a bitmap via the Chromium
DevTools Protocol (CDP), driven over `webContents.debugger` against an offscreen
Electron window. No per-engine backends, no engine-selection field.

This doc covers how a Motif instance becomes pixels. For the data model
(`MotifParams`, validation, the `add_motif` surface) see
[`data-model.md`](data-model.md); for the generic compositor see
[`render.md`](render.md).

## The principle, and the obstacle

The renderer's load-bearing principle is *preview pixels equal export pixels by
construction* — a single capture path feeds both surfaces. The hard platform wall
that shapes the design:

- **The export Worker has no DOM.** Preview runs in the renderer; export runs in a
  Web Worker against an `OffscreenCanvas` with no `document`/`<iframe>`/`Image`. It
  cannot run a Motif. So whatever produces preview pixels must produce export
  pixels through a path the Worker can consume — the **main process rasterizes,
  the Worker receives bitmaps**.

webcap clears it: capture happens on the main process, handing bitmaps to the
Worker for export. Windows now takes shared OSR textures from that browser
compositor; the portable CDP `Page.captureScreenshot` path is a real browser raster (not a
canvas read-back), so it sidesteps DOM-rasterization read-back hazards entirely —
the obvious "rasterize the DOM via an SVG `<foreignObject>`" route. (On Chromium an
inline `<foreignObject>` raster does not taint — measured, though external-resource
cases are unverified — so taint is not the binding reason. The Motif path uses CDP
capture regardless.)

The price of full web freedom is that a web page has its own clock and animates on
its own — nondeterministic, incompatible with a frame-exact editor (scrubbing,
re-export, preview==export all require that the same `t` always yields the same
pixels). The resolution is the **determinism contract**, the spine of the system:

> **A Motif renders as a pure function of time.** It never advances itself; the
> harness owns the clock and drives the page to each composition frame.

This is what makes Motifs a *video template system* rather than a screen recorder.
Everything else (capture, cache, export) is mechanism around this contract.

## Boundaries

- **In scope:** the authoring contract a Motif must satisfy, its parameter UI (the
  generated fallback form and a Motif's own `params.html`), the capture harness
  that turns it into bitmaps, the raster cache and its escalation levers, and how
  the compositor and export read Motif frames.
- **Out of scope:** adding/validating Motif layers ([`data-model.md`](data-model.md)),
  the generic per-frame composite ([`render.md`](render.md)), and audio/mux. A
  Motif carries no audio.

## Authoring contract

The author-facing contract — the `motif.define` lifecycle, the one law (state
is a function of `t`, never an accumulation), the manifest and its three
duration shapes, the `props_schema` variants, the fonts rule, and the sandbox
limits an author designs around — lives in
[`motif-authoring.md`](motif-authoring.md), the single normative spec. That
file ships inside the agent skill bundle together with the workspace and Three.js
guides it references.

Facts the rest of this document leans on:

- A built-in Motif is a packaged directory of `manifest.json` + `index.html`
  and companion assets. A user Motif is either a self-contained HTML document
  or an imported directory of HTML, scripts, styles, models, textures and fonts.
  User HTML carries an injected manifest island. Either way it is served to
  the offscreen capture host over the `motif:` URI scheme.
- Props are validated against the manifest's `props_schema` (unknown keys
  reject, missing keys fall back to defaults) and canonicalized into a stable
  key order, so identical inputs produce identical bytes and identical cache
  keys.
- Content duration takes one of three manifest shapes — `max_duration_s` /
  `max_duration_prop` (caps the layer; windowable via `src_in_us`),
  `content_duration_s` (fixed content length, freely extendable layer whose
  tail holds the last content frame), or none (content = the placed layer
  width). The held tail is what lets the cache collapse a static overlay to a
  single capture, and a fixed content-frame count is why trimming never
  invalidates cached frames.
- `settle_rafs` (clamped to `{0,1,2}`, default `2`) is how many real browser
  frames the harness waits after a seek before capturing.

## Parameter UI

The property panel gets a Motif's controls one of two ways, and a single file on
disk decides which.

**The generated fallback form is the default.** With no parameter page, the host
builds the form from `props_schema`: one row per prop, switched on its type —
text input (a textarea when `multiline`), color swatch, number field with
steppers, dropdown for `enum` — one flat list in the manifest's own key order
(only the props *values* object is canonicalized alphabetically; the schema keeps
its authored order), labelled with the prop key title-cased (`bg_color` →
"Bg Color"). Those
labels are deliberately **not** localized: user- and agent-authored Motifs carry
arbitrary on-disk keys, so there is nothing the host could register in advance.
Each row commits one key per gesture (the color swatch debounced, because a drag
through the OS color dialog would otherwise flood the serialized capture queue).
The same generator serves the picker's props form, so the two surfaces cannot
drift.

**A `params.html` takes the surface over.** A Motif that ships one owns its whole
props section — labels, order, grouping, conditional rows, and whatever controls
the author can write — and the host stops generating anything for it. The schema
keeps every other job it had.

### Enablement is presence

A `params.html` next to `index.html` in the Motif's directory is the entire
switch. There is no manifest field, so a Motif's UI can change without touching
its data contract: the catalog payload carries `has_params_ui`, which the main
process derives by stat'ing the file (built-ins once at boot — their assets are
packaged read-only; user Motifs on every catalog listing, published copy first
then draft), and the flag never enters the manifest island or manifest
validation. Companion file bytes now enter the content hash (ADR 0079), including
the parameter page. Dropping the file in — or deleting it — switches the panel
on the next catalog refresh, which the Motif directory watcher already triggers
on any file change. Of the built-ins, `text-fx` ships a page; `countdown` and
`lower-third` deliberately stay on the fallback form.

### Where the page runs

The panel frames `motif://<id>/params.html?v=<catalog revision>` with
`sandbox="allow-scripts"` and **no** `allow-same-origin`. The `?v=` is the
runtime catalog's revision, which the watcher bumps on any Motif file change, so
editing the page on disk reloads the panel instead of serving a cached copy. Four
consequences an author designs around:

- **The origin is opaque.** `localStorage`, `sessionStorage`, `document.cookie`
  and `indexedDB` *throw* on access. `event.origin` on an inbound message reads
  `"null"`, so window identity is the only check worth making — which is exactly
  what the host side does.
- **There is no network.** The params CSP keeps `default-src 'none'` with no
  `connect-src`, so fetch/XHR/WebSocket/EventSource are denied. Render documents
  separately allow same-origin/data/blob fetches. Assets are relative URLs
  (they resolve to `motif://<id>/…`) or
  `data:` URIs.
- **Companion files are allowed.** The params CSP uses `motif:` for `script-src`
  and `style-src`, so a page may split into `.js`/`.css` files beside it
  rather than cramming everything inline. Inline script and style still work, so a
  single self-contained file is fine too. `'self'` is used only by render pages —
  on the parameter page's opaque origin it would match nothing.
- **The app frames nothing else.** The renderer's own CSP grants `frame-src
  motif:` and no `'self'`, so a Motif's parameter page is the only embeddable
  context in the app. Full CSP rationale: [`security.md`](security.md).

The frame is transparent and the page paints its own surfaces from the theme
tokens it receives, so it reads as part of the panel rather than as a foreign
form.

### The protocol

Five verbs over `postMessage`, all `motif:`-prefixed so a page can ignore the
unrelated traffic any embedder eventually produces.

| Verb | Direction | Payload | When |
|---|---|---|---|
| `motif:init` | host → page | `{ motifId, layerId, props, schema, locale, themeTokens }` | once per loaded document, on the frame's `load` |
| `motif:propsChanged` | host → page | `{ props }` | the layer's props changed from *outside* this page (undo/redo, an agent edit, another surface) |
| `motif:preview` | page → host | `{ props }` (a patch) | mid-gesture |
| `motif:commit` | page → host | `{ props }` (a patch) | gesture end |
| `motif:resize` | page → host | `{ height }` (px) | whenever the page's content height changes |

`init.props` are the layer's committed props, leniently canonicalized, so a page
never has to reason about a stale stored value; `schema` is the manifest's
`props_schema` verbatim; `locale` is the app's active locale string; `themeTokens`
is a curated map of the app's CSS custom properties (surfaces, text, accent,
border, radius, font) — the page-facing subset, small on purpose so it can stay
stable.

**Nothing the page sends is believed.** The sender must be the frame's own
window, every payload is shape-checked before a field is read, keys the manifest
does not declare are dropped, and surviving values are lenient-canonicalized
against the current manifest — an invalid value degrades to its schema default.
Anything unrecognized is ignored silently. A page therefore cannot corrupt a
project, but a page that sends sloppy values watches them snap back, so send
well-formed ones (`#rrggbb` / `#rrggbbaa`, numbers inside `min`/`max`, enum
options that exist).

### The gesture model

- **`preview` never touches project state.** The patch lands in a per-layer
  overlay that the render path merges at its canonicalization choke point, so it
  reaches both the rasterized frame and the frame cache key — and nothing else: no
  backend command, no history entry, nothing in the project file. Only the
  on-screen sprite reads it; lookahead, main preparation, bake status and export
  frame requests all describe committed props, so a live gesture can never write a
  transient frame to disk or move a bake progress bar. The sprite routes
  overlay-affected frames to a separate small in-RAM lane (64 MB) rather than the
  committed-content L0 LRU, so a drag's per-tick cache keys can't evict committed
  frames; the lane is wiped when the gesture ends (commit, cancel, teardown).
- **Previews are throttled, so send freely.** The first patch of a gesture applies
  immediately and the rest coalesce into one update per 250 ms, matching the
  capture cost behind them (~80–100 ms per frame, serialized). Re-sending a value
  that has not changed costs no recapture.
- **`commit` is one history entry, however many keys it carries.** The whole patch
  rides a single `update_layer_params`, so coupled values (a preset landing three
  colors at once) are atomic and one undo takes all of them back. The overlay's
  committed keys are cleared only once the mutation settles — clearing eagerly
  would show the pre-commit frame for the length of the round-trip.
- **A page's own commit is not echoed back.** `propsChanged` fires for genuinely
  external changes only, so a page can repaint optimistically on its own edit
  without fighting a redundant update. An undo *does* arrive as `propsChanged`,
  which is what keeps a page's controls from showing stale values.
- **`resize` is advisory.** The host clamps the declared height to `[80, 1200]` px
  and sits at 240 until the page says otherwise, so a page can neither collapse to
  an invisible strip nor take the panel column hostage.
- **Teardown drops the gesture.** Selecting another layer, swapping the Motif, or a
  watcher-driven reload disposes the host: pending previews are discarded and the
  canvas returns to committed props rather than stranding on a half-finished drag.

### The reference page

`src/shared/motifs/builtin/text-fx/params.html` is the worked example and the
copy-paste template: a single self-contained document that groups its 13 props
into hand-ordered sections, switches its labels bilingually off `init.locale`
(the host never registers a Motif's strings — a page that cares about language
carries its own), skins itself from `themeTokens` with literal fallbacks for the
frame before the first message lands, shows rows only when they matter
(`type_speed` for the typewriter effect, `loop` for color-shift), composes an
RGB picker plus an alpha slider into `#rrggbbaa`, and offers preset swatches that
land three coupled colors in one commit.

## Determinism: owning the clock

Before any Motif code runs, the harness installs a clock takeover and seeks declared
animations to `t`:

| Animation source | How it is pinned to `t` |
|---|---|
| CSS animations/transitions, WAAPI | `document.getAnimations()` → `pause()` + `currentTime = tMs` |
| GSAP and other eased tweens | run on `requestAnimationFrame` + `performance.now` → both owned; the controlled rAF queue is flushed |
| canvas / WebGL render loops | bottom out on `requestAnimationFrame` → owned |
| `setTimeout` / `setInterval` / `Date.now` | stubbed to the virtual clock |

`seekTo(t)`: set the virtual clock; `getAnimations()` pause + `currentTime`; flush
the controlled rAF queue a bounded number of times (idempotent at a fixed clock);
force a layout flush; wait `settle_rafs` real browser frames so the paint commits;
then capture. The takeover is installed *before* any Motif code runs; an animation
that caches a `Date`/`performance` reference before that, or uses a time source the
harness does not hijack, is out of contract.

**The seek must stay re-seekable.** `seek()` only pauses and sets `currentTime` — it
never cancels or commits animations. Removing a completed animation would break
seeking *back* to an earlier time (the animation would be gone from
`getAnimations()`), violating the pure-function-of-`t` contract.

**Byte-identical determinism.** On Electron the offscreen-CDP capture is
**byte-identical across runs and across operating systems** at a fixed `t` — the
clock takeover freezes the frame, so two captures of the same Motif at the same `t`
produce the same bytes (verified across Windows, Linux, and macOS). Conformance
checks therefore assert exact-byte equality, not just a perceptual tolerance. The
cache captures each frame index once and reuses it.

## Capture harness

- **One reused offscreen Electron BrowserWindow host.** A single offscreen
  `BrowserWindow` (driven over `webContents.debugger` / CDP) is created lazily on first
  capture and reused across Motifs, frames, and layers. The footprint is one extra
  browser process tree, not one per layer.
- **Window-as-isolation.** The Motif is loaded as the host window's **top-level
  document**, served by the `motif:` scheme. Isolation comes from: a dedicated
  offscreen BrowserWindow (separate from the editor shell), no preload / disabled
  Node integration on the `motif:` origin, and a strict CSP (`default-src 'none'` plus
  only what capture needs) so the page is **fully offline** and can make no network
  request. The clock-takeover runtime is injected at document-start (before the
  Motif's `motif.define(...)`).
- **Multi-Motif navigation.** When a capture requests a different Motif than the one the
  host currently holds, the host **navigates** to the new `motif:` URL (reusing the
  window and CDP session; the init runtime is re-injected on the new document), and the
  capture state is reset so the readiness probe re-confirms the new page and the render
  metrics re-apply.
- **Capture via CDP, over `webContents.debugger`.** The host drives
  `Emulation.setDeviceMetricsOverride` (arbitrary resolution, independent of the physical
  screen), `Emulation.setDefaultBackgroundColorOverride` (alpha 0, so a Motif's
  `background: transparent` is preserved as real alpha instead of being flattened onto
  CDP's default opaque white). The portable output is `Page.captureScreenshot` (lossless **PNG** — the
  Canvas/CDP WebP path is lossy and crisp text edges matter). A `Runtime.evaluate`
  awaiting `window.__motifRender(t, props, meta)` runs `setup`/`frame`/seek/settle and
  resolves when the frame is visually ready; PNG capture or the Windows OSR
  texture copy follows (see the transport details below). The whole
  render+capture is **serialized** on the one host so preview, background
  preparation, export and cover requests cannot interleave and screenshot a stale
  frame. On-demand sprite requests additionally carry a per-layer **coalesce key**:
  a newer frame's request replaces a still-queued older one from the same sprite
  (latest wins, the replaced waiter rejects with a distinct superseded error), so
  real-time playback can't pile a stale-request backlog onto the one chain ahead of
  background preparation. Foreground tickets normally run first; a background
  ticket waiting two seconds receives one frame between foreground tickets, so
  background work cannot starve when resource policy allows it. Every CDP step
  is timeout-fenced — a wedged offscreen
  renderer fails the capture and tears the host down for rebuild rather than hanging
  the chain for the process's life.

## Raster cache and escalation

A capture costs tens of ms for a simple built-in to ~1 s for a heavy 1080p page — far
more than a cheap vector raster — so the cost is
managed by reuse of content-frame identities: repeated requests for the same
content frame share work, and existing frames are read without another capture.
Different frame indices remain distinct cache entries, even if their pixels happen
to match. Three escalation levers sit over the one capture function:

- **L0 — on demand (default).** The playhead frame is captured when needed and bound as
  a texture, at the resolution the composite needs. An in-RAM LRU of per-frame bitmaps
  bounded by a byte budget (512 MB of decoded RGBA — a frame count cap would let
  240 × 1080p frames pin ~2 GB); evicted bitmaps are closed promptly.
- **L1 — in-RAM lookahead (always on).** A budget-paced background prewarmer fills the
  shared L0 cache ahead of the playhead, off the play loop, during playback and while
  paused. Active layers dedupe by content cache key (N identical Motifs warm one content
  set); a pure planner orders playhead-first, then forward, then earlier frames for small
  backward scrubs; the per-content budget divides the L0 byte budget by each content's
  per-frame cost (renderW × renderH × 4). Each plan also refreshes L0 retention
  in that priority order: upcoming cached frames stay more recent than played
  frames, so adding a farther-ahead frame does not evict the next one to play.
  An in-flight prewarm result outside the latest window is closed rather than
  inserted; results still needed by the new plan remain usable after a seek.
  When main already owns preparation for a content, this lookahead only reads
  persisted frames and waits for missing coverage; it does not create a competing
  capture sequence. The foreground playhead can still request a missing frame
  immediately. Without main preparation, lookahead can capture its bounded window.
- **L2 — persisted frames.** One disposable `.wfrm`
  LZ4/straight-RGBA file per frame under `<workspace>/Cache/raster/<hash>/`,
  where `<hash>` is a 128-bit hash (two FNV-1a-64 lanes, 32 hex chars) of
  `(captureRuntimeVersion, motifId, version, contentHash, canonicalProps, renderW, renderH, fps, contentDurationFrames)`.
  Survives reload, caps the in-RAM working set, and lets export read frames off disk;
  safe to delete (regenerates). Driven by a global **Pre-bake** setting (off by default)
  and a per-layer **Pre-bake now** action. Main owns preparation for the Workspace
  session: automatic demand covers used ranges, explicit demand covers full
  content, and finishing clips in order reuses page setup. Renderer reload does
  not cancel work. Queued, paused (with reason), retrying and failed states are
  distinct from durable readiness. Referenced frames are retained against
  eviction; insufficient temporary space pauses new growth rather than causing
  repeated regeneration. See [ADR 0108](adr/0108-motif-preparation-belongs-to-the-workspace-session.md).
  Reads are disk-first, guided by main's exact frame inventory mirrored in the
  renderer's baked-key index. Known holes avoid needless disk reads; unknown
  coverage retains the disk probe until discovery succeeds. On project load, hash
  dirs no live key references are garbage-collected — but only after re-pulling the user-Motif
  catalog, and the GC is **skipped entirely** while any Motif layer is unresolvable:
  "can't resolve right now" (catalog sync lost the race with project open, a transient
  IPC failure) is not "orphaned", and deleting baked frames on a guess costs tens of
  minutes of serial re-capture.

Old PNG caches are ignored: missing new-format frames render again, and pre-baking
writes only `.wfrm` files. Invalid cache reads also fall back to live rendering.
Reads, existence checks and writes each use one dedicated IPC operation rather
than a chain of path and filesystem round trips. Frame files retain exact
straight-alpha RGBA8 bytes, carry
version/dimension/checksum validation, and are atomically replaced.

Windows uses a persistent D3D11 transport pool for decoded disk frames and live
OSR captures, independent of the optional video decoder. The active pool budget
is 128 MiB / eight size-format pools; it is separate from the 512 MiB bitmap
cache. Handles are shared once per pool; per-frame messages identify a leased
slot. Preload snapshots a fresh ImageBitmap and completes the GPU read before
acknowledging reuse. The same reader feeds export. Other platforms use native
LZ4 decoding plus pixel IPC. Live capture retains a PNG fallback.

Baking on Windows reads the OSR texture on a persistent native worker and
encodes `.wfrm` directly, reusing the staging texture. It avoids PNG and pixel
IPC; atomic persistence finishes before main marks the frame complete.
Pure background baking delivers no bitmap to the editor. Native readback failure
uses the main-process PNG compatibility writer. With PNG capture, main persists
the original capture without renderer re-encoding. The file format is unchanged;
no migration is needed.

Live Windows capture retains the CDP clock commands but obtains pixels from
OSR shared textures. Resize commits before rendering; two native rAFs settle
painting without advancing Motif time. A GPU copy moves the frame into our pool
before releasing the OSR surface. A capture failure disables this output for
the session; `WEFTCUT_MOTIF_CAPTURE=png` forces the previous path for diagnosis.
See [ADR 0078](adr/0078-motifs-cache-pixels-and-transfer-persistent-textures.md)
and [the measured conformance cases](../poc/motif-frame-cache/FINDINGS.md).

The key is **source-derived**: `contentHash` covers the manifest, HTML and companion
resource paths and bytes, so
editing a Motif's source (or updating an installed one) yields a fresh key and re-captures —
the cache tracks *current* content rather than relying on a layer's stored version. A Motif
with no `contentHash` (a built-in seeded from the build-time bundle, whose content is fixed)
keys stably without it.

**Not in the cache key:** the layer transform and opacity (applied by the Pixi sprite at
composite time — moving/scaling/fading never re-captures) and the window position
(`src_in_us`; frames are keyed by absolute content-frame index, so trimming reuses cached
frames). Changing props, the content duration, or the composition fps does change the key.

### Runtime ownership and teardown

Main's `MotifBakeWorkspace` binds storage and preparation to one Workspace session.
Its `MotifBakeCoordinator` owns frame inventory, queued ranges, progress, resource
pauses, bounded retries and collection. `MotifFrameService` owns the preview's
prewarmer, projects committed layer inputs into preparation demands, and maps
main snapshots into the renderer's read index and layer status display.
`MotifBakeClient` serializes those plans and subscriptions. `Compositor` supplies
project/playhead changes and disposes only the preview-owned work.

Background scheduling keeps lazy range cursors and completes clips in timeline
order (start time, then stable track/layer order). Separate occurrences retain
their own range positions while sharing persisted pixels. **Pre-bake now** moves
the requested Motif, or the Motifs inside a Group, to the front after the current
frame. Foreground captures still interleave between frames; temporarily blocked
work yields to eligible work. Range selection never changes the full content
duration or other render inputs. See [ADR 0109](adr/0109-motif-preparation-finishes-clips-in-timeline-order.md).

Preview and lookahead share a renderer frame broker. Identical requests share
acquisition, and L0 hits need no capture. Each caller owns a bitmap clone; L0 is
pinned while cloning, and consumers check stale results before publishing them.
Main's `MotifCaptureService` separately shares overlapping display and persistence
requests within the same bound store. A bake can attach to a display capture
before texture consumption; a display joining a persistence job waits for the
write and reads the saved pixels. A foreground join promotes a queued producer.
Cancelling one consumer does not invalidate another consumer's wanted result.

- **Cached and bound are different lifetimes.** L0 owns cached bitmaps; sprites
  retain the bitmap they bind. Eviction removes cache membership immediately but
  defers closing a retained bitmap until its last sprite releases it. An idempotent
  insertion keeps the existing bitmap and closes the duplicate. L0 also owns its
  per-content frame counts, so a newly created preview service sees pre-existing
  coverage through an O(1) query; it needs no subscription or event replay.
- **Background persistence owns no display bitmap.** Main holds the OSR surface
  through encoding and atomic writing, then releases it. A persistence-only
  request never imports a display texture or warms L0. Progress counts distinct
  persisted frame indices within the demanded ranges; reads, writes and discovered
  misses update the same main-owned coverage. Renderer lookahead can subsequently
  load those frames into L0.
- **Preview disposal and project close have different effects.** Disposing the
  preview stops lookahead and detaches its observer; main preparation continues
  through preview remount or renderer reload. Close, reopen and Save As retire the
  Workspace session. Queued work checks its generation before capture; already
  admitted writes keep the old bound root and cannot publish into the next
  session. Shared content-addressed L0 pixels can outlive a preview instance,
  but old persistence acknowledgements cannot cross sessions.
- **Main owns collection and retention.** Discovery and collection are serialized;
  session and plan revisions revoke obsolete collection passes before each
  deletion. Unresolved Motifs prevent collection, and queued or in-flight content
  stays live. The native disk sweeper retains referenced raster directories,
  initially protecting the whole incoming raster root until discovery narrows the
  set. Retained bytes still count toward the temporary-cache target. Insufficient
  capacity pauses new growth instead of repeatedly evicting and regenerating the
  requested frames. A filesystem removal already submitted cannot be retracted.
- **CDP deadlines belong to the host.** The host's `send` wraps every command in a
  timeout, including viewport and transparent-background setup. Callers cannot omit
  the deadline. Settled commands clear their timeout timers; a transport failure
  tears down the host so the next ticket can rebuild it.
  Awaited decoder setup has a separate 30-second deadline; normal frame/CDP
  operations retain 5 seconds, and capture transport allows 60 seconds.

Startup inventory enumerates frame files and validates headers and lengths without
decompressing the entire project cache. `ready` requires coverage of the demanded
ranges, so an interrupted bake restores its progress and schedules only holes.
Payload checksums are verified when frames are read; a missing or corrupt frame
invalidates coverage and is produced again. RAM warming alone never establishes
durable readiness. Completion remains subject to storage availability and resource
policy: a permanently full disk or sustained resource pause can prevent completion,
and the paused state exposes that reason.

### Editing an installed Motif

Editing an installed (or built-in) Motif opens a **working draft** seeded from its source —
a built-in is a forced **fork** (built-ins live in the bundle and can't be overwritten). The
selected layer swaps in place onto the draft so the source panel previews it. From there:

- **Update** republishes the draft over the original id and **bumps its version**. Because the
  cache key is source-derived, every placed layer — this project and others — re-renders with the
  new look. Current-project layers that referenced the working draft are **rebound** to the
  original id and their stored props are **lenient-migrated** to the new schema (unknown keys
  dropped, new keys filled from defaults) in one undo step; the source panel's render path already
  tolerates a mid-flight schema mismatch, so a placed layer never blanks. Other projects pick up
  the change the next time they open.
- **Save as new** publishes the draft under its own fresh id; the original is untouched.
- **Discard** swaps the layer back to the original and deletes the draft.

A Motif can also be **imported** through one **Import Motif** action from a
`.zip` package in the picker. Agents can also open a live directory workspace
through `open_motif_draft`; see [motif-workspaces.md](motif-workspaces.md).
A ZIP holds one complete Motif folder
rooted at `index.html` (root-level contents are also accepted). The package may
supply a `manifest.json` if its HTML has no
manifest island. Import validates the manifest, assigns a fresh id and copies
all companion files into a draft. Edit/fork and publication preserve the entire
package. ZIP imports use a stored copy; directory workspaces watch the source
folder and refresh a validated app-owned snapshot. Publication retains the draft
and uses a separate installed id. See the authoring contract for local module
and loader rules.

**Export Motif ZIP** packages the selected built-in, installed or draft Motif
as `<motif-id>/` with all its companion resources. Private draft Update metadata
is omitted. Recipients import that single ZIP; scripts, models, textures, fonts
and the parameter page arrive together. Import still creates a fresh draft for
preview and installation, without overwriting a same-name installed Motif.

### Status display

Main reports `queued | baking | paused | retrying | ready | error`, with completed
and requested frame counts. `paused` identifies playback policy, memory pressure,
resource admission or disk capacity. Finite retries preserve progress; an explicit
Pre-bake action can retry a failed content. `ready` means the requested range is
persisted, which may be only the used range for automatic preparation.

The renderer adds `warming` for L0 coverage when no stronger preparation status
applies; even full RAM coverage remains warming without persisted completion.
An absent status is idle. The timeline **status dot** reflects these states, and
the **property panel** shows progress, pause reasons or errors. Idle and ready
need no standing property-panel row.

## Compositor integration

`compositeFrame(tUs)` passes each Motif sprite its layer-relative time
`tInLayerUs = tUsSnapped − layer.t_start_us`. The sprite resolves the content time, maps
it to a frame index on the exact-rational frame grid (shared `frames.ts` helpers — never
`round(µs·fps)`), clamps to `[0, contentDurationFrames − 1]`, obtains the frame (L0 / L1 /
L2), and binds the bitmap as its texture. Transform and opacity from the layer summary
apply to the sprite.

## Export

The export Worker has no DOM and cannot capture a Motif. Its bounded frame-demand
stream requests only the content frames needed by the output, including trimmed
ranges, nested Groups and retiming. The renderer reads existing L2 frames through
the shared reader or requests a foreground capture from main, then transfers fresh
bitmaps to the Worker. Byte credits bound the in-flight window; export does not
wait for a complete project-wide background bake before encoding.

Missing frames use the same capture host, dimensions and exact frame-grid inputs
as preview. Capture can persist an export frame during the existing OSR lease,
sharing an overlapping background job when possible. This cache write is optional:
a disk failure preserves valid export pixels. If native persistence is unavailable,
the compatibility writer can persist the captured bitmap. The Worker never accesses
filesystem IPC, and cancellation releases its frame window without cancelling
another consumer's still-needed work.

## User Motifs

Beyond the built-ins, users (and agents — see below) author their own Motifs. They're the
same `.html` + manifest-island documents with optional companion resources, stored globally under
`<app_config_dir>/motifs/` (so they're reusable across projects, like built-ins), and they
render through the exact same capture path — once installed, a user Motif behaves
indistinguishably from a built-in.

The lifecycle is **draft → preview → install**:

- **Create** — the picker and MCP share `open_motif_draft`: associate a working
  directory, copy an existing Motif or ZIP, or start empty. A draft has a stable
  id and content revision. Reopening a directory reuses its draft; source
  provenance does not choose an overwrite target.
- **Preview** — a draft is a placeable layer; the compositor renders it **into the real
  project canvas** so the author sees it in context. A draft's frames are keyed by
  `content_hash`, which covers the manifest, HTML and sorted companion paths/bytes,
  so resource-only edits re-capture too (ADR 0079).
- **Edit** — a placed draft layer gets an in-app **source panel** (edit the HTML + island,
  Apply → re-render). The on-disk store is also **watched**: saving a Motif's file from any
  external editor hot-reloads the same way — disk changes coalesce (debounced) into the same
  catalog resync the panel uses, and the content-hash cache key plus the capture-host
  cache-buster force a fresh capture. This covers installed Motifs too: any disk edit
  re-renders every placement. Editing an *installed* Motif opens a working draft (see
  [Editing an installed Motif](#editing-an-installed-motif)).
- **Install** — publish a reviewed revision as a separate installed id, retaining
  the draft; further publishes update that recorded target. Replacing another
  publication requires its explicit id and expected version. Trial layers rebind
  to the published id. Updates are **live/mutable**: every placement — this
  project and others — re-renders with the new look (the cache key is source-derived, never
  the layer's stored `motif_version`). **Save-as-new** is the "keep my old look" escape hatch.

Because updates are live/mutable, the `motif_version` stored on a placed layer is only a
**seen-at marker** — it never pins rendering. When a project opens, each Motif layer's marker
is compared against the catalog's current version; any mismatch surfaces a one-time
**"Motifs changed since you placed them"** notice (v1 → v3, with the affected layer count)
plus a status-log entry — the cross-project signal for updates made while this project was
closed. Dismissing it acknowledges: the markers bump to current in one undo step, so the
notice doesn't repeat on the next open. There is deliberately no global reverse index of
which projects use a Motif; each project self-reports when it opens.

A project referencing a since-deleted Motif degrades to an error placeholder, not a crash.
The lifecycle is driven from the property panel (Install / Edit / Update / Save-as-new /
Discard / Delete) with inline confirms, and equivalently over the MCP tools below. Security
of the untrusted-document case is covered in [Security](#security).

The library also exposes Export on every card and Export/Delete in its context
menu (right-click or Shift+F10). Built-ins cannot be deleted. Delete asks for
confirmation and warns that projects using the package will show missing content.

Library cards use persistent **Motif covers**: default-props PNGs captured at
the settled entrance time, at a fixed 30 fps, downsampled after rendering to fit
480×270. Main owns the cache under `<dataRoot>/cache/motif-covers/`; package or
render-runtime changes invalidate it. Only visible/near-visible cards request
covers, and a warm app restart needs no capture for them. The selected parameter
preview still renders at the project's fps and full authored size. Covers are
derived local data, not part of the exported package or project frame bakes.
See [ADR 0085](adr/0085-motif-library-covers-are-persistent-derived-resources.md).

## Agent surface

An MCP agent can both *place* and *author* Motifs, mirroring the human lifecycle through the
same backend cores (so the two surfaces can't drift):

- **Place / inspect.** `add_motif_layer` is props-only — agents reason about *what* a Motif says,
  never about capture or timing — and resolves built-ins **and** user Motifs (drafts +
  installed). `list_motifs` enumerates the full catalog (each entry carries `status` =
  `builtin | installed | draft`, plus `content_hash`/`target_id`), and `motifs://current`
  mirrors it. Preparation state is observed from the Workspace session; preview
  warming is a separate RAM-cache signal, and export requests its own bounded
  frame stream rather than waiting for every background demand. (The MCP list is
  manifest-only — `html` is stripped so it doesn't bloat agent context; agents
  fetch source on demand.)
- **Author.** `open_motif_draft` opens the working source; `read_motif` reads
  inventory or a selected file; `update_motif_files` applies a revision-checked
  batch. `preview_motif` returns a frame and exact revision; `install_motif`
  publishes that revision without consuming the draft. `export_motif` returns
  a complete ZIP and `delete_motif` removes managed content or unlinks an external
  folder without deleting it. Generic uploads/downloads cover clients without
  shared filesystem access. Full contracts: [motif-workspaces.md](motif-workspaces.md).

Agents observe and author; they never drive the renderer directly.

## Security

User Motifs are untrusted web documents (an agent or a human authored them), so the
capture host is the trust boundary. A **single reused offscreen Electron
BrowserWindow** (driven over `webContents.debugger` / CDP) navigates between Motif
ids/content hashes; isolation comes from a dedicated window (separate from the
editor), no preload / disabled Node integration on the `motif:` origin, and CSP
`default-src 'none'` — offline, with `connect-src 'self' data: blob:` for its own
package and embedded buffers. Scripts/styles also load only inline or from the
same origin; network and cross-Motif resource fetches remain blocked.
Dedicated local/Blob Workers and WASM are permitted for decoder initialization;
ordinary JS eval remains blocked. The runtime retires managed Workers after
setup and limits that live set to eight. This is lifecycle management; CSP and
Electron isolation enforce security. See [ADR 0093](adr/0093-motif-local-decoder-workers-and-wasm.md)
and the [offline 3D template](motif-three-model.md).
That window-as-sandbox carries both trusted built-ins and untrusted user Motifs. On
top of it:

- **Import-time validation** — the manifest island is parsed + validated against the
  `Manifest`/`PropSpec` schema (sane `size` bounds, well-formed `props_schema`,
  `default_duration_s`/`content_duration_s` finite-and-positive) and rejected at write/import,
  not as a runtime crash.
- **Per-frame wall-clock timeout** — `motif_capture_frame` caps the render so an
  infinite-loop Motif fails the frame (and tears down the wedged host) instead of hanging.
- **Path-safe disk serving** — the `motif:` scheme resolver rejects `..`/absolute/separator
  escapes and confirms the resolved path stays under the Motif's own directory.
- **Id-namespace isolation** — minted ids can never shadow a built-in (`countdown`,
  `lower-third`) or the reserved `drafts/` segment; the manifest's own `id`/`version` are
  ignored (app-assigned).
- **The parameter page is sandboxed separately** — a Motif's `params.html` runs
  *inside* the editor window, so it gets its own boundary: an `allow-scripts` iframe
  with no `allow-same-origin` (an opaque origin, no reach into the app's DOM), the
  offline params CSP, and a host seam that authenticates by window identity and
  validates every payload against the manifest before it can touch a layer. See
  [Parameter UI](#parameter-ui) and [`security.md`](security.md).

Residual accepted risk: a renderer-level Chromium exploit is out of our control (mitigated by
the isolated, offline host with no preload / Node integration); a determinism-violating Motif
renders wrong but harmlessly (surfaced by the determinism story).
