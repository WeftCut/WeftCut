// apps/desktop/src/main/taste/schema.ts
//
// The style token schema, v1 (spec H1-D3): only fields that map onto params a
// layer already has, so every token can become a tool default. A STYLE.md and
// a TASTE.md carry the same shape — a style states every field it cares
// about, a TASTE only the ones it overrides — and one validator reads both.
//
// Validation never throws on author input. A bad field is dropped with a
// diagnostic naming its path, so the merged view falls back to the style's
// value for exactly that field and the rest of the file still applies.
//
// Pixel tokens (`size_px`, outline and shadow widths) are for a 1080-pixel-tall
// composition and scale with the composition's height; positions and box
// widths are fractions of the composition.

import { BUILTIN_GRAPHIC_ROLES, GRAPHIC_ROLE_PATTERN } from '../../shared/graphicRole'
import { PACE_RULES, type PaceTokens } from '../../shared/craft'

export type TasteSource = 'style' | 'taste'

export interface TasteDiagnostic {
  severity: 'error' | 'warning'
  source: TasteSource
  /** Dotted path of the offending field, when there is one. */
  path?: string
  message: string
}

export type ColorToken = string
export interface OutlineToken { color: ColorToken; width: number }
export interface ShadowToken { color: ColorToken; offset_x: number; offset_y: number; blur: number }
export type IntroToken = 'FadeIn' | 'SlideUp' | 'SlideDown' | 'Typewriter'
export type OutroToken = 'FadeOut' | 'SlideUp' | 'SlideDown'

export interface TextTokens {
  family?: string | null
  size_px?: number
  weight?: number
  italic?: boolean
  color?: ColorToken
  align?: 'Left' | 'Center' | 'Right'
  position?: [number, number]
  anchor?: [number, number]
  box_w?: number | null
  outline?: OutlineToken | null
  shadow?: ShadowToken | null
  intro?: IntroToken | null
  outro?: OutroToken | null
}

export interface CaptionTokens extends Omit<TextTokens, 'intro' | 'outro' | 'align'> {
  max_chars_per_line?: number
  max_lines?: number
  min_cue_s?: number
  max_cue_s?: number
}

export interface Tokens {
  palette?: Record<string, ColorToken>
  text?: Record<string, TextTokens>
  caption?: CaptionTokens
  /** Craft rule id → a tightened threshold. Whether a value tightens or
   *  loosens a rule is the lint's to judge (it knows the rule's direction). */
  floors?: Record<string, number>
  /** Motif prop key → the value every Motif with that prop takes by default
   *  (spec H2-D2). A string may name a palette colour, resolved against a
   *  `color` prop; its type is checked against each Motif's schema at use. */
  motif?: Record<string, string | number>
  /** Font slot → families in preference order. A Motif string prop
   *  `font_<slot>` takes the first one installed (spec H2-D4). */
  fonts?: Record<string, string[]>
  /** How dense an edit is (`shared/craft.ts` PACE_RULES): each key tightens
   *  one craft rule's threshold. */
  pace?: PaceTokens
}

export interface RoleDeclaration { name: string; description?: string }

/** Graphic role → the Motifs a style draws it with, in preference order. */
export type MotifsByRole = Record<string, string[]>

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const PALETTE_NAME = /^[a-z][a-z0-9_]{0,31}$/
const INTROS: readonly string[] = ['FadeIn', 'SlideUp', 'SlideDown', 'Typewriter']
const OUTROS: readonly string[] = ['FadeOut', 'SlideUp', 'SlideDown']
const ALIGNS: readonly string[] = ['Left', 'Center', 'Right']

type Out = { diagnostics: TasteDiagnostic[]; source: TasteSource }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function bad(o: Out, path: string, message: string) {
  o.diagnostics.push({ severity: 'error', source: o.source, path, message })
}

/** A colour is `#RRGGBB`, `#RRGGBBAA`, or the name of a palette entry. A name
 *  is checked against the merged palette by the consumer, not here: a TASTE
 *  may name a colour its style's palette defines. */
