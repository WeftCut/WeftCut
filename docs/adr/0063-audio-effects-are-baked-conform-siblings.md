---
status: accepted
---

# Audio effects are baked conform siblings, named by the chain that produced them

An audio effect is not a realtime insert. A layer's `audio.*` effect chain is
rendered **once**, offline, by ffmpeg, from the media's conform PCM into a
**sibling conform file** whose name is a hash of the chain that produced it —
and both the preview mixer and the export mixer read that sibling instead of
the raw conform. Visual effects stay what [ADR 0027](0027-per-layer-effects-pixi-filter-chains.md)
made them: Pixi filters evaluated per frame.

## Context

Two forces point away from treating audio like the visual chain.

- **The economics are inverted.** A GPU filter has to run inside a frame
  budget, so it is realtime by necessity. An ffmpeg audio filter graph over
  48 kHz f32 runs at roughly 300× realtime — ten minutes of stereo in about
  two seconds — so rendering the whole clip up front is cheaper than
  engineering a realtime insert, and it removes the question of what happens
  when a filter cannot keep up.
- **The conform *is* the working format.** Every audio consumer already reads
  `Cache/audio/{hash}.conform`: the preview mixer Range-reads it over
  `weftcut-media://` and never decodes, and the Rust export mixer seeks into it
  by frame ([ADR 0019](0019-audio-mixes-in-rust-over-conform-pcm.md)). A
  processed file with the same header, rate, channel count and frame count is
  therefore consumable by both, unchanged — no reader, no plan and no scheduler
  learns a new shape.

Two facts about the surroundings settle the rest. Project state is TS-owned and
Rust is a stateless compute service, so the older argument for a typed
`AudioParams.effects` map on the Rust side no longer applies — `Layer.effects`
is already carried on every layer, with add/update/move/remove, undo, MCP tools
and param paths built. And the conform export gate taught that a persisted
artifact path outlives the file it names, so nothing about a derived audio
artifact may be written into the project.

## Decision

- **The chain lives in `Layer.effects`, under the `audio.*` namespace.** Same
  `Effect { id, kind, enabled, params }` record as a visual effect, different
  lifecycle. The v1 kind is `audio.denoise` — ffmpeg `afftdn` driven by a
  user-sampled noise profile. `applyAddEffect` enforces the one ownership rule:
  an `audio.*` kind lands on an Audio layer and only on an Audio layer, and a
  visual kind never lands on one (`EffectKindNotApplicable`). Unknown non-audio
  kinds stay permissive, as ADR 0027 left them.
- **The effective chain is what gets rendered:** the enabled, catalogued,
  *complete* audio effects in stored order. An **incomplete** effect — a
  denoise with no sample region, one shorter than the filter can learn a
  spectrum from, or one reaching past the media's duration — is dropped exactly
  as a disabled one is, and its card says what is missing. Nothing falls back to
  an untrained profile: a filter that quietly does something else is the worst
  outcome an audio edit can have.
- **The sample region is a noise-profile span, stored in source time**
  (`profile_in_us` / `profile_out_us`), and the effect applies to the whole
  clip. Source time is what keeps the bake a pure function of the material:
  move, trim, slip and split never invalidate it. "Process only this span" is
  already expressible by splitting the clip.
- **The bake is a pure function of `(media hash, conform format version,
  effective chain)`.** Those three are printed into one canonical string —
  params sorted by key, effect ids excluded, chain order preserved, only
  effective entries present, each kind carrying its own catalog `version` — and
  its sha256 is the chain signature. The first 16 hex characters name the
  artifacts: `Cache/audio/{media_hash}.fx-{sig16}.conform` and
  `Cache/waveforms/{media_hash}.fx-{sig16}.v4.peaks`. Two layers with the same
  media and the same effective chain therefore share one artifact, and an empty
  effective chain has no signature at all — that layer plays the raw conform.
