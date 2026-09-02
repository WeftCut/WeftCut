// apps/desktop/src/main/state/model.ts
import type { IdGen } from './ids'
import type { DecodeRoute } from '../../shared/decode-route'
import type { Animated } from '../../shared/keyframe'

/** The on-disk `project.json` schema version this build reads and writes.
 *
 *  Bump it and ship the matching `v_n → v_n+1` step in `migrate.ts` IN THE SAME
 *  CHANGE, with a committed fixture at the old version — `migrate.completeness.test.ts`
 *  fails otherwise. See `docs/data-model.md` §Versioning and ADR 0047.
 *
 *  This is the only home for the number: Rust deserializes projects but has no
 *  opinion about the version (`native/src/state/project.rs`). */
export const SCHEMA_VERSION = 1

export type Uuid = string
export type TimeUs = number
export interface Rational { num: number; den: number }
export interface Rgba { r: number; g: number; b: number; a: number }
export type ColorSpace = 'Bt709' | 'Bt601' | 'Bt2020' | 'SRgb'
export type AudioRole = 'dialogue' | 'music' | 'sfx' | 'voiceover'
export type TrackRole = 'ARoll' | 'BRoll' | 'AudioA' | 'AudioB' | 'Caption'
export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten' | 'Add' | 'Difference'

export type { EaseDir, Interpolation } from '../../shared/easing'
/** The keyframe record (per-key tangents, segment class on the left key,
 *  track-level `extrapolate`) and `Animated<T>` are single-sourced in
 *  src/shared/keyframe.ts; the Rust twin is native/src/state/animated.rs. */
export type { Animated, Continuity, Extrapolate, Extrapolation, Keyframe, Segment, Tangent, TangentMode } from '../../shared/keyframe'

export interface Transform {
  x: Animated<number>; y: Animated<number>
  scale_x: Animated<number>; scale_y: Animated<number>
  rotation_deg: Animated<number>
  /** Normalized transform PIVOT (0.5 = centre on that axis) — what rotation
   *  turns around and what a flip mirrors about; animatable like the rest of the
   *  transform. Replaced a plain `anchor: [x, y]` tuple pre-release; the
   *  conversion is gone with the formats it read (ADR 0047), so v1 knows only
   *  these two tracks. */
  anchor_x: Animated<number>
  anchor_y: Animated<number>
  /** Uniform-scale intent: true ⇒ scale_x/scale_y are structural twins and edit
   *  as one. Invariant enforced on results (mutations/scaleLink.ts); a flag that
   *  contradicts its own tracks (only a hand-edited file can hold one) is
   *  repaired by parseProject's normalize pass. */
  scale_linked: boolean
}
export interface Rect { x: number; y: number; w: number; h: number }

export interface FontSpec { family: string; size_px: number; weight: number; italic: boolean }
export type TextAlign = 'Left' | 'Center' | 'Right'
export type VAlign = 'Top' | 'Middle' | 'Bottom'
export interface Shadow { color: Rgba; offset_x: number; offset_y: number; blur: number }
export interface Outline { color: Rgba; width: number }
export type TextAnimPreset = 'FadeIn' | 'FadeOut' | 'SlideUp' | 'SlideDown' | 'Typewriter'

