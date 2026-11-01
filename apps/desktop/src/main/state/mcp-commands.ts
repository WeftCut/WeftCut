import { RESTYLE_GROUPS } from './mutations/restyleTaste'
import { CORRECTION_SCRIPT_MAX } from '../../shared/textCorrectionRequest'
import { pauseAmpFromDb } from '../../shared/pauseLevel'
import { TEXT_INTROS, TEXT_OUTROS } from '../../shared/textAnimation'
import { validateTimeFraction } from '../../renderer/layerTiming'
import { readExactTime } from '../../renderer/timeMapping'
import { cropProblem } from '../../shared/crop'
import { BUILTIN_GRAPHIC_ROLES, GRAPHIC_ROLE_PATTERN, graphicRoleProblem } from '../../shared/graphicRole'
// apps/desktop/src/main/state/mcp-commands.ts
// Pure MCP-tool adapter helpers: arg parsing (snake_case MCP vocab → internal
// dispatch vocab), ToolResult shaping, and CommandError → MCP error mapping.
// The byte-exact mcp.differential gate (vs Rust dispatch_tool) is the backstop.
// Mirrors native/src/mcp/{tools.rs,wire.rs}.
import type { CommandError } from './errors'
import type { Animated, Continuity, EaseDir, Extrapolate, Extrapolation, Interpolation, Keyframe, Rgba, Segment, Tangent, TangentMode, TransitionDirection, TransitionKind } from './model'
import { HOLD_EXTRAPOLATION, IN_IDENTITY, OUT_IDENTITY } from '../../shared/keyframe'
import { isUuid, uuidV7Gen, type IdGen } from './ids'
import type { EffectPatch } from './mutations/effects'
import type { MarkerPatch } from './mutations/markers'
import type { LayerParamsPatch } from './mutations/params'
import { EFFECT_KINDS, effectParamSpecs } from '../../shared/effects/params'
import { positionProblem } from '../../shared/position'
import { sortKeys } from './canonical'
import { CANVAS_MAX, CANVAS_MIN, DEFAULT_CANVAS, FPS_OPTIONS, canvasSizeError, validateProjectName } from '../../shared/newProject'
import { EASING_PRESETS, ELASTIC_DEFAULT_AMPLITUDE, ELASTIC_DEFAULT_PERIOD, applySegmentEasing, cloneInterp, presetIdForSegment } from '../../shared/easing'
import { TACK_BODY_LIMIT, TACK_KINDS, TACK_LABEL_LIMIT, TACK_STATUSES } from '../../shared/agent-activity'

/** `cancelled`: a clip-compute job ended by an explicit cancel (ADR 0121) —
 *  native's envelope code for it, and the code of the tool result that says so. */
export type McpErrorCode = 'invalid_params' | 'invalid_request' | 'not_found' | 'internal' | 'cancelled'
export type McpToolErrorJson = { code: McpErrorCode; message: string; data?: unknown }
export type ToolResultJson = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } // isError omitted when false
export type McpCallResult = { ok: true; result: ToolResultJson } | { ok: false; error: McpToolErrorJson }

/** Thrown by arg parsers on bad input (e.g. malformed UUID) → invalid_params. */
export class McpArgError extends Error {
  constructor(public readonly mcpMessage: string, public readonly field?: string) { super(mcpMessage); this.name = 'McpArgError' }
  toJson(): McpToolErrorJson { return { code: 'invalid_params', message: this.mcpMessage } }
}

/** Mirrors tools.rs parse_uuid: validates + errors "<field> not a UUID: …". */
export function parseUuid(s: unknown, field: string): string {
  if (!isUuid(s)) throw new McpArgError(`${field} not a UUID: ${String(s)}`, field)
  return s
}

const INTERP_KINDS = `'Hold' | 'Linear' | 'Bezier' | 'Elastic' | 'Bounce'`
const EASE_DIRS = new Set<string>(['In', 'Out', 'InOut'])
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

function parseEaseDir(v: unknown, kind: string, field: string): EaseDir {
  if (typeof v !== 'string' || !EASE_DIRS.has(v))
    throw new McpArgError(`invalid ${field}: ${kind} needs dir 'In' | 'Out' | 'InOut', got ${String(v)}`)
  return v as EaseDir
}

/** Validate a raw easing kind — the closed wire union single-sourced in
 *  src/shared/easing.ts (Hold | Linear | Bezier | Elastic | Bounce). Elastic
 *  amplitude/period may be omitted and take the shared authoring defaults, so
 *  the parsed value is always a complete wire object. Bezier control-point x
 *  is gated to [0, 1] — x is segment time, and the solver is single-valued
 *  only on that range. `field` names the argument in the refusal (`easing`, or
 *  a key's `segment`). Throws McpArgError on malformed input → invalid_params. */
export function parseInterp(v: unknown, field = 'easing'): Interpolation {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid ${field}: not an object`)
  const o = v as Record<string, unknown>
  const kind = o.kind
  if (typeof kind !== 'string') throw new McpArgError(`invalid ${field}: missing 'kind' (${INTERP_KINDS})`)
  if (kind === 'Hold' || kind === 'Linear') return { kind }
  if (kind === 'Bezier') {
    const p1 = o.p1
    const p2 = o.p2
    if (!isPair(p1) || !isPair(p2)) throw new McpArgError(`invalid ${field}: Bezier needs p1/p2 as [number, number]`)
    if (!(p1[0] >= 0 && p1[0] <= 1)) throw new McpArgError(`invalid ${field}: Bezier p1[0] (x) must be within [0, 1], got ${p1[0]} — x is segment time; only y may overshoot`)
    if (!(p2[0] >= 0 && p2[0] <= 1)) throw new McpArgError(`invalid ${field}: Bezier p2[0] (x) must be within [0, 1], got ${p2[0]} — x is segment time; only y may overshoot`)
    return { kind: 'Bezier', p1, p2 }
  }
  if (kind === 'Elastic') {
    const dir = parseEaseDir(o.dir, 'Elastic', field)
    const amplitude = o.amplitude === undefined || o.amplitude === null ? ELASTIC_DEFAULT_AMPLITUDE : parseNum(o.amplitude, `${field}.amplitude`)
    if (amplitude < 1) throw new McpArgError(`invalid ${field}: Elastic amplitude must be >= 1, got ${amplitude} (omit it for the default ${ELASTIC_DEFAULT_AMPLITUDE})`)
    const period = o.period === undefined || o.period === null ? ELASTIC_DEFAULT_PERIOD : parseNum(o.period, `${field}.period`)
    if (period <= 0) throw new McpArgError(`invalid ${field}: Elastic period must be > 0, got ${period} (omit it for the default ${ELASTIC_DEFAULT_PERIOD})`)
    return { kind: 'Elastic', dir, amplitude, period }
  }
  if (kind === 'Bounce') return { kind: 'Bounce', dir: parseEaseDir(o.dir, 'Bounce', field) }
  if (kind === 'EaseIn' || kind === 'EaseOut')
    throw new McpArgError(`invalid ${field}: '${kind}' is not a kind — named eases are presets ({"preset":"${kind === 'EaseIn' ? 'ease_in' : 'ease_out'}"}); kinds: ${INTERP_KINDS}`)
  throw new McpArgError(`invalid ${field}: unknown kind '${kind}' — expected ${INTERP_KINDS}`)
}

/** The one easing vocabulary (`set_keyframe`, `update_keyframe` and a
 *  `set_param_track` key): {"preset":"<id>"} bakes to a fresh copy of the
 *  canonical table entry's params (cloneInterp — the table IS the params,
 *  nothing is re-derived here); anything else parses as a raw kind. Exactly one
 *  of preset/kind: both together is ambiguous and rejects. The unknown-preset
 *  error carries the full live id list in the MESSAGE — the client drops
 *  error.data, so options must ride the message. */
export function parseEasing(v: unknown, field = 'easing'): Interpolation {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new McpArgError(`invalid ${field}: not an object`)
  const o = v as Record<string, unknown>
  if (o.preset === undefined || o.preset === null) {
    if (o.kind === undefined) throw new McpArgError(`invalid ${field}: send {"preset":"<id>"} or a raw kind ${INTERP_KINDS}`)
    return parseInterp(v, field)
  }
  if (o.kind !== undefined) throw new McpArgError(`invalid ${field}: send either {"preset":"<id>"} or a raw {"kind":...}, not both`)
  const hit = typeof o.preset === 'string' ? EASING_PRESETS.find((p) => p.id === o.preset) : undefined
  if (!hit) throw new McpArgError(`invalid ${field}: unknown preset '${String(o.preset)}' — presets: ${EASING_PRESETS.map((p) => p.id).join(', ')}`)
  return cloneInterp(hit.interp)
}

const TANGENT_MODES: readonly TangentMode[] = ['Auto', 'Free']
const CONTINUITIES: readonly Continuity[] = ['Smooth', 'Broken']
const EXTRAPOLATES: readonly Extrapolate[] = ['Hold', 'Loop', 'PingPong', 'Offset', 'Continue']
const CONTINUITY_OPTIONS = `'Smooth' | 'Broken'`
const EXTRAPOLATE_OPTIONS = EXTRAPOLATES.map((e) => `'${e}'`).join(' | ')
const KEY_SHAPE = '{t_us, value, easing?, in?: {x, y, mode}, out?: {x, y, mode}, continuity?, segment?: {kind, ...}} (IDs are generated)'
const TANGENT_X_RULE = `x is the fraction of the segment's time span and must be within [0, 1]; only y may overshoot`

/** One side of a key as stored: unit-square coords (x gated to [0, 1] — the
 *  cubic is single-valued in time only there) + a mode. An Auto side's numbers
 *  are solved on write, so it may omit them: they start at the identity and the
 *  solve replaces them. */
function parseTangent(v: unknown, side: 'in' | 'out'): Tangent {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid track: keyframe "${side}" must be a tangent {x, y, mode}`)
  const o = v as Record<string, unknown>
  if (o.mode === 'Auto' && o.x === undefined && o.y === undefined) return { ...(side === 'in' ? IN_IDENTITY : OUT_IDENTITY), mode: 'Auto' }
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
  if (o.preset !== undefined) throw new McpArgError(`invalid track: a segment is a class {kind, ...}; a preset is the key's \`easing\` {"preset":"<id>"}`)
  const i = parseInterp(v, 'segment')
  // Narrowing only: parseInterp mints Bezier from kind 'Bezier' alone, refused above.
  if (i.kind === 'Bezier') throw new McpArgError(NO_BEZIER_SEGMENT)
  return i
}
const NO_BEZIER_SEGMENT = `invalid track: a stored segment has no 'Bezier' kind — send the key's \`easing\` {"kind":"Bezier","p1","p2"} (or a preset), or {"kind":"Spline"} with the cubic on this key's out and the next key's in`

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


/** Authoring inputs carry values and curves, never externally minted identities. */
function authoringFields(o: Record<string, unknown>, allowed: string[], field: string): void {
  if ('id' in o) throw new McpArgError(`${field}: IDs are generated by WeftCut; omit id. Read existing IDs to update or delete individual keys.`, field)
  for (const key of Object.keys(o))
    if (!allowed.includes(key)) throw new McpArgError(`${field}: unknown key '${key}'; expected ${allowed.join(', ')}`, field)
}

/** Materialize the ID-free authoring shape into the complete stored record.
 *  The actor supplies its ID generator; no user ID can reach native export.
 *  Stored project parsing remains strict and does not use these defaults.
 *  `easing` keys are `set_param_track`'s alone (`withEasing`). */
function parseAnimatedTrackWith<T>(v: unknown, parseValue: (v: unknown, field: string) => T, idGen: IdGen, keyTime: 't_us' | 'local_t_us' = 't_us', withEasing = false): Animated<T> {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid track: not an object`)
  const o = v as Record<string, unknown>
  authoringFields(o, ['mode', 'value', 'extrapolate'], 'track')
  if (o.mode === 'Static') {
    if (o.extrapolate !== undefined) throw new McpArgError(`invalid track: a Static track has no extrapolate — it holds one value; extrapolation is a Keyframed track's`)
    return { mode: 'Static', value: parseValue(o.value, 'invalid track: Static value') }
  }
  if (o.mode === 'Keyframed') {
    if (!Array.isArray(o.value)) throw new McpArgError(`invalid track: Keyframed value must be an array`)
    const fields = [keyTime, 'time_fraction', 'value', ...(withEasing ? ['easing'] : []), 'in', 'out', 'continuity', 'segment']
    const entries = o.value.map((raw, i) => {
      if (raw === null || typeof raw !== 'object') throw new McpArgError(`invalid track: keyframe must be an object`)
      const k = raw as Record<string, unknown>
      if ('interp' in k)
        throw new McpArgError(`invalid track: keyframe[${i}] carries "interp", which is not a key field — a key is ${KEY_SHAPE}; its easing is \`easing\` (a preset or a raw kind)`)
      authoringFields(k, fields, `keyframe[${i}]`)
      if (!Number.isSafeInteger(k[keyTime])) throw new McpArgError(`invalid track: keyframe ${keyTime} must be an integer number of microseconds`)
      const value = parseValue(k.value, `invalid track: keyframe[${i}].value`)
      const key: Keyframe<T> = {
        id: idGen(), t_us: k[keyTime] as number, value,
        ...(k.time_fraction === undefined ? {} : { time_fraction: parseTimeFraction(k.time_fraction) }),
        in: k.in === undefined ? { ...IN_IDENTITY, mode: 'Free' } : parseTangent(k.in, 'in'),
        out: k.out === undefined ? { ...OUT_IDENTITY, mode: 'Free' } : parseTangent(k.out, 'out'),
        continuity: k.continuity === undefined ? 'Broken' : parseContinuity(k.continuity, 'invalid track: keyframe continuity'),
        segment: k.segment === undefined ? { kind: 'Linear' } : parseSegment(k.segment),
      }
      return { i, key, easing: k.easing === undefined ? undefined : parseEasing(k.easing, `keyframe[${i}].easing`), sent: { in: k.in !== undefined, out: k.out !== undefined || k.segment !== undefined } }
    })
    applyKeyEasings(entries)
    let extrapolate: Extrapolation = { ...HOLD_EXTRAPOLATION }
    if (o.extrapolate !== undefined && o.extrapolate !== null) {
      if (typeof o.extrapolate !== 'object') throw new McpArgError(`invalid track: extrapolate must be {before, after}`)
      const e = o.extrapolate as Record<string, unknown>
      extrapolate = { before: parseExtrapolate(e.before, 'invalid track: extrapolate.before'), after: parseExtrapolate(e.after, 'invalid track: extrapolate.after') }
    }
    return { mode: 'Keyframed', value: entries.map((e) => e.key), extrapolate }
  }
  throw new McpArgError(`invalid track: unknown mode '${String(o.mode)}'`)
}

/** The segment a key's `easing` eases: the one LEAVING it, or — on the last
 *  key, which has none — the one ARRIVING at it (`easingSegment`, the rule
 *  `set_keyframe` and `update_keyframe` share). An easing writes the left key's
 *  `out` + `segment` and the right key's `in`, so a key that also sends those
 *  sides, or two easings on one segment, is refused naming both: either would
 *  otherwise overwrite the other in silence. In time order, as the actor sorts. */
function applyKeyEasings<T>(entries: Array<{ i: number; key: Keyframe<T>; easing: Interpolation | undefined; sent: { in: boolean; out: boolean } }>): void {
  if (!entries.some((e) => e.easing)) return
  const order = [...entries].sort((a, b) => a.key.t_us - b.key.t_us)
  const easedBy = new Map<number, number>() // left position → the entry index that eased it
  order.forEach((e, j) => {
    if (!e.easing) return
    const at = `keyframe[${e.i}].easing`
    const left = easingSegment(j, order.length)
    if (left === null) throw new McpArgError(`${at}: a track of one key has no segment to ease — add the key it moves to`, at)
    const l = order[left]!
    const r = order[left + 1]!
    if (l.sent.out) throw new McpArgError(`${at} writes keyframe[${l.i}]'s out and segment, which keyframe[${l.i}] also sends — send one or the other`, at)
    if (r.sent.in) throw new McpArgError(`${at} writes keyframe[${r.i}]'s in, which keyframe[${r.i}] also sends — send one or the other`, at)
    const prior = easedBy.get(left)
    if (prior !== undefined) throw new McpArgError(`${at} and keyframe[${prior}].easing both ease the segment from keyframe[${l.i}] to keyframe[${r.i}] (the last key's easing eases the segment arriving at it) — send one`, at)
    easedBy.set(left, e.i)
    const [lk, rk] = applySegmentEasing(l.key, r.key, e.easing)
    l.key = lk
    r.key = rk!
  })
}

/** The left key of the segment an `easing` on key `j` of `n` eases: its own
 *  leaving segment, or on the last key the one arriving at it; null for a lone
 *  key. One rule for `set_keyframe`, `update_keyframe` and `set_param_track`. */
export function easingSegment(j: number, n: number): number | null {
  if (n < 2) return null
  return j < n - 1 ? j : j - 1
}

/** `set_param_track`'s track, values typed by `paramKey` (`parseTrackValue`),
 *  keys taking `easing`. */
export function parseAnimatedTrack(v: unknown, paramKey: string, idGen: IdGen = uuidV7Gen()): AnimatedTrack {
  return isColorParam(paramKey)
    ? parseAnimatedTrackWith<Rgba>(v, (x, f) => parseTrackValue(x, paramKey, f) as Rgba, idGen, 't_us', true)
    : parseAnimatedTrackWith<number>(v, (x, f) => parseTrackValue(x, paramKey, f) as number, idGen, 't_us', true)
}

/** A `set_position` track: its keys are timed `local_t_us`, µs from the
 *  layer's start — the base they are stored in, named so. */
function parseLocalAnimatedF64(v: unknown, idGen: IdGen): Animated<number> {
  return parseAnimatedTrackWith<number>(v, parseNum, idGen, 'local_t_us')
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

// ── Strict patch parsers ────────────────────────────────────────────────────
// Key SETS, not just "is an object" (`parseObj` above says why): each parser
// refuses an unknown key at the boundary naming the accepted set, so the agent
// learns the vocabulary from the refusal rather than from a re-read that shows
// nothing changed.

/** A finite integer wire arg → invalid_params. The µs fields and the extents
 *  are integers on the wire (the schema says so); a fraction is a bug in the
 *  caller's arithmetic, not a request. */
export function parseIntNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new McpArgError(`${field} must be an integer, got ${describeValue(v)}`, field)
  return v
}

/** An optional `graphic_role` wire arg: absent → undefined (the default
 *  applies), null → untagged, else a well-formed role name. Built-in or not is
 *  not checked here — an undeclared custom role is the lint's to report. */
export function parseGraphicRoleOpt(v: unknown, field = 'graphic_role'): string | null | undefined {
  if (v === undefined) return undefined
  const problem = graphicRoleProblem(v)
  if (problem) throw new McpArgError(problem, field)
  return v as string | null
}
// ── add_layers: one batch of new layers ─────────────────────────────────────
// The wire kinds, one per thing an agent places; each names the fields of its
// `content` arm. Strict on keys: a field another kind takes (`src_in_us` on an
// image, `graphic_role` on a video) would otherwise be dropped in silence.
export const ADD_LAYER_KINDS = ['video', 'image', 'audio', 'text', 'color', 'motif', 'group'] as const
export type AddLayerKind = (typeof ADD_LAYER_KINDS)[number]
const ADD_LAYER_CONTENT_KEYS: Record<AddLayerKind, readonly string[]> = {
  video: ['media_id', 'src_in_us', 'audio'], image: ['media_id', 'graphic_role'], audio: ['media_id', 'src_in_us', 'role'],
  text: ['content', 'graphic_role'], color: ['color'], motif: ['motif_id', 'props', 'graphic_role'], group: ['composition_id'],
}
export const ADD_LAYERS_MAX = 50
/** `remove_pauses { pauses }`: one detection's worth of reviewed ranges. */
export const REMOVE_PAUSES_MAX = 1000

/** `remove_pauses { pauses }`: the reviewed ranges, shape-checked (the hybrid
 *  checks them against the clip), or undefined to detect. They replace
 *  detection, so the detection parameters may not ride along. */
export function parseReviewedPauses(a: Record<string, unknown>): Array<{ t_start_us: number; t_end_us: number }> | undefined {
  if (a.pauses === undefined || a.pauses === null) return undefined
  if (a.threshold_db !== undefined || a.min_pause_us !== undefined) throw new McpArgError('pauses replaces detection — send it without threshold_db / min_pause_us', 'pauses')
  const list = asNonEmptyArray(a.pauses, 'pauses', 'send at least one pause, or omit it to detect')
  if (list.length > REMOVE_PAUSES_MAX) throw new McpArgError(`pauses holds ${list.length}; at most ${REMOVE_PAUSES_MAX} per call`, 'pauses')
  return list.map((p, i) => {
    const o = parseObj(p, `pauses[${i}]`)
    strictKeys(o, ['t_start_us', 't_end_us'], `pauses[${i}]`)
    const t_start_us = o.t_start_us, t_end_us = o.t_end_us
    if (!Number.isSafeInteger(t_start_us) || !Number.isSafeInteger(t_end_us) || (t_start_us as number) < 0 || (t_end_us as number) <= (t_start_us as number))
      throw new McpArgError(`pauses[${i}] must be { t_start_us, t_end_us } whole timeline µs with t_start_us < t_end_us`, 'pauses')
    return { t_start_us: t_start_us as number, t_end_us: t_end_us as number }
  })
}

/** Refuse a key a tool does not take, so nothing an agent sends is silently
 *  dropped. A key the surface renamed or folded names what replaced it (no
 *  alias: the old spelling never dispatches). */
export function strictKeys(o: Record<string, unknown>, allowed: readonly string[], where: string, replaced: Readonly<Record<string, string>> = {}): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue
    const instead = replaced[k]
    throw new McpArgError(instead ? `${where}: '${k}' is not an argument any more — ${instead}` : `${where}: unknown key '${k}'; expected ${allowed.join(', ')}`, k)
  }
}
const ADD_LAYER_KEYS: readonly string[] = ['track_id', 't_start_us', 't_end_us', 'label', 'transform', 'content']
const ADD_LAYER_TRANSFORM_KEYS: readonly string[] = ['x', 'y', 'scale', 'rotation_deg', 'opacity']
export type AddLayerContent =
  | { kind: 'video'; media: string; src_in_us: number; audio: 'linked' | 'none' | null }
  | { kind: 'image'; media: string; graphic_role: string | null }
  | { kind: 'audio'; media: string; src_in_us: number; role: string | null }
  | { kind: 'text'; content: string; graphic_role: string | undefined }
  | { kind: 'color'; color: Rgba }
  | { kind: 'motif'; motif_id: string; props: Record<string, unknown> | null; graphic_role: string | undefined }
  | { kind: 'group'; composition: string }
