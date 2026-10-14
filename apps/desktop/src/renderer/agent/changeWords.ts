// The words a review change is told in (ADR 0115): main hands facts
// (`Change.details`), this module words them in the editor's own vocabulary —
// the inspector's param names, the effect catalog's names, the History panel's
// verbs — and never an MCP tool's. Pure, and shared by every surface that
// describes a change (the Changes tab's rows, the timeline's tooltips), so a
// change reads the same wherever it is pointed at.
//
// Amounts are relative ("前移 2.0 秒"), never the baseline's timecodes: the
// baseline timeline is not on screen, so a time on it names nowhere.
import { AUDIO_EFFECTS } from '../../shared/audioEffects/catalog'
import { VISUAL_EFFECT_PARAMS } from '../../shared/effects/params'
import type { Change, ChangeAspect, ChangeDetail } from '../../shared/review'
import type { ProjectSummary } from '../ipc'
import { animatableParams } from '../keyframe/descriptors'
import { groupDisplayName } from '../lib/layerName'
import { trackDisplayName } from '../lib/trackName'
import { formatSeconds, type CarriedAlong } from './changeModel'

/** Structurally typed so `useTranslation().t` passes straight through (as
 *  `layerDisplayName` does). */
export type Translate = (key: string, values: Record<string, unknown>) => string

export interface ChangeWordsContext {
  t: Translate
  /** A track's display name, or null when it is gone. `compositionId` is the
   *  change's own composition, searched first. */
  trackName: (trackId: string, compositionId: string | null) => string | null
  /** A composition's display name, or null when it is gone. */
  compositionName: (compositionId: string) => string | null
}

/** The resolvers over the project as it is now. A null summary resolves
 *  nothing (every place falls back to its generic word). */
export function changeWordsContext(
  t: Translate,
  summary: ProjectSummary | null,
  ordinals: ReadonlyMap<string, number> | undefined,
): ChangeWordsContext {
  return {
    t,
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

/** Every locale key a fact type can be worded with — the locale parity test
 *  reads it, and the `Record` makes a new fact type fail typecheck here until
 *  it has words. */
export const DETAIL_KEYS: Record<ChangeDetail['type'], readonly string[]> = {
  length: ['changes.detail.length_added', 'changes.detail.length_removed'],
  trim: ['changes.detail.trim_start_cut', 'changes.detail.trim_start_extend', 'changes.detail.trim_end_cut', 'changes.detail.trim_end_extend'],
  shift: ['changes.detail.shift_earlier', 'changes.detail.shift_later'],
  slip: ['changes.detail.slip_earlier', 'changes.detail.slip_later'],
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

// ---- facts -----------------------------------------------------------------

/** One fact in words. Exhaustive: a new `ChangeDetail` type fails typecheck
 *  at the `never` until it is worded. */
function describeDetail(d: ChangeDetail, change: Pick<Change, 'class' | 'composition_id'>, ctx: ChangeWordsContext): string {
  const { t } = ctx
  switch (d.type) {
    case 'length':
      return t(change.class === 'removed' ? 'changes.detail.length_removed' : 'changes.detail.length_added', { s: formatSeconds(d.duration_us) })
    case 'trim':
      return t(`changes.detail.trim_${d.side}_${d.delta_us < 0 ? 'cut' : 'extend'}`, { s: formatSeconds(d.delta_us) })
    case 'shift':
      return t(d.delta_us < 0 ? 'changes.detail.shift_earlier' : 'changes.detail.shift_later', { s: formatSeconds(d.delta_us) })
    case 'slip':
      return t(d.delta_us < 0 ? 'changes.detail.slip_earlier' : 'changes.detail.slip_later', { s: formatSeconds(d.delta_us) })
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

/** What a change did, in one line: its facts in order, joined. A change with
 *  no facts says its aspects; an added or removed one with neither says
 *  nothing (its badge and title already do). */
export function describeChange(change: Change, ctx: ChangeWordsContext): string {
  const facts = change.details.map(d => describeDetail(d, change, ctx))
  if (facts.length) return facts.join(FACT_SEPARATOR)
  return change.aspects.map(a => ctx.t(`changes.aspect_${a}`, {})).join(FACT_SEPARATOR)
}

/** What a carrier moved along by one amount (`carriedAlong`), as one of its
 *  sub-lines: "后面 5 个片段随之前移 4.0 秒". */
export function describeCarried({ delta_us: delta, clips, markers: marks }: CarriedAlong, t: Translate): string {
  const clipWords = t('changes.n_clips', { count: clips }), markWords = t('changes.n_markers', { count: marks })
  const what = clips && marks ? t('changes.detail.clips_and_markers', { clips: clipWords, markers: markWords }) : marks ? markWords : clipWords
  return t(delta < 0 ? 'changes.detail.carried_earlier' : 'changes.detail.carried_later', { what, s: formatSeconds(delta) })
}
