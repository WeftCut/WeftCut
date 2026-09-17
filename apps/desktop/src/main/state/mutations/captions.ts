import type { Composition, Project, Rgba, TextAlign, TextParams, Track, Uuid } from '../model'
import { locateLayerIn, requireLayer, requireSameComposition, scopeComposition } from './helpers'
import { applyDeleteLayer } from './delete'
import { CommandFailure } from '../errors'
import type { IdGen } from '../ids'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { quantizeExtentPx, quantizeParam } from '../quantize'
import { applyAddLayer, defaultTransform } from './add'
import { DEFAULT_CAPTION_FONT_FAMILY } from '../../../shared/fonts'

/** subtitles/mod.rs CueStyle — per-cue style hints (all optional; absent ⇒
 *  the default caption look applies). `align` is the ASS 9-grid (1..9). */
export interface CueStyle {
  font_family?: string | null
  size_px?: number | null
  primary?: Rgba | null
  bold?: boolean
  italic?: boolean
  outline_px?: number | null
  outline_color?: Rgba | null
  shadow_px?: number | null
  align?: number | null
  pos?: [number, number] | null
}
/** subtitles/mod.rs Cue — one subtitle cue (text keeps explicit '\n'). */
export interface Cue { start_us: number; end_us: number; text: string; style?: CueStyle; metadata?: Record<string, unknown> }

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 }

/** Per-side safe-area margin, as a fraction of the composition edge: the inset
 *  `anchorFor` positions a cue at, and — doubled — the frame width the caption
 *  box gives up. One constant for both, because the position margin and the wrap
 *  width have to agree and two literals that must agree are how they stop
 *  agreeing. Twin of `SAFE_AREA_MARGIN` in subtitles/layout.rs. */
const SAFE_AREA_MARGIN = 0.08

/** subtitles/layout.rs:21 cue_to_text_params — lay out one cue as a Text layer.
 *  Styleless cues get white fill + black outline and no shadow, size 5% of comp
 *  height, bottom-centre inside `SAFE_AREA_MARGIN`. The ASS 9-grid align (or
 *  \pos) becomes an absolute anchor + position. NOTE the f32 keystone: size_px /
 *  outline width / shadow offsets / box_w are f32 in Rust — the differential
 *  corpus supplies explicit clean style values so the auto-multiply paths (this
 *  fn's `size * 0.06` and the wrap width) are never differential-gated (they ARE
 *  unit-tested above). Keep the arithmetic in the same order as the Rust twin. */
