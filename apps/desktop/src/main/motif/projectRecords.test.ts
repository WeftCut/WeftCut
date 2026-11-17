import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { createActor, type ActorHandle } from '../state/actor'
import { seededGen } from '../state/ids'
import { blankProject, eachLayer } from '../state/model'
import { MotifBackups } from './backups'
import { newLineage } from './lineage'
import { declaredPackage, normalize } from './motifPackage'
import { FILE_EDITS, ProjectMotifRecords, projectMotifAccess } from './projectRecords'
import { libraryPackage, libraryPackageOfLineage, ProjectMotifStore, type RevisionCause } from './projectStore'
import { UserMotifStore } from './store'
import { MotifResolver } from './resolver'
import { FOUND_KEPT, MotifTrust } from './trust'

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
/** A revision no folder holds, standing for one more folder found at an open. */
const decoy = (n: number) => createHash('sha256').update(`decoy ${n}`).digest('hex')

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
    records.folderChanged('lower', project.observe('lower'))
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('card', project.observe('card'))
    edit('lower', 'edited')
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('lower', project.observe('lower'))
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
    records.folderChanged('constructor', project.observe('constructor'))
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
    records.folderChanged('lower', project.observe('lower'))
    expect(entries().lower!.revision).toBe(placed)
    busy = false
    records.retry()
    expect(entries().lower!.revision).toBe(closedEdit)
    expect(trust.trusted(closedEdit)).toBe(false)
    // An edit made from it while open stays untrusted too.
    edit('lower', 'while open')
    records.folderChanged('lower', project.observe('lower'))
    expect(entries().lower!.revision).toBe(project.status('lower').revision)
    expect(trust.trusted(entries().lower!.revision!)).toBe(false)
  })

  it('trusts an edit on disk made while the project is open, from a trusted revision', () => {
    const { trust } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    records.opened()
    edit('lower', 'while open')
    records.folderChanged('lower', project.observe('lower'))
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

  it('trusts a folder first written while the project is open when it is read: it was made here', () => {
    const { trust, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    records.opened()
    mkdirSync(folder('stray'), { recursive: true })
    edit('stray', 'arrived while open')
    expect(resolver.resolve('stray').status).toBe('ok')
  })

  it('keeps a folder found under Motifs/ at the open untrusted when it is adopted, however many others were found', () => {
    mkdirSync(folder('found'), { recursive: true })
    edit('found', 'from another machine')
    const { trust } = trusting(); trusted = trust
    // As many other folders found at the open as the found set keeps.
    for (let n = 0; n < FOUND_KEPT; n++) trust.seen(decoy(n), 'opened', null)
    records.opened()
    const adopted = project.create({ kind: 'directory', path: folder('found') }, entries())
    expect(adopted.entry.revision).toBe(project.status('found').revision)
    expect(trust.trusted(adopted.entry.revision!)).toBe(false)
  })

  it('adopts a folder first written under Motifs/ while the project is open as trusted: it was made here', () => {
    const { trust } = trusting(); trusted = trust
    records.opened()
    mkdirSync(folder('written'), { recursive: true })
    edit('written', 'arrived while open')
    const adopted = project.create({ kind: 'directory', path: folder('written') }, entries())
    expect(trust.trusted(adopted.entry.revision!)).toBe(true)
  })

  it('judges a folder found at the open, removed and written again, from what this session saw in it', () => {
    mkdirSync(folder('found'), { recursive: true })
    edit('found', 'from another machine')
    const { trust } = trusting(); trusted = trust
    records.opened()
    rmSync(folder('found'), { recursive: true })
    mkdirSync(folder('found'))
    edit('found', 'written while open')
    const adopted = project.create({ kind: 'directory', path: folder('found') }, entries())
    expect(trust.trusted(adopted.entry.revision!)).toBe(false)
  })

  it('keeps a folder untrusted that was there at the open without making a package, once it makes one', () => {
    mkdirSync(folder('found'), { recursive: true })
    writeFileSync(path.join(folder('found'), 'index.html'), 'no manifest yet')
    const { trust, resolver } = trusting(); trusted = trust
    records.opened()
    edit('found', 'manifest added while open')
    expect(resolver.resolve('found').status).toBe('untrusted')
    expect(trust.trusted(project.status('found').revision!)).toBe(false)
  })

  it('puts back a backup the received project planted for a folder the open did not find as found, never as made here', () => {
    // The received table records 'ghost', its folder gone, its revision
    // backed up.
    mkdirSync(folder('ghost'), { recursive: true })
    edit('ghost', 'from another machine')
    const ghost = project.status('ghost').revision!
    expect(actor.dispatch('set_project_motif', { motif_id: 'ghost', uid: newLineage(), revision: ghost, from: null }).ok).toBe(true)
    expect(backups().has('ghost', ghost)).toBe(true)
    rmSync(folder('ghost'), { recursive: true })
    const { trust, resolver } = trusting(); trusted = trust
    records.opened()
    install('lower', 'v1')
    place('lower')
    actor.dispatch('undo', {})
    expect(project.status('ghost').revision).toBe(ghost)
    expect(resolver.resolve('ghost').status).toBe('untrusted')
    expect(trust.trusted(ghost)).toBe(false)
  })

  it('keeps every revision found at the open untrusted when a later write brings it back, however many were found', () => {
    const { trust, reopen, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    const placed = entries().lower!.revision!
    const received = edit('lower', 'while closed')
    const closedEdit = project.status('lower').revision!
    reopen()
    for (let n = 0; n < FOUND_KEPT; n++) trust.seen(decoy(n), 'opened', null)
    records.opened()
    expect(entries().lower!.revision).toBe(closedEdit)
    actor.dispatch('undo', {})
    expect(project.status('lower').revision).toBe(placed)
    // A sync tool writes the received bytes back while the project is open.
    writeFileSync(path.join(folder('lower'), 'index.html'), received)
    expect(resolver.resolve('lower').status).toBe('untrusted')
    expect(trust.trusted(closedEdit)).toBe(false)
  })

  it('puts a recorded revision back as found: trusted only when it was before, whatever the folder held', () => {
    mkdirSync(folder('card'), { recursive: true })
    edit('card', 'from another machine')
    const { trust, resolver } = trusting(); trusted = trust
    expect(actor.dispatch('set_project_motif', { motif_id: 'card', uid: newLineage(), revision: project.status('card').revision, from: null }).ok).toBe(true)
    records.opened()
    // Edits made from the untrusted revision stay untrusted; the user then
    // trusts the last one.
    edit('card', 'first edit')
    records.folderChanged('card', project.observe('card'))
    const first = entries().card!.revision!
    edit('card', 'second edit')
    records.folderChanged('card', project.observe('card'))
    const second = entries().card!.revision!
    expect(trust.trusted(first) || trust.trusted(second)).toBe(false)
    trust.trustNow(second)
    // Undo puts the first edit back into a folder holding trusted bytes.
    actor.dispatch('undo', {})
    expect(project.status('card').revision).toBe(first)
    expect(resolver.resolve('card').status).toBe('untrusted')
    expect(trust.trusted(first)).toBe(false)
    actor.dispatch('redo', {})
    expect(project.status('card').revision).toBe(second)
    expect(resolver.resolve('card').status).toBe('ok')
  })

  it('trusts an edit made while the project is open of a folder found trusted at the open', () => {
    const { trust, reopen, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    reopen()
    records.opened()
    edit('lower', 'while open')
    const written = project.status('lower').revision!
    expect(resolver.resolve('lower')).toMatchObject({ status: 'ok', revision: written })
    expect(trust.trusted(written)).toBe(true)
  })

  it('never puts back a backup whose files make another revision than it names, nor trusts them', () => {
    const { trust, resolver } = trusting(); trusted = trust
    install('lower', 'v1')
    place('lower')
    const placed = entries().lower!.revision!
    records.opened()
    edit('lower', 'while open')
    records.folderChanged('lower', project.observe('lower'))
    // A received project's Backups/ maps the placed revision to other bytes.
    const planted = Buffer.from(composeMotifHtml(manifest('lower'), '<html><head></head><body><script>motif.define({frame(t){ /* planted */ }})</script></body></html>'))
    const blob = createHash('sha256').update(planted).digest('hex')
    const plantedRevision = declaredPackage([{ path: 'index.html', bytes: planted }], 'lower').revision
    writeFileSync(path.join(projectDir, 'Backups', 'motifs', '.blobs', blob), planted)
    writeFileSync(path.join(projectDir, 'Backups', 'motifs', 'lower', `${placed}.json`), JSON.stringify({ files: { 'index.html': blob } }))
    actor.dispatch('undo', {})
    expect(resolver.resolve('lower').status).not.toBe('missing')
    records.folderChanged('lower', project.observe('lower'))
    expect(pageOf('lower')).not.toContain('planted')
    expect(trust.trusted(plantedRevision)).toBe(false)
    expect(warned.some(m => m.includes("Motif 'lower' could not be put back"))).toBe(true)
  })
})
