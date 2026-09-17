// apps/desktop/src/main/state/mcp-commands.ts
// Pure MCP-tool adapter helpers: arg parsing (snake_case MCP vocab → internal
// dispatch vocab), ToolResult shaping, and CommandError → MCP error mapping.
// The byte-exact mcp.differential gate (vs Rust dispatch_tool) is the backstop.
// Mirrors native/src/mcp/{tools.rs,wire.rs}.
import type { CommandError } from './errors'
import type { Animated, Continuity, EaseDir, Extrapolate, Extrapolation, Interpolation, Keyframe, Rgba, Segment, Tangent, TangentMode, TransitionDirection, TransitionKind } from './model'
import { HOLD_EXTRAPOLATION } from '../../shared/keyframe'
import type { EffectPatch } from './mutations/effects'
import type { MarkerPatch } from './mutations/markers'
import type { LayerPatch } from './mutations/update'
import type { LayerParamsPatch } from './mutations/params'
import { EFFECT_KINDS, effectParamSpecs } from '../../shared/effects/params'
import { positionProblem } from '../../shared/position'
import { sortKeys } from './canonical'
import { EASING_PRESETS, ELASTIC_DEFAULT_AMPLITUDE, ELASTIC_DEFAULT_PERIOD, cloneInterp, presetIdForSegment } from '../../shared/easing'

export type McpErrorCode = 'invalid_params' | 'invalid_request' | 'not_found' | 'internal'
export type McpToolErrorJson = { code: McpErrorCode; message: string; data?: unknown }
export type ToolResultJson = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } // isError omitted when false
export type McpCallResult = { ok: true; result: ToolResultJson } | { ok: false; error: McpToolErrorJson }

/** Thrown by arg parsers on bad input (e.g. malformed UUID) → invalid_params. */
export class McpArgError extends Error {
  constructor(public readonly mcpMessage: string, public readonly field?: string) { super(mcpMessage); this.name = 'McpArgError' }
  toJson(): McpToolErrorJson { return { code: 'invalid_params', message: this.mcpMessage } }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Mirrors tools.rs parse_uuid: validates + errors "<field> not a UUID: …". */
export function parseUuid(s: unknown, field: string): string {
  if (typeof s !== 'string' || !UUID_RE.test(s)) throw new McpArgError(`${field} not a UUID: ${String(s)}`, field)
  return s
}

const INTERP_KINDS = `'Hold' | 'Linear' | 'Bezier' | 'Elastic' | 'Bounce'`
const EASE_DIRS = new Set<string>(['In', 'Out', 'InOut'])
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

function parseEaseDir(v: unknown, kind: string): EaseDir {
  if (typeof v !== 'string' || !EASE_DIRS.has(v))
    throw new McpArgError(`invalid interp: ${kind} needs dir 'In' | 'Out' | 'InOut', got ${String(v)}`)
  return v as EaseDir
}

/** Validate an Interpolation — the closed wire union single-sourced in
 *  src/shared/easing.ts (Hold | Linear | Bezier | Elastic | Bounce). Elastic
 *  amplitude/period may be omitted and take the shared authoring defaults, so
 *  the parsed value is always a complete wire object. Bezier control-point x
 *  is gated to [0, 1] — x is segment time, and the solver is single-valued
 *  only on that range. Throws McpArgError on malformed input → invalid_params. */
export function parseInterp(v: unknown): Interpolation {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid interp: not an object`)
  const o = v as Record<string, unknown>
  const kind = o.kind
  if (typeof kind !== 'string') {
    if (typeof o.preset === 'string')
      throw new McpArgError(`invalid interp: preset ids are a update_keyframe payload — this argument takes a raw kind ${INTERP_KINDS}`)
    throw new McpArgError(`invalid interp: missing 'kind' (${INTERP_KINDS})`)
  }
  if (kind === 'Hold' || kind === 'Linear') return { kind }
  if (kind === 'Bezier') {
    const p1 = o.p1
    const p2 = o.p2
    if (!isPair(p1) || !isPair(p2)) throw new McpArgError(`invalid interp: Bezier needs p1/p2 as [number, number]`)
    if (!(p1[0] >= 0 && p1[0] <= 1)) throw new McpArgError(`invalid interp: Bezier p1[0] (x) must be within [0, 1], got ${p1[0]} — x is segment time; only y may overshoot`)
    if (!(p2[0] >= 0 && p2[0] <= 1)) throw new McpArgError(`invalid interp: Bezier p2[0] (x) must be within [0, 1], got ${p2[0]} — x is segment time; only y may overshoot`)
    return { kind: 'Bezier', p1, p2 }
  }
  if (kind === 'Elastic') {
    const dir = parseEaseDir(o.dir, 'Elastic')
    const amplitude = o.amplitude === undefined || o.amplitude === null ? ELASTIC_DEFAULT_AMPLITUDE : parseNum(o.amplitude, 'interp.amplitude')
    if (amplitude < 1) throw new McpArgError(`invalid interp: Elastic amplitude must be >= 1, got ${amplitude} (omit it for the default ${ELASTIC_DEFAULT_AMPLITUDE})`)
    const period = o.period === undefined || o.period === null ? ELASTIC_DEFAULT_PERIOD : parseNum(o.period, 'interp.period')
    if (period <= 0) throw new McpArgError(`invalid interp: Elastic period must be > 0, got ${period} (omit it for the default ${ELASTIC_DEFAULT_PERIOD})`)
    return { kind: 'Elastic', dir, amplitude, period }
  }
  if (kind === 'Bounce') return { kind: 'Bounce', dir: parseEaseDir(o.dir, 'Bounce') }
  if (kind === 'EaseIn' || kind === 'EaseOut')
    throw new McpArgError(`invalid interp: '${kind}' is not a kind — named eases are presets (update_keyframe takes {"preset":"${kind === 'EaseIn' ? 'ease_in' : 'ease_out'}"}); kinds: ${INTERP_KINDS}`)
  throw new McpArgError(`invalid interp: unknown kind '${kind}' — expected ${INTERP_KINDS}`)
}

/** Optional variant: undefined passes through (set_keyframe's interp is Option). */
export function parseInterpOpt(v: unknown): Interpolation | undefined {
  return v === undefined ? undefined : parseInterp(v)
}

/** update_keyframe's payload union: {"preset":"<id>"} bakes to a fresh
 *  copy of the canonical table entry's params (cloneInterp — the table IS the
 *  params, nothing is re-derived here); anything else parses as a raw
 *  Interpolation. Exactly one of preset/kind: both together is ambiguous and
 *  rejects. The unknown-preset error carries the full live id list in the
 *  MESSAGE — the client drops error.data, so options must ride the message. */
export function parseEasing(v: unknown): Interpolation {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid interp: not an object`)
  const o = v as Record<string, unknown>
  if (o.preset === undefined || o.preset === null) {
    if (o.kind === undefined) throw new McpArgError(`invalid interp: send {"preset":"<id>"} or a raw kind ${INTERP_KINDS}`)
    return parseInterp(v)
  }
  if (o.kind !== undefined) throw new McpArgError(`invalid interp: send either {"preset":"<id>"} or a raw {"kind":...}, not both`)
  const hit = typeof o.preset === 'string' ? EASING_PRESETS.find((p) => p.id === o.preset) : undefined
  if (!hit) throw new McpArgError(`invalid interp: unknown preset '${String(o.preset)}' — presets: ${EASING_PRESETS.map((p) => p.id).join(', ')}`)
  return cloneInterp(hit.interp)
}

const TANGENT_MODES: readonly TangentMode[] = ['Auto', 'Free']
const CONTINUITIES: readonly Continuity[] = ['Smooth', 'Broken']
const EXTRAPOLATES: readonly Extrapolate[] = ['Hold', 'Loop', 'PingPong', 'Offset', 'Continue']
const CONTINUITY_OPTIONS = `'Smooth' | 'Broken'`
const EXTRAPOLATE_OPTIONS = EXTRAPOLATES.map((e) => `'${e}'`).join(' | ')
const KEY_SHAPE = '{id, t_us, value, in: {x, y, mode}, out: {x, y, mode}, continuity, segment: {kind, ...}}'
const TANGENT_X_RULE = `x is the fraction of the segment's time span and must be within [0, 1]; only y may overshoot`

/** One side of a key as stored: unit-square coords (x gated to [0, 1] — the
 *  cubic is single-valued in time only there) + a mode. */
function parseTangent(v: unknown, side: 'in' | 'out'): Tangent {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid track: keyframe "${side}" must be a tangent {x, y, mode}`)
  const o = v as Record<string, unknown>
  if (typeof o.x !== 'number' || !Number.isFinite(o.x) || typeof o.y !== 'number' || !Number.isFinite(o.y))
    throw new McpArgError(`invalid track: keyframe "${side}" needs finite x and y`)
  if (o.x < 0 || o.x > 1) throw new McpArgError(`invalid track: keyframe "${side}".x is ${o.x} — ${TANGENT_X_RULE}`)
  if (!TANGENT_MODES.includes(o.mode as TangentMode))
    throw new McpArgError(`invalid track: keyframe "${side}".mode must be 'Auto' | 'Free', got ${String(o.mode)}`)
  return { x: o.x, y: o.y, mode: o.mode as TangentMode }
}

/** The `{x, y}` a tangent WRITE sends (update_keyframe): x within [0, 1]
 *  — refused outside, never clamped, because a clamp would store a number the
 *  agent did not send — and a finite y. The side comes out Free. */
export function parseTangentXy(v: unknown, field: string): { x: number; y: number } {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new McpArgError(`${field} must be a tangent {x, y}`, field)
  const o = v as Record<string, unknown>
  if (typeof o.x !== 'number' || !Number.isFinite(o.x)) throw new McpArgError(`${field}.x must be a number within [0, 1]`, field)
  if (o.x < 0 || o.x > 1) throw new McpArgError(`${field}.x is ${o.x} — ${TANGENT_X_RULE}`, field)
  if (typeof o.y !== 'number' || !Number.isFinite(o.y)) throw new McpArgError(`${field}.y must be a finite number`, field)
  return { x: o.x, y: o.y }
}

/** The class of the segment leaving a key. `Spline` carries no params (its
 *  shape is the two tangents); the other kinds are the same shapes as the
 *  matching `Interpolation` kinds and take the same defaults and range checks. */
export function parseSegment(v: unknown): Segment {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid track: keyframe segment must be an object {kind, ...}`)
  const o = v as Record<string, unknown>
  if (o.kind === 'Spline') return { kind: 'Spline' }
  if (o.kind === 'Bezier') throw new McpArgError(NO_BEZIER_SEGMENT)
  const i = parseInterp(v)
  // Narrowing only: parseInterp mints Bezier from kind 'Bezier' alone, refused above.
  if (i.kind === 'Bezier') throw new McpArgError(NO_BEZIER_SEGMENT)
  return i
}
const NO_BEZIER_SEGMENT = `invalid track: a stored segment has no 'Bezier' kind — send {"kind":"Spline"} and put the cubic on this key's out and the next key's in`

/** `field` prefixes the message so a key inside a track and a bare tool arg
 *  both read in their own terms. */
export function parseContinuity(v: unknown, field: string = 'continuity'): Continuity {
  if (!CONTINUITIES.includes(v as Continuity)) throw new McpArgError(`${field} must be ${CONTINUITY_OPTIONS}, got ${String(v)}`)
  return v as Continuity
}

export function parseExtrapolate(v: unknown, field: string): Extrapolate {
  if (!EXTRAPOLATES.includes(v as Extrapolate))
    throw new McpArgError(`${field} must be one of ${EXTRAPOLATE_OPTIONS}, got ${String(v)}`)
  return v as Extrapolate
}

/** A keyframe value on the wire and the rule for which param key takes which —
 *  both single-sourced in the shared record module so main's lenses and this
 *  parser cannot disagree. Re-exported for the tests and callers that read them
 *  from here. */
import { isColorParam, type TrackValue } from '../../shared/keyframe'
export { isColorParam, type TrackValue }
export type AnimatedTrack = Animated<number> | Animated<Rgba>

const describeValue = (v: unknown): string =>
  v === undefined ? 'nothing' : v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object'
    : typeof v === 'number' && !Number.isFinite(v) ? 'a non-finite number' : `a ${typeof v}`

/** Parse a keyframe value by the param it is for. A mismatch names the type
 *  the param takes (and, for a colour sent to a scalar param, that `color` is
 *  the only key taking one) — the client drops error.data, so the fix rides
 *  the message. */
export function parseTrackValue(v: unknown, paramKey: string, field: string): TrackValue {
  if (isColorParam(paramKey)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v))
      throw new McpArgError(`${field}: param 'color' takes an {r,g,b,a} colour (integers 0..255), got ${describeValue(v)}`, field)
    return parseRgba(v, field)
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    const colourHint = v !== null && typeof v === 'object' && !Array.isArray(v) ? ` — {r,g,b,a} is the value type of param_key "color" only` : ''
    throw new McpArgError(`${field}: param '${paramKey}' takes a number, got ${describeValue(v)}${colourHint}`, field)
  }
  return v
}

/** Optional variant: undefined/null → undefined (absent). */
export function parseTrackValueOpt(v: unknown, paramKey: string, field: string): TrackValue | undefined {
  return v === undefined || v === null ? undefined : parseTrackValue(v, paramKey, field)
}

/** Validate an Animated<T> in the record shape — mirrors the Rust serde form
 *  in state/animated.rs, values parsed through `parseValue`. `extrapolate` is
 *  optional at THIS API edge only (→ Hold/Hold); a saved project must carry it
 *  (serialize.ts). A key still carrying the retired per-segment `interp` is
 *  refused with the record shape in the message. Throws McpArgError →
 *  invalid_params. */
function parseAnimatedTrackWith<T>(v: unknown, parseValue: (v: unknown, field: string) => T): Animated<T> {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid track: not an object`)
  const o = v as Record<string, unknown>
  if (o.mode === 'Static') return { mode: 'Static', value: parseValue(o.value, 'invalid track: Static value') }
  if (o.mode === 'Keyframed') {
    if (!Array.isArray(o.value)) throw new McpArgError(`invalid track: Keyframed value must be an array`)
    const kfs: Keyframe<T>[] = o.value.map((raw, i) => {
      if (raw === null || typeof raw !== 'object') throw new McpArgError(`invalid track: keyframe must be an object`)
      const k = raw as Record<string, unknown>
      if ('interp' in k)
        throw new McpArgError(`invalid track: keyframe carries the retired per-segment "interp" field — a key is ${KEY_SHAPE}; the easing of a segment is this key's segment + out and the next key's in`)
      if (typeof k.id !== 'string') throw new McpArgError(`invalid track: keyframe id must be a string`)
      if (typeof k.t_us !== 'number') throw new McpArgError(`invalid track: keyframe t_us must be a number`)
      const value = parseValue(k.value, `invalid track: keyframe[${i}].value`)
      for (const field of ['in', 'out', 'continuity', 'segment'] as const)
        if (k[field] === undefined) throw new McpArgError(`invalid track: keyframe lacks "${field}" — a key is ${KEY_SHAPE}`)
      return {
        id: k.id, t_us: k.t_us, value,
        in: parseTangent(k.in, 'in'), out: parseTangent(k.out, 'out'),
        continuity: parseContinuity(k.continuity, 'invalid track: keyframe continuity'), segment: parseSegment(k.segment),
      }
    })
    let extrapolate: Extrapolation = { ...HOLD_EXTRAPOLATION }
    if (o.extrapolate !== undefined && o.extrapolate !== null) {
      if (typeof o.extrapolate !== 'object') throw new McpArgError(`invalid track: extrapolate must be {before, after}`)
      const e = o.extrapolate as Record<string, unknown>
      extrapolate = { before: parseExtrapolate(e.before, 'invalid track: extrapolate.before'), after: parseExtrapolate(e.after, 'invalid track: extrapolate.after') }
    }
    return { mode: 'Keyframed', value: kfs, extrapolate }
  }
  throw new McpArgError(`invalid track: unknown mode '${String(o.mode)}'`)
}

/** A layer param's track, values typed by `paramKey` (`parseTrackValue`). */
export function parseAnimatedTrack(v: unknown, paramKey: string): AnimatedTrack {
  return isColorParam(paramKey)
    ? parseAnimatedTrackWith<Rgba>(v, (x, f) => parseTrackValue(x, paramKey, f) as Rgba)
    : parseAnimatedTrackWith<number>(v, (x, f) => parseTrackValue(x, paramKey, f) as number)
}

/** The scalar-only form — effect params (`update_effect`), whose values are
 *  numbers whatever the param is named. */
export function parseAnimatedF64(v: unknown): Animated<number> {
  return parseAnimatedTrackWith<number>(v, parseNum)
}

/** Gate a structural patch/props argument: a plain JSON object, never a
 *  string/array/null. Every apply* mutation reads patch fields through `typeof`
 *  guards, so an unparsed patch (e.g. the JSON-encoded string an MCP client
 *  sends for an untyped schema field) would commit nothing and still report
 *  success — the one failure mode worse than rejection. */
export function parseObj(v: unknown, field: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new McpArgError(`${field} must be a JSON object, got ${Array.isArray(v) ? 'an array' : typeof v}`, field)
  return v as Record<string, unknown>
}

// ── Strict patch parsers (audit S6) ─────────────────────────────────────────
// `parseObj` proves "is an object" and nothing else, and every apply* mutation
// reads its patch behind `typeof` guards — so an unknown key, a typo, a field
// that belongs to another tool all committed NOTHING and reported success. The
// parsers below refuse at the boundary, naming the accepted set, so the agent
// learns the vocabulary from the refusal rather than from a re-read that shows
// nothing changed.

/** A finite integer wire arg → invalid_params. The µs fields and the extents
 *  are integers on the wire (the schema says so); a fraction is a bug in the
 *  caller's arithmetic, not a request. */
export function parseIntNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new McpArgError(`${field} must be an integer, got ${describeValue(v)}`, field)
  return v
}

const LAYER_PATCH_KEYS: readonly string[] = ['label', 't_start_us', 't_end_us', 'locked']
/** `update_layer`'s envelope patch. `enabled` is refused by name — the audit
 *  found the mutation APPLIED it while the description said visibility is
 *  `set_layers_enabled` — and a param key is pointed at `update_layer_params`. */
export function parseLayerPatch(v: unknown): LayerPatch {
  const o = parseObj(v, 'patch')
  const keys = Object.keys(o)
  if (keys.length === 0) throw new McpArgError(`patch names no field; update_layer writes ${LAYER_PATCH_KEYS.join(', ')}`, 'patch')
  for (const k of keys) {
    if (k === 'enabled') throw new McpArgError(`patch.enabled is not update_layer's: visibility is set_layers_enabled { layer_ids, enabled }`, 'patch')
    if (!LAYER_PATCH_KEYS.includes(k)) {
      const owner = Object.values(LAYER_PARAMS_KEYS).some((ks) => ks.includes(k)) ? ` — '${k}' is a kind-specific param, which is update_layer_params { patch: { kind, ${k} } }` : ''
      throw new McpArgError(`invalid patch: unknown key '${k}'; update_layer writes ${LAYER_PATCH_KEYS.join(', ')}${owner}`, 'patch')
    }
  }
  const out: LayerPatch = {}
  if ('label' in o) out.label = parseStrOpt(o.label, 'patch.label')
  if ('t_start_us' in o) out.t_start_us = parseIntNum(o.t_start_us, 'patch.t_start_us')
  if ('t_end_us' in o) out.t_end_us = parseIntNum(o.t_end_us, 'patch.t_end_us')
  if ('locked' in o) out.locked = parseBool(o.locked, 'patch.locked')
  return out
}

/** The fields each kind's patch may carry — the key sets of `LayerParamsPatch`
 *  (mutations/params.ts), restated as data so the parser can name them. A kind
 *  added there gains its keys here, or `mcp.strict-patches` fails. */
