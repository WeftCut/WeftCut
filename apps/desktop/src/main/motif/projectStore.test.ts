import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BUILTIN_MANIFESTS, builtinLineage, composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { collisionId, type ProjectMotifs } from '../../shared/motifs/projectMotifs'
import { builtinMotifs } from './authoring'
import { encodeMotifZip } from './archive'
import { motifContentHash } from './contentHash'
import { isLineageUid } from './lineage'
import { normalize } from './motifPackage'
import { readMotifDirectory, type MotifFile } from './packageFiles'
import { PackageRevisions } from './packageRevisions'
import { libraryPackage, ProjectMotifStore, writeThrough, type RevisionCause } from './projectStore'
import { UserMotifStore } from './store'

let root: string
let library: UserMotifStore
let project: ProjectMotifStore
let projectDir: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'project-motifs-'))
  library = new UserMotifStore(path.join(root, 'library'))
  projectDir = path.join(root, 'Film')
  project = new ProjectMotifStore(projectDir)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const manifest = (name: string, version = 1): Manifest => ({ id: 'x', name, version, size: [320, 180], default_duration_s: 2, props_schema: {} })
const page = (name: string, body = 'motif.define({frame(t){}})') =>
  Buffer.from(composeMotifHtml(manifest(name), `<html><head></head><body><script>${body}</script></body></html>`))

/** Installs `id` the way a publication does: normalised under its id and version. */
function install(id: string, name: string, extra: MotifFile[] = []): void {
  const version = library.nextVersion(id)
  library.addVersion(id, version, normalize([{ path: 'index.html', bytes: page(name) }, ...extra], id, version).files)
}

const folder = (id: string) => path.join(projectDir, 'Motifs', id)
const uidHex = (uid: string) => uid.replace(/-/g, '').slice(0, 8)

describe('placing a library Motif', () => {
  it('copies it with its revision and lineage, so its stored frames keep their keys', () => {
    install('lower', 'Lower', [{ path: 'art.svg', bytes: Buffer.from('<svg/>') }])
    const placed = project.place(libraryPackage(library, [], 'lower')!, {})
    const source = library.installedListing('lower')!
    expect(placed).toMatchObject({ id: 'lower', copied: true })
    expect(placed.entry).toEqual({ uid: library.lineage.of('lower'), revision: source.revision,
      from: { uid: library.lineage.of('lower'), version: 1, revision: source.revision } })
    expect(project.status('lower')).toEqual({ status: 'ok', revision: source.revision })
  })

  it('copies a built-in with its fixed lineage, hashing to the built-in revision', () => {
    const builtins = builtinMotifs('src/shared/motifs/builtin')
    expect(builtins.length).toBeGreaterThan(0)
    for (const b of builtins) {
      const placed = project.place(libraryPackage(library, builtins, b.id)!, {})
      expect(placed.entry.uid).toBe(builtinLineage(b.id))
      // The built-in revision as authoring.ts computes it for the catalog.
      expect(project.status(b.id).revision).toBe(motifContentHash(BUILTIN_MANIFESTS.get(b.id)!, b.html, b.files))
    }
  })

  it('places a lineage the project holds under the id it has, copying nothing', () => {
    install('lower', 'Lower')
    const first = project.place(libraryPackage(library, [], 'lower')!, {})
    const table: ProjectMotifs = { 'lower-renamed': first.entry }
    // Its folder gone, the lineage's id gets a copy again.
    const again = project.place(libraryPackage(library, [], 'lower')!, table)
    expect(again).toMatchObject({ id: 'lower-renamed', copied: true, entry: { uid: first.entry.uid, from: first.entry.from } })
    expect(again.entry.revision).toBe(project.status('lower-renamed').revision)
    expect(project.place(libraryPackage(library, [], 'lower')!, table)).toEqual({ id: 'lower-renamed', entry: first.entry, copied: false })
  })

  it('sends the copy to <id>-<uid prefix> when another lineage holds the id', () => {
    install('lower', 'Lower')
    const pkg = libraryPackage(library, [], 'lower')!
    const other = { uid: '0b8f6c1e-2d4a-4e5f-8a9b-1c2d3e4f5a6b', revision: null, from: null }
    const placed = project.place(pkg, { lower: other })
    expect(placed.id).toBe(`lower-${uidHex(pkg.uid)}`)
    expect(project.status(placed.id).status).toBe('ok')
  })

  it('sends the copy aside from a folder holding other files, and never writes over it', () => {
    install('lower', 'Lower')
    mkdirSync(folder('lower'), { recursive: true })
    writeFileSync(path.join(folder('lower'), 'index.html'), page('Someone else'))
    const placed = project.place(libraryPackage(library, [], 'lower')!, {})
    expect(placed.id).toBe(collisionId('lower', library.lineage.of('lower')))
    expect(readFileSync(path.join(folder('lower'), 'index.html'))).toEqual(page('Someone else'))
  })
})

