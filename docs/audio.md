# Audio

One model, two thin renderers. Per-layer trim, placement, `gain_db`, `pan`,
fades and mute are evaluated once into sampled envelopes; a Web Audio graph
plays them in preview and a Rust block mixer writes them at export. Both read
the same bytes — a **conform cache** of canonical PCM made once at import — so
neither path decodes audio and Chromium/ffmpeg decode differences never reach a
mix. Why: [ADR 0019](adr/0019-audio-mixes-in-rust-over-conform-pcm.md) (engine),
[0023](adr/0023-audio-mixes-by-role-not-track.md) (roles),
[0038](adr/0038-rate-locks-audio-authors-on-samples-ndf-stays-honest.md)
(sample lattice), [0063](adr/0063-audio-effects-are-baked-conform-siblings.md)
(baked effects).

## The authoring grid

Audio layer edges and audio automation sit on the **48 kHz sample lattice**,
`round(i × 1e6 / 48000)` (~20.83 µs); video layers stay on the frame grid. It
is the mixer's own lattice (`us_to_frame` in `audio/mix.rs`), so the stored
microsecond is the sample that plays. `composition.sample_rate` is only the
export target. `gridForLayerKind` (`renderer/grid.ts`, re-exported by
`main/state/snap.ts`) is the single choice for the commit validator, every
mutation snap and load repair; see [data-model.md](data-model.md).

- Drags snap to a visible quantum; sample precision comes from nudge commands
  (1 sample, 1 ms) and the inspector's timecode/ms/samples fields.
- A grouped A/V pair's sync offset is derived from the members' `t_start_us`
  (in sample indices), never stored. A group move shifts every member by the
  same delta; a video trim does not drag slipped audio.
- At 29.97 / 59.94 a frame boundary is not a sample boundary, so a paired
  audio layer sits up to ~10 µs from its video frame.

The 10 ms envelope grid below is how a rendered ramp is sampled, not where a
keyframe may sit.

## The conform cache

**Format:** 48 000 Hz, f32, interleaved, source channels capped at 2 (mono
stays mono; more than 2 downmix to stereo). 48 kHz makes video audio a decode
without resample; f32 is both consumers' working format; interleaving makes a
preview time window one contiguous Range read. There is no per-project audio
rate; the export target rate is applied once at encode.

```
magic        "VCONF\0\0\0"  (8 bytes)
version      u32            (CONFORM_FORMAT_VERSION)
sample_rate  u32            (48000)
channels     u32            (1 | 2)
frame_count  u64
data         interleaved f32 samples       offset = 28 + frame × channels × 4
```

A conform is reusable only with the current version, 48 kHz, 1–2 channels, a
nonzero frame count and an exact file length of `28 + frame_count × channels ×
4` (overflow-checked); a truncated body or trailing partial frame forces
regeneration.

**Producer:** `jobs/conform.rs`, one ffmpeg run (`-vn -ac {1|2} -ar 48000 -f
f32le`) into `Cache/audio/{blake3}.conform` under native resource admission,
triggered at import; `ensure_conform` backfills older media and format-version
bumps. Valid cached conforms restore without waiting for proxies. Cost: ~1.4 GB
per stereo source-hour (half for mono).

**Waveforms:** `jobs/waveform.rs` writes V4 `.peaks` (min/max/RMS, 22 050 Hz,
finest window 22 frames, each coarser level doubling it). For 48 kHz
mono/stereo sources it reuses the conform's PCM; other sources decode the
original directly. Generation streams through temporary files so memory does
not grow with duration. A cached waveform never waits for conform.

**Effect siblings:** an effect chain adds `{hash}.fx-{sig16}.conform` and
`waveforms/{hash}.fx-{sig16}.v4.peaks` (§ Clip effects). `cache/disk_lru.rs`
sweeps the `.fx-*` conforms as LRU units under the shared budget; the canonical
conform is never swept (a bake is one cheap filter pass, a conform a full
decode). mtime is the LRU clock, so a reader that hits the cache refreshes it.

## The envelope contract

For each audio layer, the shared `weftcut-eval` leaf (native in Rust, wasm in
the renderer; [ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md)) yields:

```
gain = lerp-sample(gain_db, 10 ms) → 10^(dB/20) × fade-in ramp × fade-out ramp
pan  = lerp-sample(pan, 10 ms), clamped [-1, 1] → pan_coeffs → 2×2 matrix [a,b,c,d]
```

