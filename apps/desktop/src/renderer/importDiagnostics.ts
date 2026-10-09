import { invoke } from './bridge/ipc'
import { IMPORT_DIAGNOSTIC_MILESTONE, type ImportMilestone } from '../shared/import-diagnostics'

/** Session-only tokens supplied by main. Old frames and late IPC replies can
 * never create a trace or attach themselves to a reopened project. */
export class RendererImportDiagnostics {
  private imports = new Map<string, { id: string; seen: Set<ImportMilestone> }>()
  constructor(private send: (payload: Record<string, unknown>) => void) {}
  track(payload: { reset?: boolean; remove?: boolean; import_id?: string; media_id?: string }) {
    if (payload.reset) { this.imports.clear(); return }
    if (payload.remove) {
      for (const [media, trace] of this.imports) if (trace.id === payload.import_id) this.imports.delete(media)
    } else if (payload.import_id && payload.media_id) {
      if (this.imports.get(payload.media_id)?.id === payload.import_id) return
      if (this.imports.size >= 2048) this.imports.delete(this.imports.keys().next().value!)
      this.imports.set(payload.media_id, { id: payload.import_id, seen: new Set() })
    }
  }
  pending(media: string, milestone: ImportMilestone): boolean {
    const trace = this.imports.get(media)
    return Boolean(trace && !trace.seen.has(milestone))
  }
  report(media: string, milestone: ImportMilestone, engine?: string) {
    const trace = this.imports.get(media)
    if (!trace || trace.seen.has(milestone)) return
    trace.seen.add(milestone)
    try { this.send({ import_id: trace.id, media_id: media, milestone, engine }) } catch { /* diagnostics */ }
  }
}
export const rendererImportDiagnostics = new RendererImportDiagnostics(payload => {
  void invoke(IMPORT_DIAGNOSTIC_MILESTONE, payload).catch(() => {})
})
