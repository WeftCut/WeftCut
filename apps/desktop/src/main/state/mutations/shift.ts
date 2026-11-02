// apps/desktop/src/main/state/mutations/shift.ts
//
// Shift layers in time by one delta, as one recorded edit. Two entry points:
//
// - `applyShiftLayers` — a named set (+ link partners), the arithmetic the
//   renderer's multi-clip drag (`applyMoveLayers`) and `move_layers` share;
// - `applyShiftLayersFrom` — `shift_layers`' sweep: everything starting at or
//   after a time. A positive delta opens a gap there (the ripple INSERT); a
//   negative one closes the span `[from + delta, from)` through the ripple
//   planner (`renderer/ripple/plan.ts`), so it refuses by the ripple's names
//   and re-measures the transitions it carries, exactly as a ripple delete
//   would.
//
// Each member lands on its own grid (`shiftOnGrids`, `floorShiftAtZero` in
// `../snap`), so a set lands exactly where a drag of the same set would.
// Overlap is validate's (`LayerOverlap` names the pair); a locked lane refuses
// before anything moves; a strict caller (MCP) is refused at zero rather than
// floored (ADR 0048).
import type { Composition, Project, Uuid } from '../model'
import { rootComposition } from '../model'
import { CommandFailure } from '../errors'
import { floorShiftAtZero, shiftOnGrids, type ShiftMember } from '../snap'
import { locateLayerIn, requireSameComposition } from './helpers'
import { linkSiblingsExcluding } from './links'
import { planRippleSpan, type RippleMove } from '../../../renderer/ripple/plan'
import { applySweep, rippleViewOfComposition } from './ripple'

/** What the shift touched: the layers re-timed (partners included) and the
 *  delta the set was shifted by before each member's own grid landing — a
 *  non-strict caller's request may have been floored at 0. Where a member
 *  landed is in the snapshot; the MCP record reads it back per layer. */
export interface ShiftLayersResult { moved: Uuid[]; delta_us: number }

/** The set a named list means: the layers plus — unless `escapeLink` — their
 *  link partners, each once, in the order first named. */
export function linkedSet(c: Composition, ids: readonly Uuid[], escapeLink: boolean): Uuid[] {
  const out: Uuid[] = []
  const seen = new Set<Uuid>()
  const add = (id: Uuid): void => { if (!seen.has(id)) { seen.add(id); out.push(id) } }
  for (const id of ids) {
    add(id)
    if (!escapeLink) for (const s of linkSiblingsExcluding(c, id)) add(s)
  }
  return out
}

/** Shift the named layers (and their link partners unless `escapeLink`) by
 *  `deltaUs`. Throws `InvalidArgument` for an empty set, `LayerNotFound`,
 *  `CrossCompositionSet`, `TrackLocked`, and — strict — `ValidationFailed
 *  { rule: NegativeLayerStart }` naming the member that would cross 0. */
export function applyShiftLayers(p: Project, ids: readonly Uuid[], deltaUs: number, escapeLink: boolean, strict = false): ShiftLayersResult {
  const c = requireSameComposition(p, ids)
  return shiftInComposition(c, linkedSet(c, ids, escapeLink), deltaUs, strict)
}

/** Shift every layer of a composition (the root when `compositionId` is null)
 *  that STARTS at or after `fromTUs`, on `trackIds` or on every track — "shift
 *  everything after t".
 *
 *  A positive delta opens room: a link the time (or the lane filter) splits is
 *  refused as `ShiftLinkStraddles`, because a link is "these move together"
 *  and a sweep that moved one member and not another would slip their sync.
 *
 *  A negative delta closes `[fromTUs + deltaUs, fromTUs)` as a ripple does:
 *  a layer starting inside the span is `RippleInsideHole`, a landing on a
 *  layer that reaches into it is `RippleCollision`, a link reaching across it
 *  is `RippleLinkStraddles`, a lock that would have to move is `TrackLocked` /
 *  `RippleLockedLayer` — and a transition whose participants both move keeps
 *  its frame count. The lane filter narrows what moves; a link with a member
 *  on a lane outside it that would have moved is `ShiftLinkStraddles`.
 *
 *  Nothing starting at or after `fromTUs` (on the lanes) is `InvalidArgument`:
 *  a sweep that moves nothing would answer success having done nothing. */
