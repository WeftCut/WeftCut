// apps/desktop/src/main/state/summary.ts
import type { Animated, Composition, Effect, Link, Layer, LayerParams, Marker, MediaItem, Outline, Project, Rgba, RoleMixSettings, Shadow, TextAlign, Track, TransitionKind, Uuid, VAlign } from './model'
import type { HistoryStatus } from './history'
import { hasSourceWindow } from './mutations/helpers'
import type { DecodeRoute } from '../../shared/decode-route'

// ── per-kind view structs — the layer-params projection the renderer reads
//    (renderer/ipc/index.ts declares the same shapes; keep the two in step) ──
export interface VideoClipView {
  kind: 'VideoClip'; media_id: string; media_label: string; src_in_us: number; src_out_us: number
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; scale_linked: boolean; rotation_deg: Animated<number>; opacity: Animated<number>
  anchor_x: Animated<number>; anchor_y: Animated<number>
  speed: number; flip_h: boolean; flip_v: boolean; fade_in_us: number; fade_out_us: number
}
export interface ImageOverlayView {
  kind: 'ImageOverlay'; media_id: string; media_label: string
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; scale_linked: boolean; rotation_deg: Animated<number>; opacity: Animated<number>
  anchor_x: Animated<number>; anchor_y: Animated<number>
  fade_in_us: number; fade_out_us: number
}
export interface TextView {
  kind: 'Text'; content: string; font_family: string; font_size_px: number; weight: number; italic: boolean
  color: Animated<Rgba>; align: TextAlign; x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; scale_linked: boolean; rotation_deg: Animated<number>; anchor_x: Animated<number>; anchor_y: Animated<number>
  opacity: Animated<number>; shadow: Shadow | null; outline: Outline | null
  /** Layout box, plain scalars (never `Animated` — see `TextParams.box_w`).
   *  Which fields are set IS the resize mode, so both nulls must survive the
   *  projection: coalescing either to a number here would invent a Fixed box
   *  the user never drew. */
  box_w: number | null; box_h: number | null
  valign: VAlign; line_height: number; letter_spacing: number
}
export interface ColorView { kind: 'Color'; color: Animated<Rgba>; width: number; height: number }
export interface AudioView {
  kind: 'Audio'; media_id: string; media_label: string; src_in_us: number; src_out_us: number
  gain_db: Animated<number>; pan: Animated<number>; fade_in_us: number; fade_out_us: number; mute: boolean; role: string
}
export interface MotifView {
  kind: 'Motif'; motif_id: string
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; scale_linked: boolean; rotation_deg: Animated<number>; opacity: Animated<number>
  anchor_x: Animated<number>; anchor_y: Animated<number>
  src_in_us: number; props: Record<string, unknown>
}
/** A Group layer's projection. `composition_label` is the referenced
 *  composition's own label (null → the renderer derives "Group N"). */
export interface CompositionRefView {
  kind: 'CompositionRef'; composition_id: string; composition_label: string | null
  src_in_us: number; src_out_us: number
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; scale_linked: boolean; rotation_deg: Animated<number>; opacity: Animated<number>
  anchor_x: Animated<number>; anchor_y: Animated<number>
}
export type LayerParamsView = VideoClipView | ImageOverlayView | TextView | ColorView | AudioView | MotifView | CompositionRefView

export function layerKind(params: LayerParams): string { return params.kind }

/** `TrackSummary.kind` — the dominant layer class, which the timeline CSS and the
 *  drop checks read. Visual-class wins; audio-only → "Audio"; empty → "Video"
 *  (so blank A/B-roll rows still style as video lanes).
 *
 *  NOT a name, and no longer in any naming chain: `renderer/lib/trackName.ts` is
 *  the single answer to what a lane is called (ADR 0042). Falling back to this
 *  would tell the user "Video" where the header reads "A roll". */
export function deriveTrackKindLabel(track: Track): string {
  let hasVisual = false, hasAudio = false
  for (const l of track.layers) {
    if (l.params.kind === 'Audio') hasAudio = true
    else hasVisual = true // VideoClip | ImageOverlay | Color | Motif | Text | CompositionRef
  }
  if (hasVisual) return 'Video'
  if (hasAudio) return 'Audio'
  return 'Video'
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** Cosmetic; only hue 0 is gated. h is a non-negative integer hue. */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r: number, g: number, b: number
  const hi = Math.trunc(h)
  if (hi <= 59) { r = c; g = x; b = 0 }
  else if (hi <= 119) { r = x; g = c; b = 0 }
  else if (hi <= 179) { r = 0; g = c; b = x }
  else if (hi <= 239) { r = 0; g = x; b = c }
  else if (hi <= 299) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const ch = (v: number) => clamp(Math.round((v + m) * 255), 0, 255)
  return `#${hex2(ch(r))}${hex2(ch(g))}${hex2(ch(b))}`
}