describe('making a Motif in the project', () => {
  it('mints a new lineage and takes an id from its name, numbered when taken', () => {
    const first = project.create({ kind: 'empty', name: 'Title Card' }, {})
    expect(first.id).toBe('title-card')
    expect(isLineageUid(first.entry.uid)).toBe(true)
    expect(first.entry.from).toBeNull()
    expect(project.status('title-card').revision).toBe(first.entry.revision)
    const second = project.create({ kind: 'empty', name: 'Title Card' }, { [first.id]: first.entry })
    expect(second.id).toBe('title-card-2')
    expect(second.entry.uid).not.toBe(first.entry.uid)
  })

  it('gives a name without ASCII letters an id from its lineage', () => {
    const a = project.create({ kind: 'empty', name: '片头' }, {})
    const b = project.create({ kind: 'empty', name: '片尾' }, { [a.id]: a.entry })
    expect(a.id).toBe(`motif-${uidHex(a.entry.uid)}`)
    expect(b.id).toBe(`motif-${uidHex(b.entry.uid)}`)
    expect(a.id).not.toBe(b.id)
  })

  it('copies a directory, so later edits of the source leave the project alone', () => {
    const source = path.join(root, 'outside')
    mkdirSync(source)
    writeFileSync(path.join(source, 'index.html'), page('Outside'))
    const made = project.create({ kind: 'directory', path: source }, {})
    writeFileSync(path.join(source, 'index.html'), page('Changed outside'))
    expect(project.status(made.id).revision).toBe(made.entry.revision)
  })

  it('keeps a ZIP lineage and sends a taken id to <id>-<uid prefix>', () => {
    const lineage = '7e2d1c0b-3a4f-4b6e-9d8c-5f4e3d2c1b0a'
    const files = normalize([{ path: 'index.html', bytes: page('Lower') }], 'lower', 1).files
    const zip = path.join(root, 'lower.zip')
    writeFileSync(zip, encodeMotifZip('lower', files, lineage))
    const made = project.create({ kind: 'zip', path: zip }, { lower: { uid: '0b8f6c1e-2d4a-4e5f-8a9b-1c2d3e4f5a6b', revision: null, from: null } })
    expect(made.entry.uid).toBe(lineage)
    expect(made.id).toBe(collisionId('lower', lineage))
  })
})

describe('a project Motif folder as it stands', () => {
  it('is missing without a folder and invalid when its files make no package', () => {
    expect(project.status('gone')).toEqual({ status: 'missing', revision: null })
    mkdirSync(folder('pageless'), { recursive: true })
    writeFileSync(path.join(folder('pageless'), 'style.css'), 'x')
    expect(project.status('pageless')).toMatchObject({ status: 'invalid', revision: null, diagnostic: expect.stringMatching(/index\.html/) })
    mkdirSync(folder('broken'), { recursive: true })
    writeFileSync(path.join(folder('broken'), 'index.html'), page('Broken'))
    writeFileSync(path.join(folder('broken'), 'manifest.json'), '{ not json')
    expect(project.status('broken').status).toBe('invalid')
  })

  it('takes a hand edit as a new revision, keeping its own version, and never rewrites it', () => {
    const made = project.create({ kind: 'empty', name: 'Edited' }, {})
    const json = path.join(folder(made.id), 'manifest.json')
    const edited = JSON.stringify({ ...JSON.parse(readFileSync(json, 'utf8')), name: 'Edited by hand', version: 3 })
    writeFileSync(json, edited)
    const before = readMotifDirectory(folder(made.id))
    const status = project.status(made.id)
    expect(status.status).toBe('ok')
    expect(status.revision).not.toBe(made.entry.revision)
    expect(project.describe(made.id)!.manifest).toMatchObject({ id: made.id, name: 'Edited by hand', version: 3 })
    expect(readMotifDirectory(folder(made.id))).toEqual(before)
  })
})

