// apps/desktop/src/main/lint/checkComposition.ts
//
// `check_composition` v1 (spec H1-D5): the craft rules a composition breaks,
// read from project data alone (Q11) — no pixels, no audio analysis. Pure: a
// project, a composition id and the merged taste in; findings keyed to a
// revision out. The host keeps the last result per composition to answer
// whether an audit is fresh (H1-D6).
//
// Text extents are ESTIMATED from the params (a glyph advance of 0.55 em and
// a line of 1.25 em), because text layout runs in the renderer. Rules that
// depend on them say so in their message and err toward silence: a finding
// that is wrong costs the agent a round, a missed one costs nothing new.

import { createHash } from 'node:crypto'
import type { Animated } from '../../shared/keyframe'
import { captionLimits, craftRule, styleThreshold, type CraftSeverity } from '../../shared/craft'
import type { Composition, Layer, Project, Rgba, TextParams } from '../state/model'
import { canonicalString } from '../state/canonical'
import type { TasteView } from '../taste/view'
import { BUILTIN_GRAPHIC_ROLES } from '../../shared/graphicRole'
import type { TextTokens } from '../taste/schema'
import { motifTokenProps } from '../taste/motifProps'

export interface Finding {
  severity: CraftSeverity
  rule: string
  /** Composition time, µs, [start, end). */
  range: [number, number]
  layers: string[]
  message: string
  fix: string
}

export interface CheckResult {
  composition_id: string
  /** Changes with the composition's content or the taste it was checked
   *  against; a stored result is fresh while this still matches. */
  revision: string
  findings: Finding[]
  counts: Record<CraftSeverity, number>
}

const ADVANCE_EM = 0.55
const LINE_EM = 1.25
const REF_HEIGHT = 1080

const first = <T>(a: Animated<T>): T => (a.mode === 'Static' ? a.value : a.value[0]!.value)
const seconds = (us: number) => Math.round(us / 1e4) / 100
const roleOf = (l: Layer): string | null => ((l.params as { graphic_role?: string | null }).graphic_role ?? null)

export function compositionRevision(comp: Composition, taste: TasteView | null): string {
  return createHash('sha256').update(canonicalString(comp)).update('\0').update(taste?.revision ?? '').digest('hex')
}

/** Estimated box of a text layer in composition px, at its first value. */
function textBox(p: TextParams) {
  const size = p.font.size_px * Math.abs(first(p.transform.scale_y))
  const lines = p.content.split('\n')
  const longest = Math.max(1, ...lines.map((l) => l.length))
  const naturalW = longest * size * ADVANCE_EM * Math.abs(first(p.transform.scale_x))
  const w = p.box_w ?? naturalW
  const wraps = p.box_w ? lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * size * ADVANCE_EM) / p.box_w!)), 0) : lines.length
  const h = p.box_h ?? wraps * size * LINE_EM
  const pos = p.transform.position.mode === 'XY' ? { x: first(p.transform.position.x), y: first(p.transform.position.y) } : null
  if (!pos) return null
  const left = pos.x - first(p.transform.anchor_x) * w, top = pos.y - first(p.transform.anchor_y) * h
  return { left, top, right: left + w, bottom: top + h }
}

const hex = (c: Rgba) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() + (c.a === 255 ? '' : c.a.toString(16).padStart(2, '0').toUpperCase())

function tokenHex(tokens: TasteView['tokens'], value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const v = value.startsWith('#') ? value : tokens.palette?.[value]
  if (!v) return undefined
  const up = v.toUpperCase()
  return up.length === 9 && up.endsWith('FF') ? up.slice(0, 7) : up
}

/** The fields of a text layer that a role's look is made of. */
function look(p: TextParams) {
  return { family: p.font.family, size_px: p.font.size_px, weight: p.font.weight, color: hex(first(p.color)) }
}

