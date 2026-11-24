// apps/desktop/src/main/state/portability.ts
//
// The portability check: what the open project still needs from outside its
// folder, so a copy of the folder (Save As, a pack, a sync) renders the same
// elsewhere. Pure: the host gathers the inputs (ts-actor-host.ts); the MCP
// view `read_project { view: "portability" }` and the check dialog show it.

import type { ProjectPath } from '../../shared/projectPath'
import type { UnavailableMotif } from '../../shared/motifs/projectMotifs'
import type { MissingFontUse } from '../fonts/uses'
import type { PortabilityMedia, PortabilityReport } from '../../shared/portability'

export interface PortabilityInputs {
  media: readonly { id: string; label: string; path: string; path_rel: ProjectPath | null; available: boolean }[]
  unavailableMotifs: readonly UnavailableMotif[]
  /** The ids the project's Motif table holds. */
  motifTable: readonly string[]
  /** The folder names under `Motifs/`. */
  motifFolders: readonly string[]
  excludedFonts: readonly { family: string; installed: boolean }[]
  missingFonts: readonly MissingFontUse[]
  outsideStyle: string | null
}

/** Each media item is listed once: a missing file under `missing`, which a
 *  relink fixes, wherever it was. An untrusted Motif is in the folder and
 *  needs a click on each machine, not a file: it is not listed. */
export function portabilityReport(i: PortabilityInputs): PortabilityReport {
  const item = (m: PortabilityInputs['media'][number]): PortabilityMedia => ({ media_id: m.id, label: m.label, path: m.path })
  const byName = (a: PortabilityMedia, b: PortabilityMedia) => a.label.localeCompare(b.label) || a.media_id.localeCompare(b.media_id)
  const missing = i.media.filter(m => !m.available).map(item).sort(byName)
  const outside = i.media.filter(m => m.available && m.path_rel === null).map(item).sort(byName)
  const motifs = (status: 'missing' | 'invalid') => i.unavailableMotifs
    .filter(m => m.status === status).map(({ motif_id, diagnostic }) => ({ motif_id, diagnostic }))
  const table = new Set(i.motifTable)
  const report: PortabilityReport = {
    portable: false,
    media: { outside, missing },
    motifs: { missing: motifs('missing'), invalid: motifs('invalid'), untracked: i.motifFolders.filter(f => !table.has(f)).sort() },
    fonts: { excluded: [...i.excludedFonts], missing: [...i.missingFonts] },
    style: { outside: i.outsideStyle },
  }
  report.portable = outside.length + missing.length + report.motifs.missing.length + report.motifs.invalid.length
    + report.fonts.excluded.length + report.fonts.missing.length === 0 && i.outsideStyle === null
  return report
}
