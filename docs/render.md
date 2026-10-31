# Render

The PixiJS renderer. One module (`apps/desktop/src/renderer/render/`)
produces every visual frame — in the preview surface and in the export
Worker — so preview pixels equal export pixels by construction.

Preview mount, clock, transport and decode engines: [`preview.md`](preview.md).
Audio: [`audio.md`](audio.md). Audio export and final mux: [`export.md`](export.md).
Motif capture and caching: [`motifs.md`](motifs.md).

## Boundaries

- **In scope:** visual compositing — video clips, images, text (caption cues
  are ordinary Text layers), color fills, Motifs, Groups, transforms,
  opacity, blend modes, per-layer effects, transitions.
- **Out of scope:** audio, muxing, probing / proxies / waveforms /
  thumbnails (Rust side).
- **Per-layer effects** are Pixi filter chains. Project state holds the
  instances and their keyframeable params; the renderer owns the catalog
  (`effects/effectRegistry.ts`: blur, chroma key, sharpen, brightness,
  contrast, saturation; chroma key and sharpen are shaders authored here).
  `EffectChain` caches filters per layer. See
  [ADR 0027](adr/0027-per-layer-effects-pixi-filter-chains.md).

## Directory layout

```
render/
  Compositor.ts          Pixi Application owner; shared services; per-frame composite
  CompositionNode.ts     one composition INSTANCE's sprites and Container
  compositionWalk.ts     THE recursive walk over a project's layers
  resolveView.ts         AnimTrack → scalar view per layer (incl. text presets)
  animated.ts            keyframe resolution via the shared eval wasm
  PlaybackEngine.ts      visual attachment to the session transport
  decoder/               preview decode (SourceDecoderPool, FrameRing, PacketPump,
                         MediaRangeSource, scrub) and export decode (ExportDecoderPool)
  sprite/                one Sprite per visual kind + CompositionRefSprite (Groups)
  effects/               filter catalog + chains
  transitions/           the two-input transition node + RT pool
  fonts/                 font registry, FontFace loading, CJK line-break hook
  motifs/                Motif frame reader, prewarm/bake planners, raster cache
  nv12/ tenbit/ yuv/     owned ingest shaders and export pack passes
  worker/                export Worker entry, encoder, protocol, native decode relay
  audio/                 preview audio (audio.md)
```

## Compositor

`Compositor` owns a Pixi `Application` (an `OffscreenCanvas` one in the export
Worker). It is constructed with the mode (`preview` | `export`) and media
resolvers (`resolveSource`, `proxyAssetUrl`, `originalAssetUrl`), and holds
what every node shares: the decoder pool, ingest shaders, Motif planners,
underrun accounting. Main entry points: `setProject(summary, openId?)`,
`compositeFrame(tUs)`, `setAnchorTime(tUs)`, `naturalSizeOf(layerId)`,
`textFitOf(layerId)`.

`setProject` with the same composition reconciles the node: removed layers
dispose their sprites, new layers spawn one on the next sweep, survivors are
patched in place. A different composition rebuilds the node, because every
sprite and decode session belonged to the timeline being left.

Each frame, every layer's `AnimTrack<T>` properties resolve at layer-local
time through `resolveView.ts` → `animated.ts` (`resolveAnimated`,
`resolveAnimatedColor` in OkLab with premultiplied alpha), both calling the
shared `weftcut-eval` wasm — the same crate Rust links natively, so preview,
export and Rust share one keyframe engine
([ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md)). The curve editor
samples through the same wasm. Golden fixtures (`animatedGolden.fixture.json`,
`animatedColorGolden.fixture.json`) are asserted by both the TS and Rust suites.

**Known limit:** the wasm evaluator holds at most 4096 keyframes per animated
property (`MAX_RESIDENT_KEYFRAMES`, `native/eval/src/lib.rs`). Beyond that the
preview truncates (one `console.warn`, `MAX_KEYFRAMES` in `renderer/eval`)
while native export evaluates every key, so the two would diverge; Path-to-XY
baking refuses a conversion past the bound.

