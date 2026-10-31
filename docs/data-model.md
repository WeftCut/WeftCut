# Data Model

The project state is the single source of truth, owned by the single-writer
actor in the Electron **main** process (`apps/desktop/src/main/state/`). The
types live in `state/model.ts` plus `src/shared/` (`keyframe.ts`,
`position.ts`, `timeMapping.ts`, `decode-route.ts`); the Rust serde twin in
`native/src/state/` holds no resident copy — it deserializes the slice it is
handed per compute call (audio export, `project://compiled`, single-media
reads). UI, MCP and persistence are all clients of the actor. This doc holds
what the types do not say: units, grids, invariants, cross-field rules and
persistence rules.

## Time

### Integer microseconds

All times are integer µs (`TimeUs`). f64 seconds appear only at API
surfaces. Never round-trip a time through `f64 / 1e6` and back inside the model.

### Timeline-field alignment: composition frame

Visual layer `t_start_us` / `t_end_us`, every `composition.duration_us` and
marker `t_us` / `end_t_us` sit on the composition frame grid
`round(i × 1e6 × den / num)`. **Audio layer endpoints sit on the fixed 48 kHz
mix lattice** `round(i × 1e6 / 48000)`, which is the mixer's own sample index,
so nothing rounds where authoring meets render. The rate is a constant, not
`composition.sample_rate`; that field is only the export target.

One function, `gridForLayerKind(kind, fps)` (`state/snap.ts`), picks the
lattice for all three enforcement sites: the validator, every mutation snap
(including `move`'s link fan-out), and the load repair. A kind-blind fan-out or
repair would silently drag a slipped audio member back onto a video frame.

A frame boundary is a sample boundary at 24/25/30/50/60/23.976 fps. At 29.97 and
59.94 (1601.6 / 800.8 samples per frame) a paired audio layer sits on the
nearest sample boundary, up to ~10 µs from the video frame. That is where the
mixer would play it anyway. `composition.duration_us` stays a frame count: the
autofit rounds the high-water mark **up** to the enclosing frame.

Mutators snap-round (half-up) every time parameter against the grid, so all
callers get aligned state. Source-time fields (`src_in_us` / `src_out_us`) are
in the source's own time and are **not** snapped. Audio automation (`gain_db`,
`pan`) quantizes on the sample lattice at write time.

Outside the boundary rule:

