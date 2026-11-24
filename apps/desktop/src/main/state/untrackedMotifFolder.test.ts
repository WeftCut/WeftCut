import { describe, expect, it } from 'vitest'
import { portabilityReport } from './portability'
import { trashUntrackedMotifFolder, type UntrackedMotifFolderDeps } from './untrackedMotifFolder'

/** A project placing `lower`, with `lower` and `spare` under `Motifs/`. */
function deps(open = true): UntrackedMotifFolderDeps & { trashed: string[] } {
  const trashed: string[] = []
  const report = portabilityReport({
    media: [], unavailableMotifs: [], motifTable: ['lower'], motifFolders: ['lower', 'spare'],
    excludedFonts: [], missingFonts: [], outsideStyle: null,
  })
  return {
    trashed,
    report: () => (open ? report : null),
    folder: (name) => `/home/u/Film/Motifs/${name}`,
    trash: async (target) => { trashed.push(target) },
  }
}

describe('trashUntrackedMotifFolder', () => {
  it('moves a folder no layer places to the trash', async () => {
    const d = deps()
    await trashUntrackedMotifFolder(d, 'spare')
    expect(d.trashed).toEqual(['/home/u/Film/Motifs/spare'])
  })

  it('refuses a placed Motif, a name the report does not list, and a path, moving nothing', async () => {
    const d = deps()
    for (const name of ['lower', 'gone', '../Media', 'spare/..', 42])
      await expect(trashUntrackedMotifFolder(d, name), String(name)).rejects.toThrow(/not a folder this project leaves unused/)
    expect(d.trashed).toEqual([])
  })

  it('refuses with no project open', async () => {
    const d = deps(false)
    await expect(trashUntrackedMotifFolder(d, 'spare')).rejects.toThrow(/No project is open/)
    expect(d.trashed).toEqual([])
  })
})
