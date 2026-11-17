// Motif trust (spec § Trust): the machine's record of trusted revisions, the
// revisions the library makes trusted, and what each way of seeing a
// revision earns, over real project folders.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { encodeMotifZip } from './archive'
import { builtinMotifs, motifRevision } from './authoring'
import { newLineage } from './lineage'
import { normalize } from './motifPackage'
import { libraryPackage, ProjectMotifStore } from './projectStore'
import { UserMotifStore } from './store'
import { FOUND_KEPT, libraryRevisions, MotifTrust, TRUST_CORRUPT_SUFFIX, TRUST_FILE, TRUST_KEPT, trustOnSeen } from './trust'

const BUILTINS = builtinMotifs(path.resolve(__dirname, '../../shared/motifs/builtin'))

let root: string
let library: UserMotifStore
let project: ProjectMotifStore
let trust: MotifTrust
const file = () => path.join(root, 'library', TRUST_FILE)
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'motif-trust-'))
  library = new UserMotifStore(path.join(root, 'library'))
  trust = new MotifTrust(file(), () => libraryRevisions(library, BUILTINS))
  project = new ProjectMotifStore(path.join(root, 'Film'), { revisions: library.revisions })
  project.onRevisionSeen((_id, revision, cause, base) => trust.seen(revision, cause, base))
})
// A coalesced write still pending must not make the folder again.
afterEach(() => { trust.flush(); rmSync(root, { recursive: true, force: true }) })

const rev = (n: number) => createHash('sha256').update(String(n)).digest('hex')
const manifest = (name: string): Manifest => ({ id: 'x', name, version: 1, size: [64, 64], default_duration_s: 1, props_schema: {} })
const page = (name: string, body = 'one') =>
  Buffer.from(composeMotifHtml(manifest(name), `<html><head></head><body><script>motif.define({frame(t){ /* ${body} */ }})</script></body></html>`))
function install(id: string, body = 'v'): void {
  const version = library.nextVersion(id)
  library.addVersion(id, version, normalize([{ path: 'index.html', bytes: page(id, body) }], id, version).files)
}
/** Writes a Motif folder as another machine's project would hold it. */
function received(dir: string, name: string, body = 'received'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'index.html'), page(name, body))
}

describe('the trust record', () => {
  it('keeps what was trusted across a restart', () => {
    trust.trustNow(rev(1))
    trust.seen(rev(2), 'placed', null)
    trust.flush()
    const restarted = new MotifTrust(file(), () => [])
    expect(restarted.trusted(rev(1))).toBe(true)
    expect(restarted.trusted(rev(2))).toBe(true)
    expect(restarted.trusted(rev(3))).toBe(false)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ version: 1, revisions: { [rev(1)]: [expect.any(Number), 'user'], [rev(2)]: [expect.any(Number), 'placed'] } })
  })

  it('writes the user\'s Trust before it returns', () => {
    trust.trustNow(rev(1))
    expect(new MotifTrust(file(), () => []).trusted(rev(1))).toBe(true)
  })

  it('moves an unreadable record aside and trusts nothing from it', () => {
    mkdirSync(path.dirname(file()), { recursive: true })
    writeFileSync(file(), '{ not json')
    expect(trust.trusted(rev(1))).toBe(false)
    expect(readFileSync(file() + TRUST_CORRUPT_SUFFIX, 'utf8')).toBe('{ not json')
    expect(existsSync(file())).toBe(false)
    trust.trustNow(rev(1))
    expect(new MotifTrust(file(), () => []).trusted(rev(1))).toBe(true)
  })

  it('keeps the newest revisions past its cap, the oldest leaving first', () => {
    let now = 0
    const capped = new MotifTrust(file(), () => [], () => ++now)
    for (let n = 0; n <= TRUST_KEPT; n++) capped.seen(rev(n), 'placed', null)
    expect(capped.trusted(rev(0))).toBe(false)
    expect(capped.trusted(rev(1))).toBe(true)
    expect(capped.trusted(rev(TRUST_KEPT))).toBe(true)
    capped.flush()
    const restarted = new MotifTrust(file(), () => [])
    expect(restarted.trusted(rev(0))).toBe(false)
    expect(restarted.trusted(rev(1))).toBe(true)
    expect(restarted.trusted(rev(TRUST_KEPT))).toBe(true)
  })

  it('trusts every built-in and every installed library version without recording them', () => {
    install('lower', 'v1')
    const first = library.versions('lower')[0]!.revision
    install('lower', 'v2')
    const second = library.versions('lower')[0]!.revision
    expect(first).not.toBe(second)
    for (const builtin of BUILTINS) expect(trust.trusted(motifRevision(library, BUILTINS, builtin.id)), builtin.id).toBe(true)
    expect(trust.trusted(first)).toBe(true)
    expect(trust.trusted(second)).toBe(true)
    trust.flush()
    expect(existsSync(file())).toBe(false)
    // A version added since is trusted once the library is read again.
    install('lower', 'v3')
    const third = library.versions('lower')[0]!.revision
    expect(trust.trusted(third)).toBe(false)
    trust.libraryChanged()
    expect(trust.trusted(third)).toBe(true)
  })
})