export interface AddLayerTransform { x?: number; y?: number; scale?: number; rotation_deg?: number; opacity?: number }
export interface AddLayerSpec {
  /** `layers[i]`, the prefix every refusal about this layer names. */
  at: string
  track: string | null; t_start_us: number; t_end_us: number | null; label: string | null
  transform: AddLayerTransform | null; content: AddLayerContent
}
function refuseUnknownKeys(o: Record<string, unknown>, allowed: readonly string[], at: string, what: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k))
  if (extra.length > 0) throw new McpArgError(`${at}: ${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not a field of ${what} (fields: ${allowed.join(', ')})`, `${at}.${extra[0]}`)
}
/** A tool's top-level arguments, strictly: a key the tool does not take is
 *  refused naming the tool that does (`owners`), never dropped — a stale
 *  spelling silently ignored would run a different edit than the one meant. */
function refuseUnknownArgs(a: Record<string, unknown>, allowed: readonly string[], tool: string, owners: Readonly<Record<string, string>> | ((k: string) => string | undefined) = {}): void {
  const k = Object.keys(a).find((x) => !allowed.includes(x))
  if (k === undefined) return
  const owner = typeof owners === 'function' ? owners(k) : owners[k]
  throw new McpArgError(`${tool} takes no \`${k}\`${owner ? ` — ${owner}` : ''} (arguments: ${allowed.join(', ')})`, k)
}
/** A `graphic_role` inside `content`: a role name, or absent. `null` would say
 *  no more than omission, so it is refused rather than accepted as a no-op. */
function parseContentRole(v: unknown, field: string): string | undefined {
  if (v === null) throw new McpArgError(`${field}: omit it for an untagged layer; null is not a role`, field)
  return parseGraphicRoleOpt(v, field) ?? undefined
}
function parseAddLayerContent(v: unknown, at: string): AddLayerContent {
  const c = parseObj(v, at)
  const kind = parseOneOf(c.kind, ADD_LAYER_KINDS, `${at}.kind`) as AddLayerKind
  refuseUnknownKeys(c, ['kind', ...ADD_LAYER_CONTENT_KEYS[kind]], at, `a ${kind} layer's content`)
  const f = (k: string) => `${at}.${k}`
  switch (kind) {
    case 'video': return { kind, media: parseUuid(c.media_id, f('media_id')), src_in_us: parseNum(c.src_in_us, f('src_in_us')),
      audio: c.audio === undefined ? null : parseOneOf(c.audio, ['linked', 'none'], f('audio')) as 'linked' | 'none' }
    case 'image': return { kind, media: parseUuid(c.media_id, f('media_id')), graphic_role: parseContentRole(c.graphic_role, f('graphic_role')) ?? null }
    case 'audio': return { kind, media: parseUuid(c.media_id, f('media_id')), src_in_us: parseNum(c.src_in_us, f('src_in_us')),
      role: c.role === undefined ? null : parseOneOf(c.role, [...AUDIO_ROLES], f('role')) }
    case 'text': return { kind, content: parseStr(c.content, f('content')), graphic_role: parseContentRole(c.graphic_role, f('graphic_role')) }
    case 'color': return { kind, color: parseRgba(c.color, f('color')) }
    case 'motif': return { kind, motif_id: parseStr(c.motif_id, f('motif_id')), props: c.props === undefined ? null : parseObj(c.props, f('props')), graphic_role: parseContentRole(c.graphic_role, f('graphic_role')) }
    case 'group': return { kind, composition: parseUuid(c.composition_id, f('composition_id')) }
  }
}
function parseAddLayerTransform(v: unknown, at: string, kind: AddLayerKind): AddLayerTransform | null {
  if (v === undefined) return null
  const o = parseObj(v, at)
  refuseUnknownKeys(o, ADD_LAYER_TRANSFORM_KEYS, at, 'transform')
  if (Object.keys(o).length === 0) throw new McpArgError(`${at} names no field; omit it for the default placement`, at)
  if (kind === 'color' || kind === 'audio') throw new McpArgError(`${at}: a ${kind} layer has no transform`, at)
  if (kind === 'text' && o.scale !== undefined) throw new McpArgError(`${at}.scale: a text layer has no scale; size it with update_layer_params font_size_px or box_w`, `${at}.scale`)
  const t: AddLayerTransform = {}
  for (const k of ADD_LAYER_TRANSFORM_KEYS) if (o[k] !== undefined) t[k as keyof AddLayerTransform] = parseNum(o[k], `${at}.${k}`)
  return t
}
function parseAddLayer(v: unknown, at: string): AddLayerSpec {
  const o = parseObj(v, at)
  refuseUnknownKeys(o, ADD_LAYER_KEYS, at, 'a layer')
  const content = parseAddLayerContent(o.content, `${at}.content`)
  const t0 = parseNum(o.t_start_us, `${at}.t_start_us`)
  const t1 = o.t_end_us === undefined ? null : parseNum(o.t_end_us, `${at}.t_end_us`)
  if (t1 === null && content.kind !== 'group') throw new McpArgError(`${at}.t_end_us is required for a ${content.kind} layer; only a group defaults its end`, `${at}.t_end_us`)
  if (t1 !== null && t1 <= t0) throw new McpArgError(`${at}.t_end_us ${t1} must be greater than t_start_us ${t0}`, `${at}.t_end_us`)
  return {
    at, content, t_start_us: t0, t_end_us: t1,
    track: o.track_id === undefined ? null : parseUuid(o.track_id, `${at}.track_id`),
    label: o.label === undefined ? null : parseStr(o.label, `${at}.label`),
    transform: parseAddLayerTransform(o.transform, `${at}.transform`, content.kind),
  }
}

const MOVE_LAYERS_KEYS: readonly string[] = ['layer_ids', 't_start_us', 'delta_us', 'track_id', 'insert', 'escape_link']
/** Where a key sent to `rename_layer` / `set_layer_flags` belongs instead: the
 *  times go to the tools that move and trim (they carry link siblings, the
 *  source window, keyframes and the autofit; a raw envelope write would carry
 *  none of them), the name and flags to each other. */
const LAYER_ENVELOPE_OWNER: Readonly<Record<string, string>> = {
  t_start_us: 'move a layer with move_layers { layer_ids, t_start_us }; both carry link partners and the source window',
  t_end_us: 'change one edge with trim_layer { layer_id, edge, new_t_us }; it carries link partners and the source window',
  label: 'the name is rename_layer { layer_id, label }',
  enabled: 'visibility is set_layer_flags { layer_ids, enabled }',
  locked: 'the lock is set_layer_flags { layer_ids, locked }',
  patch: 'send the fields themselves; kind-specific params are update_layer_params { layer_id, patch }',
  layer_id: 'name the layers in layer_ids',
  layer_ids: 'rename_layer names one layer_id',
}
const LAYER_ENVELOPE_OWNERS = (k: string): string | undefined => LAYER_ENVELOPE_OWNER[k]
  ?? (Object.values(LAYER_PARAMS_KEYS).some((ks) => ks.includes(k)) ? `'${k}' is a kind-specific param, which is update_layer_params { layer_id, patch: { kind, ${k} } }` : undefined)

/** The fields each kind's patch may carry — the key sets of `LayerParamsPatch`
 *  (mutations/params.ts) as data, so the parser can name them and the schema
 *  can advertise them. `keysOf` ties each row to the type: a key added to one
 *  side without the other fails to compile. */
type PatchKeysOf<K extends LayerParamsPatch['kind']> = Exclude<keyof Extract<LayerParamsPatch, { kind: K }>, 'kind'>
/** One kind's key set as a record, so tsc refuses a key the patch type does
 *  not have and demands every key it does. `src_out_us` is the one key the
 *  surface leaves out: over MCP a window is written by `src_in_us` alone, as a
 *  slip that keeps its length, so the span and what it plays cannot disagree;
 *  its length is `trim_layer`'s, its rate `retime_layers`'. */
const keysOf = <K extends LayerParamsPatch['kind']>(_kind: K, table: Record<PatchKeysOf<K>, true>): readonly string[] => Object.keys(table).filter((k) => k !== 'src_out_us')
export const LAYER_PARAMS_KEYS: Readonly<Record<string, readonly string[]>> = {
  Text: keysOf('Text', { content: true, font_family: true, font_size_px: true, font_weight: true, italic: true, color: true, x: true, y: true, opacity: true, rotation_deg: true, anchor_x: true, anchor_y: true, align: true, valign: true, box_w: true, box_h: true, line_height: true, letter_spacing: true, outline_width: true, outline_color: true, shadow: true, graphic_role: true, intro: true, outro: true }),
  VideoClip: keysOf('VideoClip', { crop: true, src_in_us: true, src_out_us: true, x: true, y: true, scale_x: true, scale_y: true, rotation_deg: true, anchor_x: true, anchor_y: true, opacity: true, flip_h: true, flip_v: true, fade_in_us: true, fade_out_us: true }),
  ImageOverlay: keysOf('ImageOverlay', { x: true, y: true, scale_x: true, scale_y: true, rotation_deg: true, anchor_x: true, anchor_y: true, opacity: true, fade_in_us: true, fade_out_us: true, graphic_role: true }),
  Motif: keysOf('Motif', { x: true, y: true, scale_x: true, scale_y: true, rotation_deg: true, anchor_x: true, anchor_y: true, opacity: true, src_in_us: true, motif_id: true, motif_version: true, props: true, graphic_role: true }),
  Color: keysOf('Color', { color: true, width: true, height: true }),
  Audio: keysOf('Audio', { src_in_us: true, src_out_us: true, gain_db: true, pan: true, fade_in_us: true, fade_out_us: true, mute: true, role: true }),
  CompositionRef: keysOf('CompositionRef', { src_in_us: true, src_out_us: true, x: true, y: true, scale_x: true, scale_y: true, rotation_deg: true, anchor_x: true, anchor_y: true, opacity: true, blend_mode: true }),
}
export const LAYER_PARAM_KINDS: readonly string[] = Object.keys(LAYER_PARAMS_KEYS)
/** The kinds whose patch writes `scale_x`/`scale_y` also take `scale_linked`,
 *  the Linked scale flag — not a stored param of the patch type, so it is
 *  split off by the parser and applied by the actor after the scale fields. */
const SCALE_LINK_KINDS: ReadonlySet<string> = new Set(LAYER_PARAM_KINDS.filter((k) => LAYER_PARAMS_KEYS[k]!.includes('scale_x')))
/** Every key one kind's patch accepts: its `LAYER_PARAMS_KEYS` row, plus
 *  `scale_linked` where the kind has a scale pair. */
export const layerPatchKeys = (kind: string): readonly string[] => SCALE_LINK_KINDS.has(kind) ? [...LAYER_PARAMS_KEYS[kind]!, 'scale_linked'] : LAYER_PARAMS_KEYS[kind]!
const TEXT_ALIGN_OPTIONS = ['Left', 'Center', 'Right'] as const
const VALIGN_OPTIONS = ['Top', 'Middle', 'Bottom'] as const
const BLEND_MODE_OPTIONS = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'Add', 'Difference'] as const

function parseOneOf(v: unknown, options: readonly string[], field: string): string {
  if (typeof v !== 'string' || !options.includes(v)) throw new McpArgError(`${field} must be one of ${options.join(' | ')}, got ${describeValue(v)}`, field)
  return v
}

/** One value of a kind-specific patch, gated by field name. `null` is a value
 *  only where it MEANS something — the text box pair, where it is "back to
 *  auto", `shadow`, where it is "no shadow", and `graphic_role`, where it is
 *  "untagged" — and is refused everywhere
 *  else: the wire convention is that an omitted field is left alone, so a null
 *  one is a request nothing reads. */
function parseLayerParamValue(k: string, v: unknown): unknown {
  const field = `patch.${k}`
  if (v === null) {
    if (k === 'box_w' || k === 'box_h' || k === 'shadow' || k === 'crop' || k === 'graphic_role' || k === 'intro' || k === 'outro') return null
    throw new McpArgError(`${field} is null, which is not a value for ${k} — omit the field to leave it alone`, field)
  }
  switch (k) {
    case 'crop': {
      const problem = cropProblem(v)
      if (problem) throw new McpArgError(problem, field)
      return v
    }
    case 'content': case 'font_family': case 'motif_id': return parseStr(v, field)
    case 'graphic_role': return parseGraphicRoleOpt(v, field)
    case 'intro': return parseOneOf(v, TEXT_INTROS, field)
    case 'outro': return parseOneOf(v, TEXT_OUTROS, field)
    case 'font_weight': return parseIntNum(v, field)
    case 'italic': return parseBool(v, field)
    case 'shadow': {
      const o = parseObj(v, field)
      for (const key of Object.keys(o)) if (!['color', 'offset_x', 'offset_y', 'blur'].includes(key)) throw new McpArgError(`${field}.${key} is not a shadow field — a shadow is { color, offset_x, offset_y, blur }`, field)
      return { color: parseRgba(o.color, `${field}.color`), offset_x: parseNum(o.offset_x, `${field}.offset_x`), offset_y: parseNum(o.offset_y, `${field}.offset_y`), blur: parseNum(o.blur, `${field}.blur`) }
    }
    case 'color': case 'outline_color': return parseRgba(v, field)
    case 'flip_h': case 'flip_v': case 'mute': case 'scale_linked': return parseBool(v, field)
    case 'align': return parseOneOf(v, TEXT_ALIGN_OPTIONS, field)
    case 'valign': return parseOneOf(v, VALIGN_OPTIONS, field)
    case 'blend_mode': return parseOneOf(v, BLEND_MODE_OPTIONS, field)
    case 'role': return parseRole(v)
    case 'props': return parseObj(v, field)
    case 'src_in_us': case 'src_out_us': case 'fade_in_us': case 'fade_out_us': case 'motif_version': return parseIntNum(v, field)
    default: return parseNum(v, field) // x, y, scale_x, scale_y, opacity, speed, font_size_px, line_height, letter_spacing, outline_width, gain_db, pan, width, height, box_w, box_h
  }
}

/** ADR 0049's rule for a Text layer's scale, in the words both paths refuse
 *  with — `update_layer_params` and a Static `set_param_track`: the box lays
 *  out, `scale` magnifies, and magnification is animated, never set. */
export const TEXT_SCALE_RULE = "a Text layer's static scale stays 1 — a bigger title is a bigger font_size_px or box_w (ADR 0049); animate scale with keys"

/** `update_layer_params`'s patch: `kind` names one of the seven kinds, every
 *  other key is in that kind's set, and every value is the type the kind
 *  stores. Ranges and shape rules (a positive font size, the text-box modes, a
 *  non-zero scale) stay the mutation's — it names them better than a table could. */
export function parseLayerParamsPatch(v: unknown): LayerParamsPatch & { scale_linked?: boolean } {
  const o = parseObj(v, 'patch')
  const kind = o.kind
  if (typeof kind !== 'string' || !(kind in LAYER_PARAMS_KEYS))
    throw new McpArgError(`patch.kind must be one of ${LAYER_PARAM_KINDS.join(' | ')}, got ${typeof kind === 'string' ? `'${kind}'` : describeValue(kind)} — it has to match the layer's kind, which project://tracks reports`, 'patch')
  const allowed = layerPatchKeys(kind)
  const fields = Object.keys(o).filter((k) => k !== 'kind')
  if (fields.length === 0) throw new McpArgError(`patch names no field; a ${kind} patch writes ${allowed.join(', ')}`, 'patch')
  for (const k of fields) {
    if (allowed.includes(k)) continue
    const elsewhere = Object.entries(LAYER_PARAMS_KEYS).filter(([, ks]) => ks.includes(k)).map(([kk]) => kk)
    const hint = kind === 'Text' && k.startsWith('scale_') ? ` (${TEXT_SCALE_RULE})`
      : k in LAYER_ENVELOPE_OWNER ? ` (${LAYER_ENVELOPE_OWNER[k]})`
      : k === 'src_out_us' ? ' (the window end follows src_in_us, which slips it at its length; trim_layer changes the length)'
      : elsewhere.length > 0 ? ` ('${k}' belongs to ${elsewhere.join(', ')})` : ''
    throw new McpArgError(`invalid patch: '${k}' is not a ${kind} param — a ${kind} patch writes ${allowed.join(', ')}${hint}`, 'patch')
  }
  const out: Record<string, unknown> = { kind }
  for (const k of fields) out[k] = parseLayerParamValue(k, o[k])
  if (out.scale_linked === true && typeof out.scale_x === 'number' && typeof out.scale_y === 'number' && out.scale_x !== out.scale_y)
    throw new McpArgError(`patch: scale_linked true with scale_x ${out.scale_x} and scale_y ${out.scale_y} names two scales for one link — send one axis (both take it) or equal values`, 'patch.scale_linked')
  return out as LayerParamsPatch & { scale_linked?: boolean }
}

/** `add_effect`'s kind: one of the two catalogs' (`shared/effects/params.ts`).
 *  The mutation stays permissive for a project written by a newer build (ADR
 *  0027); an agent inventing `audio.compressor` is not that case. */
export function parseEffectKind(v: unknown): string {
  if (typeof v !== 'string' || !EFFECT_KINDS.includes(v)) throw new McpArgError(`unknown effect kind ${typeof v === 'string' ? `'${v}'` : describeValue(v)} — kinds: ${EFFECT_KINDS.join(', ')}`, 'kind')
  return v
}

/** An effect param written as keyframes (`set_keyframe` / `set_param_track` on
 *  `effects[<id>].params[<key>]`): every value must sit inside the kind's
 *  catalogued range, exactly as `update_effect` refuses it — one rule whichever
 *  tool writes the param. A kind or key no catalog knows passes untouched. */
export function checkEffectParamValues(kind: string, key: string, values: readonly unknown[], field: string): void {
  const specs = effectParamSpecs(kind)
  if (specs === null || !(key in specs)) return
  const [lo, hi] = specs[key].range
  for (const value of values) {
    if (typeof value === 'number' && (value < lo || value > hi)) throw new McpArgError(`${field} ${value} is outside '${kind}'.${key}'s range [${lo}, ${hi}] — effects://catalog lists every param's range`, field)
  }
}

/** `update_effect`'s params against the effect's KIND: an unknown key or a
 *  value outside the catalogued range is refused, naming the set or the
 *  bound. A kind no catalog knows passes untouched. Called by the actor arm,
 *  which is the only place the kind is known. */
export function checkEffectPatchAgainst(kind: string, patch: EffectPatch, field = 'patch.params'): void {
  if (!patch.params) return
  const specs = effectParamSpecs(kind)
  if (specs === null) return
  for (const [k, track] of Object.entries(patch.params)) {
    if (!(k in specs)) throw new McpArgError(`invalid ${field}: '${k}' is not a param of effect kind '${kind}' — its params are ${Object.keys(specs).join(', ')}`, field)
    if (track === null) continue
    const [lo, hi] = specs[k].range
    const values = track.mode === 'Static' ? [track.value] : track.value.map((kf) => kf.value)
    for (const value of values) {
      if (value < lo || value > hi) throw new McpArgError(`invalid ${field}: ${k} ${value} is outside '${kind}'.${k}'s range [${lo}, ${hi}] — effects://catalog lists every param's range`, field)
    }
  }
}

/** `set_position`'s record, judged by the shared validator the mutation uses
 *  (`positionProblem`), so the refusal reads the same from either surface and
 *  arrives before any write. */
export function parsePosition(v: unknown, idGen: IdGen = uuidV7Gen()): Record<string, unknown> {
  const input = parseObj(v, 'position')
  authoringFields(input, input.mode === 'XY' ? ['mode', 'x', 'y'] : ['mode', 'path', 'progress'], 'position')
  let o: Record<string, unknown>
  if (input.mode === 'XY') {
    o = { mode: 'XY', x: parseLocalAnimatedF64(input.x, idGen), y: parseLocalAnimatedF64(input.y, idGen) }
  } else if (input.mode === 'Path') {
    const path = parseObj(input.path, 'position.path')
    authoringFields(path, ['nodes'], 'position.path')
    const nodes = asArray(path.nodes, 'position.path.nodes').map((raw, i) => {
      const node = parseObj(raw, `path.nodes[${i}]`)
      authoringFields(node, ['point', 'in_handle', 'out_handle', 'segment', 'tangent_mode'], `path.nodes[${i}]`)
      return { ...node, id: idGen(), in_handle: node.in_handle === undefined ? { x: 0, y: 0 } : node.in_handle,
        out_handle: node.out_handle === undefined ? { x: 0, y: 0 } : node.out_handle,
        segment: node.segment === undefined ? 'Line' : node.segment,
        tangent_mode: node.tangent_mode === undefined ? 'Corner' : node.tangent_mode }
    })
    o = { mode: 'Path', path: { nodes }, progress: parseLocalAnimatedF64(input.progress, idGen) }
  } else throw new McpArgError('position: mode must be XY or Path', 'position')
  const problem = positionProblem(o)
  if (problem !== null) throw new McpArgError(`position: ${problem}`, 'position')
  return o
}

/** An effect's params on the wire: `{ <key>: <number> }`, a static value per
 *  key — `add_effect`'s initial values and `update_effect`'s merge. `null`
 *  (update only) removes a key, back to its catalog default. An animated param
 *  is the keyframe tools' (`effects[<id>].params[<key>]`). */
function parseEffectParamValues(v: unknown, field: string, nullRemoves: boolean): Record<string, number | null> {
  const p = parseObj(v, field)
  if (Object.keys(p).length === 0) throw new McpArgError(`${field} names no param — omit it`, field)
  const out: Record<string, number | null> = {}
  for (const [k, pv] of Object.entries(p)) {
    if (pv === null && nullRemoves) { out[k] = null; continue }
    if (typeof pv === 'number' && Number.isFinite(pv)) { out[k] = pv; continue }
    const wrapped = pv !== null && typeof pv === 'object' && 'mode' in (pv as object)
    throw new McpArgError(`${field}['${k}'] must be a number${nullRemoves ? ' (or null to unset it)' : ''}, got ${describeValue(pv)}${wrapped ? ` — send the value itself, {"${k}": <number>}; animate a param with set_keyframe or set_param_track on effects[<effect_id>].params[${k}]` : ''}`, field)
  }
  return out
}

const staticEffectParams = (params: Record<string, number | null>): Record<string, Animated<number> | null> =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === null ? null : { mode: 'Static' as const, value: v }]))

/** `add_effect`'s `params`, checked against the kind it names: every key is
 *  one of the kind's and every value inside its range, before the effect is
 *  added — so the call adds the effect with these values, or nothing. */
export function parseAddEffectParams(v: unknown, kind: string): Record<string, Animated<number>> | null {
  if (v === undefined) return null
  const params = staticEffectParams(parseEffectParamValues(v, 'params', false)) as Record<string, Animated<number>>
  checkEffectPatchAgainst(kind, { params }, 'params')
  return params
}