export function cueToTextParams(cue: Cue, compW: number, compH: number): TextParams {
  const s = cue.style ?? {}
  const size = s.size_px ?? Math.round(compH * 0.05)
  const primary = s.primary ?? WHITE
  const outlineW = Math.max(s.outline_px ?? size * 0.06, 1.0)
  // No default shadow. A styleless cue (SRT/VTT) is white text with a black
  // outline and nothing else — the outline alone is what keeps it legible over
  // any picture, and a shadow on top of it read as a black smear no inspector
  // field could switch off. An ASS style says what it wants: a positive `Shadow`
  // depth becomes the offset, and an explicit 0 is honoured as "none" rather
  // than lifted to 1 px. Positive depths keep the 1 px floor a sub-pixel shadow
  // has always had. TWIN: `subtitles/layout.rs`, same predicate, same floor.
  const shadowPx = s.shadow_px ?? null
  const shadowOff = shadowPx !== null && shadowPx > 0 ? Math.max(shadowPx, 1.0) : null
  const an = s.align ?? 2
  const [[anchorX, anchorY], baseX, baseY] = anchorFor(an, compW, compH)
  // Quantized to the same authored precision an inspector edit would get. This is
  // the one place a LAYOUT calculation lands in the store rather than a value some
  // person typed, and it needs the rounding more, not less — nobody authored these
  // digits, `compH * 0.08` did. The margin lands on a clean tenth at the standard
  // heights (1080 → 993.6) but on a hundredth at most others (1081 → 993.52), and
  // an ASS `\pos` carries whatever the subtitle file wrote. A caption import
  // writes hundreds of layers in one command, so whatever this produces, it
  // produces at scale.
  //
  // TWIN: `subtitles/layout.rs` cue_to_text_params rounds at the same point, in
  // the same order. Guarded the way this function's other computed values are —
  // by MIRRORED unit tests on both sides, not by the differential corpus, which
  // supplies explicit style values and so never exercises the paths that compute
  // rather than copy (see the note on this function).
  const [rawX, rawY] = s.pos ?? [baseX, baseY]
  const x = quantizeParam('x', rawX)
  const y = quantizeParam('y', rawY)
  return {
    kind: 'Text', content: cue.text,
    font: { family: s.font_family ?? DEFAULT_CAPTION_FONT_FAMILY, size_px: size, weight: s.bold ? 700 : 400, italic: s.italic ?? false },
    color: { mode: 'Static', value: primary },
    align: alignFor(an),
    transform: { ...defaultTransform(), position: { mode: 'XY', x: { mode: 'Static', value: x }, y: { mode: 'Static', value: y } }, anchor_x: { mode: 'Static', value: anchorX }, anchor_y: { mode: 'Static', value: anchorY } },
    opacity: { mode: 'Static', value: 1 },
    shadow: shadowOff === null ? null : { color: BLACK, offset_x: shadowOff, offset_y: shadowOff, blur: shadowOff },
    outline: { color: s.outline_color ?? BLACK, width: outlineW },
    intro: null, outro: null,
    // Auto height, never Fixed: it wraps a transcript's unbroken line without
    // shrinking, so every cue keeps the size its style asked for. Fixed would
    // compress the long ones and make two cues of one file render at different
    // sizes. valign is never observable here — the height tracks the content.
    // See ADR 0049.
    box_w: quantizeExtentPx(compW * (1 - 2 * SAFE_AREA_MARGIN)), box_h: null, valign: 'Middle', line_height: 0, letter_spacing: 0,
  }
}

/** layout.rs:81 anchor_for — ASS 9-grid → (anchor, x, y). 1-3 bottom, 4-6 middle,
 *  7-9 top; 1/4/7 left, 2/5/8 centre, 3/6/9 right, inset by `SAFE_AREA_MARGIN`
 *  on both axes (f64). */
function anchorFor(an: number, w: number, h: number): [[number, number], number, number] {
  const mx = w * SAFE_AREA_MARGIN, my = h * SAFE_AREA_MARGIN
  let ax: number, x: number
  if (an === 1 || an === 4 || an === 7) { ax = 0.0; x = mx }
  else if (an === 3 || an === 6 || an === 9) { ax = 1.0; x = w - mx }
  else { ax = 0.5; x = w / 2.0 }
  let ay: number, y: number
  if (an === 7 || an === 8 || an === 9) { ay = 0.0; y = my }
  else if (an === 4 || an === 5 || an === 6) { ay = 0.5; y = h / 2.0 }
  else { ay = 1.0; y = h - my }
  return [[ax, ay], x, y]
}
/** layout.rs:97 align_for. */
function alignFor(an: number): TextAlign {
  if (an === 1 || an === 4 || an === 7) return 'Left'
  if (an === 3 || an === 6 || an === 9) return 'Right'
  return 'Center'
}

/** Batch style applied to a caption track's Text layers. null/absent =
 *  "don't touch". `outline_width` 0 (or below) REMOVES the outline: a zero-width
 *  stroke is not a stroke, and storing it as `null` is the same absent style the
 *  Text tool writes and a shadowless cue carries — one representation of "none",
 *  so the renderer's `o ? stroke : nothing` gate and the Panel's seed read agree. */
export interface CaptionStylePatch {
  font_family?: string | null
  font_size_px?: number | null
  color?: Rgba | null
  outline_width?: number | null
}

