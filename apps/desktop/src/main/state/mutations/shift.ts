// apps/desktop/src/main/state/mutations/shift.ts
//
// Shift a SET of layers in time by one delta, as one recorded edit — the
// multi-layer move that would otherwise be N `move_layer` calls and a read,
// and with a positive delta at a time the ripple INSERT: open a gap at
// `from_t_us`, then place into it.
//
// The arithmetic is `applyMoveLayer`'s, wholesale: `shiftOnGrids` lands every
// member on its own lattice, `floorShiftAtZero` takes the zero boundary as one
// body, so a set lands exactly where a drag of the same set would. Overlap is
// validate's (`LayerOverlap` names the pair); a locked lane refuses before
// anything moves; a strict caller (MCP) is refused at zero rather than floored,
// the move tools' rule (ADR 0048 — no silent clamping).
import type { Composition, Project, Uuid } from '../model'
import { rootComposition } from '../model'
import { CommandFailure } from '../errors'
import { floorShiftAtZero, shiftOnGrids, type ShiftMember } from '../snap'
import { applyDurationAutofit, insertSorted, locateLayerIn, requireSameComposition } from './helpers'
import { linkSiblingsExcluding } from './links'

/** What the shift touched: the layers re-timed (partners included) and the
 *  delta actually applied, which a non-strict caller may have had floored. */
export interface ShiftLayersResult { moved: Uuid[]; delta_us: number }

/** The set a named list means: the layers plus — unless `escapeLink` — their
 *  link partners, each once, in the order first named. */
function resolveSet(c: Composition, ids: readonly Uuid[], escapeLink: boolean): Uuid[] {
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
  return shiftInComposition(c, resolveSet(c, ids, escapeLink), deltaUs, strict)
}

/** Shift every layer of a composition (the root when `compositionId` is null)
 *  that STARTS at or after `fromTUs`, on `trackIds` or on every track — "shift
 *  everything after t". A link partner starting earlier stays, as it does
 *  under a ripple: the cut is a place in time, not a membership. */
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
  return shiftInComposition(c, ids, deltaUs, strict)
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
  // Pull every mover out first, then re-insert each at its landing: a
  // one-at-a-time move would reorder a lane's array under the walk.
  const pulled = located.map((loc) => {
    const at = loc.track.layers.findIndex((l) => l.id === loc.layer.id)
    return { track: loc.track, layer: loc.track.layers.splice(at, 1)[0] }
  })
  for (const { track, layer } of pulled) {
    const land = landings.get(layer.id)!
    layer.t_start_us = land.tStartUs
    layer.t_end_us = land.tEndUs
    insertSorted(track, layer)
  }
  applyDurationAutofit(c)
  return { moved: ids.slice(), delta_us: delta }
}