Both renderers linearly interpolate the same control points: Web Audio via
`setValueCurveAtTime` (gain node and the four pan-matrix gains), Rust per
sample. Static properties travel as scalars. A `Hold` keyframe becomes a
≤10 ms ramp. `db_to_linear`, `fade_multiplier`, `pan_coeffs` (equal-power) and
`role_audible` are single-sourced in the leaf; the 10 ms sampling loop is
parallel Rust/TS code guarded by `audioEnvelopeGolden.fixture.json` and
`panLawGolden.fixture.json`.

## Preview mixer

`renderer/render/audio/`, one shared `AudioContext`:

```
per layer:  AudioBufferSourceNode (1 s chunk)
              → GainNode       (gain envelope, role gain folded in)
              → ChannelSplitter → 4×GainNode → ChannelMerger   (pan matrix; mono uses 2)
              → trim GainNode  (micro-fades)
              → roleBusInput(role)
role bus:   GainNode (UNITY, always) → master input
              ↘ AnalyserNode (leaf: the role meter)
master:     input → AnalyserNode → DynamicsCompressor (−1 dB, 20:1, 1 ms attack) → destination
```

**Role buses are meter taps, not processing buses.** Role gain is applied only
by folding it onto each member layer's envelope in `AudioMixer.deriveFromView`;
writing it at the bus too would apply it twice (a −6 dB trim would sound at
−12 dB). `AudioGraph.test.ts` holds every bus at unity and `AudioMixer.test.ts`
asserts the fold. A gated role's layers are skipped, not zeroed, so its meter
reads true silence with no special case. `AudioMixer.updateView` re-points
`trim` when a layer's role changes.

**Feeding:** chunks are Range-read from the conform over `weftcut-media://`
(loop-read to the exact byte count) and de-interleaved into `AudioBuffer`s; no
renderer decode. 1 s chunks, 3 s lookahead, at most 8 live chunks and 8 cached
buffers per mixer (`chunkSchedule.ts`); mixers outside lookahead are released.
A chunk whose start is already past starts now with a compensating offset.

**Clock:** the audio hardware clock is master. One `ClockAnchor`
(composition µs ↔ `AudioContext.currentTime`, defined in `chunkSchedule.ts`)
drives both the playhead (derived, never accumulated) and chunk scheduling, so
there is no reconciler. `SyntheticClock` (`render/clock.ts`) interpolates
visual ticks from `getOutputTimestamp()`, falling back to latency estimates or
`currentTime` when the stamp is missing or older than 250 ms. Audio scheduling
uses raw time; the displayed Moment is frame-snapped.

**Transport ownership:** `PreviewAudioEngine` owns transport state, clock,
graph, mixers and PCM preparation; the editor session creates it
(`previewAudioSession.ts`) and disposes it at session end. Preview panels only
attach presentation, so transport, meters and edits work with Preview closed.
`Compositor` and `CompositionNode` do not own audio. A 16 ms timer refills the
3 s schedule independently of Pixi/rAF, still on the renderer JS thread — a
blocked UI thread can delay commands and refill, though Web Audio keeps playing
what was submitted. Upcoming Audio layers, including inside Groups, come from
`forEachLayer`; video readiness never gates audio start.

**States:** paused, preparing, playing, error, plus requested intent (a second
gesture cancels preparation). Play resumes the context, prepares PCM for the
first 100 ms, then releases the anchor 10 ms ahead. A missing conform keeps the
transport preparing; a 10 s deadline (300 s while retimed stems prepare) or a
read/device failure is an error; Play retries. `playing` means submitted
against a running context, not audible at the speaker.

**Edits and cancellation:** project snapshots, bake state and Role gain
overrides notify the engine directly; a changed layer is rescheduled, an
unchanged one keeps its mixer. Pause stops sources synchronously. Seek, pause,
project replacement and disposal invalidate the request generation so late
completions cannot revive old audio; completed PCM stays cached across pause. A
monitor-only edit preview does not move the clock.

## Layer skip rules

Preview and export share rules 1–6:

1. `Track.enabled == false` (track `muted`/`solo` do not gate audio).
2. The layer's role is muted.
3. A role solo set exists and the layer's role is not in it.
4. Mute wins over solo.
5. `Layer.enabled == false`.
6. `AudioParams.mute == true`.
7. `Layer.locked == true` — **export only**; preview still plays locked layers.