function rgbaHex(c: Rgba): string { return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` }

/** Color clip → its exact rgba (Static, or the first keyframe value, BLACK if
 *  none); else a stable hue from the uuid's first two bytes (hex-parsed from
 *  the UUID string). */
export function layerColorHint(layer: Layer): string {
  if (layer.params.kind === 'Color') {
    const a = layer.params.color
    const rgba = a.mode === 'Static' ? a.value : (a.value[0]?.value ?? { r: 0, g: 0, b: 0, a: 255 })
    return rgbaHex(rgba)
  }
  // Uuid::as_bytes() returns the 16 RAW bytes (NOT the string's ASCII); the canonical UUID string's hex-pairs reproduce them — parseInt("3f",16)=0x3f matches Rust bytes[0].
  const hex = layer.id.replace(/-/g, '')
  const b0 = parseInt(hex.slice(0, 2), 16), b1 = parseInt(hex.slice(2, 4), 16)
  const hue = ((b0 << 8) | b1) % 360
  return hslToHex(hue, 0.55, 0.55)
}

/** A marker's color hint is plain `#rrggbb` — no alpha on the wire. */
export function markerColorHint(c: Rgba): string { return rgbaHex(c) }

/** Is this marker anchored to source material its layer no longer shows?
 *
 *  Such a marker HIBERNATES: kept in state, not painted on the timeline, and
 *  revived the instant the trim is undone or the layer re-extended. That is the
 *  point of storing the tie in SOURCE time — the exact frame comes back for
 *  free, where burning the marker on a trim would throw it away. Hibernating is
 *  therefore a legal state, not a defect: `validate.ts` deliberately does not
 *  range-check `anchor.src_us`.
 *
 *  Half-open window on purpose. `src_out_us` is the EXCLUSIVE end — the source
 *  time just past the last frame the layer shows — so a mark sitting exactly on
 *  it is already outside, exactly as `t_end_us` is outside a layer's span.
 *
 *  A missing anchor layer, or one whose kind carries no source window, reads as
 *  hibernating rather than free: the marker still claims a tie, and answering
 *  "free" would have the lane paint it as an ordinary composition mark at a
 *  `t_us` nothing is maintaining any more. Neither case survives `validate`
 *  (`MarkerAnchorNotInComposition` / `MarkerAnchorLayerHasNoSourceWindow`), so
 *  this arm covers the window between a mutation and the commit that rejects it.
 *
 *  ONE definition, and it is this one: `reconcileMarkers` decides what to
 *  re-derive by asking the same question this projection answers, so the lane
 *  can never disagree with the reconcile about which markers are asleep. */
export function markerHibernating(c: Composition, m: Marker): boolean {
  if (m.anchor === null) return false
  const anchor = m.anchor
  for (const track of c.tracks) {
    for (const layer of track.layers) {
      if (layer.id !== anchor.layer) continue
      if (!hasSourceWindow(layer.params)) return true
      return anchor.src_us < layer.params.src_in_us || anchor.src_us >= layer.params.src_out_us
    }
  }
  return true
}

/** Explicit label, else path basename, else the whole path. */
export function mediaLabel(item: MediaItem): string {
  if (item.label != null) return item.label
  const p = item.path_abs
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = slash >= 0 ? p.slice(slash + 1) : p
  return base.length > 0 ? base : p
}

function mediaLabelFor(id: Uuid, pool: Record<Uuid, MediaItem>): string {
  const m = pool[id]
  return m ? mediaLabel(m) : id
}

/** Kind-matched UI projection. NOTE: the Motif arm is covered by unit tests
 *  only (summary.test.ts) — no integration fixture builds a Motif layer.
 *  `compositions` resolves a CompositionRef's label; the other arms never read it. */
export function layerParamsView(params: LayerParams, pool: Record<Uuid, MediaItem>, compositions: Record<Uuid, Composition> = {}): LayerParamsView {
  switch (params.kind) {
    case 'VideoClip': {
      const t = params.transform
      return { kind: 'VideoClip', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        src_in_us: params.src_in_us, src_out_us: params.src_out_us, x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y, scale_linked: t.scale_linked, rotation_deg: t.rotation_deg,
        anchor_x: t.anchor_x, anchor_y: t.anchor_y,
        opacity: params.opacity, speed: params.speed, flip_h: params.flip_h, flip_v: params.flip_v,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us }
    }
    case 'ImageOverlay': {
      const t = params.transform
      return { kind: 'ImageOverlay', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y, scale_linked: t.scale_linked, rotation_deg: t.rotation_deg, opacity: params.opacity,
        anchor_x: t.anchor_x, anchor_y: t.anchor_y,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us }
    }
    case 'Text': {
      const t = params.transform
      return { kind: 'Text', content: params.content, font_family: params.font.family, font_size_px: params.font.size_px,
        weight: params.font.weight, italic: params.font.italic, color: params.color, align: params.align,
        x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y, scale_linked: t.scale_linked, rotation_deg: t.rotation_deg,
        anchor_x: t.anchor_x, anchor_y: t.anchor_y, opacity: params.opacity,
        shadow: params.shadow, outline: params.outline,
        box_w: params.box_w, box_h: params.box_h, valign: params.valign,
        line_height: params.line_height, letter_spacing: params.letter_spacing }
    }
    case 'Color':
      return { kind: 'Color', color: params.color, width: params.width, height: params.height }
    case 'Audio':
      return { kind: 'Audio', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        src_in_us: params.src_in_us, src_out_us: params.src_out_us, gain_db: params.gain_db, pan: params.pan,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us, mute: params.mute, role: params.role }
    case 'Motif': {
      const t = params.transform
      return { kind: 'Motif', motif_id: params.motif_id, x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y, scale_linked: t.scale_linked, rotation_deg: t.rotation_deg,
        anchor_x: t.anchor_x, anchor_y: t.anchor_y,
        opacity: params.opacity, src_in_us: params.src_in_us, props: params.props }
    }
    case 'CompositionRef': {
      const t = params.transform
      return { kind: 'CompositionRef', composition_id: params.composition, composition_label: compositions[params.composition]?.label ?? null,
        src_in_us: params.src_in_us, src_out_us: params.src_out_us,
        x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y, scale_linked: t.scale_linked, rotation_deg: t.rotation_deg, opacity: params.opacity,
        anchor_x: t.anchor_x, anchor_y: t.anchor_y }
    }
  }
}

// ── top-level view types ──

/** One composition's timeline, settings and the four collections that live on
 *  it — the root and every Group project to this same shape (ADR 0052 §3).
 *  `fps_locked` is HISTORY-scoped and therefore project-wide: one lattice, one
 *  answer, repeated on every entry so a consumer holding one composition never
 *  has to reach for another. */
export interface CompositionSummary {
  id: string
  /** The composition's own label; null on the root and on an unnamed Group
   *  (the renderer derives "Group N"). */
  label: string | null
  /** The stored `N` behind a derived "Group N" — see model.ts `Composition`.
   *  Projected verbatim, and carried even on a LABELLED Group: the label is
   *  what the UI shows, the ordinal is what it falls back to when the label is
   *  cleared. */
  ordinal: number
  width: number; height: number; fps_num: number; fps_den: number
  /** EXCLUSIVE end boundary of the timeline `[0, duration_us)`, never a frame anchor. */
  duration_us: number
  duration_pinned: boolean
  /** Would a `set_composition { fps }` be rejected right now? True once the
   *  timeline holds a layer OR any stored snapshot/checkpoint does (spec R2-D1,
   *  history-scoped — see actor.setComposition). Lets the settings panel disable
   *  the rate control instead of offering a click that always errors. Read-only:
   *  the actor's own check stays the source of truth. */
  fps_locked: boolean
  tracks: TrackSummary[]; markers: MarkerSummary[]; transitions: TransitionView[]; links: LinkSummary[]
}
export interface HistoryView { cursor: number; len: number; can_undo: boolean; can_redo: boolean; lock_reason?: string }
export interface RoleMixView { role: string; gain_db: number; muted: boolean; solo: boolean }
export interface LinkSummary { id: string; label: string | null; layer_ids: string[] }
export interface MarkerSummary {
  id: string; t_us: number; end_t_us: number | null
  /** The short name — lane text and `Ctrl+K` row. */
  label: string
  /** The long text (model.ts `Marker.note`). Projected beside `label` rather
   *  than fetched on demand: it is one string, and the Panel that edits it
   *  reads the same rows the lane draws. */
  note: string
  color_hint: string
  /** The layer this marker follows, or null when it is FREE. An id, not a
   *  nested layer view: `tracks` already carries the layer, and a second copy
   *  here would be a second thing to keep in step. */
  anchor_layer: string | null
  /** The instant the anchor names in that layer's SOURCE domain, null when the
   *  marker is FREE. Projected rather than left to the renderer because it
   *  cannot be recovered there: a HIBERNATING marker's `t_us` is frozen at a
   *  moment whose window has since moved, so mapping it back would produce a
   *  source time the marker never named. It is the only position such a marker
   *  still has, and the marker Panel is the only surface that shows it. */
  anchor_src_us: number | null
  /** Anchored at source material its layer no longer shows — see
   *  `markerHibernating`. Always false for a free marker. */
  hibernating: boolean
}
/** Wire shape == model shape (model.ts `Transition`) — the compositor's
 *  two-input node consumes it verbatim in both realms (preview snapshot and
 *  the export Worker's structured-clone of this summary). */
export interface TransitionView { id: string; from_layer: string; to_layer: string; duration_us: number; kind: TransitionKind; extended_us: number }
export interface MediaSummary {
  id: string; label: string; path: string; kind: string; duration_us: number | null
  start_pts_us: number | null; container_duration_us: number | null
  width: number | null; height: number | null; size_bytes: number; available: boolean
  decode_route: DecodeRoute
  codec: string | null; pix_fmt: string | null; color_matrix: string | null; color_range: string | null
  color_primaries: string | null; color_transfer: string | null; video_start_pts_us: number | null
  audio_start_pts_us: number | null; conform_path: string | null
  /// Probed source channel count, null when the media has no audio stream or
  /// hasn't been probed yet. The waveform generator always downmixes to
  /// stereo for storage, so this is the only reliable mono/stereo signal.
  audio_channels: number | null
}
export interface LayerSummary {
  id: string; label: string | null; t_start_us: number; t_end_us: number; kind: string; color_hint: string
  enabled: boolean; locked: boolean; params: LayerParamsView; effects: Effect[]
}
export interface TrackSummary {
  id: string; kind: string; label: string | null; enabled: boolean; locked: boolean; muted: boolean; solo: boolean
  role: string | null; transient: boolean; layers: LayerSummary[]
}
export interface ProjectSummary {
  project_id: string; name: string
  /** `compositions[root_id]` is what export renders; the renderer's scope store
   *  picks which entry its timeline and panels show. */
  root_id: string
  compositions: Record<string, CompositionSummary>
  /** Counted over EVERY composition — a project-wide figure, not the root's. */
  track_count: number; layer_count: number
  history: HistoryView
  media: MediaSummary[]; audio_roles: RoleMixView[]
}

// The kebab wire form of TrackRole — what renderer/ipc/index.ts declares. The
// serialized project keeps the PascalCase variant; this spelling is view-only.
// Exported because a derived track NAME is keyed on the wire spelling too
// (history-labels.ts), and two hand-written mappings would drift.
export const TRACK_ROLE_WIRE: Record<string, string> = { ARoll: 'a-roll', BRoll: 'b-roll', AudioA: 'audio-a', AudioB: 'audio-b', Caption: 'caption' }

// `AudioRole::ALL` order (state/audio_role.rs); default-filled per role.
const ROLE_ORDER = ['dialogue', 'music', 'sfx', 'voiceover'] as const
const DEFAULT_ROLE: RoleMixSettings = { gain_db: 0, muted: false, solo: false }

/** The read-only IPC view the renderer pulls on project:changed. Pure;
 *  `fileExists` is injected (filesystem fields).
 *
 *  Every composition is projected, keyed by id; the renderer opens one of them
 *  and export reads the root. The projection of a composition is a pure
 *  function of that composition (plus the media pool and the label lookup for
 *  its Group references), so a one-composition project's root entry is exactly
 *  the timeline the flat summary used to carry. */
export function buildProjectSummary(p: Project, history: HistoryStatus, fileExists: (absPath: string) => boolean): ProjectSummary {
  const all = Object.values(p.compositions)
  const track_count = all.reduce((n, c) => n + c.tracks.length, 0)
  const layer_count = all.reduce((n, c) => n + c.tracks.reduce((m, t) => m + t.layers.length, 0), 0)

  const fileOrNull = (path: string | null | undefined): string | null => (path && fileExists(path) ? path : null)
  // The decode route's readiness paths are existence-gated the same way the
  // flat proxy fields were: a serialized-but-deleted proxy must read as "not
  // ready" (null), never as a stale path. Gate each variant's slots in place.
  const routeForSummary = (r: DecodeRoute): DecodeRoute => {
    switch (r.route) {
      case 'bypass': return r
      case 'direct-export': return { route: 'direct-export', quick_proxy: fileOrNull(r.quick_proxy) }
      case 'proxied': return {
        route: 'proxied', quick_proxy: fileOrNull(r.quick_proxy),
        full_proxy: fileOrNull(r.full_proxy), format_version: r.format_version,
      }
      case 'native-sw': return {
        route: 'native-sw', quick_proxy: fileOrNull(r.quick_proxy),
        full_proxy: fileOrNull(r.full_proxy), format_version: r.format_version,
      }
    }
  }
  const media: MediaSummary[] = Object.values(p.media_pool).map((m: MediaItem) => {
    const video = m.metadata.video as Record<string, unknown> | null | undefined
    const audio = m.metadata.audio as Record<string, unknown> | null | undefined
    return {
      id: m.id, label: mediaLabel(m), path: m.path_abs, kind: m.kind, duration_us: m.metadata.duration_us,
      start_pts_us: m.metadata.start_pts_us ?? null,
      container_duration_us: m.metadata.container_duration_us ?? null,
      width: (video?.width as number | undefined) ?? null, height: (video?.height as number | undefined) ?? null,
      size_bytes: m.file_size, available: fileExists(m.path_abs),
      decode_route: routeForSummary(m.decode_route),
      codec: (video?.codec as string | undefined) ?? null, pix_fmt: (video?.pix_fmt as string | undefined) ?? null,
      color_matrix: (video?.color_matrix as string | undefined) ?? null, color_range: (video?.color_range as string | undefined) ?? null,
      color_primaries: (video?.color_primaries as string | undefined) ?? null, color_transfer: (video?.color_transfer as string | undefined) ?? null,
      video_start_pts_us: (video?.start_pts_us as number | undefined) ?? null,
      audio_start_pts_us: (audio?.start_pts_us as number | undefined) ?? null,
      conform_path: fileOrNull(m.conform_path),
      audio_channels: (audio?.channels as number | undefined) ?? null,
    }
  })
  media.sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0)) // b.id.cmp(&a.id) — descending

  const compositionSummary = (c: Composition): CompositionSummary => ({
    id: c.id, label: c.label, ordinal: c.ordinal, width: c.width, height: c.height, fps_num: c.fps.num, fps_den: c.fps.den,
    duration_us: c.duration_us, duration_pinned: c.duration_pinned, fps_locked: history.holds_layer_anywhere,
    tracks: c.tracks.map((t: Track): TrackSummary => ({
      id: t.id, kind: deriveTrackKindLabel(t), label: t.label, enabled: t.enabled, locked: t.locked,
      muted: t.muted, solo: t.solo, role: t.role != null ? TRACK_ROLE_WIRE[t.role] : null, transient: t.transient,
      layers: t.layers.map((l: Layer): LayerSummary => ({
        id: l.id, label: l.label, t_start_us: l.t_start_us, t_end_us: l.t_end_us, kind: layerKind(l.params),
        color_hint: layerColorHint(l), enabled: l.enabled, locked: l.locked,
        params: layerParamsView(l.params, p.media_pool, p.compositions), effects: l.effects,
      })),
    })),
    markers: c.markers.map((m: Marker): MarkerSummary => ({
      id: m.id, t_us: m.t_us, end_t_us: m.end_t_us, label: m.label, note: m.note,
      color_hint: markerColorHint(m.color),
      anchor_layer: m.anchor === null ? null : m.anchor.layer,
      anchor_src_us: m.anchor === null ? null : m.anchor.src_us,
      hibernating: markerHibernating(c, m),
    })),
    transitions: c.transitions.map((t): TransitionView => ({
      id: t.id, from_layer: t.from_layer, to_layer: t.to_layer, duration_us: t.duration_us, kind: t.kind, extended_us: t.extended_us,
    })),
    links: c.links.map((g: Link): LinkSummary => ({ id: g.id, label: g.label ?? null, layer_ids: g.members })),
  })
  const compositions: Record<string, CompositionSummary> = {}
  for (const c of all) compositions[c.id] = compositionSummary(c)

  const audio_roles: RoleMixView[] = ROLE_ORDER.map((role) => {
    const s = p.audio_roles[role] ?? DEFAULT_ROLE
    return { role, gain_db: s.gain_db, muted: s.muted, solo: s.solo }
  })

  const view: ProjectSummary = {
    project_id: p.project_id, name: p.metadata.name, root_id: p.root_id, compositions,
    track_count, layer_count,
    history: { cursor: history.cursor, len: history.len, can_undo: history.can_undo, can_redo: history.can_redo },
    media, audio_roles,
  }
  if (history.lock_reason !== undefined) view.history.lock_reason = history.lock_reason
  return view
}
