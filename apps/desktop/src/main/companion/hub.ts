// apps/desktop/src/main/companion/hub.ts
//
// The app side of the companion page: what a page reads (the state and its
// event stream), what it may ask (player controls, bringing the editor
// forward), and the editor window's bridge that answers for the player. Owns
// the readiness handshake with that bridge and the demand it is told. The
// HTTP side is `routes.ts`; Electron stays out of this file, so Vitest loads it.
import path from 'node:path'
import type { TsActorHost } from '../state/ts-actor-host.js'
import type { Layer, Project } from '../state/model.js'
import { rootComposition } from '../state/model.js'
import { exportTerminal, type ExportJob } from '../../shared/exportJob.js'
import { AGENT_ACTIVITY_EVENT, type AgentActivityUpdate } from '../../shared/agent-activity.js'
import {
  COMPANION_ATTACH, COMPANION_CONTROL_EVENT, COMPANION_DEMAND_EVENT, COMPANION_DETACH, COMPANION_TRANSPORT,
  type CompanionActivity, type CompanionAttachReply, type CompanionClip, type CompanionControl,
  type CompanionControlMessage, type CompanionDemand, type CompanionDemandMessage, type CompanionEventName,
  type CompanionExport, type CompanionState, type CompanionTrack, type CompanionTransport,
} from '../../shared/companion.js'

export interface CompanionHubDeps {
  getTsHost: () => Pick<TsActorHost, 'actor' | 'openedProject'> | null
  /** Main → the editor window; the caller adds the `evt:` prefix. */
  sendToEditor: (event: string, payload: unknown) => void
  /** Restore and focus the editor window. */
  focusEditor: () => void
  /** The app's UI language setting. */
  language: () => string | null
}

/** One open event stream. */
export interface CompanionViewer {
  send(event: CompanionEventName, data: unknown): void
}

/** What `control` made of a page's request: `not_ready` while no editor is
 *  attached to drive the player, `invalid` for a body that names no action. */
export type CompanionControlOutcome = 'ok' | 'not_ready' | 'invalid'

export class CompanionHub {
  private readonly viewers = new Set<CompanionViewer>()
  /** The bridge token the editor attached with; null while none is. */
  private attached: string | null = null
  /** The demand the attached bridge was last told, so it hears only changes. */
  private told: CompanionDemand | null = null
  private transport: CompanionTransport = { t_us: 0, playing: false }
  private exportJob: CompanionExport | null = null
  private activity: CompanionActivity | null = null

  constructor(private readonly deps: CompanionHubDeps) {}

  // ── page side ──────────────────────────────────────────────────────────────

  state(): CompanionState {
    const host = this.deps.getTsHost()
    const opened = host?.openedProject() ?? null
    const base = {
      transport: this.transport, export: this.exportJob, activity: this.activity,
      editor: this.attached === null ? 'opening' as const : 'ready' as const,
      language: this.deps.language(),
    }
    if (host === null || opened === null) return { project: null, composition: null, tracks: [], ...base }
    const p = host.actor.snapshot()
    const c = rootComposition(p)
    return {
      project: { name: p.metadata.name || path.basename(opened.dir) },
      composition: { duration_us: c.duration_us, width: c.width, height: c.height, fps: { num: c.fps.num, den: c.fps.den } },
      tracks: c.tracks.map((t): CompanionTrack => ({ track_id: t.id, clips: t.layers.map((l) => clip(l, p)) })),
      ...base,
    }
  }

  /** A page opened its event stream. Returns the stream's close. */
  watch(viewer: CompanionViewer): () => void {
    this.viewers.add(viewer)
    this.demandChanged()
    return () => {
      if (this.viewers.delete(viewer)) this.demandChanged()
    }
  }

  control(body: unknown): CompanionControlOutcome {
    const action = parseAction(body)
    if (action === null) return 'invalid'
    if (action === 'focus') {
      this.deps.focusEditor()
      return 'ok'
    }
    if (this.attached === null) return 'not_ready'
    this.deps.sendToEditor(COMPANION_CONTROL_EVENT, { ...action, token: this.attached } satisfies CompanionControlMessage)
    return 'ok'
  }

  demand(): CompanionDemand {
    return { watch: this.attached !== null && this.viewers.size > 0 }
  }

  // ── editor side ────────────────────────────────────────────────────────────