Rules 2–4 run the shared `role_audible` leaf (export `audible_audio_layers`,
preview `roleGate.ts`), guarded by `roleGateGolden.fixture.json`; the
layer-selection loop around it is parallel code on each side.

## Meters

Master and per-role readings (RMS + peak) are combined-channel.
`state/masterMeterStore.ts` is the single renderer publication seam and owns
the silence floor (`SILENCE_DB`, shown as "−∞"). The session's fast tap
publishes master (`publishMasterMeter`) and roles (`publishRoleMeters`)
together, only while a reader holds `acquireRoleMeterDemand` and the transport
plays, and publishes one silent sample on stop. Separately, `reportAudioMeter`
samples `AudioGraph.meterSnapshot` every 500 ms for the MCP
`composition://meter` resource (master only). Selectors are scalar
(`useRoleRmsDb`): a selector returning a fresh object re-renders forever.
`peakHoldDb` is an infinite master peak hold, cleared only by
`resetMasterPeakHold` or a cleared preview.

## Roles

A role is a per-layer tag on `AudioParams` — Dialogue (default), Music, SFX,
Voiceover — and each role is a mix bus with project-level `RoleMixSettings {
gain_db, muted, solo }` in `Project.audio_roles` (absent ⇒ unity). The bus is
realized by folding role gain into member envelopes and filtering by mute/solo;
neither engine has a per-role summing stage.

Control levels: clip `Layer.enabled` (the inspector's audio-clip toggle; the
v1 → v2 migration turned muted audio clips into disabled ones), role
mute/solo/gain, and track `enabled` (picture and audio). Role gain
(`set_role_gain`) is recorded; role mute/solo (`update_role_flags`) are
unrecorded so undo never flips them.

**Role Mixer Panel** (`panels/MixerPanel.tsx`, exported as `RoleMixerPanel`) is
the only per-role control surface; layer gain/pan/fades stay in the inspector.
It renders a one-column card list below `UI_METRICS.mixerConsoleMinWidth`
(392 baseline px × UI scale, `settings/uiMetrics.ts`) and a vertical-fader
console with a master strip at or above it. Both use one gesture, `useRoleGain`:
dragging auditions live through a renderer-local override
(`auditionedRoleGainLinear`), release records one `set_role_gain`, Escape
restores. A role silenced by another's solo dims off the same `roleAudible`
predicate the audio pass uses. The Panel holds the meter lease only while
visible.

## Clip effects (baked)

An Audio layer's `audio.*` effects (in `Layer.effects`) are rendered once by
ffmpeg from the media conform into a sibling conform that both mixers read. The
only kind is `audio.denoise` (`afftdn` with a user-sampled noise profile). The
command layer refuses an `audio.*` kind on a non-Audio layer and a visual kind
on an Audio layer (`EffectKindNotApplicable`), and refuses keyframes on audio
params (`AudioEffectParamStatic`).

The **effective chain** is the enabled, catalogued, complete audio effects in
stored order; an incomplete one is dropped like a disabled one and its card says
what is missing. A denoise is complete when both region bounds are set, the span
is ≥ 250 ms, and it lies inside the media's duration. Region bounds are source
time, so move, trim, slip and split never invalidate a bake.

### Pipeline

`main/audioFx/baker.ts` is the orchestrator and sole holder of bake state:

```
actor change ──► desired = effectiveChain(layer) → signature
      ▼  per layer, 400 ms debounce (re-armed only by a changed desire)
   ready under this signature and file present  ⇒ done (touch mtime)
   raw conform missing                          ⇒ ensure_conform, wait
   sibling already on disk with a valid header  ⇒ ready (build peaks)
   another layer baking this signature          ⇒ attach
   otherwise: cancel the bake this layer leaves (if unshared),
              measure_conform_rms → buildFilterComplex → bake_audio_fx
              → build_peaks_for_vconf → publish ready
   on failure: publish failed, keep the previous ready artifact
```

Bakes take an interactive permit through native resource admission inside
`audio/fx.rs`, emit `media:job_*` with `kind: "audio_fx"`, and on cancel reap
ffmpeg via `kill_on_drop` and discard the temp. Rust's three primitives
(`native/src/audio/fx.rs`, spawned by `jobs/mod.rs::spawn_audio_fx`) know
nothing about effects.

