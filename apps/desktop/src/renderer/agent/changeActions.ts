// Locating a review change on the editor timeline (ADR 0115). Editor only, as
// every object navigation is (ADR 0065): the agent view is for watching.
import type { Change } from '../../shared/review'
import { openComposition, useCompositionAnchorStore } from '../state/compositionAnchorStore'
import { jumpToTimeUs, revealLayerWithoutSeek, revealTrackWithoutSelection } from '../state/navigation'
import { focusedRootUs } from '../state/playheadProjection'
import { useProjectStore } from '../state/projectStore'
import { keyIds } from './changeModel'

/** The first clip of the change that exists now (a removed clip has none). */
function currentLayer(c: Change): string | null {
  const { layerById } = useProjectStore.getState()
  return keyIds(c, 'Layer').find(id => layerById.has(id)) ?? null
}

/** Can `locateChange` take the user anywhere? A current clip, a stretch of a
 *  composition that still exists, or a track or composition that does. */
export function canLocateChange(c: Change): boolean {
  const { summary, compositionIdByTrackId } = useProjectStore.getState()
  if (!summary) return false
  if (currentLayer(c) !== null) return true
  if (c.ranges.some(r => summary.compositions[r.composition_id] !== undefined)) return true
  if (keyIds(c, 'Track').some(id => compositionIdByTrackId.has(id))) return true
  return keyIds(c, 'Composition').some(id => summary.compositions[id] !== undefined)
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
  const range = c.ranges.find(r => (compositionId === null ? summary.compositions[r.composition_id] !== undefined : r.composition_id === compositionId))
  if (layerId === null) {
    if (range) {
      if (useCompositionAnchorStore.getState().focusedId !== range.composition_id && !openComposition(range.composition_id, null)) return false
    } else {
      const track = keyIds(c, 'Track').find(id => revealTrackWithoutSelection(id))
      if (track !== undefined) return true
      const comp = keyIds(c, 'Composition').find(id => summary.compositions[id] !== undefined)
      return comp !== undefined && openComposition(comp, null)
    }
  }
  // The composition holding the footprint is focused now; its own clock
  // projects into the film's through the anchor that open gave it.
  if (range) jumpToTimeUs(focusedRootUs(range.t_start_us))
  return true
}
