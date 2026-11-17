// The Motif tools over a real library, a real project folder and a real
// actor: what each tool records, what it refuses, and what the library and
// the project hold afterwards (spec § Project Motifs, § Library).
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { createActor } from '../state/actor'
import type { Actor } from '../state/history'
import { seededGen } from '../state/ids'
import { blankProject } from '../state/model'
import { isLineageUid } from './lineage'
import { normalize } from './motifPackage'
import { runMotifTool, type MotifToolDeps } from './motifTools'
import { projectMotifAccess } from './projectRecords'
import { libraryPackage, ProjectMotifStore, type RevisionCause } from './projectStore'
import { UserMotifStore } from './store'

const roots: string[] = []
function temp() { const root = mkdtempSync(path.join(tmpdir(), 'motif-tools-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const AGENT: Actor = { kind: 'Agent', client: 'claude' }
const manifest = (name: string, props_schema: Manifest['props_schema'] = {}): Manifest =>
  ({ id: 'x', name, version: 1, size: [64, 64], default_duration_s: 1, props_schema })
const page = (name: string, body = 'one', props_schema?: Manifest['props_schema']) =>
  Buffer.from(composeMotifHtml(manifest(name, props_schema), `<html><head></head><body><script>motif.define({frame(t){ /* ${body} */ }})</script></body></html>`))

/** Every file under `dir`, by relative path, with its bytes. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(at, entry.name), `${prefix}${entry.name}/`)
      else out[prefix + entry.name] = readFileSync(path.join(at, entry.name), 'utf8')
    }
  }
  visit(dir, '')
  return out
}

function world() {
  const root = temp(), bin = temp()
  const trashed: string[] = []
  const store = new UserMotifStore(path.join(root, 'library'), { trash: async (target) => {
    trashed.push(target)
    renameSync(target, path.join(bin, String(trashed.length)))
  } })
  const projectDir = path.join(root, 'Film')
  mkdirSync(projectDir)
  let project: ProjectMotifStore | null = new ProjectMotifStore(projectDir, { revisions: store.revisions })
  const seen: Array<[string, RevisionCause]> = []
  project.onRevisionSeen((id, _revision, cause) => seen.push([id, cause]))
  const idGen = seededGen()
  const actor = createActor({ initial: blankProject(idGen, 'Film'), idGen, motifs: projectMotifAccess(() => project, id => libraryPackage(store, [], id)) })
  let changed = 0
  const deps: MotifToolDeps = { store, builtins: [], project: () => project, actor, emitChanged: () => { changed++ } }
  const call = (name: string, args: Record<string, unknown> = {}, by: Actor | undefined = AGENT) => runMotifTool(name, args, deps, by) as any
  return {
    root, store, projectDir, actor, call, seen, trashed,
    close: () => { project = null },
    changes: () => changed,
    entries: () => actor.snapshot().motifs,
    historyLen: () => actor.historyStatus().len,
    lastOp: () => actor.historyView(1).ops[0]!,
    folder: (id: string) => path.join(projectDir, 'Motifs', id),
    /** Publishes the next library version of `id`. */
    install(id: string, body = 'v', props_schema?: Manifest['props_schema']) {
      const version = store.nextVersion(id)
      store.addVersion(id, version, normalize([{ path: 'index.html', bytes: page(id === 'lower' ? 'Lower' : id, body, props_schema) }], id, version).files)
    },
    /** Places library Motif `id` on a layer; answers the layer id. */
    place(id: string): string {
      const r = actor.command('add_motif', { motifId: id, tStartUs: 0 })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      return r.value as string
    },
    /** Rewrites a project Motif's page through the tool; answers its revision. */
    edit(id: string, body: string): string {
      const read = runMotifTool('read_motif', { motif_id: id }, deps) as { revision: string }
      return (runMotifTool('update_motif_files', { motif_id: id, expected_revision: read.revision, files: [{ path: 'index.html', text: page(id, body).toString() }] }, deps, AGENT) as { revision: string }).revision
    },
    rows: (group?: string) => runMotifTool('list_motifs', group ? { group } : {}, deps) as Array<Record<string, unknown>>,
  }
}
type World = ReturnType<typeof world>
const row = (w: World, id: string, group = 'project') => w.rows(group).find(r => r.id === id)!

describe('create_motif', () => {
  it('makes an empty Motif of a new lineage, recorded as the agent, under an id from its name', () => {
    const w = world()
    const before = w.historyLen()
    const made = w.call('create_motif', { source: { kind: 'empty', name: 'Title Card' } })
    expect(made).toEqual({ motif_id: 'title-card', revision: expect.stringMatching(/^[0-9a-f]{64}$/), path: w.folder('title-card') })
    expect(w.historyLen()).toBe(before + 1)
    expect(w.lastOp().actor).toEqual(AGENT)
    expect(w.entries()['title-card']).toEqual({ uid: expect.any(String), revision: made.revision, from: null })
    expect(isLineageUid(w.entries()['title-card']!.uid)).toBe(true)
    expect(w.seen).toContainEqual(['title-card', 'created'])
    // A second one of the same name takes a free id and its own lineage.
    const second = w.call('create_motif', { source: { kind: 'empty', name: 'Title Card' } })
    expect(second.motif_id).toBe('title-card-2')
    expect(w.entries()['title-card-2']!.uid).not.toBe(w.entries()['title-card']!.uid)
  })

  it('gives a name with no ASCII letters an id from its lineage', () => {
    const w = world()
    const made = w.call('create_motif', { source: { kind: 'empty', name: '标题卡' } })
    expect(made.motif_id).toBe(`motif-${w.entries()[made.motif_id]!.uid.replace(/-/g, '').slice(0, 8)}`)
  })

  it('copies a library or project Motif as a new Motif of its own lineage', () => {
    const w = world()
    w.install('lower')
    w.place('lower')
    const fromLibrary = w.call('create_motif', { source: { kind: 'copy', motif_id: 'lower', group: 'library' } })
    const fromProject = w.call('create_motif', { source: { kind: 'copy', motif_id: 'lower' } })
    expect([fromLibrary.motif_id, fromProject.motif_id]).toEqual(['lower-2', 'lower-3'])
    const uids = ['lower', 'lower-2', 'lower-3'].map(id => w.entries()[id]!.uid)
    expect(new Set(uids).size).toBe(3)
    expect(w.entries()['lower-2']!.from).toBeNull()
    expect(() => w.call('create_motif', { source: { kind: 'copy', motif_id: 'nothing' } })).toThrow(/No Motif 'nothing' in this project/)
  })

  it('keeps the lineage a ZIP carries', () => {
    const w = world()
    w.install('lower')
    const zip = path.join(w.root, 'lower.zip')
    w.call('export_motif', { motif_id: 'lower', group: 'library', path: zip })
    const made = w.call('create_motif', { source: { kind: 'zip', path: zip } })
    expect(made.motif_id).toBe('lower')
    expect(w.entries().lower!.uid).toBe(w.store.lineage.of('lower'))
  })

  it("copies an outside directory, and adopts a folder written under the project's Motifs/ in place", () => {
    const w = world()
    const outside = path.join(w.root, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'index.html'), page('Outside'))
    const copied = w.call('create_motif', { source: { kind: 'directory', path: outside } })
    expect(copied.path).toBe(w.folder('outside'))
    const written = w.folder('hand-made')
    mkdirSync(written, { recursive: true })
    writeFileSync(path.join(written, 'index.html'), page('Whatever the page says'))
    writeFileSync(path.join(written, 'notes.txt'), 'kept')
    const before = tree(written)
    const adopted = w.call('create_motif', { source: { kind: 'directory', path: written } })
    expect(adopted).toEqual({ motif_id: 'hand-made', revision: expect.any(String), path: written })
    expect(tree(written)).toEqual(before)
    expect(w.entries()['hand-made']).toMatchObject({ revision: adopted.revision, from: null })
    expect(w.seen).toContainEqual(['hand-made', 'created'])
    // Adopting it again records nothing.
    const len = w.historyLen()
    expect(w.call('create_motif', { source: { kind: 'directory', path: written } }).motif_id).toBe('hand-made')
    expect(w.historyLen()).toBe(len)
  })

  it('needs an open project', () => {
    const w = world()
    w.close()
    expect(() => w.call('create_motif', { source: { kind: 'empty', name: 'X' } })).toThrow(/No project is open/)
  })
})