export const LAYER_PARAMS_KEYS: Readonly<Record<string, readonly string[]>> = {
  Text: ['content', 'font_family', 'font_size_px', 'font_weight', 'italic', 'color', 'x', 'y', 'opacity', 'rotation_deg', 'anchor_x', 'anchor_y', 'align', 'valign', 'box_w', 'box_h', 'line_height', 'letter_spacing', 'outline_width', 'outline_color', 'shadow'],
  VideoClip: ['src_in_us', 'src_out_us', 'x', 'y', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y', 'opacity', 'speed', 'flip_h', 'flip_v', 'fade_in_us', 'fade_out_us'],
  ImageOverlay: ['x', 'y', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y', 'opacity', 'fade_in_us', 'fade_out_us'],
  Motif: ['x', 'y', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y', 'opacity', 'src_in_us', 'motif_id', 'motif_version', 'props'],
  Color: ['color', 'width', 'height'],
  Audio: ['src_in_us', 'src_out_us', 'gain_db', 'pan', 'fade_in_us', 'fade_out_us', 'mute', 'role'],
  CompositionRef: ['src_in_us', 'src_out_us', 'x', 'y', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y', 'opacity', 'blend_mode'],
}
export const LAYER_PARAM_KINDS: readonly string[] = Object.keys(LAYER_PARAMS_KEYS)
const TEXT_ALIGN_OPTIONS = ['Left', 'Center', 'Right'] as const
const VALIGN_OPTIONS = ['Top', 'Middle', 'Bottom'] as const
const BLEND_MODE_OPTIONS = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'Add', 'Difference'] as const
const ENVELOPE_KEYS = new Set(['label', 't_start_us', 't_end_us', 'locked'])

function parseOneOf(v: unknown, options: readonly string[], field: string): string {
  if (typeof v !== 'string' || !options.includes(v)) throw new McpArgError(`${field} must be one of ${options.join(' | ')}, got ${describeValue(v)}`, field)
  return v
}

/** One value of a kind-specific patch, gated by field name. `null` is a value
 *  only where it MEANS something — the text box pair, where it is "back to
 *  auto" — and is refused everywhere else: the wire convention is that an
 *  omitted field is left alone, so a null one is a request nothing reads. */
function parseLayerParamValue(k: string, v: unknown): unknown {
  const field = `patch.${k}`
  if (v === null) {
    if (k === 'box_w' || k === 'box_h' || k === 'shadow') return null
    throw new McpArgError(`${field} is null, which is not a value for ${k} — omit the field to leave it alone`, field)
  }
  switch (k) {
    case 'content': case 'font_family': case 'motif_id': return parseStr(v, field)
    case 'font_weight': return parseIntNum(v, field)
    case 'italic': return parseBool(v, field)
    case 'shadow': {
      const o = parseObj(v, field)
      for (const key of Object.keys(o)) if (!['color', 'offset_x', 'offset_y', 'blur'].includes(key)) throw new McpArgError(`${field}.${key} is not a shadow field — a shadow is { color, offset_x, offset_y, blur }`, field)
      return { color: parseRgba(o.color, `${field}.color`), offset_x: parseNum(o.offset_x, `${field}.offset_x`), offset_y: parseNum(o.offset_y, `${field}.offset_y`), blur: parseNum(o.blur, `${field}.blur`) }
    }
    case 'color': case 'outline_color': return parseRgba(v, field)
    case 'flip_h': case 'flip_v': case 'mute': return parseBool(v, field)
    case 'align': return parseOneOf(v, TEXT_ALIGN_OPTIONS, field)
    case 'valign': return parseOneOf(v, VALIGN_OPTIONS, field)
    case 'blend_mode': return parseOneOf(v, BLEND_MODE_OPTIONS, field)
    case 'role': return parseRole(v)
    case 'props': return parseObj(v, field)
    case 'src_in_us': case 'src_out_us': case 'fade_in_us': case 'fade_out_us': case 'motif_version': return parseIntNum(v, field)
    default: return parseNum(v, field) // x, y, scale_x, scale_y, opacity, speed, font_size_px, line_height, letter_spacing, outline_width, gain_db, pan, width, height, box_w, box_h
  }
}

/** `update_layer_params`'s patch: `kind` names one of the seven kinds, every
 *  other key is in that kind's set, and every value is the type the kind
 *  stores. Ranges and shape rules (a positive font size, the text-box modes,
 *  `2·pad < min`) stay the mutation's — it names them better than a table could. */
export function parseLayerParamsPatch(v: unknown): LayerParamsPatch {
  const o = parseObj(v, 'patch')
  const kind = o.kind
  if (typeof kind !== 'string' || !(kind in LAYER_PARAMS_KEYS))
    throw new McpArgError(`patch.kind must be one of ${LAYER_PARAM_KINDS.join(' | ')}, got ${typeof kind === 'string' ? `'${kind}'` : describeValue(kind)} — it has to match the layer's kind, which project://tracks reports`, 'patch')
  const allowed = LAYER_PARAMS_KEYS[kind]
  const fields = Object.keys(o).filter((k) => k !== 'kind')
  if (fields.length === 0) throw new McpArgError(`patch names no field; a ${kind} patch writes ${allowed.join(', ')}`, 'patch')
  for (const k of fields) {
    if (allowed.includes(k)) continue
    const elsewhere = Object.entries(LAYER_PARAMS_KEYS).filter(([, ks]) => ks.includes(k)).map(([kk]) => kk)
    const hint = k === 'enabled' ? ` ('enabled' is set_layers_enabled's)`
      : ENVELOPE_KEYS.has(k) ? ` ('${k}' is update_layer's)`
      : elsewhere.length > 0 ? ` ('${k}' belongs to ${elsewhere.join(', ')})` : ''
    throw new McpArgError(`invalid patch: '${k}' is not a ${kind} param — a ${kind} patch writes ${allowed.join(', ')}${hint}`, 'patch')
  }
  const out: Record<string, unknown> = { kind }
  for (const k of fields) out[k] = parseLayerParamValue(k, o[k])
  return out as LayerParamsPatch
}

/** `add_effect`'s kind: one of the two catalogs' (`shared/effects/params.ts`).
 *  The mutation stays permissive for a project written by a newer build (ADR
 *  0027); an agent inventing `audio.compressor` is not that case. */
export function parseEffectKind(v: unknown): string {
  if (typeof v !== 'string' || !EFFECT_KINDS.includes(v)) throw new McpArgError(`unknown effect kind ${typeof v === 'string' ? `'${v}'` : describeValue(v)} — kinds: ${EFFECT_KINDS.join(', ')}`, 'kind')
  return v
}

/** `update_effect`'s params against the effect's KIND: an unknown key or a
 *  value outside the catalogued range is refused, naming the set or the
 *  bound. A kind no catalog knows passes untouched. Called by the actor arm,
 *  which is the only place the kind is known. */
export function checkEffectPatchAgainst(kind: string, patch: EffectPatch): void {
  if (!patch.params) return
  const specs = effectParamSpecs(kind)
  if (specs === null) return
  for (const [k, track] of Object.entries(patch.params)) {
    if (!(k in specs)) throw new McpArgError(`invalid patch: '${k}' is not a param of effect kind '${kind}' — its params are ${Object.keys(specs).join(', ')}`, 'patch')
    if (track === null) continue
    const [lo, hi] = specs[k].range
    const values = track.mode === 'Static' ? [track.value] : track.value.map((kf) => kf.value)
    for (const value of values) {
      if (value < lo || value > hi) throw new McpArgError(`invalid patch: params['${k}'] ${value} is outside '${kind}'.${k}'s range [${lo}, ${hi}]`, 'patch')
    }
  }
}

/** `set_position`'s record, judged by the shared validator the mutation uses
 *  (`positionProblem`), so the refusal reads the same from either surface and
 *  arrives before any write. */
export function parsePosition(v: unknown): Record<string, unknown> {
  const o = parseObj(v, 'position')
  const problem = positionProblem(o)
  if (problem !== null) throw new McpArgError(`position: ${problem}`, 'position')
  return o
}

/** Strict update_effect patch — mirrors EffectPatch (mutations/effects.ts).
 *  Unknown keys and malformed values reject; applyUpdateEffect would otherwise
 *  silently skip them.
 *
 *  A `null` inside `params` is the one null that is NOT "don't touch": it is a
 *  removal, and it passes through so the caller can put a param back to unset.
 *  A null `params` / `enabled` field still means "don't touch". */
export function parseEffectPatch(v: unknown): EffectPatch {
  const o = parseObj(v, 'patch')
  for (const k of Object.keys(o)) {
    if (k !== 'enabled' && k !== 'params')
      throw new McpArgError(`invalid patch: unknown key '${k}' — expected { enabled?: boolean, params?: { "<param>": { "mode": "Static", "value": <number> } | null } }`)
  }
  const out: EffectPatch = {}
  if (o.enabled !== undefined && o.enabled !== null) {
    if (typeof o.enabled !== 'boolean') throw new McpArgError(`invalid patch: enabled must be a boolean`)
    out.enabled = o.enabled
  }
  if (o.params !== undefined && o.params !== null) {
    const p = parseObj(o.params, 'patch.params')
    const params: Record<string, Animated<number> | null> = {}
    for (const [k, pv] of Object.entries(p)) {
      if (pv === null) { params[k] = null; continue } // removal, not a malformed track
      try { params[k] = parseAnimatedF64(pv) }
      catch (e) { throw new McpArgError(`invalid patch: params['${k}']: ${e instanceof McpArgError ? e.mcpMessage : String(e)}`) }
    }
    out.params = params
  }
  return out
}

/** Strict update_marker patch — same lie-prevention as parseEffectPatch.
 *  null = "don't touch" (end_t_us can be set, never cleared: remove+add).
 *
 *  `anchor` is absent from the accepted set on purpose and is rejected like any
 *  other unknown key: an anchor is established only by the dedicated
 *  attach/detach ops, which is what keeps the pair (`anchor`, `t_us`) from ever
 *  being written apart (see `MarkerPatch`). */
export function parseMarkerPatch(v: unknown): MarkerPatch {
  const o = parseObj(v, 'patch')
  for (const k of Object.keys(o)) {
    if (k !== 't_us' && k !== 'end_t_us' && k !== 'label' && k !== 'note' && k !== 'color')
      throw new McpArgError(`invalid patch: unknown key '${k}' — expected { t_us?, end_t_us?, label?, note?, color? }`)
  }
  parseNumOpt(o.t_us, 'patch.t_us')
  parseNumOpt(o.end_t_us, 'patch.end_t_us')
  if (o.label !== undefined && o.label !== null && typeof o.label !== 'string')
    throw new McpArgError(`patch.label must be a string`, 'patch')
  if (o.note !== undefined && o.note !== null && typeof o.note !== 'string')
    throw new McpArgError(`patch.note must be a string`, 'patch')
  if (o.color !== undefined && o.color !== null) parseRgba(o.color, 'patch.color')
  return o as MarkerPatch
}

const AUDIO_ROLES = new Set(['dialogue', 'music', 'sfx', 'voiceover'])
/** The settings patch, gated at the boundary. The two review tuples and the
 *  script are validated in depth by the actor (bounds, and the `2*pad < min`
 *  rule) — repeating that here would be a second answer — so this gate owns the
 *  two things the actor cannot see: that the booleans are booleans, and that
 *  every key is one the actor reads. An unknown key is REFUSED rather than
 *  dropped: `preview_width` and `history_capacity` are real fields of the
 *  stored settings that `update_project_settings` does not write, so a silent
 *  pass-through would report success for a preference that never changed.
 *
 *  An empty patch is refused for the same reason `set_track_flags` refuses one:
 *  the write is unconditional downstream, so it would burn an id and broadcast
 *  a settings change that changed nothing. */
const PROJECT_SETTINGS_KEYS = new Set([
  'auto_pair_audio_on_import', 'prefer_proxies', 'proxy_override',
  'shot_review', 'pause_review', 'correction_script',
])
export function parseProjectSettingsPatch(v: unknown): Record<string, unknown> {
  const patch = parseObj(v, 'patch')
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new McpArgError('patch names no setting; a call that changes nothing would still report success', 'patch')
  for (const k of keys) {
    if (!PROJECT_SETTINGS_KEYS.has(k)) throw new McpArgError(`unknown setting '${k}'; set_project_settings writes ${[...PROJECT_SETTINGS_KEYS].join(', ')}`, 'patch')
  }
  const out: Record<string, unknown> = {}
  if ('auto_pair_audio_on_import' in patch) out.auto_pair_audio_on_import = parseBoolTriState(patch.auto_pair_audio_on_import, 'auto_pair_audio_on_import')
  if ('prefer_proxies' in patch) out.prefer_proxies = parseBoolTriState(patch.prefer_proxies, 'prefer_proxies')
  if ('correction_script' in patch) out.correction_script = parseStr(patch.correction_script, 'correction_script')
  if ('proxy_override' in patch) {
    const o = patch.proxy_override
    out.proxy_override = o === null ? null : (() => {
      const ov = parseObj(o, 'proxy_override')
      return { media_id: parseUuid(ov.media_id, 'proxy_override.media_id'), value: parseBoolTriState(ov.value, 'proxy_override.value') }
    })()
  }
  // Passed through as sent: the actor refuses a malformed tuple whole, naming
  // the field and the bound it missed, which is a better error than a shape
  // check here could give.
  for (const k of ['shot_review', 'pause_review'] as const) {
    if (k in patch) out[k] = patch[k] === null ? null : parseObj(patch[k], k)
  }
  return out
}

/** Validate an AudioRole (audio_role.rs kebab-case). Rust rejects an unknown
 *  role at the serde boundary → invalid_params; mirror that here. */
export function parseRole(v: unknown): string {
  if (typeof v !== 'string' || !AUDIO_ROLES.has(v)) throw new McpArgError(`unknown audio role '${String(v)}'`)
  return v
}

const TRANSITION_KINDS = new Set(['Crossfade', 'Wipe', 'Slide'])
const TRANSITION_DIRECTIONS = new Set(['left', 'right', 'up', 'down'])
/** Flat (kind, direction) wire args → TransitionKind (model.ts). Strict on
 *  the pairing so agents get a precise error instead of a silently ignored
 *  field: Wipe/Slide REQUIRE direction; Crossfade REJECTS one. Shared by the
 *  actor dispatch arms and the MCP parsers (single source — no drift). */
export function parseTransitionKind(kind: unknown, direction: unknown): TransitionKind {
  if (typeof kind !== 'string' || !TRANSITION_KINDS.has(kind))
    throw new McpArgError(`unknown transition kind '${String(kind)}' (expected 'Crossfade' | 'Wipe' | 'Slide')`, 'kind')
  if (kind === 'Crossfade') {
    if (direction !== undefined && direction !== null)
      throw new McpArgError(`direction does not apply to Crossfade — omit it (only Wipe/Slide take one)`, 'direction')
    return { kind: 'Crossfade' }
  }
  if (typeof direction !== 'string' || !TRANSITION_DIRECTIONS.has(direction))
    throw new McpArgError(`${kind} requires direction 'left' | 'right' | 'up' | 'down', got ${String(direction)}`, 'direction')
  return { kind: kind as 'Wipe' | 'Slide', direction: direction as TransitionDirection }
}

/** add_transition's placement — a closed two-value enum defaulting 'overlap'
 *  (spec D1: overlap placement is the default; extend survives only as an
 *  explicit request). Gated here like parseTransitionKind so a typo rejects at
 *  the boundary instead of silently classifying as overlap. */
export function parseTransitionPlacement(v: unknown): 'overlap' | 'extend' {
  if (v === undefined || v === null) return 'overlap'
  if (v !== 'overlap' && v !== 'extend') throw new McpArgError(`placement must be 'overlap' | 'extend', got ${String(v)}`, 'placement')
  return v
}

/** update_transition's optional (kind, direction) pair → TransitionKind or
 *  undefined (no kind patch). direction rides INSIDE kind, so direction
 *  without kind is rejected — patch both together. */
export function parseTransitionKindOpt(kind: unknown, direction: unknown): TransitionKind | undefined {
  if (kind === undefined || kind === null) {
    if (direction !== undefined && direction !== null)
      throw new McpArgError(`direction requires kind ('Wipe' | 'Slide') in the same patch`, 'direction')
    return undefined
  }
  return parseTransitionKind(kind, direction)
}

/** Validate an Rgba (color.rs: four u8 fields). A non-object or out-of-range
 *  color must reject here → invalid_params; an ungated `a.color as Rgba` lets a
 *  string like "#fff" commit garbage to the actor. */
export function parseRgba(v: unknown, field: string): Rgba {
  if (v === null || typeof v !== 'object') throw new McpArgError(`${field} must be an {r,g,b,a} color object`, field)
  const o = v as Record<string, unknown>
  const out = { r: 0, g: 0, b: 0, a: 0 }
  for (const k of ['r', 'g', 'b', 'a'] as const) {
    const n = o[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255)
      throw new McpArgError(`${field}.${k} must be an integer 0..255`, field)
    out[k] = n
  }
  return out
}

/** Validate a required finite-number wire arg → invalid_params. A raw `as number`
 *  cast would let a string/undefined through as NaN into the actor. */
export function parseNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new McpArgError(`${field} must be a number`, field)
  return v
}

/** Optional finite-number variant: undefined/null → undefined (absent). */
export function parseNumOpt(v: unknown, field: string): number | undefined {
  return v === undefined || v === null ? undefined : parseNum(v, field)
}

/** Validate a required string wire arg → invalid_params. */
export function parseStr(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new McpArgError(`${field} must be a string`, field)
  return v
}

/** Validate a required boolean wire arg → invalid_params. */
export function parseBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new McpArgError(`${field} must be a boolean`, field)
  return v
}

/** Optional boolean variant: undefined/null → dflt. */
export function parseBoolOpt(v: unknown, field: string, dflt: boolean): boolean {
  return v === undefined || v === null ? dflt : parseBool(v, field)
}

/** Tri-state boolean wire arg: absent/null → null ("leave this flag alone"),
 *  else a gated boolean. The null is a real third value here, so it cannot go
 *  through parseBoolOpt's default — a patch field nobody sent must stay
 *  distinguishable from one sent as `false`. */
export function parseBoolTriState(v: unknown, field: string): boolean | null {
  return v === undefined || v === null ? null : parseBool(v, field)
}

/** Optional string variant: undefined/null → null, else validates string. */
export function parseStrOpt(v: unknown, field: string): string | null {
  return v === undefined || v === null ? null : (typeof v === 'string' ? v : (() => { throw new McpArgError(`${field} must be a string`, field) })())
}

export function asArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new McpArgError(`${field} must be an array`)
  return v as string[]
}

/** restack_layer's placement — a closed two-value enum, gated here so a typo
 *  rejects at the boundary instead of reaching the actor. */
export function parseRestackPosition(v: unknown): 'above' | 'below' {
  if (v !== 'above' && v !== 'below') throw new McpArgError(`position must be 'above' | 'below', got ${String(v)}`, 'position')
  return v
}

// ── ToolResult shapers (wire.rs:81-93) ──
export function toolText(s: string): ToolResultJson { return { content: [{ type: 'text', text: s }] } }
export function toolEmpty(): ToolResultJson { return { content: [] } }
/** json results travel as a text block whose text is the SERIALIZED JSON with
 *  alpha-sorted keys (Rust serde_json preserve_order OFF → BTreeMap). Uses
 *  sortKeys (NOT canonicalize): wall-clock fields must stay real here — Rust
 *  returned real DateTime<Utc> (e.g. list_checkpoints.created_at), so the
 *  harness sentinel must not leak to MCP agents. The differential gate compares
 *  via its own canonicalize() of both sides, so this stays green. */
export function toolJson(v: unknown): ToolResultJson { return { content: [{ type: 'text', text: JSON.stringify(sortKeys(v)) }] } }

/** get_param_track result shape (NOT the raw Animated serde): Static →
 *  {mode,value}; Keyframed → {mode, extrapolate, keyframes:[{id, t_us
 *  (timeline-absolute = local + t_start), t_local_us (stored base), value, in,
 *  out, continuity, segment, preset_id?}]}. preset_id is the exact-match reverse
 *  lookup of the segment LEAVING the key (this key's segment + out, the next
 *  key's in) against the canonical easing table — present only when that
 *  segment IS a table entry's (a hand-tuned curve carries none, and the last key
 *  has no leaving segment; the field is omitted, never null). Caller wraps in
 *  toolJson (sorted keys, mirrors Rust json!/BTreeMap). */
export function shapeGetParamTrack<T>(track: Animated<T>, tStartUs: number): unknown {
  if (track.mode === 'Static') return { mode: 'Static', value: track.value }
  return {
    mode: 'Keyframed',
    extrapolate: track.extrapolate,
    keyframes: track.value.map((k, i) => {
      const next = track.value[i + 1]
      const presetId = next === undefined ? undefined : presetIdForSegment(k, next)
      return {
        id: k.id, t_us: k.t_us + tStartUs, t_local_us: k.t_us, value: k.value,
        in: k.in, out: k.out, continuity: k.continuity, segment: k.segment,
        ...(presetId === undefined ? {} : { preset_id: presetId }),
      }
    }),
  }
}

/** Reasonable, NON-asserted prose for a failed dry-run op (the differential
 *  gate uses succeeding-ops-only sequences, so this string is never gated;
 *  the halt/error shape is unit-tested in mcp.dryrun.test.ts). */
export function dryRunErrorString(e: CommandError): string {
  if (e.error === 'InvalidArgument') return `${e.field}: ${e.detail}`
  if (e.error === 'Backend') return e.detail
  if (e.error === 'ValidationFailed') {
    const d = e.detail
    // The two grid rules carry the corrected value, so say it even in dry-run prose:
    // an agent planning a batch can fix the op without a second round trip.
    if (d.rule === 'OffGridLayerBoundary' || d.rule === 'OffGridTime') return `validation failed: ${d.rule} (${d.field} ${d.t} µs → send ${d.snap_to})`
    return `validation failed: ${d.rule}`
  }
  if (e.error === 'TransitionInsufficientHandle') return `insufficient tail media on the outgoing layer ${e.layer}: ${e.available_us} µs available`
  if (e.error === 'TransitionRestoreCollision') return `removing the transition would move layer ${e.layer} back onto occupied space`
  if (e.error === 'TransitionParticipantsShareLink') return `layers ${e.from} and ${e.to} share a link, so the incoming layer cannot move to open the overlap`
  if (e.error === 'TransitionUnsupportedLayerKind') return `transitions are for visual layers only: layer ${e.layer} is ${e.kind}`
  // Ripple delete: what a refusal is about is the SPAN being closed, not the
  // deleted layer's length, so the two variants carrying a hole print it.
  if (e.error === 'RippleInsideHole') return `layer ${e.layer} starts inside the span [${e.hole.s}, ${e.hole.e}) µs the ripple would close — add it to layer_ids, or delete without rippling`
  if (e.error === 'RippleCollision') return `layer ${e.moving} would ripple left onto layer ${e.blocking} on track ${e.track}`
  if (e.error === 'RippleLinkStraddles') return `link ${e.link} has members on both sides of the span [${e.hole.s}, ${e.hole.e}) µs the ripple would close`
  if (e.error === 'RippleLockedLayer') return `layer ${e.layer} is locked and would have to move`
  if (e.error === 'GapNotFound') return `[${e.s}, ${e.e}) µs is not a gap on track ${e.track}`
  return e.error
}

/** Dry-run response: per-op {index, status, output|error} flattened, plus
 *  halted_at (the first failing index, or null). DryRunOutput is kind-tagged,
 *  snake_case: add_layer{layer_id} / split_layer{left_id, right_id} /
 *  add_transition{transition_id, bounces} / void. `bounces` predicts the
 *  overlap placement's sibling lane moves (spawned = a lane would be minted) —
 *  the same info the wet add's LogBus rows carry. Wrapped in toolJson (sorted
 *  keys). */
export function shapeDryRunResponse(
  results: Array<{ ok: true; value:
    | { kind: 'AddLayer'; layer_id: string }
    | { kind: 'SplitLayer'; left_id: string; right_id: string }
    | { kind: 'AddTransition'; transition_id: string; bounces: Array<{ layer: string; from_track: string; to_track: string; spawned: boolean }> }
    | { kind: 'Void' } } | { ok: false; error: CommandError }>,
): ToolResultJson {
  let haltedAt: number | null = null
  const entries = results.map((r, index) => {
    if (r.ok) {
      const o = r.value
      const output = o.kind === 'AddLayer' ? { kind: 'add_layer', layer_id: o.layer_id }
        : o.kind === 'SplitLayer' ? { kind: 'split_layer', left_id: o.left_id, right_id: o.right_id }
        : o.kind === 'AddTransition' ? { kind: 'add_transition', transition_id: o.transition_id, bounces: o.bounces }
        : { kind: 'void' }
      return { index, status: 'ok', output }
    }
    if (haltedAt === null) haltedAt = index
    return { index, status: 'error', error: dryRunErrorString(r.error) }
  })
  return toolJson({ results: entries, halted_at: haltedAt })
}

/** The remedy a ripple refusal offers depends on WHICH tool rippled: only
 *  `delete_layers` has a `layer_ids` to widen or narrow; `ripple_delete_gap`
 *  closes a span it was given, and `remove_pauses` cuts spans it computed. One
 *  sentence for all three sent two of them chasing a parameter they do not
 *  have (audit D6). */
const RIPPLE_TOOL = { deleteLayers: 'delete_layers', gap: 'ripple_delete_gap', pauses: 'remove_pauses' } as const
function rippleRemedy(tool: string | undefined, layer: string, widen: string, narrow: string): string {
  if (tool === RIPPLE_TOOL.gap) return `move_layer or delete_layers ${layer} first so the gap closes clean, or pick a gap it does not reach into`
  if (tool === RIPPLE_TOOL.pauses) return `move_layer or delete_layers ${layer} first, or cut the pauses with a narrower window (this tool has no layer set to widen)`
  if (tool === RIPPLE_TOOL.deleteLayers || tool === undefined) return `${widen}; or ${narrow}`
  return `move_layer or delete_layers ${layer} first`
}

/** The animatable param keys, per kind — what `set_keyframe` and friends may
 *  name. Stated as data here for the `UnknownKeyframeParam` arm, which has no
 *  layer in hand and so lists every kind's set. */
const KEYFRAME_PARAM_KEYS = `visual kinds (VideoClip, ImageOverlay, Text, Motif, CompositionRef): x, y (or path_progress in Path mode), scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity; Text and Color: color; Audio: gain_db, pan; an effect param: effects[<effect_id>].params[<key>] once update_effect has set it`

