// Locating a review item — a change or a tack — on the editor timeline
// (ADR 0115). Object navigation is the editor's alone
// (docs/mcp.md#agent-panel-and-lifecycle). The agent view, which is for
// watching, only jumps its preview to where the item plays in the film
// (`jump`), through any Group holding it: no selection, no composition
// entered, no other timeline opened.
//
// One pure resolver says where an item can be found in the project as it is
// now (`locateTarget`); whether Locate or Jump is offered and what it does
// all read that one answer, so a button is never enabled for a place the
// press cannot reach.
import type { TackView } from '../../shared/agent-activity'
import type { Change } from '../../shared/review'
import { openComposition, pathToComposition, shownTimelineId, useCompositionAnchorStore } from '../state/compositionAnchorStore'
import { anchorFrame, localToRootIn, type AnchorFrame } from '../render/timeProjection'
import { jumpToTimeUs, revealLayerWithoutSeek, revealTrackWithoutSelection } from '../state/navigation'
import { focusedRootUs, seekLocalUs } from '../state/playheadProjection'
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

/** Where on composition `compositionId`'s own clock `item` sits: its clip's
 *  place, or its own, when that is on this composition. Null when it has none
 *  here — inside a Group, or on a track or composition as a whole. Pure. */
export function placeOn(item: LocateItem, index: LocateIndex, compositionId: string): number | null {
  const target = locateTarget(item, index)
  if (target?.kind === 'layer') return target.t_us !== null && index.compositionIdByLayerId.get(target.layer_id) === compositionId ? target.t_us : null
  if (target?.kind === 'time') return target.composition_id === compositionId ? target.t_us : null
  return null
}

/** Where `item` plays in the film, on the root's clock: its place on the
 *  root, else its footprint on the Group holding it, carried out through that
 *  Group's placement (`frameOf`) to the first moment the placement shows any
 *  of it. Null when it shows none — trimmed away, or nothing places the
 *  Group. Pure. */
export function filmPlace(item: LocateItem, index: LocateIndex, frameOf: (compositionId: string) => AnchorFrame | null): number | null {
  const root = index.summary?.root_id
  if (root === undefined) return null
  const own = placeOn(item, index, root)
  if (own !== null) return own
  const span = spanOf(item, index)
  const frame = span === null ? null : frameOf(span.compositionId)
  if (span === null || frame === null) return null
  const start = localToRootIn(frame, span.startUs)
  const end = localToRootIn(frame, span.endUs)
  const from = Math.max(start, frame.windowStartUs)
  const shows = end > start ? from < Math.min(end, frame.windowEndUs) : from === start && start < frame.windowEndUs
  return shows ? from : null
}

/** The stretch `item` covers on the composition holding its place, from that
 *  place: a change's footprint there, a tack's span, else a point. */
function spanOf(item: LocateItem, index: LocateIndex): { compositionId: string; startUs: number; endUs: number } | null {
  const target = locateTarget(item, index)
  const compositionId = target?.kind === 'layer' ? index.compositionIdByLayerId.get(target.layer_id)
    : target?.kind === 'time' ? target.composition_id : undefined
  if (compositionId === undefined || target === null || !('t_us' in target) || target.t_us === null) return null
  const startUs = target.t_us
  let endUs = startUs
  if (item.kind === 'change') {
    const c = item.change
    const r = (c.ranges.length ? c.ranges : c.before_ranges ?? []).find(x => x.composition_id === compositionId && x.t_start_us === startUs)
    if (r) endUs = r.t_end_us
  } else if (item.tack.end_t_us !== null) endUs = item.tack.end_t_us
  return { compositionId, startUs, endUs }
}

/** Where the preview shows `item`, on the clock of the timeline on screen:
 *  in the film (the agent view's), through any Group holding it. */
function shownPlace(item: LocateItem): { compositionId: string; tUs: number } | null {
  const compositionId = shownTimelineId()
  const index = useProjectStore.getState()
  if (compositionId === null || index.summary === null) return null
  const summary = index.summary
  const tUs = compositionId === summary.root_id
    ? filmPlace(item, index, (id) => {
      const path = pathToComposition(id)
      return path === null ? null : anchorFrame(summary, path)
    })
    : placeOn(item, index, compositionId)
  return tUs === null ? null : { compositionId, tUs }
}

/** Whether the agent view can jump its preview to `item`: it plays there. */
export function canJump(item: LocateItem): boolean {
  return shownPlace(item) !== null
}

/** Move the preview to where `item` plays, and nothing else; playback does
 *  not start. False when it plays nowhere the preview shows. */
export function jump(item: LocateItem): boolean {
  const place = shownPlace(item)
  if (place === null) return false
  seekLocalUs(place.compositionId, place.tUs)
  return true
}
