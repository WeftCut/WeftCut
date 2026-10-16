// The words a review change is told in (ADR 0115): main hands facts
// (`Change.details`), this module words them in the editor's own vocabulary —
// the inspector's param names, the effect catalog's names, the History panel's
// verbs — and never an MCP tool's. Pure, and the one source of words for
// every surface that tells of a change — the Changes tab's rows, the
// timeline's tooltips, ghosts and badges, the mini timeline's bands — so a
// change reads the same wherever it is pointed at.
//
// What a change is told against is its frame: the Review baseline, or — under
// an activity's highlight — the project just before that agent call. Every
// word that names the "before" is said through the frame (`framedWords`).
import { AUDIO_EFFECTS } from '../../shared/audioEffects/catalog'
import { VISUAL_EFFECT_PARAMS } from '../../shared/effects/params'
import { parseEntityKey, type Change, type ChangeAspect, type ChangeDetail } from '../../shared/review'
import { formatTimecode } from '../frames'
import type { LayerSummary, ProjectSummary } from '../ipc'
import { animatableParams } from '../keyframe/descriptors'
import { groupDisplayName, layerDisplayName } from '../lib/layerName'
import { trackDisplayName } from '../lib/trackName'
import type { ChangeSource } from './reviewFocus'

/** Structurally typed so `useTranslation().t` passes straight through (as
 *  `layerDisplayName` does). */
export type Translate = (key: string, values: Record<string, unknown>) => string

/** What a change is told against: the Review baseline (`review`), or the
 *  project just before one agent call (`activity`, its highlight). */
export type ChangeFrame = ChangeSource

export interface ChangeWordsContext {
  t: Translate
  frame: ChangeFrame
  /** A track's display name, or null when it is gone. `compositionId` is the
   *  change's own composition, searched first. */
  trackName: (trackId: string, compositionId: string | null) => string | null
  /** A composition's display name, or null when it is gone. */
  compositionName: (compositionId: string) => string | null
  /** A clip's display name, or null when it is gone. */
  layerName: (layerId: string) => string | null
  /** A marker's label in `compositionId`, or null when it is gone or has none. */
  markerLabel: (compositionId: string, markerId: string) => string | null
  /** A composition's frame rate, or null when it is gone. */
  fps: (compositionId: string) => { num: number; den: number } | null
}

/** The project the words resolve names in: the project store's own fields. */
export interface WordsProject {
  summary: ProjectSummary | null
  layerById?: ReadonlyMap<string, LayerSummary> | undefined
  groupOrdinals?: ReadonlyMap<string, number> | undefined
}

/** The resolvers over the project as it is now. A null summary resolves
 *  nothing (every place falls back to its generic word). */
export function changeWordsContext(t: Translate, project: WordsProject, frame: ChangeFrame = 'review'): ChangeWordsContext {
  const { summary, layerById, groupOrdinals: ordinals } = project
  return {
    t,
    frame,
    layerName: id => {
      const l = layerById?.get(id)
      return l ? layerDisplayName(l, t, ordinals) : null
    },
    markerLabel: (compositionId, markerId) =>
      summary?.compositions[compositionId]?.markers.find(m => m.id === markerId)?.label.trim() || null,
    fps: id => {
      const c = summary?.compositions[id]
      return c ? { num: c.fps_num, den: c.fps_den } : null
    },
    trackName: (trackId, compositionId) => {
      if (!summary) return null
      const own = compositionId ? summary.compositions[compositionId] : undefined
      for (const comp of own ? [own, ...Object.values(summary.compositions)] : Object.values(summary.compositions)) {
        const track = comp.tracks.find(x => x.id === trackId)
        if (track) return trackDisplayName(track, comp.tracks, t)
      }
      return null
    },
    compositionName: id => {
      if (!summary) return null
      if (id === summary.root_id) return t('changes.group_root', {})
      const comp = summary.compositions[id]
      return comp ? groupDisplayName(id, comp.label, ordinals, t) : null
    },
  }
}

/** Facts are joined with this, in either locale. */
const FACT_SEPARATOR = ' · '
/** How many param names a fact lists before "and N more". */
const MAX_NAMES = 3

/** Words that name the "before" a change is told against, each with an
 *  `_activity` twin for an activity's highlight (`changes.<key>[_activity]`). */
export const FRAMED_KEYS = ['before_label', 'before_span', 'before_point', 'ghost_label', 'ghost_tag', 'was_label', 'group_badge', 'marker_ghost_label'] as const
export type FramedKey = typeof FRAMED_KEYS[number]