/** CommandError → MCP error JSON. Every variant has an arm: a refusal names the
 *  id or field it could not honour, the read that lists valid ones, and the
 *  next call — the bare variant name is never the message (the audit found
 *  thirteen of them). `tool` is the MCP tool that raised it, for the refusals
 *  whose remedy differs per tool (the ripple family). The structured `data`
 *  mirrors the same facts for clients that forward it. */
export function mapCommandError(e: CommandError, tool?: string): McpToolErrorJson {
  if (e.error === 'InvalidArgument') return { code: 'invalid_params', message: `${e.field}: ${e.detail}` }
  if (e.error === 'Backend') return { code: 'internal', message: e.detail }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'LayerOverlap') {
    const d = e.detail
    // The full cause + options go into the MESSAGE, not only `data`: MCP
    // clients (Claude Code verified against the hero-capture traces) surface
    // only `code: message` to the model and drop `error.data`, so a bare
    // 'layer overlap' left agents blind-retrying.
    //
    // Options are VALIDATED against the geometry (audit D5): trimming the
    // blocker's tail back to the request's start only helps when the request
    // starts inside the blocker; when it starts at or before the blocker, the
    // blocker's HEAD is what moves; a split needs a cut strictly inside. Each
    // emitted option would succeed as written.
    const requestStartsInside = d.a_start < d.b_start && d.b_start < d.a_end
    const requestCoversHead = d.b_start <= d.a_start && d.a_start < d.b_end && d.b_end < d.a_end
    const prose: string[] = [`create_new_track and retry there`, `move_layer ${d.a} elsewhere`]
    const options: Array<Record<string, unknown>> = [
      { action: 'create_new_track', kind: 'Video' },
      { action: 'move_layer', layer_id: d.a },
    ]
    if (requestStartsInside) {
      prose.push(`trim_layer ${d.a} edge 'out' to ${d.b_start}`, `split_layer ${d.a} at ${d.b_start} and delete the right half`)
      options.push({ action: 'trim_existing', layer_id: d.a, edge: 'out', new_t_us: d.b_start }, { action: 'split_at_t', layer_id: d.a, at_t_us: d.b_start })
    } else if (requestCoversHead) {
      prose.push(`trim_layer ${d.a} edge 'in' to ${d.b_end}`)
      options.push({ action: 'trim_existing', layer_id: d.a, edge: 'in', new_t_us: d.b_end })
    }
    return { code: 'invalid_params', message:
      `layer overlap on track ${d.track}: the requested range [${d.b_start}, ${d.b_end}) µs collides with layer ${d.a} at [${d.a_start}, ${d.a_end}) µs. Layers of the same class collide per track (each track has ONE visual lane and ONE audio lane — a track that looks empty can still hold audio, e.g. another clip's auto-paired dialogue). Nothing was committed. Options: ${prose.join('; ')}.`,
    data: {
      error: 'LayerOverlap', track: d.track, blocking_layer: d.a,
      blocking_range_us: [d.a_start, d.a_end], requested_range_us: [d.b_start, d.b_end],
      options,
    } }
  }
  // ── Grid + bounds rules: the only ValidationErrors an agent can fix mechanically ──
  // These three carry `snap_to` (computed in validate.ts, where the lattice is in
  // hand), so surface it — the agent must not re-derive the lattice arithmetic.
  if (e.error === 'ValidationFailed' && e.detail.rule === 'OffGridLayerBoundary') {
    const d = e.detail
    // Name the lattice, not just the numbers: an Audio rejection reports fps 48000/1
    // and would otherwise read as an absurd 48000 fps composition.
    const lattice = d.grid === 'sample' ? `the ${d.fps.num} Hz audio sample lattice` : `the ${d.fps.num}/${d.fps.den} composition frame grid`
    return { code: 'invalid_params', message: `layer ${d.layer} ${d.field} ${d.t} µs is not on ${lattice}; nearest is ${d.snap_to}`, data: {
      error: 'OffGridLayerBoundary', layer: d.layer, field: d.field,
      requested_us: d.t, snap_to_us: d.snap_to, grid: d.grid, rate: [d.fps.num, d.fps.den],
      options: [{ action: 'retry_snapped', field: d.field, t_us: d.snap_to }],
    } }
  }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'OffGridTime') {
    const d = e.detail
    return { code: 'invalid_params', message: `${d.entity} ${d.field} ${d.t} µs is not on the ${d.fps.num}/${d.fps.den} composition frame grid; nearest is ${d.snap_to}`, data: {
      error: 'OffGridTime', entity: d.entity, id: d.id, field: d.field,
      requested_us: d.t, snap_to_us: d.snap_to, grid: 'frame', rate: [d.fps.num, d.fps.den],
      options: [{ action: 'retry_snapped', field: d.field, t_us: d.snap_to }],
    } }
  }
  // ── Composition container rules (ADR 0052) — structural, so prose only. ──
  if (e.error === 'ValidationFailed') {
    const d = e.detail
    switch (d.rule) {
      case 'RootMissing': return { code: 'invalid_params', message: `root_id ${d.root_id} is not a key of compositions` }
      case 'CompositionIdMismatch': return { code: 'invalid_params', message: `compositions[${d.key}] carries id ${d.id}; the key must equal the composition's id` }
      case 'CompositionMissing': return { code: 'invalid_params', message: `layer ${d.layer} references composition ${d.composition}, which does not exist` }
      case 'RootReferenced': return { code: 'invalid_params', message: `layer ${d.layer} references the root composition; only a Group can be placed as a layer` }
      case 'CompositionCycle': return { code: 'invalid_params', message: `composition references form a cycle: ${d.path.join(' → ')}` }
      case 'CompositionLatticeMismatch': return { code: 'invalid_params', message: `composition ${d.composition} differs from the root on ${d.field}; every composition shares the root's fps, sample_rate and channels (update_composition on the root cascades them)` }
      default: break
    }
  }
  if (e.error === 'CompositionNotFound') return { code: 'invalid_params', message: `composition ${e.composition} not found` }
  // Scope refusals (ADR 0052): name BOTH compositions, because the fix is a
  // different destination or a narrower set, and the ids are what the agent
  // reads back from `project://compositions`.
  if (e.error === 'CrossCompositionMove') return { code: 'invalid_params', message: `layer ${e.layer} lives in composition ${e.from}; the destination is in composition ${e.to}. A *move* never crosses a composition: pick a track / anchor inside ${e.from}, or cross deliberately with move_layers_to_composition (name ${e.to} and a landing time), add_group_members (move into a Group clip you can see), create_group (pre-compose) or ungroup_layer` }
  if (e.error === 'CrossCompositionSet') return { code: 'invalid_params', message: `layer ${e.layer} is in composition ${e.composition}, but this operation is confined to composition ${e.expected} — for a set of layers that is where its first member lives; for a marker's anchor, where the marker lives. One composition per call: split the work, or cross deliberately with move_layers_to_composition / add_group_members` }
  // `expected` is already a human-readable kind ('visual', 'CompositionRef',
  // 'VideoClip | Audio | CompositionRef'), so it carries the whole fix. Without
  // this arm the fallthrough sends the bare word `WrongLayerKind` — no layer, no
  // kind, nothing to act on, and the client drops `data` (see LayerOverlap).
  if (e.error === 'WrongLayerKind') return { code: 'invalid_params', message: `layer ${e.layer} is the wrong kind for this operation, which acts on ${e.expected}. The fix is a different layer, not different arguments — project://tracks reports each layer's kind` }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'NegativeLayerStart') {
    const d = e.detail
    return { code: 'invalid_params', message: `layer ${d.layer} would start at ${d.t_start} µs; timeline time starts at 0`, data: {
      error: 'NegativeLayerStart', layer: d.layer, requested_us: d.t_start,
      options: [{ action: 'retry_clamped', t_start_us: 0 }],
    } }
  }
  // The strict (agent) trim: the window is the fix, so it rides the message.
  if (e.error === 'TrimEdgeOutOfRange') {
    const which = e.edge === 'Out' ? 't_end_us' : e.edge === 'In' ? 't_start_us' : 'the edge'
    const bound = e.window
      ? ` — ${which} may land within [${e.window.lo}, ${e.window.hi >= Number.MAX_SAFE_INTEGER ? '∞' : e.window.hi}] µs (the other edge, the source's length and every aligned link member bound it)`
      : ''
    return { code: 'invalid_params', message: `layer ${e.layer} cannot be trimmed to ${e.new_t} µs: it spans [${e.cur_start}, ${e.cur_end}) µs${bound}. Nothing was changed; a trim is never clamped — send a time inside the window, or split_layer / delete_layers for a cut.`, data: {
      error: 'TrimEdgeOutOfRange', layer: e.layer, requested_us: e.new_t, span_us: [e.cur_start, e.cur_end],
      ...(e.window ? { window_us: [e.window.lo, e.window.hi] } : {}),
    } }
  }
  if (e.error === 'MediaInUse') {
    return { code: 'invalid_params', message: `media ${e.media} is still used by ${e.referenced_by.length} layer(s): ${e.referenced_by.join(', ')}. Nothing was removed. Options: delete_media { media_id, force: true } removes those layers with it (their links and any lane they empty go too), or delete_layers them first and retry.`, data: {
      error: 'MediaInUse', media: e.media, referenced_by: e.referenced_by,
      options: [
        { action: 'force_remove', note: 'calls delete_media with force=true; cascades layer deletions' },
        { action: 'delete_layers_first', layer_ids: e.referenced_by },
      ],
    } }
  }
  if (e.error === 'TransitionInsufficientHandle') {
    return { code: 'invalid_params', message: `insufficient tail media on the outgoing layer ${e.layer}: only ${e.available_us} µs remaining past its source out-point — borrow at most that (a shorter extend-add duration_us, or a smaller extended_us). Overlap placement borrows nothing and is not length-limited by the tail.`, data: {
      error: 'TransitionInsufficientHandle', layer: e.layer, available_us: e.available_us,
    } }
  }
  if (e.error === 'TransitionRestoreCollision') {
    return { code: 'invalid_params', message: `removing the transition moves layer ${e.layer} back toward the cut, but its destination is occupied — the gap left by the transition placement has been filled; move or delete the blocking layer first (the system never makes room)`, data: {
      error: 'TransitionRestoreCollision', layer: e.layer,
    } }
  }
  if (e.error === 'TransitionParticipantsShareLink') {
    return { code: 'invalid_params', message: `layers ${e.from} and ${e.to} share a link: overlap placement moves the incoming layer left, which would drag the outgoing layer along and the overlap would never open. Options: unlink them (update_link) and retry; or pass placement 'extend' to borrow outgoing tail media instead (positions untouched).`, data: {
      error: 'TransitionParticipantsShareLink', from: e.from, to: e.to,
      options: [
        { action: 'unlink_then_retry', layer_ids: [e.from, e.to] },
        { action: 'retry_with_placement', placement: 'extend' },
      ],
    } }
  }
  if (e.error === 'TransitionUnsupportedLayerKind') {
    return { code: 'invalid_params', message: `transitions are for visual layers only: layer ${e.layer} is ${e.kind} (audio crossfades are not supported yet)`, data: {
      error: 'TransitionUnsupportedLayerKind', layer: e.layer, kind: e.kind,
    } }
  }
  // ── Ripple delete (ADR 0062). Each message spells the span as [s, e) µs — the
  // hole is the deleted layer's footprint clipped to its neighbours, not its
  // length, so an agent that assumed the length would otherwise read the refusal
  // against the wrong numbers. Every one is pre-write: the retry costs nothing. ──
  if (e.error === 'RippleInsideHole') {
    const verb = tool === RIPPLE_TOOL.pauses ? 'the pause cut' : tool === RIPPLE_TOOL.gap ? 'closing the gap' : 'ripple delete'
    const remedy = rippleRemedy(tool, e.layer,
      `add ${e.layer} to layer_ids, so its own hole merges into this one and both close in a single ripple`,
      `call delete_layers without ripple (its default), which removes the layers and leaves the span open`)
    return { code: 'invalid_params', message: `layer ${e.layer} starts inside the span [${e.hole.s}, ${e.hole.e}) µs that ${verb} would close, and the span has to come out clean. Nothing was changed. Options: ${remedy}. A layer that merely reaches into the span from before ${e.hole.s} is anchored ahead of the cut and does not block.`, data: {
      error: 'RippleInsideHole', layer: e.layer, hole_us: [e.hole.s, e.hole.e], tool: tool ?? null,
      options: tool === RIPPLE_TOOL.deleteLayers || tool === undefined
        ? [{ action: 'add_to_set_then_retry', layer_ids: [e.layer] }, { action: 'delete_without_ripple', tool: 'delete_layers', ripple: false }]
        : [{ action: 'move_or_delete_first', layer_id: e.layer }],
    } }
  }
  if (e.error === 'RippleCollision') {
    const narrow = tool === RIPPLE_TOOL.deleteLayers || tool === undefined ? ', or narrow layer_ids so the span it closes is shorter' : ''
    return { code: 'invalid_params', message: `layer ${e.moving} would shift left onto layer ${e.blocking} on track ${e.track}: a ripple never makes room, so move_layer or delete_layers ${e.blocking} first${narrow}. Nothing was changed. A transition's overlap is authorized only while both its participants shift by the same amount.`, data: {
      error: 'RippleCollision', moving: e.moving, blocking: e.blocking, track: e.track, tool: tool ?? null,
    } }
  }
  if (e.error === 'RippleLinkStraddles') {
    const widen = tool === RIPPLE_TOOL.deleteLayers || tool === undefined ? '; or add the straddling members to layer_ids so the whole link goes with the cut' : ''
    return { code: 'invalid_params', message: `link ${e.link} has members on both sides of the span [${e.hole.s}, ${e.hole.e}) µs — one reaches across the span's start, another starts at or after its end — and a link means those layers move together, so shifting only the downstream half is not on offer (a member that ends at or before the span is wholly upstream and does not count). Nothing was changed. Options: dissolve the link (delete_link ${e.link}) or drop the downstream member from it (update_link) and retry${widen}.`, data: {
      error: 'RippleLinkStraddles', link: e.link, hole_us: [e.hole.s, e.hole.e], tool: tool ?? null,
      options: [{ action: 'unlink_then_retry', link_id: e.link }],
    } }
  }
  if (e.error === 'RippleLockedLayer') {
    const narrow = tool === RIPPLE_TOOL.deleteLayers || tool === undefined ? `, or narrow layer_ids so nothing downstream of ${e.layer} is removed` : ''
    return { code: 'invalid_params', message: `layer ${e.layer} is locked and would have to move: a ripple shifts everything that starts at or after the span it closes. Unlock it (update_layer { patch: { locked: false } }) and retry${narrow}. Nothing was changed. Only a layer that actually shifts blocks — a locked layer upstream of the cut is fine.`, data: {
      error: 'RippleLockedLayer', layer: e.layer, tool: tool ?? null,
    } }
  }
  // ── Gap closing (ADR 0069). The span is echoed because the fix is to re-read
  // the track and send the gap as it is NOW: either a layer has reached into
  // the span since it was measured, or an edge is not a layer boundary. ──
  if (e.error === 'GapNotFound') {
    return { code: 'invalid_params', message: `[${e.s}, ${e.e}) µs is not a gap on track ${e.track}: a gap is the WHOLE empty span between two layer boundaries on one track — end_us exactly where a layer starts, start_us exactly where one ends (or 0) — with no layer reaching into it. Re-read the track (project://compositions) and send the gap as it is now; the space after the last layer on a track is not a gap.`, data: {
      error: 'GapNotFound', track: e.track, span_us: [e.s, e.e],
      options: [{ action: 'reread_then_retry', resource: 'project://compositions' }],
    } }
  }
  // ── Groups (ADR 0052). Each message says what was refused AND why, because the
  // client drops `data` and the fix differs per cause. ──
  if (e.error === 'GroupLockedMember') return { code: 'invalid_params', message: `layer ${e.layer} is locked: pre-compose and add-to-Group move every selected layer or none. Unlock it (update_layer { patch: { locked: false } }) or leave it out of layer_ids` }
  if (e.error === 'GroupNotPlain') return { code: 'invalid_params', message: `Group layer ${e.layer} is not plain: its ${e.reason} is not the identity and ungroup would discard it silently. Reset the ${e.reason} on the Group layer first (update_layer_params / delete_effect), or keep the Group` }
  if (e.error === 'CompositionInUse') return { code: 'invalid_params', message: `composition ${e.composition} is still referenced by ${e.ref_count} Group layer(s); delete or ungroup them first (project://compositions lists ref_count)` }
  if (e.error === 'RootComposition') return { code: 'invalid_params', message: `composition ${e.composition} is the root: it has no name and export renders it, so it is never renamed or deleted` }
  // ── Audio effects (ADR 0063). Both name the RULE, not just the violation:
  // the client drops `data`, and each refusal is an agent's first encounter
  // with a namespace and a static-only constraint the visual effects don't have. ──
  if (e.error === 'EffectKindNotApplicable') {
    return { code: 'invalid_params', message: `effect kind '${e.kind}' does not apply to a ${e.layer_kind} layer: the audio.* namespace is for Audio layers and only Audio layers, and a visual effect kind never lands on one. Audio effects (audio.denoise) are offline conform bakes; visual effects are realtime filters. The fix is a different layer or a different kind — project://tracks reports each layer's kind`, data: {
      error: 'EffectKindNotApplicable', kind: e.kind, layer_kind: e.layer_kind,
    } }
  }
  if (e.error === 'AudioEffectParamStatic') {
    return { code: 'invalid_params', message: `effect ${e.effect} param '${e.param}' belongs to an audio.* effect, whose params are STATIC ONLY: an audio effect is a whole-clip offline bake, so there is no per-frame value to animate. Send it with update_effect as {"${e.param}": {"mode": "Static", "value": <number>}}; set_keyframe and a Keyframed update_layer_param_track are rejected on it`, data: {
      error: 'AudioEffectParamStatic', effect: e.effect, param: e.param,
    } }
  }
  // ── Every remaining variant, one arm each: the id, the field, the read that
  // lists valid ones, the next call. The order follows the union in
  // shared/commandErrors.ts; `mcp.errors` enumerates the vocabulary so a new
  // variant cannot fall through to a bare name again. ──
  switch (e.error) {
    case 'TrackNotFound':
      return { code: 'invalid_params', message: `track ${e.track} not found — project://tracks lists the current tracks; a track disappears when its last layer leaves it, so an id read before a delete or a move may be gone` }
    case 'LayerNotFound':
      return { code: 'invalid_params', message: `layer ${e.layer} not found — it may have been deleted, split (the right half carries a new id) or pruned with its track; project://tracks lists the current layers, and every mutator's answer carries the ids it minted` }
    case 'MarkerNotFound':
      return { code: 'invalid_params', message: `marker ${e.marker} not found — project://markers lists the composition's markers (add composition=<id> for a Group's)` }
    case 'TransitionNotFound':
      return { code: 'invalid_params', message: `transition ${e.transition} not found — the composition's \`transitions\` in project://current list them; deleting either participant removes its transition` }
    case 'TransitionLayersNotAdjacent':
      return { code: 'invalid_params', message: `layers ${e.from} (outgoing) and ${e.to} (incoming) are not adjacent on one track: the outgoing layer must END exactly where the incoming one STARTS, on the same track (or already overlap by exactly ${e.duration} µs to attach as-is). move_layer / trim_layer them to meet, then retry; project://tracks shows both spans`, data: { error: 'TransitionLayersNotAdjacent', from: e.from, to: e.to, duration_us: e.duration } }
    case 'CheckpointNotFound':
      return { code: 'invalid_params', message: `checkpoint ${e.checkpoint} not found — list_checkpoints reports the ones that exist (a deleted checkpoint's id is gone for good)` }
    case 'MediaNotFound':
      return { code: 'invalid_params', message: `media ${e.media} not found — project://media lists the pool; import_media adds a file and answers its media_id` }
    case 'TrackPositionOutOfRange':
      return { code: 'invalid_params', message: `new_position ${e.position} is out of range for a stack of ${e.len} track(s): positions run 0..${Math.max(0, e.len - 1)}, 0 being the bottom`, data: { error: 'TrackPositionOutOfRange', position: e.position, len: e.len } }
    case 'TrackNotEmpty':
      return { code: 'invalid_params', message: `track ${e.track} still holds layers: delete_track { track_id, force: true } deletes them with it, or move_layer / delete_layers them first. Nothing was removed` }
    case 'TrackNotRemovable':
      return { code: 'invalid_params', message: `track ${e.track} is a reserved track (A roll / B roll / audio / captions) and is never removed; its layers can be — delete_layers them, and the track stays empty` }
    case 'TrackLocked':
      return { code: 'invalid_params', message: `track ${e.track} is locked and refuses edits to the layers on it (a locked track blocks the WHOLE batch it appears in). set_track_flags { track_id: "${e.track}", locked: false } clears it; a layer's own \`locked\` is separate (update_layer)`, data: { error: 'TrackLocked', track: e.track, options: [{ action: 'unlock_track', tool: 'set_track_flags', track_id: e.track, locked: false }] } }
    case 'SplitOutsideLayer':
      return { code: 'invalid_params', message: `split at ${e.at_t} µs is outside layer ${e.layer}: at_t_us must be strictly inside the layer's span (t_start_us, t_end_us) — project://layers/${e.layer} has the span. Nothing was split`, data: { error: 'SplitOutsideLayer', layer: e.layer, at_t_us: e.at_t } }
    case 'LinkLockedMember':
      return { code: 'invalid_params', message: `layer ${e.touched} moves with link ${e.link}, whose member ${e.locked_layer} is locked, so the whole link refuses. Unlock it (update_layer { layer_id: "${e.locked_layer}", patch: { locked: false } }) or pass escape_link: true to move ${e.touched} alone`, data: { error: 'LinkLockedMember', link: e.link, locked_layer: e.locked_layer, touched: e.touched } }
    case 'LayerParamsKindMismatch':
      return { code: 'invalid_params', message: `layer ${e.layer} is a ${e.actual} layer, not ${e.patch}: send patch.kind "${e.actual}" (project://tracks reports each layer's kind). Nothing was changed`, data: { error: 'LayerParamsKindMismatch', layer: e.layer, actual: e.actual, patch: e.patch } }
    case 'LinkNotFound':
      return { code: 'invalid_params', message: `link ${e.link} not found — the composition's \`links\` in project://current list them (a layer's record carries its link_id); a link dissolves by itself when it falls below two members` }
    case 'LayerAlreadyLinked':
      return { code: 'invalid_params', message: `layer ${e.layer} is already a member of link ${e.existing}: pass reassign: true to move it into the new link (its old link dissolves below two members), or update_link ${e.existing} instead`, data: { error: 'LayerAlreadyLinked', layer: e.layer, existing: e.existing, options: [{ action: 'retry_with_reassign', reassign: true }] } }
    case 'LinkCreateNeedsTwoLayers':
      return { code: 'invalid_params', message: `create_link needs at least two DISTINCT layer ids, got ${e.got}` }
    case 'LayerNotInLink':
      return { code: 'invalid_params', message: `layer ${e.layer} is not a member of link ${e.link} — the layer's record (or project://tracks) carries its link_id` }
    case 'NothingToUndo':
      return { code: 'invalid_params', message: `nothing to undo: the history cursor is at the oldest surviving state (project://history reports cursor, len and evicted)` }
    case 'NothingToRedo':
      return { code: 'invalid_params', message: `nothing to redo: the history cursor is at the newest state — a new edit after an undo truncates the redo tail` }
    case 'HistoryLocked':
      return { code: 'invalid_params', message: `history is locked: ${e.reason}. undo, redo, jump_to and restore_checkpoint are blocked until set_history_lock { locked: false } (any connection may clear it) or the owning work session ends; edits still record`, data: { error: 'HistoryLocked', reason: e.reason, options: [{ action: 'unlock_history', tool: 'set_history_lock', locked: false }] } }
    case 'EmptyKeyframeTrack':
      return { code: 'invalid_params', message: `param '${e.param_key}' on layer ${e.layer} is Keyframed with no keys — a track needs at least one; set_keyframe adds one, clear_keyframes collapses it to Static`, data: { error: 'EmptyKeyframeTrack', layer: e.layer, param_key: e.param_key } }
    case 'UnknownKeyframeParam':
      return { code: 'invalid_params', message: `'${e.param_key}' is not an animatable param of layer ${e.layer} (its kind decides — project://tracks reports it). Animatable keys: ${KEYFRAME_PARAM_KEYS}. Static text/colour/box fields are update_layer_params`, data: { error: 'UnknownKeyframeParam', layer: e.layer, param_key: e.param_key } }
    case 'EffectNotFound':
      return { code: 'invalid_params', message: `effect ${e.effect} not found on that layer — project://layers/<layer_id> lists the chain under \`effects\`, and add_effect's answer carries the effect_id it minted` }
    case 'EffectIndexOutOfRange':
      return { code: 'invalid_params', message: `new_index ${e.index} is out of range for a chain of ${e.len} effect(s): indices run 0..${Math.max(0, e.len - 1)}, 0 applied first`, data: { error: 'EffectIndexOutOfRange', index: e.index, len: e.len } }
    case 'FpsLockedByContent':
      return { code: 'invalid_params', message: `fps is locked at ${e.current.num}/${e.current.den}: changing it to ${e.requested.num}/${e.requested.den} would re-snap every edit point, and ${e.locked_by === 'current' ? `the timeline holds ${e.layer_count} layer(s)` : 'a history snapshot or checkpoint still holds layers (undo could resurrect them)'}. Set the rate on a project that has never held a layer, or empty the timeline and reopen the project to clear the history lock`, data: { error: 'FpsLockedByContent', current: e.current, requested: e.requested, layer_count: e.layer_count, locked_by: e.locked_by } }
    case 'ValidationFailed': {
      // Every enriched rule returned above; the rest are structural (a duplicate
      // id, a missing media, a lattice mismatch) — name the rule AND its fields
      // so the caller reads which entity broke which invariant.
      const { rule, ...fields } = e.detail as { rule: string } & Record<string, unknown>
      const facts = Object.entries(fields).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')
      return { code: 'invalid_params', message: `validation failed: ${rule}${facts ? ` (${facts})` : ''}. Nothing was committed — the edit would have broken a project invariant; project://current shows the state it was checked against`, data: { error: 'ValidationFailed', rule, ...fields } }
    }
    default: {
      // The union is closed; a variant reaching here is one this mapper does not
      // know yet, which the vocabulary gate (`mcp.errors`) is there to catch.
      const rest = e as { error: string } & Record<string, unknown>
      const { error: name, ...fields } = rest
      const facts = Object.entries(fields).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')
      return { code: 'invalid_params', message: `${name}${facts ? ` (${facts})` : ''}. Nothing was committed`, data: rest }
    }
  }
}

