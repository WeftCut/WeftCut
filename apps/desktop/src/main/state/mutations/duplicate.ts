import { current, isDraft } from 'immer'
import type { Composition, Layer, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { applyDurationAutofit, cloneLayer, compositionOf, locateTrack, requireLayer, requireSameComposition } from './helpers'
import { applyLinksCreate } from './links'
import { CommandFailure } from '../errors'
import { gridForLayerKind, shiftOnGrids, snapOnGrid } from '../snap'
import { layerOverlapClass } from '../validate'

export interface PasteLayerInterval {
  tStartUs: number
  tEndUs: number
}

/** Resolve the exact snapped interval used when a copied layer is pasted, on the
 *  SOURCE layer's own grid (spec R2-D6) — so a duplicated audio clip keeps its
 *  sample alignment instead of being pulled onto the video frame grid. The source
 *  layer's duration is shifted the same way as a normal move, which preserves its
 *  quantum span on fractional frame-rate grids. */
export function pasteLayerInterval(p: Project, id: Uuid, tStartUs: number): PasteLayerInterval {
  const { comp: c, layer: source } = requireLayer(p, id)
  const grid = gridForLayerKind(source.params.kind, c.fps)
  const snappedStart = snapOnGrid(tStartUs, grid)
  // A set of one, through the arithmetic every landing shares
  // (`renderer/grid.ts`) — which is also what the timeline's duplicate preview
  // draws with, so the ghost under the pointer and the clone that lands are the
  // same two numbers.
  return shiftOnGrids(
    [{ id: source.id, kind: source.params.kind, tStartUs: source.t_start_us, tEndUs: source.t_end_us }],
    snappedStart - source.t_start_us,
    c.fps,
  ).get(source.id)!
}

/** Paste a detached clone onto an explicitly resolved target track — in the
 *  source's own composition (a track elsewhere is CrossCompositionMove). The
 *  caller owns automatic track selection/creation; this mutation preserves all
 *  layer content and effects, gives the layer and each effect a fresh id, and never joins
 *  the source link. */
export function applyPasteLayer(
  p: Project,
  idGen: IdGen,
  sourceId: Uuid,
  targetTrackId: Uuid,
  tStartUs: number,
): Uuid {
  const source = requireLayer(p, sourceId)
  const target = locateTrack(p, targetTrackId)
  if (!target) throw new CommandFailure({ error: 'TrackNotFound', track: targetTrackId })
  if (target.comp !== source.comp) throw new CommandFailure({ error: 'CrossCompositionMove', layer: sourceId, from: source.comp.id, to: target.comp.id })

  const interval = pasteLayerInterval(p, sourceId, tStartUs)
  const copy = cloneLayer(source.layer)
  const pastedId = idGen()
  copy.id = pastedId
  copy.effects = copy.effects.map((e) => ({ ...e, id: idGen() }))
  copy.t_start_us = interval.tStartUs
  copy.t_end_us = interval.tEndUs

  const at = target.track.layers.findIndex((layer) => layer.t_start_us > interval.tStartUs)
  target.track.layers.splice(at < 0 ? target.track.layers.length : at, 0, copy)
  applyDurationAutofit(source.comp)
  return pastedId
}

/** Paste a SET of layers as one edit — the whole-link duplicate. Every clone
 *  shifts by the shared `deltaUs` and then snaps on ITS OWN lattice
 *  (`pasteLayerInterval`), which is the same rule `applyMoveLayer` fans out
 *  under and what keeps a slipped A/V offset intact. Only the SEED
 *  (`layerIds[0]`) changes track, onto `targetTrackId`; every other clone lands
 *  on its source's track, mirroring the move rule. Two or more clones are linked
 *  to each other — never to their sources.
 *
 *  All-or-nothing: every destination is checked for lock and overlap before any
 *  clone is inserted, so a refusal leaves `p` untouched and burns no id. The
 *  overlap refusal is the validator's own `LayerOverlap`, with `b` naming the
 *  SOURCE whose clone would collide — the clone never came to exist. The set is
 *  one composition's (CrossCompositionSet), and the seed's target track must be
 *  in it (CrossCompositionMove).
 *
 *  `unique` makes every Group clone its own: the composition it shows is
 *  deep-copied (`copyCompositionDeep`), so editing inside the copy leaves the
 *  source alone. Without it a Group clone is another instance of the same
 *  composition, as a paste in the timeline is. A `unique` set with no Group in
 *  it is `InvalidArgument` — the flag would change nothing.
 *
 *  Returns source → clone. Empty input returns an empty map and touches nothing. */
export function applyPasteLayers(
  p: Project,
  idGen: IdGen,
  layerIds: readonly Uuid[],
  deltaUs: number,
  targetTrackId: Uuid | null,
  unique = false,
): Map<Uuid, Uuid> {
  const ids = [...new Set(layerIds)]
  const result = new Map<Uuid, Uuid>()
  if (ids.length === 0) return result
  const c = requireSameComposition(p, ids)

  interface Plan { source: Layer; trackIdx: number; tStartUs: number; tEndUs: number }
  const plans: Plan[] = []
  for (const [i, id] of ids.entries()) {
    const loc = requireLayer(p, id)
    const source = loc.layer
    let trackIdx = loc.trackIndex
    if (i === 0 && targetTrackId !== null) {
      const target = locateTrack(p, targetTrackId)
      if (!target) throw new CommandFailure({ error: 'TrackNotFound', track: targetTrackId })
      if (target.comp !== c) throw new CommandFailure({ error: 'CrossCompositionMove', layer: id, from: c.id, to: target.comp.id })
      trackIdx = target.trackIndex
    }
    if (c.tracks[trackIdx].locked) throw new CommandFailure({ error: 'TrackLocked', track: c.tracks[trackIdx].id })
    const interval = pasteLayerInterval(p, id, source.t_start_us + deltaUs)
    plans.push({ source, trackIdx, tStartUs: interval.tStartUs, tEndUs: interval.tEndUs })
  }

  // Half-open `[start, end)` per overlap class — the track rule in validate.ts.
  // Clones sharing a destination are checked against each other too: two members
  // of one link on one track collide only if the shift lands them apart from
  // how they sit today, and validate would refuse that after the fact.
  const collides = (a: { t_start_us: number; t_end_us: number }, b: { t_start_us: number; t_end_us: number }) =>
    a.t_start_us < b.t_end_us && b.t_start_us < a.t_end_us
  for (const [i, plan] of plans.entries()) {
    const cls = layerOverlapClass(plan.source.params)
    const track = c.tracks[plan.trackIdx]
    const clone = { t_start_us: plan.tStartUs, t_end_us: plan.tEndUs }
    const refuse = (other: { id: Uuid; t_start_us: number; t_end_us: number }): never => {
      throw new CommandFailure({ error: 'ValidationFailed', detail: {
        rule: 'LayerOverlap', track: track.id,
        a: other.id, a_start: other.t_start_us, a_end: other.t_end_us,
        b: plan.source.id, b_start: clone.t_start_us, b_end: clone.t_end_us,
      } })
    }
    for (const l of track.layers) if (layerOverlapClass(l.params) === cls && collides(clone, l)) refuse(l)
    for (const [j, other] of plans.entries()) {
      if (j >= i || other.trackIdx !== plan.trackIdx || layerOverlapClass(other.source.params) !== cls) continue
      if (collides(clone, { t_start_us: other.tStartUs, t_end_us: other.tEndUs })) refuse({ id: other.source.id, t_start_us: other.tStartUs, t_end_us: other.tEndUs })
    }
  }

  if (unique && !plans.some((x) => x.source.params.kind === 'CompositionRef'))
    throw new CommandFailure({ error: 'InvalidArgument', field: 'unique', detail: 'none of layer_ids is a Group layer, and only a Group has a composition to copy' })
  for (const plan of plans) {
    const copy = cloneLayer(plan.source)
    copy.id = idGen()
    copy.effects = copy.effects.map((e) => ({ ...e, id: idGen() }))
    if (unique && copy.params.kind === 'CompositionRef') copy.params.composition = copyCompositionDeep(p, idGen, copy.params.composition, new Map())
    copy.t_start_us = plan.tStartUs
    copy.t_end_us = plan.tEndUs
    const track = c.tracks[plan.trackIdx]
    const at = track.layers.findIndex((l) => l.t_start_us > copy.t_start_us)
    track.layers.splice(at < 0 ? track.layers.length : at, 0, copy)
    result.set(plan.source.id, copy.id)
  }
  if (result.size >= 2) applyLinksCreate(p, idGen, [...result.values()], false)
  applyDurationAutofit(c)
  return result
}

/** Deep-copy composition `sourceId` into a new one and return its id: fresh
 *  ids for every track, layer, effect, link, transition and marker, with the
 *  links, transitions and anchored markers re-pointed at the copies, and every
 *  Group nested inside copied the same way — so nothing the copy shows is
 *  shared with the source. A labelled source's copy is "<label> copy"; an
 *  unlabelled one takes the next ordinal like any new Group. `copies` maps
 *  each composition already copied in this pass to its copy, so a composition
 *  placed twice inside the source is copied once. */
export function copyCompositionDeep(p: Project, idGen: IdGen, sourceId: Uuid, copies: Map<Uuid, Uuid>): Uuid {
  const done = copies.get(sourceId)
  if (done !== undefined) return done
  const src = compositionOf(p, sourceId)
  const comp: Composition = structuredClone(isDraft(src) ? current(src) : src)
  comp.id = idGen()
  copies.set(sourceId, comp.id)
  comp.ordinal = p.next_group_ordinal
  p.next_group_ordinal += 1
  if (comp.label !== null) comp.label = `${comp.label} copy`
  const layerIds = new Map<Uuid, Uuid>()
  for (const track of comp.tracks) {
    track.id = idGen()
    for (const layer of track.layers) {
      const id = idGen()
      layerIds.set(layer.id, id)
      layer.id = id
      layer.effects = layer.effects.map((e) => ({ ...e, id: idGen() }))
      if (layer.params.kind === 'CompositionRef') layer.params.composition = copyCompositionDeep(p, idGen, layer.params.composition, copies)
    }
  }
  const re = (id: Uuid): Uuid => layerIds.get(id) ?? id
  comp.links = comp.links.map((l) => ({ id: idGen(), members: l.members.map(re).sort() }))
  comp.transitions = comp.transitions.map((t) => ({ ...t, id: idGen(), from_layer: re(t.from_layer), to_layer: re(t.to_layer) }))
  comp.markers = comp.markers.map((m) => ({ ...m, id: idGen(), anchor: m.anchor === null ? null : { ...m.anchor, layer: re(m.anchor.layer) } }))
  p.compositions[comp.id] = comp
  return comp.id
}
