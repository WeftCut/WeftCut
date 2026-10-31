import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ActorHandle, ChangeEvent } from '../state/actor'
import { resolveEntityLabels } from '../state/history-labels'
import type { EntityRef } from '../state/history'
import { eachLayer } from '../state/model'
import type { AgentActivity, AgentActivityCompute, AgentActivitySnapshot, AgentWorkSession } from '../../shared/agent-activity'
import { AGENT_ACTIVITY_EVENT, AGENT_VIEW_EVENT, TACK_CAPACITY } from '../../shared/agent-activity'
import { appendToolResultField } from '../state/mcp-results'
import { TackStore, type TackAttribution } from './tacks'
import { isToolError, toolErrorCode } from '../mcp/toolResult'
import type { McpErrorCode, McpToolErrorJson } from '../state/mcp-commands'

const CAPACITY = 1000
/** `committed`: the call reached the actor's commit path at least once. */
interface CallContext { workspace: string; activity: AgentActivity; committed: boolean }

/** Bound diagnostic details before crossing IPC. Never retain binary/tool results. */
export function activityDetails(value: unknown): unknown {
  let budget = 4096
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 5 || budget <= 0) return '[omitted]'
    budget -= 16
    if (typeof input === 'string') {
      const redacted = input.replace(/(authorization:\s*bearer\s+)[\w.-]+/gi, '$1[redacted]')
        .replace(/((?:x-)?api[_-]?key\s*[=:]\s*)["']?[\w.-]+["']?/gi, '$1[redacted]')
      const cap = Math.min(512, Math.max(0, budget))
      const result = redacted.length > cap ? `${redacted.slice(0, cap)}…` : redacted
      budget -= Buffer.byteLength(result)
      return result
    }
    if (Array.isArray(input)) {
      const result: unknown[] = []
      for (const v of input.slice(0, 30)) { if (budget <= 0) break; result.push(walk(v, depth + 1)) }
      return result
    }
    if (input && typeof input === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, v] of Object.entries(input).slice(0, 30)) {
        if (budget <= 0) break
        budget -= Buffer.byteLength(key)
        result[key] = /token|authorization|password|secret|api.?key/i.test(key) ? '[redacted]' : walk(v, depth + 1)
      }
      return result
    }
    return input
  }
  const result = walk(value, 0)
  const text = JSON.stringify(result)
  return text && Buffer.byteLength(text) > 4096 ? { truncated: true, preview: text.slice(0, 1000) } : result
}

/** Who holds the work session or the history lock, as a refusal names it. */
export interface AgentHolder { client: string; connection_id: string; session_id: string | null; reason: string | null; started_at: string | null }

/** A refusal of the agent service, typed: the variant, the envelope code (an
 *  argument cannot fix a busy session, so that is `invalid_request`) and the
 *  holder an agent needs to decide whether to wait or take over. */
export class AgentServiceError extends Error {
  constructor(readonly variant: 'AgentSessionBusy' | 'AgentSessionOwnerMismatch' | 'InvalidArgument' | 'NoMcpConnection', readonly code: McpErrorCode, message: string, readonly holder?: AgentHolder, readonly field?: string) {
    super(message)
    this.name = 'AgentServiceError'
  }
  toJson(): McpToolErrorJson {
    const options = this.variant === 'AgentSessionBusy' || this.variant === 'AgentSessionOwnerMismatch'
      ? [{ action: 'wait_for_session_end' }, { action: 'take_over', tool: 'begin_agent_session', force: true }]
      : undefined
    return { code: this.code, message: this.message, data: { error: this.variant, ...(this.holder ? { holder: this.holder } : {}), ...(this.field ? { field: this.field } : {}), ...(options ? { options } : {}) } }
  }
}

/** One project-open instance. AsyncLocalStorage preserves attribution through
 * native-compute awaits without observing another request's commits. */
