# Preview

The preview is a PixiJS v8 `Application` on a main-thread `<canvas>`. Export
runs the same compositor in an `OffscreenCanvas` Worker. Canvas sizing, zoom
math and the renderer itself are described in [`render.md`](render.md) (§
Preview canvas). This doc covers decode, transport attachment and the preview
surface.

## Component tree

```
Editor session
  ├─ PreviewAudioEngine — transport state, clock, AudioGraph, PCM scheduling
  └─ PreviewSurface / PixiPreview — optional visual attachment
       ├─ PlaybackEngine — reads the audio clock, presents and seeks pictures
       └─ Compositor — CompositionNodes and SourceDecoderPool
```

The editor session owns playback. Closing the Preview panel releases Pixi
resources only; transport, audio and meters keep running. Transport states,
PCM scheduling and the session timer are described in
[`audio.md` § Preview mixer](audio.md#preview-mixer).

## Clock and presentation

The audio output clock is master. PCM is scheduled against a `ClockAnchor` on
`AudioContext.currentTime`. The picture is presented on a different time: the
`getOutputTimestamp()` pair projected to the current performance time, without
adding the render lead back. Adding the lead back put the picture ahead of the
sound by the full output delay. For example, a 100 ms device delay showed
500 ms of picture where 400 ms had been heard (regression test in
`clock.test.ts`). When stamps are missing or stale, presentation falls back to
`baseLatency + outputLatency`, then to `currentTime`. `ClockSyncSnapshot.source`
names the source in use. Position is monotonic. After Play or a seek, the
position holds at the target until that audio reaches output. All of this is
an estimate, not a measurement of the speaker or display.

The Compositor records each visible frame interval in root composition time,
including Group and clip rate mappings and held pictures. It samples the output
clock again after every Pixi render submission. This produces target/output
skew, the worst expired or future frame, missing layers, held scenes and the
last 600 submission intervals. The Performance Monitor and playback-perf JSON
report them.

An edit gesture's monitor preview (`seek(t, "preview")`) changes the
presented frame only. It does not move the clock, cancel audio or publish a
Moment.

## Decode

`SourceDecoderPool` gives each clip (`layerId`) its own decoder handle and
`FrameRing`. Clips of the same media share one refcounted `SourceMedia` (one
open and parse). On the WebCodecs path, a per-clip `PacketPump` feeds a
`VideoDecoder`. Each ring holds 1 s of lookahead and 0.5 s of lookbehind. The
byte budget pauses forward fill only. Lookbehind is trimmed by time only,
because trimming it re-seeks long-GOP sources (`FrameRing.ts`). WebCodecs
frames are stored as `ImageBitmap` snapshots
([ADR 0004](adr/0004-imagebitmap-snapshot-frame-ring.md)).

Sources are never loaded whole. mediabunny reads through `MediaRangeSource`,
a `CustomSource` over `weftcut-media://` HTTP Range requests (see
[`render.md`](render.md#byte-handling)).

- **GOP crossings do not reset the decoder.** During continuous play the pump
  sends the next IDR into the same `VideoDecoder`, and the ring continues. A
  reset happens only on a backward seek outside the ring, or a forward jump
  far past the pump frontier. An unconditional reset at every GOP boundary
  measured a ~400 ms stall per boundary (`PacketPump.ts`).
- **Idle and failure.** A handle with no use for 5 s is disposed and rebuilt
  on the next request. `decoderFallback.ts` handles hardware failures: a
  zero-output first-frame error reconfigures the decoder with
  `prefer-software`, and `Codec reclaimed due to inactivity` closes the
  decoder and rebuilds it lazily. Any other error closes the decoder too; the
  next request rebuilds it from a key packet. The rebuilt decoder must output
  past the point the failed one reached since it was built or a seek last
  reset it, or the handle stops asking: a packet that fails every time is not
  rebuilt at decode rate, and an error after a backward seek is judged by the
  progress made since that seek, not by how far the clip was ever played.
- **Demand plan.** Before any acquire or prewarm, the Compositor publishes one
  priority epoch (`previewDecodePriority.ts`). It covers every active video
  clip and every clip at the nearest boundary within 1 s
  (`UPCOMING_CLIP_PREWARM_US`), with both the base and `#swap` pool keys. The
  plan uses the recursive placement walk (`forEachLayerInTime`), so Group
  instances and trims request the source time that is actually visible. For
  short sequential cuts it also looks past the nearest boundary. Speculation is
  capped at 3 upcoming clips with one active video, or 3 minus the active count
  otherwise. Clips at the nearest boundary are never dropped. Active demand is
  acquired before speculation.
- **Picture continuity.** A populated scene is not replaced until incoming
  video has a usable frame (checked recursively through Groups). Until then
  the previous complete composition stays on screen, so a cold or backward cut
  never flashes black or shows a stale tail. Empty intervals still clear. The
  audio clock does not stop; a held picture is counted as a late layer.

## Scrub

`PlaybackEngine` composites every seek immediately and passes it to a
`ScrubCoalescer` (`decoder/scrub.ts`: 50 ms debounce, 180 ms max-wait). The
coalescer then re-anchors and composites the latest target. Frames for
intermediate targets are discarded. The max-wait must exceed the worst-case
decode from a keyframe, which the short-GOP proxy bounds.

## Decode engine

The decoder for a source is chosen per session, on top of the persisted
[Decode Route](../CONTEXT.md#decode-routing). Callers pick an **engine**. The
engine hides lane choice, probes, the capability cache, sticky fallback and
device-loss recovery.

- **Engine**: `ffmpeg` (**Standard**) or `webcodecs` (**Lite**). The
  `decode_engine` AppSetting is `auto` / `ffmpeg` / `webcodecs`. A persisted
  legacy `"native"` value migrates to `ffmpeg` on load.
- **Source**: `original` or `proxy`. Only the user changes it
  ([Proxies](#proxies)).
- **Lane**: hardware or software. It is private to `FfmpegSource` and never
  appears in a resolver input or output.

`resolveDecodeEngine` (`decoder/decodeEngine.ts`) is pure. Its inputs are the
setting, whether the native-decode component is loaded, the proxy intent and
whether the proxy is ready, the session's WebCodecs-original verdict, and
whether ffmpeg has failed terminally for this source. It writes nothing.
`resolvePreviewSource` gathers these inputs for both playback and
[actionability](#actionability). It returns `{ engine, source, target, status,
key }`:

- `status` is `ok`, `pending` (a probe or proxy is outstanding) or
  `unsupported` ([Unsupported](#unsupported)).
- `key = ${engine}:${source}:${target}` is the swap identity. When it changes
  (engine or source flip, or an import moving to its project copy), the
  Compositor keeps the old frame on screen while the replacement decodes in the
  layer's alternate pool slot (`swapKeys.ts`). A lane change inside Standard
  does not change the key.

| Setting | Label | Resolves to |
|---|---|---|
| `auto` (default) | Automatic | `ffmpeg` when the component is loaded and has not failed for this source, else `webcodecs` |
| `ffmpeg` | Standard | `ffmpeg`; `unsupported` if the component is missing or has failed for this source |
| `webcodecs` | Lite | `webcodecs` |

Settings grays out **Standard** when the component is absent.

**Originals are the default.** Neither engine switches to a proxy on its own.

**Why `auto` prefers Standard.** With the hardware read barrier off the
critical path, 1080p max smooth tracks were H.264 5 on ffmpeg hardware vs 2 on
WebCodecs, and HEVC 5 vs ≥5
([findings](notes/playback-perf-findings-2026-07.md#max-smooth-tracks)).
[decode-bench](decode-bench.md) already gave ffmpeg the seek advantage. Picking
an engine per interaction would cause a visible swap, because the engine is
part of `key`. Reopening this needs a machine where Standard loses on both
sustained playback and seek.

Export uses the same Automatic/Standard/Lite vocabulary through
`resolveExportDecodeRouting`. The routing table is frozen at export start (see
[`render.md`](render.md) § Export source resolution).

### The Standard engine (`FfmpegSource`)

`FfmpegSource` puts two interchangeable transports over one stable
`FrameRing`. It needs the optional `@weftcut/native-decode` component
([ADR 0030](adr/0030-decode-engine-overlay-and-native-component.md)).

- **Lane pick at open** (`pickInitialLane`). Main walks the advertised
  hardware lanes (`HW_LANE_PRIORITY`: `nvdec`, `vaapi`, `d3d11va`,
  `videotoolbox`) and keeps those eligible for the format
  (`shared/hwLaneEligibility.ts`). It then checks the capability cache or
  probes. Windows `d3d11va` uses `GpuTransport`. The copy-back hardware lanes
  (NVDEC, VAAPI, VideoToolbox) and software decode use `SwTransport`.
- **Eligibility.** Every lane except VideoToolbox accepts 8-bit H.264, HEVC
  and VP9 only. VideoToolbox adds ProRes and 10-bit, shipped as I420P10. The
  list encodes seek safety, which a one-frame probe cannot test (MPEG-2 on
  d3d11va decodes forward, then hangs on a backward seek). It narrows the
  formats that get probed and never overrides a negative probe.
- **`GpuTransport` (d3d11va).** A pooled shared D3D11 texture reaches the
  compositor with no pixel bytes crossing IPC. Each `preview_gpu` session is a
  decode session under the same host as the byte lanes
  ([ADR 0179](adr/0179-frames-cross-processes-on-two-carriers.md)): `previewGpu:open`
  reserves the GPU admission (sessions, coded pixel area, shared-buffer bytes)
  and the decoder's memory, opens the session, and hands the pool's textures
  to the requesting document once, each sent with its tag `{key: session id,
  slot}` (`main/frameCarrier/sharedTextureImport.ts`). The preload's
  `SlotReader` keeps them by that tag. The open resolves once every texture
  has arrived. A `slot{slot, gen}` message then comes down
  `decodeSession:msg`; the preload reads that slot into an `ImageBitmap`
  (`getVideoFrame` → `createImageBitmap`) and posts it on the session's port,
  keeping the session's order: an `end` or `error` never overtakes a slot still
  being read. `GpuTransport` posts `request{targetUs, requestId}` and
  `release{slot, gen}` up the port. Every request carries a new id, and an
  `end` names the newest request the session had served when it sent it:
  `GpuTransport` reports only an end naming its last request, since an older
  one may be in flight while the playhead jumps back from the tail, and
  latching it would stop the requests at the new position. A session still at
  its end repeats `end` to each newer request. Slot textures are imported as RGBA tagged sRGB passthrough: the native
  shader already converted to working-space RGB, so `createImageBitmap` is a
  byte copy. Motif's GPU frames use the same import and the same reader
  ([`motifs.md`](motifs.md#reading-stored-frames)).
- **A slot is released only after the GPU read completes. Delivery does not
  wait.** ffmpeg overwrites a released slot on its own D3D11 device, and
  Chromium cannot track that cross-device dependency. If the release comes too
  early, a later frame's pixels arrive tagged with an earlier PTS. So the
  bitmap is delivered immediately, and the page's slot fence decides the
  release: it copies one pixel on Pixi's WebGPU queue, awaits
  `onSubmittedWorkDone`, then posts `release` (`slotFenceQueue.ts`). That is
  the lane's one read-completion strategy; with no live WebGPU device (none
  yet, a WebGL preview, or one lost and not yet replaced by Pixi's restore) it
  falls back to the one-pixel proof (`shared/readCompletion.ts`), and a frame
  whose read nothing could prove is not shown and fails the transport
  ([measurement](notes/slot-read-completion-2026-11-18.md)). A lost device runs
  no copy, so a fence still pending when its device is lost proves nothing,
  whether Chromium then rejects it or reports the work done: its slot is not
  released and the transport fails, and `FfmpegSource` falls back to software.
  The release does not depend on painting, and the page never releases on
  elapsed time. Each slot goes back at most once: after its fence or proof,
  at once when its read failed, and never when nothing proved its read or
  after dispose: the session's close reclaims those. Native never reuses a
  slot its consumer has not released: a slot left unreleased for 3 s
  (`LEASE_TIMEOUT`, `preview_gpu/session.rs`) ends the session with a
  terminal error, so a wedged consumer costs the lane (`FfmpegSource` falls
  back), never a frame shown under another frame's PTS. Any non-zero
  `lease_timeouts` counter means the consumer stopped releasing.
  `preview-gpu-order.spec.ts` checks the ordering with per-frame barcodes, on
  one session and on three concurrent sessions (Windows), and on the
  copy-back lanes with one session.
- **Every GPU session error is a transport failure.** Native sends `error`
  with `terminal` set only when the session thread stopped (a panic, or an
  expired lease); a failed
  seek, decode, keyed-mutex acquire or conversion is non-terminal and the
  session survives. `GpuTransport` reports both through `onError`, as it does
  a slot the preload failed to read, and `FfmpegSource`'s failure table falls
  back to software (ADR 0162).
- **One close for every lane.** A transport's `dispose` closes its session by
  id with `decodeSession:close`, an invoke on the route opens take, never up
  the port, so it reaches main before any open started after it. Main ends the
  session (native first, then its imports, then its reservation) and answers.
  `GpuTransport.dispose` resolves on that answer, which is what a GPU→software
  fallback waits for; the byte transports do not wait. A session also ends
  with its document: a reload, crash or destroy closes every session it
  opened.
- **`SwTransport`.** libavcodec decodes in the main process, and NV12 (or
  I420P10) bytes go over classic IPC
  ([ADR 0029](adr/0029-native-sw-decode-ships-bytes-not-shared-texture.md)).
  Each `preview_sw` session is a decode session on the same carrier as export
  decode ([`export-ipc-transport.md`](export-ipc-transport.md#decode-in)):
  `previewDecode:open` reserves the decoder's memory and opens it, main sends
  each of its messages (`bytes`, `end`, `error`) on `decodeSession:msg`, and
  the preload posts it on the session's port with the frame buffer
  transferred. `SwTransport` on the page main thread holds the other end and
  posts `request` and `release` up it. Frames carry no colour: the
  compositor's own ingest pass converts them to RGB using the colour the
  session was opened with: the source's resolved colour (`resolveSourceColor`,
  the one rule every lane shares), or for an RGB-coded source the YCbCr the
  pack converted it into (`nativePlaneColor`; see
  [`conformance.md`](conformance.md#decode-color-tags)), never through
  `createImageBitmap`, which always applies BT.601
  ([ADR 0032](adr/0032-cpu-plane-yuv-converts-in-owned-shaders.md)). The gate
  is `preview-sw-color.spec.ts`.
- **A software session reports its own death.** A native panic ends the
  session with a terminal `error`, which reaches `SwTransport.onError` and the
  failure table like a GPU error. A failed seek or decode is a non-terminal
  `error`: native logs it and the next request seeks again; the renderer does
  not act on it. The `end` of the material is not reported, because the
  native cursor already absorbs requests past it.
- **Software requests continue; they do not re-seek.** The native session
  keeps a cursor between requests. A target moving forward continues the same
  pass. Only a backward move, or a jump more than 1 s past the frontier,
  seeks. Each request decodes up to 500 ms past the target. Re-seeking on
  every request cost 137× decode amplification on a 240-frame GOP. The
  renderer requests a refill only when forward coverage drops below 150 ms
  (`REFILL_LOOKAHEAD_US`), and not while `FrameRing.isLookaheadFull()`.
- **Software delivery uses leases.** A session has at most 8 frames and
  32 MiB in flight (`WINDOW_FRAMES`, `WINDOW_BYTES` in
  `preview_sw/session.rs`); one oversized frame may travel alone. Each frame
  holds its lease until `SwTransport` releases it by id, exactly once,
  whether the frame was shown or dropped. A duplicate or unknown lease is
  ignored. A full window never parks the session: it keeps the frame it has
  and serves the next request, and a released lease wakes it. A seek changes
  the request id but does not forgive leases in flight. Forward refills keep
  the id. A cache flush changes it. Every frame names the request it answers;
  native code and the renderer both reject superseded work. Decode runs in
  8 ms cooperative slices and resumes the same cursor; it cannot interrupt a
  blocking FFmpeg call. Renderer reload closes the session.
- **Hardware→software fallback happens inside the source.** A hardware error
  or device loss, at open or later, closes the failed transport and then opens
  `SwTransport` into the same ring with a fresh `streamId`, keeping the last
  hardware frame on screen. Every transport switch closes the old transport
  before the next opens, one switch at a time
  ([ADR 0162](adr/0162-an-ffmpeg-source-switches-transports-one-at-a-time.md)).
  The swap key does not change. `currentLane()` reports the live lane. A
  capacity refusal holds the clip and a frame request retries after 1 s. Only
  if software also fails, or a bench-forced lane fails, does `onFatalError`
  fire. The Compositor then re-resolves (`auto` → `webcodecs`, otherwise
  `unsupported`).

**Hardware admission (d3d11va).** Before allocating, main reserves a session
slot (default 5), coded pixel area (default `3 × 3840 × 2160`) and pool bytes
from the shared GPU buffer budget (`src/main/previewGpuBudget.ts`; settings in
`performance-settings.ts`). The area limit is calibrated at 30 fps (60 once a
computer-test calibration is applied). It does not model pixel rate. Five
1080p sessions fit; a fourth 4K session does not
([findings](notes/playback-perf-findings-2026-07.md#hardware-admission)). A
refusal throws `hw-budget-exceeded`, and the clip spills to software with no
capability verdict.

**Capability failures are sticky; capacity spills are not.** A real hardware
failure marks that media software-only for the app session. A total ffmpeg
failure under `auto` marks it `webcodecs`. Neither verdict is ever reversed. A
budget spill records nothing. Above 1080p, a spill uses the spill profile: the
supported scale nearest 960×540, at half cadence (`budgetSpillProfile.ts`).

**Reclaim and retry.** If a priority clip is refused, the pool closes
non-priority hardware handles retained from earlier timeline regions. Each
session's `decodeSession:close` is awaited through the native close and the
lease release before `previewGpu:open` retries; a fire-and-forget close would
race the lease. If the priority set alone exceeds capacity, the refused clip spills
with no retry loop. When the epoch moves past a boundary, a still-priority
spilled clip retries hardware inside its existing `FfmpegSource`, keeping its
ring and sprite. Output from the retired transport is ignored. A repeated PTS
replaces the old snapshot and releases it.

`previewGpu:budget` exposes `sessions`, `codedPixelArea` and `calibratedFps`
for diagnostics only. Main's reservation is the authority, so do not
pre-check against it.

**Two log trails.** `noteResolution` logs one row per media whenever the
resolved key changes. `noteLaneOpen` logs one `decode-lane` row per clip on
each hardware↔software transition, with the reason. The lane has its own
trail because it is not part of the key. Neither trail logs per frame. A
same-lane reopen is silent.

**Capability cache.** `<userData>/decode_capability.json` (`main/decode-capability.ts`)
stores probe verdicts across restarts. It is keyed by lane (`sw`, `d3d11va`,
`nvdec`, `vaapi`, `videotoolbox`) and format class, plus the DRM node for
VAAPI. Each lane stores an `env` string: the ffmpeg version for `sw`, and the
GPU and driver identity for hardware lanes. If `env` changes, that lane's
entries are wiped. The cache records whether this machine can decode a format.
The session's sticky verdict records whether an open just failed.

**macOS probe isolation.** On a VideoToolbox cache miss, the one-frame probe
runs in a disposable utility process (`decode-probe-host.ts`,
`decodeProbeProcess.ts`). Concurrent requests for the same format class are
coalesced. Requests for different classes queue behind the previous answer,
not behind the child process exiting. Main enforces a 4 s deadline covering
startup, addon load and decode. It accepts a verdict only after the host exits
cleanly. On timeout or crash, the host is killed, the clip falls back to
software, and VideoToolbox resolution is disabled for the app session
(cached positives included). Transient failures are never cached as
negatives. Admission waits up to 4 s for import contention, then reserves one
CPU thread and 192 MiB until the child exits. After a 1 s reap grace the
caller continues anyway. Gates: `decodeProbeProcess.test.ts`,
`decode-probe-isolation.spec.ts`, `scripts/smoke-packaged-decode-probe.mjs`.

**Hardware evidence.** A probe failure carries a structured diagnostic through
IPC and into the negative cache entry. Each active clip exposes `hwLane`,
`hwDiagnostic` and `hwFallbackCount`, and the count survives source
re-creation. Hardware acceptance tests check this evidence before and after
sampling, so a software fallback is never counted as hardware coverage (see
[`platform-codecs.md`](platform-codecs.md)).

### The Lite engine (`SourceHandle`)

WebCodecs over the shared `SourceMedia` (§ [Decode](#decode)). On `original`,
it consults the session verdict. `ok` decodes the original, `untested` is
`pending`, and `fail` is `unsupported`. A source is marked `fail` only on a
definitive codec or config rejection from the import decodability sweep
(`markWebcodecsUnusable`), never on a timeout.

### Unsupported

When the chosen engine cannot decode the chosen source, the clip resolves to
`unsupported`. The Compositor acquires nothing and reports the media through
`onUnsupported(set)`. `UnsupportedClipCard` replaces the black frame with
two actions. **Switch to Standard** appears only when the component is
available. **Generate proxy** forces the per-clip proxy override on and
enqueues `generate_quick_proxy`. The proxy always decodes on Lite, so this
works on every machine.

## Actionability

A media card can be dragged or used once preview can actually play it. Import
job progress does not decide this. `mediaReadiness` (`panels/mediaReadiness.ts`)
turns the `resolvePreviewSource` result plus file availability into `ready`,
`missing`, `proxy_pending` or `unsupported`. The pool, the context menu and the
timeline drop handler all read the same verdict through `useImportReadiness`.

- A job finishing does not grant access. Outstanding hash, copy or
  optimization work does not take away access the source already has.
- Standard can play a probed original immediately. Lite needs a successful
  original decode or a ready proxy that the user selected.
- `PreviewCapabilities` (`app/previewCapabilities.ts`) runs at most 2 probes at
  a time and keeps in-flight probes across unrelated summary updates. It
  retries inconclusive results. First-use probes may run during playback;
  optional probes follow the background-playback policy.
- Decode evidence survives a source path change only through
  `media:source-relocated`. Main emits it when the workspace copy matches the
  previous hash and size. A missing file, different content, or a retired
  project opening discards the evidence and cancels its probes. Late results
  cannot restore discarded evidence.
- A terminal engine failure invalidates the verdict, and the engine fallback
  rules then apply. Copy progress is shown separately and may appear on an
  actionable card. Export has its own readiness gates.

## Proxies

A proxy is a decode **source** the user opts into, never a fallback the engine
picks. Two persisted `ProjectSettings` fields control it. Both are written with
the unrecorded `update_project_settings`, so neither creates an undo entry:

- **Prefer Proxies** (`prefer_proxies`): a project toggle in Settings.
- **Per-clip override** (`proxy_overrides[mediaId]`): a media-pool control
  that cycles Auto → Proxy → Original. It is hidden for `Bypass` sources.

Preview uses the proxy when `(proxy_overrides[id] ?? prefer_proxies)` is true
**and** `quickProxyPath(media)` exists. Otherwise it decodes the original. That
gate covers a toggle set before the proxy is built and a proxy deleted by the
cache. A WebCodecs-undecodable original still goes to
[Unsupported](#unsupported).

The proxy always resolves to the Lite engine. It is ≤720p short-GOP H.264
(`PROXY_GOP_FRAMES` = 6), and the proxy branch has only a URL, not a path. This
also rescues a pinned Standard engine on a machine without the component.

`generate_quick_proxy(media_id)` (`native/src/commands/media.rs`) builds a
missing quick proxy on demand. It does nothing for `Bypass`, which has no
`quick_proxy` slot, or when the proxy already exists.

- **Quick proxy** (`quick_proxy_path`): the only proxy preview reads.
- **Export master** (`proxy_path`): the full proxy, read only by export, for
  sources that export does not decode natively. Preview never reads it, and the
  preview toggles do not affect export. See
  [ADR 0011](adr/0011-export-master-vs-preview-proxy.md).

## Interaction

The preview is not a selection surface. Under Selection, a click on the frame
selects nothing. The `TransformGizmo` takes gestures only for the layer
already selected in the timeline. A video frame is mostly footage, so
click-to-select would turn stray clicks into selection changes.

**Frame-coordinate tools hit-test only their own kind.** While the Text tool
(`T`) is armed, `preview/textHitTest.ts` checks the click against Text layers
at the playhead, topmost first. It uses the gizmo's own geometry
(`layerFrameAt`, `layerQuad`). Locked or disabled layers and tracks are skipped.
A hit opens the editor (`textEditingStore`). A miss creates a Text layer at the
click: `add_text_layer` with `x` and `y`, both or neither. That is two history
entries, the same as using the menu and then typing. While the tool is armed,
the gizmo is display-only (`data-inert`). The tool stays armed after a
creation. Escape outside the editor returns to Selection. `Shift+T` toggles
display mode. A future pen or crop tool should follow the same pattern and
must not widen the hit test to every kind. The tool is inert when the preview
shows a composition other than the focused one.

**The viewport is a gesture, not a mode.** It works under every tool:

- The wheel zooms around the pointer, clamped to 5–800 %, and snaps to the
  stops (25, 50, 75, 100, 150, 200, 300, 400 %). A trackpad pinch (Chromium
  sends it as a ctrl-wheel) uses the same handler with its own gain. Listeners
  sit on the preview surface, not the Pixi host, because the overlays are
  siblings of the host.
- The middle button pans. Autoscroll is suppressed on the mouse event; that is
  the only event where suppression works. The Hand tool (`H`) shares the same
  pan code for pointers without a middle button.
- A two-finger trackpad scroll zooms. Trackpads therefore pan with the Hand
  tool.
- The toolbar readout (`Fit` or a percentage) opens a radio menu, not a
  select. A select renders its trigger from its own items, so it threw the view
  back to Fit whenever the wheel landed between stops.
- `Z` (View › Fit preview to window) returns to Fit. The stepping commands have
  no default keys: `Mod +/−` is consumed by `hardenWindow`, and `=`/`−` belong
  to the timeline.
- Zoom and pan are session view state (`previewViewStore`). No edit, history
  entry, export setting or decode divisor reads them. Zoom is measured in
  device pixels per composition pixel, and `Fit` is a mode that re-fits on
  resize ([`render.md` § Preview canvas](render.md#preview-canvas)).

## Motifs

`MotifSprite` binds cache-owned bitmaps. `MotifPlaybackCursor` keeps one
admitted request and the latest demand per sprite. During playback, late but
useful frames advance the picture. Pause and seek wait for the exact frame.
Caching, prewarming and transport are described in [`motifs.md`](motifs.md).

## Diagnostics

**Dropped/late indicator** (transport bar, `underrunTracker.ts`). A frame is
dropped when the ring had no fresh frame for it. A frame is late when the gap
between display frames (rAF timestamps, not when the composite ran) was long
enough to show a comp frame late or skip it; the display interval is learned
from the frame cadence. It counts the
current episode, dims after 1.5 s with no new problem, and clears after 3 s
of quiet, including while paused. Clearing is confirmed on the next composite,
and any new problem cancels it. Decay runs on the composite tick; there is no
UI timer. Session totals are kept in the Performance Monitor.

**Performance Monitor** (dev builds only: Dev menu › Performance Monitor). This
is a separate window (`render/PerfHUD.tsx`, `performanceMonitorWindow.ts`).
`PerfTelemetryBridge` in `PixiPreview` streams to it only while the window is
open, polling every 500 ms. It shows frame rate (rAF p50/p99 over 120
intervals), composite time, audio prepare and stop times, video late/lead,
submit p95/p99, Motif lag/hold, drop/late totals, prewarm, JS heap, process
CPU, hardware sessions against the budget, audio meters, and a per-clip table
(lane, ring, barrier, frame fates). Reset clears the peaks.

**Motif cold start** (dev builds only: Dev menu › Motif Cold Start). It saves
and closes the project, retires every capture host, deletes the project's
`Cache/raster` and the renderer's in-memory Motif frames, then reopens it, so
the host pool and preview warm as on a first open (`app/motifColdStart.ts`,
`main/motif/coldStart.ts`).

The Drop counter only reports whether the ring had a fresh frame. A loop
stalled by a synchronous GPU drain reports zero drops yet looks jerky. A
steady submit cadence can also hide a frozen Motif, which is why Motif lag/hold
is a separate tile. For per-stage timing use
[`playback-perf.md`](playback-perf.md) and `render/perf/stageTimers.ts`.
