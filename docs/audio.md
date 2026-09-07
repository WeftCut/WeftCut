# Audio

One model, two paths. The project's audio model — per-layer trim,
placement, `gain_db`, `pan`, fades, mute — is evaluated **once** into
sampled envelopes, and two thin renderers consume the same control
points: a Web Audio graph plays them in the preview, a Rust mixer
writes them at export. Neither path re-derives the model, so preview
and export cannot disagree about what a curve means; the only thing
either path owns is playback (or encoding) mechanics.

Decision record: [ADR 0019](adr/0019-audio-mixes-in-rust-over-conform-pcm.md).

Both paths read the same bytes: a **conform cache** holds every
audio-bearing source as canonical PCM, produced once at import. The
preview never decodes audio; the export never decodes audio; decode
variance between Chromium/Electron and ffmpeg is out of the picture entirely.

## The authoring grid

Audio layer edges — `t_start_us` and `t_end_us` — are quantized to **exact
48 kHz sample boundaries**, `round(i × 1e6 / 48000)`, ~20.83 µs apart. Video
layers stay on the composition frame grid; audio does not, and that asymmetry is
the point.

It is the same lattice the mixer renders on. `mix.rs` already converts
`t_start_us` / `src_in_us` / `src_out_us` to 48 kHz sample frames, so choosing
samples for authoring makes the two *literally one lattice* — **there is no
rounding at the render seam**. The stored microsecond is the sample that plays.
Before this, the authoring model was strictly coarser than the engine beneath it,
and raising the video fps silently changed how precisely audio could be placed.

The rate is the fixed mix rate, not `composition.sample_rate`: that field is only
the export target, a delivery parameter that moves no edit. An FCP-style
1/80-frame subframe was rejected for the same reason — at 29.97 one subframe is
20.02 samples, so a subframe edit would land *between* mix samples and be rounded
again at render, re-creating the two-grid problem this removed.

Audio automation (`gain_db`, `pan`, role envelopes) quantizes on the same lattice
at write time, so an envelope is never coarser than the mixer reading it. (The
10 ms coefficient grid in "The envelope contract" below is a separate thing: it
is how a *rendered* ramp is sampled, not where an authored keyframe may sit.)

Consequences worth stating:

- **Sample precision is not reachable by dragging.** At the 2000 px/s zoom
  ceiling one sample is 0.042 px, so pointer drags keep snapping to a visible
  quantum; sample accuracy arrives through nudge keys and numeric entry.
- **A grouped A/V pair carries its sync offset implicitly**, in each member's own
  `t_start_us`. There is no stored offset field, so nothing can disagree with the
  geometry. A whole-group move shifts every member by the same delta and each
  lands on its own lattice, so the offset survives exactly; a video trim does
  *not* drag slipped audio, because the trim's aligned set requires coinciding
  edges.
- At 24, 25, 30, 50, 60 and 23.976 fps a frame boundary *is* a sample boundary
  (integer samples per frame), so a co-aligned pair is exact. At 29.97 and 59.94
  it is not, so a paired audio layer sits up to ~10 µs from the video frame —
  where the mixer would have played it either way.

The lattice is selected by one function, `gridForLayerKind` in
`main/state/snap.ts`, shared by the commit validator, every mutation snap, and
the load repair. See [data-model.md](data-model.md) for the enforcement contract.

## The conform cache

Every imported media with an audio stream gets a conform file —
WeftCut's equivalent of Premiere's CFA conform, and chosen for the
same reason Premiere states for theirs: the cache format **is** the
engine working format, so the hot path never converts.

**Canonical format: 48 000 Hz, 32-bit float, source channel count
capped at 2, interleaved.**

- **48 kHz** because video-world sources are overwhelmingly 48 kHz
  already — for them conform is a decode, not a resample — and it
  matches the typical device `AudioContext` rate. Resampling (44.1 kHz
  music, exotic rates) is paid once at import, never per
  playback/export. There is deliberately no per-project audio sample
  rate setting; the export target rate is a one-time `aresample` at
  encode.
- **f32** because `AudioBuffer` channel data is f32, the mixer
  accumulates in f32, and float headroom means gain staging cannot
  clip until the single quantization at encode.
