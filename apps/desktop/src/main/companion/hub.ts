// apps/desktop/src/main/companion/hub.ts
//
// The app side of the companion page: what a page reads (the state and its
// event stream, the picture), what it may ask (player controls, bringing the
// editor forward), and the editor window's bridge that answers for the player
// and encodes the picture. Owns the readiness handshake with that bridge and
// the demand it is told. The HTTP side is `routes.ts`, the picture's bytes
// `pictureStream.ts`; Electron stays out of this file, so Vitest loads it.
import path from 'node:path'
import type { TsActorHost } from '../state/ts-actor-host.js'
import type { Layer, Project } from '../state/model.js'
import { rootComposition } from '../state/model.js'
import { exportTerminal, type ExportJob, type ExportJobState } from '../../shared/exportJob.js'
import { AGENT_ACTIVITY_EVENT, type AgentActivityUpdate } from '../../shared/agent-activity.js'
import {
  COMPANION_ATTACH, COMPANION_CONTROL_EVENT, COMPANION_DEMAND_EVENT, COMPANION_DETACH, COMPANION_MIRROR_CHUNK,
  COMPANION_MIRROR_CONFIG, COMPANION_TRANSPORT,
  type CompanionActivity, type CompanionAttachReply, type CompanionClip, type CompanionControl,
  type CompanionControlMessage, type CompanionDemand, type CompanionDemandMessage, type CompanionEventName,
  type CompanionExport, type CompanionState, type CompanionTrack, type CompanionTransport, type CompanionWindow,
} from '../../shared/companion.js'
import { PictureStream, type PictureSink } from './pictureStream.js'

export interface CompanionHubDeps {
  getTsHost: () => Pick<TsActorHost, 'actor' | 'openedProject'> | null
  /** Main → the editor window; the caller adds the `evt:` prefix. */
  sendToEditor: (event: string, payload: unknown) => void
  /** Restore and focus the editor window. */
  focusEditor: () => void
  /** The app's UI language setting. */
  language: () => string | null
  /** The editor window as it is now. */
  windowState: () => CompanionWindow
  /** The picture starts (true) or stops (false). Told on each change only. */
  pictureRunning: (running: boolean) => void
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
  private readonly picture = new PictureStream()
  /** What `pictureRunning` was last told. */
  private pictureOn = false
  /** The window state pages last heard, so they hear only changes. */
  private window: CompanionWindow | null = null

  constructor(private readonly deps: CompanionHubDeps) {}

  // ── page side ──────────────────────────────────────────────────────────────

  state(): CompanionState {
    const host = this.deps.getTsHost()
    const opened = host?.openedProject() ?? null
    const base = {
      transport: this.transport, export: this.exportJob, activity: this.activity,
      editor: this.attached === null ? 'opening' as const : 'ready' as const,
      language: this.deps.language(),
      window: this.deps.windowState(),
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

  /** A page opened the picture. Returns its close. */
  showPicture(sink: PictureSink): () => void {
    const remove = this.picture.add(sink)
    this.demandChanged()
    return () => {
      remove()
      this.demandChanged()
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

  /** An export has the GPU and the compositor to itself, so the picture
   *  steps aside while one runs; a page that still shows it gets it again
   *  when the export ends. */
  demand(): CompanionDemand {
    const attached = this.attached !== null
    return {
      watch: attached && this.viewers.size > 0,
      picture: attached && this.picture.size > 0 && !exportRunning(this.exportJob),
    }
  }

  // ── editor side ────────────────────────────────────────────────────────────

  /** The editor renderer's `companion_*` channels. */
  handleInvoke(channel: string, args: unknown): unknown {
    const a = (args ?? {}) as {
      token?: unknown; t_us?: unknown; playing?: unknown
      codec?: unknown; coded_width?: unknown; coded_height?: unknown; key?: unknown; timestamp_us?: unknown; data?: unknown
    }
    if (typeof a.token !== 'string' || a.token === '') throw new Error(`${channel} needs the bridge token`)
    switch (channel) {
      case COMPANION_ATTACH: return this.attach(a.token)
      case COMPANION_DETACH: this.detach(a.token); return null
      case COMPANION_TRANSPORT:
        if (typeof a.t_us !== 'number' || !Number.isFinite(a.t_us) || typeof a.playing !== 'boolean') throw new Error(`${channel} needs t_us and playing`)
        this.pushTransport(a.token, { t_us: a.t_us, playing: a.playing })
        return null
      case COMPANION_MIRROR_CONFIG:
        if (typeof a.codec !== 'string' || !isSide(a.coded_width) || !isSide(a.coded_height)) throw new Error(`${channel} needs codec and coded sizes`)
        if (this.picturing(a.token)) this.picture.configure({ codec: a.codec, coded_width: a.coded_width, coded_height: a.coded_height })
        return null
      case COMPANION_MIRROR_CHUNK: {
        const data = bytes(a.data)
        if (typeof a.key !== 'boolean' || typeof a.timestamp_us !== 'number' || !Number.isFinite(a.timestamp_us) || data === null) throw new Error(`${channel} needs key, timestamp_us and data`)
        if (this.picturing(a.token)) this.picture.chunk(a.key, a.timestamp_us, data)
        return null
      }
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
    this.settlePicture(demand)
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
      this.demandChanged()
    } else if (event === AGENT_ACTIVITY_EVENT) {
      const latest = (payload as AgentActivityUpdate).activities?.at(-1)
      if (latest === undefined) return
      this.activity = { client: latest.client, tool: latest.tool, state: latest.state }
      this.broadcast('activity', this.activity)
    }
  }

  /** The editor window was minimized, restored, hidden or shown. */
  windowChanged(): void {
    const now = this.deps.windowState()
    if (now === this.window) return
    this.window = now
    this.broadcast('window', now)
  }

  private release(): void {
    this.attached = null
    this.told = null
    // No editor, no player: a page must not run its playhead on.
    this.transport = { ...this.transport, playing: false }
    this.settlePicture(this.demand())
    this.broadcast('editor', {})
  }

  private demandChanged(): void {
    const demand = this.demand()
    this.settlePicture(demand)
    if (this.attached === null) return
    if (this.told !== null && this.told.watch === demand.watch && this.told.picture === demand.picture) return
    this.told = demand
    this.deps.sendToEditor(COMPANION_DEMAND_EVENT, { ...demand, token: this.attached } satisfies CompanionDemandMessage)
  }

  private settlePicture(demand: CompanionDemand): void {
    if (demand.picture === this.pictureOn) return
    this.pictureOn = demand.picture
    // The encoder stops with the demand; whatever it sent is no start for the next one.
    if (!demand.picture) this.picture.reset()
    this.deps.pictureRunning(demand.picture)
  }

  /** Frames count only from the attached bridge, and only while it was asked
   *  for them: one still in flight after the demand ended is dropped. */
  private picturing(token: string): boolean {
    return this.attached === token && this.pictureOn
  }

  private broadcast(event: CompanionEventName, data: unknown): void {
    for (const v of this.viewers) v.send(event, data)
  }
}

/** An export holding the GPU: not finished, and not waiting for the user to
 *  decide on a retry. */
function exportRunning(job: CompanionExport | null): boolean {
  return job !== null && !exportTerminal(job.state as ExportJobState) && job.state !== 'awaiting_retry'
}

function isSide(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

/** A chunk's bytes as IPC delivers them: an ArrayBuffer, or a view on one. */
function bytes(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
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