### Signature and paths

`shared/audioEffects/` holds the catalog (`catalog.ts`, `denoise.ts`), graph
composer (`graph.ts`), conform-format twins (`conform.ts`), canonical string
(`signature.ts`) and status vocabulary (`status.ts`). Only main hashes
(`main/audioFx/signature.ts`).

```
v1|{media_hash}|{CONFORM_FORMAT_VERSION}|{kind}@{version}{k=v,…};{kind}@{version}{…}
```

Params sorted by key and printed to six decimals; effect ids excluded; chain
order kept; only effective entries. `sig16` = first 16 hex chars of the sha256.
The path layout is stated twice — `cache/mod.rs` (`audio_fx_conform`,
`waveform_fx`) and `main/audioFx/fxPaths.ts`, which also owns the readiness
predicates.

**Denoise graph:** the region is prepended to the clip, `asendcmd` toggles
`sample_noise` over that copy, and a trailing `atrim` removes it — `afftdn` is
streaming, so without the pre-roll audio before the region is processed
untrained (measured 3.7 dB reduction vs 9.3 dB). Both trims count samples, not
seconds (second-valued bounds can differ by one sample and fail the frame-count
check). `nf = clamp(round(region_rms_dbfs + margin), -80, -20)`, because
`sample_noise` sets the profile's shape, never its level.

### Seams

- **Preview:** `previewAudioSession.ts` resolves each layer to its ready baked
  path, else the raw `conform_path`; `PreviewAudioEngine.refresh` recreates the
  mixer when the URL changes (the swap rides the 5 ms micro-fade). A
  temporarily unresolved URL keeps the previous artifact if the media is
  unchanged.
- **Export:** `render/exportReadiness.ts`'s `runAudioFxGate` runs after the
  conform gate (`ensure_export_audio_fx`, then wait, cancellable). Main injects
  `layerAudioSources` (`state/export-project-forward.ts`) and `plan_for_project`
  uses each as that layer's conform when the file exists. Only layers whose
  desired signature is on disk are named. Group members are always included in
  the wait (their times are Group-local).
- **Waveform:** a tile's `waveformKey` is the media id or
  `fx:{media_hash}.fx-{sig16}`; `TimelineVisualPreview.tsx` picks the fx key
  when ready, `WaveformTileProducer.ts` keys tiles by it, and
  `state/single-media-forward.ts` resolves it to a path. A new bake is new
  tiles; no invalidation event.

### Status

The baker publishes one `LayerFxState { desired_sig, ready, pending, error }`
per layer on `audio_fx:status` (full state per push), answers
`audio_fx_snapshot`, and `state/audioFxStore.ts` mirrors it. Nothing is
persisted. Status: no desired signature ⇒ none; `ready.sig` = desired ⇒ ready;
error ⇒ failed; else pending (ready wins over a stale error).

- Preview is stale-while-revalidate: a ready artifact keeps playing through a
  new bake or failure; with no ready artifact the raw conform plays.
- `ready.peaks_path` stays null until the waveform sibling lands.
- A failed signature is not retried on unrelated changes; a chain edit or
  `audio_fx_reverify { layer_id }` asks again. A tile fetch that reads
  `not_ready` for an `fx:` key falls back to the raw waveform and reverifies
  (cooldown per key).
- Export refuses rather than falling back, naming effect, layer and message.

### Region gesture

`properties/AudioRegionRow.tsx` shows the bounds, the arm button and one status
line. *Select region* arms a one-shot mode for `(layerId, effectId)`
(`timeline/audioRegionArmStore.ts`); the next drag on that clip commits both
bounds as one `update_layer_param_tracks` and disarms (Escape or a press outside
also disarm). The band (`timeline/AudioRegionBand.tsx`) is drawn only while the
owning card is mounted and expanded (`state/audioRegionFocusStore.ts`). Nothing
is frame-snapped.

## Pauses read what plays