- **Mono stays mono** (half the disk for the voice-recording class);
  >2-channel sources downmix to stereo at conform. Consumers up-mix
  mono via the pan law (below).
- **Interleaved** because the preview reads time-windows over
  `weftcut-media://` HTTP Range requests — one window, one contiguous
  byte range.

File layout (little-endian, sibling of the `.peaks` format):

```
magic        "VCONF\0\0\0"  (8 bytes)
version      u32            (CONFORM_FORMAT_VERSION)
sample_rate  u32            (48000)
channels     u32            (1 | 2)
frame_count  u64
data         interleaved f32 samples
```

Frame addressing is arithmetic: `offset = 28 + frame * channels * 4`.

**Producer:** `jobs/conform.rs`, one ffmpeg invocation
(`-i src -vn -ac {1|2} -ar 48000 -f f32le -`) streamed to
`Cache/audio/{blake3}.conform` through the standard job FIFO, with the
same pending-hash migration and skip-if-cached behavior as the
waveform job. Triggered at import for audio-bearing media; an
`ensure_conform` path covers media imported before the format existed
(and `CONFORM_FORMAT_VERSION` bumps). Job completion logs the file
size — conform costs ~1.4 GB per stereo source-hour (half for mono),
and that cost is deliberate; see the trade-off in ADR 0019.

The waveform job stays independent (22 050 Hz mono peaks); collapsing
it onto conform output is a possible later simplification, not a goal.
An effect chain adds a **sibling** pair beside both files —
`{hash}.fx-{sig16}.conform` and `waveforms/{hash}.fx-{sig16}.v4.peaks`, one
per distinct chain (see § Clip effects).

Those fx siblings are the one part of `Cache/audio/` the disk-cache LRU sweeps:
`cache/disk_lru.rs` collects `*.fx-*.conform` as units under the shared budget
while the canonical `{hash}.conform` beside them stays excluded, because a bake
is one filter pass over already-decoded PCM (~300× realtime) and a conform is a
full decode. The `.v4.peaks` siblings were already units. Since mtime is the
LRU clock, a reader that short-circuits on a cache hit refreshes it — otherwise
the artifact being played ages out as the oldest unit in the cache.

## The envelope contract

The heart of the design. For each audio layer, the shared keyframe engine
(now the single `weftcut-eval` leaf — compiled natively for Rust and to
wasm for the renderer, see [`render.md`](render.md) and
[ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md)) resolves two
envelopes over the layer's local time span:

```
gain envelope  = lerp-sample(Animated gain_db, Δ = 10 ms)
                 → linear (10^(dB/20))
                 → × fade-in ramp × fade-out ramp     (linear ramps)
pan envelope   = lerp-sample(Animated pan, Δ = 10 ms), clamped [-1, 1]
```

The output is a list of `(t_ms, value)` control points. **Both
consumers linearly interpolate between the same points**:

- Web Audio applies the gain envelope with `setValueCurveAtTime` —
  whose semantics are exactly linear interpolation across the sampled
  array — and the pan coefficient curves via `setValueCurveAtTime` on
  the matrix `GainNode`s.
- The Rust mixer lerps per sample between the same points.

Identical points, identical interpolation: parity holds by
construction, not by tolerance. Properties that are fully static (no
keyframes, no fades) skip sampling and travel as a scalar.

Known quantization: a `Hold` keyframe's instant step becomes a ≤10 ms
ramp between the two grid points that straddle it. Accepted; 10 ms is
well under a frame.

The envelope sampler's drift-prone math is single-sourced in the
`weftcut-eval` leaf (native for Rust, wasm for the renderer): `db_to_linear`
(`10^(dB/20)`), the keyframe interpolation it samples, the **fade ramp**
(`fade_multiplier`), and the **equal-power pan law** (`pan_coeffs`). The
sampler STRUCTURE around them — the 10 ms grid loop and the per-sample lerp —
is still parallel Rust/TS code, guarded by `audioEnvelopeGolden.fixture.json`.