describe('what seeing a revision earns', () => {
  const known = (trusted: string[], found: string[] = []) => ({ trusted: (r: string) => trusted.includes(r), found: new Set(found) })
  it('follows the rules table', () => {
    const [r, base] = [rev(1), rev(2)]
    expect(trustOnSeen(r, 'placed', null, known([]))).toBe('trust')
    expect(trustOnSeen(r, 'placed', null, known([], [r]))).toBe('trust')
    expect(trustOnSeen(r, 'created', null, known([]))).toBe('trust')
    expect(trustOnSeen(r, 'created', null, known([], [r]))).toBeNull()
    expect(trustOnSeen(r, 'imported', null, known([]))).toBeNull()
    expect(trustOnSeen(r, 'imported', base, known([]))).toBeNull()
    expect(trustOnSeen(r, 'imported', base, known([base]))).toBe('trust')
    expect(trustOnSeen(r, 'imported', base, known([base], [r]))).toBeNull()
    expect(trustOnSeen(r, 'edited-while-open', base, known([base]))).toBe('trust')
    expect(trustOnSeen(r, 'edited-while-open', base, known([]))).toBeNull()
    expect(trustOnSeen(r, 'edited-while-open', base, known([base], [r]))).toBeNull()
    expect(trustOnSeen(r, 'edited-while-open', null, known([]))).toBeNull()
    expect(trustOnSeen(r, 'opened', null, known([]))).toBe('found')
    expect(trustOnSeen(r, 'opened', null, known([r]))).toBeNull()
  })

  it('remembers every revision the open project found, and the newest of projects opened before', () => {
    trust.projectOpened()
    for (let n = 0; n <= FOUND_KEPT; n++) trust.seen(rev(n), 'opened', null)
    trust.seen(rev(0), 'created', null)
    expect(trust.trusted(rev(0)), 'found by the open project, past the cap').toBe(false)
    trust.projectOpened()
    trust.seen(rev(1), 'created', null)
    expect(trust.trusted(rev(1)), 'found by the project before, within the cap').toBe(false)
    trust.seen(rev(0), 'created', null)
    expect(trust.trusted(rev(0)), 'found by the project before, past the cap').toBe(true)
  })

  it('trusts a library Motif placed in the project, and keeps trusting it once the library version is gone', () => {
    install('lower')
    const placed = project.place(libraryPackage(library, [], 'lower')!, {})
    expect(trust.trusted(placed.entry.revision!)).toBe(true)
    rmSync(path.join(root, 'library', 'lower'), { recursive: true })
    trust.libraryChanged()
    expect(trust.trusted(placed.entry.revision!)).toBe(true)
  })

  it('trusts a Motif made here and every edit made from it while the project is open', () => {
    const made = project.create({ kind: 'empty', name: 'Badge' }, {})
    expect(trust.trusted(made.entry.revision!)).toBe(true)
    const edited = project.applyChanges(made.id, made.entry.revision!, new Map([['a.txt', Buffer.from('a')]]))
    expect(trust.trusted(edited)).toBe(true)
  })

  it('trusts neither a ZIP nor a folder from outside the project, nor any edit made from one', () => {
    const outside = path.join(root, 'Downloads', 'card')
    received(outside, 'Card')
    const fromFolder = project.create({ kind: 'directory', path: outside }, {})
    expect(trust.trusted(fromFolder.entry.revision!)).toBe(false)
    const zip = path.join(root, 'card.zip')
    writeFileSync(zip, encodeMotifZip('card', [{ path: 'index.html', bytes: page('Zipped') }], newLineage()))
    const fromZip = project.create({ kind: 'zip', path: zip }, { [fromFolder.id]: fromFolder.entry })
    expect(trust.trusted(fromZip.entry.revision!)).toBe(false)
    // An untrusted revision never has a trusted child.
    const edited = project.applyChanges(fromZip.id, fromZip.entry.revision!, new Map([['a.txt', Buffer.from('a')]]))
    expect(trust.trusted(edited)).toBe(false)
  })

  it('trusts a ZIP this library exported, under its own id and under another when the project holds its own', () => {
    install('lower')
    const pkg = libraryPackage(library, [], 'lower')!
    const zip = path.join(root, 'lower.zip')
    writeFileSync(zip, encodeMotifZip('lower', pkg.files, pkg.uid))
    const first = project.create({ kind: 'zip', path: zip }, {})
    expect(first.id).toBe('lower')
    expect(trust.trusted(first.entry.revision!)).toBe(true)
    // Renamed beside it, the copy's manifest names its new id: other bytes,
    // trusted for the bytes it came as.
    const beside = project.create({ kind: 'zip', path: zip }, { [first.id]: first.entry })
    expect(beside.id).not.toBe('lower')
    expect(beside.entry.revision).not.toBe(first.entry.revision)
    expect(trust.trusted(beside.entry.revision!)).toBe(true)
    trust.flush()
    expect(JSON.parse(readFileSync(file(), 'utf8')).revisions[beside.entry.revision!][1], 'recorded as this library\'s').toBe('placed')
  })

  it('trusts a library version folder brought in as a directory beside its placed copy, and no folder of other bytes', () => {
    install('lower')
    const placed = project.place(libraryPackage(library, [], 'lower')!, {})
    const fromLibrary = project.create({ kind: 'directory', path: path.join(root, 'library', 'lower', 'v1') }, { [placed.id]: placed.entry })
    expect(fromLibrary.id).not.toBe(placed.id)
    expect(trust.trusted(fromLibrary.entry.revision!)).toBe(true)
    const outside = path.join(root, 'Downloads', 'lower')
    received(outside, 'Lower', 'not the library\'s')
    const foreign = project.create({ kind: 'directory', path: outside }, { [placed.id]: placed.entry, [fromLibrary.id]: fromLibrary.entry })
    expect(trust.trusted(foreign.entry.revision!)).toBe(false)
  })

  it('hears a kept folder holding other bytes than the copy as found, not placed', () => {
    install('lower')
    received(project.folder('lower'), 'Lower', 'someone else\'s')
    const causes: string[] = []
    project.onRevisionSeen((_id, _revision, cause) => causes.push(cause))
    const revision = project.materialize('lower', libraryPackage(library, [], 'lower')!.files, 'placed')
    expect(causes).toEqual(['opened'])
    expect(trust.trusted(revision)).toBe(false)
  })
})