/** Strict update_effect patch — `{ enabled?, params? }`, at least one, with
 *  params as plain numbers (`parseEffectParamValues`). Unknown keys and
 *  malformed values reject; `applyUpdateEffect` would otherwise silently skip
 *  them. A null `enabled` or `params` means nothing omission does not, so it is
 *  refused; the one null is a param's, which unsets it. */
export function parseEffectPatch(v: unknown): EffectPatch {
  const o = parseObj(v, 'patch')
  for (const k of Object.keys(o)) {
    if (k !== 'enabled' && k !== 'params')
      throw new McpArgError(`invalid patch: unknown key '${k}' — expected { enabled?: boolean, params?: { "<param>": <number> | null } }`, 'patch')
  }
  if (o.enabled === undefined && o.params === undefined) throw new McpArgError('patch names no field; update_effect writes enabled, params', 'patch')
  const out: EffectPatch = {}
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') throw new McpArgError(`invalid patch: enabled must be a boolean, got ${describeValue(o.enabled)}`, 'patch.enabled')
    out.enabled = o.enabled
  }
  if (o.params !== undefined) out.params = staticEffectParams(parseEffectParamValues(o.params, 'patch.params', true))
  return out
}

/** Strict update_marker patch — same lie-prevention as parseEffectPatch.
 *  Absent = "don't touch"; the one null is `end_t_us: null`, which turns a
 *  region back into a point. Every other field refuses null: a null that meant
 *  "leave it" would answer success for a write that wrote nothing.
 *
 *  `anchor` is absent from the accepted set on purpose and is rejected like any
 *  other unknown key: an anchor is established only by the dedicated
 *  attach/detach ops, which is what keeps the pair (`anchor`, `t_us`) from ever
 *  being written apart (see `MarkerPatch`). */
const MARKER_PATCH_KEYS: readonly string[] = ['t_us', 'end_t_us', 'label', 'note', 'color']
export function parseMarkerPatch(v: unknown): MarkerPatch {
  const o = parseObj(v, 'patch')
  const keys = Object.keys(o)
  if (keys.length === 0) throw new McpArgError(`patch names no field; update_marker writes ${MARKER_PATCH_KEYS.join(', ')}`, 'patch')
  for (const k of keys) {
    if (!MARKER_PATCH_KEYS.includes(k))
      throw new McpArgError(`invalid patch: unknown key '${k}' — expected { t_us?, end_t_us?, label?, note?, color? }`, 'patch')
  }
  const out: MarkerPatch = {}
  if ('t_us' in o) out.t_us = parseNum(o.t_us, 'patch.t_us')
  if ('end_t_us' in o) out.end_t_us = o.end_t_us === null ? null : parseNum(o.end_t_us, 'patch.end_t_us')
  if ('label' in o) out.label = parseStr(o.label, 'patch.label')
  if ('note' in o) out.note = parseStr(o.note, 'patch.note')
  if ('color' in o) out.color = parseRgba(o.color, 'patch.color')
  return out
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
  'shot_review', 'pause_review',
])
export function parseProjectSettingsPatch(v: unknown): Record<string, unknown> {
  const patch = parseObj(v, 'patch')
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new McpArgError('patch names no setting; a call that changes nothing would still report success', 'patch')
  for (const k of keys) {
    if (k === 'correction_script') throw new McpArgError("correction_script is not an MCP setting — pass the transcript to correct_caption_text { script }", 'patch')
    if (!PROJECT_SETTINGS_KEYS.has(k)) throw new McpArgError(`unknown setting '${k}'; set_project_settings writes ${[...PROJECT_SETTINGS_KEYS].join(', ')}`, 'patch')
  }
  const out: Record<string, unknown> = {}
  if ('auto_pair_audio_on_import' in patch) out.auto_pair_audio_on_import = parseBoolTriState(patch.auto_pair_audio_on_import, 'auto_pair_audio_on_import')
  if ('prefer_proxies' in patch) out.prefer_proxies = parseBoolTriState(patch.prefer_proxies, 'prefer_proxies')
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
  if ('shot_review' in patch) out.shot_review = patch.shot_review === null ? null : parseObj(patch.shot_review, 'shot_review')
  if ('pause_review' in patch) out.pause_review = patch.pause_review === null ? null : (() => {
    const o = parseObj(patch.pause_review, 'pause_review')
    strictKeys(o, ['threshold_db', 'min_pause_us', 'pad_us'], 'pause_review', { threshold_amp: 'send threshold_db (dBFS)' })
    const db = parseNum(o.threshold_db, 'pause_review.threshold_db')
    if (!(db <= 0)) throw new McpArgError(`pause_review.threshold_db ${db} must be at or below 0 dBFS`, 'pause_review.threshold_db')
    return { threshold_amp: pauseAmpFromDb(db), min_pause_us: o.min_pause_us, pad_us: o.pad_us }
  })()
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

/** An array that NAMES a set: empty is refused, since a call over no members
 *  would report success for nothing done. `orElse` says what to send instead. */
export function asNonEmptyArray(v: unknown, field: string, orElse: string): string[] {
  const arr = asArray(v, field)
  if (arr.length === 0) throw new McpArgError(`${field} names nothing — ${orElse}`, field)
  return arr
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
 *  returned real DateTime<Utc> (e.g. a checkpoint's created_at), so the
 *  harness sentinel must not leak to MCP agents. The differential gate compares
 *  via its own canonicalize() of both sides, so this stays green. */
export function toolJson(v: unknown): ToolResultJson { return { content: [{ type: 'text', text: JSON.stringify(sortKeys(v)) }] } }

/** get_param_track's answer: `track` in exactly `set_param_track`'s write
 *  shape — Static `{mode, value}`, or Keyframed `{mode, value: [{t_us
 *  (timeline-absolute = local + t_start), value, time_fraction?, in, out,
 *  continuity, segment}], extrapolate}` — so a read-edit-write round trip sends
 *  it back unchanged. What the write does not take rides beside it, parallel to
 *  the keys: `keyframe_ids`, `local_t_us` (the stored base) and `preset_ids`, the
 *  exact-match reverse lookup of the segment LEAVING each key (this key's
 *  segment + out, the next key's in) against the canonical easing table — null
 *  for a hand-tuned curve and for the last key. Caller wraps in toolJson. */
export function shapeGetParamTrack<T>(track: Animated<T>, tStartUs: number): Record<string, unknown> {
  if (track.mode === 'Static') return { track: { mode: 'Static', value: track.value }, keyframe_ids: [], local_t_us: [], preset_ids: [] }
  const keys = track.value
  return {
    track: {
      mode: 'Keyframed', extrapolate: track.extrapolate,
      value: keys.map((k) => ({
        t_us: k.t_us + tStartUs, value: k.value,
        ...(k.time_fraction === undefined ? {} : { time_fraction: k.time_fraction }),
        in: k.in, out: k.out, continuity: k.continuity, segment: k.segment,
      })),
    },
    keyframe_ids: keys.map((k) => k.id),
    local_t_us: keys.map((k) => k.t_us),
    preset_ids: keys.map((k, i) => { const next = keys[i + 1]; return next === undefined ? null : presetIdForSegment(k, next) ?? null }),
  }
}

/** The remedy a ripple refusal offers depends on WHICH tool rippled: only
 *  `delete_layers` and `move_layers` have a `layer_ids` to widen or narrow;
 *  `shift_layers` closes a span it was given by one edge and a length, and
 *  `remove_pauses` cuts spans it computed. One sentence for all four would send
 *  three of them chasing a parameter they do not have. */
const RIPPLE_TOOL = { deleteLayers: 'delete_layers', move: 'move_layers', shift: 'shift_layers', pauses: 'remove_pauses' } as const
function rippleRemedy(tool: string | undefined, layer: string, widen: string, narrow: string): string {
  if (tool === RIPPLE_TOOL.shift) return `move_layers or delete_layers ${layer} first so the span closes clean, or shift by less so the span starts after it`
  if (tool === RIPPLE_TOOL.move) return `add ${layer} to layer_ids so it moves with the set, or move without insert`
  if (tool === RIPPLE_TOOL.pauses) return `move_layers or delete_layers ${layer} first, or cut the pauses with a narrower window (this tool has no layer set to widen)`
  if (tool === RIPPLE_TOOL.deleteLayers || tool === undefined) return `${widen}; or ${narrow}`
  return `move_layers or delete_layers ${layer} first`
}
const hasLayerSet = (tool: string | undefined): boolean => tool === RIPPLE_TOOL.deleteLayers || tool === RIPPLE_TOOL.move || tool === undefined

/** The animatable param keys, per kind — what `set_keyframe` and friends may
 *  name. Stated as data here for the `UnknownKeyframeParam` arm, which has no
 *  layer in hand and so lists every kind's set. */
const KEYFRAME_PARAM_KEYS = `visual kinds (VideoClip, ImageOverlay, Text, Motif, CompositionRef): x, y (or path_progress in Path mode), scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity; Text and Color: color; Audio: gain_db, pan; an effect param: effects[<effect_id>].params[<key>], a key of its kind in effects://catalog (unset, it reads as the catalog default)`

/** CommandError → MCP error JSON. Every variant has an arm: a refusal names the
 *  id or field it could not honour, the read that lists valid ones, and the
 *  next call — the bare variant name is never the message. `tool` is the MCP
 *  tool that raised it, for the refusals
 *  whose remedy differs per tool (the ripple family). The structured `data`
 *  mirrors the same facts for clients that forward it. */
export function mapCommandError(e: CommandError, tool?: string): McpToolErrorJson {
  const out = commandErrorArm(e, tool)
  // Every refusal names its variant in `error` (docs/mcp.md § Error model):
  // an arm that wrote prose only gets the variant here, so no arm can forget it.
  const data = out.data !== null && typeof out.data === 'object' && !Array.isArray(out.data) ? out.data as Record<string, unknown> : {}
  if (typeof data.error === 'string') return out
  const variant = e.error === 'ValidationFailed' ? { error: 'ValidationFailed', rule: e.detail.rule } : { error: e.error }
  return { ...out, data: { ...variant, ...data } }
}

/** A `RetimeRejected` reason as the one sentence that names its remedy. */
function retimeRefusal(r: Record<string, unknown>): string {
  const rate = (v: unknown) => { const t = v as { num?: number; den?: number } | null; return t && typeof t.num === 'number' ? `${t.num}/${t.den}` : String(v) }
  switch (r.kind) {
    case 'EmptyTargets': return 'retime_layers needs at least one layer id in layer_ids'
    case 'LayerMissing': return `layer ${String(r.layer_id)} not found — project://tracks lists the current layers`
    case 'Locked': return `layer ${String(r.layer_id)} is locked, or sits on a locked track; unlock it (set_layer_flags { layer_ids, locked: false } or set_track_flags) and retry`
    case 'UnsupportedContent': return `layer ${String(r.layer_id)} has no timed content to retime — only VideoClip, Audio, Motif, Group and animated image layers have a playback rate`
    case 'NestedTargets': return `layer ${String(r.descendant_id)} sits inside Group ${String(r.ancestor_id)}, which is also selected; retiming the Group already retimes it — drop one of the two from layer_ids`
    case 'InvalidSnapshot': return `layer ${String(r.layer_id)} has a span or timing the retime planner cannot read; read project://layers/${String(r.layer_id)} and retry, or report it`
    case 'InvalidTarget': return 'the target is not a usable rate or duration: send { kind: "Rate", value: { num, den } } with a positive reduced rational, or { kind: "Duration", duration_us } with a positive integer'
    case 'Numeric': return `the rate arithmetic failed (${String(r.reason)}): the requested rate or duration is too extreme to represent exactly — choose a simpler rational rate`
    case 'DurationTooShort': return `layer ${String(r.layer_id)} would be shorter than one grid step at that rate — choose a slower rate or a longer duration`
    case 'Transition': return `transition ${String(r.transition_id)} touches a selected layer, and its overlap must stay exactly its duration, which this retime would change — delete_transition it, retime, then add_transition again`
    case 'Collision': {
      const fit = typeof r.maximum_duration_us === 'number'
        ? `; at most ${r.maximum_duration_us} µs fits (a rate of at least ${rate(r.minimum_rate)})`
        : '; no slower duration fits where it starts'
      return `layer ${String(r.layer_id)} would grow onto layer ${String(r.blocking_layer_id)} on its track${fit} — move_layers ${String(r.blocking_layer_id)} out of the way first, or retime to a duration that fits`
    }
    default: return `retime refused (${Object.entries(r).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')})`
  }
}

function commandErrorArm(e: CommandError, tool?: string): McpToolErrorJson {
  if (e.error === 'InvalidArgument') return { code: 'invalid_params', message: `${e.field}: ${e.detail}` }
  if (e.error === 'Backend') return { code: 'internal', message: e.detail }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'LayerOverlap') {
    const d = e.detail
    // The full cause + options go into the MESSAGE, not only `data`: MCP
    // clients (Claude Code verified against the hero-capture traces) surface
    // only `code: message` to the model and drop `error.data`, so a bare
    // 'layer overlap' left agents blind-retrying.
    //
    // Options are VALIDATED against the geometry: trimming the
    // blocker's tail back to the request's start only helps when the request
    // starts inside the blocker; when it starts at or before the blocker, the
    // blocker's HEAD is what moves; a split needs a cut strictly inside. Each
    // emitted option would succeed as written.
    const requestStartsInside = d.a_start < d.b_start && d.b_start < d.a_end
    const requestCoversHead = d.b_start <= d.a_start && d.a_start < d.b_end && d.b_end < d.a_end
    const prose: string[] = [`create_new_track and retry there`, `move_layers ${d.a} elsewhere`]
    const options: Array<Record<string, unknown>> = [
      { action: 'create_new_track', kind: 'Video' },
      { action: 'move_layers', layer_id: d.a },
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
  if (e.error === 'CompositionNotFound') return { code: 'invalid_params', message: `composition ${e.composition} not found — project://compositions lists every composition with its id and ref_count; omit composition_id for the root`, data: { error: 'CompositionNotFound', composition: e.composition } }
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
  // ── Ripple delete (docs/features.md#ripple-delete). Each message spells the
  // span as [s, e) µs — the hole is the deleted layer's footprint clipped to
  // its neighbours, not its length, so an agent that assumed the length would
  // otherwise read the refusal against the wrong numbers. Every one is
  // pre-write: the retry costs nothing. ──
  if (e.error === 'RippleInsideHole') {
    const verb = tool === RIPPLE_TOOL.pauses ? 'the pause cut' : tool === RIPPLE_TOOL.shift ? 'the shift' : tool === RIPPLE_TOOL.move ? 'the insert move' : 'ripple delete'
    const remedy = rippleRemedy(tool, e.layer,
      `add ${e.layer} to layer_ids, so its own hole merges into this one and both close in a single ripple`,
      `call delete_layers without ripple (its default), which removes the layers and leaves the span open`)
    return { code: 'invalid_params', message: `layer ${e.layer} starts inside the span [${e.hole.s}, ${e.hole.e}) µs that ${verb} would close, and the span has to come out clean. Nothing was changed. Options: ${remedy}. A layer that merely reaches into the span from before ${e.hole.s} is anchored ahead of the cut and does not block.`, data: {
      error: 'RippleInsideHole', layer: e.layer, hole_us: [e.hole.s, e.hole.e], tool: tool ?? null,
      options: tool === RIPPLE_TOOL.deleteLayers || tool === undefined
        ? [{ action: 'add_to_set_then_retry', layer_ids: [e.layer] }, { action: 'delete_without_ripple', tool: 'delete_layers', ripple: false }]
        : tool === RIPPLE_TOOL.move
          ? [{ action: 'add_to_set_then_retry', layer_ids: [e.layer] }, { action: 'move_without_insert', tool: 'move_layers', insert: false }]
          : [{ action: 'move_or_delete_first', layer_id: e.layer }],
    } }
  }
  if (e.error === 'RippleCollision') {
    const narrow = tool === RIPPLE_TOOL.deleteLayers || tool === undefined ? ', or narrow layer_ids so the span it closes is shorter' : tool === RIPPLE_TOOL.shift ? ', or shift by less' : ''
    return { code: 'invalid_params', message: `layer ${e.moving} would shift left onto layer ${e.blocking} on track ${e.track}: a ripple never makes room, so move_layers or delete_layers ${e.blocking} first${narrow}. Nothing was changed. A transition's overlap is authorized only while both its participants shift by the same amount.`, data: {
      error: 'RippleCollision', moving: e.moving, blocking: e.blocking, track: e.track, tool: tool ?? null,
    } }
  }
  if (e.error === 'RippleLinkStraddles') {
    const widen = hasLayerSet(tool) ? '; or add the straddling members to layer_ids so the whole link goes with the cut' : ''
    return { code: 'invalid_params', message: `link ${e.link} has members on both sides of the span [${e.hole.s}, ${e.hole.e}) µs — one reaches across the span's start, another starts at or after its end — and a link means those layers move together, so shifting only the downstream half is not on offer (a member that ends at or before the span is wholly upstream and does not count). Nothing was changed. Options: dissolve the link (delete_link ${e.link}) or drop the downstream member from it (update_link) and retry${widen}.`, data: {
      error: 'RippleLinkStraddles', link: e.link, hole_us: [e.hole.s, e.hole.e], tool: tool ?? null,
      options: [{ action: 'unlink_then_retry', link_id: e.link }],
    } }
  }
  if (e.error === 'RippleLockedLayer') {
    const narrow = tool === RIPPLE_TOOL.deleteLayers || tool === undefined ? `, or narrow layer_ids so nothing downstream of ${e.layer} is removed` : ''
    return { code: 'invalid_params', message: `layer ${e.layer} is locked and would have to move: a ripple shifts everything that starts at or after the span it closes or opens. Unlock it (set_layer_flags { layer_ids: ["${e.layer}"], locked: false }) and retry${narrow}. Nothing was changed. Only a layer that actually shifts blocks — a locked layer upstream of the cut is fine.`, data: {
      error: 'RippleLockedLayer', layer: e.layer, tool: tool ?? null,
    } }
  }
  // ── Gap closing (docs/features.md#ripple-delete). The span is echoed because
  // the fix is to re-read the track and send the gap as it is NOW: either a
  // layer has reached into the span since it was measured, or an edge is not a
  // layer boundary. ──
  if (e.error === 'GapNotFound') {
    return { code: 'invalid_params', message: `[${e.s}, ${e.e}) µs is not a gap on track ${e.track}: a gap is the WHOLE empty span between two layer boundaries on one track — end_us exactly where a layer starts, start_us exactly where one ends (or 0) — with no layer reaching into it. Re-read the track (project://compositions) and send the gap as it is now; the space after the last layer on a track is not a gap.`, data: {
      error: 'GapNotFound', track: e.track, span_us: [e.s, e.e],
      options: [{ action: 'reread_then_retry', resource: 'project://compositions' }],
    } }
  }
  // ── Groups (ADR 0052). Each message says what was refused AND why, because the
  // client drops `data` and the fix differs per cause. ──
  if (e.error === 'LayerLocked') return { code: 'invalid_params', message: `layer ${e.layer} is locked. Unlock it with set_layer_flags { layer_ids: ["${e.layer}"], locked: false } before editing. Nothing was changed.`, data: { error: e.error, layer: e.layer } }
  if (e.error === 'GroupLockedMember') return { code: 'invalid_params', message: `layer ${e.layer} is locked: pre-compose and add-to-Group move every selected layer or none. Unlock it (set_layer_flags { layer_ids, locked: false }) or leave it out of layer_ids` }
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
    return { code: 'invalid_params', message: `effect ${e.effect} param '${e.param}' belongs to an audio.* effect, whose params are STATIC ONLY: an audio effect is a whole-clip offline bake, so there is no per-frame value to animate. Send it with update_effect as {"params": {"${e.param}": <number>}}; set_keyframe and a Keyframed set_param_track are refused on it`, data: {
      error: 'AudioEffectParamStatic', effect: e.effect, param: e.param,
    } }
  }
  // ── Every remaining variant, one arm each: the id, the field, the read that
  // lists valid ones, the next call. The order follows the union in
  // shared/commandErrors.ts; `mcp.error-vocabulary` enumerates the vocabulary
  // so a new variant cannot fall through to a bare name. ──
  switch (e.error) {
    case 'ShiftLinkStraddles':
      return { code: 'invalid_params', message: `link ${e.link} has a member starting before ${e.from_t_us} µs and another at or after it: a sweep from that time would move one and not the other, slipping their sync. Move the whole link with move_layers { layer_ids }, or pick a from_t_us that does not split the link; project://links lists its members`, data: { error: 'ShiftLinkStraddles', link: e.link, from_t_us: e.from_t_us } }
    case 'RetimeRejected': return { code: 'invalid_params', message: `${retimeRefusal(e.reason)}. Nothing was changed`, data: { error: e.error, ...e.reason } }
    case 'TrackNotFound':
      return { code: 'invalid_params', message: `track ${e.track} not found — project://tracks lists the current tracks; a track disappears when its last layer leaves it, so an id read before a delete or a move may be gone` }
    case 'LayerNotFound':
      return { code: 'invalid_params', message: `layer ${e.layer} not found — it may have been deleted, split (the right half carries a new id) or pruned with its track; project://tracks lists the current layers, and every mutator's answer carries the ids it minted` }
    case 'MarkerNotFound':
      return { code: 'invalid_params', message: `marker ${e.marker} not found — project://markers lists the composition's markers (add composition=<id> for a Group's)` }
    case 'TransitionNotFound':
      return { code: 'invalid_params', message: `transition ${e.transition} not found — the composition's \`transitions\` in project://current list them; deleting either participant removes its transition` }
    case 'TransitionLayersNotAdjacent':
      return { code: 'invalid_params', message: `layers ${e.from} (outgoing) and ${e.to} (incoming) are not adjacent on one track: the outgoing layer must END exactly where the incoming one STARTS, on the same track (or already overlap by exactly ${e.duration} µs to attach as-is). move_layers / trim_layer them to meet, then retry; project://tracks shows both spans`, data: { error: 'TransitionLayersNotAdjacent', from: e.from, to: e.to, duration_us: e.duration } }
    case 'CheckpointNotFound':
      return { code: 'invalid_params', message: `checkpoint ${e.checkpoint} not found — project://history lists the checkpoints of this opening (opening a project or quitting drops them; a deleted one's id is gone for good)` }
    case 'MediaNotFound':
      return { code: 'invalid_params', message: `media ${e.media} not found — project://media lists the pool; import_media adds a file and answers its media_id` }
    case 'TrackPositionOutOfRange':
      return { code: 'invalid_params', message: `new_position ${e.position} is out of range for a stack of ${e.len} track(s): positions run 0..${Math.max(0, e.len - 1)}, 0 being the bottom`, data: { error: 'TrackPositionOutOfRange', position: e.position, len: e.len } }
    case 'TrackNotEmpty':
      return { code: 'invalid_params', message: `track ${e.track} still holds layers: delete_track { track_id, force: true } deletes them with it, or move_layers / delete_layers them first. Nothing was removed` }
    case 'TrackReserved':
      return { code: 'invalid_params', message: `track ${e.track} is a reserved A roll / B roll track and keeps its place in the stack; move the other tracks around it (move_track), or restack a visual layer against it (restack_layer). Nothing was moved`, data: { error: 'TrackReserved', track: e.track } }
    case 'TrackNotRemovable':
      return { code: 'invalid_params', message: `track ${e.track} is a reserved A roll / B roll track and is never removed; its layers can be — delete_layers them, and the track stays empty` }
    case 'TrackLocked':
      return { code: 'invalid_params', message: `track ${e.track} is locked and refuses edits to the layers on it (a locked track blocks the WHOLE batch it appears in). set_track_flags { track_id: "${e.track}", locked: false } clears it; a layer's own \`locked\` is separate (set_layer_flags)`, data: { error: 'TrackLocked', track: e.track, options: [{ action: 'unlock_track', tool: 'set_track_flags', track_id: e.track, locked: false }] } }
    case 'SplitOutsideLayer':
      return { code: 'invalid_params', message: `split at ${e.at_t} µs is outside layer ${e.layer}: at_t_us must be strictly inside the layer's span (t_start_us, t_end_us) — project://layers/${e.layer} has the span. Nothing was split`, data: { error: 'SplitOutsideLayer', layer: e.layer, at_t_us: e.at_t } }
    case 'LinkLockedMember':
      return { code: 'invalid_params', message: `layer ${e.touched} moves with link ${e.link}, whose member ${e.locked_layer} is locked, so the whole link refuses. Unlock it (set_layer_flags { layer_ids: ["${e.locked_layer}"], locked: false }) or pass escape_link: true to move ${e.touched} alone`, data: { error: 'LinkLockedMember', link: e.link, locked_layer: e.locked_layer, touched: e.touched } }
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
      // The lock belongs to the work session that took it, so no option here
      // unlocks it: the MCP host adds the holder, and the unlock only for the
      // caller that holds it (`server.ts`, `historyLockedRefusal`).
      return { code: 'invalid_request', message: `history is locked: ${e.reason}. undo, redo, jump_to and restore_checkpoint are blocked while the work session that locked it runs; edits still record. Wait for that session to end, or ask the user (the Agent panel's Unlock clears it)`, data: { error: 'HistoryLocked', reason: e.reason, options: [{ action: 'wait_for_session_end' }, { action: 'ask_user' }] } }
    case 'EmptyKeyframeTrack':
      return { code: 'invalid_params', message: `param '${e.param_key}' on layer ${e.layer} is Keyframed with no keys — a track needs at least one; set_keyframe adds one, set_param_track {"mode":"Static","value":v} holds one value`, data: { error: 'EmptyKeyframeTrack', layer: e.layer, param_key: e.param_key } }
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
      // know yet, which the vocabulary gate (`mcp.error-vocabulary`) is there to catch.
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
 *  can never disagree about which calls commit (a regex over tool names would
 *  be a second list that knows nothing the table does not). The spec's defaults are `readOnlyHint: false`, `destructiveHint: true`,
 *  `idempotentHint: false`; each constant states only what differs from them,
 *  and every def carries one, which the type enforces. */
export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
// `openWorldHint: false` on every TS tool: they act on this machine's project
// only (the spec's default is true). The tools that may reach a cloud engine
// are Rust's (transcribe, describe, synthesize) and say so there.
/** A read: commits nothing; the agent panel folds it as a quick read. */
export const ANN_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }
/** A write that creates or shifts — calling it twice does it twice. */
export const ANN_WRITE: ToolAnnotations = { destructiveHint: false, openWorldHint: false }
/** A write that sets state — the same call twice leaves the same state. */
export const ANN_SET: ToolAnnotations = { destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** A write that removes or reverts: what it takes away, undo (or a checkpoint) is the way back to. */
export const ANN_DESTRUCTIVE: ToolAnnotations = { destructiveHint: true, openWorldHint: false }

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  exec: 'table' | 'dedicated'
  annotations: ToolAnnotations
  parseArgs?: (a: Record<string, unknown>, idGen?: IdGen) => { op: string; args: Record<string, unknown> }  // table-exec only
  parseDedicated?: (a: Record<string, unknown>, idGen?: IdGen) => Record<string, unknown>                    // dedicated-exec only
}

// ── Shared schema fragments ──────────────────────────────────────────────────
// Every advertised property MUST carry a "type": MCP clients (Claude Code
// verified) coerce untyped fields to `type: string`, which FORCES the model to
// send nested payloads as JSON-encoded strings no matter how it is prompted —
// the server then rejects or, worse, silently ignores them.
// mcp.catalog-bijection.test.ts gates this catalog-wide.
// ── Property schemas carry their meaning ────────────────────────────────────
// Every advertised property has a one-line description with its unit, so an
// agent learns a field from the schema rather than from ten or twenty failed
// calls. `mcp.description-budget` counts the properties that do not. Ids and
// times recur on most tools, so they are minted here once; a `null` arm is
// advertised only where null MEANS something omission does not (clear a label,
// unpin a duration, return a text box axis to auto) — an optional field is
// simply not required.
const ID_SCHEMA = (what: string) => ({ type: 'string', description: `${what} id.` })
const LAYER_ID_SCHEMA = ID_SCHEMA('Layer')
const TRACK_ID_SCHEMA = ID_SCHEMA('Track')
const LAYER_IDS_SCHEMA = (what: string) => ({ type: 'array', items: { type: 'string' }, description: what })
const US_SCHEMA = (what: string) => ({ type: 'integer', description: `${what}, µs.` })
const T_START_SCHEMA = US_SCHEMA('Timeline start')
const SRC_IN_SCHEMA = US_SCHEMA('Source in point')
const ESCAPE_LINK_SCHEMA = { type: 'boolean', description: 'Act on this layer alone, leaving its link partners in place. Default false.' }
const RGBA_SCHEMA = { type: 'object', description: 'Colour, integer channels 0..255.', properties: { r: { type: 'integer', description: 'Red 0..255.' }, g: { type: 'integer', description: 'Green 0..255.' }, b: { type: 'integer', description: 'Blue 0..255.' }, a: { type: 'integer', description: 'Alpha 0..255; 255 opaque.' } }, required: ['r', 'g', 'b', 'a'] }
// What the layer is for. Any well-formed name is stored; one outside the
// built-ins is a custom role the project's taste should declare (lint, not here).
// A null arm only where null differs from omission: the patch (clears).
const GRAPHIC_ROLE_SCHEMA = { type: 'string', pattern: GRAPHIC_ROLE_PATTERN.source, description: `What the layer is for: ${BUILTIN_GRAPHIC_ROLES.join(', ')}, or a custom name.` }
// The composition scope (ADR 0052): the tools that CREATE take it to say where,
// and the caption tools that address a composition's captions as a body take it
// to say which. Every layer-addressed tool derives its composition from the
// layer id — an agent editing inside a Group never names the Group. Two
// spellings of one optional field: the second for a read or an edit over
// existing captions. (`add_layers` spells its own: a spawn target, and a
// cross-check for a layer that names its track.)
const COMPOSITION_ID_SCHEMA = { type: 'string', description: 'Composition to create in — a Group\'s id from `project://compositions`; omit for the root.' }
const CAPTIONS_COMPOSITION_ID_SCHEMA = { type: 'string', description: 'Composition whose captions are meant — a Group\'s id from `project://compositions`; omit for the root.' }
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
// The one easing vocabulary: a preset, or a raw kind. `required` is empty —
// the two forms share no mandatory field; the exactly-one-of rule is
// parseEasing's. The preset enum derives from the canonical table, so the
// advertised ids can never drift from what bakes.
const EASE_PARAM_SCHEMAS = {
  dir: { type: 'string', enum: ['In', 'Out', 'InOut'], description: 'Elastic/Bounce only: easing direction.' },
  amplitude: { type: 'number', description: `Elastic only: overshoot amplitude, >= 1. Omit for the default ${ELASTIC_DEFAULT_AMPLITUDE}.` },
  period: { type: 'number', description: `Elastic only: oscillation period, > 0. Omit for the default ${ELASTIC_DEFAULT_PERIOD}.` },
}
const EASING_SCHEMA = {
  type: 'object',
  description: 'Easing of the segment leaving the key (on the last key, the one arriving at it): {"preset":"<id>"} or a raw {"kind":...}. Writes this key\'s out/segment and the next key\'s in.',
  properties: {
    preset: { type: 'string', enum: EASING_PRESETS.map((p) => p.id), description: 'Preset id from the canonical easing table (e.g. "ease_in_out", "ease_out_expo"); read back in preset_ids.' },
    kind: { type: 'string', enum: ['Hold', 'Linear', 'Bezier', 'Elastic', 'Bounce'], description: 'A raw easing kind, instead of a preset.' },
    p1: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Bezier only: first control point [x, y]; x within [0, 1].' },
    p2: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Bezier only: second control point [x, y]; x within [0, 1].' },
    ...EASE_PARAM_SCHEMAS,
  },
  required: [],
}
const TANGENT_SCHEMA = {
  type: 'object',
  description: 'One side of a key: {x, y} in the owning segment\'s unit square (x = fraction of its time span, y of its value span), plus `mode` — "Auto" (solved on every write; x/y may be omitted) or "Free" (authored). `in` is stored un-mirrored.',
  properties: {
    x: { type: 'number', description: "Fraction of the segment's time span, 0..1." },
    y: { type: 'number', description: "Fraction of the segment's value span; may overshoot." },
    mode: { type: 'string', enum: ['Auto', 'Free'], description: 'Auto: solved on every write. Free: as authored.' },
  },
  required: ['mode'],
}
const SEGMENT_SCHEMA = {
  type: 'object',
  description: 'Class of the segment LEAVING the key: Spline (reads the tangents) | Hold | Linear | Elastic (dir, amplitude?, period?) | Bounce (dir).',
  properties: {
    kind: { type: 'string', enum: ['Spline', 'Hold', 'Linear', 'Elastic', 'Bounce'], description: 'Class of the segment leaving the key; only Spline reads the tangents.' },
    ...EASE_PARAM_SCHEMAS,
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
const EXTRAPOLATION_SCHEMA = {
  type: 'object',
  description: 'Outside the keys, per side: Hold (end value) | Loop (repeat from the first key) | PingPong | Offset (each cycle adds last − first) | Continue (end velocity). Period = last − first; path_progress takes Hold/Loop/PingPong.',
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
            t_us: US_SCHEMA('Key time, timeline'), value,
            easing: { type: 'object', description: 'As set_keyframe\'s `easing`: {"preset":"<id>"} or a raw {"kind":...}; replaces this key\'s out/segment and the next key\'s in.' },
            time_fraction: { type: 'object', description: 'Optional exact sub-microsecond remainder; keeps retimed keys unsnapped.', properties: { num: { type: 'integer', description: '0 <= num < den.' }, den: { type: 'integer', description: 'Positive denominator; reduced fraction.' } }, required: ['num', 'den'], additionalProperties: false },
            in: { ...TANGENT_SCHEMA, description: 'Optional arriving tangent; defaults to identity, Free.' }, out: { ...TANGENT_SCHEMA, description: 'Optional leaving tangent; defaults to identity, Free.' },
            continuity: { type: 'string', enum: ['Smooth', 'Broken'], description: 'Defaults to Broken. Smooth keeps both Free sides at equal slopes on write.' },
            segment: { ...SEGMENT_SCHEMA, description: SEGMENT_SCHEMA.description + ' Defaults to Linear.' },
          },
          required: ['t_us', 'value'],
          additionalProperties: false,
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
// Explicit object items prevent clients from inferring arrays of strings.
// Advanced curve records use set_param_track's shape, without repeating their
// nested schemas three times in the position tool's catalog entry.
const SCALAR_TRACK_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['Static', 'Keyframed'], description: 'Static number or animated keys.' },
    value: { type: ['number', 'array'], description: 'Number, or keys with generated IDs (omit id).', items: {
      type: 'object', properties: {
        local_t_us: { type: 'integer', description: 'Layer-local key time, µs.' },
        value: { type: 'number', description: 'Scalar value.' },
        in: { type: 'object', description: 'Arriving {x,y,mode}; defaults to identity/Free.' },
        out: { type: 'object', description: 'Leaving {x,y,mode}; defaults to identity/Free.' },
        continuity: { type: 'string', enum: ['Smooth', 'Broken'], description: 'Defaults to Broken.' },
        segment: { type: 'object', description: '{kind,...} from set_param_track; defaults to Linear.' },
      }, required: ['local_t_us', 'value'], additionalProperties: false,
    } },
    extrapolate: { type: 'object', description: 'Optional {before,after}: Hold/Loop/PingPong/Offset/Continue; Path progress allows the first three. Defaults to Hold/Hold.' },
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
        point: { ...POINT_SCHEMA, description: 'Anchor point, composition px.' },
        in_handle: HANDLE_SCHEMA('Arriving'), out_handle: HANDLE_SCHEMA('Leaving'),
        segment: { type: 'string', enum: ['Line', 'Cubic'], description: 'Span LEAVING this node; defaults to Line. Cubic reads the handles.' },
        tangent_mode: { type: 'string', enum: ['Corner', 'Smooth', 'Auto'], description: 'Defaults to Corner. Smooth aligns handles; Auto solves from neighbours.' },
      },
      required: ['point'],
      additionalProperties: false,
    } } }, required: ['nodes'] },
    progress: { ...SCALAR_TRACK_SCHEMA, description: 'Path mode: distance along the route, 0..1 (Hold / Loop / PingPong extrapolation only).' },
  },
  required: ['mode'],
  oneOf: [
    { properties: { mode: { const: 'XY', description: 'XY needs both tracks.' } }, required: ['mode', 'x', 'y'] },
    { properties: { mode: { const: 'Path', description: 'Path needs the route and its progress.' } }, required: ['mode', 'path', 'progress'] },
  ],
}