describe('update_motif_files', () => {
  it("records one agent commit with the folder's new revision, and refuses a stale revision changing nothing", () => {
    const w = world()
    const made = w.call('create_motif', { source: { kind: 'empty', name: 'Card' } })
    const before = w.historyLen()
    const updated = w.call('update_motif_files', { motif_id: 'card', expected_revision: made.revision, files: [{ path: 'notes.txt', text: 'hello' }] })
    expect(w.historyLen()).toBe(before + 1)
    expect(w.lastOp().actor).toEqual(AGENT)
    expect(w.entries().card!.revision).toBe(updated.revision)
    expect(readFileSync(path.join(w.folder('card'), 'notes.txt'), 'utf8')).toBe('hello')
    const files = tree(w.folder('card'))
    expect(() => w.call('update_motif_files', { motif_id: 'card', expected_revision: made.revision, files: [{ path: 'notes.txt', text: 'stale' }] }))
      .toThrow(/revision conflict/)
    expect(tree(w.folder('card'))).toEqual(files)
    expect(w.historyLen()).toBe(before + 1)
  })

  it('edits a text file by exact match and refuses an ambiguous one', () => {
    const w = world()
    const made = w.call('create_motif', { source: { kind: 'empty', name: 'Card' } })
    const added = w.call('update_motif_files', { motif_id: 'card', expected_revision: made.revision, files: [{ path: 'a.txt', text: 'one two one' }] })
    expect(() => w.call('update_motif_files', { motif_id: 'card', expected_revision: added.revision, files: [{ path: 'a.txt', edits: [{ old: 'one', new: '1' }] }] })).toThrow(/matches 2 times/)
    w.call('update_motif_files', { motif_id: 'card', expected_revision: added.revision, files: [{ path: 'a.txt', edits: [{ old: 'two', new: '2' }] }] })
    expect(readFileSync(path.join(w.folder('card'), 'a.txt'), 'utf8')).toBe('one 2 one')
  })
})