- **The output is a conform, compatible byte for byte.** The bake reads the
  conform body raw (`-skip_initial_bytes`, `f32le`, the header's own rate and
  channel count) and writes the same header back, and a graph that changes the
  frame count **fails the bake** rather than landing a misaligned file. The 1:1
  sample alignment that failure protects is what lets `ConformReader` address
  the sibling at the raw conform's own frame offsets.
- **The catalog is TS; Rust exposes generic primitives.**
  `src/shared/audioEffects/` owns what an effect is, whether it is complete,
  what it needs measured, and the `filter_complex` stage it emits;
  `src/main/audioFx/` owns the digest and the cache-path predicates. Rust owns
  three stateless compute calls — `measure_conform_rms`, `bake_audio_fx` (with
  `cancel_audio_fx`) and `build_peaks_for_vconf` — and inspects neither the
  graph nor the signature. **The signature is computed only in TS**, so there is
  no cross-language twin to keep in step and no golden guard for one. Adding an
  effect is one catalog entry and its strings.
- **Bake state is derived, never persisted.** The baker holds one `LayerFxState`
  per layer — the desired signature, the ready artifact, the signature in
  flight, the last error — and disk existence is the truth; the renderer keeps a
  plain mirror of that map, and the waveform sibling's path stays null until it
  lands, because correct audio must not wait on a picture.
- **Preview is stale-while-revalidate; export gates and waits; failure never
  falls back silently.** A layer that already has a ready artifact keeps
  playing it while a new bake runs and after one fails. An empty chain returns
  the layer to the raw conform, and so does a layer that has never had a ready
  artifact — a first bake still pending, or a first bake that failed. The swap
  rides the mixer's existing micro-fade. Export flushes the bake debounce,
  waits for what is still coming, and turns anything that will never land into
  an export error naming the effect, the layer and the message.
- **Re-baking is automatic, debounced per layer, and cancellable.** One live
  bake per signature — the last layer to leave a signature is what cancels it —
  and a failed signature is not retried on unrelated project changes; a consumer
  asking for re-verification is the deliberate retry.
- **Audio effect params are static only.** Both effect-param write entries
  refuse a `Keyframed` track on an `audio.*` param
  (`AudioEffectParamStatic`) and the inspector shows no stopwatch. A whole-clip
  offline bake has no per-frame value to animate.
- **Effects run before clip gain, pan, fades and role gain.** The graph consumes
  the raw conform and mix-time parameters are unchanged, which is both
  Premiere's order and what keeps the bake pure — a gain or fade edit never
  re-bakes anything.
- **The region is drawn by a one-shot arm.** *Select region* on the card arms
  the next drag on that clip; release commits both bounds as one undo step and
  disarms. The band and its two edge handles are visible and adjustable only
  while the card that owns them is mounted and expanded, so visibility follows
  the card the user already has open and there is no new toggle. In/out marks
  were rejected: those are export state, and reusing them would cost an extra
  step every time.
- **Every time in a bake graph is counted in samples.** Trims are
  `start_sample` / `end_sample`, and any seconds a filter argument needs are
  derived from those counts. With second-valued bounds ffmpeg rounds each bound
  independently, so a region whose edges do not sit on the 48 kHz lattice makes
  the denoise stage's training pre-roll and the trim that removes it differ by
  one sample — and the length check above would then reject the bake.

## Considered options

- **A realtime audio insert (an AudioWorklet, or a filter in the mixer).**
  Rejected: it buys nothing the offline bake does not already give, costs a DSP
  implementation per effect on both sides of the dual-engine split, and
  reintroduces "what if it cannot keep up" for audio, where a dropout is not a
  dropped frame.
- **A typed `AudioParams.effects` map.** Rejected: `Layer.effects` already
  exists on every layer with the whole command, undo and MCP surface behind it,
  and state is TS-owned, so the typing argument that once favoured a separate
  map has no force left.
- **Bake only the union of the affected spans.** Rejected: it would need a
  conform format carrying a start frame plus a change in every reader, to save
  disk the cache LRU already budgets for material that regenerates at 300×
  realtime.
