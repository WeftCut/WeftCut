import type { Animated, AudioParams, AudioRole, BlendMode, ColorParams, CompositionRefParams, ImageOverlayParams, Layer, MotifParams, Project, Rgba, TextAlign, TextParams, Uuid, VAlign, VideoClipParams } from '../model'
import { CommandFailure } from '../errors'
import { snapFrameFloor, snapFrameCeil, gridForLayerKind, snapOnGrid } from '../snap'
import { authoredExtentPx, authoredValue, quantizeTrack } from '../quantize'
import { checkTrackLock, applyDurationAutofit, requireLayer } from './helpers'
import { normalizeKeyframes } from './animated'
import type { MotifCatalog } from '../../../shared/motifs/catalog'
import { resolveMotifMaxDurUs } from '../../../shared/motifs/catalog'

/** Internally-tagged ("kind") param patch. Every field optional bar kind;
 *  absent = "don't touch".
 *
 *  Text carries no `scale_x`/`scale_y` on purpose: an agent asking for a bigger
 *  title gets a bigger BOX, because the box lays glyphs out and scale magnifies
 *  the rendered result (ADR 0049). `box_w`/`box_h` are the one pair where
 *  `null` is a value distinct from absent — see the `case 'Text'` merge. */
export type LayerParamsPatch =
  | { kind: 'Text'; content?: string; font_family?: string; font_size_px?: number; color?: Rgba; x?: number; y?: number; opacity?: number; align?: TextAlign; valign?: VAlign; box_w?: number | null; box_h?: number | null; line_height?: number; letter_spacing?: number }
  | { kind: 'VideoClip'; src_in_us?: number; src_out_us?: number; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; speed?: number; flip_h?: boolean; flip_v?: boolean; fade_in_us?: number; fade_out_us?: number }
  | { kind: 'ImageOverlay'; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; fade_in_us?: number; fade_out_us?: number }
  | { kind: 'Motif'; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; src_in_us?: number; motif_id?: string; motif_version?: number; props?: Record<string, unknown> }
  | { kind: 'Color'; color?: Rgba; width?: number; height?: number }
  | { kind: 'Audio'; src_in_us?: number; src_out_us?: number; gain_db?: number; pan?: number; fade_in_us?: number; fade_out_us?: number; mute?: boolean; role?: AudioRole }
  /** A Group layer (ADR 0052 §4). The media-bearing set minus what v1 leaves
   *  out: no `speed` (AE's time-remap), no `crop`, no `flip_*`, no ref-level
   *  audio gain. `src_in_us`/`src_out_us` take NO upper bound here — overhang
   *  past the composition's duration is legal in state and clamped at the
   *  gesture (ADR 0052 §6), so this path can set the window a trim drag would
   *  not.
   *
   *  `blend_mode` is the ONE patchable blend field in this table, and only
   *  because the Ungroup gate names it: `groupNotPlainReason` refuses a
   *  non-Normal blend, and a reason no command can reach is a dead branch.
   *  Every other kind stores `blend_mode` and no surface writes it yet. */
  | { kind: 'CompositionRef'; src_in_us?: number; src_out_us?: number; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; blend_mode?: BlendMode }

const stat = <T>(value: T): Animated<T> => ({ mode: 'Static', value })

/** `authoredValue` lifted over the patch convention that absent = "don't touch".
 *
 *  Every arm below resolves ALL of its numerics through this before its first
 *  assignment, never inline at the assignment. `authoredValue` can refuse (a
 *  ranged field, out of range), and a refused patch must leave the project
 *  byte-identical — the same ordering rule the text-box mode check states in
 *  full. Inline, an out-of-range `opacity` would land after `content` and
 *  `color` had already been written. */
const authored = (key: string, v: number | undefined): number | undefined =>
  v === undefined ? undefined : authoredValue(key, v)

/** The transform numerics VideoClip / ImageOverlay / Motif all carry, resolved
 *  together so that ALL of them can refuse before ANY of them is written. */