/** `param_key`: the animatable params by name, or an effect param by path.
 *  Advertised as an enum plus a pattern so a typo is caught at the schema; the
 *  per-kind rule (a Text layer has no `scale_x`) stays the parser's
 *  (`UnknownKeyframeParam`), which names the layer's own set. */
export const PARAM_KEYS = ['x', 'y', 'path_progress', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y', 'opacity', 'color', 'gain_db', 'pan'] as const
export const EFFECT_PARAM_KEY_PATTERN = '^effects\\[[0-9a-fA-F-]{36}\\]\\.params\\[[A-Za-z0-9_]+\\]$'
const PARAM_KEY_SCHEMA = {
  type: 'string',
  description: 'Visual: x/y (XY), path_progress (Path), scale_x, scale_y, rotation_deg, anchor_x, anchor_y, opacity; Text/Color: color; Audio: gain_db, pan; effects[<effect_id>].params[<key>].',
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
  x: { type: 'number', description: "The anchor point's x, composition px: the centre unless anchor_x moves it. Refused in Path mode: translate_position / set_position." },
  y: { type: 'number', description: "The anchor point's y, composition px (refused in Path mode)." },
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
  src_in_us: { type: 'integer', description: 'Source in point, µs — a slip: the window moves and keeps its length, so the span is unchanged. Its end follows; change the length with trim_layer.' },
  scale_x: { type: 'number', description: 'Horizontal scale factor; 1 = native size.' },
  scale_y: { type: 'number', description: 'Vertical scale factor; 1 = native size.' },
  scale_linked: { type: 'boolean', description: 'After the scale fields: true links the pair, copying the scale_x track onto scale_y (destructive to an animated scale_y); false unlinks.' },
  rotation_deg: { type: 'number', description: 'Rotation, degrees clockwise.' },
  anchor_x: { type: 'number', description: 'Anchor (pivot), fraction of the width: 0 left, 0.5 centre (default), 1 right.' },
  anchor_y: { type: 'number', description: 'Anchor (pivot), fraction of the height: 0 top, 0.5 centre (default), 1 bottom.' },
  crop: { type: ['object', 'null'], description: 'Static retained source rectangle in normalized 0..1 coordinates, before transform. x/y are top-left; w/h positive, contained in source. Null resets. Does not change scale or position.', properties: { x: { type: 'number', minimum: 0, maximum: 1, description: 'Left.' }, y: { type: 'number', minimum: 0, maximum: 1, description: 'Top.' }, w: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Width.' }, h: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Height.' } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false },
  flip_h: { type: 'boolean', description: 'Mirror horizontally.' },
  flip_v: { type: 'boolean', description: 'Mirror vertically.' },
  fade_in_us: US_SCHEMA('Fade-in length'),
  fade_out_us: US_SCHEMA('Fade-out length'),
  gain_db: { type: 'number', description: 'Gain, dB; written Static, replacing any keyframes.' },
  pan: { type: 'number', description: 'Stereo pan, -1 (left) .. 1 (right); written Static.' },
  mute: { type: 'boolean', description: 'Silence the clip.' },
  role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'Audio role, whose gain and flags fold into the mix.' },
  width: { type: 'integer', description: 'Colour block width, px.' },
  height: { type: 'integer', description: 'Colour block height, px.' },
  blend_mode: { type: 'string', enum: [...BLEND_MODE_OPTIONS], description: 'How the Group composites over what lies below.' },
  motif_id: { type: 'string', description: 'Motif id from list_motifs.' },
  motif_version: { type: 'integer', description: 'Motif version to bind.' },
  props: { type: 'object', description: "Motif props, matched against its props_schema." },
  graphic_role: { ...GRAPHIC_ROLE_SCHEMA, type: ['string', 'null'], description: 'Graphic role; null clears.' },
  intro: { type: ['string', 'null'], enum: [...TEXT_INTROS, null], description: 'Entrance played from the layer start (400 ms, or a third of a short layer); null: none.' },
  outro: { type: ['string', 'null'], enum: [...TEXT_OUTROS, null], description: 'Exit played into the layer end; null: none.' },
}
// add_layers: the shared fields sit flat on the layer; what differs by kind is
// one `content` object, a one-level `oneOf` on `kind`, each arm carrying its
// own notes so the tool description need not.
const ADD_LAYER_TRANSFORM_SCHEMA = {
  type: 'object', description: 'Static placement at creation, as update_layer_params writes it. Not on color or audio; text takes no scale.',
  properties: {
    x: { type: 'number', description: 'Anchor x, composition px.' }, y: { type: 'number', description: 'Anchor y, composition px.' },
    scale: { type: 'number', description: 'Uniform scale factor; 1 = native size.' },
    rotation_deg: LAYER_PARAM_FIELD_SCHEMAS.rotation_deg, opacity: { type: 'number', description: 'Opacity 0..1.' },
  },
  additionalProperties: false,
}
const addLayerArm = (kind: AddLayerKind, what: string, props: Record<string, unknown>, required: string[]) =>
  ({ properties: { kind: { const: kind, description: what }, ...props }, required: ['kind', ...required], additionalProperties: false })
const ADD_LAYER_CONTENT_SCHEMA = {
  type: 'object', description: 'What the layer is; `kind` picks the fields.',
  properties: { kind: { type: 'string', enum: [...ADD_LAYER_KINDS], description: 'The layer kind.' } },
  required: ['kind'],
  oneOf: [
    addLayerArm('video', 'A Video item. Its source window is `src_in_us` plus the span, at rate 1.', {
      media_id: ID_SCHEMA('Video media'), src_in_us: SRC_IN_SCHEMA,
      audio: { type: 'string', enum: ['linked', 'none'], description: "`linked`: also place its audio as a linked dialogue Audio layer (refused without an audio stream); `none`: picture only. Default: settings `auto_pair_audio_on_import`." },
    }, ['media_id', 'src_in_us']),
    addLayerArm('image', 'An Image item, a still over the span.', { media_id: ID_SCHEMA('Image media'), graphic_role: GRAPHIC_ROLE_SCHEMA }, ['media_id']),
    addLayerArm('audio', "An Audio item, or a Video item's audio alone: unlinked, on the track's audio lane; window `src_in_us` plus the span, edges on the 48 kHz lattice.", {
      media_id: ID_SCHEMA('Media'), src_in_us: SRC_IN_SCHEMA,
      role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'Mixing bus; default music.' },
    }, ['media_id', 'src_in_us']),
    addLayerArm('text', "A Text layer centred in frame, born in the style's tokens for its `graphic_role` (`project://taste`). Restyle with update_layer_params.", {
      content: { type: 'string', description: 'The text; newlines are honoured.' }, graphic_role: GRAPHIC_ROLE_SCHEMA,
    }, ['content']),
    addLayerArm('color', "A solid block the composition's size.", { color: { ...RGBA_SCHEMA, description: 'Fill colour.' } }, ['color']),
    addLayerArm('motif', "A Motif. Omitted props take the style's tokens, then the manifest's defaults; unknown props refuse.", {
      motif_id: { type: 'string', description: 'Motif id from `list_motifs`.' },
      props: { type: 'object', description: "Props matched against the Motif's `props_schema`." },
      graphic_role: { ...GRAPHIC_ROLE_SCHEMA, description: `${GRAPHIC_ROLE_SCHEMA.description} Omitted: the manifest's.` },
    }, ['motif_id']),
    addLayerArm('group', 'Another instance of an existing composition, windowed from its start. Refused: the root, a cycle, an empty composition.', {
      composition_id: { type: 'string', description: "The composition to place, a Group's id from `project://compositions`." },
    }, ['composition_id']),
  ],
}
const LAYER_PARAMS_PATCH_SCHEMA = {
  type: 'object',
  description: "Kind-tagged patch: `kind` must match the layer's, and only that kind's fields are accepted (one variant per kind); a key outside the set is refused naming it.",
  properties: { kind: { type: 'string', enum: [...LAYER_PARAM_KINDS], description: "The layer's params.kind, as project://tracks reports it." } },
  required: ['kind'],
  oneOf: LAYER_PARAM_KINDS.map((kind) => ({
    properties: { kind: { const: kind, description: `Fields of a ${kind} layer.` }, ...Object.fromEntries(layerPatchKeys(kind).map((k) => [k, LAYER_PARAM_FIELD_SCHEMAS[k]])) },
    required: ['kind'],
    additionalProperties: false,
  })),
}

/** The `project://*` views `read_project` serves — one per state-view resource
 *  the TS host answers (`resource-views.ts`), so the two never disagree on what
 *  an agent can read. The Rust-compute resources are not here. */