function color(o: Out, path: string, v: unknown): ColorToken | undefined {
  if (typeof v === 'string' && (HEX.test(v) || PALETTE_NAME.test(v))) return v
  bad(o, path, 'expected #RRGGBB, #RRGGBBAA or a palette name')
  return undefined
}

function num(o: Out, path: string, v: unknown, min: number, max: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v
  bad(o, path, `expected a number from ${min} to ${max}`)
  return undefined
}

function pair(o: Out, path: string, v: unknown, min: number, max: number): [number, number] | undefined {
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max)) return [v[0], v[1]]
  bad(o, path, `expected [x, y], each from ${min} to ${max}`)
  return undefined
}

function oneOf<T extends string>(o: Out, path: string, v: unknown, options: readonly string[], nullable: boolean): T | null | undefined {
  if (v === null && nullable) return null
  if (typeof v === 'string' && options.includes(v)) return v as T
  bad(o, path, `expected one of ${options.join(', ')}${nullable ? ' or null' : ''}`)
  return undefined
}

function outline(o: Out, path: string, v: unknown): OutlineToken | null | undefined {
  if (v === null) return null
  if (!isObj(v)) { bad(o, path, 'expected { color, width } or null'); return undefined }
  unknownKeys(o, path, v, ['color', 'width'])
  const c = color(o, `${path}.color`, v.color), w = num(o, `${path}.width`, v.width, 0, 100)
  return c === undefined || w === undefined ? undefined : { color: c, width: w }
}

function shadow(o: Out, path: string, v: unknown): ShadowToken | null | undefined {
  if (v === null) return null
  if (!isObj(v)) { bad(o, path, 'expected { color, offset_x, offset_y, blur } or null'); return undefined }
  unknownKeys(o, path, v, ['color', 'offset_x', 'offset_y', 'blur'])
  const c = color(o, `${path}.color`, v.color)
  const x = num(o, `${path}.offset_x`, v.offset_x, -200, 200), y = num(o, `${path}.offset_y`, v.offset_y, -200, 200)
  const b = num(o, `${path}.blur`, v.blur, 0, 200)
  return c === undefined || x === undefined || y === undefined || b === undefined ? undefined : { color: c, offset_x: x, offset_y: y, blur: b }
}

function unknownKeys(o: Out, path: string, v: Record<string, unknown>, known: readonly string[]) {
  for (const k of Object.keys(v)) if (!known.includes(k)) bad(o, `${path}.${k}`, 'unknown token')
}

const TEXT_KEYS = ['family', 'size_px', 'weight', 'italic', 'color', 'align', 'position', 'anchor', 'box_w', 'outline', 'shadow', 'intro', 'outro'] as const
const CAPTION_KEYS = ['family', 'size_px', 'weight', 'italic', 'color', 'position', 'anchor', 'box_w', 'outline', 'shadow',
  'max_chars_per_line', 'max_lines', 'min_cue_s', 'max_cue_s'] as const

/** The fields TextTokens and CaptionTokens share, read one key at a time so a
 *  bad key costs only itself. */
function textField(o: Out, path: string, key: string, v: unknown): unknown {
  const at = `${path}.${key}`
  switch (key) {
    case 'family':
      if (v === null || (typeof v === 'string' && v.trim() !== '' && v.length <= 200)) return v
      bad(o, at, 'expected a font family list or null (the app default text font)'); return undefined
    case 'size_px': return num(o, at, v, 4, 1000)
    case 'weight': return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 900 && v % 100 === 0 ? v : (bad(o, at, 'expected 100, 200, … 900'), undefined)
    case 'italic': return typeof v === 'boolean' ? v : (bad(o, at, 'expected true or false'), undefined)
    case 'color': return color(o, at, v)
    case 'align': return oneOf(o, at, v, ALIGNS, false)
    case 'position': return pair(o, at, v, -1, 2)
    case 'anchor': return pair(o, at, v, 0, 1)
    case 'box_w': return v === null ? null : num(o, at, v, 0.01, 1)
    case 'outline': return outline(o, at, v)
    case 'shadow': return shadow(o, at, v)
    case 'intro': return oneOf(o, at, v, INTROS, true)
    case 'outro': return oneOf(o, at, v, OUTROS, true)
    case 'max_chars_per_line': return typeof v === 'number' && Number.isInteger(v) && v >= 8 && v <= 200 ? v : (bad(o, at, 'expected a whole number from 8 to 200'), undefined)
    case 'max_lines': return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4 ? v : (bad(o, at, 'expected 1 to 4'), undefined)
    case 'min_cue_s': return num(o, at, v, 0.1, 30)
    case 'max_cue_s': return num(o, at, v, 0.5, 60)
  }
  return undefined
}