  /** The editor renderer's `companion_*` channels. */
  handleInvoke(channel: string, args: unknown): unknown {
    const a = (args ?? {}) as { token?: unknown; t_us?: unknown; playing?: unknown }
    if (typeof a.token !== 'string' || a.token === '') throw new Error(`${channel} needs the bridge token`)
    switch (channel) {
      case COMPANION_ATTACH: return this.attach(a.token)
      case COMPANION_DETACH: this.detach(a.token); return null
      case COMPANION_TRANSPORT:
        if (typeof a.t_us !== 'number' || !Number.isFinite(a.t_us) || typeof a.playing !== 'boolean') throw new Error(`${channel} needs t_us and playing`)
        this.pushTransport(a.token, { t_us: a.t_us, playing: a.playing })
        return null
    }
    throw new Error(`unknown companion channel ${channel}`)
  }

  /** The bridge has its listeners in place. The reply carries the demand as
   *  it stands, so nothing main says before this point can be lost: from here
   *  on main tells this token only of changes. A newer attach replaces an
   *  older one. */
  attach(token: string): CompanionAttachReply {
    this.attached = token
    const demand = this.demand()
    this.told = demand
    this.broadcast('editor', {})
    return { demand }
  }

  /** The bridge is going away. A stale token (an effect torn down after its
   *  successor attached) leaves the newer attach in place. */
  detach(token: string): void {
    if (this.attached === token) this.release()
  }

  /** The editor document is gone (reload, crash, window closed): whatever
   *  bridge was attached went with it, without detaching. */
  editorGone(): void {
    if (this.attached !== null) this.release()
  }

  pushTransport(token: string, transport: CompanionTransport): void {
    if (this.attached !== token) return
    this.transport = transport
    this.broadcast('transport', transport)
  }

  /** Main's `evt:` relay, every event before any window guard: the three the
   *  page shows are already announced there. */
  observe(event: string, payload: unknown): void {
    if (event === 'project:changed') this.broadcast('project', {})
    else if (event === 'export:status') {
      const job = payload as ExportJob
      this.exportJob = { job_id: job.job_id, state: job.state, progress: job.progress ?? (exportTerminal(job.state) ? 1 : 0), filename: job.filename }
      this.broadcast('export', this.exportJob)
    } else if (event === AGENT_ACTIVITY_EVENT) {
      const latest = (payload as AgentActivityUpdate).activities?.at(-1)
      if (latest === undefined) return
      this.activity = { client: latest.client, tool: latest.tool, state: latest.state }
      this.broadcast('activity', this.activity)
    }
  }

  private release(): void {
    this.attached = null
    this.told = null
    // No editor, no player: a page must not run its playhead on.
    this.transport = { ...this.transport, playing: false }
    this.broadcast('editor', {})
  }

  private demandChanged(): void {
    if (this.attached === null) return
    const demand = this.demand()
    if (this.told !== null && this.told.watch === demand.watch) return
    this.told = demand
    this.deps.sendToEditor(COMPANION_DEMAND_EVENT, { ...demand, token: this.attached } satisfies CompanionDemandMessage)
  }

  private broadcast(event: CompanionEventName, data: unknown): void {
    for (const v of this.viewers) v.send(event, data)
  }
}

function parseAction(body: unknown): CompanionControl | 'focus' | null {
  const b = (body ?? {}) as { action?: unknown; t_us?: unknown }
  switch (b.action) {
    case 'focus': return 'focus'
    case 'play': case 'pause': return { action: b.action }
    case 'seek':
      return typeof b.t_us === 'number' && Number.isFinite(b.t_us) ? { action: 'seek', t_us: Math.max(0, Math.round(b.t_us)) } : null
  }
  return null
}

type ShownParams = { kind: string; media?: string; content?: string; motif_id?: string; composition?: string }

function clip(layer: Layer, p: Project): CompanionClip {
  const params = layer.params as ShownParams
  return { layer_id: layer.id, kind: params.kind, label: layer.label ?? shown(params, p), t_start_us: layer.t_start_us, t_end_us: layer.t_end_us }
}

/** What an unlabelled layer is called on the timeline: what it shows. */
function shown(params: ShownParams, p: Project): string {
  if (params.kind === 'Text' && params.content !== undefined) return params.content.split('\n')[0]!
  const media = params.media === undefined ? undefined : p.media_pool[params.media]
  if (media !== undefined) return media.label ?? path.basename(media.path_rel ?? media.path_abs)
  if (params.composition !== undefined) return p.compositions[params.composition]?.label ?? ''
  return params.motif_id ?? ''
}