interface AuthoredTransform {
  x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number
}

function authoredTransform(patch: {
  x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number
}): AuthoredTransform {
  /** A shape predicate on scale, not a range — which is why it is not in
   *  PARAM_PRECISION. A NEGATIVE factor is a mirror and deliberately
   *  first-class (`gizmoGeometry` is written to be flip-aware), so the only
   *  illegal value is ZERO: at zero the box collapses, `localDelta` answers
   *  null, and there is no lever left to scale back by.
   *
   *  Tested AFTER rounding, because rounding is what reaches the degenerate
   *  value: 0.0004 passes any raw `!== 0` test and then records as 0. */
  const scale = (key: 'scale_x' | 'scale_y'): number | undefined => {
    const q = authored(key, patch[key])
    if (q === 0) {
      throw new CommandFailure({ error: 'InvalidArgument', field: key,
        detail: `${key} cannot be 0 — a zero axis collapses the layer with no way to scale it back. Got ${patch[key]}, which records as 0; send a small non-zero factor, or a negative one to mirror.` })
    }
    return q
  }
  return {
    x: authored('x', patch.x),
    y: authored('y', patch.y),
    scale_x: scale('scale_x'),
    scale_y: scale('scale_y'),
    opacity: authored('opacity', patch.opacity),
  }
}

/** The Text enums, as values — the patch arrives from MCP as untyped JSON, so the
 *  types alone guard nothing at runtime. Listed here and not in `model.ts` because
 *  this is the only site that needs them as data. */
const TEXT_ALIGNS: readonly TextAlign[] = ['Left', 'Center', 'Right']
const VALIGNS: readonly VAlign[] = ['Top', 'Middle', 'Bottom']
/** `BlendMode`'s variants as values, for the same reason: MCP hands this arm
 *  untyped JSON, and an unrecognised mode reaches the renderer's blend table as
 *  `undefined`, i.e. a layer composited by no rule at all. */
const BLEND_MODES: readonly BlendMode[] = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'Add', 'Difference']

/** apply_params_patch — kind-matched field merge; a discriminant
 *  mismatch is the only error. Animated fields collapse to Static(v) (MVP: this
 *  overwrites any keyframe track). Motif props merge field-wise (never replace). */