/** add_caption_track — lay the cues onto Caption tracks (one Text layer per
 *  cue), packing into the caption tracks the composition ALREADY HAS before
 *  opening a new one (ADR 0070). Cues stable-sorted by start_us; each cue goes to
 *  the FIRST unlocked Caption-role track, in track order, whose layers leave the
 *  cue's snapped span free, else a new Caption track is appended after the
 *  existing tracks and joins the candidates. Existing tracks come first because
 *  they precede anything appended, so a second transcription of the same
 *  timeline lands beside the first instead of above it — a new lane opens only
 *  where a cue truly collides with one already there.
 *
 *  The free test is the same-track overlap rule `pickFreeOverlayTrack` applies to
 *  every other placement, on the snapped bounds `applyAddLayer` will store: two
 *  cues that touch (end == start) share a lane, two that overlap by a frame do
 *  not. Locked tracks are never candidates, for that helper's reason — a locked
 *  lane must not receive content any more than it may lose it.
 *
 *  Returns the track the FIRST cue landed on — an existing one when it had room.
 *  Empty cues still open one empty Caption track. ★ ID ORDER: opening a lane
 *  mints the track id (newCaptionTrack → idGen) BEFORE the layer id (applyAddLayer
 *  → idGen) — the seeded-id tests pin that order. No explicit autofit
 *  (applyAddLayer autofits per layer). Scoped to `compositionId`, the root by
 *  default: only THAT composition's caption tracks are candidates, and a new lane
 *  opens there. */
export function applyAddCaptionTrack(p: Project, idGen: IdGen, cues: Cue[], compW: number, compH: number, label: string | null, compositionId?: Uuid | null): Uuid {
  const c = scopeComposition(p, compositionId)
  const grid = gridForLayerKind('Text', c.fps)
  const sorted = cues.slice().sort((a, b) => (a.start_us < b.start_us ? -1 : a.start_us > b.start_us ? 1 : 0)) // stable by start_us
  // Candidates in the order they are tried: the composition's own unlocked
  // caption tracks first, then every lane this call opens, appended as it opens.
  const lanes: Track[] = c.tracks.filter((t) => t.role === 'Caption' && !t.locked)
  let first: Uuid | null = null
  for (const cue of sorted) {
    const s = snapOnGrid(cue.start_us, grid)
    const e = snapOnGrid(cue.end_us, grid)
    let lane = lanes.find((t) => spanFree(t, s, e))
    if (!lane) { lane = newCaptionTrack(c, idGen, label); lanes.push(lane) }
    const layerId = applyAddLayer(p, idGen, lane.id, cueToTextParams(cue, compW, compH), cue.start_us, cue.end_us)
    if (cue.metadata) lane.layers.find(l => l.id === layerId)!.metadata = cue.metadata
    first ??= lane.id
  }
  return first ?? newCaptionTrack(c, idGen, label).id // empty-cues safety net (Track::new after the loop)
}

/** Whether no layer of `t` overlaps the half-open span `[s, e)` — the
 *  `pickFreeOverlayTrack` predicate, on one track. */
function spanFree(t: Track, s: number, e: number): boolean {
  return t.layers.every((l) => !(s < l.t_end_us && l.t_start_us < e))
}

/** Track::new() defaults + role=Caption, appended to the END of the track list
 *  (push_back). A role stamp makes it part of the reserved skeleton, so
 *  `transient` is false and emptying it never removes it — unlike every track
 *  `applyAddTrack` mints. */
function newCaptionTrack(c: Composition, idGen: IdGen, label: string | null): Track {
  const track: Track = { id: idGen(), label, enabled: true, locked: false, muted: false, solo: false,
    removable: true, role: 'Caption', transient: false, height_px: 64, layers: [] }
  c.tracks.push(track)
  return track
}

/** Patch every Text layer of ONE track with a caption style patch; non-Text
 *  layers skipped. */
function restyleTrackTextLayers(track: Track, patch: CaptionStylePatch): void {
  for (const layer of track.layers) if (layer.params.kind === 'Text') restyleTextLayer(layer.params, patch)
}

/** One caption's restyle. A positive outline_width keeps the existing outline
 *  color (or BLACK if none); zero removes the outline (see `CaptionStylePatch`). */
