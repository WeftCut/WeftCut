import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { createActor, type ActorHandle } from '../state/actor'
import { seededGen } from '../state/ids'
import { blankProject, eachLayer } from '../state/model'
import { MotifBackups } from './backups'
import { normalize } from './motifPackage'
import { FILE_EDITS, ProjectMotifRecords, projectMotifAccess } from './projectRecords'
import { libraryPackage, libraryPackageOfLineage, ProjectMotifStore, type RevisionCause } from './projectStore'
import { UserMotifStore } from './store'

let root: string
let library: UserMotifStore
let project: ProjectMotifStore
let projectDir: string
let actor: ActorHandle
let records: ProjectMotifRecords
let seen: Array<[string, string, RevisionCause]>
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'project-records-'))
  library = new UserMotifStore(path.join(root, 'library'))
  projectDir = path.join(root, 'Film')
  project = new ProjectMotifStore(projectDir)
  seen = []
  project.onRevisionSeen((id, revision, cause) => seen.push([id, revision, cause]))
  const idGen = seededGen()
  actor = createActor({ initial: blankProject(idGen, 'Film'), idGen, motifs: projectMotifAccess(() => project, id => libraryPackage(library, [], id)) })
  records = new ProjectMotifRecords({ actor, project: () => project, libraryOfLineage: uid => libraryPackageOfLineage(library, [], uid) })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const manifest = (name: string, props_schema: Manifest['props_schema'] = {}): Manifest =>
  ({ id: 'x', name, version: 1, size: [320, 180], default_duration_s: 2, props_schema })
const page = (name: string, body: string, props_schema?: Manifest['props_schema']) =>
  Buffer.from(composeMotifHtml(manifest(name, props_schema), `<html><head></head><body><script>motif.define({frame(t){ /* ${body} */ }})</script></body></html>`))

/** Publishes the next library version of `id`. */
function install(id: string, body: string, props_schema?: Manifest['props_schema']): void {
  const version = library.nextVersion(id)
  library.addVersion(id, version, normalize([{ path: 'index.html', bytes: page(id, body, props_schema) }], id, version).files)
}
const folder = (id: string) => path.join(projectDir, 'Motifs', id)
const pageOf = (id: string) => readFileSync(path.join(folder(id), 'index.html'), 'utf8')
/** Writes the folder's page as an author would, and answers it. */
function edit(id: string, body: string): string {
  const html = composeMotifHtml(manifest(id), `<html><head></head><body><script>motif.define({frame(t){ /* ${body} */ }})</script></body></html>`)
  writeFileSync(path.join(folder(id), 'index.html'), html)
  return html
}
function place(id: string): string {
  const r = actor.command('add_motif', { motifId: id, tStartUs: 0 })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string
}
const entries = () => actor.snapshot().motifs
const historyLen = () => actor.historyStatus().len
const lastOp = () => actor.historyView(1).ops[0]!
const backups = () => new MotifBackups(projectDir)

describe('placing a library Motif', () => {
  it('copies its folder in, records it with the layer, and one undo leaves the folder untracked', () => {
    install('lower', 'v1')
    const before = historyLen()
    place('lower')
    // A spawned lane and the layer with its Motif: the Motif rides the layer's commit.
    expect(historyLen()).toBe(before + 2)
    expect(entries().lower!.revision).toBe(project.status('lower').revision)
    expect(seen).toContainEqual(['lower', entries().lower!.revision, 'placed'])
    expect(backups().has('lower', entries().lower!.revision!)).toBe(true)
    actor.dispatch('undo', {})
    expect(entries()).toEqual({})
    expect([...eachLayer(actor.snapshot())].some(({ layer }) => layer.params.kind === 'Motif')).toBe(false)
    expect(project.status('lower').status).toBe('ok')
  })
})