export interface VideoClipParams {
  kind: 'VideoClip'; media: Uuid; src_in_us: TimeUs; src_out_us: TimeUs
  transform: Transform; opacity: Animated<number>; crop: Rect | null
  flip_h: boolean; flip_v: boolean; blend_mode: BlendMode; speed: number
  fade_in_us: number; fade_out_us: number
}
export interface ImageOverlayParams {
  kind: 'ImageOverlay'; media: Uuid; transform: Transform; opacity: Animated<number>
  blend_mode: BlendMode; fade_in_us: number; fade_out_us: number
}
export interface TextParams {
  kind: 'Text'; content: string; font: FontSpec; color: Animated<Rgba>; align: TextAlign
  transform: Transform; opacity: Animated<number>; shadow: Shadow | null; outline: Outline | null
  intro: TextAnimPreset | null; outro: TextAnimPreset | null
  /** Layout box in composition px, LOCAL (pre-`scale`). Which fields are set IS
   *  the resize mode — no enum to contradict them: (null, null) auto width,
   *  (set, null) auto height (wraps), (set, set) fixed (wraps and shrinks to
   *  fit). Plain scalars, NOT `Animated`: a keyframed box would move the shrink
   *  factor every frame and rebuild the glyph atlas with it — `scale` is the
   *  animation channel for a text layer's size. See ADR 0049. */
  box_w: number | null
  box_h: number | null
  /** Where the text block sits INSIDE the box — orthogonal to
   *  `transform.anchor_y`, which places the box against `x`/`y`. */
  valign: VAlign
  /** Line leading; 0 = auto (the font's own metrics). */
  line_height: number
  letter_spacing: number
}
export interface MotifParams {
  kind: 'Motif'; motif_id: string; motif_version: number; props: Record<string, unknown>
  src_in_us: TimeUs; transform: Transform; opacity: Animated<number>
}
export interface MotifRebindEntry {
  layer_id: string; motif_id: string; motif_version: number; props: Record<string, unknown>
}
export interface AudioParams {
  kind: 'Audio'; media: Uuid; src_in_us: TimeUs; src_out_us: TimeUs
  gain_db: Animated<number>; pan: Animated<number>
  fade_in_us: number; fade_out_us: number; mute: boolean; role: AudioRole
}
export interface ColorParams { kind: 'Color'; color: Animated<Rgba>; width: number; height: number }
/** A Group layer: a media-bearing layer whose SOURCE is another composition
 *  (ADR 0052 §4). `src_in_us`/`src_out_us` window the referenced composition's
 *  time exactly as VideoClip/Audio window their media, so the source duration is
 *  `compositions[composition].duration_us`. Validation puts NO upper bound on
 *  `src_out_us` — overhang is tolerated in state and clamped at the gesture
 *  (ADR 0052 §6): rejecting it would refuse a delete INSIDE the Group whenever
 *  autofit shrank the duration under a parent's window. */
export interface CompositionRefParams {
  kind: 'CompositionRef'; composition: Uuid; src_in_us: TimeUs; src_out_us: TimeUs
  transform: Transform; opacity: Animated<number>; blend_mode: BlendMode
}
export type LayerParams =
  | VideoClipParams | ImageOverlayParams | TextParams | MotifParams | AudioParams | ColorParams | CompositionRefParams

export interface Effect { id: Uuid; kind: string; enabled: boolean; params: Record<string, Animated<number>> }
export interface Layer {
  id: Uuid; label: string | null; t_start_us: TimeUs; t_end_us: TimeUs
  enabled: boolean; locked: boolean; metadata: Record<string, unknown>
  params: LayerParams; effects: Effect[]
}
export interface Track {
  id: Uuid; label: string | null; enabled: boolean; locked: boolean
  muted: boolean; solo: boolean; removable: boolean; role: TrackRole | null
  transient: boolean; height_px: number; layers: Layer[]
}
/** What an anchored marker points at: one layer, and a time in that layer's
 *  SOURCE domain (the same domain `src_in_us`/`src_out_us` window). Source
 *  time, not timeline time, is what makes the tie survive a trim or a move —
 *  the frame the user marked keeps its identity however the clip is later cut.
 *  Named so the ops that set and clear it can type against the shape. */