export function applyParamsPatch(layer: Layer, patch: LayerParamsPatch): void {
  const p = layer.params
  if (p.kind !== patch.kind) {
    throw new CommandFailure({ error: 'LayerParamsKindMismatch', layer: layer.id, actual: p.kind, patch: patch.kind })
  }
  switch (patch.kind) {
    case 'Text': {
      const t = p as TextParams
      // MCP hands this layer untyped JSON (`parseObj` + a cast), so the Text arm's
      // enums and box numbers are checked here rather than trusted. It is the edge
      // half of ADR 0049's pair — refuse at the edge, never blank the screen
      // mid-render — and the renderer's coalescing is the other half. Unchecked,
      // `valign: 'Center'` reaches `VALIGN_FRAC[valign]` as `undefined` and lands a
      // NaN anchor on the sprite, which is a VANISHED layer rather than a
      // misplaced one.
      if (patch.align !== undefined && !TEXT_ALIGNS.includes(patch.align)) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'align', detail: `align must be one of ${TEXT_ALIGNS.join(' | ')}` })
      }
      if (patch.valign !== undefined && !VALIGNS.includes(patch.valign)) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'valign', detail: `valign must be one of ${VALIGNS.join(' | ')}` })
      }
      // A box axis is either null (auto) or a real positive extent, authored in
      // WHOLE composition pixels: the box lays glyphs out (ADR 0049), so half a
      // pixel of line-breaking width is not something an author means. Zero and
      // negative are refused because they are not a narrow box, they are a broken
      // mode — the renderer reads a non-positive width as "no box" and would render
      // Auto width while state claimed Fixed. Deliberately NOT the gesture's 8 px
      // floor: that one is a drag ergonomic, and a 4 px box an agent asks for on
      // purpose is legal, just silly.
      //
      // `authoredExtentPx` rounds first and checks after, which is the only order
      // that catches `0.4` — a value that passes a raw `> 0` test and then records
      // as exactly the zero box the check exists to refuse. Resolved here, once, so
      // the mode check below and the assignments further down all see what will
      // actually be stored.
      const boxPx = (field: 'box_w' | 'box_h'): number | null | undefined => {
        const v = patch[field]
        return v === undefined || v === null ? v : authoredExtentPx(field, v, ', or null for auto')
      }
      const boxWPatch = boxPx('box_w')
      const boxHPatch = boxPx('box_h')
      const xP = authored('x', patch.x)
      const yP = authored('y', patch.y)
      const opacityP = authored('opacity', patch.opacity)
      for (const field of ['line_height', 'letter_spacing'] as const) {
        const v = patch[field]
        if (v !== undefined && !Number.isFinite(v)) {
          throw new CommandFailure({ error: 'InvalidArgument', field, detail: `${field} must be a finite number` })
        }
      }
      // A shape predicate, not a range: there is no sensible upper bound on type
      // size, but zero and negative are not small type, they are no glyphs at all.
      // Hand-written rather than table-driven for the reason every refusal here is
      // — the detail line is the only channel an agent can correct itself from, and
      // a generated `must be in (0, Inf)` would not name what to send instead.
      if (patch.font_size_px !== undefined && !(Number.isFinite(patch.font_size_px) && patch.font_size_px > 0)) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'font_size_px',
          detail: `font_size_px must be a positive number of composition pixels — got ${patch.font_size_px}` })
      }
      // The resize mode IS the box nullability — (null, null) auto width,
      // (set, null) auto height, (set, set) fixed — so (null, set) is no mode at
      // all. A gesture reaching that pair backfills the width it measured in the
      // same commit; this layer has no canvas, and inventing a width would be the
      // silent clamp ADR 0048 rules out, so MCP's route to it refuses. Refusing
      // BEFORE the first write is load-bearing: a rejected patch must leave the
      // project byte-identical. A patch touching NEITHER box field still passes
      // through an already-illegal (hand-edited) layer, which the renderer
      // coalesces to auto width — refusing there would make the file unfixable.
      if (patch.box_w !== undefined || patch.box_h !== undefined) {
        const w = boxWPatch !== undefined ? boxWPatch : t.box_w
        const h = boxHPatch !== undefined ? boxHPatch : t.box_h
        if (w === null && h !== null) {
          throw new CommandFailure({ error: 'InvalidArgument', field: 'box_h',
            detail: 'a text box height with no width is not a resize mode: send box_w in the same patch for fixed, or leave box_h null — the modes are (null, null) auto width, (set, null) auto height, (set, set) fixed' })
        }
      }
      if (patch.content !== undefined) t.content = patch.content
      if (patch.font_family !== undefined) t.font.family = patch.font_family
      if (patch.font_size_px !== undefined) t.font.size_px = patch.font_size_px
      if (patch.color !== undefined) t.color = stat(patch.color)
      if (xP !== undefined) t.transform.x = stat(xP)
      if (yP !== undefined) t.transform.y = stat(yP)
      if (opacityP !== undefined) t.opacity = stat(opacityP)
      if (patch.align !== undefined) t.align = patch.align
      if (patch.valign !== undefined) t.valign = patch.valign
      // On the box pair the absent/null split is LOAD-BEARING, not the incidental
      // "don't touch" it is everywhere else: null is the only way to say "back to
      // auto", so an `=== undefined` guard here is the whole wire contract.
      if (patch.box_w !== undefined) t.box_w = boxWPatch as number | null
      if (patch.box_h !== undefined) t.box_h = boxHPatch as number | null
      if (patch.line_height !== undefined) t.line_height = patch.line_height
      if (patch.letter_spacing !== undefined) t.letter_spacing = patch.letter_spacing
      return
    }
    case 'VideoClip': {
      const v = p as VideoClipParams
      const a = authoredTransform(patch)
      // Another shape predicate: speed scales a duration, so zero is a division
      // by zero downstream and negative is not "backwards", it is a negative
      // span. No upper bound — a 50× ramp is a legitimate effect.
      if (patch.speed !== undefined && !(Number.isFinite(patch.speed) && patch.speed > 0)) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'speed',
          detail: `speed must be a positive multiplier (1 = unchanged) — got ${patch.speed}` })
      }
      if (patch.src_in_us !== undefined) v.src_in_us = patch.src_in_us
      if (patch.src_out_us !== undefined) v.src_out_us = patch.src_out_us
      if (a.x !== undefined) v.transform.x = stat(a.x)
      if (a.y !== undefined) v.transform.y = stat(a.y)
      if (a.scale_x !== undefined) v.transform.scale_x = stat(a.scale_x)
      if (a.scale_y !== undefined) v.transform.scale_y = stat(a.scale_y)
      if (a.opacity !== undefined) v.opacity = stat(a.opacity)
      if (patch.speed !== undefined) v.speed = patch.speed
      if (patch.flip_h !== undefined) v.flip_h = patch.flip_h
      if (patch.flip_v !== undefined) v.flip_v = patch.flip_v
      if (patch.fade_in_us !== undefined) v.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) v.fade_out_us = patch.fade_out_us
      return
    }
    case 'ImageOverlay': {
      const i = p as ImageOverlayParams
      const a = authoredTransform(patch)
      if (a.x !== undefined) i.transform.x = stat(a.x)
      if (a.y !== undefined) i.transform.y = stat(a.y)
      if (a.scale_x !== undefined) i.transform.scale_x = stat(a.scale_x)
      if (a.scale_y !== undefined) i.transform.scale_y = stat(a.scale_y)
      if (a.opacity !== undefined) i.opacity = stat(a.opacity)
      if (patch.fade_in_us !== undefined) i.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) i.fade_out_us = patch.fade_out_us
      return
    }
    case 'Motif': {
      const m = p as MotifParams
      const a = authoredTransform(patch)
      if (a.x !== undefined) m.transform.x = stat(a.x)
      if (a.y !== undefined) m.transform.y = stat(a.y)
      if (a.scale_x !== undefined) m.transform.scale_x = stat(a.scale_x)
      if (a.scale_y !== undefined) m.transform.scale_y = stat(a.scale_y)
      if (a.opacity !== undefined) m.opacity = stat(a.opacity)
      if (patch.src_in_us !== undefined) m.src_in_us = patch.src_in_us
      if (patch.motif_id !== undefined) m.motif_id = patch.motif_id
      if (patch.motif_version !== undefined) m.motif_version = patch.motif_version
      if (patch.props !== undefined) for (const k of Object.keys(patch.props)) m.props[k] = patch.props[k]
      return
    }
    case 'CompositionRef': {
      const g = p as CompositionRefParams
      const a = authoredTransform(patch)
      // Checked before the first write, like the Text arm's enums and for the
      // same reason: a refused patch must leave the project byte-identical.
      if (patch.blend_mode !== undefined && !BLEND_MODES.includes(patch.blend_mode)) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'blend_mode',
          detail: `blend_mode must be one of ${BLEND_MODES.join(' | ')}` })
      }
      if (patch.src_in_us !== undefined) g.src_in_us = patch.src_in_us
      if (patch.src_out_us !== undefined) g.src_out_us = patch.src_out_us
      if (a.x !== undefined) g.transform.x = stat(a.x)
      if (a.y !== undefined) g.transform.y = stat(a.y)
      if (a.scale_x !== undefined) g.transform.scale_x = stat(a.scale_x)
      if (a.scale_y !== undefined) g.transform.scale_y = stat(a.scale_y)
      if (a.opacity !== undefined) g.opacity = stat(a.opacity)
      if (patch.blend_mode !== undefined) g.blend_mode = patch.blend_mode
      return
    }
    case 'Color': {
      const c = p as ColorParams
      // The same whole-pixel extent the text box is: a Color layer is rasterized
      // at this size, and a fractional one buys nothing a whole pixel does not.
      // Resolved before the colour is written so a refusal leaves the layer
      // untouched.
      const wP = patch.width === undefined ? undefined : authoredExtentPx('width', patch.width)
      const hP = patch.height === undefined ? undefined : authoredExtentPx('height', patch.height)
      if (patch.color !== undefined) c.color = stat(patch.color)
      if (wP !== undefined) c.width = wP
      if (hP !== undefined) c.height = hP
      return
    }
    case 'Audio': {
      const au = p as AudioParams
      const gainP = authored('gain_db', patch.gain_db)
      // `pan` is the one param whose stored value could previously disagree with
      // what was rendered: the mixer clamps to [-1, 1] on the way out
      // (`audio/envelope.rs` sample_pan), so a stored 2.0 played as 1.0 forever.
      // Refusing here makes the store the truth; that clamp stays as a guard for
      // projects written before this check existed.
      const panP = authored('pan', patch.pan)
      if (patch.src_in_us !== undefined) au.src_in_us = patch.src_in_us
      if (patch.src_out_us !== undefined) au.src_out_us = patch.src_out_us
      if (gainP !== undefined) au.gain_db = stat(gainP)
      if (panP !== undefined) au.pan = stat(panP)
      if (patch.fade_in_us !== undefined) au.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) au.fade_out_us = patch.fade_out_us
      if (patch.mute !== undefined) au.mute = patch.mute
      if (patch.role !== undefined) au.role = patch.role
      return
    }
  }
}

