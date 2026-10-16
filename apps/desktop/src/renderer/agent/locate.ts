// Locating a review item — a change or a tack — on the editor timeline
// (ADR 0115). Editor only, as every object navigation is (ADR 0065): the agent
// view is for watching.
//
// One pure resolver says where an item can be found in the project as it is
// now (`locateTarget`); whether Locate is offered and what it does both read
// that one answer, so the button is never enabled for a place the press
// cannot reach.
import type { TackView } from '../../shared/agent-activity'
import type { Change } from '../../shared/review'
import { openComposition, useCompositionAnchorStore } from '../state/compositionAnchorStore'
import { jumpToTimeUs, revealLayerWithoutSeek, revealTrackWithoutSelection } from '../state/navigation'
import { focusedRootUs } from '../state/playheadProjection'
import { useProjectStore, type ProjectStoreState } from '../state/projectStore'
import { entityIdOf } from './changeModel'

export type LocateItem = { kind: 'change'; change: Change } | { kind: 'tack'; tack: TackView }

/** The project indexes a target is resolved against. */
export type LocateIndex = Pick<ProjectStoreState, 'summary' | 'compositionIdByLayerId' | 'compositionIdByTrackId'>

/** Where Locate takes the user, in the order it prefers them:
 *  - `layer`: reveal and select a clip that exists now, entering its
 *    composition, then seek to `t_us` there when the item has a place on it;
 *  - `time`: open a composition and seek to `t_us` on its clock;
 *  - `track`: reveal a track that exists (an item with no place in time);
 *  - `composition`: open a composition that exists. */
export type LocateTarget =
  | { kind: 'layer'; layer_id: string; t_us: number | null }
  | { kind: 'time'; composition_id: string; t_us: number }
  | { kind: 'track'; track_id: string }
  | { kind: 'composition'; composition_id: string }

const hasComposition = (index: LocateIndex, id: string) => index.summary?.compositions[id] !== undefined

/** A change: its clip while it exists, at its footprint on the clip's
 *  composition; else its footprint — current, or a removed one's baseline
 *  one — on a composition that exists; else its track or composition. */
function changeTarget(c: Change, index: LocateIndex): LocateTarget | null {
  const ranges = c.ranges.length ? c.ranges : c.before_ranges ?? []
  const layer = entityIdOf(c, 'Layer')
  const layerComposition = layer === null ? undefined : index.compositionIdByLayerId.get(layer)
  if (layer !== null && layerComposition !== undefined) {
    const r = ranges.find(x => x.composition_id === layerComposition)
    return { kind: 'layer', layer_id: layer, t_us: r ? r.t_start_us : null }
  }
  const r = ranges.find(x => hasComposition(index, x.composition_id))
  if (r) return { kind: 'time', composition_id: r.composition_id, t_us: r.t_start_us }
  const track = entityIdOf(c, 'Track')
  if (track !== null && index.compositionIdByTrackId.has(track)) return { kind: 'track', track_id: track }
  const comp = entityIdOf(c, 'Composition')
  return comp !== null && hasComposition(index, comp) ? { kind: 'composition', composition_id: comp } : null
}

/** A tack: the clip it follows, at its start, while that clip exists; else
 *  its start on its composition. None once it has no place. */
function tackTarget(t: TackView, index: LocateIndex): LocateTarget | null {
  if (t.composition_id === null || t.t_us === null) return null
  const followed = t.follows?.layer_id
  if (followed !== undefined && index.compositionIdByLayerId.has(followed)) return { kind: 'layer', layer_id: followed, t_us: t.t_us }
  return hasComposition(index, t.composition_id) ? { kind: 'time', composition_id: t.composition_id, t_us: t.t_us } : null
}

/** Where `item` can be found in the project `index` describes, or null when
 *  nowhere. Pure. */
export function locateTarget(item: LocateItem, index: LocateIndex): LocateTarget | null {
  if (index.summary === null) return null
  return item.kind === 'change' ? changeTarget(item.change, index) : tackTarget(item.tack, index)
}

/** Whether Locate can take the user to `item` now. */
export function canLocate(item: LocateItem): boolean {
  return locateTarget(item, useProjectStore.getState()) !== null
}

/** Take the user to `item`: the editor's navigation to its target. False when
 *  it has none or the navigation was refused. */
export function locate(item: LocateItem): boolean {
  const target = locateTarget(item, useProjectStore.getState())
  if (target === null) return false
  switch (target.kind) {
    case 'layer':
      if (!revealLayerWithoutSeek(target.layer_id)) return false
      break
    case 'time':
      if (useCompositionAnchorStore.getState().focusedId !== target.composition_id && !openComposition(target.composition_id, null)) return false
      break
    case 'track': return revealTrackWithoutSelection(target.track_id)
    case 'composition': return openComposition(target.composition_id, null)
  }
  // The composition holding the place is focused now; its own clock projects
  // into the film's through the anchor that open gave it.
  if (target.t_us !== null) jumpToTimeUs(focusedRootUs(target.t_us))
  return true
}