Pan law: the equal-power law is a time-varying 2×2 mix matrix
`[a,b,c,d]` (`out_l = a·l + b·r`, `out_r = c·l + d·r`), computed by
`weftcut-eval::pan_coeffs`. The canonical pan control points are the
COEFFICIENTS, sampled on the 10 ms grid; both consumers lerp coefficients
(export per-sample, preview via `setValueCurveAtTime`) — the same grid →
lerp discipline as gain, so parity holds by construction. The
`panLawGolden.fixture.json` covers mono + stereo branches; the pan
coefficient envelope is additionally covered in the envelope golden.

## Preview mixer

`render/audio/` replaces element-based playback with a
buffer-scheduled graph on one shared `AudioContext`:

```
per layer:  AudioBufferSourceNode (chunk)
              → GainNode        (gain envelope via setValueCurveAtTime)
              → ChannelSplitter → 4×GainNode → ChannelMerger
                                (pan matrix; coefficient curves from the
                                 weftcut-eval pan law — mono uses 2 gains)
              → trim GainNode   (micro-fades, re-anchor masking)
              → master.input
master:     input → analyser (meter) → DynamicsCompressor
              (−1 dB, 20:1, 1 ms attack — soft overload protection)
              → destination
```

**Feeding:** chunks are read straight from the conform file over
`weftcut-media://` HTTP Range requests (loop-read until the exact byte
count, the established Range discipline) and de-interleaved into
`AudioBuffer`s — **no decode in the renderer, ever**. Chunk length 1 s, lookahead 3 s,
at most 8 live chunks per layer (~3 MB). Mono conform produces mono
buffers; the pan matrix routes the single channel to both outputs via
the mono pan law (2 gains).

**Scheduling:** sample-accurate inside the audio clock domain —
`when = ctxTimeAtCompUs(anchor, chunkCompUs)` against the engine's
clock anchor. Chunks that would start in the past start now with a
compensating buffer offset.

**Clock:** the audio hardware clock is the master. One `ClockAnchor`
(a composition-µs ↔ `AudioContext.currentTime` pair, defined in
`chunkSchedule.ts` and nowhere else) is owned by the `PlaybackEngine`:
while the context is running, the playing position is DERIVED from
`ctx.currentTime` against it — pure mapping, no accumulation — and the
engine forwards the same anchor to every `AudioMixer`, which schedules
chunks against it. Playhead and audio share one clock by construction;
there is no second clock to reconcile, so there is no reconciler.
While the context is suspended (autoplay policy, before the first
gesture) the clock falls back to `performance.now()` deltas; the flip
back to audio-derived re-anchors from the current position, so
switching sources never jumps the playhead. The anchor is re-taken on
play and on seek-during-play; mixers detect the identity change and
reschedule behind a ~5 ms micro-fade.

**Edits during playback:** a parameter change re-derives the layer's
envelopes and reschedules that layer (`cancelAndHoldAtTime`, then
fresh curves — `setValueCurveAtTime` forbids overlapping automation,
so rescheduling is the only correct move). Seek/pause cancel all
scheduled sources; resume re-anchors. Mute, track-silenced, and
out-of-window layers simply don't schedule.

**Layer skip rules (preview and export share rules 1–6):**

1. `Track.enabled == false` — the whole track is off; skip all its audio layers.
   This is the one whole-track gate left: track `muted`/`solo` no longer gate
   audio (audio mute/solo moved to roles — see Roles below).
2. The layer's role is muted (`RoleMixSettings.muted == true`) — every layer
   tagged with that role is silenced.
3. A role-solo set is non-empty — any role with `solo == true` exists; skip
   layers whose role is not soloed. (An empty solo set → normal path.)
4. `mute wins over solo` — a role that is both muted and soloed is silent, and a
   muted role inside a solo set never reopens.
5. `Layer.enabled == false` — the individual layer is off; skip it regardless of
   role flags.
6. `AudioParams.mute == true` — the layer's own clip mute; skip it.
7. `Layer.locked == true` — **export-side only**: the export planner drops locked
   layers' audio; the preview mixer does not apply this rule, so a locked layer
   still plays back. The divergence is inherited, not designed — locking is an
   edit guard, and silencing on lock is arguably wrong on both sides.

