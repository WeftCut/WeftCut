import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveExportRequest, resolveExportOptions, EXPORT_SETTINGS_SCHEMA, EXPORT_COMPATIBILITY } from '../shared/exportValidation.js'
import { rootComposition } from './state/model.js'
import { snapFrameRound } from './state/snap.js'
import type { TsActorHost } from './state/ts-actor-host.js'

export type ExportState = 'preparing' | 'rendering' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
export interface ExportJob {
  job_id: string; state: ExportState; output_path: string; agent: boolean
  settings: ReturnType<typeof resolveExportRequest>['settings']
  range: { startUs: number; endUs: number }; phase?: string; progress?: number; duration_us?: number; error?: string
}
interface PrivateJob { view: ExportJob; staging: string; cancelling: boolean; finishing: boolean; rendererLost?: boolean; begin?: Promise<unknown>; nativeCancel?: Promise<void> | undefined; timer?: ReturnType<typeof setTimeout> }
export interface ExportJobsDeps {
  host: () => TsActorHost | null
  send: (event: string, payload: unknown) => void
  native: (channel: string, args: Record<string, unknown>) => Promise<unknown>
  cleanupNativeSessions?: () => void | Promise<void>
}
const terminal = (s: ExportState) => ['completed', 'failed', 'cancelled'].includes(s)
/** App-session registry; independent of MCP connections and renderer React state. */
export class ExportJobs {
  private jobs = new Map<string, PrivateJob>()
  private active: PrivateJob | undefined
  private ready = false
  constructor(private deps: ExportJobsDeps) {}
  isActive(): boolean { return this.active !== undefined }
  assertWritable(): void { if (this.active) throw new Error('ExportInProgress: cancel or wait for the active export before editing or switching projects') }
  rendererReady(): void { this.ready = true }
  async rendererDetaching(): Promise<void> {
    this.ready = false
    // React disposal aborts the pipeline but does not destroy its worker. The
    // old controller still reports terminal state after its cleanup finishes.
    if (this.active) await this.cancel(this.active.view.job_id)
  }
  async rendererGone(): Promise<void> {
    this.ready = false
    const j = this.active
    if (!j) return
    j.rendererLost = true
    j.cancelling = true
    try { await this.cancelNative(j) } catch (e) { j.view.error = `Native export cleanup failed: ${String(e)}`; j.view.phase = 'cleanup_failed'; return }
    await this.finish(j, 'failed', 'Export renderer disconnected')
  }
  private resolve(a: Record<string, unknown>) {
    const h = this.deps.host()
    if (!h || h.openedProject() === null) throw new Error('NoProjectOpen: open a project before exporting')
    if (h.projectOperationPending?.()) throw new Error('ProjectOperationInProgress: wait for project switching to finish')
    return h.handleInvoke('export_settings_get', {}).then(saved => {
      const c = rootComposition(h.actor.snapshot())
      return resolveExportRequest(saved, a.settings, {
      width: c.width, height: c.height, fps_num: c.fps.num, fps_den: c.fps.den, duration_us: c.duration_us,
      }, a.range as {startUs:number;endUs:number} | undefined, a.allow_experimental_10bit === true, snapFrameRound)
    })
  }
  async options(): Promise<unknown> {
    const h = this.deps.host()
    if (!h || h.openedProject() === null) throw new Error('NoProjectOpen: open a project before exporting')
    const saved = await h.handleInvoke('export_settings_get', {})
    const c = rootComposition(h.actor.snapshot())
    return { ...resolveExportOptions(saved, {width:c.width,height:c.height,fps_num:c.fps.num,fps_den:c.fps.den,duration_us:c.duration_us}, snapFrameRound), duration_us:c.duration_us, settings_schema: EXPORT_SETTINGS_SCHEMA, compatibility: EXPORT_COMPATIBILITY, range_unit: 'microseconds', range_end: 'exclusive', experimental_10bit_requires_opt_in: true }
  }
  async start(a: Record<string, unknown>): Promise<ExportJob> {
    this.assertWritable()
    if (!this.ready) throw new Error('ExportRendererUnavailable: wait for the editor to finish loading')
    if (typeof a.output_path !== 'string' || !path.isAbsolute(a.output_path)) throw new Error('output_path must be an absolute path')
    if (a.allow_experimental_10bit !== undefined && typeof a.allow_experimental_10bit !== 'boolean') throw new Error('allow_experimental_10bit must be boolean')
    const r = await this.resolve(a)
    this.assertWritable()
    const destination = path.resolve(a.output_path)
    if (path.extname(destination).toLowerCase() !== `.${r.extension}`) throw new Error(`output_path must have .${r.extension} extension`)
    const agent = a.agent !== false
    if (!agent) await fs.mkdir(path.dirname(destination), {recursive:true})
    const parent = await fs.stat(path.dirname(destination))
    if (!parent.isDirectory()) throw new Error('output_path parent must be an existing directory')
    if (agent) { try { await fs.lstat(destination); throw new Error('output_path already exists; choose a new destination') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } }
    this.assertWritable()
    if (this.deps.host()?.projectOperationPending?.()) throw new Error('ProjectOperationInProgress: wait for project switching to finish')
    if (!this.ready) throw new Error('ExportRendererUnavailable: wait for the editor to finish loading')
    const id = randomUUID()
    const staging = path.join(path.dirname(destination), `.weftcut-export-${id}.${r.extension}`)
    const j: PrivateJob = { view: { job_id: id, state: 'preparing', output_path: destination, agent, settings: r.settings, range: r.range }, staging, cancelling: false, finishing: false }
    this.active = j; this.jobs.set(id, j)
    this.deps.send('export:status', this.status(id))
    this.watch(j)
    try {
      j.begin = (async () => {
        // Filesystem admission awaits may have overlapped an edit or a workspace
        // swap. Resolve again after reserving the gate, before renderer dispatch.
        const admitted = await this.resolve(a)
        if (path.extname(destination).toLowerCase() !== `.${admitted.extension}`) throw new Error(`output_path must have .${admitted.extension} extension`)
        j.view.settings = admitted.settings
        j.view.range = admitted.range
        return this.deps.native('export_begin', {})
      })()
      await j.begin
      if (this.active === j) {
        if (j.cancelling) await this.finish(j, j.rendererLost ? 'failed' : 'cancelled', j.rendererLost ? 'Export renderer disconnected' : undefined)
        else this.deps.send('export:run', { ...j.view, output_path: staging })
      }
    } catch (e) { await this.finish(j, 'failed', String(e)) }
    return this.status(id)
  }
  status(id: string): ExportJob { const j = this.jobs.get(id); if (!j) throw new Error(`Unknown export job '${id}'`); return structuredClone(j.view) }
  private cancelNative(j: PrivateJob): Promise<void> {
    // Cancellation must follow native admission: cancelling its previous token
    // before export_begin installs this job's token would miss the new job.
    return j.nativeCancel ??= (j.begin ?? Promise.resolve()).catch(() => {}).then(() => this.deps.native('export_cancel', {})).then(() => {}).catch(e => { j.nativeCancel = undefined; throw e })
  }
  async cancel(id: string): Promise<ExportJob> {
    const j = this.jobs.get(id)
    if (!j) throw new Error(`Unknown export job '${id}'`)
    if (terminal(j.view.state) || j.finishing) return this.status(id)
    if (!j.cancelling) {
      j.cancelling = true
      j.view.phase = 'cancelling'
      this.deps.send('export:cancel', { job_id: id })
      try { await this.cancelNative(j) } catch (e) { j.view.error = `Native export cleanup failed: ${String(e)}`; j.view.phase = 'cleanup_failed' }
      // Renderer owns worker/mux cleanup; retain admission until it acknowledges.
      if (!terminal(j.view.state)) { clearTimeout(j.timer); j.timer = setTimeout(() => { j.view.phase = 'cancellation_stalled'; this.deps.send('export:status', this.status(id)) }, 30_000); j.timer.unref() }
    } else if (!j.nativeCancel) {
      try { await this.cancelNative(j) } catch (e) { j.view.error = `Native export cleanup failed: ${String(e)}`; j.view.phase = 'cleanup_failed' }
    }
    return this.status(id)
  }
  async update(a: Record<string, unknown>): Promise<ExportJob> {
    const id = a.job_id as string; const j = this.jobs.get(id)
    if (!j) throw new Error(`Unknown export job '${id}'`)
    if (terminal(j.view.state) || j.finishing) return this.status(id)
    const state = a.state as ExportState
    if (!['preparing','rendering','finalizing','completed','failed','cancelled'].includes(state)) throw new Error('Invalid export state')
    if (typeof a.phase === 'string' && !j.cancelling) j.view.phase = a.phase
    if (typeof a.progress === 'number' && Number.isFinite(a.progress)) j.view.progress = Math.max(0, Math.min(1, a.progress))
    if (typeof a.duration_us === 'number' && Number.isFinite(a.duration_us)) j.view.duration_us = a.duration_us
    if (terminal(state)) {
      if (j.cancelling) { await this.cancelNative(j); await this.finish(j, 'cancelled') }
      else await this.finish(j, state, typeof a.error === 'string' ? a.error : undefined)
    } else {
      const order = ['preparing','rendering','finalizing']
      if (order.indexOf(state) >= order.indexOf(j.view.state)) j.view.state = state
      if (!j.cancelling) this.watch(j)
    }
    return this.status(id)
  }
  private watch(j: PrivateJob): void {
    clearTimeout(j.timer)
    // Stalled job only: each renderer progress update renews this deadline.
    j.timer = setTimeout(() => { void this.cancel(j.view.job_id) }, 30 * 60_000)
    j.timer.unref()
  }
  private async finish(j: PrivateJob, state: ExportState, error?: string): Promise<void> {
    if (terminal(j.view.state) || j.finishing) return
    if (state !== 'completed') {
      try { await this.cancelNative(j) } catch (e) { j.view.error = `Native export cleanup failed: ${String(e)}`; j.view.phase = 'cleanup_failed'; return }
    }
    try { await this.deps.cleanupNativeSessions?.() }
    catch (e) { j.view.error = `Native decode cleanup failed: ${String(e)}`; j.view.phase = 'cleanup_failed'; return }
    if (terminal(j.view.state) || j.finishing) return
    j.finishing = true
    clearTimeout(j.timer)
    try {
      if (state === 'completed') {
        const stat = await fs.stat(j.staging)
        if (!stat.isFile() || stat.size === 0) throw new Error('Export produced no output')
        if (j.view.agent) {
          await fs.link(j.staging, j.view.output_path)
        } else await fs.rename(j.staging, j.view.output_path)
      }
    } catch (e) { state = 'failed'; error = e instanceof Error ? e.message : String(e) }
    finally {
      try { await fs.rm(j.staging, {force:true}) }
      catch (e) { error = `${error ? error + '; ' : ''}Could not remove temporary export ${j.staging}: ${String(e)}` }
      j.view.state = state
      if (error !== undefined) j.view.error = error
      if (this.active === j) this.active = undefined
      j.finishing = false
      this.deps.send('export:status', this.status(j.view.job_id))
    }
  }
}