describe('delete_motif', () => {
  it('removes a Motif no layer uses from the project, keeping its folder; one in use is refused', () => {
    const w = world()
    w.install('lower')
    w.place('lower')
    w.call('create_motif', { source: { kind: 'empty', name: 'Spare' } })
    expect(() => w.call('delete_motif', { motif_id: 'lower' })).toThrow(/MotifInUse/)
    expect(w.entries().lower).toBeDefined()
    const before = w.historyLen()
    expect(w.call('delete_motif', { motif_id: 'spare' })).toEqual({ motif_id: 'spare' })
    expect(w.historyLen()).toBe(before + 1)
    expect(w.lastOp().actor).toEqual(AGENT)
    expect(w.entries().spare).toBeUndefined()
    expect(existsSync(path.join(w.folder('spare'), 'index.html'))).toBe(true)
    // The library is untouched.
    expect(w.store.publishedIds()).toEqual(['lower'])
  })
})

describe('list_motifs', () => {
  it("derives each project row's state against the library", () => {
    const w = world()
    w.install('synced'); w.place('synced')
    w.install('edited'); w.place('edited'); w.edit('edited', 'changed here')
    w.install('stale'); w.place('stale'); w.install('stale', 'newer in the library')
    w.call('create_motif', { source: { kind: 'empty', name: 'Mine' } })
    expect(Object.fromEntries(w.rows('project').map(r => [r.id, r.state]))).toEqual({
      synced: 'in_sync', edited: 'modified', stale: 'update_available', mine: 'project_only',
    })
  })

  it('lists both groups by default; library rows name the project id holding them', () => {
    const w = world()
    w.install('lower'); w.place('lower')
    w.install('spare')
    const rows = w.rows()
    expect(rows.map(r => [r.group, r.id])).toEqual([['library', 'lower'], ['library', 'spare'], ['project', 'lower']])
    expect(row(w, 'lower', 'library')).toMatchObject({ status: 'installed', version: 1, in_project: 'lower' })
    expect(row(w, 'spare', 'library').in_project).toBeNull()
    expect(row(w, 'lower')).toMatchObject({ status: 'ok', path: w.folder('lower'), from: { version: 1 } })
  })

  it('offers no preview of a library Motif whose folder name cannot be its host, saying to rename it', () => {
    const w = world()
    w.install('MyMotif')
    const diagnostic = expect.stringMatching(/must be lowercase/)
    // No manifest: nothing previews or places it from the row.
    expect(row(w, 'MyMotif', 'library')).toEqual({ group: 'library', id: 'MyMotif', status: 'invalid', diagnostic, revision: expect.any(String), in_project: null })
    expect(w.call('read_motif', { motif_id: 'MyMotif', group: 'library' })).toMatchObject({ status: 'invalid', diagnostic })
  })

  it('names a missing or invalid project Motif, and lists only the library with no project open', () => {
    const w = world()
    w.install('gone'); w.place('gone')
    w.install('broken'); w.place('broken')
    rmSync(w.folder('gone'), { recursive: true })
    writeFileSync(path.join(w.folder('broken'), 'manifest.json'), '{broken')
    expect(row(w, 'gone')).toMatchObject({ status: 'missing', revision: null, diagnostic: expect.any(String) })
    expect(row(w, 'broken')).toMatchObject({ status: 'invalid', revision: null, diagnostic: expect.stringMatching(/JSON/) })
    w.close()
    expect(w.rows().map(r => r.group)).toEqual(['library', 'library'])
  })
})