export const READ_PROJECT_VIEWS = ['current', 'composition', 'compositions', 'media', 'tracks', 'layer', 'markers', 'links', 'transitions', 'settings', 'history', 'session', 'effects', 'tacks', 'taste', 'media_thumbnail', 'media_frame'] as const
/** The views that take `composition_id` — the per-composition resources. */
export const SCOPED_PROJECT_VIEWS: ReadonlySet<string> = new Set(['composition', 'tracks', 'markers', 'links', 'transitions'])
export type ReadProjectView = (typeof READ_PROJECT_VIEWS)[number]

/** Where an argument the keyframe tools do not take belongs instead. */
const KEYFRAME_ARG_OWNERS: Readonly<Record<string, string>> = {
  interp: 'the easing is `easing`, a preset or a raw kind',
  keyframe_id: 'a key by id is update_keyframe / delete_keyframe',
  value: 'a value by time is set_keyframe; a whole track is set_param_track',
  track: 'a whole track is set_param_track',
  extrapolate: 'extrapolation is the Keyframed track\'s `extrapolate` in set_param_track',
  before: 'extrapolation is the Keyframed track\'s `extrapolate` in set_param_track',
  after: 'extrapolation is the Keyframed track\'s `extrapolate` in set_param_track',
  smooth: 'Auto tangents on one key are update_keyframe { smooth: true }',
  local_t_us: 'key times are t_us, timeline-absolute',
}