/** A framed word in the context's frame. */
export function framedWords(ctx: Pick<ChangeWordsContext, 't' | 'frame'>, key: FramedKey, values: Record<string, unknown> = {}): string {
  return ctx.t(`changes.${key}${ctx.frame === 'activity' ? '_activity' : ''}`, values)
}

/** Every locale key a fact type can be worded with — the locale parity test
 *  reads it, and the `Record` makes a new fact type fail typecheck here until
 *  it has words. */
export const DETAIL_KEYS: Record<ChangeDetail['type'], readonly string[]> = {
  length: ['changes.detail.length_added', 'changes.detail.length_removed'],
  time: ['changes.detail.time_start', 'changes.detail.time_end', 'changes.detail.time_source_start', 'changes.detail.time_source_end'],
  trim: ['changes.detail.trim_start_cut', 'changes.detail.trim_start_extend', 'changes.detail.trim_end_cut', 'changes.detail.trim_end_extend'],
  track: ['changes.detail.track_from_to', 'changes.detail.track_to', 'changes.detail.track_other'],
  composition: ['changes.detail.composition_to', 'changes.detail.composition_other'],
  speed: ['changes.detail.speed', 'changes.detail.speed_changed'],
  params: ['changes.detail.list_separator', 'changes.detail.names_more', 'changes.aspect_params'],
  keyframes: ['changes.detail.list_separator', 'changes.detail.names_more', 'changes.detail.keyframes', 'changes.aspect_keyframes'],
  effect: [
    'changes.detail.effect_added', 'changes.detail.effect_added_any',
    'changes.detail.effect_removed', 'changes.detail.effect_removed_any',
    'changes.detail.effect_changed', 'changes.detail.effect_changed_any',
  ],
  label: ['changes.detail.label'],
  enabled: ['changes.detail.enabled', 'changes.detail.disabled'],
  locked: ['changes.detail.locked', 'changes.detail.unlocked'],
  aspect: (['placement', 'timing', 'retime', 'params', 'effects', 'keyframes', 'label', 'flags'] satisfies ChangeAspect[]).map(a => `changes.aspect_${a}`),
}

// ---- param names -----------------------------------------------------------

/** Wire keys the inspector edits outside the keyframe descriptors (static
 *  fields), by the label its row carries. */
const STATIC_PARAM_LABELS: Readonly<Record<string, string>> = {
  position: 'property_panel.position',
  transform: 'property_panel.transform',
  scale_linked: 'property_panel.scale',
  content: 'property_panel.content',
  font: 'property_panel.font_family',
  box_w: 'property_panel.text_box_w',
  box_h: 'property_panel.text_box_h',
  align: 'property_panel.align',
  valign: 'property_panel.valign',
  line_height: 'property_panel.line_height',
  letter_spacing: 'property_panel.letter_spacing',
  outline: 'property_panel.text_outline',
  flip_h: 'property_panel.flip_h',
  flip_v: 'property_panel.flip_v',
  fade_in_us: 'property_panel.fade_in',
  fade_out_us: 'property_panel.fade_out',
  width: 'property_panel.width',
  height: 'property_panel.height',
  role: 'property_panel.role',
  props: 'property_panel.props',
  media: 'property_panel.media',
}
/** An axis label the inspector shows inside its owner's row ("X" in the
 *  Position row) reads as "Position X" out of it. */
const OWNER_LABELS: Readonly<Record<string, string>> = { x: 'property_panel.position', y: 'property_panel.position' }

/** paramKey → the inspector's label key: every keyframeable param of every
 *  kind (both position modes, scale unlinked so each axis keeps its own name),
 *  then the static fields. */
const PARAM_LABELS: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>()
  for (const kind of ['VideoClip', 'Text', 'Audio', 'Color'])
    for (const mode of ['XY', 'Path'] as const)
      for (const d of animatableParams(kind, false, mode)) if (!out.has(d.paramKey)) out.set(d.paramKey, d.labelKey)
  for (const [k, v] of Object.entries(STATIC_PARAM_LABELS)) if (!out.has(k)) out.set(k, v)
  return out
})()

/** An inspector label without its unit ("Rotation (°)" → "Rotation"): in a
 *  sentence the unit names nothing. */
const withoutUnit = (label: string) => label.replace(/\s*[（(][^（）()]*[）)]\s*$/, '')

/** A param's name as the inspector labels it, or null for a key it does not
 *  show (never the raw key: that is wire vocabulary). */