export interface MarkerAnchor { layer: Uuid; src_us: TimeUs }
/** A point (`end_t_us === null`) or region annotation on ONE composition's
 *  timeline.
 *
 *  `label` and `note` are two fields, not one, because `label` has two
 *  consumers that force it short — the marker lane's inline text and the
 *  `Ctrl+K` result row. A paragraph in `label` ruins both, and merging the two
 *  sacrifices one side by construction; Premiere (Name + Comments) and Resolve
 *  (Name + Notes) split them for the same reason. `note` is the Panel's field
 *  and nothing else reads it.
 *
 *  `anchor` is TRUTH and `t_us` is a derived cache that nonetheless stays
 *  STORED: `reconcileMarkers` re-derives `t_us` on every commit as
 *  `snapFrameRound(layer.t_start_us + (anchor.src_us - params.src_in_us), …)`.
 *  Keeping the cache in state is the whole trick — every reader (ruler, Ctrl+K,
 *  summary projection, serialize, MCP, export) goes on reading `t_us` and needs
 *  no change, and the sorted-markers invariant keeps its meaning. Deriving at
 *  projection time instead would force each reader to re-resolve the anchor.
 *
 *  Following a clip is bought with a FIELD, not a second entity: a clip-marker
 *  type beside this one would fork every marker consumer, the same way a
 *  composition sub type would fork every walk (see `Composition` below). */
export interface Marker {
  id: Uuid; t_us: TimeUs; end_t_us: TimeUs | null
  label: string; note: string; color: Rgba
  /** null = a FREE marker: it marks the composition's own time and behaves
   *  exactly as every marker did before anchoring existed. */
  anchor: MarkerAnchor | null
}
/** Motion direction, not reveal side — semantics in native/src/state/transition.rs (the serde twin). */
export type TransitionDirection = 'left' | 'right' | 'up' | 'down'
export type TransitionKind =
  | { kind: 'Crossfade' }
  | { kind: 'Wipe'; direction: TransitionDirection }
  | { kind: 'Slide'; direction: TransitionDirection }
export interface Transition {
  id: Uuid; from_layer: Uuid; to_layer: Uuid; duration_us: TimeUs; kind: TransitionKind
  /** How many µs of the outgoing layer's tail this transition borrowed to open
   *  its overlap; 0 = pure placement overlap (both layers play exactly their
   *  trimmed ranges). `from_layer.t_end_us − extended_us` is the exit frame the
   *  user actually cut — the inverse ops route by it so remove/update give back
   *  ONLY borrowed material and move the incoming layer for the rest.
   *  Invariant `0 ≤ extended_us ≤ duration_us` (validate, structural). */
  extended_us: TimeUs
}
/** `members` kept sorted; `label` omitted (not null) when absent — see serialize.ts.
 *  Members are layers of ONE composition (validate checks them against that
 *  composition's own layer set, never the project-wide one). */
export interface Link { id: Uuid; label?: string; members: Uuid[] }
/** One timeline: settings + tracks + markers + transitions + links. The root and
 *  every Group share this shape (ADR 0052 §3) — there is no sub type, so every
 *  walk, mutation and validator has ONE path. `label` is null on the root and
 *  on an unnamed Group (the renderer derives "Group N"); unlike `Link.label` it
 *  is ALWAYS written (null, never omitted) — the Rust twin is a plain
 *  `Option<String>`. */
export interface Composition {
  id: Uuid; label: string | null
  /** The `N` a Group with no label is shown under — drawn from
   *  `Project.next_group_ordinal` at creation and never rewritten, so naming
   *  one Group renumbers no other and clearing a label gives a Group its
   *  original number back. Held INDEPENDENTLY of `label`, because a number
   *  derived from which compositions are unlabelled moves for every Group
   *  below the one being named.
   *  0 on the root, which is never shown as a Group; Groups are 1-based. */
  ordinal: number
  width: number; height: number; fps: Rational; duration_us: TimeUs; duration_pinned: boolean
  sample_rate: number; channels: number; color_space: ColorSpace; background: Rgba
  tracks: Track[]; markers: Marker[]; transitions: Transition[]; links: Link[]
}
/** The per-composition fields that are not timeline content — what a new Group
 *  copies from its parent at pre-compose, and what `project://composition` emits. */
