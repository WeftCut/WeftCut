import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
import { MotifResolver } from './resolver'
import { MotifTrust } from './trust'

let root: string
let library: UserMotifStore
let project: ProjectMotifStore
let projectDir: string
let actor: ActorHandle
let records: ProjectMotifRecords
let seen: Array<[string, string, RevisionCause]>
let warned: string[]
let rewatched: string[]
/** While set, the project refuses every write, as during an export. */
let busy: boolean
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'project-records-'))
  library = new UserMotifStore(path.join(root, 'library'))
  projectDir = path.join(root, 'Film')
  project = new ProjectMotifStore(projectDir)
  seen = []
  warned = []
  rewatched = []
  busy = false
  project.onRevisionSeen((id, revision, cause) => seen.push([id, revision, cause]))
  const idGen = seededGen()
  actor = createActor({
    initial: blankProject(idGen, 'Film'), idGen, motifs: projectMotifAccess(() => project, id => libraryPackage(library, [], id)),
    assertWritable: () => { if (busy) throw new Error('An export is active') },
  })
  records = new ProjectMotifRecords({
    actor, project: () => project, libraryOfLineage: uid => libraryPackageOfLineage(library, [], uid),
    warn: message => warned.push(message), rewatch: id => rewatched.push(id),
  })
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
    expect(entries().lower).toEqual({ uid: replaced.uid, revision: updated.revision, from: { uid: replaced.uid, version: 2, revision: library.installedListing('lower')!.revision } })
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
    // Recorded, never heard as an edit made here: Motif trust tells the two apart.
    expect(seen.some(([, , cause]) => cause === 'edited-while-open')).toBe(false)
    expect(existsSync(folder('lower'))).toBe(true)
  })
})

describe('a move through history', () => {
  it('leaves a folder holding an edit not recorded yet, and records it', async () => {
    install('lower', 'v1')
    place('lower')
    edit('lower', 'recorded')
    records.folderChanged('lower', project.status('lower'))
    // Written after the last record, before the watcher told it.
    const unrecorded = edit('lower', 'not told yet')
    const revision = project.status('lower').revision!
    actor.dispatch('undo', {})
    expect(pageOf('lower')).toBe(unrecorded)
    expect(warned.some(m => m.includes("Motif 'lower' was not put back"))).toBe(true)
    // Recorded once the undo's broadcast is over.
    await Promise.resolve()
    expect(entries().lower!.revision).toBe(revision)
    expect(lastOp().actor).toEqual(FILE_EDITS)
  })

  it('makes the watcher tell the next change of each folder it puts back', () => {
    install('lower', 'v1')
    install('card', 'v1')
    place('lower')
    place('card')
    edit('lower', 'edited')
    records.folderChanged('lower', project.status('lower'))
    actor.dispatch('undo', {})
    // An agent writing the undone revision again lands on the state the
    // watcher last told: unless forgotten, that write would go unrecorded.
    expect(rewatched).toEqual(['lower'])
  })

  it('puts back every folder it can when one cannot be', () => {
    install('card', 'v1')
    install('lower', 'v1')
    place('card')
    place('lower')
    const at = actor.historyStatus().cursor
    const card = pageOf('card'), lower = pageOf('lower')
    const placedCard = entries().card!.revision!
    edit('card', 'edited')
    records.folderChanged('card', project.status('card'))
    edit('lower', 'edited')
    records.folderChanged('lower', project.status('lower'))
    // The card's placed revision can no longer be read back.
    writeFileSync(path.join(projectDir, 'Backups', 'motifs', 'card', `${placedCard}.json`), 'damaged')
    actor.dispatch('jump_to', { index: at })
    expect(pageOf('card')).not.toBe(card)
    expect(pageOf('lower')).toBe(lower)
    expect(warned.some(m => m.includes("Motif 'card' could not be put back"))).toBe(true)
  })
})