The mute/solo half of these rules is evaluated against the project's `audio_roles`
table, so it is consistent whatever track a layer lives on. The mute/solo
DECISION itself now runs the shared `weftcut-eval` leaf (`role_audible` — native
in the export planner `audible_audio_layers`, wasm in the preview gate
`roleGate.ts`; [ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md)) and is guarded
by the `roleGateGolden.fixture.json` cross-language golden. The layer-selection
loop around it (track + window gating) stays parallel on the two sides.

The master meter (RMS + peak per channel) is surfaced to the dev
PerfHUD and over MCP for level checks.

## Roles

Audio mixing groups by **role**, not by track. A role is a per-layer
tag on `AudioParams` — Dialogue (the default), Music, SFX, or
Voiceover — and each role is a mix bus. The buses live project-level in
`Project.audio_roles`, one `RoleMixSettings { gain_db, muted, solo }`
per role; an absent entry resolves to defaults (0 dB, unmuted,
unsoloed) via `role_mix`, so a project that never touched the mixer
plays every role at unity. Decision record: [ADR 0023](adr/0023-audio-mixes-by-role-not-track.md).

v1 realizes the bus by **folding**: the role's `gain_db` is converted
to linear and multiplied into every member layer's gain envelope before
the block loop, and role mute/solo simply filter which layers enter the
plan. There is no separate summing stage per role — the per-block
accumulator loop is unchanged from a track-less mix. A future per-role
effect insert (`RoleMixSettings.effects`) is the deferred extension
point that would turn the fold into a real bus with its own DSP; it is
named in the data model and does nothing yet.

Three control levels stack, each owning a different scope:

- **Clip mute** (`AudioParams.mute`, per layer) — silence one layer.
- **Role mute / solo / gain** (`audio_roles`, the mix) — silence,
  isolate, or trim a whole category of sound at once ("all dialogue",
  "just the music").
- **Track `enabled`** (the eye toggle, whole track) — turn an entire
  track's picture *and* audio off together.

Role gain is a **recorded** edit — `set_role_gain` lands on the undo
stack like any parameter change. Role mute and solo (`update_role_flags`)
are **unrecorded** preferences applied to every history snapshot, so
Ctrl-Z never flips a mixer toggle — the same convention as the track
eye/lock flags. The Mixer panel is the surface that drives these.

## Clip effects (baked)

An audio effect is an **offline bake**, not a realtime insert: a layer's
`audio.*` effect chain is rendered once by ffmpeg from the media's conform
into a **sibling conform file**, and both mixers read that sibling instead of
the raw conform. Decision record:
[ADR 0063](adr/0063-audio-effects-are-baked-conform-siblings.md). The v1 kind
is `audio.denoise` (`afftdn` with a user-sampled noise profile).

The chain is the ordinary `Layer.effects` array; audio kinds live in the
`audio.*` namespace and the command layer refuses one on a non-Audio layer
(and a visual kind on an Audio layer). The **effective chain** — what a bake
actually renders — is the enabled, catalogued, *complete* audio effects in
stored order; an incomplete one is dropped exactly as a disabled one is, and
the card says what is missing. A denoise is complete when both sample-region
bounds are written, the span is at least 250 ms, and it lies inside the media's
probed duration. Region bounds are **source (media) time**, so move, trim, slip
and split never invalidate a bake.

### The pipeline

`main/audioFx/baker.ts` is the orchestrator, and the only holder of bake state:

```
actor change ──► desired = effectiveChain(layer) → chain signature
   (Layer diff hint ⇒ that layer; anything else ⇒ every composition)
      │
      ▼  per layer, 400 ms debounce (a standing timer is re-armed only by a
      │   CHANGED desire, so a burst of edits collapses into one bake)
   ready under this signature and the file is still there  ⇒ done (touch mtime)
   raw conform missing                                     ⇒ ensure_conform, wait
                                        (its derivatives event re-enters here)
   the sibling is already on disk and its header parses    ⇒ ready (build peaks)
   another layer is already baking this signature          ⇒ attach to it
   otherwise: cancel the bake this layer is leaving (if nobody else wants it),
              measure_conform_rms → buildFilterComplex → bake_audio_fx
              → build_peaks_for_vconf → publish ready
   on failure: publish failed, KEEP the previous ready artifact
```