export class AgentActivityService {
  private context = new AsyncLocalStorage<CallContext>()
  private workspace = randomUUID()
  private revision = 0
  private activities: AgentActivity[] = []
  private sessions: AgentWorkSession[] = []
  private active: AgentWorkSession | null = null
  private evicted = 0
  private scheduled = false
  private dirty = new Set<string>()
  private removed: string[] = []
  private resetPending = false
  private publishedRevision = 0
  private unsubscribe: (() => void) | null = null
  private dirtyTacks = new Set<string>()
  private removedTacks: string[] = []
  /** This project opening's tacks (ADR 0115): reset with the activity, and
   *  published through the same deltas under the same workspace and revision. */
  readonly tacks: TackStore

  constructor(private actor: ActorHandle, private send: (event: string, payload: unknown) => void, private capacity = CAPACITY, tackCapacity = TACK_CAPACITY) {
    this.tacks = new TackStore({
      capacity: tackCapacity,
      project: () => this.actor.snapshot(),
      caller: () => this.currentCall(),
      changed: (dirty, removed) => {
        for (const id of dirty) this.dirtyTacks.add(id)
        for (const id of removed) { this.dirtyTacks.delete(id); this.removedTacks.push(id) }
        this.publish()
      },
    })
  }

  /** The MCP call running in this async context: its activity, connection and
   *  work session. Null outside a call, and inside one that began in an earlier
   *  project opening — its late results must not populate this one. */
  currentCall(): TackAttribution | null {
    const ctx = this.context.getStore()
    if (!ctx || ctx.workspace !== this.workspace || ctx.activity.connection_id === null) return null
    const a = ctx.activity
    return { session_id: a.session_id, connection_id: a.connection_id!, client: a.client, activity_id: a.id }
  }

  start(): void { this.unsubscribe ??= this.actor.subscribe(e => this.onChange(e)) }
  stop(): void { this.unsubscribe?.(); this.unsubscribe = null }

  snapshot(): AgentActivitySnapshot {
    const tacks = this.tacks.views()
    return structuredClone({
      workspace_id: this.workspace, revision: this.revision, session: this.active,
      sessions: this.sessions, activities: this.activities, evicted: this.evicted,
      lock_reason: this.actor.historyStatus().lock_reason ?? null,
      checkpoints: this.actor.listCheckpoints().map(({ id, label }) => ({ id, label })),
      tacks,
    })
  }