A pause detection's subject is the Audio layer that reaches the mixer: an
`Audio` layer itself, or for a `VideoClip` the linked Audio member sharing its
media, else the link's only Audio member, else none (an embedded track never
reaches a mixer). It reads the fx sibling's peaks when that layer's bake and
peaks are ready, the raw media's otherwise; main injects the resolved path, so
the detector and the waveform tiles choose in one place. A running bake falls
back to raw peaks rather than refusing. UI: [features.md](features.md#pauses).

## Retimed audio

When any Audio or Group (`CompositionRef`) layer has a rate ≠ 1 or a source
phase (`audio/retime.rs::needed`), both preview and export render the root
composition into **per-role stems** with `audio/retime.rs`, cached as
immutable `retime-*.vconf` files beside the conforms (identity: a digest of the
project and the effect-conform overrides). Each scope renders its source window
at the authored rate, applies clip gain/pan/fades, mixes by role, then passes
child role stems through the parent Group's rate/pitch policy. Every stage has a
fixed sample count (tails padded with silence). Pitch-preserving stages chain
`atempo` within [0.5, 2]; pitch-following stages use `asetrate` + `aresample`
with an `atempo` remainder. Role gain/mute/solo stay outside the stems
(`retime::stem_plan`, `PreviewAudioEngine.refresh`). Preview fetches stems via
`prepare_retimed_audio`; a failed preparation is an error, never playback at the
old rate.

## Export mixer

`audio::mix::plan_for_project(project, window, overrides)` builds a
**MixPlan**: per audible layer the conform path and channel count, source span,
placement and the two envelopes, after the skip rules and role-gain fold. A
missing conform fails readiness first. `overrides` (layer id → baked sibling)
falls back to the raw conform if the file was evicted; the export gate, not the
planner, keeps the mix honest.

```
for each block (MIX_BLOCK_FRAMES = 65 536, 48 kHz f32 stereo):
    zero the accumulator
    for each layer overlapping the block:
        map block → source frames; read from conform (seek = 28 + frame × ch × 4)
        apply lerped gain and pan_coeffs per sample; sum
    write the block to ffmpeg stdin
```

Frame bounds derive from the export window with exact rational math, so audio
length matches the video range to the sample. Encode tail
(`export/mod.rs`):

```
ffmpeg -f f32le -ar 48000 -ac 2 -i - -af alimiter=limit=0.891:level=0 \
       -ar {target_sr} -ac {target_ch} {codec args} <temp audio file>
```

The limiter is always on: a −1 dB sample-peak ceiling (not true-peak) for
overlapping layers summing past full scale; `level=0` because alimiter's
auto-normalize defaults on. Muxing and the no-audio short-circuit are in
[export.md](export.md).

## Readiness and errors

- **Export, conform:** the wait set comes from Rust
  (`ensure_export_audio_conform`, same audible-layer walk as the plan) and
  completes on `media:job_complete kind=conform` — the stored `conform_path`
  cannot signal this, since a stale path looks the same before and after a
  re-conform. A failed conform fails the export naming the media, never a
  silent drop.
- **Export, effects:** the audio-effect gate follows (§ Seams).
- **Preview:** see § States; a pending or failed bake never silences a layer.

## MCP surface

`gain_db`, `pan`, `fade_in_us` and `fade_out_us` are live in both paths and
the tool descriptions say so. The master meter is the `composition://meter`
resource. Clip effects use the four effect tools with `audio.denoise`; both
audio refusals name the rule in the message because the client drops
structured error data. Bake status is not on MCP: an agent that needs processed
audio exports, and the export gate waits. See [mcp.md](mcp.md).

## Testing

- Cross-language goldens: envelope (`audioEnvelopeGolden.fixture.json`), pan
  law (`panLawGolden.fixture.json`), role gate (`roleGateGolden.fixture.json`) —
  also the native↔wasm `libm` determinism proof.
- `e2e/electron/audio-pan-preview.spec.ts` renders the real pan graph in an
  `OfflineAudioContext` against the equal-power law.
- Clip effects: Rust tests with real ffmpeg in `native/src/audio/fx.rs`
  (frame count preserved, RMS, peaks, and a fixture proving the concat pre-roll
  is needed); `main/audioFx/graph.ffmpeg.test.ts` smoke-runs the emitted graph
  through bundled ffmpeg; `e2e/electron/audio-denoise.spec.ts` compares exported
  noise-span RMS with and without the effect.
- `e2e/electron/audio.spec.ts` asserts exports analytically (fade and gain RMS
  envelopes, summing and limiter ceiling, pan L/R energy ratio); the Goertzel
  suite in [conformance.md](conformance.md) is level-insensitive.