- `transition.duration_us` / `extended_us` are *distances* between canonical
  boundaries. What is enforced is `overlap == duration_us` and
  `0 ≤ extended_us ≤ duration_us`; canonical endpoints then make both whole
  frame counts. A transition duration is measured from the cut (backward for
  placement overlap, forward for an extend's borrowed tail, ADR 0048) — a
  duration derived from the rate alone cannot stay on grid at 29.97 / 23.976.
- Keyframe `t_us` is snapped on write but **not enforced**: trim and split
  rebase keys by a delta, and re-snapping would dedupe-merge two keys that
  landed on one frame.

Requests below half a frame are rejected, not rounded down: a transition and a
region marker each span at least one frame. A marker dropped mid-frame moves up
to half a frame.

**Structural, not per-mutation.** The commit validator rejects any off-grid
endpoint, duration or marker time (`OffGridLayerBoundary` / `OffGridTime`, with
`snap_to`, and `grid` naming the lattice), so a mutator that forgets to snap
fails loudly.

**Origin.** A layer may not start before 0 (`NegativeLayerStart`, separate from
the grid rules because a negative time is usually canonical). A move toward the
origin clamps the shared delta, so a link stops as a set.

**Repair on load, not reject.** `parseProject`'s normalize pass snaps every
grid-bound field, re-derives transition durations from the repaired geometry,
lifts a layer straddling zero (its visible span kept) and parks a layer lying
entirely before zero after everything else on its track (lifting it would
manufacture an overlap). The pass is idempotent. Its report reaches the status
log after the workspace commit, because that commit rotates the per-workspace
LogBus.

Changing `composition.fps` re-snaps every layer and marker in the same
transaction (see the fps lock under Validation).

### Timecode

Timecode is SMPTE `HH:MM:SS:FF`, non-drop-frame at every fps, starting at zero
with no persisted offset. At 23.976 / 29.97 / 59.94 an NDF hour is 3603.6 s of
wall clock. Where a **duration** is displayed at a fractional rate (export range,
composition duration in Settings), the wall-clock figure is shown beside it.
Drop-frame is **declined**: it only relabels, and its consumers are interchange
formats WeftCut does not write. If interchange is built, DF and a non-zero start
timecode share one migration and one insertion point (`formatTimecode` /
`parseTimecode` in `renderer/frames.ts`).

### Boundary semantics

Every boundary (`t_start_us`, `t_end_us`, `duration_us`, trim handles) is
exclusive and may equal `duration_us`. The **playhead** is a frame anchor: it
shows the frame *starting* at `t` and is clamped to
`[0, lastFrameAnchorUs]` = `max(0, duration_us − frameDur)`, so End in a 10 s
30 fps comp lands on `00:00:09:29`. Tools that show an exclusive end show the
last frame it *keeps*. The one-frame gap is bridged only by helpers in
`renderer/frames.ts`, never by a bare `±1` in UI code:

| Surface | Rule | Helper |
| --- | --- | --- |
| Playhead / monitor display | frame starting at `t` | `displayedFrameStartUs` |
| Playhead upper bound, End, auto-pause park | start of last frame | `lastFrameAnchorUs` via `clampSeekUs` |
| In point, range start, paste-at-playhead | store the playhead value | — |
| Out point / range end from the playhead | the displayed frame's exclusive end | `inclusiveOutBoundaryUs` |
| Trim-drag monitor preview | out side: last kept frame; in side: first | `boundaryDisplayFrameUs` |
| Edit-point navigation (`↑`/`↓`) | park on the cut (incoming frame) | `seekToPrevEdit` / `seekToNextEdit` |
| Attribute panel End | the exclusive boundary, so Start + Duration = End | as stored |

Render/export interval math may subtract 1 µs from a half-open `endUs`; that is
µs arithmetic, not frame translation. Only the time ruler seeks; clicks in the
track body select and never move the playhead.

## Identity

Every entity id is a UUIDv7 (`state/ids.ts`). Never use array indices for
identity: they shift on insert and break agent-held references. Layer and marker
ids are unique **project-wide**, across compositions.

## Project

`compositions` is keyed by `Composition.id`; `compositions[root_id]` is what
export renders. A Group is another entry, referenced by a `CompositionRef` layer.
There is no sub-composition type: every walk, mutation and validator has one path
over one shape (ADR 0052). `compositions` and `root_id` have no serde default — a
file without them is not a project. Rust keeps an `OrdMap` for deterministic
serialization; TS keeps a plain object in insertion order.

`next_group_ordinal` is monotonic (see Composition).

`audio_roles` is sparse: an absent role resolves to unity (0 dB, unmuted,
unsoloed) via `Project::role_mix`. The mixing model is in
[audio.md](audio.md) and [ADR 0023](adr/0023-audio-mixes-by-role-not-track.md).

`settings` (`ProjectSettings`): `shot_review` / `pause_review` are `null` for
"detector defaults" so no threshold literal lives in TS; `2 · pad_us <
min_pause_us` holds by validation. `preview_width/height`,
`autosave_interval_secs` and `history_capacity` are wire-only: nothing reads
them.

## Composition

The root and every Group share one struct and therefore every
per-composition rule: duration autofit, track cleanup, overlap classes, the
reserved A/B skeleton, transitions between same-track layers, links between
same-composition layers. A new Group copies its parent's settings and starts
with the skeleton.

**Single lattice.** Every composition's `fps`, `sample_rate` and `channels`
equal the root's (`CompositionLatticeMismatch`): a Group on another rate would
be time remapping under another name. `set_composition` cascades those three to
every composition whichever is named; `width` / `height` / `color_space` /
`background` / `duration_us` apply to the named composition only.

`fps` is rational: `30000/1001 ≠ 29.97`.

**Group numbering is stored.** An unlabelled Group shows as `Group N`, `N` =
its `ordinal`, taken from `Project.next_group_ordinal` at creation and never
rewritten. The counter never reuses a number (delete Group 3, create one → 1, 2,
4): numbering off the live list would renumber Groups, and reuse would let undo
restore a deleted Group beside a new one with its number. The root's ordinal is
`0`. The renderer derives the display name in `renderer/lib/layerName.ts`; main
stores no localized string. `label` is always written (`null`, never omitted).

**Duration.** While `duration_pinned` is false, `duration_us` follows
`max(layer.t_end_us)` both ways. `set_composition { duration_us }` pins it;
while pinned only the overflow guard moves it (a layer past the end bumps it up).
`fit_composition_to_layers` clears the pin. The fitted value is the high-water
mark snapped **up** to the frame grid (`applyDurationAutofit`,
`mutations/helpers.ts`). Pin and duration belong to the unrecorded composition
envelope; Settings shows the pin as the *Extend duration* switch, floored at the
content end, and switching it off calls `fit_composition_to_layers`.

## MediaItem

`path_rel` (workspace-relative, e.g. `Media/clip.mp4`) is authoritative. On load
`reconcileMediaPaths` (`state/persistence.ts`) recomputes `path_abs =
join(workspace, path_rel)`, so a moved workspace keeps its references. Items with
`path_rel === null` (import copy pending, or synthesized `Cache/` media) keep
their stored `path_abs`. A missing file shows as unavailable; the project still
loads.

`file_hash_blake3` is the content identity (relink, cache keys). Import shows the
clip at once from a stat-only probe with a provisional hash; a standalone BLAKE3
pass sets the real hash before any derivative job is enqueued, so jobs are always
keyed on final content, and the workspace copy runs in parallel.

`metadata.duration_us` is normalized content duration (container start offset
removed); source windows use this domain.

### Decode route

`decode_route` is the **persisted** record of where preview and export read
pixels, with derivative readiness folded into the variants so route and path
cannot contradict each other (wire: `{ route: "bypass" | "direct-export" |
"proxied" | "native-sw", … }`; terms in
[CONTEXT.md](../CONTEXT.md#decode-routing)):

- `bypass` — preview and export read the original.
- `direct-export { quick_proxy }` — export reads the original; preview reads a
  720p short-GOP quick proxy.
- `proxied { quick_proxy, full_proxy, format_version }` — export reads the
  source-resolution master `full_proxy`; preview reads the quick proxy (falling
  back to the full one). Bumping `format_version` forces regeneration.
- `native-sw` — a WebCodecs-blind source (ProRes, DNxHD/HR, MPEG-2, VC-1/WMV3;
  `codec_is_blindspot` in `native/src/jobs/proxy_decision.rs`); same fields and
  path resolution as `proxied`. Preview decodes the original through the
  Standard (ffmpeg) engine when the native component is present, otherwise the
  quick proxy (`renderer/render/decoder/decodeEngine.ts`, ADR 0030). Export reads
  `full_proxy` under the `webcodecs` engine setting and the original under
  `auto` / `ffmpeg` when the component is usable
  (`renderer/render/exportDecodeRouting.ts`,
  [ADR 0033](adr/0033-export-decode-joins-the-engine-overlay.md)).

The variants make illegal combinations unrepresentable (no full-proxy export
with original preview, no `bypass` carrying a proxy), so a change to this enum is
a shape conversion (a chain step, see Versioning). A `null` path means the
derivative has not landed. An unknown source GOP counts as long
(`gop_is_scrub_friendly(None) == false`), so a probe hiccup builds a scrub proxy
rather than bypassing. `resolveDecode(media)`
(`renderer/render/decodeRoute.ts`) maps the record to paths; preview source and
engine come from `resolvePreviewSource` / `resolveDecodeEngine`. Pool
actionability uses that same resolution, not the presence of a path or a job
event ([preview.md § Actionability](preview.md#actionability)).
H.264 and 8-bit AV1 may import as `direct-export`; HEVC, VP9, ProRes and
10-bit/HDR route to a full master. Before export the renderer verifies a
`direct-export` source with `probeSourceDecodable`; on failure
`ensure_full_proxy` moves the route to `proxied` and the export waits for the
master (why: [platform-codecs.md](platform-codecs.md#12-export-from-original-needs-a-proven-worker-decode)).

### Media kinds

`kind` is decided at import by `detect_kind` (`native/src/io/probe.rs`),
ffprobe first, extension fallback:

- A video stream means `Video`, except: cover art (`disposition.attached_pic`)
  is ignored; a still-image codec counts as `Video` only when it moves with a
  real video codec (motion-JPEG stays `Video`); animated GIF / WebP / APNG / AVIF
  are `Image` (AVIF told apart from AV1 video by `container_format`).
- An audio stream and no counting video stream means `Audio`.
- No probe → extension list; unknown extensions default to `Video` (so SVG
  imports as an unusable layer).

| Kind | Import dialog offers | Derivatives |
| --- | --- | --- |
| Video | mp4 mov mkv webm avi m4v mpg mpeg m2v | decode-route proxies, waveform, conform, thumbnails |
| Audio | wav mp3 flac aac m4a ogg opus | waveform + conform only, ready once the copy lands |
| Image | png jpg jpeg gif webp bmp | none — rendered from the original |
| Subtitle | srt ass vtt | none |

The extension fallback also maps `tif`/`tiff`, `avif`, `apng` to `Image`. The
dialog omits TIFF because Chromium's `createImageBitmap` cannot decode it, and
omits AVIF (drag-drop and MCP still import it). Still images get a 3 s default
duration; animated images decode all frames once via WebCodecs `ImageDecoder`
and loop to fill the layer (one native loop when placed). Subtitle items carry
no picture: `apply_subtitles` turns one into caption `Text` layers
([captions.md](captions.md)).

## Track

Tracks are kind-agnostic; the class shown for a track (Video / Audio / Empty) is
derived from its layers. **Same-class layers (video-class vs audio-class) never
overlap on one track**; cross-class overlap is allowed and is how a paired AV
import lands.

- `enabled` (eye) hides the track's video and silences its audio.
- `locked`: at every commit and dry run, `assertLockedLayersUnchanged`
  (`state/layerLocks.ts`) refuses any change, direct or indirect, to the content,
  transitions or link membership of a layer on a locked track (`TrackLocked`) or
  of a locked layer (`LayerLocked`, via `layerEditLock` in
  `shared/layerLocks.ts`), and refuses a locked track gaining layers. A lock-only
  patch is the one allowed write; an unlock bundled with content edits is
  refused. The check is on results, so every write path (UI, MCP, link fan-out)
  is covered.
- `enabled` / `locked` change through `update_track_flags`, which is
  **unrecorded** — undo never flips a track control.
- `muted` / `solo` round-trip but gate nothing; audio mute/solo is per mixing
  role. Audio control stacks in three scopes: clip (`AudioParams.mute`), role
  (`audio_roles`), track (`enabled`).
- `role` is stored `ARoll | BRoll | AudioA | AudioB | Caption` (kebab
  `a-roll` … in the summary). A fresh project and every new Group carry
  non-removable A/B-roll tracks; `delete_track` on one returns
  `TrackNotRemovable`. Legacy files without `removable` load it as `true`; the
  role, not `removable`, is the load-bearing discriminant.

**Naming.** `label: null` means the name is derived, renderer-side in
`renderer/lib/trackName.ts` (main has no locale bundle; main emits keys, never
English): a role track from its role, a role-less one from its 1-based slot from
the bottom, so adding or pruning renumbers those above. The exception is the
track `separate_audio` creates, which stores `"<source> (audio)"` because the
source cannot be recomputed later. `rename_track` stores `null` for a blank name —
the route back to the derived name (a layer rename instead abandons on empty).

**Cleanup: a track disappears when its last layer leaves it.** The predicate is
`transient && !locked`; every path that can empty a track (`delete_layers`,
`move_layer`, `move_layers_to_new_track`, `separate_audio`, `restack_layer`,
`groups_create`, `groups_ungroup`, `move_layers_to_composition` /
`groups_add_members`) calls `pruneEmptiedTrack` on the track it just emptied,
never a project-wide sweep, in the same history entry. So a track born empty
survives until removed, and an edit never removes a track elsewhere. A raise that
empties a renamed track deletes it and its name; one undo restores both
(exempting named tracks would make a name a second pin beside the lock).
`transient == (role is None)` at every creation site. The app setting
`auto_delete_empty_tracks` (default true) gates the rule; changing it sweeps
nothing. `remove_media --force` deletes through the same `applyDeleteLayer`, so
it prunes too.

## Layer

`t_end_us` is exclusive. `enabled: false` is not deleted: the layer serializes
and occupies its range. `metadata` is a free extension map.

`effects` is an ordered chain joined to an external catalog on `kind`, which the
model does not validate (an unknown visual kind is skipped with a warning
renderer-side). A visual `kind` is a realtime Pixi filter
(`render/effects/effectRegistry.ts`, ADR 0027); an `audio.*` kind is an offline
bake catalogued in `shared/audioEffects/` (ADR 0063). The command layer enforces
`audio.*` only on Audio layers and nothing else on them
(`EffectKindNotApplicable`); audio effect params are static only, and the baked
artifact is derived, never stored.

**VideoClip.** `crop` is a static retained source rect, normalized; `null` = full
source. `w`,`h` > 0 and inside `[0,1]²`; writes quantize to 1e-9 and canonicalize
full frame to `null` (`shared/crop.ts`). Crop never changes position, scale,
pivot or source window.

**ImageOverlay / Motif / Text `graphic_role`** is `null` or matches
`^[a-z][a-z0-9_]{0,31}$`; a Motif's is born from its manifest role unless the
caller names one. Roles are described in [mcp.md](mcp.md). A caption cue's is
always `null`.

**Motif.** `props` are checked against the manifest's `props_schema` at write
(add and patch; a patch merges into existing props, a rebind starts from the
patch alone); a Motif the catalog does not know stays permissive. `src_in_us` is
the offset into the Motif's intrinsic content.

**Audio.** `role` is the mix-bus tag (`dialogue` | `music` | `sfx` |
`voiceover`, default `dialogue`); the mixer groups by role, not track. `pan` is
−1..1.

**Color.** A fill with no transform and no opacity; `color` is its only
animatable param.

### Text box

The box is what gives text a size, and which fields are set **is** the resize
mode:

| `(box_w, box_h)` | Mode | Wraps | Shrinks to fit |
|---|---|---|---|
| `(null, null)` | Auto width | no | no |
| `(set, null)` | Auto height | yes | no |
| `(set, set)` | Fixed | yes | yes |

`(null, set)` is not a mode: an edge drag backfills `box_w` in the same commit,
MCP refuses it, and the renderer coalesces it to Auto width. Box fields are in
LOCAL composition px and are not `Animated` (a keyframed box would rebuild the
glyph atlas every frame; `scale_*` is the size animation channel). The Fixed
shrink factor is derived in the renderer and never stored, because an MCP
`content` edit never reaches the renderer (ADR 0049). `line_height: 0` means the
font's own metrics.

### CompositionRef (Group layer)

A media-bearing layer whose source is a composition: source duration is
`compositions[composition].duration_us`, parent time `t` maps to
`t − t_start_us + src_in_us`, so trim clamping, split and keyframe rebasing apply
as for VideoClip / Audio. `composition` is never `root_id` and never on a cycle.
**Overhang is tolerated in state, clamped at the gesture**: validation requires
only `0 ≤ src_in < src_out`, because an upper bound would refuse a delete inside
the Group whenever autofit shrank it under a parent's window (ADR 0052). No crop,
flip or ref-level gain.

### Transform

**Position is the anchor position in composition pixels** for every transformed
kind (schema v4, [ADR 0112](adr/0112-anchor-position-schema-v4.md)):
`world = Position + R·S·(local − anchor·naturalSize)`. The full source defines
the pivot even when cropped; proxies never change stored Position. Text uses its
layout box (measured bounds on auto axes).

- `anchor_x` / `anchor_y` are the normalized **pivot** (0.5 = centre), animatable
  and unbounded. Inspector Anchor moves content around a fixed Position; the
  on-canvas anchor target also writes `Position += R·S·(Δanchor·naturalSize)` so
  content stays put.
- Scale gestures (inspector and canvas handles) hold Position fixed and write
  only scale tracks.
- New media and Motifs are placed with Position at half their natural size (top
  left at 0,0); a plain Group at half its composition size (identity transform);
  Text at the composition centre.

`position` is exactly one of `XY { x, y }` or `Path { path: { nodes }, progress }`
([ADR 0060](adr/0060-position-has-xy-and-path-modes.md)). Path nodes
carry a stable `id`, relative handles, the outgoing `segment` (Line | Cubic) and
`tangent_mode` (Corner | Smooth | Auto); geometry has no timestamps, and the
solver stores resolved handles for every reader. `progress` 0–1 traverses by
distance and is keyframed as `path_progress`; independent `x`/`y` writes are
refused in Path mode. `set_position` replaces the record atomically,
`translate_path` moves all nodes, and a split keeps the whole route and progress
on both halves. Conversion previews never write state; applying one is a single
record replacement.

`scale_linked` is **uniform-scale intent**: while true, `scale_x` and `scale_y`
are structural twins (same mode and, if keyframed, the same `(t_us, value, in,
out, continuity, segment)` sequence and `extrapolate`; key ids differ). Enforced
on **results** (`mutations/scaleLink.ts`): after any write touching a linked
layer's scale, a twin check in the same commit clears the flag on divergence.
`set_scale_linked { linked: true }` copies `scale_x` over `scale_y` with fresh
ids. The load pass backfills a missing flag from the twin check and repairs a
lying one. Rust carries it for wire fidelity only.

## Animated values

`Animated<T>` is `{mode: "Static", value}` or `{mode: "Keyframed", value: [keys],
extrapolate}` (`shared/keyframe.ts`, Rust `native/src/state/animated.rs`).

**Keyframe `t_us` is relative to the layer's start**, so moving a layer keeps its
animation. An optional `time_fraction` holds an exact sub-µs remainder. An
IN-edge trim shifts every key by the delta; split partitions keys at the cut
(right half rebased, an emptied half collapses to `Static` at the boundary
value); keys outside `[0, duration]` are **kept** (trims stay reversible),
`value_at` clamps them and the UI hides them.

**Tangents.** `out` shapes the segment leaving a key, `in` the segment
arriving; each is `{x, y, mode}` in the segment's unit square (CSS
`cubic-bezier` lineage). A Spline segment `a → b` evaluates
`unit_bezier(a.out.x, a.out.y, b.in.x, b.in.y)`. `in` is stored **un-mirrored**
(the curve graph mirrors for display): `1 − (1 − 0.58)` is not `0.58` in f64, and
preset recovery, the linked-scale twin compare and the Rust↔TS goldens all need
exact equality. Identity sides are `(1/3, 1/3)` / `(2/3, 2/3)`, written as
`1 / 3` and `2 / 3` in both languages ([ADR 0058](adr/0058-tangents-live-on-the-key-the-segment-class-on-the-left-key.md)).

**Modes.** `Free` is the numbers as written. `Auto` is clamped monotone (slope
from neighbours, flat at extrema / ends / sign changes, `y ∈ [0,1]`) and is
solved when the track is **written**, in the actor's normalization beside
frame-snap / sort / dedupe-last-wins, never in the engine — stored tangents are
always explicit. `continuity: Smooth` with both sides Free and both segments
Spline re-derives `in.y` from the out side ("out wins"). Trim, split and move
never re-solve.

**Segments.** `segment` on the left key names `kf[i] → kf[i+1]`: `Spline` reads
tangents; `Hold`, `Linear`, `Elastic {dir, amplitude, period}` and `Bounce {dir}`
ignore them (sides next to them hold the identity). Named presets are not
variants: authoring bakes a preset to `(p1, p2)` as Free `left.out` /
`right.in` with `Spline`, and recovers the name by exact lookup in the
append-only table in `src/shared/easing.ts` (entries are never retuned; a new
feel is a new id).

**Extrapolation.** `extrapolate { before, after }`, each `Hold | Loop |
PingPong | Offset | Continue`, default `Hold / Hold`. Period = `last.t −
first.t`; a single key never extrapolates. `Loop` jumps back to `first.value`;
`PingPong` runs odd periods backwards; `Offset` adds `n·(last − first)` per
period (Rgba in OkLab); `Continue` extends the last segment's end velocity
(slope 0 after Hold or procedural).

`parseProject` **refuses** a key with `interp` or missing `in` / `out` /
`continuity` / `segment`, or a keyframed track missing `extrapolate`: a defaulted
tangent would be silently different motion.

**Animatable params.** Visual kinds: position (`x`/`y`, or `path_progress` in
Path mode), `scale_x`, `scale_y`, `rotation_deg`, `anchor_x`, `anchor_y`,
`opacity`; Text adds `color`; Audio `gain_db`, `pan`; Color `color`. Effect
params are `effects[<id>].params[<key>]`; `audio.*` effect params refuse a
Keyframed track (whole-clip bake). The list has one home per side:
`animatableParams` in `renderer/keyframe/descriptors.ts`, and
`TRANSFORM_F64_KEYS` + `f64Lens` / `rgbaLens` in `main/state/mutations/params.ts`,
mirrored by `resolve_animated_f64` in `native/src/state/layer.rs`. Editing
surfaces (timeline rows, navigation, marquee, batch edits, clipboard) discover
params through `renderer/keyframe/channels.ts` (`layerParams`,
`readLayerParamTrack`, `keyframedParams`), which adds per-instance effect params
from `shared/effects/params.ts`; effect rows are addressed by effect instance id,
so reorder changes the label, not the address. Only Keyframed params get
timeline rows.

`color` is the one `Rgba` track; the param key decides the lens and a value of
the other type is refused. Quantization is numbers-only, and an Rgba Auto side
lands on the identity with its mode kept. Text shadow and outline colours are
plain static `Rgba` fields.

## Marker

A marker belongs to one composition. **Following a clip is a field, not a second
entity**: `anchor: { layer, src_us, src_fraction? }` names a layer of the same
composition and an instant in its SOURCE domain (`src_fraction` holds the exact
sub-µs phase, omitted when absent). `t_us` stays **stored** as a derived cache,
so every reader (lane, `Ctrl+K`, summary, serialize, MCP, export) reads `t_us`.

`reconcileMarkers` (`state/validate.ts`) runs in the commit beside
`reconcileTransitions`, after the mutation and before validate. It re-derives
`t_us` through the retime-aware `sourceInstantTimelineUs` (`summary.ts`) and
carries `end_t_us` by the same delta; drops a marker whose layer exists nowhere
(status-log row); and leaves a layer that exists in another composition for
validate to refuse (`MarkerAnchorNotInComposition` is a bug detector).

- Patching `t_us` on an anchored marker **moves the anchor**: `update_marker`
  derives `src_us` from it and the reconcile writes `t_us` back. A time outside
  the layer's span is refused, and so is `t_us` together with `end_t_us`.
  `anchor` is set and cleared only by attach / detach.
- An anchor whose `src_us` falls outside `[src_in_us, src_out_us)`
  **hibernates**: kept, not painted, revived exactly by undoing the trim.
  Hibernation is recomputed every commit and never stored, so `src_us` is
  deliberately not range-checked.
- `label` is short (lane text, `Ctrl+K` row); `note` is the Panel's long text.

## Link

A flat, non-nesting set of ≥ 2 layers of **one composition** whose move / trim /
split fan out to every member; a layer is in at most one link, and a link has no
name (a stored `label` is dropped at load). Rust keeps `members` as an `OrdSet`;
TS keeps the array sorted. Behaviour: [features.md § Links](features.md#links).

## Read surface: `ProjectSummary`

The renderer never holds a `Project`. Main builds a read-only view on every
`project:changed` (`buildProjectSummary` in `state/summary.ts`; the renderer's
types in `renderer/ipc/index.ts`). Every composition is projected, keyed by id,
as a pure function of that composition plus the media pool; timeline fields live
only on the composition entries, so a consumer names the composition it reads.
`track_count` / `layer_count` span every composition; `audio_roles` always lists
the four roles in canonical order with defaults filled; `fps_locked` is
history-scoped, so it repeats on every entry. `TrackSummary.kind` is a derived
class, never a name.

A timeline Panel is addressed `timeline:<composition_id>`
([ADR 0053](adr/0053-a-timeline-panel-is-one-composition.md)). Keyboard
surfaces (inspector, Playhead panel, creation commands) follow the focused
composition (`state/compositionAnchorStore.ts`); the preview renders its locked
target or the focused one; export always reads `compositions[root_id]`. If a
composition vanishes (undoing the pre-compose you stand in), its Panel closes and
focus falls back along the anchor path, then to the root.

## History

`state/history.ts`: a linear stack of whole-project snapshots (Immer structural
sharing), capped at 200 entries, plus named checkpoints and an optional lock.

- Undo/redo move the cursor and broadcast the snapshot there.
- Checkpoints are in-memory snapshots that survive stack eviction; they are not
  written to `project.json`. Restoring one records a new entry, which drops redo.
- While the lock is set (`set_history_lock`), undo / redo / restore are refused.
- **Unrecorded mutation classes** patch every snapshot and checkpoint in place
  (`replace*Everywhere` in `history.ts`), broadcast a non-recorded change and
  leave the cursor: unreferenced media import/removal, derivative and path
  updates, track and role flags, project settings, and the whole composition
  envelope (`set_composition` / `fit_composition_to_layers`). Opening or creating
  a project resets history (`replace_state`). Per-op table:
  [features.md § Undo-stack scope](features.md#undo-stack-scope).
- The composition fan-out is a **transform per snapshot**: a pinned duration is
  floored at that snapshot's own content, and an fps re-snap runs against that
  snapshot's own layers and markers. Because the write spans every snapshot, the
  fps lock is judged over all of them.

## Concurrency: single-writer actor

One writer: UI IPC and MCP calls both land in the actor (`state/actor.ts`), which
runs each mutation as an Immer recipe, reconciles, validates, records and
broadcasts a `ChangeEvent { op_id, actor, summary, affected, new_snapshot,
diff_hint }`. `diff_hint` (`Coarse | Layer(id) | Composition`) lets consumers do
partial work ([architecture.md](architecture.md)).

## Validation invariants

Enforced on every commit by `validate` (`state/validate.ts`); error names are in
`src/shared/commandErrors.ts`. A failure returns a structured error (UI toast;
MCP tool error with a reason and, where useful, options).

| Invariant | Failure |
|---|---|
| `t_start_us < t_end_us`; `t_start_us ≥ 0` | reject (`InvalidLayerRange`, `NegativeLayerStart`); the start is clamped in the mutator first; a loaded project is repaired instead |
| Endpoints, `duration_us`, marker times on their grid (see Time) | snap in the mutator, then reject (`OffGridLayerBoundary` / `OffGridTime`, carrying `snap_to`); a loaded project is repaired instead |
| `fps` changes only while no layer exists in the timeline or any stored snapshot / checkpoint | reject (`FpsLockedByContent`, `locked_by: current \| history`) — the unrecorded rate change writes every snapshot, so undo could otherwise resurrect old-grid layers |
| `transition.duration_us` == the participants' overlap; `0 ≤ extended_us ≤ duration_us` | reject |
| `0 ≤ src_in < src_out`, and `src_out ≤ media duration` for VideoClip / Audio (exact, through the layer's time map) | reject (`InvalidSrcRange`, `SrcRangeExceedsMedia`); a CompositionRef has no upper bound |
| No two same-class layers on one track overlap in `[t_start, t_end)` | reject (`LayerOverlap`, with options) |
| `duration_us == max(t_end_us)` unpinned; `≥` pinned | autofit (pinned: grow only) |
| `width/height > 0`, `fps` num/den non-zero | reject (`InvalidCanvas`, `InvalidFps`) |
| `root_id` resolves; `compositions[k].id == k` | reject (`RootMissing`, `CompositionIdMismatch`) |
| Every `CompositionRef` target exists, is not the root, forms no cycle | reject (`CompositionMissing`, `RootReferenced`, `CompositionCycle`); unreferenced compositions are legal |
| A composition is removed only by ungrouping its last reference or by `compositions_delete` when unreferenced | `CompositionInUse`; deleting a Group layer never cascades into its composition |
| Every composition's `fps` / `sample_rate` / `channels` equal the root's | reject (`CompositionLatticeMismatch`) |
| Layer and marker ids unique project-wide; transition ids unique per composition | reject (`DuplicateLayerId`, `DuplicateMarkerId`, `DuplicateTransitionId`) |
| An anchored marker's layer is in the same composition and has a source window (VideoClip / Audio / CompositionRef) | reject (`MarkerAnchorNotInComposition`, `MarkerAnchorLayerHasNoSourceWindow`); `src_us` is not range-checked |
| Media and track references resolve | reject (`MissingMedia`, …) |
| Link ids unique per composition; members in the same composition; a layer in ≤ 1 link; ≥ 2 members | reject (`DuplicateLinkId`, `LinkMemberMissing`, `LayerInMultipleLinks`, `LinkBelowMinSize`); a delete or member removal dissolves a link below two first |
| Transition participants do not share a link | refused at `add_transition` (`TransitionParticipantsShareLink`): placement moves the incoming layer's link siblings, so the overlap would never open |
| `crop` valid; `graphic_role` valid; `frame_interpolation` is `FrameSampling` | `InvalidArgument` |
| Keyframe `t_us` outside `[0, duration]` | allowed |

## Mutation surface

Actor commands (`state/actor.ts`) and MCP tools (`MCP_TOOL_DEFS` in
`state/mcp-commands.ts`) are not 1:1 by name — e.g. MCP `create_group` →
`groups_create`, `ungroup_layer` → `groups_ungroup`, `create_link` /
`update_link` / `delete_link` → `links_*`, `update_composition` →
`set_composition`, `delete_media` → `remove_media`, `set_track_flags` →
`update_track_flags`, `delete_layers { ripple }` → `ripple_delete_layers`,
`set_marker_anchor` → attach / detach. The tool catalog is [mcp.md](mcp.md).
Patches are strongly typed, not JSON Patch.

**Scope is derived, never passed** (ADR 0052). Ids are project-wide unique, so a
layer-, marker-, track-, link- or transition-addressed command edits the
composition that holds its target. Only creation commands carry
`composition_id?` (default root): `add_track`, `add_marker`,
`add_caption_track`, lane-picking layer adds, and the composition envelope; a
layer add naming a `track_id` cross-checks it. A derived-scope command never
crosses compositions: a destination elsewhere is `CrossCompositionMove`, a set
straddling two is `CrossCompositionSet`. A layer changes composition only through
pre-compose, `groups_add_members`, ungroup, or `move_layers_to_composition`.

Command contracts not stated elsewhere:

| Command | Contract |
|---|---|
| `remove_media(id, force?)` | `MediaInUse { referenced_by }` unless `force`, which deletes the layers as `delete_layers` does (links, lane prune, autofit; locked lane → `TrackLocked`) in one recorded entry; unreferenced media is removed unrecorded |
| `update_track_flags` / `update_role_flags` | unrecorded; `set_role_gain` and `rename_track` are recorded |
| `move_track(id, position)` | whole-track reorder in its composition, `0` = bottom; refuses locked tracks and tracks holding locked clips; keeps identity, links, transitions; no-op records nothing |
| `paste_layers(ids, t_start_us \| t_offset_us, target_track_id?)` | the only copy command: clones shift by the seed's (`ids[0]`) delta, re-snap on their own lattice; only the seed changes track; any lock or overlap refuses the set; ≥ 2 clones are linked together |
| `set_layers_enabled(ids, enabled)` | exactly the named layers (no link fan-out); a locked track refuses the set |
| `update_layer_param_track(s)` / `update_param_tracks_multi` | replace whole tracks with the normalization above; the multi form spans layers in **one** entry and checks the scale-link invariant once per layer after all entries land |
| `move_layer(…, escape_link?)` | link-aware; a fan-out touching a locked member refuses whole (`LinkLockedMember`) |
| `move_layers_to_composition(ids, to, anchor_layer_id, anchor_t_start_us, to_track_id?)` | the set lands with the anchor at an ABSOLUTE destination time, others keeping phase; lanes per source track (omitted: nearest free else spawn; `"spawn"`: fresh; named: refused if locked/occupied); each member re-snaps on its own lattice. [features.md § Groups](features.md#groups) |
| `move_layers_to_new_track(ids, anchor_layer_id?, t_start_us?)` | one fresh top lane; emptied source lanes pruned in the same entry; with both landing args the anchor lands at an absolute time, with neither times are kept verbatim; links untouched |
| `restack_layer(id, above\|below, anchor_layer_id? \| anchor_track_id?)` | anchored z-reorder resolved at apply time; a sole occupant moves its track, a shared-track mover splits onto a fresh track; role-stamped sources never move; audio movers/anchors, cross-composition and self anchors refuse. [features.md § Track placement](features.md#track-placement) |
| `delete_layers(ids)` | one entry; ids de-duplicated; any locked member refuses the batch; no link fan-out |
| `ripple_delete_layers(ids)` / `ripple_delete_gap(track, s, e)` | close what was vacated on every track of the composition, each on its own lattice; anchored markers follow, free markers and the playhead stay; refuses whole before writing. [features.md § Ripple delete](features.md#ripple-delete) |
| `links_create(ids, reassign?)` and `links_*` | `LinkCreateNeedsTwoLayers`, `LayerAlreadyLinked` unless `reassign`, `LinkNotFound`, `LayerNotInLink` |
| `groups_create(ids, label?)` | pre-compose into a new composition with the parent's settings and the A/B skeleton; never partial (locks refuse first); inside links and transitions move, straddling ones are trimmed / reconciled away; anchored markers follow their layer |
| `add_group_layer(source, track_id, t_start_us)` | window `[0, duration_us)`, identity transform; refuses the root, a cycle, an empty source before any write |
| `groups_add_members(ids, group_layer_id)` | members land at `t_start_us − group.t_start_us + group.src_in_us` (overhang possible); delegates the crossing to `move_layers_to_composition` |
| `groups_ungroup(layer_id)` | only a plain Group (identity transform, static opacity 1, no effects, Normal) else `GroupNotPlain`; members inside the window copy in trimmed, outside dropped; the composition goes with its last reference |
| `set_composition(patch, composition_id?)` | never recorded; lattice fields cascade; `fps` behind the lock |
| `restore_checkpoint` | records a new entry (clears redo) |
| `dry_run(operations)` | runs the batch on a clone, stops at the first error, commits nothing |
| `replace_state(snapshot)` | project open / new; full validation; resets history |

Agent keyframe tools (`get_param_track`, `set_keyframe`, `update_keyframe`,
`delete_keyframe`, `smooth_keyframes`, `set_extrapolation`, `clear_keyframes`,
`set_param_track`) read the track, apply a pure transform, and write the whole
track back. Their times are timeline-absolute, converted to layer-local at the
boundary. The transform math is shared with the timeline UI and locked Rust↔TS by
a golden fixture.

## On-disk format: workspace folder

The workspace folder **is** the project; originals are copied in on import.

```
<workspace>/
├── project.json        canonical state; autosave 500 ms after the last commit
├── project.pre-v{n}.json  pre-upgrade bytes (see Versioning)
├── view.json           UI view state for this project
├── Media/              imported originals (workspace owns the bytes)
├── Cache/              derivatives, regenerable: proxies, thumbnails, filmstrip,
│                       waveforms, audio (48 kHz conform), frames, raster (Motif
│                       frames <hash>/<frame>.wfrm, see motifs.md#frame-cache),
│                       transcribe-audio, descriptions, shots,
│                       shot-stats, voiceover, inline-subs (reserved)
├── Backups/            project.json copy every 50 commits or 5 min; newest 20 kept
└── Renders/            default export destination
```

There is no explicit Save: autosave (`state/autosave.ts`) writes every commit;
`project_save` only forces the flush.

### `view.json`: how this project was last looked at

Kept out of `project.json` so zooming never dirties the document, pushes undo or
reaches MCP. One definition, `src/shared/view-state.ts`, shared by main (owns the
file) and the renderer (owns the live copy). `composition_tabs` is an **intent**:
the Panels that exist are that list intersected with the summary's compositions,
so an entry outlives the undo that removed its composition and comes back on redo
with zoom, scroll and anchor. Only the last anchor step is stored; `null` = take
the shortest path from the root. `viewStateDefaults()` is the only place a
missing field gets a value — every reader goes through it. Dock geometry is
app-level, not here.

## App-level storage: the data root

**`<userData>/`** holds small, fixed-location, atomically written JSON owned by
main: `app_settings.json`, `keybindings.json`, `workspaces.json`,
`recents.json`, `decode_capability.json`, and the secrets `cloud_keys.json` /
`mcp_auth.json` (plus the OS keyring). The data root's own path lives here
(`data_root` in `app_settings.json`), so it cannot itself be under the data root.

- `app_settings.json` also holds export presets: `export_presets` entries
  `{ id, name, version: 1, values }` and `default_export_preset_id` (a personal
  or `builtin:*` id; deleting the default restores `builtin:match`). `values`
  copies the `ExportSettings` output fields except the encoder/decode engine and
  `hwAccel`. A project's own `export.json` wins over the default
  ([export.md § Export presets](export.md#export-presets)).
- `workspaces.json` holds Dock layouts and **never a composition id**: live
  `timeline:<id>` Panels fold back to the bare `timeline` slot on save. Restore
  order: geometry, the root's timeline in the slot, then the project's
  `view.json` tabs (ADR 0053).

**`<dataRoot>/`** (default `<userData>/data/`, relocatable) holds large
app-managed content, resolved once at boot by `resolveDataRoot`
(`src/main/dataRoot.ts`) before the backend, the Motif store and the fs guard
are built; every consumer takes its paths from it, and the root is on the
renderer's `fs:*` allow-list.

```
<dataRoot>/
├── motifs/      user-authored Motifs — user content
├── cache/       app-level backend cache — regenerable (not <workspace>/Cache)
└── downloads/   downloaded engines and models — <itemId>/<version>/…, manifest.json written last
```

Downloads are speech engines, models and the Qwen3-VL set
([ADR 0039](adr/0039-local-engines-are-pinned-upstream-artifacts.md)). Catalog:
`src/shared/content-catalog.ts` (pinned URL, SHA-256, size); lifecycle
`src/main/contentDownload.ts`; one-at-a-time queue `src/main/contentQueue.ts`.
Partials (`cache/content-partial/<itemId>.part` + `.part.json` naming the
artifact) resume from their size; the queue persists in
`cache/content-queue.json`. A transfer failure never discards a partial: up to 3
attempts with 1 s / 4 s backoff and a 45 s stall watchdog. Cancel keeps the
partial (pause); `content:remove` deletes it. A 200 to a Range request restarts
from zero; a 416 refetches whole.

Resolution: unset → default, created silently; set and writable → used; set but
unavailable → a blocking native dialog offering **Re-set** or **Quit**, never a
silent fallback.

**Changing the data root** (Settings → Data location;
`src/main/dataRootMigration.ts`): a folder that already is a data root is
**adopted** as-is; otherwise `motifs/` and `downloads/` are **copied** (not
`cache/`), verified (Motifs by content hash, downloads by count + size), and
rolled back on failure with `data_root` unchanged. Same, nested or ancestor
targets are rejected. Success writes `data_root` and relaunches. A userData
marker (`data-root-migration.json`) lets Settings offer to delete the old copy
after relaunch — copy mode only, explicit confirm, never `userData` itself.

## Versioning

`project.json` carries `schema_version`. `SCHEMA_VERSION` (`state/model.ts`,
currently **5**) is the only home of the number; Rust round-trips the field and
never gates on it.

The load path is a **version-keyed upgrade chain** ([ADR 0047](adr/0047-project-schema-upgrades-are-a-version-keyed-chain.md)):

1. `state/persistence.ts` refuses a missing / non-numeric version or one
   **ahead** of the build (writing it back would drop unknown fields).
2. `state/migrate.ts` walks `STEPS`, one `v_n → v_n+1` step each, on a clone;
   the host injects external facts through `MigrationContext` (media and Motif
   sizes, the frozen v3 evaluator from `migrationEvaluation.ts`).
3. `parseProject` (`state/serialize.ts`) casts and normalizes.

Upgrading happens in memory. Before the workspace is replaced, the exact input
bytes are preserved and verified in `project.pre-v{n}.json` beside
`project.json` (not in `Backups/`, whose snapshots are post-write and gc'd); an
identical backup is reused, a differing one kept and a numbered
`project.pre-v{n}.{k}.json` created. Failing to preserve it aborts the open.
These backups are never cleaned up. Saving writes the current schema; restoring
the backup with an older build is the only downgrade.

| Kind of change | Where it goes |
|---|---|
| A new **optional** field | `#[serde(default)]` in Rust and a default in `parseProject`'s normalize pass, so no consumer sees `undefined`. No bump. |
| A **validity repair** (off-grid geometry, a flag contradicting its data) | the same version-blind normalize pass; idempotent |
| A **shape conversion** (rename, merge, split, retype, retired variant) | a chain step with a version number — never an unconditional rewrite in `parseProject` |

A step imports **nothing** — not `SCHEMA_VERSION` (the target is a parameter),
not a model type, not `defaultSettings()`. It declares local types for the fields
it touches and writes frozen literals; otherwise it silently re-anchors to a
model that has moved on. Deserialization is permissive: unknown fields are
ignored and dropped on next save.

**A bump ships with its step and a frozen fixture** of the version it leaves
(`apps/desktop/fixtures/projects/v{n}.json`). `migrate.completeness.test.ts`
pins `MIN_SCHEMA_VERSION + STEPS.length === SCHEMA_VERSION`, the step versions,
and that every fixture upgrades and passes `parseProject` + `validate`. A bump
without its step cannot be repaired later.

### Steps

- **v1 → v2**: an Audio layer with `params.mute: true` becomes `enabled: false,
  mute: false` (the inspector's clip-mute control was removed). Nothing else
  changes. Earlier pre-release cutovers, including ADR 0060's position record,
  stay inside v1; legacy transform axes are refused.
- **v2 → v3**: time mapping (below). Deletes the inert `VideoClip.speed`, writes
  an identity `time_map` and `FrameSampling` on every temporal kind,
  `preserve_pitch: true` on Audio and CompositionRef, and a `content_window` on
  ImageOverlay and Motif. Motif `props.speed` is content and untouched.
- **v3 → v4**: Position becomes the anchor for VideoClip, ImageOverlay, Motif and
  CompositionRef (ADR 0112): `x += anchor_x·sourceWidth·|scale_x|` (and y), sizes
  from original media metadata, the Motif manifest version or the referenced
  composition — never proxy or crop sizes; missing sizes refuse. Constant offsets
  translate keys or path points; animated scale or anchor bakes XY position at
  composition frame times over each clip's span, including transition handles and
  every reachable Group instance. It refuses (original untouched) a curve over
  the v3 evaluator's 4096 keys, a clip needing over 4096 samples, or a project
  over 2,000,000 sampled instants. The log lists clip ids, previous mode and
  sample count. Frames match at samples; between samples, later retiming or an fps
  change may differ.
- **v4 → v5**: `graphic_role: null` on every Text, Motif and ImageOverlay; a
  Motif's manifest role is not back-filled.

## Time mapping (schema 3)

Temporal clips (VideoClip, Audio, ImageOverlay, Motif, CompositionRef) carry
`TimingFields` (`shared/timeMapping.ts`, Rust `native/src/state/timing.rs`):
`time_map: { kind: "Affine", rate: {num, den} }` (absent = identity), optional
`source_phase.in/out` and `fade_phase` remainders, `content_window`,
`preserve_pitch`, `frame_interpolation`. Wire rationals are reduced safe integers
with positive denominators. `src_in_us/src_out_us` plus `source_phase` form one
exact source window. Animated images and Motifs use an unwrapped
`content_window`; image looping happens only at frame sampling. Only
`FrameSampling` is accepted.

Keyframes carry integer `t_us` plus optional `time_fraction`; exact keys are
never re-snapped or merged in normalization. Retiming scales a layer's own key
times and fades (`fade_phase` keeps fractions), including effect animation; a
Group's child state is untouched. Composition clocks compose rational origins and
rates; only the final sample / display boundary is quantized. Non-unit-rate Group
membership changes and ungrouping are refused. Rationale:
[ADR 0092](adr/0092-constant-time-remapping-preserves-content-windows.md).