Bakes share `ffmpeg_sem` with the import derivatives — no second pool — and
emit the usual `media:job_started/complete/error` with `kind: "audio_fx"`, so
the status bar's job counter includes them. A cancel aborts the task, which
reaps ffmpeg through `kill_on_drop` and discards the temp.

Rust's part is three stateless primitives in `native/src/audio/fx.rs`
(spawned through `jobs/mod.rs::spawn_audio_fx`): `measure_conform_rms` pools a
frame range into one dBFS figure, `bake_audio_fx` runs a finished
`filter_complex` from one conform into another, and `build_peaks_for_vconf`
draws the waveform sibling. None of them knows what an effect is.

### The signature and the paths

Everything that decides *what* gets rendered is TS. `shared/audioEffects/`
holds the catalog (`catalog.ts`, `denoise.ts`), the bake contract and the
graph composer (`graph.ts`), the conform-format twins (`conform.ts`), the
canonical string (`signature.ts`) and the cross-process state vocabulary
(`status.ts`). Only main hashes it (`main/audioFx/signature.ts`), because the
shared tree compiles without Node types — and nothing renderer-side needs a
signature, it reads the paths the baker publishes.

```
v1|{media_hash}|{CONFORM_FORMAT_VERSION}|{kind}@{version}{k=v,…};{kind}@{version}{…}
```

Params sorted by key and printed to six decimals, effect `id` excluded (so two
layers configured alike share one artifact), chain order preserved (it is the
render order), only effective entries present. `sig = sha256(canonical)`;
`sig16` is its first 16 hex chars. An empty effective chain has **no**
signature — that layer plays the raw conform.

```
Cache/audio/{media_hash}.fx-{sig16}.conform        (VCONF; same header as the raw one)
Cache/waveforms/{media_hash}.fx-{sig16}.v4.peaks   (the processed waveform)
```

The layout is stated twice — `cache/mod.rs`'s `audio_fx_conform` /
`waveform_fx` and `main/audioFx/fxPaths.ts` — because only the baker holds a
signature, so only the baker can name the file; the TS side also owns the
trust predicates (non-empty, magic, format version, plausible channel count),
since disk existence is what "ready" means.

**The denoise graph** trains the filter with a concat pre-roll: the sample
region is prepended to the clip, `asendcmd` starts and stops `sample_noise`
over that copy, and a trailing `atrim` drops it again. `afftdn` is streaming,
so without the pre-roll everything before the region is processed with an
untrained profile (measured: 3.7 dB of reduction there, against 9.3 dB with
it). Both trims count **samples** on the 48 kHz lattice, never seconds: with
second-valued bounds the pre-roll and the trim that removes it can differ by
one sample, and `bake_audio_fx` rejects a graph that changes the frame count.
`nf` is derived at bake time as `clamp(round(region_rms_dbfs + margin), -80,
-20)` — `sample_noise` sets the profile's spectral shape and never its level,
so a loud floor left at the filter's default makes the whole filter a no-op.

### The three seams

- **Preview.** `PixiPreview.tsx`'s `audioSourceUrl(layerId, mediaId)` answers
  the baked path when the layer has one and the raw `conform_path` otherwise;
  `CompositionNode.ensureAudio` disposes and recreates the `AudioMixer` when
  the url changes, so the swap lands behind the existing ~5 ms micro-fade. A
  url that goes null under a live mixer keeps that mixer — the audio it already
  holds is closer to the truth than silence.
- **Export.** `render/exportReadiness.ts`'s `runAudioFxGate` runs after the
  conform gate (the conform is only half the audio wait): listener first, then
  `ensure_export_audio_fx`, then the wait, with a Cancel-able "preparing"
  panel. Main injects `layerAudioSources` into the mix channel
  (`state/export-project-forward.ts`), and `audio/mix.rs`'s `plan_for_project`
  uses the override as that layer's `conform_path` when the file is there.
  Only layers whose *desired* signature is the one on disk are named, so an
  absent entry means "no effects", never "not ready yet". The export window
  filters **root-composition** layers only: a layer inside a Group keeps times
  local to that Group and only the mix planner resolves the placement that maps
  them, so a Group's members are always included — waiting for one bake too
  many is cheaper than exporting audio the user never heard.
