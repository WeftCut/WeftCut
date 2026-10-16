// Locating a review change on the editor timeline (ADR 0115). Editor only, as
// every object navigation is (ADR 0065): the agent view is for watching.
import type { Change } from '../../shared/review'
import { openComposition, useCompositionAnchorStore } from '../state/compositionAnchorStore'
import { jumpToTimeUs, revealLayerWithoutSeek, revealTrackWithoutSelection } from '../state/navigation'
import { focusedRootUs } from '../state/playheadProjection'
import { useProjectStore } from '../state/projectStore'
import { entityIdOf } from './changeModel'

/** The change's clip when it exists now (a removed clip has none). */
function currentLayer(c: Change): string | null {
  const id = entityIdOf(c, 'Layer')
  return id !== null && useProjectStore.getState().layerById.has(id) ? id : null
}

/** Can `locateChange` take the user anywhere? A current clip, a stretch of a
 *  composition that still exists, or a track or composition that does. */
export function canLocateChange(c: Change): boolean {
  const { summary, compositionIdByTrackId } = useProjectStore.getState()
  if (!summary) return false
  if (currentLayer(c) !== null) return true
  if ([...c.ranges, ...c.before_ranges ?? []].some(r => summary.compositions[r.composition_id] !== undefined)) return true
  const track = entityIdOf(c, 'Track'), comp = entityIdOf(c, 'Composition')
  if (track !== null && compositionIdByTrackId.has(track)) return true
  return comp !== null && summary.compositions[comp] !== undefined
}

/** Reveal and select the change's clip if one exists, entering its
 *  composition; otherwise open the composition holding its footprint. Then
 *  seek to the footprint's start on that composition. A change with no
 *  footprint reveals its track or opens its composition. */
export function locateChange(c: Change): boolean {
  const { summary, compositionIdByLayerId } = useProjectStore.getState()
  if (!summary) return false
  const layerId = currentLayer(c)
  let compositionId: string | null = null
  if (layerId !== null) {
    if (!revealLayerWithoutSeek(layerId)) return false
    compositionId = compositionIdByLayerId.get(layerId) ?? null
  }
  const ranges = c.ranges.length ? c.ranges : c.before_ranges ?? []
  const range = ranges.find(r => (compositionId === null ? summary.compositions[r.composition_id] !== undefined : r.composition_id === compositionId))
  if (layerId === null) {
    if (range) {
      if (useCompositionAnchorStore.getState().focusedId !== range.composition_id && !openComposition(range.composition_id, null)) return false
    } else {
      const track = entityIdOf(c, 'Track')
      if (track !== null && revealTrackWithoutSelection(track)) return true
      const comp = entityIdOf(c, 'Composition')
      return comp !== null && summary.compositions[comp] !== undefined && openComposition(comp, null)
    }
  }
  // The composition holding the footprint is focused now; its own clock
  // projects into the film's through the anchor that open gave it.
  if (range) jumpToTimeUs(focusedRootUs(range.t_start_us))
  return true
}