/** update_layer_params (mutation half): lock-check, locate,
 *  field-merge, then Motif content-window clamp.
 *  After the field-merge: if the layer is a Motif with a known catalog entry and
 *  a finite contentDur, and the placed window exceeds that contentDur, clamp
 *  src_in_us + t_end_us into the new content. Growing never resizes.
 *
 *  LANDMINE: JS numbers are exact to 2^53 µs — consistent with the
 *  resolveMotifTEndUs twin note in catalog.ts — diverges from Rust saturating
 *  arithmetic only for absurd timestamps far beyond realistic use. */
export function applyUpdateLayerParams(p: Project, id: Uuid, patch: LayerParamsPatch, catalog: MotifCatalog): void {
  const { comp: c, layer } = checkTrackLock(p, id) // LayerNotFound / TrackLocked
  applyParamsPatch(layer, patch)

  // Content-window model: after a Motif params update, if the cap-driving prop
  // (e.g. `seconds`) shrank the content below the current window, clamp the
  // geometry. Growing never resizes.
  if (layer.params.kind === 'Motif') {
    const params = layer.params as MotifParams
    // INTENTIONAL: the clamp cap is resolved from this `catalog` — the actor's full
    // MotifCatalog (built-ins + user layer) — so a USER motif with a cap clamps here too,
    // not just built-ins. Clamping user motifs is the desired behavior; do NOT narrow this
    // to built-ins-only.
    const manifest = catalog.get(params.motif_id)
    if (manifest === undefined) return // unknown motif → no clamp
    const contentDur = resolveMotifMaxDurUs(manifest, params.props)
    if (contentDur === null) return // unbounded → no clamp

    const tStart = layer.t_start_us
    const tEnd = layer.t_end_us
    const srcIn = params.src_in_us
    const width = tEnd - tStart

    if (srcIn + width <= contentDur) return // grow / within content → no geometry change

    // Clamp the window start into content (keep >= 0, < contentDur). Floor (not
    // round) so newSrcIn can never round UP toward contentDur on off-grid inputs.
    const maxSrcIn = Math.max(contentDur - 1, 0)
    const fps = c.fps
    const newSrcIn = snapFrameFloor(Math.min(srcIn, maxSrcIn), fps.num, fps.den)
    // Largest grid t_end whose derived src_out stays <= contentDur.
    const cappedEnd = snapFrameFloor(tStart + (contentDur - newSrcIn), fps.num, fps.den)
    // Never collapse to zero-width (guards degenerate contentDur <= 0). The floor
    // is ONE FRAME, not one µs: `tStart + 1` is off-grid, and validate's grid
    // backstop would reject the whole commit — turning a silent 1 µs sliver into
    // a failed edit whenever a motif's remaining content is under one frame.
    const newTEnd = Math.max(cappedEnd, snapFrameCeil(tStart + 1, fps.num, fps.den))

    params.src_in_us = newSrcIn
    layer.t_end_us = newTEnd
    applyDurationAutofit(c)
  }
}