- **Waveform.** A tile's identity is a `waveformKey` — a media id for the raw
  conform, or `fx:{media_hash}.fx-{sig16}` for a baked sibling.
  `LayerBlock.tsx` picks the fx key when one is ready,
  `tileEngine/WaveformTileProducer.ts` keys tiles and level tables by it, and
  `state/single-media-forward.ts` resolves an `fx:` key to an explicit
  `waveformPath` before forwarding to Rust. An fx key is immutable per
  artifact, so a new bake is simply new tiles and no invalidation event is
  needed.

### Readiness and status

The baker publishes one `LayerFxState { desired_sig, ready, pending, error }`
per layer over `audio_fx:status`, answers `audio_fx_snapshot` for boot-time and
late subscribers, and `state/audioFxStore.ts` mirrors the map in the renderer
(full state per push, never a delta, so a dropped event cannot half-update it).
Nothing is persisted: a stored path outlives the file it names.

Status is a four-way derivation of that record, in this order: no desired
signature ⇒ **none** (the layer plays the raw conform); `ready.sig` equals the
desired one ⇒ **ready**; an error stands ⇒ **failed**; otherwise **pending**.
Ready wins over a stale error deliberately, because the last failure stays
attached until the next bake supersedes it.

- **Preview is stale-while-revalidate.** The last ready artifact keeps playing
  while a new bake runs and after one fails; only an empty chain returns the
  layer to the raw conform.
- `ready.peaks_path` is **null** while the waveform sibling has not landed —
  correct audio never waits on a picture, so the timeline keeps drawing the raw
  waveform until it fills in.
- **A failed signature is not retried** on unrelated project changes; editing
  the chain (a new signature) or an explicit `audio_fx_reverify { layer_id }`
  is what asks again. Reverify is also the eviction recovery path: a tile fetch
  that reads `not_ready` for an `fx:` key drops to the raw waveform and asks the
  baker to re-probe the disk, cooldown-gated per key.
- **Export refuses rather than falling back.** A layer that will never bake
  fails the export with the effect, the layer and the message named; a failure
  belonging to the chain as a whole (a missing conform, an ffmpeg refusal of the
  composed graph) says so instead of blaming an arbitrary card.

### The card and the region gesture

An Audio layer's Effects panel renders the audio catalog
(`panels/EffectPanel.tsx` picks which catalog by layer kind), with no stopwatch
on any row — `audio.*` params are static only. `properties/AudioRegionRow.tsx`
shows the two bounds as source seconds, the arm button, and the one status line
(needs a region / too short / outside the clip's source span / processing /
failed).

*Select region* arms a one-shot mode scoped to `(layerId, effectId)`
(`timeline/audioRegionArmStore.ts`); the next drag on that clip paints the
region and commits both bounds as one `update_layer_param_tracks`, then
disarms — Escape and a press outside the clip disarm too. The band and its two
edge handles (`timeline/AudioRegionBand.tsx`, arithmetic in
`timeline/audioRegionGeometry.ts`, gestures in
`timeline/hooks/useAudioRegionDrag.ts`) are drawn only while the owning card is
mounted and expanded, which `state/audioRegionFocusStore.ts` decides. Nothing
is frame-snapped: audio authors on samples.

## Export mixer

`lower(project, target, window)` no longer produces an ffmpeg filter
graph; it produces a **MixPlan**: per audible layer, the conform path
+ channel count, source span, timeline placement, and the two
envelopes (or scalars). The plan applies the same layer skip rules as
the preview (see above) — the `Track.enabled` whole-track gate, the
role mute/solo gates, and `Layer.enabled`/`AudioParams.mute` all take
effect in export, and each role's gain is folded into its layers'
envelopes. Layers whose conform is missing fail readiness before any
work starts.

