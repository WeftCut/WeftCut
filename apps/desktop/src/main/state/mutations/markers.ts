import type { Composition, Project, Rgba, Uuid } from '../model'
import { rootComposition } from './helpers'
import { CommandFailure } from '../errors'
import { snapFrameRound } from '../snap'

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

/** MarkerPatch. null/absent = "don't touch"; end_t_us can only be SET, never
 *  cleared (clearing → remove+add). */
export interface MarkerPatch {
  t_us?: number | null
  end_t_us?: number | null
  label?: string | null
  color?: Rgba | null
}

/** Patch a marker; only provided fields apply. Re-sorts by t_us (stable) when
 *  t_us changed, preserving the sorted-markers invariant. Times are snapped and
 *  the span checked against the MERGED marker, so moving t_us past an existing
 *  end_t_us fails the same way as patching a bad end_t_us. */
export function applyUpdateMarker(p: Project, id: Uuid, patch: MarkerPatch): void {
  const c = rootComposition(p)
  const idx = c.markers.findIndex((m) => m.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'MarkerNotFound', marker: id })
  const needsResort = typeof patch.t_us === 'number'
  const m = c.markers[idx]
  const snapped = snapMarkerTimes(c, needsResort ? (patch.t_us as number) : m.t_us,
    typeof patch.end_t_us === 'number' ? patch.end_t_us : m.end_t_us)
  if (needsResort) m.t_us = snapped.tUs
  if (typeof patch.end_t_us === 'number') m.end_t_us = snapped.endTUs
  if (typeof patch.label === 'string') m.label = patch.label
  if (patch.color && typeof patch.color === 'object') m.color = patch.color
  if (needsResort) c.markers.sort((a, b) => (a.t_us < b.t_us ? -1 : a.t_us > b.t_us ? 1 : 0))
}

/** Remove a marker by id. */
export function applyRemoveMarker(p: Project, id: Uuid): void {
  const c = rootComposition(p)
  const idx = c.markers.findIndex((m) => m.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'MarkerNotFound', marker: id })
  c.markers.splice(idx, 1)
}