describe('an edit the project refuses to record', () => {
  it('waits, is told again by the watcher, and is recorded once writes are taken', () => {
    install('lower', 'v1')
    place('lower')
    const len = historyLen()
    edit('lower', 'during export')
    busy = true
    records.folderChanged('lower', project.status('lower'))
    expect(historyLen()).toBe(len)
    expect(rewatched).toContain('lower')
    busy = false
    records.retry()
    expect(historyLen()).toBe(len + 1)
    expect(entries().lower!.revision).toBe(project.status('lower').revision)
  })
})

describe('updating a folder whose files make no package', () => {
  /** Leaves `lower`'s folder mid-edit: its page renamed, a note beside it. */
  function breakFolder(): void {
    renameSync(path.join(folder('lower'), 'index.html'), path.join(folder('lower'), 'index.old'))
    writeFileSync(path.join(folder('lower'), 'notes.txt'), 'half done')
  }

  it('moves the unfinished files under Backups/motifs/unfinished and says where', () => {
    install('lower', 'v1')
    place('lower')
    breakFolder()
    install('lower', 'v2')
    const updated = records.updateFromLibrary('lower')
    // Answered relative to the project folder, as the panel shows it.
    expect(updated.unfinished).toMatch(/^Backups\/motifs\/unfinished\/lower-/)
    const aside = path.join(projectDir, ...updated.unfinished!.split('/'))
    expect(readFileSync(path.join(aside, 'notes.txt'), 'utf8')).toBe('half done')
    expect(existsSync(path.join(aside, 'index.old'))).toBe(true)
    expect(project.status('lower')).toMatchObject({ status: 'ok', revision: updated.revision })
    expect(warned.some(m => m.includes(aside))).toBe(true)
    // A later open collects backups, never what was set aside.
    records.opened()
    expect(existsSync(path.join(aside, 'notes.txt'))).toBe(true)
  })

  it('puts the unfinished files back when the update is refused', () => {
    install('lower', 'v1')
    place('lower')
    breakFolder()
    install('lower', 'v2')
    busy = true
    expect(() => records.updateFromLibrary('lower')).toThrow()
    expect(readFileSync(path.join(folder('lower'), 'notes.txt'), 'utf8')).toBe('half done')
    expect(existsSync(path.join(folder('lower'), 'index.old'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'Backups', 'motifs', 'unfinished'))
      && readdirSync(path.join(projectDir, 'Backups', 'motifs', 'unfinished')).length).toBeFalsy()
  })
})

describe('placing a Motif the project holds but cannot render', () => {
  const refusal = () => {
    const r = actor.command('add_motif', { motifId: 'lower', tStartUs: 0 })
    if (r.ok) throw new Error('placed')
    return JSON.stringify(r.error)
  }

  it('asks for the library copy only when the folder is gone', () => {
    install('lower', 'v1')
    place('lower')
    rmSync(folder('lower'), { recursive: true })
    expect(refusal()).toContain('from_library: true')
  })

  it('asks for the files fixed, or Restore from library, when they make no package', () => {
    install('lower', 'v1')
    place('lower')
    renameSync(path.join(folder('lower'), 'index.html'), path.join(folder('lower'), 'index.old'))
    expect(refusal()).not.toContain('from_library')
    expect(refusal()).toContain('Restore from library')
  })
})

describe('a library id that is no project key', () => {
  it('is placed under the key the v5 upgrade would give it', () => {
    install('Lower Third', 'v1')
    place('Lower Third')
    expect(Object.keys(entries())).toEqual(['lower-third'])
    expect(project.status('lower-third').status).toBe('ok')
  })
})

describe('an id Object.prototype answers', () => {
  it('names no Motif of the table: its folder is never recorded', () => {
    install('lower', 'v1')
    place('lower')
    cpSync(folder('lower'), folder('constructor'), { recursive: true })
    const len = historyLen()
    records.folderChanged('constructor', project.status('constructor'))
    expect(historyLen()).toBe(len)
    expect(Object.keys(entries())).toEqual(['lower'])
  })
})