Position resolves through one XY-or-Path interface. Paths flatten Line/Cubic
geometry to a distance table in the eval leaf (`path.rs`: 0.01 px target,
depth limit 9); the wasm adapter caches the table per immutable geometry. The
tolerance is a subdivision target, not a global error bound.

### Compositions: the recursive composite

A **Group** is a composition placed as one `CompositionRef` layer in another;
the root and every Group share one shape, so there is one drawing path
([ADR 0052](adr/0052-link-propagates-group-composes.md)).

- **One `CompositionNode` per Group layer**, not per composition: two
  placements of one composition show different frames at one playhead. Shared
  services key per instance with `instanceKey(path, layerId)` — the bare layer
  id at the root.
- **Render to texture.** `CompositionRefSprite` composites its child node
  into a `RenderTexture` of the composition's size and stages it through the
  same `stageVisual` as every other kind, so transform, opacity, blend,
  effects and transitions apply to one flat image. The target is 8-bit
  (`bgra8unorm` on WebGPU), so the 10-bit lane quantizes through a Group.
- **Time.** Child `t = parent t − t_start + src_in`, re-snapped to the shared
  lattice (`compositionLocalUs`) — without the re-snap a child layer starting
  on an anchor difference reads one frame late. Past the composition's
  `duration_us` the texture is transparent.
- **Audio** runs the same recursion (`native/src/audio/mix.rs`
  `for_each_audio_layer`, same offsets and window, same depth cap
  `MAX_COMPOSITION_DEPTH`); a disabled Group layer silences everything below.
- **Preview draws its render target** (`state/compositionAnchorStore.ts`): the
  locked composition, or the focused one by default. Frame size, fps and
  clock follow the target. **Export always draws the root.**
- Every flat walk that must see inside Groups goes through
  `compositionWalk.ts` (export decode set and emptiness gate in
  `activeVideoLayers.ts`, Motif pre-bake in `exportBake.ts`, font collection,
  Motif planners). It reports each leaf at its root-time placement, clipped to
  the entered Groups' windows, with the head/tail cut. The Compositor's own
  sweep recurses through child nodes instead, because it owns sprites per
  instance.

### Keyframe easing authoring