function restyleTextLayer(tp: TextParams, patch: CaptionStylePatch): void {
  {
    if (patch.font_family !== undefined && patch.font_family !== null) tp.font.family = patch.font_family
    if (patch.font_size_px !== undefined && patch.font_size_px !== null) tp.font.size_px = patch.font_size_px
    if (patch.color !== undefined && patch.color !== null) tp.color = { mode: 'Static', value: patch.color }
    if (patch.outline_width !== undefined && patch.outline_width !== null) {
      if (patch.outline_width <= 0) {
        tp.outline = null
      } else {
        const existingColor = tp.outline ? tp.outline.color : BLACK
        tp.outline = { color: existingColor, width: patch.outline_width }
      }
    }
  }
}

/** restyle_captions — the Project-wide caption corpus restyle: patch EVERY
 *  caption-role Track's Text layers, in every composition, in one commit, so
 *  overlapping caption lanes restyle atomically as one undo entry. Non-caption
 *  tracks are untouched. There is no TrackNotFound — a project may legitimately
 *  hold zero caption tracks, in which case this is a no-op (commit's no-op guard
 *  then records nothing). */
export function applyRestyleCaptions(p: Project, patch: CaptionStylePatch, layerIds: readonly Uuid[] | null = null): void {
  if (layerIds === null) { for (const track of captionTracks(p)) restyleTrackTextLayers(track, patch); return }
  // Narrowed: only the named captions — each must BE one, so a title from
  // add_text_layer cannot be restyled through the caption door by mistake.
  for (const id of new Set(layerIds)) {
    const { track, layer } = requireLayer(p, id)
    if (track.role !== 'Caption' || layer.params.kind !== 'Text') throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: `layer ${id} is not a caption (a Text layer on a Caption track); a title is styled with update_layer_params` })
    restyleTextLayer(layer.params, patch)
  }
}

/** What a merge did: the cue that absorbed the others, and the ones removed. */
export interface MergeCaptionsResult { layer: Uuid; removed: Uuid[] }

/** merge_captions — fold two or more cues of ONE caption track into the
 *  earliest: its span becomes the union, its text the texts joined by a line
 *  break in time order, its style stays; the rest are deleted. A gap between
 *  them is spanned; a cue of another lane in between makes the union overlap
 *  it, which validate refuses (`LayerOverlap`) — the merge is per lane. */
export function applyMergeCaptions(p: Project, ids: readonly Uuid[]): MergeCaptionsResult {
  const unique = [...new Set(ids)]
  if (unique.length < 2) throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: 'merge_captions needs two or more captions' })
  const c = requireSameComposition(p, unique) // LayerNotFound / CrossCompositionSet
  const located = unique.map((id) => {
    const loc = locateLayerIn(c, id)!
    if (loc.track.role !== 'Caption' || loc.layer.params.kind !== 'Text') throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: `layer ${id} is not a caption (a Text layer on a Caption track)` })
    return loc
  })
  const trackId = located[0].track.id
  if (located.some((l) => l.track.id !== trackId)) throw new CommandFailure({ error: 'InvalidArgument', field: 'layer_ids', detail: 'captions to merge must sit on ONE caption track — merge per lane, or move them together first' })
  if (located[0].track.locked) throw new CommandFailure({ error: 'TrackLocked', track: trackId })
  located.sort((x, y) => x.layer.t_start_us - y.layer.t_start_us)
  const keep = located[0].layer
  const tp = keep.params as TextParams
  tp.content = located.map((l) => (l.layer.params as TextParams).content).join('\n')
  keep.t_end_us = Math.max(...located.map((l) => l.layer.t_end_us))
  const removed = located.slice(1).map((l) => l.layer.id)
  for (const id of removed) applyDeleteLayer(p, id)
  return { layer: keep.id, removed }
}

/** Every caption-role track across the project — the corpus `restyle_captions`
 *  patches and the actor's affected set for it. */
export function captionTracks(p: Project): Track[] {
  const out: Track[] = []
  for (const c of Object.values(p.compositions)) for (const t of c.tracks) if (t.role === 'Caption') out.push(t)
  return out
}