- **Apply the effect inside the sample region only.** Rejected: the region is a
  *profile* — with `afftdn`, sampling a noise profile against not sampling one
  is two quality tiers, not two extents — and a span-limited effect is what
  splitting the clip already expresses.
- **Persist the artifact path on the effect.** Rejected by the conform gate's
  own lesson: a stored path reads identically before and after the file behind
  it disappears.
- **A per-clip badge for bake status.** Rejected: per-effect state on a clip
  does not scale past one effect. The card is the status surface, and bakes
  reach the status bar's job counter through the ordinary job events.

## Consequences

- **Disk grows by one conform-sized file per distinct chain** — around 230 MB
  for ten minutes of stereo — and every debounced param edit mints a new
  signature. So `Cache/audio/` becomes the one partly-swept cache directory: the
  `.fx-*` siblings are LRU units under the shared budget while the canonical
  `{hash}.conform` beside them stays excluded, because a bake is one filter pass
  over already-decoded PCM and a conform is a full decode. Readers that
  short-circuit on a cache hit refresh the file's mtime, or the artifact being
  played would age out as the cache's oldest unit.
- **Preview and export read one file, so one measurement is evidence for
  both.** An analyzer pass over an exported mix proves what the preview mixer is
  playing too — there is no second signal path to verify.
- **Adding an audio effect is one TS catalog entry** plus its strings: a
  descriptor's `isComplete`, `measurements` and `buildStage`, and one line in
  the registry. No Rust, no IPC, no undo, no schema change.
- **A bake needs a measurement pass before its graph can be written.**
  `sample_noise` sets the noise profile's spectral *shape* only and never its
  level, so a loud floor left at the filter's default is a no-op; the denoise
  stage derives `nf` from the region's measured RMS plus the user's margin. That
  is why the bake contract carries a measurement-request list at all, and why
  digital silence — a level with no dB value — is a real answer a stage has to
  interpret rather than an error.
- **The timeline draws the processed waveform.** Waveform tiles are keyed by
  artifact rather than by media, an `fx:` key is immutable per artifact (so a
  new bake is simply new tiles, with no invalidation event), and a key the
  backend can no longer resolve degrades to the raw waveform and asks the baker
  to re-verify.
- **Two new refusals join the command vocabulary**, each naming the rule rather
  than only the violation, because the MCP client drops structured error data
  and both rules are unlike anything the visual effects enforce.
- **Deferred, and named so none arrives by drift:** auto-detecting the region by
  scanning for the lowest-RMS span; auditioning the removed noise (`om=noise` is
  one param away); `audio.denoise_speech` on `arnndn`, whose model would ship
  through the app-managed content catalog
  ([ADR 0061](0061-content-downloads-are-a-main-owned-resumable-queue.md)); a
  conform format carrying a start frame, for span-limited bakes; per-role bus
  effects — the `RoleMixSettings.effects` insert that would make each role a
  true processing bus; dragging the band body to relocate a region instead of
  re-arming; keyframed audio params, which `afftdn`'s runtime-commandable `nr` /
  `nf` would reach through `asendcmd`; and a clip badge for bake state.

## References

- [ADR 0019](0019-audio-mixes-in-rust-over-conform-pcm.md) — audio mixes in Rust
  over conform PCM (the conform format and both readers).
- [ADR 0023](0023-audio-mixes-by-role-not-track.md) — roles are the mix buses
  (where a per-role effect insert would live).
- [ADR 0027](0027-per-layer-effects-pixi-filter-chains.md) — per-layer effects as
  Pixi filter chains (the `Effect` record, and the permissiveness this narrows
  for one namespace).
- [ADR 0038](0038-rate-locks-audio-authors-on-samples-ndf-stays-honest.md) —
  audio authors on samples, which is why a region is not frame-snapped.
- [`audio.md`](../audio.md) § Clip effects (baked) — the pipeline, the paths and
  the seams.
- [`data-model.md`](../data-model.md), [`mcp.md`](../mcp.md),
  [`timeline-content-preview.md`](../timeline-content-preview.md).