// Presence check; the caller throws McpArgError on false.
export function keyframePresent(track: { mode: string; value: unknown }, id: string): boolean {
  return track.mode === 'Keyframed' && Array.isArray((track as { value: Array<{ id: string }> }).value)
    && (track as { value: Array<{ id: string }> }).value.some((k) => k.id === id)
}

/** Single-source record per MCP tool. Table-exec tools carry parseArgs; what
 *  they ANSWER with is `MCP_RESULT_READERS[name]` (mcp-results.ts), read back
 *  from the committed snapshot. Dedicated-exec tools carry stub records only —
 *  their parseDedicated arms are attached at registration. */
/** MCP tool annotations, advertised in `tools/list` and the ONE statement of
 *  the read/write and destructive split: the activity service's read rows take
 *  `readOnlyHint` from the merged catalog, so the agent panel and the client
 *  can never disagree about which calls commit (audit S3 — the regex over tool
 *  names this replaces knew nothing the table did not, and was a second list).
 *  The spec's defaults are `readOnlyHint: false`, `destructiveHint: true`,
 *  `idempotentHint: false`; each constant states only what differs from them,
 *  and every def carries one, which the type enforces. */
export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
/** A read: commits nothing; the agent panel folds it as a quick read. */
export const ANN_READ: ToolAnnotations = { readOnlyHint: true }
/** A write that creates or shifts — calling it twice does it twice. */
export const ANN_WRITE: ToolAnnotations = { destructiveHint: false }
/** A write that sets state — the same call twice leaves the same state. */
export const ANN_SET: ToolAnnotations = { destructiveHint: false, idempotentHint: true }
/** A write that removes or reverts: what it takes away, undo (or a checkpoint) is the way back to. */
export const ANN_DESTRUCTIVE: ToolAnnotations = { destructiveHint: true }

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  exec: 'table' | 'dedicated'
  annotations: ToolAnnotations
  parseArgs?: (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }  // table-exec only
  parseDedicated?: (a: Record<string, unknown>) => Record<string, unknown>                    // dedicated-exec only
}

// ── Shared schema fragments ──────────────────────────────────────────────────
// Every advertised property MUST carry a "type": MCP clients (Claude Code
// verified) coerce untyped fields to `type: string`, which FORCES the model to
// send nested payloads as JSON-encoded strings no matter how it is prompted —
// the server then rejects or, worse, silently ignores them.
// mcp.catalog-bijection.test.ts gates this catalog-wide.
// ── Property schemas carry their meaning ────────────────────────────────────
// Every advertised property has a one-line description with its unit, so an
// agent learns a field from the schema rather than from a failed call (the
// audit's testers spent their first ten to twenty calls learning vocabularies
// the schema could have carried — S2). `mcp.description-budget` counts the
// properties that do not. Ids and times recur on most tools, so they are
// minted here once; a `null` arm is advertised only where null MEANS something
// omission does not (clear a label, unpin a duration, return a text box axis
// to auto) — an optional field is simply not required.
const ID_SCHEMA = (what: string) => ({ type: 'string', description: `${what} id.` })
const LAYER_ID_SCHEMA = ID_SCHEMA('Layer')
const TRACK_ID_SCHEMA = ID_SCHEMA('Track')
const LAYER_IDS_SCHEMA = (what: string) => ({ type: 'array', items: { type: 'string' }, description: what })
const US_SCHEMA = (what: string) => ({ type: 'integer', description: `${what}, µs.` })
const T_START_SCHEMA = US_SCHEMA('Timeline start')
const T_END_SCHEMA = US_SCHEMA('Timeline end (exclusive)')
const SRC_IN_SCHEMA = US_SCHEMA('Source in point')
const SRC_OUT_SCHEMA = US_SCHEMA('Source out point (exclusive)')
const ESCAPE_LINK_SCHEMA = { type: 'boolean', description: 'Act on this layer alone, leaving its link partners in place. Default false.' }
const RGBA_SCHEMA = { type: 'object', description: 'Colour, integer channels 0..255.', properties: { r: { type: 'integer', description: 'Red 0..255.' }, g: { type: 'integer', description: 'Green 0..255.' }, b: { type: 'integer', description: 'Blue 0..255.' }, a: { type: 'integer', description: 'Alpha 0..255; 255 opaque.' } }, required: ['r', 'g', 'b', 'a'] }
// The creation-op scope (ADR 0052): only tools that CREATE take it. Every
// layer-addressed tool derives its composition from the layer id — an agent
// editing inside a Group never names the Group. Two spellings of the same
// optional field: the second for tools whose required `track_id` already fixes
// the composition, where the id is a cross-check rather than a choice.
const COMPOSITION_ID_SCHEMA = { type: 'string', description: 'Composition to create in — a Group\'s id from `project://compositions`; omit for the root.' }
const TRACK_COMPOSITION_ID_SCHEMA = { type: 'string', description: 'Optional cross-check: the composition `track_id` belongs to; refused on mismatch. The track alone fixes the composition.' }
export function parseCompositionIdOpt(v: unknown): string | null {
  return v === undefined || v === null ? null : parseUuid(v, 'composition_id')
}
/** `move_layers_to_composition`'s destination lane: a lane id, the literal
 *  `'spawn'`, or absent/null for "no opinion". The literal is matched before
 *  parseUuid so a typo (`'spwan'`) rejects at the boundary instead of arriving
 *  as the silent no-opinion move. */
export function parseDestTrackOpt(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (v === 'spawn') return 'spawn'
  return parseUuid(v, 'to_track_id')
}
const INTERP_SCHEMA = {
  type: 'object',
  description: 'Easing: {"kind":"Hold"} | {"kind":"Linear"} | {"kind":"Bezier","p1":[x,y],"p2":[x,y]} | {"kind":"Elastic","dir",amplitude?,period?} | {"kind":"Bounce","dir"}.',
  properties: {
    kind: { type: 'string', enum: ['Hold', 'Linear', 'Bezier', 'Elastic', 'Bounce'], description: 'Easing kind of the segment leaving the key.' },
    p1: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Bezier only: first control point [x, y]; x within [0, 1].' },
    p2: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Bezier only: second control point [x, y]; x within [0, 1].' },
    dir: { type: 'string', enum: ['In', 'Out', 'InOut'], description: 'Elastic/Bounce only: easing direction.' },
    amplitude: { type: 'number', description: `Elastic only: overshoot amplitude, >= 1. Omit for the default ${ELASTIC_DEFAULT_AMPLITUDE}.` },
    period: { type: 'number', description: `Elastic only: oscillation period, > 0. Omit for the default ${ELASTIC_DEFAULT_PERIOD}.` },
  },
  required: ['kind'],
}
// update_keyframe's interp: the raw INTERP_SCHEMA kinds PLUS the preset
// form. `required` is empty — the two forms share no mandatory field; the
// exactly-one-of rule is parseEasing's. The preset enum derives from the
// canonical table, so the advertised ids can never drift from what bakes.
const EASING_SCHEMA = {
  type: 'object',
  description: 'Either {"preset":"<id>"} — a canonical named preset, baked to its params — or a raw kind (same forms as set_keyframe interp).',
  properties: {
    preset: { type: 'string', enum: EASING_PRESETS.map((p) => p.id), description: 'Preset id from the canonical easing table (e.g. "ease_in_out", "ease_out_expo", "ease_in_out_bounce").' },
    ...INTERP_SCHEMA.properties,
  },
  required: [],
}
const TANGENT_SCHEMA = {
  type: 'object',
  description: 'One side of a key: {x, y} in the owning segment\'s unit square (x = fraction of its time span, y of its value span), plus `mode` — "Auto" (solved on every write) or "Free" (authored). `in` is stored un-mirrored.',
  properties: {
    x: { type: 'number', description: "Fraction of the segment's time span, 0..1." },
    y: { type: 'number', description: "Fraction of the segment's value span; may overshoot." },
    mode: { type: 'string', enum: ['Auto', 'Free'], description: 'Auto: solved on every write. Free: as authored.' },
  },
  required: ['x', 'y', 'mode'],
}
const SEGMENT_SCHEMA = {
  type: 'object',
  description: 'Class of the segment LEAVING the key: Spline (reads the tangents) | Hold | Linear | Elastic (dir, amplitude?, period?) | Bounce (dir).',
  properties: {
    kind: { type: 'string', enum: ['Spline', 'Hold', 'Linear', 'Elastic', 'Bounce'], description: 'Class of the segment leaving the key; only Spline reads the tangents.' },
    dir: INTERP_SCHEMA.properties.dir,
    amplitude: INTERP_SCHEMA.properties.amplitude,
    period: INTERP_SCHEMA.properties.period,
  },
  required: ['kind'],
}
// A tangent WRITE (update_keyframe): no mode — a written side is Free.
const TANGENT_XY_SCHEMA = {
  type: 'object',
  description: 'A tangent to write: {x, y} in the owning segment\'s unit square — x within [0, 1] (refused outside), y may overshoot. Stored Free.',
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1, description: "Fraction of the segment's time span, 0..1." },
    y: { type: 'number', description: "Fraction of the segment's value span; may overshoot." },
  },
  required: ['x', 'y'],
}
const EXTRAPOLATE_SCHEMA = {
  type: 'string', enum: [...EXTRAPOLATES],
  description: 'Hold = the end value; Loop = repeat the cycle; PingPong = alternate cycles reversed; Offset = each cycle adds the last-minus-first delta; Continue = carry the end velocity on as a line.',
}
const EXTRAPOLATION_SCHEMA = {
  type: 'object',
  description: 'What the track does outside its keys, per side: Hold | Loop | PingPong | Offset | Continue (see set_extrapolation).',
  properties: {
    before: { type: 'string', enum: [...EXTRAPOLATES], description: 'Before the first key.' },
    after: { type: 'string', enum: [...EXTRAPOLATES], description: 'After the last key.' },
  },
  required: ['before', 'after'],
}
// A keyframe value: `oneOf` the two wire shapes, plus the union `type` so a
// client that keys its coercion on `type` alone still sees a typed field.
const TRACK_VALUE_SCHEMA = {
  type: ['number', 'object'],
  description: 'Typed by `param_key`: a number for scalar params (x, y, path_progress, scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity, gain_db, pan, effect params), {r,g,b,a} (0..255) for "color". Path mode takes path_progress (a fraction) instead of x/y.',
}
const TRACK_VALUE_OPT_SCHEMA = {
  ...TRACK_VALUE_SCHEMA,
  description: "The value to hold, typed by `param_key`; omit for the first keyframe's value.",
}
/** The track record with its value slot typed per caller. Only the layer-param
 *  union is advertised today: `update_effect` describes its (scalar) params in one
 *  line rather than inlining this record a second time. */
function animTrackSchema(value: Record<string, unknown>, staticTypes: string[], valueNote: string) {
  return {
    type: 'object',
    description: `An animation track: {"mode":"Static","value":v} or {"mode":"Keyframed","value":[keyframes],"extrapolate":{before, after}} (Hold/Hold when omitted). Values are ${valueNote}.`,
    properties: {
      mode: { type: 'string', enum: ['Static', 'Keyframed'], description: 'Static holds one value; Keyframed animates the key array.' },
      value: {
        type: [...staticTypes, 'array'],
        description: `Static: the held value (${valueNote}). Keyframed: the keyframe array.`,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Key id: an existing one updates that key, a fresh one adds.' }, t_us: US_SCHEMA('Key time, timeline-absolute'), value,
            in: { ...TANGENT_SCHEMA, description: 'Arriving tangent.' }, out: { ...TANGENT_SCHEMA, description: 'Leaving tangent.' },
            continuity: { type: 'string', enum: ['Smooth', 'Broken'], description: 'With both sides Free: Smooth keeps their slopes locked equal on write, Broken lets them differ.' },
            segment: SEGMENT_SCHEMA,
          },
          required: ['id', 't_us', 'value', 'in', 'out', 'continuity', 'segment'],
        },
      },
      extrapolate: EXTRAPOLATION_SCHEMA,
    },
    required: ['mode', 'value'],
  }
}
const ANIM_TRACK_SCHEMA = animTrackSchema(TRACK_VALUE_SCHEMA, ['number', 'object'], 'typed by `param_key` — a number, or {r,g,b,a} (integers 0..255) for "color"')

const POINT_SCHEMA = { type: 'object', description: 'A point, composition px.', properties: { x: { type: 'number', description: 'x, composition px.' }, y: { type: 'number', description: 'y, composition px.' } }, required: ['x', 'y'] }
const HANDLE_SCHEMA = (which: string) => ({ ...POINT_SCHEMA, description: `${which} Bezier handle as a vector RELATIVE to \`point\`, composition px; {0,0} on a Line node.` })
// The compact form, not `animTrackSchema`: three copies of the full keyframe
// record would cost ~4 KB of catalog for a shape `set_param_track` already
// spells out in full; the description points there.
const SCALAR_TRACK_SCHEMA = {
  type: 'object',
  description: "A scalar animation track, in `set_param_track`'s record shape.",
  properties: {
    mode: { type: 'string', enum: ['Static', 'Keyframed'], description: 'Static holds one number; Keyframed animates the key array.' },
    value: { type: ['number', 'array'], description: "Static: the number. Keyframed: the keys, in `set_param_track`'s key shape with layer-local `t_us`." },
    extrapolate: EXTRAPOLATION_SCHEMA,
  },
  required: ['mode', 'value'],
}
/** `set_position`'s record: XY (two scalar tracks) or Path (nodes + a scalar
 *  `progress` track). Typed so a client sends objects, not JSON strings; judged
 *  by `positionProblem` on the way in. */
const POSITION_SCHEMA = {
  type: 'object',
  description: 'XY: `x`/`y` tracks in composition px. Path: `path.nodes` plus a `progress` track, 0..1 = distance along the path (Hold/Loop/PingPong extrapolation only).',
  properties: {
    mode: { type: 'string', enum: ['XY', 'Path'], description: 'XY: two scalar tracks. Path: a route plus a progress track.' },
    x: { ...SCALAR_TRACK_SCHEMA, description: 'XY mode: the x track, composition px.' },
    y: { ...SCALAR_TRACK_SCHEMA, description: 'XY mode: the y track, composition px.' },
    path: { type: 'object', description: 'Path mode: the route.', properties: { nodes: { type: 'array', description: '1..128 nodes in route order.', items: {
      type: 'object',
      description: 'One node of the route.',
      properties: {
        id: { type: 'string', description: 'Node id, unique and non-empty (yours to mint).' },
        point: { ...POINT_SCHEMA, description: 'Anchor point, composition px.' },
        in_handle: HANDLE_SCHEMA('Arriving'), out_handle: HANDLE_SCHEMA('Leaving'),
        segment: { type: 'string', enum: ['Line', 'Cubic'], description: 'Span LEAVING this node: Line, or Cubic (reads the handles).' },
        tangent_mode: { type: 'string', enum: ['Corner', 'Smooth', 'Auto'], description: 'Corner: handles independent. Smooth: aligned directions, own lengths. Auto: solved from the neighbours on write.' },
      },
      required: ['id', 'point', 'in_handle', 'out_handle', 'segment', 'tangent_mode'],
    } } }, required: ['nodes'] },
    progress: { ...SCALAR_TRACK_SCHEMA, description: 'Path mode: distance along the route, 0..1 (Hold / Loop / PingPong extrapolation only).' },
  },
  required: ['mode'],
}

/** `param_key`: the animatable params by name, or an effect param by path.
 *  Advertised as an enum plus a pattern so a typo is caught at the schema; the
 *  per-kind rule (a Text layer has no `scale_x`) stays the parser's
 *  (`UnknownKeyframeParam`), which names the layer's own set. */
export const PARAM_KEYS = ['x', 'y', 'path_progress', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y', 'opacity', 'color', 'gain_db', 'pan'] as const
export const EFFECT_PARAM_KEY_PATTERN = '^effects\\[[0-9a-fA-F-]{36}\\]\\.params\\[[A-Za-z0-9_]+\\]$'
const PARAM_KEY_SCHEMA = {
  type: 'string',
  description: 'Animatable param: visual kinds x, y (path_progress in Path mode), scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity; Text and Color color; Audio gain_db, pan; or an effect param as effects[<effect_id>].params[<key>].',
  anyOf: [{ enum: [...PARAM_KEYS] }, { pattern: EFFECT_PARAM_KEY_PATTERN }],
}

/** `update_layer_params`'s patch, one variant per kind, generated from the
 *  same key table the parser refuses against (`LAYER_PARAMS_KEYS`), so the
 *  advertised fields and the accepted ones cannot drift (`mcp.schema-semantics`
 *  pins it). A client that reads `oneOf` sees each kind's exact set; one that
 *  does not still sees `kind` and its enum. */
const LAYER_PARAM_FIELD_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  content: { type: 'string', description: 'The text; newlines are honoured.' },
  font_family: { type: 'string', description: 'Font family name.' },
  font_size_px: { type: 'number', description: 'Font size, composition px.' },
  color: { ...RGBA_SCHEMA, description: 'Fill colour.' },
  font_weight: { type: 'integer', description: 'CSS weight 100..900; 400 regular, 700 bold.' },
  italic: { type: 'boolean', description: 'Italic face.' },
  shadow: { type: ['object', 'null'], description: 'Drop shadow, or null for none.', properties: {
    color: { ...RGBA_SCHEMA, description: 'Shadow colour.' },
    offset_x: { type: 'number', description: 'Horizontal offset, composition px.' },
    offset_y: { type: 'number', description: 'Vertical offset, composition px.' },
    blur: { type: 'number', minimum: 0, description: 'Blur radius, composition px; 0 is hard-edged.' },
  }, required: ['color', 'offset_x', 'offset_y', 'blur'] },
  x: { type: 'number', description: 'Anchor x, composition px (refused in Path mode: set_position / translate_path).' },
  y: { type: 'number', description: 'Anchor y, composition px (refused in Path mode).' },
  opacity: { type: 'number', description: 'Opacity 0..1.' },
  align: { type: 'string', enum: [...TEXT_ALIGN_OPTIONS], description: 'Horizontal alignment inside the box.' },
  valign: { type: 'string', enum: [...VALIGN_OPTIONS], description: 'Vertical alignment inside the box.' },
  // `['number', 'null']` on the box pair is the wire contract, not laxness:
  // null is "back to auto", and a bare 'number' would make the one transition
  // the resize modes have no other way to state unsendable. `exclusiveMinimum`
  // applies only to numbers, so it constrains a real extent without
  // contradicting the null arm: a non-positive box is not a narrow box but a
  // broken mode — the renderer reads it as "no box".
  box_w: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Layout box width, composition px, local (before `scale`). null = auto width.' },
  box_h: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Layout box height, composition px, local (before `scale`). null = auto height. Refused when the layer has no box_w and the patch supplies none.' },
  line_height: { type: 'number', description: 'Line height, px; 0 = the font metrics.' },
  letter_spacing: { type: 'number', description: 'Letter spacing, px.' },
  outline_width: { type: 'number', description: 'Stroke width, composition px; 0 removes the outline.' },
  outline_color: { ...RGBA_SCHEMA, description: 'Stroke colour.' },
  src_in_us: SRC_IN_SCHEMA,
  src_out_us: SRC_OUT_SCHEMA,
  scale_x: { type: 'number', description: 'Horizontal scale factor; 1 = native size.' },
  scale_y: { type: 'number', description: 'Vertical scale factor; 1 = native size.' },
  rotation_deg: { type: 'number', description: 'Rotation, degrees clockwise.' },
  anchor_x: { type: 'number', description: 'Pivot x, fraction of the width (0.5 = centre).' },
  anchor_y: { type: 'number', description: 'Pivot y, fraction of the height (0.5 = centre).' },
  speed: { type: 'number', description: 'Playback rate; 1 = normal.' },
  flip_h: { type: 'boolean', description: 'Mirror horizontally.' },
  flip_v: { type: 'boolean', description: 'Mirror vertically.' },
  fade_in_us: US_SCHEMA('Fade-in length'),
  fade_out_us: US_SCHEMA('Fade-out length'),
  gain_db: { type: 'number', description: 'Gain, dB; written Static, replacing any keyframes.' },
  pan: { type: 'number', description: 'Stereo pan, -1 (left) .. 1 (right); written Static.' },
  mute: { type: 'boolean', description: 'Silence the clip.' },
  role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'Mixing bus.' },
  width: { type: 'integer', description: 'Colour block width, px.' },
  height: { type: 'integer', description: 'Colour block height, px.' },
  blend_mode: { type: 'string', enum: [...BLEND_MODE_OPTIONS], description: 'How the Group composites over what lies below.' },
  motif_id: { type: 'string', description: 'Motif id from list_motifs.' },
  motif_version: { type: 'integer', description: 'Motif version to bind.' },
  props: { type: 'object', description: "Motif props, matched against its props_schema." },
}
const LAYER_PARAMS_PATCH_SCHEMA = {
  type: 'object',
  description: "Kind-tagged patch: `kind` must match the layer's, and only that kind's fields are accepted (one variant per kind); a key outside the set is refused naming it.",
  properties: { kind: { type: 'string', enum: [...LAYER_PARAM_KINDS], description: "The layer's params.kind, as project://tracks reports it." } },
  required: ['kind'],
  oneOf: LAYER_PARAM_KINDS.map((kind) => ({
    properties: { kind: { const: kind, description: `Fields of a ${kind} layer.` }, ...Object.fromEntries(LAYER_PARAMS_KEYS[kind].map((k) => [k, LAYER_PARAM_FIELD_SCHEMAS[k]])) },
    required: ['kind'],
    additionalProperties: false,
  })),
}

