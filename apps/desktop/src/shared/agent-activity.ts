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
 *  never serialized. `range` says what the tack follows, and is placed when
 *  read (see `TackView`). */
export type TackKind = (typeof TACK_KINDS)[number]
export type TackStatus = (typeof TACK_STATUSES)[number]
/** One end of an `edges` range, tied to the clip that was under it at
 *  creation: the same source-instant pair a `MarkerAnchor` stores. */
export interface TackEdgeAnchor { layer_id: string; src_us: number; src_fraction?: ExactTime }
export type TackRange =
  /** Follows nothing: a time on a composition's clock. What `create_tacks`
   *  stores when neither end had a clip under it. */
  | { kind: 'free'; composition_id: string; t_us: number; end_t_us: number | null }
  /** Pinned to ONE clip by `anchor_layer_id`. `src_fraction` /
   *  `src_end_fraction` carry the sub-microsecond remainder of the source
   *  instant on a retimed layer, exactly as a `MarkerAnchor` does. */
  | { kind: 'anchored'; layer_id: string; src_us: number; src_end_us: number | null; src_fraction?: ExactTime; src_end_fraction?: ExactTime }
  /** Each end follows the clip under it at creation, independently (`null`:
   *  that end was over a gap, or a point's absent end). `composition_id`,
   *  `t_us`, `end_t_us` are the times as created — the fallback a lost or
   *  unanchored end is placed from. At least one of `start` / `end` is set. */
  | { kind: 'edges'; composition_id: string; t_us: number; end_t_us: number | null; start: TackEdgeAnchor | null; end: TackEdgeAnchor | null }
/** Which clip each end of a tack follows; null for an end that follows none
 *  (a free tack, a gap end, a point's end). An anchored tack reports its one
 *  layer for both ends of a region. */
export interface TackFollows { start: { layer_id: string } | null; end: { layer_id: string } | null }
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
 *  are null unless `visible`. `outdated`: a clip the tack covered at creation
 *  has since changed in more than a pure move in time (trimmed, split,
 *  retimed, re-styled, deleted) — by anyone. */
export interface TackView extends Tack {
  composition_id: string | null
  t_us: number | null
  end_t_us: number | null
  state: TackState
  outdated: boolean
  follows: TackFollows
}
/** One of the calling connection's open tacks that a mutating MCP call moved,
 *  resized, put out of place or made outdated — reported on that call's
 *  result as `affected_tacks`. */
export interface AffectedTack { tack_id: string; label: string; change: 'moved' | 'resized' | 'stale' | 'hibernating' | 'outdated' }
/** An open tack of a work session that needs the agent's look before it ends
 *  the session — `end_agent_session`'s `tacks_to_review`. */
export interface TackToReview { tack_id: string; label: string; state: TackState; outdated: boolean }
/** Tacks retained per project opening; beyond it `create_tacks` refuses. */
export const TACK_CAPACITY = 1000
/** A tack's label is a few words (the panel row, the timeline chip); its body
 *  carries the detail. Both bounded so 1000 tacks stay a small payload. */
export const TACK_LABEL_LIMIT = 200
export const TACK_BODY_LIMIT = 4000
export const TACK_KINDS = ['note', 'issue', 'question'] as const
export const TACK_STATUSES = ['open', 'resolved', 'dismissed'] as const
/** The user's tack actions from the agent panel (renderer → main). They go
 *  through the same TackStore and the same activity delta as the MCP verbs, and
 *  record no history. Exactly one selector per delete: the listed ids (all must
 *  exist), every tack of one work session (`null`: those created outside any
 *  session), or every tack whose status is one of `statuses`. */
export type TackDeleteSelector =
  | { tack_ids: string[] }
  | { session_id: string | null }
  | { statuses: TackStatus[] }
export const TACK_SET_STATUS_CHANNEL = 'agent_tacks_set_status'
export const TACK_DELETE_CHANNEL = 'agent_tacks_delete'
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