User-facing behavior: [`features.md`](features.md#keyframe-curves). Mechanics:

- Focusing a property expands its sub-lane into a value graph
  (`timeline/KeyframeCurveGraph.tsx`) with a tangent handle per side of each
  Spline key. A drag rewrites one side via `setTangent` live and commits once
  on release. Auto sides draw greyed (`.kf-handle-auto`); grabbing one makes
  the key Free. With Smooth continuity the other side is rotated to the same
  slope during the drag; `ContinuityMenu` switches Smooth / Broken.
- Extrapolation outside the end keys is drawn dashed (`.kf-curve-extrap`),
  sampled through the same `resolveAnimated` the preview runs, with one mark
  beside the end key (`↻ ↔ ⤴ →`).
- `EasingMenu`: tier 1 is Linear / Hold / Ease In / Ease Out / Ease In-Out /
  Smooth (+ Extrapolate before/after on end keys); tier 2 is the preset
  gallery, thumbnails sampled through the wasm eval. Every row folds the
  selection per `(layerId, paramKey)` in `keyframeBatch.ts` and commits one
  `update_param_tracks_multi`. Arming or hovering a row previews through
  `easingPreviewStore`, which the curve graph and diamond row read in place of
  the committed track. Smooth marks keys Auto and leaves the numbers to main's
  write-time solve.
- Marker glyph = outgoing segment class (`interpGlyphClass`): diamond linear,
  square hold, circle eased.
- The sub-lane header carries the `◄ ◆ ►` navigator and a compact value field;
  inspector rows and this field are one control (`components/KeyframeField.tsx`),
  and editing it auto-keys at the playhead.
- A colour property draws a gradient strip (`timeline/ColorLane.tsx`): tiled
  canvas, one `resolveAnimatedColor` sample per device-pixel column, repainted
  only for visible tiles. No curve or tangent handles.

## Decoder pool

`SourceDecoderPool` holds one decode handle per **clip** (`layerId`): a
`SourceHandle` (WebCodecs, the Lite engine) or an `FfmpegSource` (native, the
Standard engine; [`preview.md`](preview.md#decode-engine)). WebCodecs handles
of one source share a refcounted `SourceMedia` (mediabunny `Input` +
`EncodedPacketSink` + decoder config) keyed by `mediaId`, but each owns its
`VideoDecoder`, `FrameRing` and `PacketPump`.

- A handle is created on first request and disposed 5 s after its last
  (`IDLE_DISPOSE_MS`); `SourceMedia` is freed at refcount 0.
- `decoderFallback.ts`: a hardware error before any output downgrades the
  handle once to `prefer-software`; `"Codec reclaimed due to inactivity"`
  nulls the decoder, logs once, and rebuilds lazily.
- `FrameRing` keeps 1 s lookahead / 0.5 s lookbehind (with a 10-frame
  lookahead floor and a byte budget, `frameRingBudget.ts`).
- The ring stores `ImageBitmap` snapshots, not `VideoFrame`s: `SourceHandle`
  runs `createImageBitmap(frame)` and closes the frame, returning the hardware
  decoder's pool slot. Holding `VideoFrame`s would pin the pool (~13 slots)
  and stall the decoder silently. The native software lane rings
  `NativeNv12Frame`s, converted only in the compositor's owned `Nv12Ingest`
  pass (ADR 0032). The export `ExportFrameStore` keeps `VideoFrame`s because
  its consumer closes each one right after encoding.
- `decoder/decodedFrame.ts` owns the `DecodedFrame` union
  (`VideoFrame | ImageBitmap | TenBitFrame | NativeNv12Frame`) and its
  `BrowserConvertibleFrame` subset (`VideoFrame | ImageBitmap`), the only
  kinds `VideoClipSprite.updateFrame` accepts — routing a CPU-plane kind into
  the snapshot path is a compile error. Timing lives beside each frame
  (`ptsUs`/`durationUs`), never on it.

### Byte handling

The source is never resident in memory. `openMediaInput` (`mediaInput.ts`)
opens a mediabunny `Input` over `MediaRangeSource`, a `CustomSource` that
issues HTTP `Range` requests against the `weftcut-media://` protocol (16 MiB
mediabunny cache, network prefetch profile). `read` loops until it has
exactly the requested bytes, because the protocol caps each 206 body (~1 MB)
and a short read wedges mediabunny. mediabunny owns demux and byte caching;
`PacketPump` pulls via `getKeyPacket` / `getNextPacket`, which await uncached
reads. The reset decision (`decideReset`) is synchronous; only the
reset action fetches a key packet.

### Why per-clip decoders

Overlapping copies of one source (A/B roll, split screen) need independent
anchors. With one decoder per `mediaId`, N overlapping clips wrote N
conflicting anchors per tick, the ring evicted its own contents, and the
decoder reset every tick — no clip ever painted a stable frame. The cost is a
decode session per clip (native hardware sessions are capped by main's
admission budget, `PREVIEW_GPU_MAX_SESSIONS`, hence the pool's
retained-session reclaim) and a cold decoder at every cut (~100–300 ms first
frame).

## Scrub

`PlaybackEngine` composites every seek immediately and feeds a
`ScrubCoalescer` (`decoder/scrub.ts`; the engine configures 50 ms debounce,
180 ms max-wait), so an unbroken drag still re-targets the decoder a few times
a second. On a stable target the pump resets to the prior key packet and
decodes forward. `maxWaitMs` must exceed the worst decode time from a
keyframe, which the short-GOP proxy ([`preview.md`](preview.md#proxies)) bounds; with a ~1 s GOP every
fire would flush an unfinished decode.

## Playhead updates

The engine emits the playhead once per composition frame
(`PreviewAudioEngine.emitTime`) into `state/playheadStore.ts` (zustand), never
into React state above a leaf: a frame-rate value in App state re-renders the
tree 30–60×/s and, under the dev build, ratchets native renderer memory.

The store holds **root time** (ADR 0053). Conversion to a render target's or a
Panel's composition time happens only in `state/playheadProjection.ts`, over
`render/timeProjection.ts` (which reuses `compositionWalk.ts`'s `childFrame`
and `compositionLocalUs`). An edit "at the playhead" uses the composition's
clock; a drawn playhead uses the windowed reading and is absent where its
Group is not on screen. Resolving an anchor walks the summary, so per-frame
subscribers hoist it with `useAnchorFrame` and subscribe through
`subscribeLocalPlayhead`.

Consumers pick the cheapest tier (rules in the store header):

1. **Event-time read** — `playheadTimeUs()` in handlers. No subscription.
2. **Transient subscription** — `usePlayheadStore.subscribe` in an effect,
   mutating a DOM node via ref (playhead line, timecode). Zero React commits.
3. **Throttled hook** — `usePlayheadTimeUsThrottled()` for value-at-playhead
   panels; trailing edge, so a pause converges on the exact frame.
4. **Frame-rate hook** — `usePlayheadTimeUs()`, tiny leaf subtrees only.

A per-frame loop must never read layout: the playhead dirties `style.left`
each frame, so a `getBoundingClientRect()` in the same rAF forces a full
reflow. Preview overlays (gizmo, motion path, safe-area guides) read a cached
rect (`preview/layoutRectCache.ts`), hoist their anchor with
`useFocusedPlayheadReader`, and skip DOM writes when nothing moved.

Guard: `e2e/scripts/memory-ratchet.mjs [text|transitions|text-box|groups]`
(local only; needs the dev server on port 1420). It plays 90 s of a no-media
fixture and fails when the post-GC memory floor rises ≥ 30 MB. Run the
scenario whose allocation class your change touches.

## Sprite kinds

| Sprite | Source | Notes |
|---|---|---|
| `VideoClipSprite` | `FrameStore.frameAt` | Browser-convertible frames upload via the snapshot rule below; CPU-plane kinds (`NativeNv12Frame`, `TenBitFrame`) go through owned ingest shaders (ADR 0032). |
| `ImageOverlaySprite` | `ImageDecoder` / `createImageBitmap` | Raster types go to `sharedAnimatedImageCache` (`animatedImageCache.ts`) first: a multi-frame source is decoded once (capped at composition size, drawn back at natural size) and looped to fill the layer (`gifFrameIndexAt`). Single-frame and bmp/tiff/svg sources take a one-shot full-resolution `createImageBitmap`. The export Worker awaits `preloadImages()` before encoding. |
| `TextSprite` | Pixi `Text` | Outline = stroke, shadow = `dropShadow`. Box layout below. |
| `MotifSprite` | captured Motif frame | Binds the frame for the layer-relative time; see [`motifs.md`](motifs.md). |
| `ColorSprite` | Pixi `Graphics` | Animated fill. |
| `CompositionRefSprite` | child `CompositionNode` | See Compositions above. |

### Text entrance and exit presets

`TextParams.intro` (`FadeIn | SlideUp | SlideDown | Typewriter`) and `outro`
(`FadeOut | SlideUp | SlideDown`) are semantic presets, not keyframes: they
stay attached to the layer's start and end, so trims and moves keep them.
`shared/textAnimation.ts` (`textAnimationAt`) defines them and `resolveView.ts`
applies them, so preview and export play the same frames:

- an entrance/exit lasts 400 ms, or a third of the layer if shorter, ease-out
  cubic; fades multiply the layer's opacity;
- slides travel half the font size (`SlideUp` rises into place; on exit rises
  away);
- `Typewriter` reveals one character per 40 ms over at most half the layer.

Set through `update_layer_params` (`null` clears). The properties panel does
not expose them.

### Text layout: the box

Decision and rejected options: [ADR 0049](adr/0049-text-box-lays-out-glyphs-it-does-not-scale-them.md).

**Fonts.** Registration belongs to the document's or the export Worker's
`FontFaceSet`, not to a Compositor. `loadFontsIntoFaceSet` registers each
family once per set and shares in-flight loads; bytes come from
`fonts/registry.ts` (bundled Liberation Sans + Noto Sans SC, OS resolution
otherwise). Re-adding a `FontFace` does not replace the old one and the
document keeps it alive, so reopening Preview reuses the document's fonts;
the export Worker installs its own before the encode loop.

**Mode** is read from `(box_w, box_h)`: `(null, null)` Auto width (no wrap),
`(set, null)` Auto height (wrap), `(set, set)` Fixed (wrap + shrink).
`TextSprite` coalesces `(null, set)`, bogus `align`/`valign` and non-finite
box/leading/tracking to safe values, because the failure would be a NaN
transform — a vanished layer.

**Placement in the box.** Pixi's block is `maxLineWidth` wide (plus stroke and
shadow), never `wordWrapWidth`, so `align` only distributes lines within the
block. `TextSprite.blockAnchorInBox` offsets the block inside the box from
`align`/`valign` and expresses it as a Pixi `anchor` — not `pivot`, which
would move the rotation/scale origin. With no box the anchor is unchanged.
`naturalSizeOf` reports the box, so the gizmo draws the box, not the glyphs;
a glyphless layer reports one em by one line.

**CJK.** `fonts/lineBreak.ts` (`installCjkLineBreaking`) is called
unconditionally in the `Compositor` constructor, outside the preview-only font
branch. Gate: `e2e/electron/text-box-cjk-export.spec.ts` exports one CJK
string auto-wrapped and once with explicit `\n`, and SSIM-compares the two.

**Shrink-to-fit** (Fixed only): `textBox.ts` `fitFontSize` binary-searches
whole-pixel sizes with `CanvasTextMetrics.measureText` — whole pixels so the
search needs no epsilon and Pixi's measurement cache stays bounded. Floor
`TEXT_BOX_MIN_PX` = 8 (also the `box_w` drag floor); an authored size below
it is never enlarged. The factor scales outline, shadow, leading and tracking
too (`line_height: 0` = font metrics, unaffected); scaling leading is what
lets the search converge when an absolute leading exceeds `box_h`. The search
runs inside `TextSprite`'s `appliedSig` gate, so an unchanged box costs no
re-measure; the winning probe's `TextStyle` is kept so the measurement cache
hits. `GizmoProbe.textFitOf` exposes the result.

### Frame upload: the snapshot rule

**Never bind a raw `VideoFrame` to a Pixi texture.** Pixi's WebGPU upload
(`copyExternalImageToTexture`) ignores the frame's `colorSpace` and converts
with fixed BT.709 limited range — a destructive mis-convert for 601 or
full-range sources. Chromium's 2D-canvas paths honor a decoder-produced
frame's matrix and range, so:

- **Preview** converts at decode output (`createImageBitmap` in
  `SourceHandle`); the ring already holds correct RGB.
- **Export** keeps `VideoFrame`s, and `VideoClipSprite` draws each into its
  own `OffscreenCanvas` with `drawImage` before binding.

Buffer-defined frames (native CPU planes) are converted by Chromium as BT.601
whatever their tag, so they never take this path: they ride
`NativeNv12Frame` / `TenBitFrame` through owned ingest shaders (ADR 0032),
enforced by the `BrowserConvertibleFrame` parameter type. This is one gated
chokepoint of the color model (ADR 0014, which also holds the evidence: the
perceptual gate scores ~22 without the export snapshot, ≈0 with it).

**Zero-copy (`importExternalTexture`) is parked.** It does honor the matrix,
but the blit it would remove costs ~0.03 ms/frame at 1080p and 4K
([measurement](notes/playback-perf-findings-2026-07.md#the-loop-is-not-the-bottleneck)),
while the replacement needs a bespoke per-frame external-texture pass, a
permanent WebGL dual path (export has no `navigator.gpu`) and a new
conformance pass. Only 4K export could justify it; measure
`__weftcutExportPerf.compositeMs` first.

## Export Worker

`worker/exportWorker.ts` receives a `start` request (`worker/protocol.ts`):
an `OffscreenCanvas`, an `ExportProjectSnapshot`, `[startUs, endUs)`, the
encoder config or native sink `pixFmt`, bit depth, the native-decode media
set, `allowHwExportDecode` and the font bytes. It mounts a `Compositor` in
export mode on the **root** composition, installs the fonts, awaits
`preloadImages()`, and walks the output grid with the exact rational fps
(`worker/frameGrid.ts`) so trims and 29.97-style rates neither drift nor
over-count. Motif frames arrive as bounded
`motif:frame` packets from the renderer and are credited back after use.
Output streams to the main thread as `chunk` events, each awaiting a
`chunk-ack`, so no export is bounded by a single `ArrayBuffer`; `done` carries
only perf counters. The main thread then runs the audio export and mux
([`export.md`](export.md)).

### Export decode pipelines (one per media × phase)

The Worker plans `ExportDecoderPool` ranges in 60-frame chunks
(`CHUNK_FRAMES`) and consumes concurrently via `ring.waitForPts` and
eviction. Each producer parks on a fixed window (`EXPORT_FRAME_WINDOW` = 24)
that counts pending packets, resident pictures and 10-bit copies together
([resource accounting](performance-settings.md)); a long GOP may span several
chunks. Blocks also split at source activation/deactivation, so rapid cuts do
not open all their decoders at once. Ranges on one handle are serialized.

Two handles implement `ExportDecodeSession`, chosen per media by the routing
table:

- **`ExportSourceHandle`** — in-worker `VideoDecoder`, no mid-export
  `flush()` (only true EOS drains the reorder tail; software decoders withhold
  trailing frames, e.g. macOS H.264 2–4, so every lane carries a reorder
  lead-in). Hardware decode is allowed only on Windows and macOS
  (`hwExportDecodeAllowed`, passed as `allowHwExportDecode`): on Linux/NVIDIA
  a hardware `VideoFrame` reads back as zeros with no error. The 10-bit lane
  always pins software.
- **`NativeExportSourceHandle`** (`worker/nativeExportSource.ts`) — a relay to
  a credit-windowed native `export_sw` session that decodes the **original**
  and streams NV12/I420P10 planes back in order, one credit returned per frame
  leaving the ring. `nd:rangeEnd` closes a range without an out-of-range proof
  frame; a backward range starts a new generation. Transport:
  [`export-ipc-transport.md`](export-ipc-transport.md); decision: ADR 0033.

Pipelines are keyed by `exportHandleKey` = `mediaId` + phase
(`src_in_us − t_start_us`), and each chunk dispatches one merged range per
key. Same phase (stacked copies, trims of one pass) shares one decoder; ring
eviction takes the group minimum. Different phases get separate pipelines,
because one ring holding the gap would exhaust the ~13-slot decoder pool and
deadlock. Keying by bare `mediaId` let overlapping clips race one packet
cursor and froze the export; gate: `e2e/electron/export_overlap_same_source.spec.ts`.
Source time per pipeline is monotonic in `t`, so export never seeks backward.

### Export source resolution

**Engine routing.** `resolveExportDecodeRouting` (`exportDecodeRouting.ts`)
runs once at export start (`app/useExportFlow.ts`) from the project's
`decodeEngine` setting, native-component presence, composite bit depth and
each medium's persisted Decode Route, and the table rides into the Worker.
Nothing re-resolves mid-run; a native session error aborts the export (ADR
0033). `auto`: WebCodecs-decodable sources stay in-worker, `native-sw` routes
decode the original natively. `ffmpeg`: every source native. `webcodecs`:
every source in-worker. Without the component, `ffmpeg` degrades to `auto`
and nothing routes native. The dialog's "N from originals, M from lossy proxy"
line comes from the same table (`routingSourceCounts`), and native-routed
media skip proxy readiness (`proxyWaitScope`).

**WebCodecs readiness** (`exportReadiness.ts`). WebCodecs-routed clips read
their export source from the Decode Route (`resolveDecode`): the original for
DirectExport/bypassed sources, otherwise the full export master — never the
quick preview proxy. DirectExport originals (`sourcesNeedingPreflight`) get a
main-thread pre-flight (`probeSourceDecodable`): configure, decode one key
packet, race against the error callback and a deadline (WebCodecs can stall
silently). A failure aborts before the Worker starts and calls
`ensure_full_proxy`, so a retry succeeds from the master. The probe memo is
shared with the import sweep, so an in-flight probe is awaited rather than
duplicated — concurrent probes contend for the decoder pool and false-negative.

### Encode exits

`resolveEncodeTarget` (`encodeTarget.ts`) returns `NativeTarget { pixFmt }` or
`WebCodecsTarget { workerCodec }`. `auto` (default) always resolves native.
WebCodecs is reached only by an explicit pin on an 8-bit H.264/HEVC/AV1
export; the dialog disables conflicting combinations and `mergeSettings`
snaps a stale saved combo back to `auto`. If the native sink fails to start
under `auto` for an 8-bit non-intermediate, the user is offered a WebCodecs
retry; every other failure is a hard error. The engine never swaps silently.

**Native (default).** The Worker forces WebGL2 (the pack shaders need GL; the
WebCodecs exit prefers WebGPU). A GPU pack pass — `PackYuvPlanar` for
yuv420p / yuv422p / yuv422p10le, `PackYuv420p10` for yuv420p10le — writes
rawvideo, read back asynchronously two frames deep (`yuv/pboReadback.ts`
`PboFrameReader`), and streams over `chunk`/`chunk-ack` to the native ffmpeg
sink (`native/src/export/videosink.rs`). The sink runs one `EncoderPlan` from
`export/encoder_registry.rs`, which maps codec intent to an adapter that
passed a real one-frame probe and owns every output argument (rate control,
GOP, pixel format/profile, `bt709`/`limited` tags). A missing encoder yields
structured `EncodeUnavailable` attempts, never a guessed encoder name.

**10-bit** (HEVC Main10 / AV1 10-bit, and ProRes) composites into an
`rgba16float` target; DNxHR is 8-bit. 10-bit-capable sources (Hi10P, AV1
10-bit; `tenBitExportCapable`) decode in software through a CPU-plane lane —
AV1 hardware decode emits opaque frames that cannot `copyTo`. `TenBitIngest`
uploads planes as `rg8unorm` and unpacks into the f16 target. Copies share the
24-frame window and hold their reservation until their input frames close.
The lane is labelled **experimental** and confirmed on click: preview stays
8-bit SDR and the path runs below realtime (ADR 0022).

**WebCodecs (pin only).** `VideoEncoder` encodes the canvas frames
(`timestamp = tUs − startUs`, backpressure at `encodeQueueSize > 8`) and
mediabunny writes fMP4 slices over the same chunk loop. Color tags are the
encoder's defaults.

**Intermediates.** ProRes (`prores_ks`, proxy/lt/422/hq, yuv422p10le) and
DNxHR (`dnxhd`, lb/sq/hq, yuv422p) are native-only and MOV-only; the profile
fixes rate control, so bit-depth/CRF/preset/GOP controls are hidden.

Guard: `e2e/electron/export_codecs.spec.ts` (AV1/HEVC, 10-bit HEVC step
counts above the 8-bit ceiling, pinned-native H.264 tags, ProRes, DNxHR).

## Preview canvas

The preview canvas's logical size is the composition; every transform, render
texture, filter frame and `containMap` speaks composition pixels. Only
`renderer.resize(w, h, resolution)` sizes the backing store, with
(`decoder/playbackResolution.ts`, `previewRenderResolution`):

```
resolution = min(1, scale, knob)   scale = zoom, or fit in Fit view
                                   fit   = min(room.w / width, room.h / height)
                                   knob  = Full 1 · 1/2 0.5 · 1/4 0.25
```

`room` is the host's (`.pixi-preview-host`) `ResizeObserver` box in whole
device pixels. The knob caps the fit rather than multiplying it: pixels above
the fit are never shown, while the knob's real saving — the decode divisor
(Full 1, 1/2 2, 1/4 4) — applies regardless; the fit never reaches
`OutScale`. Below a fit of 1, `fittedCanvasBox` writes the canvas box from the
Full buffer size, centred and device-pixel-snapped, so Pixi does the downscale
and `Text` (which follows `renderer.resolution`) rasterizes at display
density; a still text layer snaps its block to the buffer grid (preview only).
At a fit of 1 CSS contain-fit owns the canvas (`.pixi-preview-canvas`) — the
E2E gates' case. [ADR 0071](adr/0071-the-preview-backing-store-fits-the-display-box.md).

Zoom is that scale: device pixels per composition pixel, so 100 % is the
composition's own detail. `Fit` is a mode; the renderer publishes the resolved
fit into `previewViewStore`. Outside Fit, `fittedCanvasBox` writes the zoomed
box even past the host; pan is clamped per axis and stays on the device grid.
Pan moves only the DOM box; zoom also changes resolution; both invalidate the
cached canvas rect. Gestures: [`preview.md`](preview.md#interaction).

- **Composition size is the composition's.** Below a fit of 1 Pixi's logical
  size becomes `pixels / resolution`, so `PixiPreview` keeps the composition
  integers itself and never reads `app.screen` or `renderer.width/height`.
- **Readbacks render at `resolution: 1`** (colour picker `captureFrame`, E2E
  `sampleComposite`, conformance PNGs), so they are composition-sized at any
  fit or knob. Filter intermediates are allocated at resolution 1
  (`Filter.defaultOptions.resolution`), so texel-addressed kernels (sharpen)
  match between preview and export.

## Render & Play

The export-complete panel offers **Play**, which opens the exported file in a
secondary window (`useExportFlow.ts` `openRenderPlayPopup`): static
`/render-play.html`, with the asset URL, display path and localized title in
the URL hash (the page has no i18next); each window gets a unique
`render-play-<ts>` label. Beside it, a reveal button (`shell:reveal`) reads
"Reveal in Finder" / "Reveal in Explorer", and "Show in folder" on Linux,
where `main/openPath.ts` opens the containing folder through a detached
`xdg-open` because Electron's `showItemInFolder` wedges GTK file managers.
Main `stat`s the file first, since `showItemInFolder` ignores a missing file.

## Regression gates

Pixi is its own ground truth; there is no reference renderer. Rendering
regressions are caught by Playwright specs that export through the real app
and analyze the file against its sources — `conformance.spec.ts` (alignment +
SSIM), `color-conformance.spec.ts`, `transitions-wysiwyg.spec.ts`,
`group-export-*.spec.ts`, `text-box-cjk-export.spec.ts`. Suite layout and
analyzer: [`conformance.md`](conformance.md).