describe('a Motif edited on disk', () => {
  it('is recorded as one commit by the files, holding the burst\'s last revision, and re-keys that Motif alone', () => {
    install('lower', 'v1')
    install('card', 'v1')
    place('lower')
    place('card')
    const before = entries()
    const len = historyLen()
    for (let i = 0; i < 4; i++) edit('lower', `edit ${i}`)
    // The watcher tells a burst once its quiet window passes; told again, it
    // finds the revision recorded.
    records.folderChanged('lower', project.status('lower'))
    records.folderChanged('lower', project.status('lower'))
    expect(historyLen()).toBe(len + 1)
    expect(lastOp().actor).toEqual(FILE_EDITS)
    const revision = project.status('lower').revision!
    expect(entries()).toEqual({ ...before, lower: { ...before.lower!, revision } })
    expect(seen).toContainEqual(['lower', revision, 'edited-while-open'])
  })

  it('undo puts the folder back from its backup, and redo puts the edit back', () => {
    install('lower', 'v1')
    place('lower')
    const original = pageOf('lower')
    const edited = edit('lower', 'edited')
    records.folderChanged('lower', project.status('lower'))
    actor.dispatch('undo', {})
    expect(pageOf('lower')).toBe(original)
    expect(project.status('lower').revision).toBe(entries().lower!.revision)
    actor.dispatch('redo', {})
    expect(pageOf('lower')).toBe(edited)
    expect(project.status('lower').revision).toBe(entries().lower!.revision)
  })

  it('records nothing for files that make no package, and leaves them on undo', () => {
    install('lower', 'v1')
    place('lower')
    const len = historyLen()
    // Mid-rename: the page is gone for a moment.
    renameSync(path.join(folder('lower'), 'index.html'), path.join(folder('lower'), 'index.old'))
    expect(project.status('lower').status).toBe('invalid')
    records.folderChanged('lower', project.status('lower'))
    expect(historyLen()).toBe(len)
    actor.dispatch('undo', {})
    expect(existsSync(path.join(folder('lower'), 'index.old'))).toBe(true)
    expect(existsSync(path.join(folder('lower'), 'index.html'))).toBe(false)
  })

  it('a folder the table does not hold is never recorded', () => {
    install('lower', 'v1')
    place('lower')
    actor.dispatch('undo', {})
    const len = historyLen()
    edit('lower', 'untracked')
    records.folderChanged('lower', project.status('lower'))
    expect(historyLen()).toBe(len)
  })
})

describe('updating the project copy from the library', () => {
  it('is one undo step that rebinds the layers and keeps the replaced revision', () => {
    install('lower', 'v1', { title: { type: 'string', default: 'A' } })
    const layerId = place('lower')
    const replaced = entries().lower!
    install('lower', 'v2', { headline: { type: 'string', default: 'B' } })
    const len = historyLen()
    const updated = records.updateFromLibrary('lower')
    expect(historyLen()).toBe(len + 1)
    expect(entries().lower).toEqual({ uid: replaced.uid, revision: updated.revision, from: { uid: replaced.uid, version: 2, revision: library.describe('lower')!.revision } })
    const props = () => [...eachLayer(actor.snapshot())].find(({ layer }) => layer.id === layerId)!.layer.params as { props: Record<string, unknown> }
    expect(props().props).toEqual({ headline: 'B' })
    expect(backups().has('lower', replaced.revision!)).toBe(true)
    actor.dispatch('undo', {})
    expect(entries().lower).toEqual(replaced)
    expect(project.status('lower').revision).toBe(replaced.revision)
    expect(props().props).toEqual({ title: 'A' })
  })
})

describe('opening a project', () => {
  it('keeps the backups of the revisions its table records, and no others', () => {
    install('lower', 'v1')
    place('lower')
    const kept = entries().lower!.revision!
    edit('lower', 'edited')
    records.folderChanged('lower', project.status('lower'))
    const edited = entries().lower!.revision!
    actor.dispatch('undo', {})
    // The table is back at `kept`; the edit's backup is history's alone, and
    // an open starts with none.
    records.opened()
    expect(backups().has('lower', kept)).toBe(true)
    expect(backups().has('lower', edited)).toBe(false)
  })

  it('records a folder edited while the project was closed', () => {
    install('lower', 'v1')
    place('lower')
    const len = historyLen()
    edit('lower', 'while closed')
    records.opened()
    expect(historyLen()).toBe(len + 1)
    expect(entries().lower!.revision).toBe(project.status('lower').revision)
    // Found at the open, not edited here: Motif trust tells the two apart.
    expect(seen.filter(([, , cause]) => cause === 'opened')).toEqual([['lower', entries().lower!.revision, 'opened']])
    expect(seen.some(([, , cause]) => cause === 'edited-while-open')).toBe(false)
    expect(existsSync(folder('lower'))).toBe(true)
  })
})