export function paramName(key: string, t: Translate): string | null {
  const labelKey = PARAM_LABELS.get(key)
  if (!labelKey) return null
  const name = withoutUnit(t(labelKey, {}))
  const owner = OWNER_LABELS[key]
  return owner ? `${t(owner, {})} ${name}` : name
}

/** Param names joined, at most `MAX_NAMES` then "and N more"; unknown keys only
 *  count. Null when no key has a name. */
function paramList(keys: readonly string[], t: Translate): string | null {
  const names = [...new Set(keys.map(k => paramName(k, t)).filter((n): n is string => n !== null))]
  if (!names.length) return null
  const unknown = keys.filter(k => paramName(k, t) === null).length
  const shown = names.slice(0, MAX_NAMES).join(t('changes.detail.list_separator', {}))
  const more = names.length - Math.min(names.length, MAX_NAMES) + unknown
  return more > 0 ? t('changes.detail.names_more', { names: shown, count: more }) : shown
}

// ---- effect names ----------------------------------------------------------

/** An effect's catalog name ("Blur"), or null for a kind this build does not
 *  know. Visual kinds name themselves `effects.<kind>.name` (the realtime
 *  registry's convention); audio kinds carry their key in the shared catalog. */
export function effectName(kind: string, t: Translate): string | null {
  const key = VISUAL_EFFECT_PARAMS[kind] ? `effects.${kind}.name` : AUDIO_EFFECTS[kind]?.nameI18nKey
  if (!key) return null
  const name = t(key, { defaultValue: '' })
  return name && name !== key ? name : null
}

// ---- numbers ---------------------------------------------------------------