describe('read_motif and export_motif', () => {
  it('read the project Motif by default and the library one with group "library"', () => {
    const w = world()
    w.install('lower', 'library body'); w.place('lower'); w.edit('lower', 'project body')
    expect(w.call('read_motif', { motif_id: 'lower', path: 'index.html' }).text).toContain('project body')
    expect(w.call('read_motif', { motif_id: 'lower', group: 'library', path: 'index.html' }).text).toContain('library body')
    expect(w.call('read_motif', { motif_id: 'lower' })).toMatchObject({ group: 'project', path: w.folder('lower'), status: 'ok' })
  })

  it('reads an invalid folder so it can be fixed, and refuses to export it', () => {
    const w = world()
    w.install('lower'); w.place('lower')
    writeFileSync(path.join(w.folder('lower'), 'manifest.json'), '{broken')
    const read = w.call('read_motif', { motif_id: 'lower' })
    expect(read).toMatchObject({ status: 'invalid', revision: null, manifest: null, diagnostic: expect.stringMatching(/JSON/) })
    expect(read.files.map((f: { path: string }) => f.path)).toContain('manifest.json')
    expect(() => w.call('export_motif', { motif_id: 'lower', path: path.join(w.root, 'x.zip') })).toThrow(/is invalid/)
  })
})

describe('install_motif and the approval card', () => {
  it("proposes to the library Motif of the project Motif's lineage; approval adds a version and leaves the project byte-identical", () => {
    const w = world()
    w.install('lower'); w.place('lower')
    const revision = w.edit('lower', 'better')
    const proposed = w.call('install_motif', { motif_id: 'lower' })
    expect(proposed).toMatchObject({ state: 'awaiting_approval', revision, target: { id: 'lower', version: 1 } })
    expect(w.store.versions('lower').map(v => v.version)).toEqual([1])
    const project = tree(w.projectDir)
    const len = w.historyLen()
    const approved = w.call('approve_motif_proposal', { proposal_id: proposed.proposal_id }, undefined)
    expect(approved).toMatchObject({ motif_id: 'lower', version: 2, publication: { state: 'approved', library_id: 'lower', version: 2 } })
    expect(w.store.installedFile('lower', 'index.html')!.toString()).toContain('better')
    expect(tree(w.projectDir)).toEqual(project)
    expect(w.historyLen()).toBe(len)
    // The project copy is the library's content now.
    expect(row(w, 'lower').state).toBe('in_sync')
    expect(row(w, 'lower').publication).toMatchObject({ state: 'approved', proposal_id: proposed.proposal_id })
  })

  it('saved as new while its project is open, the entry follows the new library Motif in one user commit', () => {
    const w = world()
    w.install('lower'); w.place('lower'); w.edit('lower', 'forked')
    const proposed = w.call('install_motif', { motif_id: 'lower' })
    const len = w.historyLen()
    const approved = w.call('approve_motif_proposal', { proposal_id: proposed.proposal_id, as_new: true }, undefined)
    expect(approved.motif_id).toBe('lower-2')
    expect(w.store.versions('lower').map(v => v.version)).toEqual([1])
    expect(w.historyLen()).toBe(len + 1)
    expect(w.lastOp().actor).toEqual({ kind: 'User' })
    const uid = w.store.lineage.of('lower-2')
    expect(uid).not.toBe(w.store.lineage.of('lower'))
    expect(w.entries().lower).toMatchObject({ uid, from: { uid, version: 1, revision: w.store.installedListing('lower-2')!.revision } })
    expect(row(w, 'lower').state).toBe('in_sync')
  })

  it('proposes a Motif made in the project as a new library Motif of its lineage, and a rejection carries the note', () => {
    const w = world()
    const made = w.call('create_motif', { source: { kind: 'empty', name: 'Badge' } })
    const proposed = w.call('install_motif', { motif_id: made.motif_id })
    expect(proposed.target).toEqual({ new_id: 'badge' })
    // The same proposal again is the same one; a newer revision supersedes it.
    expect(w.call('install_motif', { motif_id: 'badge' }).proposal_id).toBe(proposed.proposal_id)
    w.edit('badge', 'two')
    const newer = w.call('install_motif', { motif_id: 'badge' })
    expect(newer.superseded_proposal_id).toBe(proposed.proposal_id)
    expect(w.call('list_motif_proposals').map((c: { proposal_id: string }) => c.proposal_id)).toEqual([newer.proposal_id])
    expect(w.call('reject_motif_proposal', { proposal_id: newer.proposal_id, note: 'bigger title' })).toMatchObject({ state: 'rejected', note: 'bigger title' })
    expect(row(w, 'badge').publication).toMatchObject({ state: 'rejected', note: 'bigger title' })
    expect(w.store.publishedIds()).toEqual([])
  })

  it('refuses a new id the library holds, with the ways forward', () => {
    const w = world()
    w.install('badge')
    w.call('create_motif', { source: { kind: 'empty', name: 'Badge' } })
    expect(() => w.call('install_motif', { motif_id: 'badge' })).toThrow(/taken by the library Motif/)
  })

  it('survives a restart: a pending proposal is approved by the next app', () => {
    const w = world()
    w.call('create_motif', { source: { kind: 'empty', name: 'Badge' } })
    const proposed = w.call('install_motif', { motif_id: 'badge' })
    const restarted = new UserMotifStore(w.store.root())
    const actor = createActor({ initial: blankProject(seededGen(), 'Other'), idGen: seededGen() })
    const approved = runMotifTool('approve_motif_proposal', { proposal_id: proposed.proposal_id }, { store: restarted, builtins: [], project: () => null, actor, emitChanged: () => {} }) as { motif_id: string }
    expect(approved.motif_id).toBe('badge')
    expect(restarted.lineage.of('badge')).toBe(w.entries().badge!.uid)
  })
})

