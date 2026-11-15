// apps/desktop/src/main/mcp/playheadView.ts
//
// `project://playhead` / `read_project { view: "playhead" }`: where the user is
// looking. The playhead, the range and the selection are the editor's session
// state, not project state, so main asks the editor window at read time
// (`PlayheadReader`) and adds what the project says lies under the playhead
// (`playheadView`). The editor's half is `renderer/state/playheadReport.ts`;
// the wire is `shared/editorPlayhead.ts`.
import { randomUUID } from 'node:crypto'
import type { Project } from '../state/model.js'
import { layerEnvelope } from '../state/resource-views.js'
import type { EditorPlayheadReport, PlayheadReadMessage } from '../../shared/editorPlayhead.js'

/** How long a read waits for the editor. Answering is a few store reads, so
 *  only an editor that is gone or reloading takes this long. */
export const PLAYHEAD_READ_TIMEOUT_MS = 3_000

const NOT_READY = 'The editor window is not ready to report the playhead yet; retry in a moment.'

/** The editor could not answer: no window, a reload, or a project still
 *  loading. Retrying is the remedy. */
export class EditorNotReadyError extends Error {
  readonly variant = 'EditorNotReady'
  constructor(message: string = NOT_READY) {
    super(message)
    this.name = 'EditorNotReadyError'
  }
}

export interface PlayheadReaderDeps {
  /** Send the request to the editor window; false when there is no window. */
  ask: (message: PlayheadReadMessage) => boolean
  timeoutMs?: number
}

interface Pending {
  resolve: (report: EditorPlayheadReport) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Main's side of the request: one round trip per read, nothing otherwise. */
export class PlayheadReader {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly deps: PlayheadReaderDeps) {}

  read(): Promise<EditorPlayheadReport> {
    const request_id = randomUUID()
    return new Promise<EditorPlayheadReport>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id)
        reject(new EditorNotReadyError())
      }, this.deps.timeoutMs ?? PLAYHEAD_READ_TIMEOUT_MS)
      this.pending.set(request_id, { resolve, reject, timer })
      if (!this.deps.ask({ request_id })) this.settle(request_id, new EditorNotReadyError())
    })
  }

  /** The editor's `PLAYHEAD_REPORT`. An answer nobody waits for any more (a
   *  read that timed out) is dropped. */
  answer(message: unknown): void {
    const m = (message ?? {}) as { request_id?: unknown; report?: unknown; error?: unknown }
    if (typeof m.request_id !== 'string') throw new Error('playhead_report needs request_id')
    if (typeof m.error === 'string') this.settle(m.request_id, new EditorNotReadyError(m.error))
    else if (isReport(m.report)) this.settle(m.request_id, m.report)
    else throw new Error('playhead_report needs a report or an error')
  }

  private settle(requestId: string, outcome: EditorPlayheadReport | Error): void {
    const p = this.pending.get(requestId)
    if (p === undefined) return
    this.pending.delete(requestId)
    clearTimeout(p.timer)
    if (outcome instanceof Error) p.reject(outcome)
    else p.resolve(outcome)
  }
}

function isReport(v: unknown): v is EditorPlayheadReport {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  const range = r.range as { t_start_us?: unknown; t_end_us?: unknown } | null | undefined
  return typeof r.root_id === 'string' && typeof r.composition_id === 'string'
    && typeof r.t_us === 'number' && Number.isFinite(r.t_us) && typeof r.timecode === 'string'
    && typeof r.playing === 'boolean'
    && (range === null || (typeof range === 'object' && range !== undefined && typeof range.t_start_us === 'number' && typeof range.t_end_us === 'number'))
    && Array.isArray(r.selection) && r.selection.every((id) => typeof id === 'string')
}

/** The record the view answers: the editor's report, plus the layers the
 *  playhead is over in that composition, as `project://tracks` envelopes with
 *  their `track_id`, in `project://tracks` order. A report about a project or a
 *  composition the actor no longer holds (a switch in flight, a Group just
 *  deleted) is refused as not ready rather than answered against the wrong
 *  timeline. */
export function playheadView(project: Project, report: EditorPlayheadReport): Record<string, unknown> {
  const c = project.compositions[report.composition_id]
  if (report.root_id !== project.root_id || c === undefined) throw new EditorNotReadyError()
  const t = report.t_us
  const under = c.tracks.flatMap((track) => track.layers
    .filter((l) => l.t_start_us <= t && t < l.t_end_us)
    .map((l) => ({ track_id: track.id, ...layerEnvelope(l, c) })))
  return {
    composition_id: c.id,
    t_us: t,
    timecode: report.timecode,
    playing: report.playing,
    range: report.range,
    selection: report.selection,
    under_playhead: under,
  }
}
