/** Runtime-only agent activity. Independent of the diagnostic log and edit stack. */
import type { ExactTime } from './timeMapping'
import type { ComputePhase } from './compute-jobs'
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
   *  `begin_agent_session { force: true }` — the remedy for an owner that is gone. */
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
  /** `cancelled`: a clip-compute call whose job was cancelled (ADR 0121) —
   *  ended on purpose, so neither done nor a failure. */
  state: 'running' | 'done' | 'error' | 'cancelled'
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
  /** A clip-compute call's job (ADR 0121), kept live while the row runs and
   *  left at its last phase once it ends. */
  compute?: AgentActivityCompute
  /** The calling connection closed while this call was running. The row stays
   *  `running` until the work ends — the job is not cancelled by a disconnect. */
  caller_disconnected?: true
}
export interface AgentActivityCompute { job_id: string; phase: ComputePhase; phase_since: string }
export interface AgentConnection {
  id: string
  client: string
  version: string
  connected_at: string
  last_activity_at: string
}
/** A Tack: a comment on what plays in a time range, opened by an agent for the
 *  user to review or by the user for an agent to act on, and answered by
 *  either side (ADR 0115, ADR 0117, ADR 0185). Runtime-only within a project
 *  opening — not project content, not in history, never serialized. `range`
 *  is where it was made; where it sits now is placed when read (see
 *  `TackView`). */
export type TackKind = (typeof TACK_KINDS)[number]
export type TackStatus = (typeof TACK_STATUSES)[number]
export type TackAuthor = (typeof TACK_AUTHORS)[number]
/** One message after a tack's opening, in the order written. */
export interface TackReply {
  author: TackAuthor
  body: string
  at: string
  /** The agent's MCP client name; null on the user's. */
  client: string | null
  /** When an agent first read this message through the tacks read; always
   *  null on an agent's own. Seen is not handled: see `TackView.awaiting`. */
  seen_at: string | null
}
/** A tack's range as `create_tacks` made it, on its composition's frame grid. */
export interface TackRange { composition_id: string; t_us: number; end_t_us: number | null }
/** The layer a tack's range moves with right now — the first it covered that
 *  still shows the content its covered part started on — and the timeline
 *  time that content reads at now. For a layer with a source window, the
 *  source instant too: the pair a `MarkerAnchor` stores. */
export interface TackFollows { layer_id: string; t_us: number; src_us?: number; src_fraction?: ExactTime }
export interface Tack {
  id: string
  author: TackAuthor
  /** The work session the creating call ran in; null outside one, and on
   *  every user tack. */
  session_id: string | null
  /** The creating MCP call's connection, client and activity; null on a
   *  user tack. */
  connection_id: string | null
  client: string | null
  activity_id: string | null
  /** What an agent's tack asks of the user; null exactly on a user tack,
   *  which always asks for a change. */
  kind: TackKind | null
  label: string
  body: string
  status: TackStatus
  range: TackRange
  created_at: string
  /** A user tack's opening, as `TackReply.seen_at`; null on an agent's. */
  seen_at: string | null
  replies: TackReply[]
}
/** What a tack's icon and chip wear: an agent tack's kind, or `user`. */
export type TackMark = TackKind | 'user'
export const tackMark = (t: Pick<Tack, 'author' | 'kind'>): TackMark => t.author === 'user' || t.kind === null ? 'user' : t.kind
/** A tack as read: the stored record plus its placement, derived from the
 *  current project on every read. The range keeps its length and moves as far
 *  as the content `follows` names moved; `composition_id` / `t_us` / `end_t_us` are null only
 *  when its composition no longer exists. `outdated`: its range no longer
 *  plays what it played at creation, on any track — by anyone's edit. */
export interface TackView extends Tack {
  composition_id: string | null
  t_us: number | null
  end_t_us: number | null
  outdated: boolean
  follows: TackFollows | null
  /** Whose move it is on an open tack: the side that did not write its last
   *  message (the opening when it has no replies). Null once it is closed. */
  awaiting: TackAuthor | null
}
/** One of the calling client's open tacks that a mutating MCP call moved or
 *  made outdated — reported on that call's result as `affected_tacks`. */
export interface AffectedTack { tack_id: string; label: string; change: 'moved' | 'outdated' }
/** An open outdated tack of the client ending its work session —
 *  `end_agent_session`'s `tacks_to_review`. */
export interface TackToReview { tack_id: string; label: string }
/** Tacks retained per project opening; beyond it `create_tacks` refuses. */
export const TACK_CAPACITY = 1000
/** A tack's label is a few words (the panel row, the timeline chip); its body
 *  carries the detail. Both bounded so 1000 tacks stay a small payload. */
export const TACK_LABEL_LIMIT = 200
export const TACK_BODY_LIMIT = 4000
/** Messages a tack holds after its opening; beyond it a reply is refused. */
export const TACK_REPLY_LIMIT = 100
/** A user tack's label: the first line of what they wrote, cut to this. */
export const USER_TACK_LABEL_LENGTH = 80
export const TACK_KINDS = ['note', 'issue', 'question'] as const
export const TACK_STATUSES = ['open', 'resolved', 'dismissed'] as const
export const TACK_AUTHORS = ['agent', 'user'] as const
/** The user's tack actions from the agent panel (renderer → main). They go
 *  through the same TackStore and the same activity delta as the MCP verbs, and
 *  record no history. Exactly one selector per delete: the listed ids (all must
 *  exist), every agent tack of one work session (`null`: those created outside
 *  any session), or every tack whose status is one of `statuses`. */
export type TackDeleteSelector =
  | { tack_ids: string[] }
  | { session_id: string | null }
  | { statuses: TackStatus[] }
/** A user tack as the panel creates it: times on `composition_id`'s timeline. */
export interface UserTackInput { composition_id: string; t_us: number; end_t_us: number | null; text: string }
export const TACK_SET_STATUS_CHANNEL = 'agent_tacks_set_status'
export const TACK_DELETE_CHANNEL = 'agent_tacks_delete'
export const TACK_CREATE_CHANNEL = 'agent_tacks_create'
export const TACK_REPLY_CHANNEL = 'agent_tacks_reply'
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