describe('Motif trust across an open', () => {
  /** The machine's trust record and the resolver hearing the open project,
   *  as the app wires them; `reopen` makes the project folder the open one
   *  again, as a project open does before its records settle. */
  function trusting() {
    const trust = new MotifTrust(path.join(root, 'trust.json'), () => [])
    const resolver = new MotifResolver(library, [], trust)
    resolver.onRevisionSeen((_id, revision, cause, base) => trust.seen(revision, cause, base))
    resolver.recordedBy(id => Object.hasOwn(entries(), id) ? entries()[id]!.revision : null)
    const reopen = () => {
      project = new ProjectMotifStore(projectDir)
      resolver.setProject(project)
    }
    reopen()
    return { trust, reopen, resolver }
  }
  afterEach(() => { trusted?.flush(); trusted = null })
  let trusted: MotifTrust | null = null

  it('never trusts an edit made while the project was closed', () => {
    const { trust, reopen } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    expect(trust.trusted(entries().lower!.revision!)).toBe(true)
    edit('lower', 'while closed')
    reopen()
    records.opened()
    expect(entries().lower!.revision).toBe(project.status('lower').revision)
    expect(trust.trusted(entries().lower!.revision!)).toBe(false)
  })

  it('never trusts it when it is heard as an edit before the open settles, and recorded late', () => {
    const { trust, reopen } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    const placed = entries().lower!.revision!
    edit('lower', 'while closed')
    const closedEdit = project.status('lower').revision!
    reopen()
    // The watcher tells the folder while the open still refuses writes: it
    // waits for `retry`, which hears it as an edit made from the trusted
    // revision the table records.
    busy = true
    records.folderChanged('lower', project.status('lower'))
    expect(entries().lower!.revision).toBe(placed)
    busy = false
    records.retry()
    expect(entries().lower!.revision).toBe(closedEdit)
    expect(trust.trusted(closedEdit)).toBe(false)
    // An edit made from it while open stays untrusted too.
    edit('lower', 'while open')
    records.folderChanged('lower', project.status('lower'))
    expect(entries().lower!.revision).toBe(project.status('lower').revision)
    expect(trust.trusted(entries().lower!.revision!)).toBe(false)
  })

  it('trusts an edit on disk made while the project is open, from a trusted revision', () => {
    const { trust } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    records.opened()
    edit('lower', 'while open')
    records.folderChanged('lower', project.status('lower'))
    expect(entries().lower!.revision).toBe(project.status('lower').revision)
    expect(trust.trusted(entries().lower!.revision!)).toBe(true)
  })

  it('trusts an edit on disk made while the project is open when it is read, before the watcher hears it', () => {
    const { trust, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    records.opened()
    edit('lower', 'while open')
    const written = project.status('lower').revision!
    expect(resolver.resolve('lower')).toMatchObject({ status: 'ok', revision: written })
    expect(trust.trusted(written)).toBe(true)
  })

  it('keeps an edit made while the project was closed untrusted when it is read before the open records it', () => {
    const { trust, reopen, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    edit('lower', 'while closed')
    reopen()
    // The table still records the trusted placed revision.
    expect(resolver.resolve('lower').status).toBe('untrusted')
    records.opened()
    expect(resolver.resolve('lower').status).toBe('untrusted')
  })

  it('keeps an edit made while open from an untrusted revision untrusted when it is read', () => {
    const { trust, reopen, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    edit('lower', 'while closed')
    reopen()
    records.opened()
    edit('lower', 'while open')
    expect(resolver.resolve('lower').status).toBe('untrusted')
    expect(trust.trusted(project.status('lower').revision!)).toBe(false)
  })

  it('trusts no folder the table does not record when it is read', () => {
    const { trust, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    records.opened()
    mkdirSync(folder('stray'), { recursive: true })
    edit('stray', 'arrived while open')
    expect(resolver.resolve('stray').status).toBe('untrusted')
  })

  it('keeps a folder found under Motifs/ at the open untrusted when it is adopted', () => {
    mkdirSync(folder('found'), { recursive: true })
    edit('found', 'from another machine')
    const { trust } = trusting(); trusted = trust
    records.opened()
    const adopted = project.create({ kind: 'directory', path: folder('found') }, entries())
    expect(adopted.entry.revision).toBe(project.status('found').revision)
    expect(trust.trusted(adopted.entry.revision!)).toBe(false)
  })
})
