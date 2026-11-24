// apps/desktop/src/main/state/untrackedMotifFolder.ts
//
// The portability check's cleanup of a folder under the open project's
// `Motifs/` that no layer places (`PortabilityReport.motifs.untracked`): it
// goes to the system trash. The host serves it (`project_trash_motif_folder`).

import type { Trash } from '../motif/store'
import type { PortabilityReport } from '../../shared/portability'

export interface UntrackedMotifFolderDeps {
  /** The open project's report, read at the call; null with none open. */
  report: () => PortabilityReport | null
  /** The folder `Motifs/<name>/` of the open project (`ProjectMotifStore.folder`). */
  folder: (name: string) => string
  trash: Trash
}

/** Moves `Motifs/<name>/` to the trash. `name` comes from the renderer, so a
 *  path is built only from a name the report lists as untracked at the call:
 *  any other name, a placed Motif's included, is refused with nothing moved. */
export async function trashUntrackedMotifFolder(deps: UntrackedMotifFolderDeps, name: unknown): Promise<void> {
  const report = deps.report()
  if (!report) throw new Error('No project is open')
  if (typeof name !== 'string' || !report.motifs.untracked.includes(name))
    throw new Error(`Motifs/${String(name)}/ is not a folder this project leaves unused`)
  await deps.trash(deps.folder(name))
}