A layer's conform path is not always its media's: `plan_for_project` takes an
optional **per-layer override table**, keyed by layer id, which main fills from
the audio-effect baker (see § Clip effects) — the baked effect-chain sibling
that layer's audio must come from. An override whose file has been evicted
falls back to the raw conform rather than failing the plan, because an entry
that outlives its file must not be able to break an export; keeping the *mix*
honest is the export gate's job, and it refuses instead of falling back.

The mixer (`export::mix`) is a block-pull loop, deterministic and
allocation-flat:

```
for each output block (65 536 frames, 48 kHz f32 stereo):
    zero the accumulator
    for each layer overlapping the block:
        map block window → source frames (t_start, src_in, clamped to src span)
        read frames from the conform file (seek = header + frame × ch × 4)
        gain = lerp(envelope) per sample
        pan  = lerp(pan_coeffs) per sample → 2×2 matrix (the shared leaf law)
        sum into the accumulator
    write the block, interleaved, to ffmpeg stdin
```

The frame grid derives from the export window with exact rational
math (the same discipline as the video `frameGrid`), so audio length
matches the video range to the sample.

ffmpeg's remaining role is the encode tail:

```
ffmpeg -f f32le -ar 48000 -ac 2 -i - \
       -af aresample={target_sr},alimiter=limit=0.891:level=false \
       -c:a {aac|libopus} -b:a {bps}  <temp audio file>
```

- `alimiter` (−1 dB ceiling) is **always on in this slice** (no user
  toggle yet; an export-settings switch can come later) — it is the
  answer to "two 0 dB layers sum past full scale". `level=false` is
  explicit because alimiter's auto-normalize default is a known trap.
  This is a sample-peak ceiling; true-peak oversampling is future
  work.
- The limiter only acts above its ceiling; material below −1 dB
  passes unchanged, and the existing Goertzel conformance gates
  (dominant frequency, SNR, alignment) are level-shift-insensitive
  either way.
- Everything downstream — temp-file naming, `mux_to_file`, the
  no-audio-layers short-circuit, the `include=false` skip — is
  unchanged from [`export.md`](export.md).

The audio IR (`DecodeA/Adelay/Amix/OutA` and the lavfi emitter) is
retired by this design; the mixer plan is its replacement.

## Readiness and errors

- **Export:** conform readiness joins the existing media-readiness
  gate; the export auto-wait ("preparing") panel covers conform jobs
  exactly as it covers proxies. The wait set comes from Rust
  (`ensure_export_audio_conform`, sharing the mix plan's audible-layer
  walk and validating the cache file itself), and completion is tracked
  by `media:job_complete kind=conform` events — the store's
  `conform_path` can't carry this wait because a stale path reads
  identically before and after a re-conform. A conform job that
  *failed* (unreadable audio) fails the export loudly with the media
  named — never a silent layer drop.
- **Export, effect chains:** the conform gate is followed by the
  audio-effect gate (`runAudioFxGate` over `ensure_export_audio_fx`),
  which flushes the bake debounce, waits on `audio_fx:status` for the
  layers it names, and fails the export with the **effect, the layer and
  the message** for anything that will never land — never a fall back to
  the unprocessed audio. See § Clip effects.
- **Preview:** a layer without conform (job still running, or failed)
  is silent and logs once to the status log. Range-read failures
  retry; a chunk that misses its deadline mutes briefly rather than
  glitching (underrun behavior). A layer whose *bake* is pending or
  failed is not silent — it keeps playing the last ready artifact, or
  the raw conform if there has never been one.

## MCP surface

With this design, `gain_db`, `pan`, `fade_in_us`, and `fade_out_us`
take real effect in both preview and export. The MCP tool
descriptions must say so — the previous state (accepted but ignored)
was a silent-no-op trap for agents, and updating the contract text is
part of the same change that makes the fields live. The master meter
is additionally exposed as an MCP resource for agent-side level
checks.

Clip effects ride the four existing effect tools — `add_effect` /
`update_effect` / `move_effect` / `remove_effect` — with `audio.denoise` as the
one audio `kind`; the two rules the audio namespace adds are refusals, not new
tools (`EffectKindNotApplicable` for a kind on the wrong layer kind,
`AudioEffectParamStatic` for a keyframe attempt on an `audio.*` param), and
each message names the rule because the client drops structured error data. See
[`mcp.md`](mcp.md). Bake status is deliberately not on the MCP surface: an
agent that needs the processed audio exports, and the export gate does the
waiting.

