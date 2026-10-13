// Renderer-side reading of tacks (ADR 0115): grouping for the Tacks tab, the
// set a timeline surface paints, and the marker a tack converts into. Pure —
// the store reads and IPC live in `tackActions.ts`.
import { useMemo } from 'react'
import type { AgentWorkSession, TackView } from '../../shared/agent-activity'
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
  return { compositionId: t.composition_id, tUs: t.t_us, endTUs: t.end_t_us, label: t.label, note: t.body, anchor }
}
  const anchor: MarkerAnchorArg | null = instant === null ? null
    : { layer: instant.layer, src_us: instant.src_us, ...(instant.src_fraction ? { src_fraction: instant.src_fraction } : {}) }