export type CompositionSettings = Pick<Composition, 'width' | 'height' | 'fps' | 'sample_rate' | 'channels' | 'color_space' | 'background'>
export interface RoleMixSettings { gain_db: number; muted: boolean; solo: boolean }
export interface MediaVideoMetadata {
  width?: number; height?: number; fps_num?: number; fps_den?: number
  codec?: string; pix_fmt?: string; start_pts_us?: TimeUs | null
  nb_frames?: number | null; [k: string]: unknown
}
export interface MediaAudioMetadata {
  sample_rate?: number; channels?: number; codec?: string
  start_pts_us?: TimeUs | null; [k: string]: unknown
}
export interface MediaMetadata {
  /** Normalized content duration; timeline source windows use this domain. */
  duration_us: TimeUs | null
  /** Earliest container PTS that maps to content time 0, when known. */
  start_pts_us?: TimeUs | null
  /** Raw ffprobe duration before subtracting start offset, for diagnostics. */
  container_duration_us?: TimeUs | null
  video?: MediaVideoMetadata | null
  audio?: MediaAudioMetadata | null
  container_format?: string | null
  [k: string]: unknown
}
export interface MediaItem {
  id: Uuid; label: string | null; path_abs: string; path_rel: string | null; kind: 'Video' | 'Audio' | 'Image' | 'Subtitle'
  metadata: MediaMetadata; file_hash_blake3: string; file_size: number; file_mtime: number
  imported_at: string
  /** Where preview/export decode from + proxy readiness. Mirrors Rust
   *  `MediaItem.decode_route`; see ../../shared/decode-route. */
  decode_route: DecodeRoute
  conform_path: string | null; waveform_path: string | null; thumbnails_dir: string | null
}
export interface ProjectMetadata { name: string; created_at: string; modified_at: string; description: string | null }
/** The Shots Panel's review parameters: the score a candidate must exceed to
 *  become a boundary, and the shortest span the reduce keeps. Both are wire
 *  fields of `reduce_shot_report` and are range-checked against its bounds on
 *  the way in. `sensitivity` reads backwards — a higher value yields FEWER
 *  cuts — which is why it never reaches a label; see ADR 0057. */
export interface ShotReviewSettings { sensitivity: number; min_shot_us: number }
export interface ProjectSettings {
  preview_width: number; preview_height: number; autosave_interval_secs: number | null
  history_capacity: number; auto_pair_audio_on_import: boolean
  prefer_proxies: boolean
  proxy_overrides: Record<string, boolean>
  /** The reviewed detection parameters, or `null` for "whatever the detector
   *  defaults to". Null rather than a pair of numbers so no threshold literal
   *  lives in TypeScript at all: the defaults are Rust's
   *  (`Backend::shot_default_opts`), and a copy here would be free to drift
   *  from the value a zero-argument apply and `analyze_clip` both use. */
  shot_review: ShotReviewSettings | null
}
export interface Project {
  schema_version: number; project_id: Uuid; metadata: ProjectMetadata
  /** Keyed by `Composition.id` (validate: key === id). A plain object rather
   *  than a Map because the model is JSON-native end to end — Immer drafts it,
   *  `structuredClone` copies it and the wire shape IS this shape; the Rust twin
   *  is an `OrdMap` for its own reasons. The root is `compositions[root_id]`;
   *  a Group is another entry, referenced by a `CompositionRef` layer. */
  compositions: Record<Uuid, Composition>; root_id: Uuid
  /** The `ordinal` the next Group created in this project takes, then advanced.
   *  MONOTONIC — a number is never reused, so deleting Group 3 and creating
   *  another gives Group 4 and the list reads 1, 2, 4. Reuse (`max + 1`, or the
   *  lowest free slot) is rejected on correctness, not tidiness: delete the
   *  highest Group, create one, undo the delete, and two compositions carry the
   *  same number. Undo restores this counter with the rest of the snapshot, so
   *  a resurrected Group keeps the number it was born with. */
  next_group_ordinal: number
  media_pool: Record<string, MediaItem>; audio_roles: Record<string, RoleMixSettings>
  settings: ProjectSettings
}

/** A reserved-skeleton track. `label` is null because the name is DERIVED from
 *  `role` renderer-side (ADR 0042) — a literal written here could never be
 *  localized, and localizability is the whole point of the role stamp. */