function textBlock(o: Out, path: string, v: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!isObj(v)) { bad(o, path, 'expected a mapping of tokens'); return undefined }
  const out: Record<string, unknown> = {}
  for (const [k, raw] of Object.entries(v)) {
    if (!keys.includes(k)) { bad(o, `${path}.${k}`, 'unknown token'); continue }
    const value = textField(o, path, k, raw)
    if (value !== undefined) out[k] = value
  }
  return out
}

/** The `roles` list: custom role declarations. Built-in names need no
 *  declaration and may not be redeclared. */
export function validateRoles(raw: unknown, source: TasteSource, diagnostics: TasteDiagnostic[]): RoleDeclaration[] {
  const o: Out = { diagnostics, source }
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) { bad(o, 'roles', 'expected a list of { name, description }'); return [] }
  const out: RoleDeclaration[] = []
  raw.forEach((r, i) => {
    const entry = typeof r === 'string' ? { name: r } : r
    if (!isObj(entry) || typeof entry.name !== 'string' || !GRAPHIC_ROLE_PATTERN.test(entry.name)) {
      bad(o, `roles[${i}]`, 'expected { name: lower_snake_case, description? }'); return
    }
    if ((BUILTIN_GRAPHIC_ROLES as readonly string[]).includes(entry.name)) {
      bad(o, `roles[${i}]`, `${entry.name} is a built-in role; it needs no declaration`); return
    }
    unknownKeys(o, `roles[${i}]`, entry, ['name', 'description'])
    out.push({ name: entry.name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) })
  })
  return out
}