/** A playback rate as a percentage: 1 → "100%", 1/3 → "33.3%". */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%`
}

/** Seconds as a place or a length is said: at most three decimals, trailing
 *  zeros dropped but one kept — `4.0`, `1.25`, `0.04`. The exact frame is a
 *  timecode's to tell (a row's place, a ghost's tooltip). */
export function formatSeconds(us: number): string {
  const text = (us / 1_000_000).toFixed(3).replace(/0+$/, '')
  return text.endsWith('.') ? `${text}0` : text
}

/** Seconds as a measured before/after value is said: to the microsecond and
 *  signed, so no difference reads as none (`1.0 → 1.000001`). */
function formatExactSeconds(us: number): string {
  const value = (us / 1_000_000).toFixed(6).replace(/0+$/, '')
  return value.endsWith('.') ? `${value}0` : value
}

// ---- facts -----------------------------------------------------------------

/** One fact in words. Exhaustive: a new `ChangeDetail` type fails typecheck
 *  at the `never` until it is worded. */
function describeDetail(d: ChangeDetail, change: Pick<Change, 'class' | 'composition_id'>, ctx: ChangeWordsContext): string {
  const { t } = ctx
  switch (d.type) {
    case 'length':
      return t(change.class === 'removed' ? 'changes.detail.length_removed' : 'changes.detail.length_added', { s: formatSeconds(d.duration_us) })
    case 'time':
      return t('changes.detail.time_' + d.field, { from: formatExactSeconds(d.from_us), to: formatExactSeconds(d.to_us) })
    case 'trim':
      return t(`changes.detail.trim_${d.side}_${d.delta_us < 0 ? 'cut' : 'extend'}`, { s: formatExactSeconds(Math.abs(d.delta_us)) })
    case 'track': {
      const from = d.from === null ? null : ctx.trackName(d.from, change.composition_id)
      const to = d.to === null ? null : ctx.trackName(d.to, change.composition_id)
      if (from && to) return t('changes.detail.track_from_to', { from, to })
      return to ? t('changes.detail.track_to', { to }) : t('changes.detail.track_other', {})
    }
    case 'composition': {
      const name = ctx.compositionName(d.to)
      return name ? t('changes.detail.composition_to', { name }) : t('changes.detail.composition_other', {})
    }
    case 'speed':
      return d.from !== null && d.to !== null
        ? t('changes.detail.speed', { from: formatRate(d.from), to: formatRate(d.to) })
        : t('changes.detail.speed_changed', {})
    case 'params':
      return paramList(d.keys, t) ?? t('changes.aspect_params', {})
    case 'keyframes': {
      const names = paramList(d.keys, t)
      return names ? t('changes.detail.keyframes', { names }) : t('changes.aspect_keyframes', {})
    }
    case 'effect': {
      const name = effectName(d.effect, t)
      return name ? t(`changes.detail.effect_${d.op}`, { name }) : t(`changes.detail.effect_${d.op}_any`, {})
    }
    case 'label': return t('changes.detail.label', {})
    case 'enabled': return t(d.value ? 'changes.detail.enabled' : 'changes.detail.disabled', {})
    case 'locked': return t(d.value ? 'changes.detail.locked' : 'changes.detail.unlocked', {})
    case 'aspect': return t(`changes.aspect_${d.aspect}`, {})
    default: {
      const unworded: never = d
      return String((unworded as { type: unknown }).type)
    }
  }
}

/** The facts a change is told by. An edge measured as a trim is said by
 *  the trim alone: its raw timeline and source values say the same cut again
 *  in other units (they stay on the change, unworded). */
function toldDetails(change: Pick<Change, 'details'>): ChangeDetail[] {
  const trimmed = new Set(change.details.flatMap(d => (d.type === 'trim' ? [d.side] : [])))
  if (trimmed.size === 0) return change.details
  return change.details.filter(d => d.type !== 'time' || !trimmed.has(d.field === 'start' || d.field === 'source_start' ? 'start' : 'end'))
}

/** Whether a change's words already state its whole current place — both
 *  timeline edges, or the start of a point (a point marker has no end) —
 *  so it needs no second notation beside them. */
export function statesPlace(change: Pick<Change, 'details' | 'ranges'>): boolean {
  const told = toldDetails(change)
  const point = change.ranges.length > 0 && change.ranges.every(r => r.t_end_us <= r.t_start_us)
  const fields = point ? (['start'] as const) : (['start', 'end'] as const)
  return fields.every(f => told.some(d => d.type === 'time' && d.field === f))
}

/** What a change did, in one line: its facts in order, joined. An added or
 *  removed one without a length says nothing (its badge and title already do). */
export function describeChange(change: Change, ctx: ChangeWordsContext): string {
  return toldDetails(change).map(d => describeDetail(d, change, ctx)).join(FACT_SEPARATOR)
}

/** A change pointed at from the timeline — a clip's tooltip, a cut mark, a
 *  mini timeline band: its class, then what it did. */
export function changeLine(change: Change, ctx: ChangeWordsContext): string {
  const cls = ctx.t(`changes.class_${change.class}`, {})
  const what = describeChange(change, ctx)
  return what ? ctx.t('changes.clip_title', { cls, what }) : cls
}

/** What a change names: the clip, marker, track or Group as the rest of the
 *  app names it while it exists; a removed one by its baseline name; its kind
 *  when it has none. A track says it is one: inside a new Group its derived
 *  name ("A roll") repeats the root's. */
export function changeTitle(c: Change, ctx: ChangeWordsContext): string {
  const { t } = ctx
  const { kind, id } = parseEntityKey(c.id)
  const fallback = t(`changes.kind_${kind}`, {})
  if (c.class === 'removed') return kind === 'Track' && c.before_name ? t('changes.track_title', { name: c.before_name }) : c.before_name ?? fallback
  switch (kind) {
    case 'Layer': return ctx.layerName(id) ?? fallback
    case 'Marker': return (c.composition_id ? ctx.markerLabel(c.composition_id, id) : null) || fallback
    case 'Track': { const name = ctx.trackName(id, c.composition_id); return name ? t('changes.track_title', { name }) : fallback }
    case 'Composition': return ctx.compositionName(id) ?? fallback
    default: return fallback
  }
}

/** Where a change is on the timeline — or, removed, where it was before — in
 *  the seconds its facts speak ("Now 2.5 – 4.0 s"), its timecode for a
 *  tooltip. Null when its facts already say its whole current place, or it
 *  has no place on a composition that exists. */
export function changePlace(c: Change, ctx: ChangeWordsContext): { text: string; timecode: string } | null {
  if (statesPlace(c)) return null
  const ranges = c.ranges.length ? c.ranges : c.before_ranges ?? []
  const r = ranges.find(x => x.composition_id === c.composition_id) ?? ranges[0]
  const fps = r ? ctx.fps(r.composition_id) : null
  if (!r || !fps) return null
  const span = r.t_end_us > r.t_start_us
  const tc = formatTimecode(r.t_start_us, fps.num, fps.den)
  const timecode = span ? `${tc} – ${formatTimecode(r.t_end_us, fps.num, fps.den)}` : tc
  const values = span ? { start: formatSeconds(r.t_start_us), end: formatSeconds(r.t_end_us) } : { t: formatSeconds(r.t_start_us) }
  const shape = span ? 'span' : 'point'
  const text = c.ranges.length ? ctx.t(`changes.position_${shape}`, values) : framedWords(ctx, `before_${shape}`, values)
  return { text, timecode }
}