export function checkComposition(project: Project, compositionId: string, taste: TasteView | null, range?: [number, number]): CheckResult {
  const comp = project.compositions[compositionId]
  if (!comp) throw new Error(`no composition ${compositionId}`)
  const findings: Finding[] = []
  const floors = taste?.tokens.floors ?? {}
  const captions = captionLimits(taste?.tokens)
  const scale = comp.height / REF_HEIGHT
  const limit = (id: string): number => styleThreshold(id, floors[id])
  const add = (rule: string, l: Layer | Layer[], message: string, fix: string) => {
    const ls = Array.isArray(l) ? l : [l]
    findings.push({ severity: craftRule(rule).severity, rule, range: [Math.min(...ls.map((x) => x.t_start_us)), Math.max(...ls.map((x) => x.t_end_us))], layers: ls.map((x) => x.id), message, fix })
  }
  const known = new Set<string>(taste ? taste.roles.map((r) => r.name) : BUILTIN_GRAPHIC_ROLES)
  const byRole = new Map<string, Array<{ layer: Layer; p: TextParams }>>()
  const motifsByRole = new Map<string, Layer[]>()
  // Titles and lower thirds are held long enough to read, whatever draws them.
  const hold = (l: Layer, role: string | null, dur: number) => {
    if (role !== 'title' && role !== 'lower_third') return
    const id = role === 'title' ? 'title-hold' : 'lower-third-hold'
    const min = limit(id)
    if (dur < min - 1e-3) add(id, l, `${role.replace('_', ' ')} on screen ${seconds(l.t_end_us - l.t_start_us)} s, under ${min} s`, `extend it to at least ${min} s`)
  }

  for (const track of comp.tracks) {
    const isCaption = track.role === 'Caption'
    for (const l of track.layers) {
      if (!l.enabled) continue
      const dur = (l.t_end_us - l.t_start_us) / 1e6
      const role = roleOf(l)
      if (role !== null && !known.has(role))
        add('undeclared-role', l, `graphic role ${role} is neither built in nor declared in the project's style or TASTE.md`, `declare ${role} under roles in TASTE.md, or use a built-in role`)

      if (l.params.kind === 'VideoClip' && track.role === 'ARoll') {
        const min = limit('short-clip')
        if (dur < min - 1e-3) add('short-clip', l, `A-roll clip is ${dur.toFixed(2)} s, under ${min} s`, 'merge it into a neighbour or extend it; a fragment this short reads as a stutter')
      }
      if (l.params.kind === 'Motif' && !isCaption) {
        // A Motif's entrance is its own, so only the hold and the role's
        // consistency are checked here.
        hold(l, role, dur)
        if (role !== null && role !== 'none') {
          motifsByRole.set(role, [...(motifsByRole.get(role) ?? []), l])
          const drift = motifDrift(l.params, role, taste)
          if (drift.length) add('token-drift', l, `${role.replace('_', ' ')} Motif differs from its style tokens: ${drift.join(', ')}`, 'restyle_to_taste, or keep it if the departure is deliberate')
        }
        continue
      }
      if (l.params.kind !== 'Text') continue
      const p = l.params
      const box = textBox(p)
      if (box) {
        if (box.right <= 0 || box.bottom <= 0 || box.left >= comp.width || box.top >= comp.height)
          add('text-offscreen', l, `text box (estimated) lies wholly outside the ${comp.width}×${comp.height} frame`, 'move it into the frame')
        else if (!isCaption) {
          const safe = limit('title-safe')
          const mx = (comp.width * (1 - safe)) / 2, my = (comp.height * (1 - safe)) / 2
          if (box.left < mx - 1 || box.top < my - 1 || box.right > comp.width - mx + 1 || box.bottom > comp.height - my + 1)
            add('title-safe', l, `text box (estimated) leaves the title-safe area (centred ${Math.round(safe * 100)} %)`, 'move it inward or reduce its size')
        }
      }
      if (isCaption) {
        const maxChars = captions.max_chars, maxLines = captions.max_lines
        const lines = p.content.split('\n')
        const longest = Math.max(...lines.map((x) => x.length))
        if (longest > maxChars) add('caption-line-length', l, `caption line of ${longest} characters, over ${maxChars}`, `break or split the cue so each line holds at most ${maxChars}`)
        if (lines.length > maxLines) add('caption-lines', l, `caption cue of ${lines.length} lines, over ${maxLines}`, 'split the cue in time')
        const minS = captions.min_cue_s, maxS = captions.max_cue_s
        if (dur < minS - 1e-3) add('caption-cue-min', l, `caption cue on screen ${dur.toFixed(2)} s, under ${minS} s`, 'merge it with a neighbouring cue')
        if (dur > maxS + 1e-3) add('caption-cue-max', l, `caption cue on screen ${dur.toFixed(2)} s, over ${maxS} s`, 'split it at a phrase boundary')
        const list = byRole.get('caption') ?? []; list.push({ layer: l, p }); byRole.set('caption', list)
        continue
      }
      if (role === 'title' || role === 'lower_third') {
        hold(l, role, dur)
        const missing = [p.intro === null ? 'intro' : null, p.outro === null ? 'outro' : null].filter(Boolean)
        if (missing.length) add('text-pops', l, `${role.replace('_', ' ')} has no ${missing.join(' or ')}: it pops ${missing.length === 2 ? 'on and off' : missing[0] === 'intro' ? 'on' : 'off'}`, 'set intro/outro, or restyle_to_taste for the style\'s')
      }
      if (role !== null && role !== 'none') {
        const drawn = taste?.motifs?.[role]
        if (drawn) add('role-motif', l, `${role.replace('_', ' ')} is plain text, but the style draws ${role} with the Motif ${drawn.ids.join(' or ')}`, `place ${drawn.ids[0]} with add_motif_layer (its props carry the text), or keep the text if it is meant`)
        const list = byRole.get(role) ?? []; list.push({ layer: l, p }); byRole.set(role, list)
        const tokens = taste?.tokens.text?.[role]
        if (tokens) {
          const drift = driftFields(p, tokens, taste!.tokens, scale)
          if (drift.length) add('token-drift', l, `${role} differs from its style tokens: ${drift.join(', ')}`, 'restyle_to_taste, or keep it if the departure is deliberate')
        }
      }
    }
  }

  for (const [role, list] of byRole) {
    const variants = new Map<string, Layer[]>()
    for (const { layer, p } of list) {
      const key = JSON.stringify(look(p))
      variants.set(key, [...(variants.get(key) ?? []), layer])
    }
    if (variants.size > 1) {
      const desc = [...variants.keys()].map((k) => { const v = JSON.parse(k); return `${v.family} ${v.size_px}px/${v.weight} ${v.color}` })
      add('role-inconsistency', list.map((x) => x.layer), `${role === 'caption' ? 'captions' : `${role} layers`} use ${variants.size} looks: ${desc.join('; ')}`, 'give them one look (restyle_to_taste sets the style\'s)')
    }
  }

  for (const [role, list] of motifsByRole) {
    const ids = [...new Set(list.map((l) => (l.params as { motif_id: string }).motif_id))]
    if (ids.length > 1) add('role-inconsistency', list, `${role} layers are drawn with ${ids.length} Motifs: ${ids.join(', ')}`, `draw every ${role} with one Motif${taste?.motifs?.[role] ? ` (the style's: ${taste.motifs[role]!.ids[0]})` : ''}`)
  }

  const inRange = range ? findings.filter((f) => f.range[0] < range[1] && f.range[1] > range[0]) : findings
  const order: Record<CraftSeverity, number> = { hard: 0, warning: 1, review: 2 }
  inRange.sort((a, b) => order[a.severity] - order[b.severity] || a.range[0] - b.range[0] || a.rule.localeCompare(b.rule))
  const counts = { hard: 0, warning: 0, review: 0 }
  for (const f of inRange) counts[f.severity]++
  return { composition_id: compositionId, revision: compositionRevision(comp, taste), findings: inRange, counts }
}

/** Token-backed props a role's Motif departs from. Fonts are left out: what
 *  they resolve to depends on the machine, which the lint does not know. */
function motifDrift(p: { motif_id: string; props: Record<string, unknown> }, role: string, taste: TasteView | null): string[] {
  const schema = taste?.motifs?.[role]?.motifs?.find((m) => m.id === p.motif_id)?.props_schema
  if (!schema) return []
  const want = motifTokenProps({ props_schema: schema }, taste!.tokens, null)
  const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' ? a.toUpperCase() === b.toUpperCase() : a === b
  return Object.entries(want).filter(([k, v]) => !k.startsWith('font_') && !same(p.props[k], v)).map(([k, v]) => `${k} ${String(p.props[k])} (style ${String(v)})`)
}

/** Token fields a tagged text layer departs from, at the composition's scale. */
function driftFields(p: TextParams, t: TextTokens, tokens: TasteView['tokens'], scale: number): string[] {
  const out: string[] = []
  if (t.size_px !== undefined && Math.abs(p.font.size_px - t.size_px * scale) > 0.5) out.push(`size ${p.font.size_px} px (style ${Math.round(t.size_px * scale * 10) / 10})`)
  if (t.weight !== undefined && p.font.weight !== t.weight) out.push(`weight ${p.font.weight} (style ${t.weight})`)
  if (t.family) if (p.font.family !== t.family) out.push(`family ${p.font.family} (style ${t.family})`)
  const want = tokenHex(tokens, t.color)
  if (want && hex(first(p.color)) !== want) out.push(`colour ${hex(first(p.color))} (style ${want})`)
  if (t.align !== undefined && p.align !== t.align) out.push(`align ${p.align} (style ${t.align})`)
  return out
}