const MOTIF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PROP_KEY = /^[a-z][a-z0-9_]{0,63}$/
/** One family name, as the system names it: no quotes, commas or semicolons. */
const FAMILY = /^[^'",;{}<>]{1,100}$/

/** The `motifs` mapping: graphic role → a Motif id or a list of them. Roles
 *  are checked against `knownRoles`; whether an id exists is the view's to
 *  judge, since it holds the Motif catalog. */
export function validateMotifs(raw: unknown, source: TasteSource, knownRoles: ReadonlySet<string>, diagnostics: TasteDiagnostic[]): MotifsByRole {
  const o: Out = { diagnostics, source }
  if (raw === undefined || raw === null) return {}
  if (!isObj(raw)) { bad(o, 'motifs', 'expected a mapping of graphic role → Motif id or list of ids'); return {} }
  const out: MotifsByRole = {}
  for (const [role, v] of Object.entries(raw)) {
    const path = `motifs.${role}`
    if (!knownRoles.has(role)) { bad(o, path, `undeclared graphic role ${role}; declare it under roles`); continue }
    const list = typeof v === 'string' ? [v] : v
    if (!Array.isArray(list) || !list.length) { bad(o, path, 'expected a Motif id or a non-empty list of ids'); continue }
    const ids: string[] = []
    list.forEach((id, i) => {
      if (typeof id === 'string' && MOTIF_ID.test(id)) { if (!ids.includes(id)) ids.push(id) }
      else bad(o, `${path}[${i}]`, 'expected a Motif id')
    })
    if (ids.length) out[role] = ids
  }
  return out
}

/** Validate a `tokens` mapping. Role keys under `text` are checked against
 *  `knownRoles` (built-ins plus every declaration visible to this file). */
export function validateTokens(raw: unknown, source: TasteSource, knownRoles: ReadonlySet<string>, diagnostics: TasteDiagnostic[]): Tokens {
  const o: Out = { diagnostics, source }
  if (raw === undefined || raw === null) return {}
  if (!isObj(raw)) { bad(o, 'tokens', 'expected a mapping'); return {} }
  const out: Tokens = {}
  for (const [k, v] of Object.entries(raw)) {
    const path = `tokens.${k}`
    if (k === 'palette') {
      if (!isObj(v)) { bad(o, path, 'expected a mapping of name → colour'); continue }
      const palette: Record<string, ColorToken> = {}
      for (const [name, c] of Object.entries(v)) {
        if (!PALETTE_NAME.test(name)) { bad(o, `${path}.${name}`, 'palette names are lower_snake_case'); continue }
        if (typeof c !== 'string' || !HEX.test(c)) { bad(o, `${path}.${name}`, 'expected #RRGGBB or #RRGGBBAA'); continue }
        palette[name] = c
      }
      out.palette = palette
    } else if (k === 'text') {
      if (!isObj(v)) { bad(o, path, 'expected a mapping of graphic role → tokens'); continue }
      const text: Record<string, TextTokens> = {}
      for (const [role, block] of Object.entries(v)) {
        if (!knownRoles.has(role)) { bad(o, `${path}.${role}`, `undeclared graphic role ${role}; declare it under roles`); continue }
        const t = textBlock(o, `${path}.${role}`, block, TEXT_KEYS)
        if (t) text[role] = t as TextTokens
      }
      out.text = text
    } else if (k === 'caption') {
      const c = textBlock(o, path, v, CAPTION_KEYS)
      if (c) out.caption = c as CaptionTokens
    } else if (k === 'floors') {
      if (!isObj(v)) { bad(o, path, 'expected a mapping of craft rule id → number'); continue }
      const floors: Record<string, number> = {}
      for (const [rule, n] of Object.entries(v)) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(rule)) { bad(o, `${path}.${rule}`, 'craft rule ids are lower-kebab-case'); continue }
        if (typeof n !== 'number' || !Number.isFinite(n)) { bad(o, `${path}.${rule}`, 'expected a number'); continue }
        floors[rule] = n
      }
      out.floors = floors
    } else if (k === 'pace') {
      if (!isObj(v)) { bad(o, path, 'expected a mapping: beat_every_s, bare_talk_max_s, scenes_per_min'); continue }
      const pace: PaceTokens = {}
      for (const [key, n] of Object.entries(v)) {
        if (!(key in PACE_RULES)) { bad(o, `${path}.${key}`, 'unknown pace key (beat_every_s, bare_talk_max_s, scenes_per_min)'); continue }
        if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) { bad(o, `${path}.${key}`, 'expected a positive number'); continue }
        pace[key as keyof PaceTokens] = n
      }
      out.pace = pace
    } else if (k === 'motif') {
      if (!isObj(v)) { bad(o, path, 'expected a mapping of Motif prop key → value'); continue }
      const motif: Record<string, string | number> = {}
      for (const [key, val] of Object.entries(v)) {
        if (!PROP_KEY.test(key) || key.startsWith('font_')) { bad(o, `${path}.${key}`, key.startsWith('font_') ? 'font props come from tokens.fonts' : 'Motif prop keys are lower_snake_case'); continue }
        if ((typeof val === 'number' && Number.isFinite(val)) || (typeof val === 'string' && val.length <= 200)) motif[key] = val
        else bad(o, `${path}.${key}`, 'expected a number or a string of at most 200 characters')
      }
      out.motif = motif
    } else if (k === 'fonts') {
      if (!isObj(v)) { bad(o, path, 'expected a mapping of font slot → families'); continue }
      const fonts: Record<string, string[]> = {}
      for (const [slot, list] of Object.entries(v)) {
        if (!PROP_KEY.test(slot)) { bad(o, `${path}.${slot}`, 'font slots are lower_snake_case'); continue }
        const families = Array.isArray(list) ? list : [list]
        if (!families.length || families.length > 12 || !families.every((f) => typeof f === 'string' && FAMILY.test(f))) {
          bad(o, `${path}.${slot}`, 'expected 1 to 12 font family names, without quotes or commas'); continue
        }
        fonts[slot] = families as string[]
      }
      out.fonts = fonts
    } else bad(o, path, 'unknown token group (palette, text, caption, floors, pace, motif, fonts)')
  }
  return out
}
