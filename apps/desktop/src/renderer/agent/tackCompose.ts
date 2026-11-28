// The "new tack" prompt (ADR 0185): where the user's tack will sit, as
// module-level state so the command works with every panel closed — App
// renders the dialog, as it does the marker rename prompt.
import { create } from 'zustand'
import { displayedFrameStartUs } from '../frames'
import { focusedPlayheadUs } from '../state/playheadProjection'
import { currentOpenComposition, useProjectStore } from '../state/projectStore'
import { rangeInUs, rangeOutUs, resolveMarkedRange } from '../state/rangeStore'

export interface TackPlace { compositionId: string; tUs: number; endTUs: number | null }

interface TackComposeState { place: TackPlace | null }

export const useTackComposeStore = create<TackComposeState>(() => ({ place: null }))

/** Where a new tack goes: the marked range while the open timeline is the
 *  film's (the range is root time) and both its ends are marked, else the
 *  frame under the playhead. One mark alone would stretch the tack to the
 *  film's start or end, which nobody pointed at. */
export function newTackPlace(): TackPlace | null {
  const open = currentOpenComposition()
  if (!open) return null
  const inUs = rangeInUs(), outUs = rangeOutUs()
  if (open.id === useProjectStore.getState().summary?.root_id && inUs !== null && outUs !== null) {
    const marked = resolveMarkedRange(inUs, outUs, open.duration_us)
    if (marked) return { compositionId: open.id, tUs: marked.startUs, endTUs: marked.endUs }
  }
  return { compositionId: open.id, tUs: displayedFrameStartUs(focusedPlayheadUs(), open.fps_num, open.fps_den), endTUs: null }
}

export function openTackCompose(): void {
  const place = newTackPlace()
  if (place) useTackComposeStore.setState({ place })
}

export function closeTackCompose(): void {
  useTackComposeStore.setState({ place: null })
}