function newTrack(id: Uuid, role: TrackRole): Track {
  return { id, label: null, enabled: true, locked: false, muted: false, solo: false,
    removable: false, role, transient: false, height_px: 64, layers: [] }
}
export function defaultCompositionSettings(): CompositionSettings {
  return { width: 1920, height: 1080, fps: { num: 30, den: 1 }, sample_rate: 48000, channels: 2,
    color_space: 'Bt709', background: { r: 0, g: 0, b: 0, a: 255 } }
}
/** Settings + the reserved A/B skeleton (ADR 0042), empty timeline. Mints the
 *  two track ids (A roll, then B roll); the caller mints `id` itself so it can
 *  choose where the composition id falls in the det-id order (see blankProject).
 *  Pre-compose builds here; blankProject inlines the same skeleton because its
 *  det-id order puts project_id between the two track ids and the root id.
 *
 *  `ordinal` is passed in rather than read off a project, because a composition
 *  is built before it joins one — the caller takes it from
 *  `Project.next_group_ordinal` and advances that counter. */
export function newComposition(id: Uuid, idGen: IdGen, label: string | null, ordinal: number, settings: CompositionSettings): Composition {
  const aRoll = newTrack(idGen(), 'ARoll')
  const bRoll = newTrack(idGen(), 'BRoll')
  return { id, label, ordinal, ...settings, duration_us: 0, duration_pinned: false,
    tracks: [aRoll, bRoll], markers: [], transitions: [], links: [] }
}
/** `compositions[root_id]` — validate guarantees it resolves (RootMissing). */
export function rootComposition(p: Project): Composition {
  return p.compositions[p.root_id]
}
/** Every layer of every composition, with its holders. */
export function* eachLayer(p: Pick<Project, 'compositions'>): Iterable<{ composition: Composition; track: Track; layer: Layer }> {
  for (const composition of Object.values(p.compositions))
    for (const track of composition.tracks)
      for (const layer of track.layers) yield { composition, track, layer }
}
export function defaultSettings(): ProjectSettings {
  return { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
    history_capacity: 200, auto_pair_audio_on_import: true,
    prefer_proxies: false, proxy_overrides: {}, shot_review: null }
}

/** Mirror of Rust `Project::new_blank`. Id order: A-roll, B-roll, project_id,
 *  root composition id — the root's id comes LAST so `…0001/0002/0003` keep
 *  their meaning in every det-id test. */
export function blankProject(idGen: IdGen, name: string): Project {
  const aRoll = newTrack(idGen(), 'ARoll')
  const bRoll = newTrack(idGen(), 'BRoll')
  const projectId = idGen()
  const rootId = idGen()
  // `ordinal: 0` is the root's reserved value — `groupOrdinals` skips the root,
  // and Groups count up from 1, so nothing the user sees can ever collide with it.
  const root: Composition = { id: rootId, label: null, ordinal: 0, ...defaultCompositionSettings(), duration_us: 0,
    duration_pinned: false, tracks: [aRoll, bRoll], markers: [], transitions: [], links: [] }
  // LANDMINE: real RFC3339 timestamps, NOT the '<TS>' sentinel. canonicalize()
  // normalizes these away for differential comparison, so a sentinel would pass
  // the gates — but this JSON still round-trips through Rust `DateTime<Utc>`
  // deserialization (`serde_json::from_str::<Project>`) in the export-audio
  // channels and the `project://compiled` MCP resource, which reject a
  // non-timestamp. Mirrors Rust `Project::new_blank`'s `Utc::now()`.
  const now = new Date().toISOString()
  return {
    schema_version: SCHEMA_VERSION, project_id: projectId,
    metadata: { name, created_at: now, modified_at: now, description: null },
    compositions: { [rootId]: root }, root_id: rootId, next_group_ordinal: 1,
    media_pool: {}, audio_roles: {}, settings: defaultSettings(),
  }
}
