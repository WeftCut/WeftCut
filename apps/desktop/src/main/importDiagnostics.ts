import { uuidV7Gen } from './state/ids'
import type { MediaItem } from './state/model'
import { IMPORT_DIAGNOSTIC_TRACK, IMPORT_MILESTONES, type ImportStageEvent } from '../shared/import-diagnostics'

type Entry = {
  level: 'debug' | 'info' | 'warn'
  category: { kind: 'Import' }
  source: { kind: 'System' }
  message: string
  details: Record<string, unknown>
}
type Trace = {
  id: string; start: number; media?: string; requestDone: boolean; requestFailed: boolean; summaryDone: boolean
  decisionPending: boolean; expected: Set<string>; stages: Map<string, ImportStageEvent>
  milestones: Map<string, number>; failed: boolean; landed: Set<string>
}
export interface ImportTrace {
  id: string
  bind(item: MediaItem, copy: boolean): void
  queued(): void
  fail(error: unknown): void
}

/** One bounded, workspace-scoped correlator for UI AND MCP imports. Native
 * tasks report their own queue/work clocks; renderer milestones are observed
 * on main's clock (IPC latency included). Logging can never fail an import. */
export class ImportDiagnostics {
  private traces = new Map<string, Trace>()
  private byMedia = new Map<string, Trace>()
  constructor(private deps: {
    emit: (entry: Entry) => void
    send: (event: string, payload: unknown) => void
    version: string
    now?: () => number
    id?: () => string
  }) {}
  private now() { return this.deps.now?.() ?? performance.now() }
  private send(payload: unknown) { try { this.deps.send(IMPORT_DIAGNOSTIC_TRACK, payload) } catch { /* diagnostics */ } }
  private log(t: Trace, stage: string, details: Record<string, unknown>, level: Entry['level'] = 'debug') {
    try {
      this.deps.emit({ level, category: { kind: 'Import' }, source: { kind: 'System' },
        message: `Import timing: ${stage}`, details: { ...details, schema: 1,
          import_id: t.id, media_id: t.media ?? null, stage,
          elapsed_ms: Math.max(0, this.now() - t.start), app_version: this.deps.version } })
    } catch { /* diagnostics must not affect import */ }
  }
  begin(): ImportTrace {
    if (this.traces.size >= 2048) {
      const oldest = this.traces.values().next().value!
      this.log(oldest, 'tracking_ended', { reason: 'capacity', background_completed: oldest.summaryDone }, 'info')
      this.remove(oldest)
    }
    const t: Trace = { id: this.deps.id?.() ?? uuidV7Gen()(), start: this.now(), requestDone: false, requestFailed: false,
      summaryDone: false, decisionPending: true, expected: new Set(['probe', 'hash']), stages: new Map(), milestones: new Map(), failed: false, landed: new Set() }
    this.traces.set(t.id, t)
    this.log(t, 'requested', {}, 'info')
    return {
      id: t.id,
      bind: (item, copy) => {
        if (!this.traces.has(t.id)) return
        t.media = item.id
        this.byMedia.set(item.id, t)
        if (copy) t.expected.add('copy')
        this.log(t, 'registered', { media_label: item.label, size_bytes: item.file_size, kind: item.kind,
          duration_us: item.metadata.duration_us, video: item.metadata.video, audio: item.metadata.audio })
        this.send({ import_id: t.id, media_id: item.id })
      },
      queued: () => { if (this.traces.has(t.id)) { t.requestDone = true; this.log(t, 'request_completed', {}); this.summary(t) } },
      fail: error => {
        if (!this.traces.has(t.id)) return
        this.log(t, 'request_failed', { error: String(error) }, 'warn')
        t.requestFailed = true
        this.send({ import_id: t.id, remove: true })
      },
    }
  }
  native(event: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    const t = typeof p.import_id === 'string' ? this.traces.get(p.import_id)
      : typeof p.media_id === 'string' ? this.byMedia.get(p.media_id)
      : typeof p.mediaId === 'string' ? this.byMedia.get(p.mediaId) : undefined
    if (!t) return
    if (event === 'import:diagnostic-plan') {
      if (Array.isArray(p.stages)) for (const stage of p.stages) if (typeof stage === 'string') t.expected.add(stage)
      t.decisionPending = p.decision_pending === true
      this.summary(t)
    } else if (event === 'import:diagnostic') {
      const stage = payload as ImportStageEvent
      this.log(t, stage.stage, { ...stage }, stage.status === 'failed' ? 'warn' : 'debug')
      t.stages.set(stage.stage, stage)
      if (stage.status === 'failed' || stage.status === 'cancelled') t.failed = true
      this.summary(t)
    } else if (['media:job_complete', 'media:job_error', 'import:complete', 'import:error'].includes(event)) {
      const stage = event.startsWith('import:') ? 'copy' : String(p.kind)
      t.landed.add(stage)
      if (event.endsWith('error')) {
        t.failed = true
        this.log(t, `${stage}_writeback`, { status: 'failed', error: p.error ?? p.detail }, 'warn')
      }
      this.summary(t)
    }
  }
  milestone(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    const t = typeof p.import_id === 'string' ? this.traces.get(p.import_id) : undefined
    if (!t || t.requestFailed || p.media_id !== t.media || !IMPORT_MILESTONES.some(name => name === p.milestone)) return
    const name = p.milestone as string
    if (t.milestones.has(name)) return
    const ms = Math.max(0, this.now() - t.start)
    t.milestones.set(name, ms)
    this.log(t, name, { engine: typeof p.engine === 'string' ? p.engine : undefined,
      measurement: 'main_receipt', since_editable_ms: name === 'first_frame_submitted' || name === 'audio_prepared'
        ? t.milestones.has('editable') ? ms - t.milestones.get('editable')! : null : undefined }, 'info')
  }
  private summary(t: Trace) {
    if (t.summaryDone || t.requestFailed || !t.requestDone || t.decisionPending) return
    if ([...t.expected].some(s => !['completed', 'failed', 'cancelled'].includes(t.stages.get(s)?.status ?? ''))) return
    if ([...t.expected].some(s => s !== 'probe' && s !== 'hash' && t.stages.get(s)?.status !== 'cancelled' && !t.landed.has(s))) return
    t.summaryDone = true
    this.log(t, 'background_settled', { status: t.failed ? 'incomplete' : 'completed',
      stages: [...t.expected].map(s => t.stages.get(s)), milestones_ms: Object.fromEntries(t.milestones) }, 'info')
  }
  private remove(t: Trace) {
    this.traces.delete(t.id)
    if (t.media) this.byMedia.delete(t.media)
    this.send({ import_id: t.id, remove: true })
  }
  reset(): void {
    for (const t of this.traces.values()) {
      this.log(t, 'tracking_ended', { reason: 'workspace_changed', background_completed: t.summaryDone,
        unsettled_stages: [...t.expected].filter(s => !['completed', 'failed', 'cancelled'].includes(t.stages.get(s)?.status ?? '')) }, 'info')
    }
    this.traces.clear(); this.byMedia.clear(); this.send({ reset: true })
  }
}