describe("the user's own Save to library", () => {
  it('replaces the library Motif of its lineage only at the expected version', () => {
    const w = world()
    w.install('lower'); w.place('lower'); w.edit('lower', 'mine')
    expect(() => w.call('publish_motif', { motif_id: 'lower' }, undefined)).toThrow(/send expected_version 1/)
    expect(w.call('publish_motif', { motif_id: 'lower', expected_version: 1 }, undefined)).toMatchObject({ motif_id: 'lower', version: 2 })
    expect(w.store.installedFile('lower', 'index.html')!.toString()).toContain('mine')
  })

  it('a dry run names the Motif it would replace and the change, writing nothing; a Motif of no library lineage replaces none', () => {
    const w = world()
    w.install('lower'); w.place('lower'); w.edit('lower', 'mine')
    const library = tree(w.store.root())
    const revision = w.call('read_motif', { motif_id: 'lower' }).revision
    expect(w.call('publish_motif', { motif_id: 'lower', dry_run: true }, undefined)).toEqual({
      revision,
      replaces: { id: 'lower', version: 1 },
      diff: { files: { added: [], removed: [], changed: ['index.html'] }, props: { added: [], removed: [], changed: [] } },
    })
    expect(tree(w.store.root())).toEqual(library)
    w.call('create_motif', { source: { kind: 'empty', name: 'Badge' } })
    expect(w.call('publish_motif', { motif_id: 'badge', dry_run: true }, undefined)).toMatchObject({ replaces: null, diff: null })
  })
})

describe('library versions and delete', () => {
  it('restores an older version as the newest, and a delete trashes the library folder only', async () => {
    const w = world()
    w.install('lower', 'first'); w.place('lower'); w.install('lower', 'second')
    expect(w.call('restore_motif_version', { motif_id: 'lower', version: 1 }, undefined)).toMatchObject({ motif_id: 'lower', version: 3 })
    expect(w.call('list_motif_versions', { motif_id: 'lower' }).map((v: { version: number }) => v.version)).toEqual([3, 2, 1])
    const project = tree(w.projectDir)
    await w.call('delete_library_motif', { motif_id: 'lower' }, undefined)
    expect(w.trashed).toEqual([path.join(w.store.root(), 'lower')])
    expect(tree(w.projectDir)).toEqual(project)
    expect(row(w, 'lower').state).toBe('project_only')
  })
})