  private publish(activity?: AgentActivity): void {
    if (activity) this.dirty.add(activity.id)
    this.revision++
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const update = structuredClone({
        workspace_id: this.workspace, revision: this.revision, from_revision: this.publishedRevision,
        reset: this.resetPending, removed_ids: this.removed,
        session: this.active, sessions: this.sessions,
        activities: this.activities.filter(a => this.dirty.has(a.id)), evicted: this.evicted,
        lock_reason: this.actor.historyStatus().lock_reason ?? null,
        checkpoints: this.actor.listCheckpoints().map(({ id, label }) => ({ id, label })),
        tacks: this.tacks.viewsOf(this.dirtyTacks), removed_tack_ids: this.removedTacks,
      })
      this.dirty.clear(); this.removed = []; this.resetPending = false
      this.dirtyTacks.clear(); this.removedTacks = []
      this.publishedRevision = this.revision
      this.send(AGENT_ACTIVITY_EVENT, update)
    })
  }

  reset(): void {
    this.workspace = randomUUID()
    this.active = null
    this.sessions = []
    this.activities = []
    this.evicted = 0
    this.tacks.clear()
    this.dirty.clear(); this.removed = []; this.resetPending = true
    this.dirtyTacks.clear(); this.removedTacks = []
    this.publish()
  }

  refresh(): void { this.refreshEffects(); this.tacks.refresh(); this.publish() }

  private trim(): void {
    // Running entries are never evicted. Capacity counts completed activities.
    let excess = this.activities.filter(a => a.state !== 'running').length - this.capacity
    if (excess > 0) this.activities = this.activities.filter(a => {
      if (a.state !== 'running' && excess > 0) { excess--; this.evicted++; this.removed.push(a.id); return false }
      return true
    })
    const retained = new Set(this.activities.map(a => a.session_id))
    this.sessions = this.sessions.filter(s => s === this.active || retained.has(s.id))
  }

  async run<T>(connection: string, client: string, tool: string, args: unknown, read: boolean, fn: () => T | Promise<T>): Promise<T> {
    const now = new Date().toISOString()
    const project = this.actor.snapshot()
    const input = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    const affected: EntityRef[] = []
    const layers = new Set([...eachLayer(project)].map(({ layer }) => layer.id))
    const tracks = new Set(Object.values(project.compositions).flatMap(c => c.tracks.map(t => t.id)))
    const candidates = [input.layer_id, input.layer, input.id, input.track_id, input.track,
      ...(Array.isArray(input.layer_ids) ? input.layer_ids : [])]
    for (const id of candidates) {
      if (typeof id !== 'string') continue
      const kind = layers.has(id) ? 'Layer' : tracks.has(id) ? 'Track' : null
      if (kind && !affected.some(ref => ref.id === id)) affected.push({ kind, id })
    }
    const entityLabels = resolveEntityLabels(project, null, affected)
    const mediaId = typeof input.media_id === 'string' ? input.media_id : typeof input.uri === 'string' ? /^media:\/\/([^/]+)/.exec(input.uri)?.[1] : undefined
    const media = mediaId ? project.media_pool[mediaId] : undefined
    if (media) entityLabels.push({ text: media.path_abs.split(/[\\/]/).at(-1) ?? media.path_abs })
    const activity: AgentActivity = {
      id: randomUUID(), session_id: this.active?.connection_id === connection ? this.active.id : null,
      connection_id: connection, client, tool, kind: read ? 'read' : 'operation',
      started_at: now, ended_at: null, state: 'running', duration_ms: null,
      message: tool, affected, entity_labels: entityLabels, history_ids: [], effect: null,
      args: activityDetails(args), error: null,
    }
    const ctx: CallContext = { workspace: this.workspace, activity, committed: false }
    this.activities.push(activity)
    this.publish(activity)
    // A mutating call answers with what it did to the caller's own open tacks
    // (`affected_tacks`), so an agent learns its edit moved or outdated a tack
    // it left. Read before the call starts; null — and nothing more to do —
    // when this client holds no open tack.
    const watched = read ? null : this.tacks.watch(client)
    return this.context.run(ctx, async () => {
      try {
        let result = await fn()
        if (isToolError(result) && toolErrorCode(result) === 'cancelled') {
          // A job someone cancelled ended on purpose: not a failure, and the
          // "Cancelled" text is the state itself, not an error to show.
          activity.state = 'cancelled'
        } else if (result && typeof result === 'object' && 'isError' in result && result.isError) {
          activity.state = 'error'
          const errorResult = result as { content?: Array<{ text?: string }> }
          activity.error = String(activityDetails(errorResult.content?.map(c => c.text ?? '').join('\n') || 'Tool failed'))
        } else {
          activity.state = 'done'
          if (watched !== null && ctx.committed && ctx.workspace === this.workspace) {
            const affected = this.tacks.affectedSince(watched)
            if (affected.length) result = appendToolResultField(result, 'affected_tacks', affected)
          }
        }
        return result
      } catch (error) {
        activity.state = 'error'
        activity.error = String(activityDetails(error instanceof Error ? error.message : String(error)))
        throw error
      } finally {
        activity.ended_at = new Date().toISOString()
        activity.duration_ms = Date.parse(activity.ended_at) - Date.parse(now)
        if (ctx.workspace === this.workspace) { this.refreshEffects(); this.trim(); this.publish(activity) }
      }
    })
  }

  /** A clip-compute call's job and phase, onto its row while it runs. The
   *  caller captured the id inside its call (`currentCall`), because phases
   *  arrive from native events outside that async context. A row that ended,
   *  was evicted or belongs to an earlier opening is left alone. */
  setCompute(activityId: string, compute: AgentActivityCompute): void {
    const a = this.activities.find(x => x.id === activityId)
    if (!a || a.state !== 'running') return
    a.compute = structuredClone(compute)
    this.publish(a)
  }

  /** Begin this connection's work session, or answer the one it holds.
   *  `lock` (default true) locks history for everyone but this session's own
   *  connection, so the user's undo waits while the agent can still undo its
   *  own mistake. The default applies to the first begin only: a repeat
   *  changes the lock only when `lock` is passed, so a repeat never undoes
   *  the user's Unlock behind their back. `force` ends another
   *  connection's session first (`end_reason: 'forced'`) — the takeover of a
   *  session whose owner is gone, in one call. */
  begin(reason: string, opts: { lock?: boolean; force?: boolean } = {}): AgentWorkSession {
    const ctx = this.context.getStore()
    if (!ctx || ctx.workspace !== this.workspace) throw new AgentServiceError('NoMcpConnection', 'internal', 'An agent work session needs a current MCP connection, and this call has none')
    const connection = ctx.activity.connection_id!
    if (this.active && this.active.connection_id === connection) {
      ctx.activity.session_id = this.active.id
      if (opts.lock !== undefined) this.setLock(this.active, opts.lock)
      return this.active
    }
    if (!reason.trim()) throw new AgentServiceError('InvalidArgument', 'invalid_params', 'reason must be non-empty: say in a few words what the session is for', undefined, 'reason')
    if (this.active) {
      if (opts.force !== true) throw new AgentServiceError('AgentSessionBusy', 'invalid_request', `Another work session is running: ${this.describeOwner()}. Wait for it to finish, or take it over with begin_agent_session { force: true } when its owner is gone (a connection whose stream dropped is closed automatically, but not instantly). read_project { view: "session" } shows the holder.`, this.holder())
      this.close(this.active, 'forced')
    }
    const checkpoint = this.actor.checkpoint(`Pre-agent: ${reason.trim()}`, { kind: 'Agent', client: ctx.activity.client })
    this.actor.pinReviewBaseline(checkpoint)
    const session: AgentWorkSession = {
      id: randomUUID(), connection_id: connection, client: ctx.activity.client, reason: reason.trim(),
      started_at: new Date().toISOString(), ended_at: null, end_reason: null, checkpoint_id: checkpoint,
    }
    this.active = session
    this.sessions.push(session)
    ctx.activity.session_id = session.id
    this.checkpoint('checkpoint', checkpoint, `Pre-agent: ${session.reason}`)
    this.setLock(session, opts.lock ?? true)
    this.publish()
    this.send(AGENT_VIEW_EVENT, { workspace_id: this.workspace, session_id: session.id })
    return session
  }

  /** Lock history for `session`, exempting its own connection's calls, or
   *  release the lock. Only a session takes the lock, so it is the holder. */
  private setLock(session: AgentWorkSession, locked: boolean): void {
    if (locked === this.locked()) return
    if (locked) this.actor.lockHistory(session.reason, () => this.currentCall()?.connection_id === session.connection_id)
    else this.actor.unlockHistory()
    this.publish()
  }

  /** Whether history is locked now (the user may have unlocked it). */
  locked(): boolean { return this.actor.historyStatus().lock_reason !== undefined }

  /** The active session's holder, for the two refusals' data. */
  private holder(): AgentHolder {
    const s = this.active!
    return { client: s.client, connection_id: s.connection_id, session_id: s.id, reason: s.reason, started_at: s.started_at }
  }

  /** Who holds the history lock — the active session, the only taker — or
   *  null when history is not locked. `HistoryLocked` names it. */
  lockHolder(): AgentHolder | null {
    return this.active && this.locked() ? this.holder() : null
  }

  /** Who holds the session, for the two refusals: the client, a short
   *  connection id, the reason it gave and how long ago it began. */
  private describeOwner(): string {
    const s = this.active!
    const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(s.started_at)) / 60_000))
    return `${s.client} (connection ${s.connection_id.slice(0, 8)}…) began the work session "${s.reason}" ${ageMin} min ago (${s.started_at})`
  }

  /** End the active session: the owner's `end_agent_session` ('agent'), the
   *  panel's End ('user'), or its connection going away ('disconnected', with
   *  that connection; another connection's session is left alone). Any other
   *  caller is refused: a stale session is taken over by `begin { force }`.
   *  The session's history lock goes with it — a lock whose owner is gone
   *  blocks every revert for nobody. */
  end(reason: 'agent' | 'user' | 'disconnected', connection?: string): void {
    if (reason === 'disconnected' && connection !== undefined) this.markDisconnected(connection)
    if (!this.active) return
    const caller = connection ?? this.context.getStore()?.activity.connection_id
    if (reason !== 'user' && caller !== this.active.connection_id) {
      if (reason === 'disconnected') return
      throw new AgentServiceError('AgentSessionOwnerMismatch', 'invalid_request', `This work session belongs to another connection: ${this.describeOwner()}; only that connection can end it. begin_agent_session { force: true } takes it over when its owner is gone.`, this.holder())
    }
    this.close(this.active, reason)
  }

  private close(ended: AgentWorkSession, reason: NonNullable<AgentWorkSession['end_reason']>): void {
    ended.ended_at = new Date().toISOString()
    ended.end_reason = reason
    this.active = null
    if (this.locked()) this.actor.unlockHistory()
    this.trim()
    this.publish()
  }

  /** The connection's calls still running are flagged, not ended: a call
   *  outlives its caller (a clip-compute job runs on so a retry can join it),
   *  and its row ends when the call returns, as every row does. */
  private markDisconnected(connection: string): void {
    for (const a of this.activities) {
      if (a.state !== 'running' || a.connection_id !== connection || a.caller_disconnected) continue
      a.caller_disconnected = true
      this.publish(a)
    }
  }

  /** The user's Unlock: history opens for everyone; the session runs on. */
  unlock(): void { this.actor.unlockHistory(); this.publish() }

  checkpoint(kind: 'checkpoint' | 'restore', id: string, label: string): void {
    const ctx = this.context.getStore()
    if (ctx && ctx.workspace !== this.workspace) return
    if (ctx) {
      Object.assign(ctx.activity, { kind, checkpoint_id: id, message: label })
      this.dirty.add(ctx.activity.id)
    } else {
      const now = new Date().toISOString()
      const historyId = kind === 'restore' ? this.actor.historyView(1).ops[0]?.op_id : undefined
      this.activities.push({
        id: randomUUID(), session_id: this.active?.id ?? null, connection_id: null, client: '',
        tool: kind, kind, started_at: now, ended_at: now, state: 'done', duration_ms: 0,
        message: label, affected: [], entity_labels: [], history_ids: historyId ? [historyId] : [], effect: historyId ? 'applied' : null,
        args: {}, error: null, checkpoint_id: id,
      })
      this.dirty.add(this.activities.at(-1)!.id)
    }
    this.trim()
    this.publish()
  }

  private onChange(e: ChangeEvent): void {
    if (e.summary === 'Replaced project state') { this.reset(); return }
    const ctx = this.context.getStore()
    if (ctx?.workspace === this.workspace) {
      ctx.committed = true
      const entry = this.actor.historyView(1).ops.find(op => op.op_id === (e.history_op_id ?? e.op_id))
      const a = ctx.activity
      this.dirty.add(a.id)
      a.message = e.summary
      const refs = entry?.affected ?? e.affected
      const labels = entry?.entity_labels ?? resolveEntityLabels(e.new_snapshot, null, refs)
      refs.forEach((ref, i) => {
        if (a.affected.some(r => r.kind === ref.kind && r.id === ref.id)) return
        a.affected.push(ref)
        if (labels[i]) a.entity_labels.push(labels[i])
      })
      if (entry) {
        a.history_ids.push(entry.op_id)
        a.label_key = entry.label_key
        if (entry.label_args) a.label_args = entry.label_args
      }
    }
    this.refreshEffects()
    // Tacks are placed and compared against the project, so an edit can move
    // or outdate them.
    this.tacks.refresh()
    this.publish()
  }

  private refreshEffects(): void {
    for (const a of this.activities) {
      if (!a.history_ids.length) continue
      const states = this.actor.historyEffects(a.history_ids)
      const effect = states.every(s => s === 'applied') ? 'applied'
        : states.every(s => s === 'reverted') ? 'reverted'
        : states.includes('unknown') ? 'unknown' : 'partial'
      if (a.effect !== effect) { a.effect = effect; this.dirty.add(a.id) }
    }
  }
}
