// Renderer-side reading of tacks (ADR 0115): grouping for the Tacks tab, the
// set a timeline surface paints, and the marker a tack converts into. Pure —
// the store reads and IPC live in `tackActions.ts`.
import { useMemo } from 'react'
import type { AgentActivitySnapshot, AgentWorkSession, TackView } from '../../shared/agent-activity'
import type { MarkerAnchorArg } from '../ipc'
import { useAgentActivity } from './activityStore'

export interface TackGroup {
  /** Expansion key (`tackGroupKey`). */
  key: string
  sessionId: string | null
  /** The work session, while activity still retains it; null for tacks made
   *  outside a session, or of a session whose record has been dropped. */
  session: AgentWorkSession | null
  tacks: TackView[]
}

/** Placed tacks first, in timeline order per composition; unplaced ones after,
 *  in creation order (the input order, which `sort` keeps for ties). */
function byPlacement(a: TackView, b: TackView): number {
  if (a.t_us === null || b.t_us === null) return (a.t_us === null ? 1 : 0) - (b.t_us === null ? 1 : 0)
  if (a.composition_id !== b.composition_id) return 0
  return a.t_us - b.t_us
}

/** Tacks grouped by the work session that created them, groups in order of
 *  their first tack. */
export function groupTacks(tacks: readonly TackView[], sessions: readonly AgentWorkSession[], groupKey: (session: string | null) => string): TackGroup[] {
  const groups = new Map<string | null, TackGroup>()
  for (const t of tacks) {
    let g = groups.get(t.session_id)
    if (!g) {
      g = { key: groupKey(t.session_id), sessionId: t.session_id, session: sessions.find(s => s.id === t.session_id) ?? null, tacks: [] }
      groups.set(t.session_id, g)
    }
    g.tacks.push(t)
  }
  return [...groups.values()].map(g => ({ ...g, tacks: [...g.tacks].sort(byPlacement) }))
}

/** Open tacks placed on `compositionId`'s timeline right now — what a timeline
 *  surface paints. Resolved, dismissed, hibernating and stale ones are listed
 *  in the panel only. */
export function paintableTacks(tacks: readonly TackView[], compositionId: string | null): TackView[] {
  if (compositionId === null) return []
  return tacks.filter(t => t.status === 'open' && t.state === 'visible' && t.composition_id === compositionId && t.t_us !== null)
}

const NO_TACKS: TackView[] = []
export function useCompositionTacks(compositionId: string | null): TackView[] {
  const tacks = useAgentActivity(s => s.snapshot?.tacks ?? NO_TACKS)
  return useMemo(() => paintableTacks(tacks, compositionId), [tacks, compositionId])
}

/** Whether the editor timeline holds its Review lane: the overlay is on and
 *  this project opening has had agent review material — a work session or a
 *  tack of any status.
 *
 *  Deliberately NOT "has open tacks": the row is the ruler family's and adding
 *  one reflows every track below it. Keyed to open or visible tacks, it would
 *  come and go as an agent resolved its last tack or anchored one onto a clip
 *  that slid out of view — a reflow nobody asked for, mid-edit. A work session
 *  begins before the agent's first edit and switches the app to agent mode, so
 *  in practice the row appears while the editor is not on screen, and stays
 *  until the overlay is switched off or another project is opened. */
export function reviewLaneExists(reviewOverlay: boolean, snapshot: Pick<AgentActivitySnapshot, 'sessions' | 'tacks'> | null): boolean {
  return reviewOverlay && snapshot !== null && (snapshot.sessions.length > 0 || snapshot.tacks.length > 0)
}

export function useReviewLaneExists(): boolean {
  return useAgentActivity(s => reviewLaneExists(s.reviewOverlay, s.snapshot))
}

/** Open tack ranges merged into disjoint spans, and the instants of point
 *  tacks no span covers — what a strip too thin to pack chips paints at ONE
 *  opacity, so overlapping tacks never darken into a colour of their own. Both
 *  in time order; touching ranges merge. */
export function tackCoverage(tacks: readonly Pick<TackView, 't_us' | 'end_t_us'>[]): { spans: Array<[number, number]>; points: number[] } {
  const ranges: Array<[number, number]> = []
  const points = new Set<number>()
  for (const t of tacks) {
    if (t.t_us === null) continue
    if (t.end_t_us !== null && t.end_t_us > t.t_us) ranges.push([t.t_us, t.end_t_us])
    else points.add(t.t_us)
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const spans: Array<[number, number]> = []
  for (const [start, end] of ranges) {
    const last = spans.at(-1)
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else spans.push([start, end])
  }
  // A point inside a span is already covered; painted again it would be one
  // more layer of the same hue, the very stacking this exists to avoid.
  const covered = (t: number) => spans.some(([start, end]) => start <= t && t <= end)
  return { spans, points: [...points].filter(t => !covered(t)).sort((a, b) => a - b) }
}

/** The clips a tack follows, start's first, each once: both ends of an edge
 *  range on one clip name it once, an anchored tack names its one clip, a free
 *  one none. */
export function tackFollowedLayers(t: Pick<TackView, 'follows'>): string[] {
  const ids = [t.follows.start?.layer_id, t.follows.end?.layer_id].filter((id): id is string => id !== undefined)
  return [...new Set(ids)]
}

/** Why a tack cannot be located or converted, as an i18n key — or null when
 *  it can. Only a visible tack has a place on a timeline. */
export function tackUnplacedReason(t: TackView): string | null {
  if (t.state === 'stale') return 'tacks.stale_hint'
  if (t.state === 'hibernating') return 'tacks.hibernating_hint'
  return null
}

/** The `add_marker` a tack converts into: its place, its label and body as the
 *  marker's label and note, and the source instant it follows — an anchored
 *  tack's, or an edge-anchored tack's start — so the marker follows the clip as
 *  the tack did (a marker anchors one instant; its region end stays timeline
 *  time). Free otherwise. Null when the tack has no place to convert at. */
export function tackMarkerArgs(t: TackView): {
  compositionId: string; tUs: number; endTUs: number | null; label: string; note: string; anchor: MarkerAnchorArg | null
} | null {
  if (t.state !== 'visible' || t.composition_id === null || t.t_us === null) return null
  const r = t.range
  const instant = r.kind === 'anchored' ? { layer: r.layer_id, src_us: r.src_us, src_fraction: r.src_fraction }
    : r.kind === 'edges' && r.start !== null ? { layer: r.start.layer_id, src_us: r.start.src_us, src_fraction: r.start.src_fraction }
    : null
  const anchor: MarkerAnchorArg | null = instant === null ? null
    : { layer: instant.layer, src_us: instant.src_us, ...(instant.src_fraction ? { src_fraction: instant.src_fraction } : {}) }
  return { compositionId: t.composition_id, tUs: t.t_us, endTUs: t.end_t_us, label: t.label, note: t.body, anchor }
}