## Testing

- **Cross-language goldens:** the envelope sampler fixture (gain control
  points + pan values + pan coefficient envelope) and the pan-law fixture
  (`pan_coeffs` mono + stereo branches + apply rows), each asserted by both
  the Rust and TS suites against one checked-in fixture — also the
  native↔wasm `libm` trig determinism proof.
- **Preview pan graph:** an `OfflineAudioContext` render test
  (`e2e/electron/audio-pan-preview.spec.ts`) drives the real
  `buildPanGraph` + `panCurves` and checks output L/R against the
  equal-power law — covering the matrix-mixer wiring the math goldens
  cannot reach.
- **Mixer unit tests:** pure f32-in/f32-out — placement, trim
  clamping, overlap summing, envelope application, block-boundary
  continuity.
- **Clip effects** are covered in three layers, each answering a different
  question:
  - **Rust, real ffmpeg** (`native/src/audio/fx.rs`, skipped where no ffmpeg is
    installed, in `jobs/conform.rs`'s style) — does the DSP work? Bake output
    frame count equals input; the RMS primitive against a known-level fixture;
    peaks over a VCONF input; and a *profile engages* fixture whose noise-only
    region sits at the END, asserting that the stretch before it improves as
    much as the stretch after it and that the same graph **without** the concat
    pre-roll does not — the test that documents why the pre-roll exists.
  - **Vitest** (`shared/audioEffects/`, `main/audioFx/`,
    `main/state/mutations/effects`, the renderer stores, rows and geometry) —
    is the right graph built, named and orchestrated? The canonical string and
    signature (order, the enabled and completeness filters, id exclusion,
    quantization, a version bump changing the signature); the baker's state
    machine (debounce, supersede and cancel, attaching to a shared signature,
    waiting on a pending conform, a failure keeping the last ready artifact);
    the namespace and static-only refusals; waveform-key resolution; the arm
    store's lifecycle and the band's px↔µs mapping including offscreen. The
    emitted graph is additionally **smoke-run through the bundled ffmpeg** over
    a fraction-of-a-second fixture (`main/audioFx/graph.ffmpeg.test.ts`), the
    repo rule for anything that emits an ffmpeg graph.
  - **End to end** — is it what you hear? Because preview and export read the
    same baked file, an audio-only export of a noisy fixture with and without
    the effect, compared by the conformance analyzer's windowed RMS over the
    noise-only span, is evidence for both paths at once; the Rust fixture above
    stays the precise DSP gate, so this one proves the plumbing.
- **Conformance E2E** (extends [`conformance.md`](conformance.md)):
  the deterministic mixer upgrades audio assertions from perceptual
  to analytic. New fixtures: a keyframed gain ramp (per-window RMS
  against the analytic envelope), fade-in/out, two-layer overlap
  (summing + limiter engagement), and pan (L/R energy ratio). The
  existing Goertzel tone/alignment suite continues to pass unchanged.

## Out of scope here, designed elsewhere or later

- **Retime / speed** — needs A/V group-coupling semantics first;
  component direction is signalsmith-stretch (same MIT algorithm
  available as Rust crate and AudioWorklet).
- **Per-role DSP effects** — the `RoleMixSettings.effects` insert that
  would make each role a true processing bus; v1 folds role gain only.
- **Clip-effect extensions** (§ Clip effects ships the chain and one kind):
  auto-detecting the sample region by scanning for the quietest span;
  auditioning the removed noise rather than the result; a speech denoiser on
  `arnndn`, whose model would arrive through the app-managed content catalog;
  a conform format carrying a start frame, which is what a span-limited bake
  would need; dragging the region band's body to relocate it instead of
  re-arming; keyframed audio params, which `afftdn`'s runtime-commandable
  `nr` / `nf` would reach through `asendcmd`; and a clip badge for bake state.
- **True-peak (oversampled) limiting**, loudness-normalize export
  option, >stereo output, scrub audio.