/** native/src/state/layer.rs `parse_effect_param_key` — parse
 *  "effects[<uuid>].params[<key>]" → [effectId, paramKey]; null otherwise. (A
 *  non-UUID id still parses here but the subsequent effect lookup fails → resolves
 *  to null, matching the Rust outcome.) */
export function parseEffectParamKey(key: string): [Uuid, string] | null {
  const m = /^effects\[([^\]]+)\]\.params\[(.+)\]$/.exec(key)
  return m ? [m[1], m[2]] : null
}

export const TRANSFORM_F64_KEYS = ['x', 'y', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y']

/** layer.rs `resolve_animated_f64_mut` / `resolve_animated_f64_mut_on_layer` —
 *  resolve a param-key to a setter for its Animated<f64> slot, or null if the key
 *  is unknown / invalid on this kind. Effect-param paths look in layer.effects
 *  (and require the param slot to already exist). */
function f64Lens(layer: Layer, key: string): { set(v: Animated<number>): void } | null {
  const eff = parseEffectParamKey(key)
  if (eff) {
    const e = layer.effects.find((x) => x.id === eff[0])
    if (!e || !(eff[1] in e.params)) return null
    return { set: (v) => { e.params[eff[1]] = v } }
  }
  const p = layer.params
  if (p.kind === 'Color') return null
  if (p.kind === 'Audio') {
    if (key === 'gain_db') return { set: (v) => { p.gain_db = v } }
    if (key === 'pan') return { set: (v) => { p.pan = v } }
    return null
  }
  // VideoClip | ImageOverlay | Text | Motif | CompositionRef — transform +
  // opacity. A Group joins by having exactly that pair and nothing else
  // animatable (ADR 0052 §4), so it needs no arm of its own here.
  if (key === 'opacity') return { set: (v) => { p.opacity = v } }
  if (TRANSFORM_F64_KEYS.includes(key)) return { set: (v) => { (p.transform as unknown as Record<string, Animated<number>>)[key] = v } }
  return null
}

/** layer.rs:286-374 read sibling of f64Lens — resolve a param-key to its CURRENT
 *  Animated<f64> (a reference into the layer), or null if unknown/invalid on this
 *  kind. Effect-param paths read layer.effects (None when the param slot is
 *  absent → caller maps to UnknownKeyframeParam). Read-only: never inserts. */
export function resolveAnimatedF64(layer: Layer, key: string): Animated<number> | null {
  const eff = parseEffectParamKey(key)
  if (eff) {
    const e = layer.effects.find((x) => x.id === eff[0])
    return e ? (e.params[eff[1]] ?? null) : null
  }
  const p = layer.params
  if (p.kind === 'Color') return null
  if (p.kind === 'Audio') {
    if (key === 'gain_db') return p.gain_db
    if (key === 'pan') return p.pan
    return null
  }
  // VideoClip | ImageOverlay | Text | Motif | CompositionRef — transform +
  // opacity, the read sibling of `f64Lens`' one arm for all five.
  if (key === 'opacity') return p.opacity
  if (TRANSFORM_F64_KEYS.includes(key)) return (p.transform as unknown as Record<string, Animated<number>>)[key] ?? null
  return null
}

/** Locate the layer (LayerNotFound), resolve the param key
 *  (UnknownKeyframeParam), return its t_start_us + current track. Used by the MCP
 *  keyframe tools for timeline-absolute↔layer-local conversion. Read-only (no
 *  commit, no id mint). */
export function readLayerTrack(p: Project, id: Uuid, paramKey: string): { tStartUs: number; track: Animated<number> } {
  const { layer } = requireLayer(p, id)
  const track = resolveAnimatedF64(layer, paramKey)
  if (track === null) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: paramKey })
  return { tStartUs: layer.t_start_us, track }
}

