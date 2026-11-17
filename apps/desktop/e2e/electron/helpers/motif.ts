// Motifs as the specs make them: in the open project's `Motifs/<id>/`, the
// way an agent makes one (`create_motif`, then `update_motif_files`), or in a
// profile's library before the app starts. See docs/motif-workspaces.md.
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Makes a Motif in the open project from `manifest` and its page; answers
 *  the id the project gave it (from the manifest's name). Needs a project
 *  open: a project Motif lives in its folder. */
export async function createMotif(page: Page, manifest: Record<string, unknown>, html: string): Promise<string> {
  return page.evaluate(async ({ manifest, html }) => {
    const invoke = (window as any).api.backend.invoke
    const made = await invoke('create_motif', { source: { kind: 'empty', name: manifest.name } })
    await invoke('update_motif_files', { motif_id: made.motif_id, expected_revision: made.revision,
      files: [{ path: 'manifest.json', text: JSON.stringify(manifest) }, { path: 'index.html', text: html }] })
    return made.motif_id as string
  }, { manifest, html })
}

/** The content hash `list_motifs` reports for Motif `id` of `group`, the one
 *  a capture of its host names. */
export async function motifContentHash(page: Page, id: string, group: 'project' | 'library' = 'project'): Promise<string> {
  const hash = await page.evaluate(async ({ id, group }) => {
    const rows = await (window as any).api.backend.invoke('list_motifs', { group }) as Array<{ id: string; content_hash?: string }>
    return rows.find(row => row.id === id)?.content_hash ?? null
  }, { id, group })
  if (!hash) throw new Error(`list_motifs has no ${group} Motif '${id}' with a content hash`)
  return hash
}

/** Saves project Motif `id` to the library as the panel's "Save to library"
 *  does (the renderer-only `publish_motif`; an agent's `install_motif` only
 *  proposes). `expectedVersion` replaces the library Motif of its lineage at
 *  that version. Answers the library id. */
export async function saveMotifToLibrary(page: Page, id: string, expectedVersion?: number): Promise<string> {
  return page.evaluate(async ({ id, expectedVersion }) => {
    const invoke = (window as any).api.backend.invoke
    const published = await invoke('publish_motif', { motif_id: id, ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }) })
    return published.motif_id as string
  }, { id, expectedVersion })
}

/** Writes version `version` of library Motif `id` into the profile at
 *  `userDataDir`, as the library keeps it (`<id>/v<n>/`, ADR 0172): `files`
 *  by path, `index.html` among them. Answers the version folder. */
export function seedLibraryMotif(userDataDir: string, id: string, version: number, files: Record<string, string | Buffer>): string {
  const dir = path.join(userDataDir, 'data', 'motifs', id, `v${version}`)
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, bytes)
  }
  return dir
}

/** A Motif page carrying its manifest in the island the library reads. */
export function motifPage(manifest: Record<string, unknown>, body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<script type="application/json" id="motif-manifest">${JSON.stringify(manifest)}</script>${head}`
    + `</head><body>${body}</body></html>`
}