describe('changing a project Motif', () => {
  const css = (text: string) => new Map([['style.css', Buffer.from(text)]])

  it('writes the change and answers the folder\'s new revision', () => {
    const made = project.create({ kind: 'empty', name: 'Edited' }, {})
    const revision = project.applyChanges(made.id, made.entry.revision!, css('a{}'))
    expect(readFileSync(path.join(folder(made.id), 'style.css'), 'utf8')).toBe('a{}')
    expect(project.status(made.id).revision).toBe(revision)
    expect(revision).not.toBe(made.entry.revision)
  })

  it('refuses a stale revision, writing nothing', () => {
    const made = project.create({ kind: 'empty', name: 'Edited' }, {})
    project.applyChanges(made.id, made.entry.revision!, css('a{}'))
    expect(() => project.applyChanges(made.id, made.entry.revision!, css('b{}'))).toThrow(/revision conflict/)
    expect(readFileSync(path.join(folder(made.id), 'style.css'), 'utf8')).toBe('a{}')
  })

  it('refuses a change that leaves no package, writing nothing', () => {
    const made = project.create({ kind: 'empty', name: 'Edited' }, {})
    const before = readMotifDirectory(folder(made.id))
    expect(() => project.applyChanges(made.id, made.entry.revision!, new Map([['index.html', null], ['style.css', Buffer.from('a{}')]]))).toThrow(/index\.html/)
    expect(readMotifDirectory(folder(made.id))).toEqual(before)
  })

  it('refuses files changed since they were read, writing nothing', () => {
    const made = project.create({ kind: 'empty', name: 'Edited' }, {})
    const dir = folder(made.id)
    const original = readMotifDirectory(dir)
    const stamp = new PackageRevisions().stamp(dir)
    writeFileSync(path.join(dir, 'index.html'), page('Saved meanwhile'))
    expect(() => writeThrough(dir, stamp, original, css('a{}'))).toThrow(/changed/)
    expect(readMotifDirectory(dir).map(f => f.path)).not.toContain('style.css')
  })

  it('puts the written files back when a later step fails', () => {
    const made = project.create({ kind: 'empty', name: 'Edited' }, {})
    const dir = folder(made.id)
    const original = readMotifDirectory(dir)
    const stamp = new PackageRevisions().stamp(dir)
    const changes = new Map([['index.html', page('Replaced')], ['style.css', Buffer.from('a{}')]])
    expect(() => writeThrough(dir, stamp, original, changes, () => { throw new Error('commit failed') })).toThrow(/commit failed/)
    expect(readMotifDirectory(dir)).toEqual(original)
  })
})

describe('revisions seen', () => {
  it('tells the listener each revision with its cause', () => {
    install('lower', 'Lower')
    const seen: [string, string, RevisionCause][] = []
    const stop = project.onRevisionSeen((id, revision, cause) => seen.push([id, revision, cause]))
    const placed = project.place(libraryPackage(library, [], 'lower')!, {})
    const made = project.create({ kind: 'empty', name: 'Mine' }, { lower: placed.entry })
    const edited = project.applyChanges(made.id, made.entry.revision!, new Map([['a.txt', Buffer.from('a')]]))
    project.found('lower')
    project.found('gone')
    stop()
    project.found('lower')
    expect(seen).toEqual([
      ['lower', placed.entry.revision, 'placed'],
      [made.id, made.entry.revision, 'created'],
      [made.id, edited, 'edited-while-open'],
      ['lower', placed.entry.revision, 'opened'],
    ])
  })

  it('hears a folder changed on disk as an edit of the revision it last observed there, never of another', () => {
    const seen: [string, string, RevisionCause, string | null][] = []
    project.onRevisionSeen((id, revision, cause, base) => seen.push([id, revision, cause, base]))
    mkdirSync(folder('card'), { recursive: true })
    writeFileSync(path.join(folder('card'), 'index.html'), page('Found'))
    const found = project.found('card').revision!
    writeFileSync(path.join(folder('card'), 'index.html'), page('Edited on disk'))
    const edited = project.observe('card').revision!
    // Observed again unchanged, it is heard no more.
    project.observe('card')
    writeFileSync(path.join(folder('card'), 'index.html'), page('Edited again'))
    // An update made from the revision read is heard from that one, observed first.
    const again = project.status('card').revision!
    const updated = project.applyChanges('card', again, new Map([['a.txt', Buffer.from('a')]]))
    mkdirSync(folder('fresh'), { recursive: true })
    writeFileSync(path.join(folder('fresh'), 'index.html'), page('Fresh'))
    const fresh = project.observe('fresh').revision!
    expect(seen).toEqual([
      ['card', found, 'opened', null],
      ['card', edited, 'edited-while-open', found],
      ['card', again, 'edited-while-open', edited],
      ['card', updated, 'edited-while-open', again],
      ['fresh', fresh, 'edited-while-open', null],
    ])
  })
})
