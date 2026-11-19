// Motifs as the specs make them: in the open project's `Motifs/<id>/`, the
// way an agent makes one (`create_motif`, then `update_motif_files`), or in a
// profile's library before the app starts. See docs/motif-workspaces.md.
// Also what the Motif specs share to look at one: its project row, the
// preview's picture of it, and an agent's MCP client.
import { expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { invokeCmd, waitForHook } from './driver'

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

/** The user's Trust of project Motif `id`, as the Motifs panel's trust card
 *  sends it: the revision its summary was read from (ADR 0174). A renderer
 *  channel: no agent tool trusts. Answers the trusted revision. */
export async function trustMotif(page: Page, id: string): Promise<string> {
  return page.evaluate(async id => {
    const invoke = (window as any).api.backend.invoke
    const card = await invoke('motif_trust_summary', { motif_id: id })
    await invoke('trust_motif', { motif_id: id, revision: card.revision })
    return card.revision as string
  }, id)
}

/** An open project's Motif row as `list_motifs` reports it. */
export interface ProjectRow { id: string; status: string; state: string; path: string; revision: string | null; from: { version: number } | null }

/** The open project's Motif rows. */
export const projectRows = (page: Page) => invokeCmd<ProjectRow[]>(page, 'list_motifs', { group: 'project' })
export const projectRow = async (page: Page, id: string) => (await projectRows(page)).find(row => row.id === id)

/** Closes the open project and opens the one at `projectPath`, as the
 *  start screen does. */
export async function reopen(page: Page, projectPath: string): Promise<void> {
  await waitForHook(page, 'motifReopenProject')
  await page.evaluate(p => (window as any).__weftcutTest.motifReopenProject({ path: p }), projectPath)
}

/** Places Motif `motifId` at the start of the timeline; answers the layer id. */
export const addLayer = (page: Page, motifId: string, durationUs: number) =>
  page.evaluate(a => (window as any).__weftcutTest.addMotifLayer(a), { motifId, durationUs }) as Promise<string>

/** A Motif body that fills `rect` ([x, y, w, h]) of its canvas with `color`
 *  and leaves the rest transparent: whole-pixel edges, so a sample inside
 *  reads the colour exactly. */
export const fillBody = (rect: readonly [number, number, number, number], color: string) =>
  `<div style="position:absolute;left:${rect[0]}px;top:${rect[1]}px;width:${rect[2]}px;height:${rect[3]}px;background:${color}"></div>`
  + `<script>motif.define({ frame() {} })</script>`
export const fillPage = (rect: readonly [number, number, number, number], color: string) =>
  `<!doctype html><html><body style="margin:0;background:transparent">${fillBody(rect, color)}</body></html>`

export interface Sample { r: number; g: number; b: number; a: number }
export const rgb = (s: Sample) => [s.r, s.g, s.b]

const seek = (page: Page, us: number) => page.evaluate(us => (window as any).__weftcutTest.weftcutSeekUs(us), us)
const sampleAt = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), [x, y] as const) as Promise<Sample>

/** The composite at `points` once the preview shows `want` there (the preview
 *  mounts and captures asynchronously); seeks to `us` on every try. */
export async function settledSamples(page: Page, us: number, points: readonly (readonly [number, number])[],
  want: (samples: Sample[]) => boolean, label: string): Promise<Sample[]> {
  let last = 'no sample' as Sample[] | string
  await expect.poll(async () => {
    try {
      await seek(page, us)
      last = await Promise.all(points.map(([x, y]) => sampleAt(page, x, y)))
      return want(last)
    } catch (error) { last = String(error); return false }
  }, { timeout: 60_000, message: `${label}: ${JSON.stringify(last)}` }).toBe(true)
  return last as Sample[]
}

/** An MCP client on the app's own endpoint, connected as an agent is. */
export async function connectMcp(page: Page, name: string): Promise<Client> {
  const info = await page.evaluate(() => (window as any).api.mcp.getInfo())
  const client = new Client({ name, version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }))
  return client
}