/** update_layer_param_track (mutation half): lock-check →
 *  normalize (EmptyKeyframeTrack on empty) → locate → resolve, lazily inserting
 *  Static(0) for a missing slot of an EXISTING effect → re-resolve
 *  (UnknownKeyframeParam) → assign. NO autofit (a keyframe write never moves
 *  t_start/t_end). Keyframe param-tracks are Animated<f64> only. */
export function applyUpdateLayerParamTrack(p: Project, id: Uuid, paramKey: string, track: Animated<number>): void {
  const { comp: c, layer } = checkTrackLock(p, id) // LayerNotFound / TrackLocked — BEFORE normalize
  // Located BEFORE normalize because the write-time grid depends on the layer's
  // kind: an audio envelope — gain_db, pan, and the audio-role automation —
  // quantizes on the 48 kHz lattice, so audio automation is never coarser than the
  // mixer that renders it (spec R2-D6). Error ordering: EmptyKeyframeTrack precedes
  // UnknownKeyframeParam.
  //
  // This changes the WRITE grid only. Keyframe times remain deliberately unenforced
  // by validate (see validate.ts's validateLayerParams note): trim/split rebase keys
  // by a delta, and re-snapping the shifted set would dedupe-merge two keys that
  // landed on one quantum — authored data lost.
  if (!normalizeKeyframes(track, (t) => snapOnGrid(t, gridForLayerKind(layer.params.kind, c.fps)))) {
    throw new CommandFailure({ error: 'EmptyKeyframeTrack', layer: id, param_key: paramKey })
  }
  // Values, after the times. Here rather than beside `lens.set` because the lazy
  // insert below WRITES to the project, and a refusal has to leave the project
  // byte-identical — the same ordering rule applyParamsPatch's text-box mode
  // check spells out.
  //
  // Running before the key is known valid is safe: an unrecognised key falls to
  // the effect-param fallback, which carries no range and so cannot refuse, and
  // `f64Lens` still answers UnknownKeyframeParam for it two lines down. Only keys
  // that ARE in the table carry a range, and those are exactly the valid ones.
  quantizeTrack(paramKey, track)
  if (f64Lens(layer, paramKey) === null) {
    const eff = parseEffectParamKey(paramKey)
    if (eff) {
      const e = layer.effects.find((x) => x.id === eff[0])
      // A placeholder that lives for two statements: it exists only so the
      // re-resolve below finds the key present, and `lens.set(track)` overwrites
      // it unconditionally. NOT a default — the effect registry's `default` is
      // the default, applied at render (`EffectChain`) and in the inspector
      // (`EffectParamField`), and absent-means-default is the contract because
      // main cannot read that pixi-dependent registry at all.
      if (e && !(eff[1] in e.params)) e.params[eff[1]] = { mode: 'Static', value: 0 }
    }
  }
  const lens = f64Lens(layer, paramKey)
  if (!lens) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: paramKey })
  lens.set(track)
}
