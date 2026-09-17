/** Runtime-only agent activity. Independent of the diagnostic log and edit stack. */
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
export interface AgentActivitySnapshot {
  workspace_id: string
  revision: number
  session: AgentWorkSession | null
  sessions: AgentWorkSession[]
  activities: AgentActivity[]
  evicted: number
  lock_reason: string | null
  checkpoints: Array<{ id: string; label: string }>
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
}
export const AGENT_ACTIVITY_EVENT = 'agent_activity:changed'
export const AGENT_VIEW_EVENT = 'agent_view:enter'
