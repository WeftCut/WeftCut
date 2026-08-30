import type { Composition, Marker, Project, Rgba, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { snapFrameRound } from '../snap'
import { hasSourceWindow, requireLayer } from './helpers'

/** Marker times on the composition frame grid — the one snap both the add path
 *  (`applyAddMarker`) and the patch path share.
 *
 *  Markers are frame-quantized like every other timeline entity (Premiere /
 *  Resolve do the same), so a marker dropped mid-frame moves up to half a frame.
 *  A region whose span collapses to zero frames under the snap FAILS: persisting
 *  `end_t_us <= t_us` would leave a region no UI can hit and no later snap-target
 *  logic can use. */
export function snapMarkerTimes(c: Composition, tUs: number, endTUs: number | null): { tUs: number; endTUs: number | null } {
  const { num, den } = c.fps
  const t = snapFrameRound(tUs, num, den)
  const end = endTUs === null ? null : snapFrameRound(endTUs, num, den)
  if (end !== null && end <= t)
    throw new CommandFailure({ error: 'InvalidArgument', field: 'end_t_us',
      detail: `a region marker must span at least one frame at ${num}/${den} fps: snapped end_t_us ${end} <= t_us ${t}` })
  return { tUs: t, endTUs: end }
}

/** A marker with the composition that holds it. Marker ids are unique
 *  project-wide (validate: `DuplicateMarkerId`), so the id alone names the
 *  composition — the same rule layers follow. */
export interface LocatedMarker { comp: Composition; marker: Marker; index: number }
export function locateMarker(p: Project, id: Uuid): LocatedMarker | null {
  for (const c of Object.values(p.compositions)) {
    const index = c.markers.findIndex((m) => m.id === id)
    if (index >= 0) return { comp: c, marker: c.markers[index], index }
  }
  return null
}
function requireMarker(p: Project, id: Uuid): LocatedMarker {
  const found = locateMarker(p, id)
  if (!found) throw new CommandFailure({ error: 'MarkerNotFound', marker: id })
  return found
}

/** MarkerPatch. null/absent = "don't touch"; end_t_us can only be SET, never
 *  cleared (clearing → remove+add).
 *
 *  `anchor` is deliberately NOT a patch field, and never becomes one: an anchor
 *  is set and cleared only by the dedicated attach/detach ops, which check the
 *  layer and derive `t_us` from it in the same commit. Reachable through a
 *  generic patch, it would let a caller name a layer in another composition, or
 *  move the anchor without moving the marker — an inconsistent pair the patch
 *  surface has no way to repair. The same reasoning keeps `t_us` patchable:
 *  that one IS the cache, and the next reconcile corrects it. */
export interface MarkerPatch {
  t_us?: number | null
  end_t_us?: number | null
  label?: string | null
  note?: string | null
  color?: Rgba | null
}

/** Patch a marker; only provided fields apply. Re-sorts by t_us (stable) when
 *  t_us changed, preserving the sorted-markers invariant. Times are snapped and
 *  the span checked against the MERGED marker, so moving t_us past an existing
 *  end_t_us fails the same way as patching a bad end_t_us. */
export function applyUpdateMarker(p: Project, id: Uuid, patch: MarkerPatch): void {
  const { comp: c, marker: m } = requireMarker(p, id)
  const needsResort = typeof patch.t_us === 'number'
  const snapped = snapMarkerTimes(c, needsResort ? (patch.t_us as number) : m.t_us,
    typeof patch.end_t_us === 'number' ? patch.end_t_us : m.end_t_us)
  if (needsResort) m.t_us = snapped.tUs
  if (typeof patch.end_t_us === 'number') m.end_t_us = snapped.endTUs
  if (typeof patch.label === 'string') m.label = patch.label
  if (typeof patch.note === 'string') m.note = patch.note
  if (patch.color && typeof patch.color === 'object') m.color = patch.color
  if (needsResort) c.markers.sort((a, b) => (a.t_us < b.t_us ? -1 : a.t_us > b.t_us ? 1 : 0))
}

/** Remove a marker by id. */
export function applyRemoveMarker(p: Project, id: Uuid): void {
  const { comp: c, index } = requireMarker(p, id)
  c.markers.splice(index, 1)
}

/** Tie a marker to a layer of its own composition — the explicit half of
 *  anchoring, and (with `applyAddMarker`) one of only two writers of a
 *  `MarkerAnchor`.
 *
 *  `src_us` is read off the marker's CURRENT `t_us`: the anchor names the source
 *  instant the mark already sits on, so attaching moves nothing. `t_us` is
 *  deliberately NOT recomputed here — the same `produce()` runs
 *  `reconcileMarkers` after this returns and derives it from the anchor, and two
 *  derivations of one value are how the two drift.
 *
 *  Three refusals, all before the anchor is written. A layer in another
 *  composition reads as `CrossCompositionSet`: the marker and its layer are the
 *  one-composition set here, so `expected` is the marker's composition, and a
 *  cross-composition tie is unrepresentable rather than merely odd — the two
 *  timelines share no origin, so no `t_us` could be derived over it. A kind with
 *  no source window is `WrongLayerKind`, because the derivation reads
 *  `params.src_in_us` and the fix is a different layer, not a different time. A
 *  marker outside the layer's timeline span is `InvalidArgument`: a mark the clip
 *  does not touch names no instant in it, and tying it anyway would only teleport
 *  it onto the clip. */
export function applyAttachMarker(p: Project, markerId: Uuid, layerId: Uuid): void {
  const { comp: c, marker: m } = requireMarker(p, markerId)
  const { comp: layerComp, layer } = requireLayer(p, layerId)
  if (layerComp !== c)
    throw new CommandFailure({ error: 'CrossCompositionSet', layer: layerId, composition: layerComp.id, expected: c.id })
  if (!hasSourceWindow(layer.params))
    throw new CommandFailure({ error: 'WrongLayerKind', layer: layerId, expected: 'VideoClip | Audio | CompositionRef' })
  if (m.t_us < layer.t_start_us || m.t_us >= layer.t_end_us)
    throw new CommandFailure({ error: 'InvalidArgument', field: 'layer',
      detail: `marker ${markerId} at t_us ${m.t_us} is outside layer ${layerId}'s span [${layer.t_start_us}, ${layer.t_end_us})` })
  m.anchor = { layer: layerId, src_us: m.t_us - layer.t_start_us + layer.params.src_in_us }
}

/** Cut a marker loose from its layer. `t_us` stays exactly where the last
 *  reconcile left it, so the mark keeps the frame it is on and simply stops
 *  following.
 *
 *  The ONE exit from hibernation, and the answer to "I want the note, not the
 *  following": what comes out is an ordinary free marker, not a casualty. */
export function applyDetachMarker(p: Project, markerId: Uuid): void {
  requireMarker(p, markerId).marker.anchor = null
}