/** The `project://*` views `read_project` serves — one per state-view resource
 *  the TS host answers (`resource-views.ts`), so the two never disagree on what
 *  an agent can read. The Rust-compute resources are not here. */
export const READ_PROJECT_VIEWS = ['current', 'composition', 'compositions', 'media', 'tracks', 'layer', 'markers', 'links', 'transitions', 'settings', 'history', 'session', 'effects', 'media_thumbnail', 'media_frame'] as const
/** The views that take `composition_id` — the per-composition resources. */
export const SCOPED_PROJECT_VIEWS: ReadonlySet<string> = new Set(['composition', 'tracks', 'markers', 'links', 'transitions'])
export type ReadProjectView = (typeof READ_PROJECT_VIEWS)[number]

// ── Single-source MCP tool table ─────────────────────────────────────────────
// Every scalar and patch arg of a table-exec entry is parser-gated in parseArgs:
// uuid/number/enum/boolean scalars through parseX, patch objects through parseObj
// at minimum — a non-object patch must reject, never commit-nothing-and-succeed.
// The dedicated stubs exist only so the MCP_TOOLS projection stays complete;
// their behavior lives in actor.ts arms.
export const MCP_TOOL_DEFS: ReadonlyArray<McpToolDef> = [
  {name:'set_position',exec:'table',annotations:ANN_SET,description:"Replace a layer's position outright: XY tracks, or a motion path with a scalar `progress` track. Times are layer-local µs. Existing XY animation is replaced only by this explicit call. One undo step.",inputSchema:{type:'object',properties:{layer_id:LAYER_ID_SCHEMA,position:POSITION_SCHEMA},required:['layer_id','position']},parseArgs:a=>({op:'set_position',args:{layer:parseUuid(a.layer_id,'layer_id'),position:parsePosition(a.position)}})},
  {name:'translate_path',exec:'table',annotations:ANN_WRITE,description:"Translate the entire spatial path in composition pixels, preserving its geometry and progress animation. Requires Path mode. One undo step.",inputSchema:{type:'object',properties:{layer_id:LAYER_ID_SCHEMA,dx:{type:'number',description:'Shift in x, composition px.'},dy:{type:'number',description:'Shift in y, composition px.'}},required:['layer_id','dx','dy']},parseArgs:a=>({op:'translate_path',args:{layer:parseUuid(a.layer_id,'layer_id'),dx:parseNum(a.dx,'dx'),dy:parseNum(a.dy,'dy')}})},
  // ── table-exec: tracks ───────────────────────────────────────────────────
  { name: 'add_track', exec: 'table', annotations: ANN_WRITE,
    description: "Add a track and return its record (`track_id`, `index`, `composition_id`). Tracks are kind-agnostic — any layer kind goes on any track. A track disappears when its last layer leaves it (deleted or moved away), so place a layer rather than reserving a track; a track created empty survives until it has been filled and emptied.",
    inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'Optional name. Omit it and the track is displayed by its position in the stack, which renumbers as tracks come and go.' }, composition_id: COMPOSITION_ID_SCHEMA }, required: [] },
    parseArgs: (a) => ({ op: 'add_track', args: { label: parseStrOpt(a.label, 'label'), composition_id: parseCompositionIdOpt(a.composition_id) } }) },
  { name: 'delete_track', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Remove a track. Rejects if the track has layers unless force=true. Default A roll / B roll tracks cannot be removed.",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, force: { type: 'boolean', description: 'Also delete the layers still on it. Default false, which refuses a non-empty track (TrackNotEmpty).' } }, required: ['track_id'] },
    parseArgs: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  { name: 'rename_track', exec: 'table', annotations: ANN_SET,
    description: "Name a track, reserved A roll / B roll / audio / caption tracks included. Recorded. `label: null` (or blank) clears it back to the derived name — its role, or its position in the stack.",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, label: { type: ['string', 'null'], description: 'The new name. null or blank clears it back to the displayed-by-default name.' } }, required: ['track_id'] },
    parseArgs: (a) => ({ op: 'rename_track', args: { track: parseUuid(a.track_id, 'track_id'), label: parseStrOpt(a.label, 'label') } }) },
  { name: 'move_track', exec: 'table', annotations: ANN_SET,
    description: "Move a track to a different z-order position. 0 = bottom of stack. Position must be < current track count.",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, new_position: { type: 'integer', description: 'Target index in the stack; 0 is the bottom.' } }, required: ['new_position', 'track_id'] },
    parseArgs: (a) => ({ op: 'move_track', args: { track: parseUuid(a.track_id, 'track_id'), new_position: parseNum(a.new_position, 'new_position') } }) },
  // Two flags of four: `Track` also stores muted/solo, and they are omitted on
  // purpose — the mix folds by ROLE (ADR 0023), so nothing reads a track's, and
  // advertising them would be advertising a write that changes nothing.
  { name: 'set_track_flags', exec: 'table', annotations: ANN_SET,
    description: "Set a track's `enabled` and/or `locked` flag; omit (or null) one to leave it alone, and name at least one. `locked` is what every `TrackLocked` refusal points at — a locked track rejects edits to its layers, and clearing it here is the fix. `enabled` is the track's output in preview and export; its layers stay put. Unrecorded (not undoable), like `set_role_flags`. A layer's own `locked` is separate (`update_layer`), and an edit needs both clear. Mute/solo live on roles: `set_role_flags`. Unrecorded.",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, enabled: { type: 'boolean', description: "The track's output, preview and export alike. Omitted leaves it alone." }, locked: { type: 'boolean', description: 'Whether the track refuses edits to its layers. Omitted leaves it alone.' } }, required: ['track_id'] },
    parseArgs: (a) => {
      const enabled = parseBoolTriState(a.enabled, 'enabled')
      const locked = parseBoolTriState(a.locked, 'locked')
      if (enabled === null && locked === null) throw new McpArgError('set_track_flags needs at least one of `enabled` / `locked`; a call that names no flag would report success having changed nothing')
      return { op: 'update_track_flags', args: { track: parseUuid(a.track_id, 'track_id'), patch: { enabled, locked } } }
    } },
  // ── table-exec: layers ───────────────────────────────────────────────────
  // The one copy tool. `t_start_us` and `t_offset_us` are the two ways to say
  // where the seed's clone goes — absolute, or relative to the seed itself, so
  // a same-place copy needs no read of the timeline first. Exactly one, because
  // a call carrying both names two landings and the actor would have to pick.
  { name: 'paste_layers', exec: 'table', annotations: ANN_WRITE,
    description: "Duplicate a set of layers as one recorded edit — the only copy tool. `layer_ids[0]` is the seed; place its clone with exactly one of `t_start_us` (absolute) or `t_offset_us` (relative to the seed's start). Every other clone shifts by the same delta on its source's track; `target_track_id` moves only the seed's clone. All-or-nothing: a locked or occupied destination for any member rejects the batch (`TrackLocked`, or `LayerOverlap` naming the source whose clone would collide). Two or more clones link to each other, never to their sources; pass a single id to copy one linked layer alone. Returns `{ clones: [{ source, clone }], layers }` in input order.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The layers to clone; the first is the seed the start time refers to.' },
      t_start_us: { type: 'integer', description: "Absolute start time of the seed's clone; the other clones keep their offsets from it. Mutually exclusive with `t_offset_us`." },
      t_offset_us: { type: 'integer', description: "Start of the seed's clone relative to the seed's own start, so `t_offset_us` shifts every clone by that much. Mutually exclusive with `t_start_us`." },
      target_track_id: { type: 'string', description: "Track for the seed's clone. Omit to keep it on the seed's track." },
    }, required: ['layer_ids'] },
    parseArgs: (a) => {
      const absolute = a.t_start_us !== undefined && a.t_start_us !== null
      const relative = a.t_offset_us !== undefined && a.t_offset_us !== null
      if (absolute === relative) throw new McpArgError(
        `paste_layers needs exactly one of \`t_start_us\` / \`t_offset_us\`${absolute ? ' — two of them name two landings' : ''}`,
        absolute ? 't_offset_us' : 't_start_us')
      return { op: 'paste_layers', args: {
        layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')),
        ...(absolute ? { t_start_us: parseNum(a.t_start_us, 't_start_us') } : { t_offset_us: parseNum(a.t_offset_us, 't_offset_us') }),
        target_track_id: a.target_track_id === undefined || a.target_track_id === null ? null : parseUuid(a.target_track_id, 'target_track_id'),
      } }
    } },
  // `enabled` is deliberately absent from `update_layer`'s patch below and lives
  // ONLY here: the two writes are identical for one layer, and the set form is
  // the one that survives a fan-out (a linked A/V pair is one undo, not two).
  { name: 'set_layers_enabled', exec: 'table', annotations: ANN_SET,
    description: "Set `enabled` on exactly these layers in one recorded edit — the only tool that writes it, for one layer or many. Nothing is expanded: to hide a linked A/V pair, pass both members. A layer's own `locked` does not block it; a member on a locked track rejects the whole batch (`TrackLocked`).",
    inputSchema: { type: 'object', properties: { layer_ids: LAYER_IDS_SCHEMA('The layers to show or hide.'), enabled: { type: 'boolean', description: 'true shows, false hides — preview and export alike.' } }, required: ['layer_ids', 'enabled'] },
    parseArgs: (a) => ({ op: 'set_layers_enabled', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), enabled: parseBool(a.enabled, 'enabled') } }) },
  { name: 'update_layer', exec: 'table', annotations: ANN_SET,
    description: "Update a layer's envelope: `label`, `t_start_us`/`t_end_us`, `locked`. Only fields you set apply; time changes are validated; any other key is refused naming the set. Visibility is `set_layers_enabled`; kind-specific params are `update_layer_params`.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, patch: {
      type: 'object',
      description: 'Envelope patch; only the fields you set apply.',
      properties: {
        label: { type: ['string', 'null'], description: 'Display name; null clears it.' },
        t_start_us: { ...T_START_SCHEMA, description: 'New timeline start, µs (snapped to the grid and echoed).' },
        t_end_us: { ...T_END_SCHEMA, description: 'New timeline end (exclusive), µs (snapped and echoed).' },
        locked: { type: 'boolean', description: 'Refuse edits to this layer.' },
      },
    } }, required: ['layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: parseLayerPatch(a.patch) } }) },
  { name: 'update_layer_params', exec: 'table', annotations: ANN_SET,
    description: "Update a layer's kind-specific params. `patch.kind` must match the layer, and only that kind's fields apply — the schema lists each kind's set, and a key outside it is refused naming the set. Audio `gain_db`/`pan` are written as STATIC values, replacing any keyframes. Text is laid out by its BOX, not by scale: `box_w`/`box_h` (composition px, before `scale`) set the resize mode — (null, null) auto width, (set, null) auto height (wraps), (set, set) fixed (wraps, shrinks to fit); `null` returns an axis to auto; `box_h` without a `box_w` is refused. Text has no scale fields here — a bigger title is a bigger box or `font_size_px`; its face is `font_family`, `font_weight` (100..900), `italic`, and `shadow` is a whole record or null. Path mode rejects independent x/y writes: use `translate_path` or `set_position`. `rotation_deg` and the `anchor_x`/`anchor_y` pivot write STATIC values on every visual kind, like `x`/`y`. On a scale-linked layer a patch leaving scale_x ≠ scale_y clears the link in the same commit.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, patch: LAYER_PARAMS_PATCH_SCHEMA }, required: ['layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_layer_params', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: parseLayerParamsPatch(a.patch) } }) },
  { name: 'set_scale_linked', exec: 'table', annotations: ANN_SET,
    description: "Toggle a layer's uniform-scale link (visual kinds only). `linked=true` snaps `scale_y` to a whole-track copy of `scale_x` — keyframes included — in the same commit; `linked=false` clears only the flag. While linked, any write that leaves the two tracks unequal (a single-axis `update_layer_params`, `set_keyframe`, `delete_keyframe`, `set_param_track`) clears the flag in that commit — write both axes identically to keep it.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, linked: { type: 'boolean', description: 'true links scale_y to scale_x; false clears the flag only.' } }, required: ['layer_id', 'linked'] },
    parseArgs: (a) => ({ op: 'set_scale_linked', args: { layer: parseUuid(a.layer_id, 'layer_id'), linked: parseBool(a.linked, 'linked') } }) },
  { name: 'move_layer', exec: 'table', annotations: ANN_SET,
    description: "Move a layer to a different track and/or start time. The end time shifts by the same delta. Cross-track moves are validated against the destination's existing layers — overlap rejects with structured options. A start before 0 (for the layer or a link sibling moving with it) is refused, never clamped. Returns the layer's committed envelope, the link `siblings` that moved with it, and `adjusted` for any grid snap.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, new_t_start_us: US_SCHEMA('New timeline start'), new_track_id: { type: 'string', description: 'Destination track; the current one to move in time only.' }, escape_link: ESCAPE_LINK_SCHEMA }, required: ['layer_id', 'new_t_start_us', 'new_track_id'] },
    parseArgs: (a) => ({ op: 'move_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), to_track: parseUuid(a.new_track_id, 'new_track_id'), t_start_us: parseNum(a.new_t_start_us, 'new_t_start_us'), escape_link: parseBoolOpt(a.escape_link, 'escape_link', false), strict: true } }) },
  { name: 'shift_layers', exec: 'table', annotations: ANN_WRITE,
    description: "Shift a set of layers in time by one `delta_us`, as one recorded edit — the multi-layer move, and with a positive delta at `from_t_us` the ripple INSERT (open a gap, then place into it; a negative delta closes one). Name the set with `layer_ids` (link partners ride along unless `escape_link`) or with `from_t_us` (every layer starting at or after it, on `track_ids` or on every track of the composition). Each layer snaps on its own grid; the record echoes where each landed. Refuses, moving nothing: a start that would cross 0 (`NegativeLayerStart`), a landing on an occupied span (`LayerOverlap`, naming the pair), a locked lane (`TrackLocked`). Returns `{ moved: [layer records], delta_us }`.",
    inputSchema: { type: 'object', properties: {
      layer_ids: LAYER_IDS_SCHEMA('The layers to shift, all in one composition. Exactly one of this and `from_t_us`.'),
      from_t_us: US_SCHEMA('Shift every layer starting at or after this time, timeline'),
      track_ids: { type: 'array', items: { type: 'string' }, description: 'With `from_t_us`: only these tracks. Omit for every track.' },
      delta_us: { type: 'integer', description: 'Signed shift, µs; positive moves later. Not 0.' },
      escape_link: { ...ESCAPE_LINK_SCHEMA, description: 'With `layer_ids`: leave link partners in place. Default false.' },
      composition_id: { ...COMPOSITION_ID_SCHEMA, description: 'With `from_t_us`: the composition to sweep; omit for the root.' },
    }, required: ['delta_us'] },
    parseArgs: (a) => {
      const byIds = a.layer_ids !== undefined && a.layer_ids !== null
      const byTime = a.from_t_us !== undefined && a.from_t_us !== null
      if (byIds === byTime) throw new McpArgError(`shift_layers takes exactly one of \`layer_ids\` / \`from_t_us\`${byIds ? ' — two of them name two sets' : ' — neither names a set'}`, byIds ? 'from_t_us' : 'layer_ids')
      const delta = parseIntNum(a.delta_us, 'delta_us')
      if (delta === 0) throw new McpArgError('delta_us is 0 — nothing would move', 'delta_us')
      return { op: 'shift_layers', args: byIds
        ? { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), delta_us: delta, escape_link: parseBoolOpt(a.escape_link, 'escape_link', false), strict: true }
        : { from_t_us: parseIntNum(a.from_t_us, 'from_t_us'), tracks: a.track_ids === undefined || a.track_ids === null ? null : asArray(a.track_ids, 'track_ids').map((s) => parseUuid(s, 'track_ids')), composition_id: parseCompositionIdOpt(a.composition_id), delta_us: delta, strict: true } }
    } },
  { name: 'restack_layer', exec: 'table', annotations: ANN_SET,
    description: "Restack a visual layer in z-order relative to an ANCHOR layer: `position` 'above' | 'below' puts it directly above/below the anchor's track, resolved at apply time (anchors are layers, not indices, which drift between read and write). A mover that is its track's sole occupant moves the whole track; a mover sharing its track splits onto a new track at the target, and the source is pruned only if that emptied it; a role-stamped A/B-roll track never moves. Front/back are not variants — anchor on the top or bottom of the visual stack. Audio never stacks (`WrongLayerKind`), nor may the anchor be the mover. Already in place = no-op, nothing recorded. One recorded commit.",
    inputSchema: { type: 'object', properties: {
      layer_id: { type: 'string', description: 'The visual layer to restack.' },
      anchor_layer_id: { type: 'string', description: 'The visual layer to place it against; may sit on a reserved track.' },
      position: { type: 'string', enum: ['above', 'below'], description: "Place the layer directly above or directly below the anchor layer's track." },
    }, required: ['anchor_layer_id', 'layer_id', 'position'] },
    parseArgs: (a) => ({ op: 'restack_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), anchor: parseUuid(a.anchor_layer_id, 'anchor_layer_id'), position: parseRestackPosition(a.position) } }) },
  { name: 'trim_layer', exec: 'table', annotations: ANN_SET,
    description: "Trim one edge of a layer: `edge` 'in' (t_start) or 'out' (t_end) to `new_t_us`. Media-bearing layers move the matching `src_in_us`/`src_out_us` by the same delta, clamped at the source bound. In a link, every member whose same edge sits at the same time moves with it unless `escape_link=true`. A target past the other edge or past the source (of any member) is refused naming the legal window, never clamped. Returns the layer's committed envelope, the `siblings` trimmed with it, and `adjusted` for any grid snap.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, edge: { type: 'string', enum: ['in', 'out'], description: 'Which edge moves: in = t_start_us, out = t_end_us.' }, new_t_us: US_SCHEMA('Where the edge lands, timeline'), escape_link: ESCAPE_LINK_SCHEMA }, required: ['edge', 'layer_id', 'new_t_us'] },
    parseArgs: (a) => ({ op: 'trim_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), edge: parseStr(a.edge, 'edge'), new_t_us: parseNum(a.new_t_us, 'new_t_us'), escape_link: parseBoolOpt(a.escape_link, 'escape_link', false), strict: true } }) },
  // One delete tool over two actor ops: `ripple` is the whole difference between
  // them, and the surface says so rather than making an agent pick a verb it can
  // only tell apart by reading two descriptions. Empty `layer_ids` splits — the
  // lift takes it as the no-op of an empty selection, the ripple has no hole to
  // close and refuses — so the arity check stays in the actor, where each op
  // already owns its own answer.
  { name: 'delete_layers', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Delete a set of layers as one recorded edit. `ripple` decides what happens to the vacated span: `false` (default) is the lift — it stays empty and nothing moves; `true` closes each hole so the film gets shorter — every remaining layer starting at or after a hole shifts left by its length on EVERY track of the composition (anchored markers riding along), touching holes merge, and layers starting before a hole, free markers and the playhead stay put. The set is one composition's (`CrossCompositionSet`); a member on a locked track refuses the whole batch (`TrackLocked`, cleared with `set_track_flags`) while a layer's own `locked` does not block a delete; tracks the batch emptied are pruned. A ripple refuses whole, before any write, naming the blocker: `RippleInsideHole` (a remaining layer starts inside a hole — add it to `layer_ids`, or lift), `RippleCollision` (a mover would land on a layer that is not moving), `RippleLinkStraddles` (a link spans the hole), `RippleLockedLayer` (only a layer that actually shifts blocks). An empty set records nothing as a lift and is refused as a ripple.",
    inputSchema: { type: 'object', properties: {
      layer_ids: LAYER_IDS_SCHEMA('The layers to delete, all in one composition.'),
      ripple: { type: 'boolean', description: 'Close each vacated span and shift everything downstream left (default false — leave the spans empty).' },
    }, required: ['layer_ids'] },
    parseArgs: (a) => ({
      op: parseBoolOpt(a.ripple, 'ripple', false) ? 'ripple_delete_layers' : 'delete_layers',
      args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')) },
    }) },
  { name: 'ripple_delete_gap', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Close a GAP — an empty span on one track between two layer boundaries — so everything after it moves left and the film gets shorter; nothing is deleted. `[start_us, end_us)` must be the whole gap as it is now: `end_us` exactly where a layer on `track_id` starts, `start_us` exactly where one ends (or 0 before the first clip); the space after the last clip is not a gap. Otherwise `GapNotFound` carries the span you sent — re-read `project://tracks` and retry. The closing is `delete_layers { ripple: true }`'s: every layer starting at or after `end_us` on every track shifts left, anchored markers follow, free markers and the playhead stay. Refuses whole with the same names — `RippleInsideHole` (a layer on another track starts inside the gap: delete it first), `RippleCollision`, `RippleLinkStraddles`, `RippleLockedLayer` / `TrackLocked` (a gap on a locked lane always refuses). One recorded edit.",
    inputSchema: { type: 'object', properties: { track_id: { type: 'string', description: 'The track the gap is on.' }, start_us: US_SCHEMA('Gap start, timeline'), end_us: US_SCHEMA('Gap end (exclusive), timeline') }, required: ['track_id', 'start_us', 'end_us'] },
    parseArgs: (a) => ({ op: 'ripple_delete_gap', args: { track: parseUuid(a.track_id, 'track_id'), s: parseNum(a.start_us, 'start_us'), e: parseNum(a.end_us, 'end_us') } }) },
  // ── table-exec: links ───────────────────────────────────────────────────
  { name: 'create_link', exec: 'table', annotations: ANN_WRITE,
    description: "Create a new link from >=2 distinct layer ids. Optional `label`. If any layer is already in another link, the op fails unless `reassign=true`, which removes them from their prior link(s) first (auto-dissolving any link that falls below 2 members). Returns the link record (`link_id`, `members`).",
    inputSchema: { type: 'object', properties: { layer_ids: LAYER_IDS_SCHEMA('Two or more layers of one composition.'), label: { type: 'string', description: 'Optional name.' }, reassign: { type: 'boolean', description: 'Pull a member out of the link it is already in. Default false: such a member refuses.' } }, required: ['layer_ids'] },
    parseArgs: (a) => ({ op: 'links_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), label: parseStrOpt(a.label, 'label'), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }) },
  { name: 'delete_link', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Dissolve (delete) a link. The member layers themselves are not deleted.",
    inputSchema: { type: 'object', properties: { link_id: ID_SCHEMA('Link') }, required: ['link_id'] },
    parseArgs: (a) => ({ op: 'links_dissolve', args: { link: parseUuid(a.link_id, 'link_id') } }) },
  { name: 'update_link', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Change a link in one recorded edit — any of: `add_layer_ids` (join layers; one already in another link is refused unless `reassign` is true, which pulls it out of its old link first, dissolving that link if it falls below two members), `remove_layer_ids` (drop members; below two, the link dissolves), `label` (rename; `null` clears). At least one. Applied add → remove → label. Every layer must be in the link's composition (`CrossCompositionSet`). Create with `create_link`, delete with `delete_link`.",
    inputSchema: { type: 'object', properties: {
      link_id: ID_SCHEMA('Link'),
      add_layer_ids: LAYER_IDS_SCHEMA('Layers to join.'),
      remove_layer_ids: LAYER_IDS_SCHEMA('Members to drop.'),
      label: { type: ['string', 'null'], description: 'New label; null clears it.' },
      reassign: { type: 'boolean', description: 'Let `add_layer_ids` take a layer out of another link. Default false.' },
    }, required: ['link_id'] },
    parseDedicated: (a) => {
      const ids = (v: unknown, field: string): string[] => v === undefined || v === null ? [] : asArray(v, field).map((s) => parseUuid(s, field))
      const p = {
        link: parseUuid(a.link_id, 'link_id'),
        add: ids(a.add_layer_ids, 'add_layer_ids'),
        remove: ids(a.remove_layer_ids, 'remove_layer_ids'),
        label: a.label === undefined ? undefined : parseStrOpt(a.label, 'label'),
        reassign: parseBoolOpt(a.reassign, 'reassign', false),
      }
      if (p.add.length === 0 && p.remove.length === 0 && p.label === undefined)
        throw new McpArgError(`update_link needs at least one of add_layer_ids, remove_layer_ids, label — nothing to change`)
      return p
    } },
  // ── table-exec: groups (ADR 0052; docs/features.md#groups) ──────────────
  { name: 'create_group', exec: 'table', annotations: ANN_WRITE,
    description: "Pre-compose: move one or more layers (all in one composition) into a NEW composition and place it back as a single Group layer at the set's earliest start, on the top-most lane the set occupied (or the nearest free lane above). The new composition copies the parent's settings; members' tracks map onto A roll, B roll, then fresh tracks so z-order survives, and time is rebased so the earliest member starts at 0. Never partial: a member on a locked track (`TrackLocked`) or itself locked (`GroupLockedMember`), or a set spanning two compositions (`CrossCompositionSet`), refuses everything. Links fully inside move; a straddling link loses its inside members. Transitions between two members move; a straddling one is dropped. Markers stay. Returns `{ composition_id, layer_id, layer }`; one undo restores all.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The layers to pre-compose; at least one, all in one composition.' },
      label: { type: 'string', description: 'Optional name for the new composition. Omit and the UI derives one.' },
    }, required: ['layer_ids'] },
    parseArgs: (a) => ({ op: 'groups_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), label: parseStrOpt(a.label, 'label') } }) },
  { name: 'add_group_members', exec: 'table', annotations: ANN_WRITE,
    description: "Move layers INTO the composition a Group layer already shows, keeping the screen position they had. `layer_ids` (one or more, all in one composition) and `group_layer_id` must be siblings; the Group's `params.composition` is the destination, and each member lands at `t_start_us − group.t_start_us + group.src_in_us`. Lane mapping, links, transitions, markers and the shared refusals are `move_layers_to_composition`'s, which this delegates to — call that directly when you know the destination composition and the time. Own refusals: the Group in another composition (`CrossCompositionSet`), not a Group (`WrongLayerKind`), a Group pointing at the root (`RootComposition`).",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The layers to move in; at least one, all in one composition.' },
      group_layer_id: { type: 'string', description: 'The Group clip they move into — a `CompositionRef` layer in the SAME composition as the members.' },
    }, required: ['layer_ids', 'group_layer_id'] },
    parseArgs: (a) => ({ op: 'groups_add_members', args: {
      layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')),
      group_layer: parseUuid(a.group_layer_id, 'group_layer_id'),
    } }) },
  { name: 'move_layers_to_composition', exec: 'table', annotations: ANN_WRITE,
    description: "Move layers out of their composition into another, landing at a time you name — the general cross-composition move (`add_group_members` is the keep-screen-position shortcut). `layer_ids`: one or more, all in one composition. `to_composition_id`: the destination (ids: `project://compositions`); the root is an ordinary destination. `anchor_layer_id` is the member that lands at `anchor_t_start_us`, absolute on the destination's clock; the others keep their offset from it. Lanes are assigned per SOURCE TRACK: `to_track_id` omitted bounces each block to the nearest free lane, `\"spawn\"` takes one fresh lane, a lane id lands every block there and REFUSES a locked or occupied one. Links and transitions fully inside move, straddling ones are cut; emptied source lanes are pruned, markers stay behind, both compositions autofit, no Group layer is retrimmed. Refuses whole, before any write: an empty set, an anchor outside the set, the current composition as destination, `CrossCompositionSet`, `TrackLocked` / `GroupLockedMember`, `CompositionCycle`, a member landing before time 0.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The layers to move; at least one, all in one composition.' },
      to_composition_id: { type: 'string', description: 'The destination composition (`project://compositions`). The root is allowed — that is the move back out of a Group.' },
      anchor_layer_id: { type: 'string', description: 'Which member `anchor_t_start_us` positions; every other member keeps its offset from it.' },
      anchor_t_start_us: { type: 'integer', description: "The anchor's start time on the DESTINATION's clock — absolute, not a delta." },
      to_track_id: { type: 'string', description: 'A lane id (locked or occupied REFUSES), "spawn" for a fresh top lane, or omit to bounce to the nearest free lane.' },
    }, required: ['anchor_layer_id', 'anchor_t_start_us', 'layer_ids', 'to_composition_id'] },
    parseArgs: (a) => ({ op: 'move_layers_to_composition', args: {
      layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')),
      to_composition: parseUuid(a.to_composition_id, 'to_composition_id'),
      anchor_layer: parseUuid(a.anchor_layer_id, 'anchor_layer_id'),
      anchor_t_start_us: parseNum(a.anchor_t_start_us, 'anchor_t_start_us'),
      to_track: parseDestTrackOpt(a.to_track_id),
    } }) },
  { name: 'add_group_layer', exec: 'table', annotations: ANN_WRITE,
    description: "Place an EXISTING composition on a track as one more Group layer (`create_group` makes a NEW one). `source_composition_id` is what gets placed (ids and reference counts: `project://compositions`); `track_id` and `t_start_us` are where. The layer is windowed over the whole composition (`src_in_us: 0`, `src_out_us: duration_us`) with an identity transform; trim it afterwards for a slice. Instances are independent and all show the same content. Refuses before creating anything: the root (`RootComposition`), a composition that already reaches this track's composition, itself included (`CompositionCycle`), and an empty composition (`InvalidArgument`).",
    inputSchema: { type: 'object', properties: {
      source_composition_id: { type: 'string', description: "The composition to place — a Group's id from `project://compositions`, never the root." },
      track_id: TRACK_ID_SCHEMA,
      t_start_us: T_START_SCHEMA,
      composition_id: TRACK_COMPOSITION_ID_SCHEMA,
    }, required: ['source_composition_id', 't_start_us', 'track_id'] },
    parseArgs: (a) => ({ op: 'add_group_layer', args: {
      source_composition: parseUuid(a.source_composition_id, 'source_composition_id'),
      track: parseUuid(a.track_id, 'track_id'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'),
      composition_id: parseCompositionIdOpt(a.composition_id),
    } }) },
  { name: 'ungroup_layer', exec: 'table', annotations: ANN_WRITE,
    description: "Expand a Group layer back into its members, in place. Refuses unless the Group is PLAIN — identity transform, static opacity 1, no effects, Normal blend (`GroupNotPlain { reason }`), because those apply to the composite and would be discarded; reset them first or keep the Group. Members intersecting the Group's `[src_in_us, src_out_us)` window are copied into the parent at the same on-screen time, trimmed to the window; members wholly outside are dropped. The composition's tracks become fresh tracks at the Group's z position; inner links and transitions carry over. The composition is removed when nothing else references it. One undo restores the Group.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string', description: 'The Group layer (its params.kind is CompositionRef).' } }, required: ['layer_id'] },
    parseArgs: (a) => ({ op: 'groups_ungroup', args: { layer: parseUuid(a.layer_id, 'layer_id') } }) },
  { name: 'rename_composition', exec: 'table', annotations: ANN_SET,
    description: "Name a Group's composition (`label: null` or blank clears it back to the derived name). Recorded, so undo reverts it. The root composition refuses (`RootComposition`): it has no name — it is the timeline. Composition ids: `project://compositions`.",
    inputSchema: { type: 'object', properties: { composition_id: ID_SCHEMA('Composition'), label: { type: ['string', 'null'], description: 'The new name; null or blank clears it.' } }, required: ['composition_id'] },
    parseArgs: (a) => ({ op: 'groups_rename', args: { composition: parseUuid(a.composition_id, 'composition_id'), label: parseStrOpt(a.label, 'label') } }) },
  { name: 'delete_composition', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Delete a composition nothing references — an orphan left when its Group layers were deleted. Refuses while any Group layer points at it (`CompositionInUse { ref_count }`; `project://compositions` shows the count) and refuses the root (`RootComposition`). Recorded.",
    inputSchema: { type: 'object', properties: { composition_id: ID_SCHEMA('Composition') }, required: ['composition_id'] },
    parseArgs: (a) => ({ op: 'compositions_delete', args: { composition: parseUuid(a.composition_id, 'composition_id') } }) },
  // ── table-exec: effects ──────────────────────────────────────────────────
  { name: 'add_effect', exec: 'table', annotations: ANN_WRITE,
    description: "Append an effect to a layer's chain (applied last) and return its record (`effect_id`, `kind`, `index`). `kind` is the catalog key. Visual kinds (\"blur\", \"chromakey\", \"brightness\", \"contrast\", \"saturation\", \"sharpen\") go on visual layers: the colour trio take `amount` in [-100, 100] (percent offset, 0 = no change), \"sharpen\" takes `amount` in [0, 100]. Audio kinds are the `audio.*` namespace, for Audio layers ONLY, and their params are STATIC ONLY (`set_keyframe` on one is `AudioEffectParamStatic`); a kind on the wrong layer kind is `EffectKindNotApplicable`. The one audio kind is \"audio.denoise\": `strength` dB [1, 40] (default 12), `margin` dB [0, 20] (default 8), and `profile_in_us`/`profile_out_us`, SOURCE-time bounds of a noise-only span ≥ 250000 µs — it does nothing until both are set. The effect is created with no params: set a static value with `update_effect` first, then (visual only) `set_keyframe` on `effects[<id>].params[<key>]`. `effects://catalog` (or `read_project { view: \"effects\" }`) lists every kind's params, defaults and ranges.",
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...EFFECT_KINDS], description: 'Catalog key: visual kinds on visual layers, audio.* on Audio layers.' }, layer_id: LAYER_ID_SCHEMA }, required: ['kind', 'layer_id'] },
    parseArgs: (a) => ({ op: 'add_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), kind: parseEffectKind(a.kind) } }) },
  { name: 'update_effect', exec: 'table', annotations: ANN_SET,
    description: "Update an effect: patch is `{ enabled?, params? }` where params is `{ paramKey: { \"mode\": \"Static\", \"value\": <number> } }` (v1 params are scalar). A `null` param value removes the key (back to unset/default). For keyframed params use set_keyframe with param_key \"effects[<effect_id>].params[<key>]\". An unparseable patch (non-object, unknown key, malformed param value) rejects with invalid_params — it never partially applies.",
    inputSchema: { type: 'object', properties: { effect_id: ID_SCHEMA('Effect'), layer_id: LAYER_ID_SCHEMA, patch: {
      type: 'object',
      description: 'Effect patch. Only fields you set are applied; `params` merges key-by-key, and a null value removes its key.',
      properties: {
        enabled: { type: 'boolean', description: 'false bypasses the effect, true applies it.' },
        params: { type: 'object', description: 'Param key → AnimTrack, or null to remove the key. v1 effect params are scalar, e.g. {"strength": {"mode":"Static","value":8}}.', additionalProperties: { type: ['object', 'null'], description: 'An AnimTrack — {"mode":"Static","value":<number>} for a v1 param — or null to unset the key. Keyframe a visual effect param through set_keyframe instead.' } },
      },
    } }, required: ['effect_id', 'layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), patch: parseEffectPatch(a.patch) } }) },
  { name: 'move_effect', exec: 'table', annotations: ANN_SET,
    description: "Reorder an effect within its layer's chain. new_index is 0-based; 0 = first applied. Must be < effect count.",
    inputSchema: { type: 'object', properties: { effect_id: ID_SCHEMA('Effect'), layer_id: LAYER_ID_SCHEMA, new_index: { type: 'integer', description: 'Target position in the chain; 0 is applied first.' } }, required: ['effect_id', 'layer_id', 'new_index'] },
    parseArgs: (a) => ({ op: 'move_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), new_index: parseNum(a.new_index, 'new_index') } }) },
  { name: 'delete_effect', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Remove an effect from a layer by id.",
    inputSchema: { type: 'object', properties: { effect_id: ID_SCHEMA('Effect'), layer_id: LAYER_ID_SCHEMA }, required: ['effect_id', 'layer_id'] },
    parseArgs: (a) => ({ op: 'remove_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id') } }) },
  // ── table-exec: transitions ──────────────────────────────────────────────
  { name: 'add_transition', exec: 'table', annotations: ANN_WRITE,
    description: "Add a transition at the cut between two adjacent layers on the same track — `from_layer_id` (outgoing) ends exactly where `to_layer_id` (incoming) starts — and return its record. `kind` 'Crossfade' (default) | 'Wipe' | 'Slide'; `direction` is the MOTION direction ('left' = the boundary or the sliding content moves left), required for Wipe/Slide and rejected for Crossfade. `placement` 'overlap' (default) moves the INCOMING layer left by the frame-rounded duration so both still play exactly their trimmed ranges and the vacated span stays a gap — nothing ripples; link siblings follow, bouncing to a free lane. 'extend' instead borrows outgoing tail media past its out-point, positions untouched (`extended_us = duration`), refused with `TransitionInsufficientHandle { available_us }` when the tail is short. A pair already overlapped by exactly the duration attaches as-is. Refuses: participants sharing a link, a move crossing t = 0, a duration longer than either participant, an Audio participant (`TransitionUnsupportedLayerKind`). Recorded — one undo restores every moved layer.",
    inputSchema: { type: 'object', properties: {
      direction: { type: 'string', enum: ['left', 'right', 'up', 'down'], description: 'Motion direction. Required for Wipe / Slide, refused for Crossfade.' },
      duration_us: US_SCHEMA('Transition length'),
      from_layer_id: { type: 'string', description: 'Outgoing layer — the one that ends at the cut.' },
      kind: { type: 'string', enum: ['Crossfade', 'Wipe', 'Slide'], description: 'Default Crossfade.' },
      placement: { type: 'string', enum: ['overlap', 'extend'], description: "'overlap' (default): the incoming layer moves left, trimmed ranges preserved. 'extend': the outgoing layer borrows tail media, positions untouched." },
      to_layer_id: { type: 'string', description: 'Incoming layer — the one that starts at the cut.' },
    }, required: ['duration_us', 'from_layer_id', 'to_layer_id'] },
    parseArgs: (a) => {
      parseTransitionKind(a.kind ?? 'Crossfade', a.direction) // strict enum gate at the MCP boundary; dispatch re-derives from the raw args below
      parseTransitionPlacement(a.placement) // strict enum gate; dispatch re-derives (absent → 'overlap')
      return { op: 'add_transition', args: { from: parseUuid(a.from_layer_id, 'from_layer_id'), to: parseUuid(a.to_layer_id, 'to_layer_id'), duration_us: parseNum(a.duration_us, 'duration_us'), kind: a.kind, direction: a.direction, placement: a.placement } }
    } },
  { name: 'update_transition', exec: 'table', annotations: ANN_SET,
    description: "Patch a transition's `duration_us`, `kind`/`direction` and/or `extended_us` in one recorded commit; only fields you set apply. `direction` rides with `kind`: switching to Wipe/Slide needs both, and `direction` alone or beside Crossfade is rejected. Geometry is two targets: `extended_us` is the borrowed share of the overlap (0 = pure placement, `duration_us` = pure borrow); the outgoing layer ends at its exit frame + `extended_us`, the incoming starts `duration_us` before that. With `extended_us` OMITTED the trimmed ranges are preserved — growing moves the incoming layer further left and never borrows, shrinking returns borrowed tail first then moves it right. Only an explicit `extended_us` grows the borrow (checked against the remaining tail: `TransitionInsufficientHandle { available_us }`); a NEGATIVE one is a deliberate tail trim of real content. Link siblings follow the incoming layer; a move onto occupied space or across t = 0 refuses the commit. `TransitionNotFound` for an unknown id.",
    inputSchema: { type: 'object', properties: {
      direction: { type: 'string', enum: ['left', 'right', 'up', 'down'], description: 'Motion direction; rides with `kind` (Wipe / Slide need it, Crossfade refuses it).' },
      duration_us: US_SCHEMA('New transition length'),
      extended_us: { type: 'integer', description: 'Borrowed-tail target in µs, at most duration_us. Omit to preserve trimmed ranges; negative = deliberate tail trim of real content.' },
      kind: { type: 'string', enum: ['Crossfade', 'Wipe', 'Slide'], description: 'New kind; send `direction` with Wipe / Slide.' },
      transition_id: ID_SCHEMA('Transition'),
    }, required: ['transition_id'] },
    parseArgs: (a) => {
      parseTransitionKindOpt(a.kind, a.direction) // strict enum gate; dispatch re-derives
      parseNumOpt(a.duration_us, 'duration_us')
      parseNumOpt(a.extended_us, 'extended_us')
      return { op: 'update_transition', args: { transition: parseUuid(a.transition_id, 'transition_id'), duration_us: a.duration_us, kind: a.kind, direction: a.direction, extended_us: a.extended_us } }
    } },
  { name: 'delete_transition', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Remove a transition and restore the hard cut, routed by provenance: the outgoing layer's end shrinks back by `extended_us` (only borrowed tail is returned, never real content) and the incoming layer moves RIGHT by `duration_us − extended_us`, link siblings following. `TransitionRestoreCollision` when that destination has since been filled — move or delete the blocker first; the system never makes room. Recorded. `TransitionNotFound` for an unknown id.",
    inputSchema: { type: 'object', properties: { transition_id: ID_SCHEMA('Transition') }, required: ['transition_id'] },
    parseArgs: (a) => ({ op: 'remove_transition', args: { transition: parseUuid(a.transition_id, 'transition_id') } }) },
  // ── table-exec: composition ──────────────────────────────────────────────
  // The lane this opens is the ONE track in the model that stores a label
  // (mutations/media.ts names the source it lifted from), which is why the
  // result is a TRACK id and not the layer's: the layer is unchanged, it moved.
  { name: 'separate_audio_to_new_track', exec: 'table', annotations: ANN_WRITE,
    description: "Lift an Audio layer onto a new track of its own, in the source lane's slot, and return the new track's record with the layer's. The layer is untouched — id, span, gain, role and links survive — so an auto-paired dialogue clip gets its own lane while the pair still moves together; `delete_link` afterwards to make them independent. `WrongLayerKind` on anything but an Audio layer (a VideoClip's sound is the Audio layer linked to it — see `project://tracks`). A source lane the lift emptied is pruned. One undo reverts it.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string', description: 'The VideoClip whose audio splits off onto its own layer.' } }, required: ['layer_id'] },
    parseArgs: (a) => ({ op: 'separate_audio', args: { layer: parseUuid(a.layer_id, 'layer_id') } }) },
  { name: 'update_composition', exec: 'table', annotations: ANN_SET,
    description: "Update a composition's envelope — canvas `width`/`height`, `fps`, `sample_rate`, `channels`, `color_space`, `background`, `duration_us`; only fields you set apply; `composition_id` names a Group's composition, the root when omitted. Unrecorded: the envelope is setup, so the patch reaches every history snapshot and undo walks past it. `fps` is LOCKED once the timeline, any history snapshot or any checkpoint holds a layer — refused with `FpsLockedByContent { current, requested, layer_count, locked_by: \"current\" | \"history\" }`; set the rate on a project that has never held a layer, or empty the timeline and reopen the project to clear a history lock. `sample_rate` is never locked. Setting `duration_us` PINS the duration so layer edits stop auto-fitting it; `duration_us: null` (alone in the patch) unpins it and refits to the layers.",
    inputSchema: { type: 'object', properties: { patch: {
      type: 'object',
      description: 'Composition envelope patch. Only fields you set are applied.',
      properties: {
        width: { type: 'integer', description: 'Canvas width, px.' },
        height: { type: 'integer', description: 'Canvas height, px.' },
        fps: { type: 'object', description: 'Frame rate as a fraction (30000/1001 = 29.97). Locked once any content exists.', properties: { num: { type: 'integer', description: 'Numerator.' }, den: { type: 'integer', description: 'Denominator.' } }, required: ['num', 'den'] },
        duration_us: { type: ['integer', 'null'], description: 'A value pins the duration; `null` unpins it so it follows the layers again, and must be the only field in the patch.' },
        sample_rate: { type: 'integer', description: 'Audio sample rate, Hz.' },
        channels: { type: 'integer', description: 'Audio channel count.' },
        color_space: { type: 'string', enum: ['Bt709', 'Bt601', 'Bt2020', 'SRgb'], description: 'Working colour space.' },
        background: { ...RGBA_SCHEMA, description: 'Canvas background colour.' },
      },
    }, composition_id: { type: 'string', description: 'The composition to patch; omit for the root. fps / sample_rate / channels are one lattice for the whole project and cascade to every composition.' } }, required: ['patch'] },
    parseArgs: (a) => {
      const patch = parseObj(a.patch, 'patch')
      const composition_id = parseCompositionIdOpt(a.composition_id)
      // `duration_us: null` is the unpin — the inverse of setting it — and routes
      // to the fit op. Alone, because the fit refits every history snapshot to
      // its own high-water mark while a canvas patch lands as one value; the two
      // do not compose into a single op, and a caller who wants both sends two.
      if (patch.duration_us === null) {
        const rest = Object.keys(patch).filter((k) => k !== 'duration_us')
        if (rest.length > 0) throw new McpArgError(`duration_us: null unpins the duration and must be the only field in the patch — send ${rest.join(', ')} in a separate call`, 'patch')
        return { op: 'fit_composition_to_layers', args: { composition_id } }
      }
      return { op: 'set_composition', args: { ...patch, composition_id } }
    } },
  // The project-preferences twin of set_composition: that one owns the canvas a
  // composition renders at, this one owns the preferences the EDITOR works by,
  // and both are setup rather than editing, so neither records.
  { name: 'set_project_settings', exec: 'table', annotations: ANN_SET,
    description: "Update the project's editing preferences; only the fields you send apply, and an unknown key or an empty patch is refused. Unrecorded — preferences are setup, patched into every history snapshot, so undo walks past them (the `update_composition` contract). Fields: `auto_pair_audio_on_import`, `prefer_proxies`, `proxy_override`, `shot_review`, `pause_review` (the last two validated and refused as a whole, against the detectors' own bounds; `null` clears one back to defaults), `correction_script` (what `correct_caption_text` corrects against). Read current values from `project://current`.",
    inputSchema: { type: 'object', properties: { patch: {
      type: 'object',
      description: "Settings patch. Only the fields you include are applied; `null` has a per-field meaning given below and is never 'unset'.",
      properties: {
        auto_pair_audio_on_import: { type: 'boolean', description: 'Whether `add_video_layer` also places and links the source\'s audio. Default on; off places a video silent.' },
        prefer_proxies: { type: 'boolean', description: 'Whether preview reads generated proxies rather than the original media. A playback preference; export always reads the original.' },
        proxy_override: { type: 'object', description: "Per-media exception to `prefer_proxies`, read back as `settings.proxy_overrides[media_id]`. An unknown media id is refused.", properties: { media_id: { type: 'string', description: 'A pool media id.' }, value: { type: ['boolean', 'null'], description: 'true / false pins the item; null removes the exception.' } }, required: ['media_id', 'value'] },
        shot_review: { type: ['object', 'null'], description: "Shot-detection parameters `analyze_clip` / `auto_split_by_shot` run at, or `null` for the defaults. `sensitivity` in [0, 1]; `min_shot_us` > 0.", properties: { sensitivity: { type: 'number', description: 'Cut sensitivity 0..1.' }, min_shot_us: US_SCHEMA('Shortest shot kept') }, required: ['sensitivity', 'min_shot_us'] },
        pause_review: { type: ['object', 'null'], description: "Pause parameters `detect_pauses` / `remove_pauses` run at, or `null` for their defaults. `threshold_amp` in [0, 1], `min_pause_us` > 0, `pad_us` >= 0 with `2 * pad_us < min_pause_us`.", properties: { threshold_amp: { type: 'number', description: 'Peak amplitude below which audio counts as a pause, 0..1.' }, min_pause_us: US_SCHEMA('Shortest pause detected'), pad_us: US_SCHEMA('Kept on each side of a cut pause') }, required: ['threshold_amp', 'min_pause_us', 'pad_us'] },
        correction_script: { type: 'string', description: "Reference text `correct_caption_text` corrects against — the script, notes, the spelling of every name. Must be set before that call." },
      },
    } }, required: ['patch'] },
    parseArgs: (a) => ({ op: 'update_project_settings', args: { patch: parseProjectSettingsPatch(a.patch) } }) },
  // ── table-exec: markers ──────────────────────────────────────────────────
  { name: 'update_marker', exec: 'table', annotations: ANN_SET,
    description: "Update a marker. Setting `t_us` re-sorts the marker list. On a marker ANCHORED to a clip, `t_us` names the time the mark should read and moves the ANCHOR to make it read that, so the mark keeps following its clip from the new offset — a time outside that clip's span is refused, and `t_us` together with `end_t_us` is refused (an anchored region's end follows its anchor by itself; patch one or the other).",
    inputSchema: { type: 'object', properties: { marker_id: ID_SCHEMA('Marker'), patch: {
      type: 'object',
      description: 'Marker patch; only fields you set apply. `end_t_us` can be set, never cleared (remove + re-add). The anchor is `set_marker_anchor`\'s, not patchable here.',
      properties: {
        t_us: US_SCHEMA('New time, timeline'),
        end_t_us: US_SCHEMA('Region end, timeline; turns a point marker into a region'),
        label: { type: ['string', 'null'], description: 'Short name — what the marker lane and the search palette show. Keep it to a few words; long text belongs in `note`.' },
        note: { type: ['string', 'null'], description: 'Long text, shown only in the marker panel.' },
        color: { ...RGBA_SCHEMA, description: 'Marker colour.' },
      },
    } }, required: ['marker_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_marker', args: { marker: parseUuid(a.marker_id, 'marker_id'), patch: parseMarkerPatch(a.patch) } }) },
  { name: 'delete_marker', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Remove a marker.",
    inputSchema: { type: 'object', properties: { marker_id: ID_SCHEMA('Marker') }, required: ['marker_id'] },
    parseArgs: (a) => ({ op: 'remove_marker', args: { marker: parseUuid(a.marker_id, 'marker_id') } }) },
  // The anchor is written HERE and nowhere else: `update_marker`'s patch refuses
  // the field (`parseMarkerPatch`), so a tie can never be established as a side
  // effect of editing something else — the refusal the tie owes is about WHERE
  // the mark sits, and a patch that also moved it would have two answers.
  { name: 'set_marker_anchor', exec: 'table', annotations: ANN_SET,
    description: "Tie a marker to a clip so the mark FOLLOWS it through moves, trims, splits and composition crossings, or cut it loose with `layer_id: null`. `layer_id` must be a clip of the marker's own composition. Tying names the source instant the mark already sits on, so nothing moves; `t_us` stays the field to read. Refuses without writing: a layer in another composition (`CrossCompositionSet`), a kind with no source window such as Color or Text (`WrongLayerKind`), a marker outside the clip's span (`InvalidArgument` — `update_marker` it onto the clip first). Re-tying replaces the tie. Untying keeps the frame currently shown and is the one exit from `hibernating`; untying a free marker records nothing.",
    inputSchema: { type: 'object', properties: {
      marker_id: ID_SCHEMA('Marker'),
      layer_id: { type: ['string', 'null'], description: 'The clip to follow, or null to cut the marker loose.' },
    }, required: ['marker_id', 'layer_id'] },
    parseArgs: (a) => {
      const marker = parseUuid(a.marker_id, 'marker_id')
      if (a.layer_id === null) return { op: 'detach_marker', args: { marker } }
      return { op: 'attach_marker', args: { marker, layer: parseUuid(a.layer_id, 'layer_id') } }
    } },
  // ── table-exec: media ────────────────────────────────────────────────────
  { name: 'delete_media', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Remove a media item. Rejects if any layer references it unless force=true. With force=true, also deletes the referencing layers in one atomic commit, exactly as delete_layers would: their links dissolve below two members, a transient lane they empty is pruned, a locked lane refuses as TrackLocked. Unrecorded when nothing used it; the forced cascade records.",
    inputSchema: { type: 'object', properties: { media_id: ID_SCHEMA('Media'), force: { type: 'boolean', description: 'Also delete the layers that use it (their links and emptied lanes go too). Default false: media in use refuses.' } }, required: ['media_id'] },
    parseArgs: (a) => ({ op: 'remove_media', args: { media: parseUuid(a.media_id, 'media_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  // ── table-exec: history ──────────────────────────────────────────────────
  { name: 'undo', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Undo the most recent edit (linear history); `NothingToUndo` at the origin. Only timeline edits record — layers, tracks, markers, transitions, links, and media removals that cascade. Outside the stack and untouched by undo: media imports, the composition envelope (`update_composition`), project settings (`set_project_settings`), track and role flags, and loading a project (which resets history).",
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'undo', args: {} }) },
  { name: 'jump_to', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Move the history cursor to an absolute stack index — the history panel's click-a-row, and the way to a state that is neither one undo away nor a checkpoint. `index` uses `project://history`'s numbering (`ops[i]` sits at `window_start + i`; `cursor` is where you are), so jumping is reading that resource and naming a row; out of range is refused naming the live bounds, and `evicted > 0` means index 0 is the oldest SURVIVING state. A revert path like undo/redo/`restore_checkpoint`, so `set_history_lock` blocks it. Records nothing; a later edit truncates whatever sat ahead, as after an undo.",
    inputSchema: { type: 'object', properties: { index: { type: 'integer', description: 'Absolute history index, in `project://history`\'s numbering (`window_start + i`).' } }, required: ['index'] },
    parseArgs: (a) => ({ op: 'jump_to', args: { index: parseNum(a.index, 'index') } }) },
  { name: 'redo', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Redo the next edit. Errors with NothingToRedo if no redo is available. A new commit truncates the redo tail.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'redo', args: {} }) },
  { name: 'delete_checkpoint', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Drop a named checkpoint. Only the restore point goes — the edits it marked stay, nothing about the timeline or the undo stack changes, so there is nothing to undo afterwards. `CheckpointNotFound` for an id `list_checkpoints` does not report. Deliberately NOT blocked by `set_history_lock`: the lock rejects revert paths, and forgetting a restore point reverts nothing. Unrecorded.",
    inputSchema: { type: 'object', properties: { checkpoint_id: ID_SCHEMA('Checkpoint') }, required: ['checkpoint_id'] },
    parseArgs: (a) => ({ op: 'delete_checkpoint', args: { checkpoint_id: parseUuid(a.checkpoint_id, 'checkpoint_id') } }) },
  // ── table-exec: captions ─────────────────────────────────────────────────
  // Project-wide by design (one commit over every Caption-role track in every
  // composition): caption lanes multiply as cues collide, and restyling them
  // one at a time would leave a film styled in two ways for as long as the
  // batch took.
  { name: 'restyle_captions', exec: 'table', annotations: ANN_SET,
    description: "Restyle EVERY caption in the project in one recorded edit — every Text layer on every caption-role track, in every composition, so multiplied caption lanes stay one look. Omitted or `null` fields are left alone. `outline_width: 0` removes the outline; a positive width adds or resizes one (keeping its colour, black if it had none). Sizes are composition px. A Text layer from `add_text_layer` is not a caption — style it with `update_layer_params`.",
    inputSchema: { type: 'object', properties: {
      font_family: { type: 'string', description: 'Font family for every caption.' },
      font_size_px: { type: 'number', description: 'Font size, composition px.' },
      color: { ...RGBA_SCHEMA, description: 'Text colour.' },
      outline_width: { type: 'number', description: '0 removes the outline; a positive width (composition px) adds or resizes it.' },
    }, required: [] },
    parseArgs: (a) => ({ op: 'restyle_captions', args: { patch: {
      font_family: parseStrOpt(a.font_family, 'font_family'),
      font_size_px: parseNumOpt(a.font_size_px, 'font_size_px') ?? null,
      color: a.color === undefined || a.color === null ? null : parseRgba(a.color, 'color'),
      outline_width: parseNumOpt(a.outline_width, 'outline_width') ?? null,
    } } }) },
  // ── table-exec: audio roles ──────────────────────────────────────────────
  { name: 'set_role_gain', exec: 'table', annotations: ANN_SET,
    description: "Set an audio role's mix gain (dB). role ∈ {dialogue,music,sfx,voiceover}. Recorded (undoable). Folds into every layer of that role at mix time.",
    inputSchema: { type: 'object', properties: { gain_db: { type: 'number', description: 'Bus gain, dB; 0 = unity.' }, role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'The mixing bus.' } }, required: ['gain_db', 'role'] },
    parseArgs: (a) => ({ op: 'set_role_gain', args: { role: parseRole(a.role), gain_db: parseNum(a.gain_db, 'gain_db') } }) },
  // set_role_flags: patch stays structural (muted/solo are nullable booleans validated by the mutation)
  { name: 'set_role_flags', exec: 'table', annotations: ANN_SET,
    description: "Mute/solo an audio role. role ∈ {dialogue,music,sfx,voiceover}. Unrecorded (not undoable). Mute wins over solo; any solo silences non-soloed roles.",
    inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'The mixing bus.' }, muted: { type: 'boolean', description: 'Silence the bus. Omitted leaves it alone.' }, solo: { type: 'boolean', description: 'Play this bus alone. Omitted leaves it alone.' } }, required: ['role'] },
    parseArgs: (a) => ({ op: 'update_role_flags', args: { role: parseRole(a.role), patch: { muted: a.muted ?? null, solo: a.solo ?? null } } }) },
  // ── dedicated-exec — parseDedicated validates and maps MCP args; behavior lives in actor.ts arms ──
  { name: 'add_color_layer', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Add a solid-color layer to a track and return its record — `layer_id`, `track_id`, the span as committed, `adjusted` for any grid snap. `t_start_us` and `t_end_us` are timeline microseconds (start inclusive, end exclusive). Layer cannot overlap existing layers on the same track.",
    inputSchema: { type: 'object', properties: { color: { ...RGBA_SCHEMA, description: 'Fill colour.' }, height: { type: 'integer', description: 'Block height, px; default 1080.' }, t_end_us: T_END_SCHEMA, t_start_us: T_START_SCHEMA, track_id: TRACK_ID_SCHEMA, width: { type: 'integer', description: 'Block width, px; default 1920.' }, composition_id: TRACK_COMPOSITION_ID_SCHEMA }, required: ['color', 't_end_us', 't_start_us', 'track_id'] },
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), color: parseRgba(a.color, 'color'),
      width: parseNumOpt(a.width, 'width'), height: parseNumOpt(a.height, 'height'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us'),
      composition_id: parseCompositionIdOpt(a.composition_id) }) },
  { name: 'add_video_layer', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Add a visual layer from an imported `Video` or `Image` item onto a track and return its record; an audio-only item is refused and pointed at `add_audio_layer`. Video: `src_in_us`/`src_out_us` are the source in/out points, `t_start_us`/`t_end_us` the timeline span. Image: an ImageOverlay over the timeline range; omit `src_in_us`/`src_out_us`. When a Video has an audio stream and `auto_pair_audio_on_import` is on (the default), a linked dialogue Audio layer lands on the SAME track's audio lane, committed atomically — an occupied lane rejects the whole call naming the blocker. The record always carries `audio_layer_id`/`link_id`/`audio` (null when unpaired).",
    inputSchema: { type: 'object', properties: { media_id: ID_SCHEMA('Media'), src_in_us: { type: 'integer', description: 'Source in point, µs. Required for Video; ignored for an Image.' }, src_out_us: { type: 'integer', description: 'Source out point (exclusive), µs. Required for Video; ignored for an Image.' }, t_end_us: T_END_SCHEMA, t_start_us: T_START_SCHEMA, track_id: TRACK_ID_SCHEMA, composition_id: TRACK_COMPOSITION_ID_SCHEMA }, required: ['media_id', 't_end_us', 't_start_us', 'track_id'] },
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), media: parseUuid(a.media_id, 'media_id'),
      src_in_us: parseNumOpt(a.src_in_us, 'src_in_us') ?? null, src_out_us: parseNumOpt(a.src_out_us, 'src_out_us') ?? null,
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us'),
      composition_id: parseCompositionIdOpt(a.composition_id) }) },
  { name: 'add_audio_layer', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Add an Audio layer from an imported item onto a track's audio lane and return its record — music, a sound effect, a voice track, or a video file's audio on its own. The only way audio-only media reaches the timeline (`add_video_layer` refuses it). `media_id` is an `Audio` item or a `Video` item with an audio stream; `Image` and `Subtitle` are refused. The layer stands ALONE — no auto-pair, no link — on the track's audio lane (every track has one, beside its visual lane). `src_in_us`/`src_out_us` are source in/out, `t_start_us`/`t_end_us` the timeline span; both snap to the 48 kHz sample lattice. `role` (default `music`) picks the mixing bus — a property of the clip, not its track.",
    inputSchema: { type: 'object', properties: { media_id: ID_SCHEMA('Media'), src_in_us: SRC_IN_SCHEMA, src_out_us: SRC_OUT_SCHEMA, t_end_us: T_END_SCHEMA, t_start_us: T_START_SCHEMA, track_id: TRACK_ID_SCHEMA, role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'Mixing bus for the clip. Defaults to `music`.' }, composition_id: TRACK_COMPOSITION_ID_SCHEMA }, required: ['media_id', 'src_in_us', 'src_out_us', 't_end_us', 't_start_us', 'track_id'] },
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), media: parseUuid(a.media_id, 'media_id'),
      src_in_us: parseNum(a.src_in_us, 'src_in_us'), src_out_us: parseNum(a.src_out_us, 'src_out_us'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us'),
      role: a.role === undefined || a.role === null ? null : parseRole(a.role),
      composition_id: parseCompositionIdOpt(a.composition_id) }) },
  { name: 'add_text_layer', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Add a Text layer — a title, a lower third, a credit — and return its record. Born at the caption font, 72 px, opaque white, centre-aligned and centred in frame. `x`/`y` (both or neither) override placement and are the layer's ANCHOR point, not clamped to frame. Everything else — font, size, colour, outline, layout box, alignment — is `update_layer_params { kind: 'Text' }`. It cannot overlap another visual layer on the track. Subtitles from a document are `apply_subtitles`; this is the one-off.",
    inputSchema: { type: 'object', properties: { content: { type: 'string', description: 'The text to display. Newlines are honoured.' }, t_end_us: T_END_SCHEMA, t_start_us: T_START_SCHEMA, track_id: TRACK_ID_SCHEMA, x: { type: 'number', description: "Anchor x in composition pixels. Give it with `y` or not at all; omitted, the layer is centred in frame." }, y: { type: 'number', description: 'Anchor y in composition pixels. Give it with `x` or not at all.' }, composition_id: TRACK_COMPOSITION_ID_SCHEMA }, required: ['content', 't_end_us', 't_start_us', 'track_id'] },
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), content: parseStr(a.content, 'content'),
      x: parseNumOpt(a.x, 'x'), y: parseNumOpt(a.y, 'y'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us'),
      composition_id: parseCompositionIdOpt(a.composition_id) }) },
  // The two caption tools that carry WORD timing. Both are dedicated because
  // both take the project id the production channels pass for staleness — an
  // agent has no reason to hold one, so the arm supplies it from the state it
  // is already reading.
  { name: 'apply_transcripts', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Lay transcripts on the caption tracks, KEEPING per-word timing; returns `{ caption_track_id, cues }`. Pass `transcribe_clip`'s envelope as it comes (`segments` and `word_timing`) — prefer this over `apply_subtitles` for a transcript: an SRT has no room for word offsets, and `correct_caption_text` needs them to re-segment a corrected cue. Cues pack into the composition's existing caption tracks, opening a lane only for a cue that collides with all of them, and snap to the frame grid. `source_layer_ids` is parallel to `transcripts` and tags each cue with the clip it came from, so corrections group by take. At most 1000 transcripts. One recorded edit.",
    inputSchema: { type: 'object', properties: {
      transcripts: { type: 'array', description: "One entry per transcribed clip, in the shape `transcribe_clip` returns.", items: {
        type: 'object',
        properties: {
          word_timing: { type: 'string', enum: ['exact', 'interpolated_from_cue', 'none'], description: "`transcribe_clip`'s field of the same name: where the word offsets came from. `none` stores cues with no word timing." },
          segments: { type: 'array', description: 'Cues, with timeline-absolute microsecond bounds.', items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The cue text.' }, t_start_us: US_SCHEMA('Cue start, timeline-absolute'), t_end_us: US_SCHEMA('Cue end (exclusive), timeline-absolute'),
              words: { type: 'array', description: 'Word offsets, timeline-absolute like the cue. Empty is allowed.', items: {
                type: 'object',
                properties: { text: { type: 'string', description: 'The word.' }, t_start_us: US_SCHEMA('Word start, timeline-absolute'), t_end_us: US_SCHEMA('Word end (exclusive), timeline-absolute') },
                required: ['text', 't_start_us', 't_end_us'],
              } },
            },
            required: ['text', 't_start_us', 't_end_us', 'words'],
          } },
        },
        required: ['word_timing', 'segments'],
      } },
      source_layer_ids: { type: 'array', items: { type: 'string' }, description: 'Parallel to `transcripts`: the layer each was transcribed from.' },
      composition_id: COMPOSITION_ID_SCHEMA,
    }, required: ['transcripts'] },
    parseDedicated: (a) => ({
      transcripts: asArray(a.transcripts, 'transcripts').map((t) => parseObj(t, 'transcripts')),
      source_ids: a.source_layer_ids === undefined || a.source_layer_ids === null
        ? [] : asArray(a.source_layer_ids, 'source_layer_ids').map((x) => parseUuid(x, 'source_layer_ids')),
      composition_id: parseCompositionIdOpt(a.composition_id),
    }) },
  { name: 'correct_caption_text', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Correct the captions against the project's reference text — `set_project_settings { correction_script }`: the script, the running order, the spelling of every name — and re-segment the cues the correction changed. Returns `{ changed }`. Refused while the script is blank (`InvalidArgument`, field `correction_script`). Every caption in the composition by default; `layer_ids` narrows it (an id that is not a caption Text layer refuses the call). A cue with word timing (see `apply_transcripts`) may be SPLIT or MERGED to match the new wording, each cue timed from its words; one without it is corrected in place. Refuses whole, before any write, if a target or its track is locked. One recorded edit.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The captions to correct. Omit for every caption in the composition.' },
      composition_id: COMPOSITION_ID_SCHEMA,
    }, required: [] },
    parseDedicated: (a) => ({
      layer_ids: a.layer_ids === undefined || a.layer_ids === null
        ? null : asArray(a.layer_ids, 'layer_ids').map((x) => parseUuid(x, 'layer_ids')),
      composition_id: parseCompositionIdOpt(a.composition_id),
    }) },
  { name: 'split_layer', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Split a layer into two halves at the given timeline microsecond. Returns `{ left, right, layers, siblings: [{ source, left, right }] }` — every link sibling's halves too. `at_t_us` must be strictly between the layer's t_start_us and t_end_us. For media-bearing layers (VideoClip, Audio) the source offsets are adjusted at speed=1 — variable speed support is deferred.",
    inputSchema: { type: 'object', properties: { at_t_us: US_SCHEMA('Cut point, timeline; strictly inside the layer'), escape_link: ESCAPE_LINK_SCHEMA, layer_id: LAYER_ID_SCHEMA }, required: ['at_t_us', 'layer_id'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'),
      at_t_us: parseNum(a.at_t_us, 'at_t_us'), escape_link: a.escape_link }) },
  { name: 'add_marker', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Add a marker (point or region) to a composition's timeline — the root, or the Group named by `composition_id`. Returns the marker record (`marker_id`, `t_us` as snapped). Set `end_t_us` to make it a region marker. Set `anchor_layer_id` to have the mark FOLLOW a clip instead of standing at a fixed time; omit it for an ordinary marker.",
    inputSchema: { type: 'object', properties: { anchor_layer_id: { type: 'string',
      description: 'Clip the marker should follow — a layer of the same composition with a source window (VideoClip, Audio, Group). Tied as `set_marker_anchor` would tie it, refused for the same reasons (no marker is created). Omit for a fixed marker.' },
      color: { ...RGBA_SCHEMA, description: 'Marker colour.' }, end_t_us: US_SCHEMA('Region end, timeline; omit for a point marker'), label: { type: 'string', description: 'Short name shown on the marker lane.' }, t_us: US_SCHEMA('Marker time, timeline'), composition_id: COMPOSITION_ID_SCHEMA }, required: ['color', 'label', 't_us'] },
    parseDedicated: (a) => ({ color: parseRgba(a.color, 'color'), t_us: parseNum(a.t_us, 't_us'),
      end_t_us: parseNumOpt(a.end_t_us, 'end_t_us'), label: parseStr(a.label, 'label'),
      anchor_layer_id: a.anchor_layer_id != null ? parseUuid(a.anchor_layer_id, 'anchor_layer_id') : null,
      composition_id: parseCompositionIdOpt(a.composition_id) }) },
  { name: 'set_history_lock', exec: 'dedicated', annotations: ANN_SET,
    description: "Block reverts (undo / redo / jump_to / restore_checkpoint) while a batch runs, or release the block. `locked: true` needs a `reason`, shown beside the lock badge in the agent and history panels and returned to any revert attempt; `locked: false` takes none and is idempotent. Never affects what records: the lock rejects reverts, it does not fold a batch into one history entry. Last writer wins. Always pair the lock with its release — ending the owning work session or disconnecting also releases it, and the user can unlock locally; switching views does not.",
    inputSchema: { type: 'object', properties: {
      locked: { type: 'boolean', description: 'true blocks reverts; false releases the block.' },
      reason: { type: 'string', description: 'Why the history is locked — required when locking, refused when unlocking.' },
    }, required: ['locked'] },
    parseDedicated: (a) => {
      const locked = parseBool(a.locked, 'locked')
      const reason = a.reason === undefined || a.reason === null ? null : parseStr(a.reason, 'reason')
      if (locked && (reason === null || reason.trim() === ''))
        throw new McpArgError('set_history_lock needs a non-empty `reason` when locking — it is what the user is shown in place of undo', 'reason')
      if (!locked && reason !== null)
        throw new McpArgError('set_history_lock takes no `reason` when unlocking — there is nothing left to explain', 'reason')
      return { locked, reason }
    } },
  { name: 'set_keyframe', exec: 'dedicated', annotations: ANN_SET,
    description: "Insert or update a keyframe on a layer param; `t_us` is timeline-absolute. A Static track is lifted to Keyframed; a key at the same frame is updated in place. Returns the key (`keyframe_id`, `t_us`). `value` is typed by `param_key`: a number for scalar params, `{r,g,b,a}` (0..255) for \"color\". `interp` (optional) is the easing of the segment LEAVING this key as a raw kind (Hold | Linear | Bezier {p1,p2} | Elastic | Bounce — the schema has the shapes; named presets go through `update_keyframe`); omitted, it inherits the preceding segment's easing. One side or the continuity: `update_keyframe`; Auto tangents: `smooth_keyframes`. Keying one scale axis of a scale-linked layer clears the link.",
    inputSchema: { type: 'object', properties: { interp: INTERP_SCHEMA, layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA, t_us: US_SCHEMA('Key time, timeline-absolute'), value: TRACK_VALUE_SCHEMA }, required: ['layer_id', 'param_key', 't_us', 'value'] },
    parseDedicated: (a) => {
      const paramKey = parseStr(a.param_key, 'param_key')
      return { layer: parseUuid(a.layer_id, 'layer_id'), param_key: paramKey,
        t_us: parseNum(a.t_us, 't_us'), value: parseTrackValue(a.value, paramKey, 'value'), interp: parseInterpOpt(a.interp) }
    } },
  { name: 'get_param_track', exec: 'dedicated', annotations: ANN_READ,
    description: "Read a layer param's animation track — the record to inspect before editing keys. Returns {\"mode\":\"Static\",\"value\":v} or {\"mode\":\"Keyframed\",\"extrapolate\":{before, after},\"keyframes\":[{id, t_us, t_local_us, value, in, out, continuity, segment, preset_id?}]}. `t_us` is timeline-absolute, `t_local_us` layer-local; `value` is typed by `param_key`. Per key, `in`/`out` are the arriving/leaving tangents {x, y, mode} in the segment's unit square (\"Auto\" = solved on write, \"Free\" = authored), `continuity` is \"Smooth\" | \"Broken\", `segment` is the class of the segment leaving the key (\"Spline\" | \"Hold\" | \"Linear\" | \"Elastic\" | \"Bounce\"; only Spline reads tangents), and `preset_id` names the easing preset the leaving segment exactly matches (absent on a hand-tuned curve and the last key). Position params are mode-specific: x/y in XY mode, path_progress in Path mode (a fraction, not a percentage).",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key') }) },
  { name: 'delete_keyframe', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Remove a keyframe by id from a layer param. Get the id from get_param_track. When it was the last key, the track collapses to Static holding that key's value.",
    inputSchema: { type: 'object', properties: { keyframe_id: ID_SCHEMA('Keyframe'), layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA }, required: ['keyframe_id', 'layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key') }) },
  { name: 'update_keyframe', exec: 'dedicated', annotations: ANN_SET,
    description: "Change one keyframe in one commit — any of: `t_us` (move it, timeline-absolute; the track re-sorts), `easing` (the segment LEAVING the key: {\"preset\":\"<id>\"} from the canonical table, read back as `preset_id`, or a raw kind {\"kind\":\"Hold\"} | {\"kind\":\"Linear\"} | {\"kind\":\"Bezier\",\"p1\":[x,y],\"p2\":[x,y]} | {\"kind\":\"Elastic\",\"dir\",amplitude?,period?} | {\"kind\":\"Bounce\",\"dir\"}; writes this key's out tangent and the next key's in tangent, both Free), `in` / `out` (one side's tangent {x, y}, stored Free — x within [0, 1], y may overshoot — its segment becoming Spline; a side written on an Auto key frees the whole key), `continuity` (\"Smooth\" re-derives in from out, \"Broken\" changes no number). At least one; applied in that order. Auto tangents on one or every key: `smooth_keyframes`.",
    inputSchema: { type: 'object', properties: {
      keyframe_id: ID_SCHEMA('Keyframe'),
      layer_id: LAYER_ID_SCHEMA,
      param_key: PARAM_KEY_SCHEMA,
      t_us: { type: 'integer', description: 'New timeline-absolute time, µs.' },
      easing: EASING_SCHEMA,
      in: TANGENT_XY_SCHEMA,
      out: TANGENT_XY_SCHEMA,
      continuity: { type: 'string', enum: ['Smooth', 'Broken'], description: 'Smooth keeps the two sides at one slope (re-derived from `out`); Broken lets them differ.' },
    }, required: ['keyframe_id', 'layer_id', 'param_key'] },
    parseDedicated: (a) => {
      const p = {
        layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'), param_key: parseStr(a.param_key, 'param_key'),
        t_us: parseNumOpt(a.t_us, 't_us') ?? null,
        easing: a.easing === undefined || a.easing === null ? null : parseEasing(a.easing),
        in: a.in === undefined || a.in === null ? null : parseTangentXy(a.in, 'in'),
        out: a.out === undefined || a.out === null ? null : parseTangentXy(a.out, 'out'),
        continuity: a.continuity === undefined || a.continuity === null ? null : parseContinuity(a.continuity),
      }
      if (p.t_us === null && p.easing === null && p.in === null && p.out === null && p.continuity === null)
        throw new McpArgError(`update_keyframe needs at least one of t_us, easing, in, out, continuity — nothing to change`)
      return p
    } },
  { name: 'smooth_keyframes', exec: 'dedicated', annotations: ANN_SET,
    description: "Set Auto tangents (clamped monotone, solved on write and kept smooth as neighbours move) on one key, or every key when `keyframe_id` is omitted. Both sides of each key go Auto with Smooth continuity, and the adjacent segments become Spline. get_param_track reads the solved coordinates back with mode \"Auto\".",
    inputSchema: { type: 'object', properties: { keyframe_id: { type: 'string', description: 'One key to smooth; omit for every key of the track.' }, layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      keyframe_id: a.keyframe_id != null ? parseUuid(a.keyframe_id, 'keyframe_id') : null }) },
  { name: 'clear_keyframes', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Collapse a param's animation back to a single Static value. `value` (optional) is the value to hold, typed by `param_key` — a number, or {r,g,b,a} (integers 0..255) for \"color\"; when omitted, defaults to the first keyframe's value. No-op on an already-Static track.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA, value: TRACK_VALUE_OPT_SCHEMA }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => {
      const paramKey = parseStr(a.param_key, 'param_key')
      return { layer: parseUuid(a.layer_id, 'layer_id'), param_key: paramKey, value: parseTrackValueOpt(a.value, paramKey, 'value') }
    } },
  { name: 'set_param_track', exec: 'dedicated', annotations: ANN_SET,
    description: "Low-level: replace a param's whole animation track — {\"mode\":\"Static\",\"value\":v} or {\"mode\":\"Keyframed\",\"value\":[{id, t_us, value, in, out, continuity, segment}],\"extrapolate\":{before, after}}; the keys ride in `value` here, where `get_param_track` reads them back as `keyframes` (plus t_local_us / preset_id) — with `t_us` timeline-absolute, values typed by `param_key`, each tangent's x within [0, 1], `extrapolate` defaulting to Hold/Hold. Auto sides and the in side of a Smooth key are re-solved on write. For bulk authoring only — retiming many keys or pasting a track is one commit here; otherwise use the granular tools. Replacing one scale axis of a scale-linked layer clears the link.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA, track: ANIM_TRACK_SCHEMA }, required: ['layer_id', 'param_key', 'track'] },
    parseDedicated: (a) => {
      const paramKey = parseStr(a.param_key, 'param_key')
      return { layer: parseUuid(a.layer_id, 'layer_id'), param_key: paramKey, track: parseAnimatedTrack(a.track, paramKey) }
    } },
  { name: 'set_extrapolation', exec: 'dedicated', annotations: ANN_SET,
    description: "Set what a keyframed track does outside its keys: `before` the first and/or `after` the last (at least one; the other keeps its value). \"Hold\" (the end value, default), \"Loop\" (repeat from the first key — a visible jump when first ≠ last), \"PingPong\" (alternate cycles run backwards), \"Offset\" (each cycle adds the last-minus-first delta), \"Continue\" (carry the last segment's end velocity on as a line). The period is last.t − first.t; a single-key track never extrapolates. Refused on a Static track. For path_progress, only Hold / Loop / PingPong are supported. Reads back as `extrapolate` on `get_param_track`.",
    inputSchema: { type: 'object', properties: {
      after: { ...EXTRAPOLATE_SCHEMA, description: 'After the last key. ' + EXTRAPOLATE_SCHEMA.description },
      before: { ...EXTRAPOLATE_SCHEMA, description: 'Before the first key. ' + EXTRAPOLATE_SCHEMA.description },
      layer_id: LAYER_ID_SCHEMA,
      param_key: PARAM_KEY_SCHEMA,
    }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => {
      const p = {
        layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
        before: a.before === undefined || a.before === null ? null : parseExtrapolate(a.before, 'before'),
        after: a.after === undefined || a.after === null ? null : parseExtrapolate(a.after, 'after'),
      }
      if (p.before === null && p.after === null)
        throw new McpArgError(`set_extrapolation needs at least one of before, after (each ${EXTRAPOLATE_OPTIONS}) — nothing to write`)
      return p
    } },
  { name: 'dry_run', exec: 'dedicated', annotations: ANN_READ,
    description: "Run a sequence of edit operations against a clone of the project WITHOUT committing — check overlaps and invariants before touching real state. Validates after each op exactly as `commit()` does and HALTS at the first error. Returns `{ results: [{ index, status, output? | error? }], halted_at: number | null }`. Supported ops: `add_color_layer`, `add_video_layer`, `add_audio_layer`, `add_text_layer`, `update_layer`, `update_layer_params`, `move_layer`, `split_layer`, `delete_layers` (lift only — `ripple: true` is refused), `add_transition` (the transition kind rides as `transition_kind`, since `kind` names the op). Motifs, caption import, media import and undo/redo are not dry-runnable.",
    inputSchema: { type: 'object', properties: { operations: {
      type: 'array',
      description: 'The edits to rehearse, in order.',
      items: { type: 'object', description: "{ kind: <one of the supported tool names>, ...that tool's args }. For add_transition the transition kind rides as `transition_kind` (plus optional `placement`)." },
    } }, required: ['operations'] },
    parseDedicated: (a) => ({ operations: asArray(a.operations, 'operations') }) },
  { name: 'add_motif_layer', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Add a motif layer and return its record. `motif_id` from `list_motifs`; `t_start_us` timeline µs; `t_end_us` defaults to `t_start_us + default_duration_s`; `track_id` omitted always spawns a fresh track (never reuses one, so consecutive auto-inserts cannot collide); `props` is matched against the motif's `props_schema` — unknown keys reject, missing keys take defaults. Rendering is lazy: the motif rasterizes on first render and is cached by content.",
    inputSchema: { type: 'object',
      properties: {
        motif_id: { type: 'string', description: 'Motif id from `list_motifs` (built-ins: "countdown", "lower-third", "text-fx").' },
        t_start_us: { type: 'integer', description: 'Layer start in timeline microseconds.' },
        t_end_us: { type: 'integer', description: 'Layer end in timeline microseconds. Defaults to `t_start_us + default_duration_s * 1_000_000` when omitted.' },
        track_id: { type: 'string', description: 'Target track id. If omitted, a fresh track is spawned; it carries no stored name and is displayed by its position.' },
        props: { type: 'object', description: 'Motif props as a JSON object. Keys must match the motif\'s `props_schema`; unknown keys reject; missing keys fill from defaults. Omit entirely to use all defaults.' },
        composition_id: { type: 'string', description: 'The composition the spawned track opens in (a Group\'s id); omit for the root. With `track_id` set, the track must belong to it.' },
      },
      required: ['motif_id', 't_start_us'] },
    parseDedicated: (a) => ({
      motif_id: parseStr(a.motif_id, 'motif_id'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'),
      t_end_us: parseNumOpt(a.t_end_us, 't_end_us') ?? null,
      track_id: a.track_id != null ? parseUuid(a.track_id, 'track_id') : null,
      props: a.props != null ? parseObj(a.props, 'props') : null,
      composition_id: parseCompositionIdOpt(a.composition_id),
    }) },
  { name: 'create_checkpoint', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Create a named checkpoint of the current state and return `{ checkpoint_id, label }`. Checkpoints survive later commits (unlike the redo tail) and persist in the project file; the agent panel shows each as a row with a Restore button. Use it at logical batch boundaries. Unrecorded.",
    inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'Checkpoint name.' } }, required: ['label'] },
    parseDedicated: (a) => ({ label: parseStr(a.label, 'label') }) },
  { name: 'list_checkpoints', exec: 'dedicated', annotations: ANN_READ,
    description: "List all named checkpoints, oldest first. Returns id, label, actor, created_at per checkpoint (no project snapshot).",
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseDedicated: (_a) => ({}) },
  { name: 'restore_checkpoint', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Restore a named checkpoint. Records a new history entry — undo will return to the pre-restore state. Errors with CheckpointNotFound if the id doesn't exist. The agent panel preserves activity and inserts a restore boundary; only edits with known history provenance are marked reverted.",
    inputSchema: { type: 'object', properties: { checkpoint_id: ID_SCHEMA('Checkpoint') }, required: ['checkpoint_id'] },
    parseDedicated: (a) => ({ checkpoint_id: parseUuid(a.checkpoint_id, 'checkpoint_id') }) },
  { name: 'end_agent_session', exec: 'dedicated', annotations: ANN_WRITE,
    description: "End your work session and release its history lock. Keeps the current view and activity records. Does not cancel running tasks, disconnect MCP, or prohibit later calls. Only the owning connection may end a session — unless `force: true`, which takes over another connection's session (and its lock) when its owner is gone; `read_project { view: \"session\" }` shows who holds it.",
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', description: "End another connection's session too. Default false." } } },
    parseDedicated: (a) => ({ force: parseBoolOpt(a.force, 'force', false) }) },
  { name: 'begin_agent_session', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Begin a work session and show the lightweight agent view. Creates one Pre-agent checkpoint. Repeating on the same connection returns the existing session without changing the view; another connection is refused (`AgentSessionBusy` names the holder) unless it takes over with `end_agent_session { force: true }`. Finish with end_agent_session; a session whose connection is gone is closed by the app once its stream has dropped. The user may switch views without ending the session.",
    inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'What this work session is for; shown to the user beside the busy badge.' } }, required: ['reason'] },
    parseDedicated: (a) => ({ reason: parseStr(a.reason, 'reason') }) },
  // ── hybrid defs (TS-owned) — executed by runHybrid (routeMcpTool → 'hybrid'),
  //    NOT actor.mcpCall arms. They live here (not the Rust catalog like the
  //    other hybrids) because their input computes in Rust — the shot report,
  //    the waveform peaks — while the edit writes through the TS actor, so the
  //    def has to merge into the advertised catalog from the TS side.
  //    parseDedicated is the bijection gate's required-scalar check only;
  //    runHybrid re-validates layer_id itself. ──
  { name: 'auto_split_by_shot', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Detect a VideoClip's shot cuts and split it at every in-window cut as ONE undoable step; returns `{ layer_ids }` in timeline order (the single unchanged id when there is no interior cut). `min_shot_us` (default 500000) is the minimum shot length; `drop_short=true` also deletes segments shorter than that, taking every overlapping member of the layer's link with them so no orphaned audio sliver is left. Reads the same cached shot report as `analyze_clip`, so boundaries agree; a convenience over `analyze_clip` + `split_layer`.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string', description: 'The VideoClip to split.' }, min_shot_us: US_SCHEMA('Shortest shot to keep; default 500000'), drop_short: { type: 'boolean', description: 'Also delete segments shorter than min_shot_us, with the overlapping members of their link. Default false.' } }, required: ['layer_id'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), min_shot_us: parseNumOpt(a.min_shot_us, 'min_shot_us'), drop_short: parseBoolOpt(a.drop_short, 'drop_short', false) }) },
  { name: 'remove_pauses', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Cut the pauses out of a clip's audio and CLOSE the gaps, as ONE recorded edit. A pause is a run whose peak stays under `threshold_amp` for at least `min_pause_us` (defaults as `detect_pauses`); `pad_us` (default 100000) of it stays on EACH side so speech keeps its breath, so the cut core is `[start + pad_us, end − pad_us)`; a pause touching the clip's edge is trimmed off whole. Pass an Audio layer, or a VideoClip, which delegates to the Audio layer of its link (refused when it plays no sound). Every other link member overlapping a removed core is cut in lockstep, and everything downstream shifts left on every track. Returns `{ surviving_layer_ids, removed, removed_us }`. Refuses whole, before any write, with `delete_layers { ripple: true }`'s refusals (`RippleInsideHole`, `RippleCollision`, `RippleLinkStraddles`, `RippleLockedLayer` / `TrackLocked`), and with `InvalidArgument` when the cores cover the clip end to end (that is a delete). To review first, `detect_pauses` + one anchored region `add_marker` per pause (the `/cut-pauses` prompt).",
    inputSchema: { type: 'object', properties: {
      layer_id: { type: 'string', description: 'Target Audio layer id, or a VideoClip id that delegates to its linked Audio layer.' },
      threshold_amp: { type: 'number', description: "Peak amplitude threshold in [0.0, 1.0], the same parameter `detect_pauses` takes. Omit to use that tool's own default." },
      min_pause_us: { type: 'integer', description: "Shortest pause worth removing, in microseconds — the same parameter `detect_pauses` takes. Omit to use that tool's own default." },
      pad_us: { type: 'integer', description: 'Microseconds of each pause KEPT on each side. Default 100000; 0 erases each pause whole. Must satisfy 2 * pad_us < min_pause_us.' },
    }, required: ['layer_id'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), threshold_amp: parseNumOpt(a.threshold_amp, 'threshold_amp'), min_pause_us: parseNumOpt(a.min_pause_us, 'min_pause_us'), pad_us: parseNumOpt(a.pad_us, 'pad_us') }) },
  // ── dedicated-exec: reads, for a client without MCP resources ─────────────
  { name: 'read_project', exec: 'dedicated', annotations: ANN_READ,
    description: "Read project state as a tool result — the same views the `project://*` resources serve, for a client that cannot read MCP resources (prefer the resources when yours can). `view`: `current`, `composition`, `compositions`, `media`, `tracks` (layer envelopes), `layer` (needs `id`), `markers`, `links`, `transitions`, `settings` (preferences + metadata incl. `modified_at`), `history`, `session` (who holds the work session), `effects` (the effects catalog), `media_thumbnail` / `media_frame` (an IMAGE block; `id` is the media id, `media_frame` also takes `t_us`). `composition`, `tracks`, `markers`, `links`, `transitions` take `composition_id` for a Group's, the root when omitted. JSON views return the body as text.",
    inputSchema: { type: 'object', properties: {
      view: { type: 'string', enum: [...READ_PROJECT_VIEWS], description: 'Which view to read.' },
      id: { type: 'string', description: 'The layer id for view `layer`; the media id for `media_thumbnail` / `media_frame`.' },
      t_us: { type: 'integer', description: 'For `media_frame`: the frame time in the SOURCE, µs.' },
      composition_id: { type: 'string', description: 'For the per-composition views: a Group\'s composition; omit for the root.' },
    }, required: ['view'] },
    parseDedicated: (a) => {
      const view = parseStr(a.view, 'view')
      if (!READ_PROJECT_VIEWS.includes(view as ReadProjectView)) throw new McpArgError(`view must be one of ${READ_PROJECT_VIEWS.join(', ')}, got '${view}'`, 'view')
      const needsId = view === 'layer' || view === 'media_thumbnail' || view === 'media_frame'
      if (needsId && (a.id === undefined || a.id === null)) throw new McpArgError(`view '${view}' needs \`id\` — ${view === 'layer' ? 'the layer id (project://tracks lists them)' : 'the media id (project://media lists them)'}`, 'id')
      if (view === 'media_frame' && (a.t_us === undefined || a.t_us === null)) throw new McpArgError("view 'media_frame' needs `t_us` — the frame time in the SOURCE, µs (media_thumbnail takes none)", 't_us')
      const t_us = view === 'media_frame' ? parseNum(a.t_us, 't_us') : null
      return { view, id: needsId ? parseUuid(a.id, 'id') : null, t_us, composition_id: parseCompositionIdOpt(a.composition_id) }
    } },
]

const DEF_BY_NAME: Map<string, McpToolDef> = new Map(MCP_TOOL_DEFS.map((d) => [d.name, d]))
export function mcpDef(name: string): McpToolDef { const d = DEF_BY_NAME.get(name); if (!d) throw new Error(`no MCP def for ${name}`); return d }

/** MCP tool → internal dispatch op + renamed args. Projection of MCP_TOOL_DEFS.
 *  Explicit-param tools (add_color_layer/add_video_layer/add_marker/split_layer
 *  etc.) are NOT here — they have dedicated arms in actor.mcpCall. */
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> =
  Object.fromEntries(MCP_TOOL_DEFS.flatMap((d) => d.parseArgs ? [[d.name, d.parseArgs] as const] : []))

/** All MCP tools this adapter handles (parsers + the dedicated arms). Projection of MCP_TOOL_DEFS. */
export const MCP_TOOLS: ReadonlySet<string> = new Set(MCP_TOOL_DEFS.map((d) => d.name))
