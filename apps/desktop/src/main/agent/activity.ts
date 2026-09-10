import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ActorHandle, ChangeEvent } from '../state/actor'
import { resolveEntityLabels } from '../state/history-labels'
import type { EntityRef } from '../state/history'
import { eachLayer } from '../state/model'
import type { AgentActivity, AgentActivitySnapshot, AgentWorkSession } from '../../shared/agent-activity'
import { AGENT_ACTIVITY_EVENT, AGENT_VIEW_EVENT } from '../../shared/agent-activity'

const CAPACITY = 1000
interface CallContext { workspace: string; activity: AgentActivity }

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
  private lockOwner: { connection: string; session: string | null } | null = null
  private scheduled = false
  private dirty = new Set<string>()
  private removed: string[] = []
  private resetPending = false
  private publishedRevision = 0
  private unsubscribe: (() => void) | null = null

  constructor(private actor: ActorHandle, private send: (event: string, payload: unknown) => void, private capacity = CAPACITY) {}

  start(): void { this.unsubscribe ??= this.actor.subscribe(e => this.onChange(e)) }
  stop(): void { this.unsubscribe?.(); this.unsubscribe = null }

  snapshot(): AgentActivitySnapshot {
    return structuredClone({
      workspace_id: this.workspace, revision: this.revision, session: this.active,
      sessions: this.sessions, activities: this.activities, evicted: this.evicted,
      lock_reason: this.actor.historyStatus().lock_reason ?? null,
      checkpoints: this.actor.listCheckpoints().map(({ id, label }) => ({ id, label })),
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
      })
      this.dirty.clear(); this.removed = []; this.resetPending = false
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
    this.lockOwner = null
    this.dirty.clear(); this.removed = []; this.resetPending = true
    this.publish()
  }

  refresh(): void { this.refreshEffects(); this.publish() }

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
    const ctx: CallContext = { workspace: this.workspace, activity }
    this.activities.push(activity)
    this.publish(activity)
    return this.context.run(ctx, async () => {
      try {
        const result = await fn()
        if (result && typeof result === 'object' && 'isError' in result && result.isError) {
          activity.state = 'error'
          const errorResult = result as { content?: Array<{ text?: string }> }
          activity.error = String(activityDetails(errorResult.content?.map(c => c.text ?? '').join('\n') || 'Tool failed'))
        } else activity.state = 'done'
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

  begin(reason: string): AgentWorkSession {
    const ctx = this.context.getStore()
    if (!ctx || ctx.workspace !== this.workspace) throw new Error('Agent session requires a current MCP connection')
    const connection = ctx.activity.connection_id!
    if (this.active) {
      if (this.active.connection_id !== connection) throw new Error('AgentSessionBusy: another connection has an active work session')
      ctx.activity.session_id = this.active.id
      return this.active
    }
    if (!reason.trim()) throw new Error('Agent session reason must be non-empty')
    const checkpoint = this.actor.checkpoint(`Pre-agent: ${reason.trim()}`, { kind: 'Agent', client: ctx.activity.client })
    const session: AgentWorkSession = {
      id: randomUUID(), connection_id: connection, client: ctx.activity.client, reason: reason.trim(),
      started_at: new Date().toISOString(), ended_at: null, end_reason: null, checkpoint_id: checkpoint,
    }
    this.active = session
    this.sessions.push(session)
    ctx.activity.session_id = session.id
    this.checkpoint('checkpoint', checkpoint, `Pre-agent: ${session.reason}`)
    this.publish()
    this.send(AGENT_VIEW_EVENT, { workspace_id: this.workspace, session_id: session.id })
    return session
  }

  end(reason: 'agent' | 'user' | 'disconnected', connection?: string): void {
    if (!this.active) return
    const caller = connection ?? this.context.getStore()?.activity.connection_id
    if (reason !== 'user' && caller !== this.active.connection_id) {
      if (reason === 'disconnected') return
      throw new Error('AgentSessionOwnerMismatch: only the owning connection can end this session')
    }
    const ended = this.active
    ended.ended_at = new Date().toISOString()
    ended.end_reason = reason
    this.active = null
    if (this.lockOwner?.session === ended.id && this.lockOwner.connection === ended.connection_id) this.unlock()
    this.trim()
    this.publish()
  }

  lock(reason: string): void {
    const ctx = this.context.getStore()
    this.actor.lockHistory(reason)
    this.lockOwner = ctx ? { connection: ctx.activity.connection_id!, session: ctx.activity.session_id } : null
    this.publish()
  }

  unlock(): void { this.actor.unlockHistory(); this.lockOwner = null; this.publish() }

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
