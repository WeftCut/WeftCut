/** Runtime-only agent activity. Independent of the diagnostic log and edit stack. */
import type { ExactTime } from './timeMapping'
export type AgentEntityRef = { kind: 'Layer' | 'Track' | 'Marker' | 'Media' | 'Transition' | 'Composition'; id: string }
export type AgentEntityLabel = { text: string } | { label_key: string; label_args?: Record<string, string | number> }
export interface AgentWorkSession {
  id: string
  connection_id: string
  client: string
  reason: string
  started_at: string
  ended_at: string | null
  /** `forced` = another connection took the session over with
   *  `end_agent_session { force: true }` — the remedy for an owner that is gone. */
  end_reason: 'agent' | 'user' | 'disconnected' | 'forced' | null
  checkpoint_id: string
}
export interface AgentActivity {
  id: string
  session_id: string | null
  connection_id: string | null
  client: string
  tool: string
  kind: 'read' | 'operation' | 'checkpoint' | 'restore'
  started_at: string
  ended_at: string | null
  state: 'running' | 'done' | 'error'
  duration_ms: number | null
  message: string
  label_key?: string
  label_args?: Record<string, string | number>
  affected: AgentEntityRef[]
  entity_labels: AgentEntityLabel[]
  history_ids: string[]
  effect: 'applied' | 'reverted' | 'partial' | 'unknown' | null
  args: unknown
  error: string | null
  checkpoint_id?: string
}
export interface AgentConnection {
  id: string
  client: string
  version: string
  connected_at: string
  last_activity_at: string
}
/** A Tack: a time range an agent points the user at for review (ADR 0115).
 *  Runtime-only within a project opening — not project content, not in history,
 *  never serialized. `range` is free on a composition's clock, or anchored to a
 *  layer's SOURCE time and placed when read (see `TackView`). */
export type TackKind = (typeof TACK_KINDS)[number]
export type TackStatus = (typeof TACK_STATUSES)[number]
export type TackRange =
  | { kind: 'free'; composition_id: string; t_us: number; end_t_us: number | null }
  /** `src_fraction` / `src_end_fraction` carry the sub-microsecond remainder
   *  of the source instant on a retimed layer, exactly as a `MarkerAnchor` does. */
  | { kind: 'anchored'; layer_id: string; src_us: number; src_end_us: number | null; src_fraction?: ExactTime; src_end_fraction?: ExactTime }
export interface Tack {
  id: string
  /** The work session the creating call ran in; null outside one. */
  session_id: string | null
  connection_id: string
  client: string
  /** The agent activity of the `create_tacks` call. */
  activity_id: string
  kind: TackKind
  label: string
  body: string
  status: TackStatus
  range: TackRange
  created_at: string
}
/** `visible`: placed on a timeline. `hibernating`: its anchor layer exists but
 *  the layer's source window no longer covers the instant. `stale`: its anchor
 *  layer (or a free tack's composition) exists nowhere. */
export type TackState = 'visible' | 'hibernating' | 'stale'
/** A tack as read: the stored record plus its placement, derived from the
 *  current project on every read. `composition_id` is where it is placed (an
 *  anchored tack's layer's composition), null when stale; `t_us` / `end_t_us`
 *  are null unless `visible`. */
export interface TackView extends Tack {
  composition_id: string | null
  t_us: number | null
  end_t_us: number | null
  state: TackState
}
/** Tacks retained per project opening; beyond it `create_tacks` refuses. */
export const TACK_CAPACITY = 1000
/** A tack's label is a few words (the panel row, the timeline band); its body
 *  carries the detail. Both bounded so 1000 tacks stay a small payload. */
export const TACK_LABEL_LIMIT = 200
export const TACK_BODY_LIMIT = 4000
export const TACK_KINDS = ['note', 'issue', 'question'] as const
export const TACK_STATUSES = ['open', 'resolved', 'dismissed'] as const
export interface AgentActivitySnapshot {
  workspace_id: string
  revision: number
  session: AgentWorkSession | null
  sessions: AgentWorkSession[]
  activities: AgentActivity[]
  evicted: number
  lock_reason: string | null
  checkpoints: Array<{ id: string; label: string }>
  /** Every tack of this project opening, in creation order. In an update:
   *  only the tacks whose record or placement changed. */
  tacks: TackView[]
}
export interface AgentConnectionSnapshot {
  available: boolean
  url: string
  connections: AgentConnection[]
}
/** A delta against from_revision; a gap is repaired with a fresh snapshot. */
export interface AgentActivityUpdate extends AgentActivitySnapshot {
  from_revision: number
  reset: boolean
  removed_ids: string[]
  removed_tack_ids: string[]
}
export const AGENT_ACTIVITY_EVENT = 'agent_activity:changed'
export const AGENT_VIEW_EVENT = 'agent_view:enter'