// ── Single-source MCP tool table ─────────────────────────────────────────────
// Every scalar and patch arg of a table-exec entry is parser-gated in parseArgs:
// uuid/number/enum/boolean scalars through parseX, patch objects through parseObj
// at minimum — a non-object patch must reject, never commit-nothing-and-succeed.
// The dedicated stubs exist only so the MCP_TOOLS projection stays complete;
// their behavior lives in actor.ts arms.
export const MCP_TOOL_DEFS: ReadonlyArray<McpToolDef> = [
  {name:'set_position',exec:'table',annotations:ANN_DESTRUCTIVE,description:"Replace a layer's position outright, motion included: XY tracks, or a motion path with a scalar `progress` track. Keys are timed `local_t_us` (layer-local) and need only local_t_us/value (Linear, identity tangents); nodes need only point (Line, Corner, zero handles); IDs are generated, so omit them. A static `update_layer_params` x/y also flattens XY animation; `translate_position` offsets it instead. One undo step; returns the position as committed.",inputSchema:{type:'object',properties:{layer_id:LAYER_ID_SCHEMA,position:POSITION_SCHEMA},required:['layer_id','position']},parseArgs:(a,idGen)=>({op:'set_position',args:{layer:parseUuid(a.layer_id,'layer_id'),position:parsePosition(a.position,idGen)}})},
  { name: 'translate_position', exec: 'table', annotations: ANN_WRITE,
    description: "Offset a layer's position by (dx, dy) composition px as one undo step, keeping its motion: in XY mode every x/y key (or the static value), in Path mode every node (handles and progress kept). Returns the position as committed, as set_position does.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, dx: { type: 'number', description: 'Shift in x, composition px.' }, dy: { type: 'number', description: 'Shift in y, composition px.' } }, required: ['layer_id', 'dx', 'dy'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, ['layer_id', 'dx', 'dy'], 'translate_position')
      const dx = parseNum(a.dx, 'dx'), dy = parseNum(a.dy, 'dy')
      if (dx === 0 && dy === 0) throw new McpArgError('translate_position by (0, 0) moves nothing — send a non-zero dx or dy', 'dx')
      return { op: 'translate_position', args: { layer: parseUuid(a.layer_id, 'layer_id'), dx, dy } }
    } },
  // ── table-exec: tracks ───────────────────────────────────────────────────
  { name: 'add_track', exec: 'table', annotations: ANN_WRITE,
    description: "Add a track and return its record (`track_id`, `index`, `composition_id`). Tracks are kind-agnostic — any layer kind goes on any track. A track disappears when its last layer leaves it (deleted or moved away), so place a layer rather than reserving a track; a track created empty survives until it has been filled and emptied.",
    inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'Optional name. Omit it and the track is displayed by its position in the stack, which renumbers as tracks come and go.' }, composition_id: COMPOSITION_ID_SCHEMA }, required: [] },
    parseArgs: (a) => ({ op: 'add_track', args: { label: parseStrOpt(a.label, 'label'), composition_id: parseCompositionIdOpt(a.composition_id) } }) },
  { name: 'delete_track', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Remove a track. Refuses a track with layers unless force=true (`TrackNotEmpty`); with force the layers go with it and their links are cleaned up in the same undo entry. A Group layer among them leaves its composition in place with `ref_count 0` (`project://compositions`) — `delete_composition` removes that. Only A roll / B roll tracks are protected (`TrackNotRemovable`); audio and caption tracks can be deleted.",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, force: { type: 'boolean', description: 'Also delete the layers still on it. Default false, which refuses a non-empty track (TrackNotEmpty).' } }, required: ['track_id'] },
    parseArgs: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  { name: 'rename_track', exec: 'table', annotations: ANN_SET,
    description: "Name a track, reserved A roll / B roll / audio / caption tracks included. Recorded. `label: null` (or blank) clears it back to the derived name — its role, or its position in the stack.",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, label: { type: ['string', 'null'], description: 'The new name. null or blank clears it back to the displayed-by-default name.' } }, required: ['track_id'] },
    parseArgs: (a) => ({ op: 'rename_track', args: { track: parseUuid(a.track_id, 'track_id'), label: parseStrOpt(a.label, 'label') } }) },
  { name: 'move_track', exec: 'table', annotations: ANN_SET,
    description: "Move a track to a different z-order position, one recorded edit; 0 is the bottom of the stack, and the position must be below the track count (`TrackPositionOutOfRange`). Refuses a reserved A roll / B roll track (`TrackReserved`; they keep their place), a locked track (`TrackLocked`) and a track holding a locked layer (`LayerLocked`).",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, new_position: { type: 'integer', description: 'Target index in the stack; 0 is the bottom.' } }, required: ['new_position', 'track_id'] },
    parseArgs: (a) => ({ op: 'move_track', args: { track: parseUuid(a.track_id, 'track_id'), new_position: parseIntNum(a.new_position, 'new_position') } }) },
  // Two flags of four: `Track` also stores muted/solo, and they are omitted on
  // purpose — the mix folds by ROLE (ADR 0023), so nothing reads a track's, and
  // advertising them would be advertising a write that changes nothing.
  { name: 'set_track_flags', exec: 'table', annotations: ANN_SET,
    description: "Set a track's `enabled` and/or `locked` flag; omit (or null) one to leave it alone, and name at least one. `locked` is what every `TrackLocked` refusal points at — a locked track rejects edits to its layers, and clearing it here is the fix. `enabled` is the track's output in preview and export; its layers stay put. A layer's own `locked` is separate (`set_layer_flags`), and an edit needs both clear. Mute/solo live on roles: `set_role_flags`. Unrecorded.",
    inputSchema: { type: 'object', properties: { track_id: TRACK_ID_SCHEMA, enabled: { type: 'boolean', description: "The track's output, preview and export alike. Omitted leaves it alone." }, locked: { type: 'boolean', description: 'Whether the track refuses edits to its layers. Omitted leaves it alone.' } }, required: ['track_id'] },
    parseArgs: (a) => {
      const enabled = parseBoolTriState(a.enabled, 'enabled')
      const locked = parseBoolTriState(a.locked, 'locked')
      if (enabled === null && locked === null) throw new McpArgError('set_track_flags needs at least one of `enabled` / `locked`; a call that names no flag would report success having changed nothing')
      return { op: 'update_track_flags', args: { track: parseUuid(a.track_id, 'track_id'), patch: { enabled, locked } } }
    } },
  // ── table-exec: layers ───────────────────────────────────────────────────
  // The one copy tool. `t_start_us` and `delta_us` are the two ways to say
  // where the seed's clone goes — absolute, or relative to the seed itself, so
  // a same-place copy needs no read of the timeline first. Exactly one, because
  // a call carrying both names two landings and the actor would have to pick.
  // The vocabulary is `move_layers`': seed first, `track_id` for the seed only.
  { name: 'paste_layers', exec: 'table', annotations: ANN_WRITE,
    description: "Duplicate a set of layers as one recorded edit — the only copy tool. `layer_ids[0]` is the seed; land its clone with exactly one of `t_start_us` or `delta_us` (from the seed's start). Every other clone shifts by the same delta on its source's track; `track_id` moves only the seed's clone. Nothing is expanded: pass link partners to copy them. All-or-nothing: a locked or occupied destination refuses the batch (`TrackLocked`, or `LayerOverlap` naming the source). Two or more clones link to each other. A Group clone shares its composition unless `unique`. Returns `{ clones: [{ source, clone }], layers, groups? }`; `groups` names each unique copy's `composition_id`.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The layers to clone; the first is the seed the start time refers to.' },
      t_start_us: { type: 'integer', description: "Absolute start time of the seed's clone; the other clones keep their offsets from it. Exclusive with `delta_us`." },
      delta_us: { type: 'integer', description: "Start of the seed's clone relative to the seed's own start, so every clone shifts by that much. Exclusive with `t_start_us`." },
      track_id: { type: 'string', description: "Track for the seed's clone. Omit to keep it on the seed's track." },
      unique: { type: 'boolean', description: "Give each Group clone its own deep copy of the Group's composition, so editing inside it leaves the source alone. Default false: another instance of the same composition." },
    }, required: ['layer_ids'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, ['layer_ids', 't_start_us', 'delta_us', 'track_id', 'unique'], 'paste_layers', { t_offset_us: 'the relative landing is delta_us', target_track_id: "the seed's clone's track is track_id" })
      const absolute = a.t_start_us !== undefined && a.t_start_us !== null
      const relative = a.delta_us !== undefined && a.delta_us !== null
      if (absolute === relative) throw new McpArgError(
        `paste_layers needs exactly one of \`t_start_us\` / \`delta_us\`${absolute ? ' — two of them name two landings' : ''}`,
        absolute ? 'delta_us' : 't_start_us')
      return { op: 'paste_layers', args: {
        layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')),
        ...(absolute ? { t_start_us: parseNum(a.t_start_us, 't_start_us') } : { t_offset_us: parseNum(a.delta_us, 'delta_us') }),
        target_track_id: a.track_id === undefined || a.track_id === null ? null : parseUuid(a.track_id, 'track_id'),
        unique: parseBoolOpt(a.unique, 'unique', false),
      } }
    } },
  // A layer's envelope as tracks have it: `rename_layer` + `set_layer_flags`
  // beside `rename_track` + `set_track_flags`. Both strict — a time or a param
  // key is refused naming the tool that writes it.
  { name: 'rename_layer', exec: 'table', annotations: ANN_SET,
    description: "Rename a layer: `label`, or null to clear it. One recorded edit. Times are `move_layers` (start) and `trim_layer` (one edge); `enabled` / `locked` are `set_layer_flags`; kind-specific params are `update_layer_params`.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, label: { type: ['string', 'null'], description: 'Display name; null clears it.' } }, required: ['layer_id', 'label'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, ['layer_id', 'label'], 'rename_layer', LAYER_ENVELOPE_OWNERS)
      if (a.label === undefined) throw new McpArgError('rename_layer needs `label` — a name, or null to clear it', 'label')
      return { op: 'update_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: { label: parseStrOpt(a.label, 'label') } } }
    } },
  { name: 'set_layer_flags', exec: 'table', annotations: ANN_SET,
    description: "Set `enabled` and/or `locked` on exactly these layers in one recorded edit; omit one to leave it alone, and name at least one. Nothing is expanded: pass link partners (`link_id` in project://tracks) to hide or lock a linked pair. `enabled` is the layer's output in preview and export. A locked layer refuses edits; its track's lock is separate (`set_track_flags`). A locked layer or track (`LayerLocked` / `TrackLocked`) refuses the visibility write for the whole batch: unlock in its own call first. Hide and lock is one call.",
    inputSchema: { type: 'object', properties: {
      layer_ids: LAYER_IDS_SCHEMA('The layers to set, all in one composition.'),
      enabled: { type: 'boolean', description: 'true shows, false hides — preview and export alike. Omitted leaves it alone.' },
      locked: { type: 'boolean', description: 'Whether the layer refuses edits. Omitted leaves it alone.' },
    }, required: ['layer_ids'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, ['layer_ids', 'enabled', 'locked'], 'set_layer_flags', LAYER_ENVELOPE_OWNERS)
      const enabled = parseBoolTriState(a.enabled, 'enabled')
      const locked = parseBoolTriState(a.locked, 'locked')
      if (enabled === null && locked === null) throw new McpArgError('set_layer_flags needs at least one of `enabled` / `locked`; a call that names no flag would report success having changed nothing')
      return { op: 'set_layer_flags', args: { layers: asNonEmptyArray(a.layer_ids, 'layer_ids', 'name at least one layer').map((s) => parseUuid(s, 'layer_ids')), enabled, locked } }
    } },
  { name: 'update_layer_params', exec: 'table', annotations: ANN_SET,
    description: "Patch static fields of one layer; fields are kind-specific (schema variants). A static write replaces that field's animation, x/y included (Path mode refuses x/y: translate_position); set_param_track animates. `scale_linked` links the scale pair; while linked, one axis writes both. Text has no scale fields: resize its box. `src_in_us` slips the source window (span kept); retime_layers changes the rate. Returns the layer with `params`, each patched field as committed (values are quantized); locked layers and invalid values are refused.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, patch: LAYER_PARAMS_PATCH_SCHEMA }, required: ['layer_id', 'patch'] },
    parseArgs: (a) => {
      const { scale_linked, ...patch } = parseLayerParamsPatch(a.patch)
      return { op: 'update_layer_params', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch, link_fan_out: true, ...(scale_linked === undefined ? {} : { scale_linked }) } }
    } },
  // The agent's move, in `paste_layers`' vocabulary: `layer_ids[0]` is the seed
  // the landing names, `t_start_us` | `delta_us` say where, `track_id` moves
  // only the seed. `insert` is the ripple move. Strict: a key no arm reads is
  // refused, as add_layers refuses one.
  { name: 'move_layers', exec: 'table', annotations: ANN_WRITE,
    description: "Move a set of layers as one recorded edit. `layer_ids[0]` is the seed: land it with one of `t_start_us` (absolute) or `delta_us`, or with neither for a lane change alone. Every member keeps its offset on its own track, link partners included unless `escape_link`; `track_id` moves only the seed — a track of the same composition, or \"spawn\" for a fresh top track. `insert: true` is the ripple move: the set's span closes behind it and opens at its landing on every track, so a later landing is read with that span already closed; it refuses like `delete_layers { ripple: true }`. Each layer snaps on its own grid. A start before 0, an occupied landing (`LayerOverlap`) or a lock refuses whole. Returns `{ layers, rippled, track?, pruned_tracks }`.",
    inputSchema: { type: 'object', properties: {
      layer_ids: LAYER_IDS_SCHEMA('The layers to move, all in one composition; the first is the seed.'),
      t_start_us: US_SCHEMA("Where the seed starts afterwards, timeline. Exclusive with `delta_us`"),
      delta_us: { type: 'integer', description: 'Signed shift of the seed, µs; positive moves later. Exclusive with `t_start_us`.' },
      track_id: { type: 'string', description: 'The seed\'s destination track, or "spawn" for a fresh top track. Omit to keep its track.' },
      insert: { type: 'boolean', description: 'Close the span behind and open room at the landing, on every track. Default false: an occupied landing refuses.' },
      escape_link: { ...ESCAPE_LINK_SCHEMA, description: 'Move only the named layers, leaving link partners in place. Default false.' },
    }, required: ['layer_ids'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, MOVE_LAYERS_KEYS, 'move_layers', { layer_id: 'name the set in layer_ids', new_t_start_us: 'the seed lands at t_start_us', new_track_id: "the seed's track is track_id", target_track_id: "the seed's track is track_id", from_t_us: 'a sweep from a time is shift_layers' })
      const absolute = a.t_start_us !== undefined && a.t_start_us !== null
      const relative = a.delta_us !== undefined && a.delta_us !== null
      if (absolute && relative) throw new McpArgError('move_layers takes one of `t_start_us` / `delta_us` — two of them name two landings', 'delta_us')
      const track = a.track_id === undefined || a.track_id === null ? null : a.track_id === 'spawn' ? 'spawn' as const : parseUuid(a.track_id, 'track_id')
      if (!absolute && !relative && track === null) throw new McpArgError('move_layers needs `t_start_us`, `delta_us` or `track_id` — a call naming none would move nothing', 't_start_us')
      const deltaUs = relative ? parseIntNum(a.delta_us, 'delta_us') : null
      if (deltaUs === 0 && track === null) throw new McpArgError('delta_us is 0 and no track_id is named — nothing would move', 'delta_us')
      // `layers` rides beside the request so a LayerOverlap is oriented
      // against the set the call named (actor.ts `subjectsOf`).
      const layers = asNonEmptyArray(a.layer_ids, 'layer_ids', 'name at least one layer; the first is the seed').map((s) => parseUuid(s, 'layer_ids'))
      return { op: 'move_layer_set', args: { layers, request: {
        layers, tStartUs: absolute ? parseIntNum(a.t_start_us, 't_start_us') : null, deltaUs, track,
        insert: parseBoolOpt(a.insert, 'insert', false), escapeLink: parseBoolOpt(a.escape_link, 'escape_link', false),
      } } }
    } },
  { name: 'shift_layers', exec: 'table', annotations: ANN_WRITE,
    description: "Shift every layer starting at or after `from_t_us` by one `delta_us`, as one recorded edit — on `track_ids`, or on every track of the composition. A positive delta opens room there (the ripple insert); a negative one closes `[from_t_us + delta_us, from_t_us)` the way `delete_layers { ripple: true }` closes a hole, refusing by the same names (`RippleInsideHole`: a layer starts inside the span; `RippleCollision`, `RippleLinkStraddles`, `RippleLockedLayer`) and keeping each carried transition. A link the sweep would split is `ShiftLinkStraddles`; a start before 0 refuses. Each layer snaps on its own grid. To move named layers, `move_layers`. Returns `{ moved: [layer records], delta_us }`.",
    inputSchema: { type: 'object', properties: {
      from_t_us: US_SCHEMA('Shift every layer starting at or after this time, timeline'),
      delta_us: { type: 'integer', description: 'Signed shift, µs; positive opens room, negative closes the span before from_t_us. Not 0.' },
      track_ids: { type: 'array', items: { type: 'string' }, description: 'Only these tracks. Omit for every track.' },
      composition_id: { ...COMPOSITION_ID_SCHEMA, description: 'The composition to sweep; omit for the root.' },
    }, required: ['from_t_us', 'delta_us'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, ['from_t_us', 'delta_us', 'track_ids', 'composition_id'], 'shift_layers', { layer_ids: 'named layers move with move_layers', escape_link: 'named layers move with move_layers' })
      const delta = parseIntNum(a.delta_us, 'delta_us')
      if (delta === 0) throw new McpArgError('delta_us is 0 — nothing would move', 'delta_us')
      return { op: 'shift_layers', args: { from_t_us: parseIntNum(a.from_t_us, 'from_t_us'), tracks: a.track_ids === undefined || a.track_ids === null ? null : asArray(a.track_ids, 'track_ids').map((s) => parseUuid(s, 'track_ids')), composition_id: parseCompositionIdOpt(a.composition_id), delta_us: delta, strict: true } }
    } },
  { name: 'restack_layer', exec: 'table', annotations: ANN_SET,
    description: "Restack a visual layer above/below a stable layer or track anchor. Supply exactly one anchor; track anchors work through gaps. A sole occupant carries its track; shared or reserved sources split onto a fresh track. Reserved tracks stay put. Audio, cross-composition and self-anchors reject. Already in place records nothing. One undo step.",
    inputSchema: { type: 'object', properties: {
      layer_id: { type: 'string', description: 'The visual layer to restack.' },
      anchor_layer_id: { type: 'string', description: 'The visual layer to place it against; supply exactly one of anchor_layer_id / anchor_track_id.' },
      anchor_track_id: { type: 'string', description: 'A visual track to place it against, including an empty reserved lane. Supply instead of anchor_layer_id.' },
      position: { type: 'string', enum: ['above', 'below'], description: "Place the layer directly above or directly below the anchor layer's track." },
    }, required: ['layer_id', 'position'], oneOf: [
      { required: ['anchor_layer_id'], not: { required: ['anchor_track_id'] } },
      { required: ['anchor_track_id'], not: { required: ['anchor_layer_id'] } },
    ] },
    parseArgs: (a) => {
      const hasLayer = a.anchor_layer_id !== undefined && a.anchor_layer_id !== null
      const hasTrack = a.anchor_track_id !== undefined && a.anchor_track_id !== null
      if (hasLayer === hasTrack) throw new McpArgError('provide exactly one of anchor_layer_id / anchor_track_id', 'anchor_layer_id')
      return { op: 'restack_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'),
        ...(hasTrack ? { anchor_track: parseUuid(a.anchor_track_id, 'anchor_track_id') } : { anchor: parseUuid(a.anchor_layer_id, 'anchor_layer_id') }),
        position: parseRestackPosition(a.position) } }
    } },
  // The pitch policy rides the retime it matters to (a rate of 1 plays at
  // pitch either way), and may be sent alone to change only the policy.
  { name: 'retime_layers', exec: 'table', annotations: ANN_SET,
    description: "Retime exactly these clips in one recorded edit, keeping their starts and source windows. `target` is an absolute Rate — source µs per timeline µs, so 2/1 plays twice as fast at half the length — or a Duration (µs). `preserve_pitch` sets the pitch policy of the Audio and Group clips among them (default true), with or without a target. Nothing is expanded: pass link partners too, or their A/V sync drifts; the answer's `unretimed_partners` names any left out. Atomic; refuses collisions, transitions, locks and nested targets. Returns `{ layers: [{ layer_id, t_end_us, duration_us, actual_rate, … }], unretimed_partners }` after grid snapping.",
    inputSchema: { type: 'object', properties: { layer_ids: LAYER_IDS_SCHEMA('Explicit target clips'), target: { type: 'object', description: 'Absolute rate or duration.', oneOf: [
      { type: 'object', properties: { kind: { type: 'string', const: 'Rate', description: 'Rate target.' }, value: { type: 'object', description: 'Reduced positive rational: source µs per timeline µs.', properties: { num: { type: 'integer', minimum: 1, description: 'Numerator.' }, den: { type: 'integer', minimum: 1, description: 'Denominator.' } }, required: ['num', 'den'], additionalProperties: false } }, required: ['kind', 'value'], additionalProperties: false },
      { type: 'object', properties: { kind: { type: 'string', const: 'Duration', description: 'Duration target.' }, duration_us: { type: 'integer', minimum: 1, description: 'Target microseconds.' } }, required: ['kind', 'duration_us'], additionalProperties: false }
    ] }, preserve_pitch: { type: 'boolean', description: 'Keep the pitch of the Audio and Group clips when the rate changes. Omit to leave the policy alone.' } }, required: ['layer_ids'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, ['layer_ids', 'target', 'preserve_pitch'], 'retime_layers')
      const hasTarget = a.target !== undefined && a.target !== null
      const preservePitch = parseBoolTriState(a.preserve_pitch, 'preserve_pitch')
      if (!hasTarget && preservePitch === null) throw new McpArgError('retime_layers needs `target`, `preserve_pitch` or both — a call naming neither would change nothing', 'target')
      return { op: 'retime_layers_mcp', args: { layers: asNonEmptyArray(a.layer_ids, 'layer_ids', 'name at least one clip').map(s => parseUuid(s, 'layer_ids')), target: hasTarget ? parseRetimeTarget(a.target) : null, preserve_pitch: preservePitch } }
    } },
  { name: 'trim_layer', exec: 'table', annotations: ANN_SET,
    description: "Trim an edge to new_t_us. Source time follows the clip rate; keyframes remain glued to content. Aligned linked edges follow unless escape_link. Refuses targets outside the legal source/timeline window. Returns committed spans, trimmed siblings and grid adjustments.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, edge: { type: 'string', enum: ['in', 'out'], description: 'Which edge moves: in = t_start_us, out = t_end_us.' }, new_t_us: US_SCHEMA('Where the edge lands, timeline'), escape_link: ESCAPE_LINK_SCHEMA }, required: ['edge', 'layer_id', 'new_t_us'] },
    parseArgs: (a) => ({ op: 'trim_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), edge: parseOneOf(a.edge, ['in', 'out'], 'edge'), new_t_us: parseNum(a.new_t_us, 'new_t_us'), escape_link: parseBoolOpt(a.escape_link, 'escape_link', false), strict: true } }) },
  // One delete tool over two actor ops: `ripple` is the whole difference between
  // them, and the surface says so rather than making an agent pick a verb it can
  // only tell apart by reading two descriptions. Empty `layer_ids` splits — the
  // lift takes it as the no-op of an empty selection, the ripple has no hole to
  // close and refuses — so the arity check stays in the actor, where each op
  // already owns its own answer.
  { name: 'delete_layers', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Delete a set of layers as one recorded edit. Nothing is expanded: pass link partners (`link_id` in project://tracks), or a lifted video leaves its dialogue playing. `ripple` decides what happens to the vacated span: `false` (default) is the lift — it stays empty and nothing moves; `true` closes each hole so the film gets shorter — every remaining layer starting at or after a hole shifts left by its length on EVERY track of the composition (anchored markers riding along), touching holes merge, and layers starting before a hole, free markers and the playhead stay put. The set is one composition's (`CrossCompositionSet`); any locked layer or track refuses the whole batch; tracks the batch emptied are pruned. A ripple refuses whole, before any write, naming the blocker: `RippleInsideHole` (a remaining layer starts inside a hole — add it to `layer_ids`, or lift), `RippleCollision` (a mover would land on a layer that is not moving), `RippleLinkStraddles` (a link spans the hole), `RippleLockedLayer` (only a layer that shifts blocks). An empty set is refused as a ripple.",
    inputSchema: { type: 'object', properties: {
      layer_ids: LAYER_IDS_SCHEMA('The layers to delete, all in one composition.'),
      ripple: { type: 'boolean', description: 'Close each vacated span and shift everything downstream left (default false — leave the spans empty).' },
    }, required: ['layer_ids'] },
    parseArgs: (a) => ({
      op: parseBoolOpt(a.ripple, 'ripple', false) ? 'ripple_delete_layers' : 'delete_layers',
      args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')) },
    }) },
  // ── table-exec: links ───────────────────────────────────────────────────
  { name: 'create_link', exec: 'table', annotations: ANN_WRITE,
    description: "Create a new link from >=2 distinct layer ids. If any layer is already in another link, the op fails unless `reassign=true`, which removes them from their prior link(s) first (auto-dissolving any link that falls below 2 members). Returns the link record (`link_id`, `members`).",
    inputSchema: { type: 'object', properties: { layer_ids: LAYER_IDS_SCHEMA('Two or more layers of one composition.'), reassign: { type: 'boolean', description: 'Pull a member out of the link it is already in. Default false: such a member refuses.' } }, required: ['layer_ids'] },
    parseArgs: (a) => ({ op: 'links_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }) },
  { name: 'delete_link', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Dissolve (delete) a link. The member layers themselves are not deleted.",
    inputSchema: { type: 'object', properties: { link_id: ID_SCHEMA('Link') }, required: ['link_id'] },
    parseArgs: (a) => ({ op: 'links_dissolve', args: { link: parseUuid(a.link_id, 'link_id') } }) },
  { name: 'update_link', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Change a link in one recorded edit — any of: `add_layer_ids` (join layers; one already in another link is refused unless `reassign` is true, which pulls it out of its old link first, dissolving that link if it falls below two members), `remove_layer_ids` (drop members; below two, the link dissolves). At least one. Applied add → remove. Every layer must be in the link's composition (`CrossCompositionSet`). Create with `create_link`, delete with `delete_link`.",
    inputSchema: { type: 'object', properties: {
      link_id: ID_SCHEMA('Link'),
      add_layer_ids: LAYER_IDS_SCHEMA('Layers to join.'),
      remove_layer_ids: LAYER_IDS_SCHEMA('Members to drop.'),
      reassign: { type: 'boolean', description: 'Let `add_layer_ids` take a layer out of another link. Default false.' },
    }, required: ['link_id'] },
    parseDedicated: (a) => {
      const ids = (v: unknown, field: string): string[] => v === undefined || v === null ? [] : asArray(v, field).map((s) => parseUuid(s, field))
      const p = {
        link: parseUuid(a.link_id, 'link_id'),
        add: ids(a.add_layer_ids, 'add_layer_ids'),
        remove: ids(a.remove_layer_ids, 'remove_layer_ids'),
        reassign: parseBoolOpt(a.reassign, 'reassign', false),
      }
      if (p.add.length === 0 && p.remove.length === 0)
        throw new McpArgError(`update_link needs at least one of add_layer_ids, remove_layer_ids — nothing to change`)
      return p
    } },
  // ── table-exec: groups (ADR 0052; docs/features.md#groups) ──────────────
  { name: 'create_group', exec: 'table', annotations: ANN_WRITE,
    description: "Pre-compose selected clips into a new Group, preserving their placement and links. Refuses partial links, locked members and incompatible selections. Returns the Group clip and composition. Group members retain their own timing and effects.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The layers to pre-compose; at least one, all in one composition.' },
      label: { type: 'string', description: 'Optional name for the new composition. Omit and the UI derives one.' },
    }, required: ['layer_ids'] },
    parseArgs: (a) => ({ op: 'groups_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), label: parseStrOpt(a.label, 'label') } }) },
  { name: 'add_group_members', exec: 'table', annotations: ANN_WRITE,
    description: "Move selected clips into an existing Group while preserving external placement. Requires Group rate 1 and compatible selection. Refuses partial links, locked members and cycles. Returns the resulting Group.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The layers to move in; at least one, all in one composition.' },
      group_layer_id: { type: 'string', description: 'The Group clip they move into — a `CompositionRef` layer in the SAME composition as the members.' },
    }, required: ['layer_ids', 'group_layer_id'] },
    parseArgs: (a) => ({ op: 'groups_add_members', args: {
      layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')),
      group_layer: parseUuid(a.group_layer_id, 'group_layer_id'),
    } }) },
  { name: 'move_layers_to_composition', exec: 'table', annotations: ANN_WRITE,
    description: "Move selected layers into another composition. The anchor lands at anchor_t_start_us; other members retain offsets. Lane assignment is per source track: omit to_track_id to find space, use spawn for fresh lanes, or name a free unlocked lane. Refuses mixed source compositions, locks, cycles, negative starts and membership changes involving retimed Groups. Internal links/transitions move; straddling ones are cut. Markers stay; compositions autofit; Group windows stay fixed.",
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
    description: "Append an effect to a layer's chain (applied last), with `params` as plain numbers, and return its record (`effect_id`, `kind`, `index`, `params`). An unset param is its catalog default (`effects://catalog`: every kind's params, defaults and ranges), and can be keyframed at once as `effects[<effect_id>].params[<key>]`. Visual kinds (\"blur\", \"chromakey\", \"brightness\", \"contrast\", \"saturation\", \"sharpen\") go on visual layers; the colour trio and sharpen default to 0, no change; chromakey's key colour `keyR`/`keyG`/`keyB` is 0..1, not 0..255. `audio.*` kinds go on Audio layers ONLY, params STATIC ONLY (`AudioEffectParamStatic`); a kind on the wrong layer kind is `EffectKindNotApplicable`. \"audio.denoise\" (`strength`, `margin` dB) does nothing until `profile_in_us`/`profile_out_us`, SOURCE-time bounds of a noise-only span ≥ 250000 µs, are set.",
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: [...EFFECT_KINDS], description: 'Catalog key: visual kinds on visual layers, audio.* on Audio layers.' },
      layer_id: LAYER_ID_SCHEMA,
      params: { type: 'object', description: 'Initial values, param key → number, each within its catalog range, e.g. {"amount": -20}. Omitted keys take the catalog default.', additionalProperties: { type: 'number', description: 'A static value.' } },
    }, required: ['kind', 'layer_id'] },
    parseArgs: (a) => {
      refuseUnknownArgs(a, ['layer_id', 'kind', 'params'], 'add_effect')
      const kind = parseEffectKind(a.kind)
      const params = parseAddEffectParams(a.params, kind)
      return { op: 'add_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), kind, ...(params ? { params } : {}) } }
    } },
  { name: 'update_effect', exec: 'table', annotations: ANN_SET,
    description: "Update an effect: patch is `{ enabled?, params? }`, at least one; params merge key by key as plain numbers, `null` unsetting a key back to its catalog default. A value written to a keyframed param replaces its keys; animate with set_keyframe on `effects[<effect_id>].params[<key>]`. Unknown keys and out-of-range values are refused, never partially applied. Returns the effect record.",
    inputSchema: { type: 'object', properties: { effect_id: ID_SCHEMA('Effect'), layer_id: LAYER_ID_SCHEMA, patch: {
      type: 'object',
      description: 'Effect patch; only the fields sent are applied.',
      properties: {
        enabled: { type: 'boolean', description: 'false bypasses the effect, true applies it.' },
        params: { type: 'object', description: 'Param key → number, or null to unset it, e.g. {"strength": 8}.', additionalProperties: { type: ['number', 'null'], description: 'A static value, or null for the catalog default.' } },
      },
    } }, required: ['effect_id', 'layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), patch: parseEffectPatch(a.patch) } }) },
  { name: 'move_effect', exec: 'table', annotations: ANN_SET,
    description: "Reorder an effect within its layer's chain. new_index is 0-based; 0 = first applied. Must be < effect count.",
    inputSchema: { type: 'object', properties: { effect_id: ID_SCHEMA('Effect'), layer_id: LAYER_ID_SCHEMA, new_index: { type: 'integer', description: 'Target position in the chain; 0 is applied first.' } }, required: ['effect_id', 'layer_id', 'new_index'] },
    parseArgs: (a) => ({ op: 'move_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), new_index: parseIntNum(a.new_index, 'new_index') } }) },
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
    description: "Update the project's editing preferences; only the fields you send apply, and an unknown key or an empty patch is refused. Unrecorded — preferences are setup, patched into every history snapshot, so undo walks past them (the `update_composition` contract). Fields: `auto_pair_audio_on_import`, `prefer_proxies`, `proxy_override`, `shot_review`, `pause_review` (the last two validated and refused as a whole, against the detectors' own bounds; `null` clears one back to defaults). Returns `{ settings, changed }`; `changed` names the fields that moved (empty: all already set). Read current values from `project://settings`.",
    inputSchema: { type: 'object', properties: { patch: {
      type: 'object',
      description: "Settings patch. Only the fields you include are applied; `null` has a per-field meaning given below and is never 'unset'.",
      properties: {
        auto_pair_audio_on_import: { type: 'boolean', description: 'The default of `add_layers` video `audio`: on places and links the source\'s audio, off places a video silent. Default on.' },
        prefer_proxies: { type: 'boolean', description: 'Whether preview reads generated proxies rather than the original media. A playback preference; export always reads the original.' },
        proxy_override: { type: 'object', description: "Per-media exception to `prefer_proxies`, read back as `settings.proxy_overrides[media_id]`. An unknown media id is refused.", properties: { media_id: { type: 'string', description: 'A pool media id.' }, value: { type: ['boolean', 'null'], description: 'true / false pins the item; null removes the exception.' } }, required: ['media_id', 'value'] },
        shot_review: { type: ['object', 'null'], description: "Shot-detection parameters `analyze_clip` / `auto_split_by_shot` run at, or `null` for the defaults. `sensitivity` in [0, 1]; `min_shot_us` > 0.", properties: { sensitivity: { type: 'number', description: 'Cut sensitivity 0..1.' }, min_shot_us: US_SCHEMA('Shortest shot kept') }, required: ['sensitivity', 'min_shot_us'] },
        pause_review: { type: ['object', 'null'], description: "The Pauses section's parameters, or `null` for the defaults. `threshold_db` ≤ 0, `min_pause_us` > 0, `pad_us` >= 0 with `2 * pad_us < min_pause_us`.", properties: { threshold_db: { type: 'number', description: 'Peak level below which audio counts as a pause, dBFS.' }, min_pause_us: US_SCHEMA('Shortest pause detected'), pad_us: US_SCHEMA('Kept on each side of a cut pause') }, required: ['threshold_db', 'min_pause_us', 'pad_us'] },
      },
    } }, required: ['patch'] },
    parseArgs: (a) => ({ op: 'update_project_settings', args: { patch: parseProjectSettingsPatch(a.patch) } }) },
  // ── table-exec: markers ──────────────────────────────────────────────────
  { name: 'update_marker', exec: 'table', annotations: ANN_SET,
    description: "Update a marker. Setting `t_us` re-sorts the marker list. On a marker ANCHORED to a clip, `t_us` names the time the mark should read and moves the ANCHOR to make it read that, so the mark keeps following its clip from the new offset — a time outside that clip's span is refused, and `t_us` together with `end_t_us` is refused (an anchored region's end follows its anchor by itself; patch one or the other).",
    inputSchema: { type: 'object', properties: { marker_id: ID_SCHEMA('Marker'), patch: {
      type: 'object',
      description: 'Marker patch; only fields you set apply. The anchor is `set_marker_anchor`\'s, not patchable here.',
      properties: {
        t_us: US_SCHEMA('New time, timeline'),
        end_t_us: { type: ['integer', 'null'], description: 'Region end, timeline µs (exclusive); a point marker becomes a region. null turns a region back into a point.' },
        label: { type: 'string', description: 'Short name — what the marker lane and the search palette show. Keep it to a few words; long text belongs in `note`.' },
        note: { type: 'string', description: 'Long text, shown only in the marker panel.' },
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
    description: "Undo the newest edit by anyone: history is shared, so it may be the user's — check `undone.actor`, and `redo` puts it back. `NothingToUndo` at the origin. Only timeline edits record — layers, tracks, markers, transitions, links, and media removals that cascade. Outside the stack and untouched by undo: media imports, the composition envelope (`update_composition`), project settings (`set_project_settings`), track and role flags, and loading a project (which resets history). Answers `undone`: the op reverted.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'undo', args: {} }) },
  { name: 'jump_to', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Move the history cursor to the state right after op `op_id` (an `ops[].op_id` of `project://history`): the way to a state that is neither one undo away nor a checkpoint. An op the stack no longer holds is refused. A revert path like undo, so another session's history lock blocks it. Records nothing; a later edit drops whatever sat ahead, as after an undo. Answers `at`: the op the cursor now sits on.",
    inputSchema: { type: 'object', properties: { op_id: { type: 'string', description: 'The op to land on: an `ops[].op_id` of `project://history`.' } }, required: ['op_id'] },
    parseArgs: (a) => ({ op: 'jump_to_op', args: { op_id: parseUuid(a.op_id, 'op_id') } }) },
  { name: 'redo', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Redo the next edit. Errors with NothingToRedo if no redo is available. A new commit truncates the redo tail. Answers `redone`: the op reapplied.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'redo', args: {} }) },
  // ── table-exec: captions ─────────────────────────────────────────────────
  // Project-wide by design (one commit over every Caption-role track in every
  // composition): caption lanes multiply as cues collide, and restyling them
  // one at a time would leave a film styled in two ways for as long as the
  // batch took.
  // Q9's restyle: back to the project's style tokens (spec H1-D4). Dedicated:
  // the tokens come from the host's taste, which the actor reads through its
  // `tasteTokens` option.
  { name: 'restyle_to_taste', exec: 'dedicated', annotations: ANN_SET,
    description: "Reset Text and style Motif layers to the project's style tokens (project://taste), one edit: text takes its role's tokens (untagged: `none`), captions the caption tokens, a Motif its token-backed props. Select by exactly one of `layer_ids`, `graphic_role`, `captions: true` (the last two within `composition_id`). `groups`: `look` (face, size, colour, outline, shadow, box), `position`, `motion` (intro/outro); default look + motion (placement kept); `position` moves Text only. Returns `{ restyled, unchanged }`.",
    inputSchema: { type: 'object', properties: {
      layer_ids: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Text or Motif layers to restyle.' },
      graphic_role: { type: ['string', 'null'], description: 'Every Text or Motif layer with this role; null selects the untagged ones.' },
      captions: { type: 'boolean', description: 'Every caption.' },
      composition_id: { type: 'string', description: "A Group's composition; omit for the root." },
      groups: { type: 'array', minItems: 1, items: { type: 'string', enum: [...RESTYLE_GROUPS] }, description: 'Default look, motion.' },
    } },
    parseDedicated: (a) => {
      const selectors = [a.layer_ids !== undefined, a.graphic_role !== undefined, a.captions === true].filter(Boolean).length
      if (selectors !== 1) throw new McpArgError('select with exactly one of layer_ids, graphic_role or captions: true', 'layer_ids')
      const groups = a.groups === undefined ? ['look', 'motion'] : asNonEmptyArray(a.groups, 'groups', 'name at least one group').map((g, i) => parseOneOf(g, RESTYLE_GROUPS, `groups[${i}]`))
      return {
        layer_ids: a.layer_ids === undefined ? null : asNonEmptyArray(a.layer_ids, 'layer_ids', 'name at least one layer').map((s) => parseUuid(s, 'layer_ids')),
        graphic_role: a.graphic_role === undefined ? null : parseGraphicRoleOpt(a.graphic_role) ?? null,
        captions: a.captions === true,
        composition_id: parseCompositionIdOpt(a.composition_id),
        groups,
      }
    } },
  { name: 'merge_captions', exec: 'table', annotations: ANN_DESTRUCTIVE,
    description: "Merge two or more captions of ONE caption lane into the earliest, as one recorded edit: its span becomes the union, its text the texts joined by a line break in time order, its style stays; the others are deleted. A gap between them is spanned. Refuses a layer that is not a caption, captions on different lanes, and a union that would overlap another cue of the lane (`LayerOverlap`). Returns the merged caption's record with `removed`.",
    inputSchema: { type: 'object', properties: { layer_ids: LAYER_IDS_SCHEMA('Two or more captions on one caption track.') }, required: ['layer_ids'] },
    parseArgs: (a) => ({ op: 'merge_captions', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')) } }) },
  // ── table-exec: audio roles ──────────────────────────────────────────────
  { name: 'set_role_gain', exec: 'table', annotations: ANN_SET,
    description: "Set an audio role's mix gain (dB). role ∈ {dialogue,music,sfx,voiceover}. Recorded (undoable). Folds into every layer of that role at mix time.",
    inputSchema: { type: 'object', properties: { gain_db: { type: 'number', description: 'Role gain, dB; 0 = unity.' }, role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'The audio role.' } }, required: ['gain_db', 'role'] },
    parseArgs: (a) => ({ op: 'set_role_gain', args: { role: parseRole(a.role), gain_db: parseNum(a.gain_db, 'gain_db') } }) },
  { name: 'set_role_flags', exec: 'table', annotations: ANN_SET,
    description: "Mute/solo an audio role; omit one flag to leave it alone, and name at least one. role ∈ {dialogue,music,sfx,voiceover}. Mute wins over solo; any solo silences non-soloed roles. Gates preview AND export. Unrecorded (undo does not revert it) and not in the review diff — restore the flags before handing back. A mix change the user reviews is `set_role_gain`.",
    inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'], description: 'The audio role.' }, muted: { type: 'boolean', description: 'Silence the role. Omitted leaves it alone.' }, solo: { type: 'boolean', description: 'Play this role alone. Omitted leaves it alone.' } }, required: ['role'] },
    parseArgs: (a) => {
      const muted = parseBoolTriState(a.muted, 'muted')
      const solo = parseBoolTriState(a.solo, 'solo')
      if (muted === null && solo === null) throw new McpArgError('set_role_flags needs at least one of `muted` / `solo`; a call that names no flag would report success having changed nothing')
      return { op: 'update_role_flags', args: { role: parseRole(a.role), patch: { muted, solo } } }
    } },
  // ── dedicated-exec — parseDedicated validates and maps MCP args; behavior lives in actor.ts arms ──
  { name: 'add_layers', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Place 1–50 layers in ONE recorded edit, all or nothing: any refusal commits none. `content.kind` picks what each layer is. A layer without `track_id` gets a fresh track in the same edit; layers on one lane cannot overlap. A Video with an audio stream also lands its dialogue Audio on the same track's audio lane, linked (`audio`); an occupied audio lane refuses naming the blocker. Audio-only media is kind `audio`, a still kind `image`; a subtitle document is `apply_subtitles`. Returns `{ layers: [{ layer_id, track_id, t_start_us, t_end_us, adjusted, linked }] }` in input order; `adjusted` lists grid snaps, `linked` is `{ audio_layer_id, link_id }` or null.",
    inputSchema: { type: 'object', properties: {
      composition_id: { type: 'string', description: "Composition a layer without `track_id` opens its track in (a Group's id); omit for the root. A named track must belong to it." },
      layers: { type: 'array', minItems: 1, maxItems: ADD_LAYERS_MAX, description: 'The layers, placed in order.', items: { type: 'object', properties: {
        track_id: { type: 'string', description: 'Track to place on; omit for a fresh track.' },
        t_start_us: T_START_SCHEMA,
        t_end_us: { type: 'integer', description: "Timeline end (exclusive), µs. Required except for a group, which defaults to its composition's length." },
        label: { type: 'string', description: 'Clip name.' },
        transform: ADD_LAYER_TRANSFORM_SCHEMA,
        content: ADD_LAYER_CONTENT_SCHEMA,
      }, required: ['t_start_us', 'content'], additionalProperties: false } },
    }, required: ['layers'] },
    parseDedicated: (a) => {
      const layers = asNonEmptyArray(a.layers, 'layers', 'send at least one layer') as unknown[]
      if (layers.length > ADD_LAYERS_MAX) throw new McpArgError(`layers holds ${layers.length}; at most ${ADD_LAYERS_MAX} per call`, 'layers')
      return { composition_id: parseCompositionIdOpt(a.composition_id), layers: layers.map((l, i) => parseAddLayer(l, `layers[${i}]`)) }
    } },
  // The two caption tools that carry WORD timing. Both are dedicated because
  // both take the project id the production channels pass for staleness — an
  // agent has no reason to hold one, so the arm supplies it from the state it
  // is already reading.
  { name: 'apply_transcripts', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Lay transcripts on the caption tracks of `composition_id` (root by default), keeping per-word timing. Pass `transcribe_clip`'s `transcripts` as is, or your own cues with `word_timing: 'none'`, unsplit: cues are built to the style's caption limits (lines broken, long segments split). A transcript whose `source` clip changed since it was transcribed (trimmed, cut, moved) is refused: transcribe it again. Cues pack into the existing caption tracks, opening a lane only when all collide, and snap to frames. Returns `{ caption_track_id, cue_layer_ids }`, cues in time order. At most 1000 transcripts. One recorded edit.",
    inputSchema: { type: 'object', properties: {
      transcripts: { type: 'array', maxItems: 1000, description: "`transcribe_clip`'s `transcripts`, or your own in that shape.", items: {
        type: 'object',
        properties: {
          source: { type: 'object', description: 'The clip it was transcribed from, as `transcribe_clip` names it; a `signature` that no longer matches refuses.', properties: { layer_id: { type: 'string', description: 'The layer that was read.' }, signature: { type: 'string', description: 'Its state when read.' } }, required: ['layer_id'] },
          word_timing: { type: 'string', enum: ['exact', 'interpolated_from_cue', 'none'], description: "Where the word offsets came from. `none` stores cues with no word timing." },
          segments: { type: 'array', description: 'Cues, timeline µs.', items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The cue text.' }, t_start_us: US_SCHEMA('Cue start, timeline'), t_end_us: US_SCHEMA('Cue end (exclusive), timeline'),
              words: { type: 'array', description: 'Word offsets, timeline µs like the cue. Empty is allowed.', items: {
                type: 'object',
                properties: { text: { type: 'string', description: 'The word.' }, t_start_us: US_SCHEMA('Word start, timeline'), t_end_us: US_SCHEMA('Word end (exclusive), timeline') },
                required: ['text', 't_start_us', 't_end_us'],
              } },
            },
            required: ['text', 't_start_us', 't_end_us', 'words'],
          } },
        },
        required: ['word_timing', 'segments'],
      } },
      composition_id: CAPTIONS_COMPOSITION_ID_SCHEMA,
    }, required: ['transcripts'] },
    parseDedicated: (a) => {
      strictKeys(a, ['transcripts', 'composition_id'], 'apply_transcripts', { source_layer_ids: "each transcript names its clip in `source`" })
      const list = asArray(a.transcripts, 'transcripts')
      if (list.length > 1000) throw new McpArgError(`transcripts holds ${list.length}; at most 1000 per call`, 'transcripts')
      return {
        transcripts: list.map((t, i) => {
          const o = parseObj(t, `transcripts[${i}]`)
          // The envelope's informational fields ride along unread.
          strictKeys(o, ['source', 'word_timing', 'segments', 'backend', 'fallback', 'language', 'input_normalization'], `transcripts[${i}]`)
          if (o.source === undefined || o.source === null) return o
          const src = parseObj(o.source, `transcripts[${i}].source`)
          strictKeys(src, ['layer_id', 'signature'], `transcripts[${i}].source`)
          return { ...o, source: { layer_id: parseUuid(src.layer_id, `transcripts[${i}].source.layer_id`), ...(src.signature === undefined ? {} : { signature: parseStr(src.signature, `transcripts[${i}].source.signature`) }) } }
        }),
        composition_id: parseCompositionIdOpt(a.composition_id),
      }
    } },
  { name: 'correct_caption_text', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Correct caption TEXT against `script`, the full verbatim transcript of what is said (not notes or a glossary): each cue's words are aligned to it and misheard words, names and terms replaced. Cue segmentation and timing never change. Refuses (`InvalidArgument`, field `script`) when under half of the caption words align to it. Every caption in `composition_id` (root by default); `layer_ids` narrows it (a non-caption id refuses). Returns `{ changed, match_ratio, changes: [{ layer_id, before, after }] }`, at most 20 listed (`changed` counts all). Refuses whole, before any write, if a target or its track is locked. One recorded edit; nothing to change records nothing.",
    inputSchema: { type: 'object', properties: {
      script: { type: 'string', maxLength: CORRECTION_SCRIPT_MAX, description: 'The full verbatim transcript of the speech these captions show, correctly spelled.' },
      layer_ids: { type: 'array', items: { type: 'string' }, description: 'The captions to correct. Omit for every caption in the composition.' },
      composition_id: CAPTIONS_COMPOSITION_ID_SCHEMA,
    }, required: ['script'] },
    parseDedicated: (a) => {
      strictKeys(a, ['script', 'layer_ids', 'composition_id'], 'correct_caption_text')
      const script = parseStr(a.script, 'script')
      if (!script.trim()) throw new McpArgError('script is blank — pass the full verbatim transcript the captions should match', 'script')
      if (script.length > CORRECTION_SCRIPT_MAX) throw new McpArgError(`script is ${script.length} characters; at most ${CORRECTION_SCRIPT_MAX}`, 'script')
      return {
        script,
        layer_ids: a.layer_ids === undefined || a.layer_ids === null
          ? null : asNonEmptyArray(a.layer_ids, 'layer_ids', 'omit it to correct every caption, or name at least one').map((x) => parseUuid(x, 'layer_ids')),
        composition_id: parseCompositionIdOpt(a.composition_id),
      }
    } },
  { name: 'split_layer', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Split at sorted, grid-snapped times in one atomic edit. Each half retains its mapped content window. Linked members are cut too and form a separate link per segment unless escape_link. Returns layer_ids, the actual at_t_us and `siblings: [{ layer_id, segments }]`, each link partner cut with it.",
    inputSchema: { type: 'object', properties: {
      at_t_us: { type: 'array', items: { type: 'integer' }, minItems: 1, description: 'Interior timeline cuts, µs; snapped, sorted, deduplicated. Any invalid cut rejects all.' },
      escape_link: ESCAPE_LINK_SCHEMA, layer_id: LAYER_ID_SCHEMA,
    }, required: ['layer_id', 'at_t_us'] },
    parseDedicated: (a) => {
      const common = { layer: parseUuid(a.layer_id, 'layer_id'), escape_link: parseBoolOpt(a.escape_link, 'escape_link', false) }
      const cuts = asNonEmptyArray(a.at_t_us, 'at_t_us', 'provide at least one cut').map((v, i) => {
        const at = parseNum(v, `at_t_us[${i}]`)
        if (!Number.isSafeInteger(at)) throw new McpArgError(`at_t_us[${i}] must be an integer microsecond`, 'at_t_us')
        return at
      })
      return { ...common, at_t_us: cuts }
    } },
  { name: 'add_marker', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Add a marker (point or region) to a composition's timeline — the root, or the Group named by `composition_id`. Returns the marker record (`marker_id`, `t_us` as snapped). Set `end_t_us` to make it a region marker. Set `anchor_layer_id` to have the mark FOLLOW a clip instead of standing at a fixed time; omit it for an ordinary marker. `color` defaults to the timeline's marker blue.",
    inputSchema: { type: 'object', properties: { anchor_layer_id: { type: 'string',
      description: 'Clip the marker should follow — a layer of the same composition with a source window (VideoClip, Audio, Group). Tied as `set_marker_anchor` would tie it, refused for the same reasons (no marker is created). Omit for a fixed marker.' },
      color: { ...RGBA_SCHEMA, description: 'Marker colour; omit for the default.' }, end_t_us: US_SCHEMA('Region end, timeline; omit for a point marker'), label: { type: 'string', description: 'Short name shown on the marker lane.' }, note: { type: 'string', description: 'Long text, shown only in the marker panel.' }, t_us: US_SCHEMA('Marker time, timeline'), composition_id: COMPOSITION_ID_SCHEMA }, required: ['label', 't_us'] },
    parseDedicated: (a) => ({ color: a.color === undefined ? null : parseRgba(a.color, 'color'), t_us: parseNum(a.t_us, 't_us'),
      end_t_us: parseNumOpt(a.end_t_us, 'end_t_us'), label: parseStr(a.label, 'label'), note: a.note === undefined ? null : parseStr(a.note, 'note'),
      anchor_layer_id: a.anchor_layer_id != null ? parseUuid(a.anchor_layer_id, 'anchor_layer_id') : null,
      composition_id: parseCompositionIdOpt(a.composition_id) }) },
  { name: 'set_keyframe', exec: 'dedicated', annotations: ANN_SET,
    description: "Insert or update one key on a layer param by time (`t_us`, timeline-absolute), snapped to the frame first: a key on that frame is updated in place, id kept. On a Static track the first key replaces the static value, which is not kept — key the start value too, or use set_param_track. `value` is typed by `param_key`: a number, or {r,g,b,a} (0..255) for \"color\"; an effect param needs no prior write and must sit in its catalog range. `easing` eases the segment leaving the key, or on the last key the one arriving at it; omitted, a new key inherits the easing of the segment it splits. Returns the key (`keyframe_id`, `t_us`, `local_t_us`). Sides, continuity, Auto tangents: update_keyframe.",
    inputSchema: { type: 'object', properties: { easing: EASING_SCHEMA, layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA, t_us: US_SCHEMA('Key time, timeline-absolute'), value: TRACK_VALUE_SCHEMA }, required: ['layer_id', 'param_key', 't_us', 'value'] },
    parseDedicated: (a) => {
      refuseUnknownArgs(a, ['layer_id', 'param_key', 't_us', 'value', 'easing'], 'set_keyframe', KEYFRAME_ARG_OWNERS)
      const paramKey = parseStr(a.param_key, 'param_key')
      return { layer: parseUuid(a.layer_id, 'layer_id'), param_key: paramKey,
        t_us: parseNum(a.t_us, 't_us'), value: parseTrackValue(a.value, paramKey, 'value'), easing: a.easing === undefined ? null : parseEasing(a.easing) }
    } },
  { name: 'get_param_track', exec: 'dedicated', annotations: ANN_READ,
    description: "Read a layer param's animation. `track` is exactly set_param_track's shape, to edit and send back as is: {\"mode\":\"Static\",\"value\":v} or {\"mode\":\"Keyframed\",\"value\":[{t_us, value, time_fraction?, in, out, continuity, segment}],\"extrapolate\"}, `t_us` timeline-absolute. Beside it, parallel to the keys: `keyframe_ids` (for update_keyframe / delete_keyframe), `local_t_us` (layer-local) and `preset_ids` (the easing preset the segment leaving each key matches, else null). `in`/`out` are tangents {x, y, mode} (\"Auto\" solved on write, \"Free\" authored); `segment` is {kind, …}, the class of the segment leaving the key — only Spline reads the tangents. An unset effect param reads as its catalog default. Position params are mode-specific: x/y in XY mode, path_progress in Path mode (a fraction).",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => {
      refuseUnknownArgs(a, ['layer_id', 'param_key'], 'get_param_track', KEYFRAME_ARG_OWNERS)
      return { layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key') }
    } },
  { name: 'delete_keyframe', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Remove a keyframe by id from a layer param (`keyframe_ids` in get_param_track). When it was the last key, the track collapses to Static holding that key's value. Returns the track's `mode` and `keyframe_ids`, or the static `value`.",
    inputSchema: { type: 'object', properties: { keyframe_id: ID_SCHEMA('Keyframe'), layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA }, required: ['keyframe_id', 'layer_id', 'param_key'] },
    parseDedicated: (a) => {
      refuseUnknownArgs(a, ['layer_id', 'param_key', 'keyframe_id'], 'delete_keyframe', KEYFRAME_ARG_OWNERS)
      return { layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'), param_key: parseStr(a.param_key, 'param_key') }
    } },
  { name: 'update_keyframe', exec: 'dedicated', annotations: ANN_SET,
    description: "Change one keyframe by id in one commit — any of: `t_us` (move it, timeline-absolute, snapped to the frame; the track re-sorts; a frame another key holds is refused, `KeyframeOccupied`), `easing` (as set_keyframe's: the segment leaving the key, or on the last key the one arriving at it; read back in preset_ids), `in` / `out` (one side's tangent {x, y}, stored Free — x within [0, 1], y may overshoot — its segment becoming Spline; a side written on an Auto key frees the whole key), `continuity` (\"Smooth\" re-derives in from out, \"Broken\" changes no number), `smooth: true` (both sides Auto, solved on write and kept smooth as neighbours move; the adjacent segments become Spline). At least one; applied in that order, `smooth` alone or with `t_us`. Returns the key.",
    inputSchema: { type: 'object', properties: {
      keyframe_id: ID_SCHEMA('Keyframe'),
      layer_id: LAYER_ID_SCHEMA,
      param_key: PARAM_KEY_SCHEMA,
      t_us: { type: 'integer', description: 'New timeline-absolute time, µs.' },
      easing: EASING_SCHEMA,
      in: TANGENT_XY_SCHEMA,
      out: TANGENT_XY_SCHEMA,
      continuity: { type: 'string', enum: ['Smooth', 'Broken'], description: 'Smooth keeps the two sides at one slope (re-derived from `out`); Broken lets them differ.' },
      smooth: { type: 'boolean', const: true, description: 'Auto tangents on both sides, Smooth continuity. Only true; a side written later frees the key.' },
    }, required: ['keyframe_id', 'layer_id', 'param_key'] },
    parseDedicated: (a) => {
      refuseUnknownArgs(a, ['layer_id', 'param_key', 'keyframe_id', 't_us', 'easing', 'in', 'out', 'continuity', 'smooth'], 'update_keyframe', KEYFRAME_ARG_OWNERS)
      const opt = <T>(k: string, f: (v: unknown) => T): T | null => {
        if (a[k] === null) throw new McpArgError(`update_keyframe: ${k} is null, which is not a value — omit it to leave the key's ${k} alone`, k)
        return a[k] === undefined ? null : f(a[k])
      }
      const smooth = opt('smooth', (v) => {
        if (v !== true) throw new McpArgError(`smooth takes only true (Auto tangents); a key leaves Auto when a side is written — send in or out`, 'smooth')
        return true
      })
      const p = {
        layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'), param_key: parseStr(a.param_key, 'param_key'),
        t_us: opt('t_us', (v) => parseNum(v, 't_us')),
        easing: opt('easing', (v) => parseEasing(v)),
        in: opt('in', (v) => parseTangentXy(v, 'in')),
        out: opt('out', (v) => parseTangentXy(v, 'out')),
        continuity: opt('continuity', (v) => parseContinuity(v)),
        smooth: smooth ?? false,
      }
      const shaping = (['easing', 'in', 'out', 'continuity'] as const).filter((k) => p[k] !== null)
      if (p.smooth && shaping.length > 0)
        throw new McpArgError(`update_keyframe: smooth sets both sides Auto, which ${shaping.join(', ')} would overwrite — send smooth alone (or with t_us)`, 'smooth')
      if (p.t_us === null && shaping.length === 0 && !p.smooth)
        throw new McpArgError(`update_keyframe needs at least one of t_us, easing, in, out, continuity, smooth — nothing to change`)
      return p
    } },
  { name: 'set_param_track', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Replace a whole param track in one undo step, discarding its keys: {\"mode\":\"Static\",\"value\":v}, or {\"mode\":\"Keyframed\",\"value\":[keys],\"extrapolate\"?} (Hold/Hold when omitted). A key needs only {t_us (timeline-absolute), value}; `easing` (as set_keyframe's) or in/out/segment/continuity shape the curve, else Linear. get_param_track's `track` is this shape and round-trips as is; IDs are generated, so omit them. Two keys snapping onto one frame are refused, naming both. A Text layer's static scale stays 1 (ADR 0049). Returns the committed keys `{keyframe_id, t_us, value}` and `extrapolate`, or the static `value`.",
    inputSchema: { type: 'object', properties: { layer_id: LAYER_ID_SCHEMA, param_key: PARAM_KEY_SCHEMA, track: ANIM_TRACK_SCHEMA }, required: ['layer_id', 'param_key', 'track'] },
    parseDedicated: (a, idGen) => {
      refuseUnknownArgs(a, ['layer_id', 'param_key', 'track'], 'set_param_track', KEYFRAME_ARG_OWNERS)
      const paramKey = parseStr(a.param_key, 'param_key')
      return { layer: parseUuid(a.layer_id, 'layer_id'), param_key: paramKey, track: parseAnimatedTrack(a.track, paramKey, idGen) }
    } },
  { name: 'create_checkpoint', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Create a named checkpoint of the current state and return `{ checkpoint_id, label }`. It lasts for this project opening only: opening another project or quitting drops it. It survives later commits (unlike the redo tail); `project://history` lists checkpoints and the agent panel shows each with a Restore button. `begin_agent_session` already makes one. Unrecorded.",
    inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'Checkpoint name.' } }, required: ['label'] },
    parseDedicated: (a) => ({ label: parseStr(a.label, 'label') }) },
  { name: 'export_captions', exec: 'dedicated', annotations: ANN_READ,
    description: "The captions of a composition as a subtitle document — `format` `srt` or `vtt` — read from every caption lane (or one `track_id`) in time order, with the cue text as it stands. `range` (start_export's) clips cues to it and shifts them to 0, in step with a range export. Returns `{ format, cues, body }`, plus the snapped `range`; write `body` to a file yourself. Records nothing.",
    inputSchema: { type: 'object', properties: {
      format: { type: 'string', enum: ['srt', 'vtt'], description: 'SubRip or WebVTT.' },
      track_id: { type: 'string', description: 'One caption lane only; omit for every caption lane of the composition.' },
      composition_id: CAPTIONS_COMPOSITION_ID_SCHEMA,
      range: { type: 'object', description: 'Snapped to the frame grid as start_export snaps it; omit for all cues.',
        properties: { t_start_us: US_SCHEMA('Inclusive start, timeline'), t_end_us: US_SCHEMA('Exclusive end, timeline') }, required: ['t_start_us', 't_end_us'], additionalProperties: false },
    }, required: ['format'] },
    parseDedicated: (a) => {
      refuseUnknownArgs(a, ['format', 'track_id', 'composition_id', 'range'], 'export_captions', { start_us: 'a span is range { t_start_us, t_end_us }', t_start_us: 'a span is range { t_start_us, t_end_us }', t_end_us: 'a span is range { t_start_us, t_end_us }' })
      let range: { t_start_us: number; t_end_us: number } | null = null
      if (a.range !== undefined && a.range !== null) {
        const r = parseObj(a.range, 'range')
        refuseUnknownKeys(r, ['t_start_us', 't_end_us'], 'range', 'export_captions range (timeline µs)')
        range = { t_start_us: parseIntNum(r.t_start_us, 'range.t_start_us'), t_end_us: parseIntNum(r.t_end_us, 'range.t_end_us') }
        if (range.t_start_us < 0 || range.t_end_us <= range.t_start_us) throw new McpArgError(`range must be a nonempty half-open span from t_start_us ≥ 0, got ${range.t_start_us}–${range.t_end_us}`, 'range')
      }
      return {
        format: parseOneOf(a.format, ['srt', 'vtt'], 'format'),
        track_id: a.track_id === undefined || a.track_id === null ? null : parseUuid(a.track_id, 'track_id'),
        composition_id: parseCompositionIdOpt(a.composition_id),
        range,
      }
    } },
  { name: 'restore_checkpoint', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Restore a named checkpoint. Records a new history entry — undo will return to the pre-restore state. Errors with CheckpointNotFound if the id doesn't exist. The agent panel preserves activity and inserts a restore boundary; only edits with known history provenance are marked reverted.",
    inputSchema: { type: 'object', properties: { checkpoint_id: ID_SCHEMA('Checkpoint') }, required: ['checkpoint_id'] },
    parseDedicated: (a) => ({ checkpoint_id: parseUuid(a.checkpoint_id, 'checkpoint_id') }) },
  { name: 'end_agent_session', exec: 'dedicated', annotations: ANN_WRITE,
    description: "End your work session and release its history lock; the view, activity, running tasks and connection stay. Only the owning connection may end it (`begin_agent_session { force: true }` takes over a stale one). Unless your last `check_composition` is current, the app audits first; hard or warning findings keep the session open (`ended: false, held: \"audit\"`): settle them and end again. Answers `{ ended, audit }` (`ended`: the closed session, null with none), plus `tacks_to_review` when open tacks are outdated. Unrecorded.",
    inputSchema: { type: 'object', properties: {} },
    parseDedicated: (_a) => ({}) },
  { name: 'begin_agent_session', exec: 'dedicated', annotations: ANN_SET,
    description: "Begin a work session for a batch: one Pre-agent checkpoint, the review baseline pinned to it, and the lightweight agent view. `lock` (default true) locks the user's undo until the session ends, `reason` shown in its place; your own undo, redo, jump_to and restore_checkpoint still work. Repeating on the same connection returns the session, changing the lock only when `lock` is passed. Another connection's session refuses (`AgentSessionBusy` names the holder) unless `force: true` ends it and begins yours. `end_agent_session`, the user or your connection closing ends it. Answers the session with `locked`, and `taken_over` after a force. Unrecorded.",
    inputSchema: { type: 'object', properties: {
      reason: { type: 'string', description: 'What this work session is for; shown to the user beside the busy badge and in place of undo.' },
      lock: { type: 'boolean', description: "Lock the user's undo for the session. Default true; false leaves it free." },
      force: { type: 'boolean', description: "End another connection's session (its owner gone) and begin yours. Default false." },
    }, required: ['reason'] },
    parseDedicated: (a) => ({ reason: parseStr(a.reason, 'reason'), lock: a.lock === undefined ? undefined : parseBool(a.lock, 'lock'), force: parseBoolOpt(a.force, 'force', false) }) },
  // ── tacks (ADR 0115) — served by the MCP host's TackStore beside the agent
  //    activity (`mcp/tackTools.ts`), not by the actor: they are not project
  //    state, record nothing and ignore the history lock. A bare actor refuses. ──
  // The audit (spec H1-D5): served by the host, which remembers the result so
  // end_agent_session and start_export can say whether it is still fresh.
  { name: 'check_composition', exec: 'dedicated', annotations: ANN_READ,
    description: "Check a composition against the craft rules (skill craft/rules.md) and the project's taste: `{ composition_id, revision, findings: [{ severity, rule, range, layers, message, fix }], counts }`. `hard`: fix before handoff; `warning`: fix, or leave a tack saying why not; `review`: a departure from the style to confirm. Project data only — text extents are estimated. The whole composition is checked and remembered; `t_start_us`/`t_end_us` only narrow the findings returned. Run it after your edits and after fixing.",
    inputSchema: { type: 'object', properties: {
      composition_id: { type: 'string', description: "A Group's composition; omit for the root." },
      t_start_us: US_SCHEMA('Only findings overlapping from here, timeline'),
      t_end_us: US_SCHEMA('…to here; give both or neither'),
    } },
    parseDedicated: (a) => {
      const t0 = parseNumOpt(a.t_start_us, 't_start_us'), t1 = parseNumOpt(a.t_end_us, 't_end_us')
      if ((t0 === undefined) !== (t1 === undefined)) throw new McpArgError('t_start_us and t_end_us go together: give both or neither', 't_end_us')
      if (t0 !== undefined && t1 !== undefined && !(t1 > t0)) throw new McpArgError('t_end_us must be after t_start_us', 't_end_us')
      return { composition_id: parseCompositionIdOpt(a.composition_id), range: t0 === undefined ? null : [t0, t1] }
    } },
  { name: 'create_tacks', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Point the user at time ranges to review — a pause to check, a shot to judge, a cut to decide. Not a marker: it lives in the agent panel for this project opening only; the user resolves, dismisses or clears it; use it unless the user asked for markers. Create after your edits; all or none. It comments on what plays in its range on every track: it moves with that content and is outdated once the range plays anything else. Describe content, never times: the panel shows the live place. One place, one tack. Returns `{ tack_ids, hints? }`; your later edits report your moved or outdated tacks as `affected_tacks`. `TackLimit` past 1000. Unrecorded; works while history is locked.",
    inputSchema: { type: 'object', properties: {
      tacks: { type: 'array', minItems: 1, description: 'The tacks to create, validated together: one refusal creates none.',
        items: { type: 'object', additionalProperties: false, required: ['label', 't_us'], properties: {
          label: { type: 'string', maxLength: TACK_LABEL_LIMIT, description: 'A few words naming the content — the panel row and the timeline band show it.' },
          body: { type: 'string', maxLength: TACK_BODY_LIMIT, description: 'Plain-text detail; default empty.' },
          kind: { type: 'string', enum: [...TACK_KINDS], description: 'note (default) informs; issue flags a problem; question asks the user to decide.' },
          t_us: US_SCHEMA('Start, on the composition timeline'),
          end_t_us: US_SCHEMA('Range end, timeline; omit for a point'),
          composition_id: { type: 'string', description: "A Group's composition; omit for the root." },
        } } },
    }, required: ['tacks'] },
    parseDedicated: (a) => {
      const list = asNonEmptyArray(a.tacks, 'tacks', 'send at least one tack') as unknown[]
      return { tacks: list.map((v, i) => parseTackInput(v, `tacks[${i}]`)) }
    } },
  { name: 'update_tack', exec: 'dedicated', annotations: ANN_SET,
    description: "Change a tack's label, body, kind or status — `resolved` once you fixed what it pointed at, `dismissed` when it no longer matters, `open` to raise it again. At least one field. Its place is fixed at creation; to move one, delete and create it again. Returns the tack as project://tacks reads it. Unrecorded.",
    inputSchema: { type: 'object', properties: {
      tack_id: ID_SCHEMA('Tack'),
      patch: { type: 'object', additionalProperties: false, description: 'Only the fields you set apply.', properties: {
        label: { type: 'string', maxLength: TACK_LABEL_LIMIT, description: 'A few words.' },
        body: { type: 'string', maxLength: TACK_BODY_LIMIT, description: 'Plain-text detail.' },
        kind: { type: 'string', enum: [...TACK_KINDS], description: 'note | issue | question.' },
        status: { type: 'string', enum: [...TACK_STATUSES], description: 'open | resolved | dismissed.' },
      } },
    }, required: ['tack_id', 'patch'] },
    parseDedicated: (a) => ({ tack_id: parseUuid(a.tack_id, 'tack_id'), patch: parseTackPatch(a.patch) }) },
  { name: 'delete_tacks', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Remove tacks: the listed `tack_ids` (every one must exist, or none is removed), or every tack created in work session `session_id`. Exactly one of the two. Returns `{ deleted_tack_ids }`. Unrecorded.",
    inputSchema: { type: 'object', properties: {
      tack_ids: { type: 'array', items: { type: 'string', description: 'Tack id.' }, minItems: 1, description: 'The tacks to remove.' },
      session_id: { type: 'string', description: 'A work session id (project://session); removes every tack created in it.' },
    } },
    parseDedicated: (a) => {
      const hasIds = a.tack_ids !== undefined && a.tack_ids !== null
      const hasSession = a.session_id !== undefined && a.session_id !== null
      if (hasIds === hasSession) throw new McpArgError('delete_tacks takes exactly one of tack_ids or session_id', hasIds ? 'session_id' : 'tack_ids')
      if (hasSession) return { session_id: parseUuid(a.session_id, 'session_id') }
      return { tack_ids: asNonEmptyArray(a.tack_ids, 'tack_ids', 'name at least one tack, or pass session_id').map((v, i) => parseUuid(v, `tack_ids[${i}]`)) }
    } },
  // ── hybrid defs (TS-owned) — executed by runHybrid (routeMcpTool → 'hybrid'),
  //    NOT actor.mcpCall arms. They live here (not the Rust catalog like the
  //    other hybrids) because their input computes in Rust — the shot report,
  //    the waveform peaks — while the edit writes through the TS actor, so the
  //    def has to merge into the advertised catalog from the TS side.
  //    parseDedicated is the bijection gate's required-scalar check only;
  //    runHybrid re-validates layer_id itself. apply_subtitles is the same
  //    split: Rust parses the document, the TS side reads the pool item and
  //    writes the cues. ──
  { name: 'apply_subtitles', exec: 'dedicated', annotations: ANN_WRITE,
    description: "Lay an imported `Subtitle` item (a .srt/.vtt/.ass from `import_media`) onto the caption tracks as one editable Text layer per cue, one recorded edit. The whole document lands, its time 0 at `t_start_us`. Each cue packs onto the first unlocked caption track with room, opening a new one only where it collides with all of them. Advanced ASS styling is simplified. Returns `{ caption_track_id, cues, simplified }`.",
    inputSchema: { type: 'object', properties: { media_id: ID_SCHEMA('Subtitle media'), t_start_us: US_SCHEMA('Where the document\'s time 0 lands on the timeline; default 0'), composition_id: COMPOSITION_ID_SCHEMA }, required: ['media_id'] },
    parseDedicated: (a) => {
      const t = parseNumOpt(a.t_start_us, 't_start_us') ?? 0
      if (!Number.isInteger(t) || t < 0) throw new McpArgError(`t_start_us must be a non-negative integer, got ${String(a.t_start_us)}`, 't_start_us')
      return { media: parseUuid(a.media_id, 'media_id'), t_start_us: t, composition_id: parseCompositionIdOpt(a.composition_id) }
    } },
  { name: 'auto_split_by_shot', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Split a VideoClip at cached analyze_clip shot cuts as one edit. min_shot_us defaults to 500000. drop_short deletes shorter shots and overlapping link members. Returns layer_ids in timeline order (the original id alone when no interior cut exists) and `siblings: [{ layer_id, segments }]`, each link partner cut with it.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string', description: 'The VideoClip to split.' }, min_shot_us: US_SCHEMA('Shortest shot to keep; default 500000'), drop_short: { type: 'boolean', description: 'Also delete segments shorter than min_shot_us, with the overlapping members of their link. Default false.' } }, required: ['layer_id'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), min_shot_us: parseNumOpt(a.min_shot_us, 'min_shot_us'), drop_short: parseBoolOpt(a.drop_short, 'drop_short', false) }) },
  { name: 'remove_pauses', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Cut pauses out of the audio a clip plays and ripple downstream, as one edit. `layer_id` is an Audio layer, or a VideoClip read through its linked Audio member; link members are cut together, on the frame grid when picture is linked. `pauses` cuts exactly those ranges (`detect_pauses` output, e.g. the subset the user kept); without it the clip is detected at `threshold_db` / `min_pause_us` (detect_pauses' defaults). `pad_us` keeps 100000 µs of each pause on each side; a pause at a clip edge trims whole. Returns `{ surviving_layer_ids, removed, removed_us }`. To review first: `detect_pauses`, then one `create_tacks` batch. Refuses whole, before any write: `RippleInsideHole` (a layer on another track starts inside a pause), `RippleCollision`, `RippleLinkStraddles`, `RippleLockedLayer` / `TrackLocked`, `InvalidArgument` (pad too large, a pause outside the clip or overlapping another, a clip silent end to end).",
    inputSchema: { type: 'object', properties: {
      layer_id: { type: 'string', description: 'Target Audio layer id, or a VideoClip id that delegates to its linked Audio layer.' },
      pauses: { type: 'array', minItems: 1, maxItems: REMOVE_PAUSES_MAX, description: 'Timeline ranges to cut, as `detect_pauses` returned them; replaces detection, so not with `threshold_db` / `min_pause_us`.', items: { type: 'object', properties: {
        t_start_us: US_SCHEMA('Pause start, timeline'), t_end_us: US_SCHEMA('Pause end (exclusive), timeline'),
      }, required: ['t_start_us', 't_end_us'], additionalProperties: false } },
      threshold_db: { type: 'number', description: "Peak threshold, dBFS (≤ 0), as `detect_pauses` takes it. Omit for its default." },
      min_pause_us: { type: 'integer', description: "Shortest pause worth removing, µs, as `detect_pauses` takes it. Omit for its default." },
      pad_us: { type: 'integer', description: 'Microseconds of each pause KEPT on each side. Default 100000; 0 erases each pause whole. Must satisfy 2 * pad_us < min_pause_us.' },
    }, required: ['layer_id'] },
    parseDedicated: (a) => {
      strictKeys(a, ['layer_id', 'pauses', 'threshold_db', 'min_pause_us', 'pad_us'], 'remove_pauses', { threshold_amp: 'send threshold_db (dBFS)' })
      const pauses = parseReviewedPauses(a)
      const threshold_db = parseNumOpt(a.threshold_db, 'threshold_db')
      if (threshold_db !== undefined && !(threshold_db <= 0)) throw new McpArgError(`threshold_db ${threshold_db} must be at or below 0 dBFS`, 'threshold_db')
      return { layer: parseUuid(a.layer_id, 'layer_id'), threshold_db, min_pause_us: parseNumOpt(a.min_pause_us, 'min_pause_us'), pad_us: parseNumOpt(a.pad_us, 'pad_us'), ...(pauses ? { pauses } : {}) }
    } },
  // ── dedicated-exec: reads, for a client without MCP resources ─────────────
  { name: 'read_project', exec: 'dedicated', annotations: ANN_READ,
    description: "The `project://*` views as a tool result, for clients without resources. `view`: `current`, `composition`, `compositions`, `media` (with `id`, one item's card), `tracks` (layer envelopes), `layer` (needs `id`), `markers`, `links`, `transitions`, `settings` (preferences + metadata), `history`, `session` (who holds the session), `effects` (effects catalog), `tacks` (review tacks; `composition_id` narrows), `taste` (style tokens + provenance), `media_thumbnail` / `media_frame` (an IMAGE; `id` is the media id, `media_frame` takes `src_us`). `composition`, `tracks`, `markers`, `links`, `transitions` take `composition_id` for a Group's, the root when omitted. JSON views answer as text.",
    inputSchema: { type: 'object', properties: {
      view: { type: 'string', enum: [...READ_PROJECT_VIEWS], description: 'Which view to read.' },
      id: { type: 'string', description: 'The layer id for view `layer`; the media id for `media` (optional) / `media_thumbnail` / `media_frame`.' },
      src_us: { type: 'integer', description: 'For `media_frame`: the frame time in the source, µs.' },
      composition_id: { type: 'string', description: 'For the per-composition views: a Group\'s composition; omit for the root.' },
    }, required: ['view'] },
    parseDedicated: (a) => {
      const view = parseStr(a.view, 'view')
      if (!READ_PROJECT_VIEWS.includes(view as ReadProjectView)) throw new McpArgError(`view must be one of ${READ_PROJECT_VIEWS.join(', ')}, got '${view}'`, 'view')
      const needsId = view === 'layer' || view === 'media_thumbnail' || view === 'media_frame'
      if (needsId && (a.id === undefined || a.id === null)) throw new McpArgError(`view '${view}' needs \`id\` — ${view === 'layer' ? 'the layer id (project://tracks lists them)' : 'the media id (project://media lists them)'}`, 'id')
      if (view === 'media_frame' && (a.src_us === undefined || a.src_us === null)) throw new McpArgError("view 'media_frame' needs `src_us` — the frame time in the source, µs (media_thumbnail takes none)", 'src_us')
      const src_us = view === 'media_frame' ? parseNum(a.src_us, 'src_us') : null
      const takesId = needsId || (view === 'media' && a.id !== undefined && a.id !== null)
      return { view, id: takesId ? parseUuid(a.id, 'id') : null, src_us, composition_id: parseCompositionIdOpt(a.composition_id) }
    } },
  // ── projects — executed by the MCP host (`mcp/projectTools.ts`), not the
  //    actor: opening swaps the actor's whole state and the renderer follows.
  //    Both answer while no project is open (`APP_SCOPE_TOOLS`).
  { name: 'open_project', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Open a project folder (the one holding project.json) in the editor, as the start screen's Open does; only one the user asked for. The project open before is saved; its undo history is dropped. The folder already open is not reloaded and answers `already_open: true`. Recent projects: `read_project { view: \"session\" }`. Returns `{ name, dir, replaced, already_open }`.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the project folder.' } }, required: ['path'] },
    parseDedicated: (a) => ({ path: parseAbsolutePath(a.path, 'path') }) },
  { name: 'create_project', exec: 'dedicated', annotations: ANN_DESTRUCTIVE,
    description: "Create `<parent_folder>/<name>` and open it, as New Project does; only when the user asked. The project open before is saved. Defaults: the session view's `default_parent_folder`; 1920x1080 at 60 fps (the rate locks once a layer is placed). Returns `{ name, dir, replaced }`.",
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Folder and project name.' },
      parent_folder: { type: 'string', description: 'Absolute folder to create in.' },
      width: { type: 'integer', description: 'Even px, 16..7680; with `height`.' },
      height: { type: 'integer', description: 'Even px, 16..7680; with `width`.' },
      fps: { type: 'object', description: '24, 25, 30, 50, 60, or 24000/30000/60000 over 1001.', properties: { num: { type: 'integer', description: 'Numerator.' }, den: { type: 'integer', description: 'Denominator.' } }, required: ['num', 'den'] },
    }, required: ['name'] },
    parseDedicated: (a) => parseCreateProject(a) },
]

/** An absolute path, Windows (`C:\…`, `\\server\…`) or POSIX (`/…`). A relative
 *  one would resolve against the app's working directory, which no caller can
 *  see. */
function parseAbsolutePath(v: unknown, field: string): string {
  const p = parseStr(v, field).trim()
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)) throw new McpArgError(`${field} must be an absolute path; got '${p}'`, field)
  return p
}

/** English for the New Project dialog's name rules (`shared/newProject.ts`). */
const PROJECT_NAME_PROBLEM: Record<string, string> = {
  'new_project.validation_empty': 'name is required',
  'new_project.validation_whitespace': "name can't start or end with whitespace",
  'new_project.validation_invalid_chars': 'name can\'t contain any of \\ / : * ? " < > |',
  'new_project.validation_trailing_dot': "name can't end with a period",
  'new_project.validation_reserved': 'name is one the OS reserves (CON, NUL, COM1…) — pick another',
}

function parseCreateProject(a: Record<string, unknown>): Record<string, unknown> {
  const name = parseStr(a.name, 'name')
  const nameProblem = validateProjectName(name)
  if (nameProblem) throw new McpArgError(PROJECT_NAME_PROBLEM[nameProblem] ?? nameProblem, 'name')
  const parent = a.parent_folder === undefined || a.parent_folder === null ? null : parseAbsolutePath(a.parent_folder, 'parent_folder')
  if ((a.width === undefined) !== (a.height === undefined)) throw new McpArgError('send width and height together, or neither for 1920x1080', a.width === undefined ? 'width' : 'height')
  const width = a.width === undefined ? DEFAULT_CANVAS.width : parseNum(a.width, 'width')
  const height = a.height === undefined ? DEFAULT_CANVAS.height : parseNum(a.height, 'height')
  const size = canvasSizeError(width, height)
  if (size) {
    const why = size.key === 'canvas.size_range' ? `width and height must be between ${CANVAS_MIN} and ${CANVAS_MAX}`
      : size.key === 'canvas.size_odd' ? 'width and height must be whole even numbers'
      : 'the canvas cannot exceed 8K (7680 × 4320) in total area'
    throw new McpArgError(`${why}; got ${width}x${height}`, 'width')
  }
  let fps = { num: DEFAULT_CANVAS.fpsNum, den: DEFAULT_CANVAS.fpsDen }
  if (a.fps !== undefined) {
    const f = parseObj(a.fps, 'fps')
    fps = { num: parseNum(f.num, 'fps.num'), den: parseNum(f.den, 'fps.den') }
    if (!FPS_OPTIONS.some((o) => o.num === fps.num && o.den === fps.den)) {
      throw new McpArgError(`fps ${fps.num}/${fps.den} is not a WeftCut rate; one of ${FPS_OPTIONS.map((o) => `${o.num}/${o.den}`).join(', ')}`, 'fps')
    }
  }
  return { name, parent_folder: parent, width, height, fps_num: fps.num, fps_den: fps.den }
}

/** One `create_tacks` entry: a closed key set, a label of a few words, and
 *  the times as integers — what `TackStore` validates against the project. */
function parseTackInput(v: unknown, field: string): Record<string, unknown> {
  const o = parseObj(v, field)
  const keys = ['label', 'body', 'kind', 't_us', 'end_t_us', 'composition_id']
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new McpArgError(`${field}: unknown key '${k}'; expected ${keys.join(', ')}`, field)
  return {
    label: parseTackLabel(o.label, `${field}.label`),
    body: o.body === undefined || o.body === null ? '' : parseTackBody(o.body, `${field}.body`),
    kind: o.kind === undefined || o.kind === null ? 'note' : parseOneOf(o.kind, TACK_KINDS, `${field}.kind`),
    t_us: parseIntNum(o.t_us, `${field}.t_us`),
    end_t_us: o.end_t_us === undefined || o.end_t_us === null ? null : parseIntNum(o.end_t_us, `${field}.end_t_us`),
    composition_id: o.composition_id === undefined || o.composition_id === null ? null : parseUuid(o.composition_id, `${field}.composition_id`),
  }
}
function parseTackLabel(v: unknown, field: string): string {
  const label = parseStr(v, field).trim()
  if (label === '') throw new McpArgError(`${field} must be non-empty — a few words naming what to review`, field)
  if (label.length > TACK_LABEL_LIMIT) throw new McpArgError(`${field} is ${label.length} characters; at most ${TACK_LABEL_LIMIT} — put the detail in body`, field)
  return label
}
function parseTackBody(v: unknown, field: string): string {
  const body = parseStr(v, field)
  if (body.length > TACK_BODY_LIMIT) throw new McpArgError(`${field} is ${body.length} characters; at most ${TACK_BODY_LIMIT}`, field)
  return body
}
function parseTackPatch(v: unknown): Record<string, unknown> {
  const o = parseObj(v, 'patch')
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || o[k] === null) continue
    if (k === 'label') out.label = parseTackLabel(o.label, 'patch.label')
    else if (k === 'body') out.body = parseTackBody(o.body, 'patch.body')
    else if (k === 'kind') out.kind = parseOneOf(o.kind, TACK_KINDS, 'patch.kind')
    else if (k === 'status') out.status = parseOneOf(o.status, TACK_STATUSES, 'patch.status')
    else throw new McpArgError(`invalid patch: unknown key '${k}' — expected { label?, body?, kind?, status? }`, 'patch')
  }
  if (Object.keys(out).length === 0) throw new McpArgError('update_tack needs at least one of label, body, kind, status — nothing to change', 'patch')
  return out
}

const DEF_BY_NAME: Map<string, McpToolDef> = new Map(MCP_TOOL_DEFS.map((d) => [d.name, d]))
export function mcpDef(name: string): McpToolDef { const d = DEF_BY_NAME.get(name); if (!d) throw new Error(`no MCP def for ${name}`); return d }

/** MCP tool → internal dispatch op + renamed args. Projection of MCP_TOOL_DEFS.
 *  Explicit-param tools (add_layers/add_marker/split_layer
 *  etc.) are NOT here — they have dedicated arms in actor.mcpCall. */
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>, idGen?: IdGen) => { op: string; args: Record<string, unknown> }> =
  Object.fromEntries(MCP_TOOL_DEFS.flatMap((d) => d.parseArgs ? [[d.name, d.parseArgs] as const] : []))

/** All MCP tools this adapter handles (parsers + the dedicated arms). Projection of MCP_TOOL_DEFS. */
export const MCP_TOOLS: ReadonlySet<string> = new Set(MCP_TOOL_DEFS.map((d) => d.name))

function parseRetimeTarget(value: unknown): import('../../shared/timeMapping').RetimeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpArgError('target must be Rate or Duration', 'target');
  const t = value as Record<string, unknown>;
  if (t.kind === 'Duration' && Number.isSafeInteger(t.duration_us) && (t.duration_us as number) > 0 && Object.keys(t).every(k => ['kind', 'duration_us'].includes(k))) return { kind: 'Duration', duration_us: t.duration_us as number };
  if (t.kind === 'Rate' && t.value && typeof t.value === 'object' && Object.keys(t).every(k => ['kind', 'value'].includes(k))) {
    const r = t.value as Record<string, unknown>;
    if (Number.isSafeInteger(r.num) && Number.isSafeInteger(r.den) && (r.num as number) > 0 && (r.den as number) > 0 && Object.keys(r).every(k => ['num', 'den'].includes(k)))
      return { kind: 'Rate', value: { num: r.num as number, den: r.den as number } };
  }
  throw new McpArgError('target requires a positive rational Rate or integer Duration', 'target');
}
function parseTimeFraction(v: unknown) {
  try { const fraction = readExactTime(v); validateTimeFraction(fraction); return fraction; }
  catch { throw new McpArgError('time_fraction must be a reduced fraction with 0 <= num < den', 'time_fraction'); }
}