export function applyShiftLayersFrom(
  p: Project, compositionId: Uuid | null, trackIds: readonly Uuid[] | null, fromTUs: number, deltaUs: number, strict = false,
): ShiftLayersResult {
  const c = compositionId === null ? rootComposition(p) : p.compositions[compositionId]
  if (!c) throw new CommandFailure({ error: 'CompositionNotFound', composition: compositionId as Uuid })
  if (trackIds) for (const t of trackIds) if (!c.tracks.some((x) => x.id === t)) throw new CommandFailure({ error: 'TrackNotFound', track: t })
  const lanes = trackIds ? new Set(trackIds) : null
  const ids: Uuid[] = []
  for (const t of c.tracks) {
    if (lanes && !lanes.has(t.id)) continue
    for (const l of t.layers) if (l.t_start_us >= fromTUs) ids.push(l.id)
  }
  if (ids.length === 0) throw new CommandFailure({ error: 'InvalidArgument', field: 'from_t_us', detail: `no layer${lanes ? ' on track_ids' : ''} starts at or after ${fromTUs} µs, so the sweep would move nothing` })
  const set = new Set(ids)
  if (deltaUs > 0 || lanes) {
    for (const link of c.links) {
      const inside = link.members.filter((m) => set.has(m))
      if (inside.length === 0 || inside.length === link.members.length) continue
      // Opening room: any member left behind slips. Closing: only a member the
      // lane filter left out that would otherwise have moved — the planner
      // owns the members upstream of the span.
      const strays = deltaUs > 0 ? link.members.filter((m) => !set.has(m))
        : link.members.filter((m) => !set.has(m) && (locateLayerIn(c, m)?.layer.t_start_us ?? -1) >= fromTUs)
      if (strays.length > 0) throw new CommandFailure({ error: 'ShiftLinkStraddles', link: link.id, from_t_us: fromTUs })
    }
  }
  if (deltaUs > 0) return shiftInComposition(c, ids, deltaUs, strict)

  // ── Closing: the ripple planner over the lanes the sweep covers ──
  const s = fromTUs + deltaUs
  if (s < 0) {
    if (strict) {
      const earliest = ids.map((id) => locateLayerIn(c, id)!.layer).reduce((a, b) => (b.t_start_us < a.t_start_us ? b : a))
      throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'NegativeLayerStart', layer: earliest.id, t_start: earliest.t_start_us + deltaUs } })
    }
    return shiftLeftOf(c, lanes, Math.max(0, s), fromTUs)
  }
  return shiftLeftOf(c, lanes, s, fromTUs)
}

/** Close `[s, e)` over `lanes` (every lane when null) with the ripple planner. */
function shiftLeftOf(c: Composition, lanes: ReadonlySet<Uuid> | null, s: number, e: number): ShiftLayersResult {
  const full = rippleViewOfComposition(c)
  const view = lanes ? { ...full, tracks: full.tracks.filter((t) => lanes.has(t.id)) } : full
  const plan = planRippleSpan(view, { s, e })
  if (!plan.ok) throw new CommandFailure(plan.refusal)
  return { moved: applySweep(c, plan.moves), delta_us: s - e }
}

function shiftInComposition(c: Composition, ids: readonly Uuid[], deltaUs: number, strict: boolean): ShiftLayersResult {
  if (ids.length === 0) return { moved: [], delta_us: 0 }
  const located = ids.map((id) => {
    const loc = locateLayerIn(c, id)
    if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
    return loc
  })
  for (const loc of located) if (loc.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: loc.track.id })
  const movers: ShiftMember[] = located.map(({ layer }) => ({ id: layer.id, kind: layer.params.kind, tStartUs: layer.t_start_us, tEndUs: layer.t_end_us }))
  const delta = floorShiftAtZero(movers, deltaUs)
  if (strict && delta !== deltaUs) {
    const earliest = movers.reduce((a, b) => (b.tStartUs < a.tStartUs ? b : a))
    throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'NegativeLayerStart', layer: earliest.id, t_start: earliest.tStartUs + deltaUs } })
  }
  const landings = shiftOnGrids(movers, delta, c.fps)
  // `applySweep` writes each landing on the mover's own lane and keeps the
  // frame count of a transition both of whose participants move.
  const moves: RippleMove[] = located.map(({ layer, track }) => ({ layer: layer.id, track: track.id, t_start_us: landings.get(layer.id)!.tStartUs, t_end_us: landings.get(layer.id)!.tEndUs }))
  applySweep(c, moves)
  return { moved: ids.slice(), delta_us: delta }
}
