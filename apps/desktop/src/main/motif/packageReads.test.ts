// Which operations read a package's bytes: an unchanged package is answered
// from its recorded revision (ADR 0164). The reads are observed at `node:fs`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { listMotifsInner, motifRevision } from './authoring'
import { packageContentHash } from './contentHash'
import { readMotifDirectory } from './packageFiles'
import { PackageRevisions, STAMP_SETTLE_MS } from './packageRevisions'
import { UserMotifStore } from './store'
import { MotifWorkspace } from './workspace'

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const spied = vi.fn(fs.readFileSync)
  return { ...fs, readFileSync: spied, default: { ...fs, readFileSync: spied } }
})

const pathsRead = () => vi.mocked(readFileSync).mock.calls.map(call => String(call[0]))
const forgetReads = () => { vi.mocked(readFileSync).mockClear() }

/** A clock far enough ahead that files written by the test have settled. */
const settledClock = () => Date.now() + 2 * STAMP_SETTLE_MS

/** New bytes of the same length, with a modification time no earlier write had. */
function rewrite(file: string, bytes: Buffer): void {
  const earlier = statSync(file).mtimeMs / 1000 - 10
  writeFileSync(file, bytes)
  utimesSync(file, earlier, earlier)
}

const MODEL = Buffer.from([1, 2, 3, 4]), OTHER_MODEL = Buffer.from([4, 3, 2, 1])
const manifest = (id: string): Manifest =>
  ({ id, name: 'Scene', version: 1, size: [64, 64], default_duration_s: 1, fonts: [], props_schema: {} })
const page = (id: string) => composeMotifHtml(manifest(id), '<head></head><body><script>motif.define({setup(){}})</script></body>')

const roots: string[] = []
function temp(): string { const dir = mkdtempSync(path.join(tmpdir(), 'motif-reads-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('an installed package with a model', () => {
  let root: string, model: string
  const install = (store: UserMotifStore) => {
    store.writeDraft('scene', page('scene'))
    store.installDraft('scene', 'scene')
    mkdirSync(path.dirname(model))
    writeFileSync(model, MODEL)
  }
  const listed = (store: UserMotifStore) => listMotifsInner(store, []).find(e => e.id === 'scene')!.content_hash
  beforeEach(() => { root = temp(); model = path.join(root, 'scene', 'assets', 'model.glb') })

  it('is listed again without its model being read, while its files are unchanged', () => {
    const store = new UserMotifStore(root, new PackageRevisions(null, '', settledClock))
    install(store)
    const first = listed(store)
    expect(pathsRead(), 'the first listing hashes the model').toContain(model)

    forgetReads()
    expect(listed(store)).toBe(first)
    expect(pathsRead()).not.toContain(model)
  })

  it('answers its revision to a cover or a read without its model being read', () => {
    const store = new UserMotifStore(root, new PackageRevisions(null, '', settledClock))
    install(store)
    const first = listed(store)

    forgetReads()
    expect(motifRevision(store, [], 'scene')).toBe(first)
    expect(pathsRead()).not.toContain(model)
  })

  it('is read again while its files changed too recently for their times to be trusted', () => {
    const store = new UserMotifStore(root)
    install(store)
    const first = listed(store)

    forgetReads()
    expect(listed(store)).toBe(first)
    expect(pathsRead()).toContain(model)
  })

  it('lists the revision of its new bytes after an edit in the store that keeps every size', () => {
    const store = new UserMotifStore(root, new PackageRevisions(null, '', settledClock))
    install(store)
    const first = listed(store)

    rewrite(model, OTHER_MODEL)
    const second = listed(store)
    expect(second).not.toBe(first)
    expect(second).toBe(packageContentHash(readMotifDirectory(path.join(root, 'scene'))))
  })

  it('lists another revision when a file is added to it or removed', () => {
    const store = new UserMotifStore(root, new PackageRevisions(null, '', settledClock))
    install(store)
    const first = listed(store)

    writeFileSync(path.join(root, 'scene', 'extra.js'), '')
    const withExtra = listed(store)
    expect(withExtra).not.toBe(first)
    rmSync(path.join(root, 'scene', 'extra.js'))
    expect(listed(store)).toBe(first)
  })

  it('is pinned under the revision it lists, before and after an edit in the store', () => {
    const store = new UserMotifStore(root, new PackageRevisions(null, '', settledClock))
    install(store)
    const first = listed(store) as string

    const pin = store.pinPackage('scene', first)
    expect(store.readFile('scene', `.revisions/${first}/assets/model.glb`)).toEqual(MODEL)
    pin!.release()

    rewrite(model, OTHER_MODEL)
    const second = listed(store) as string
    const repinned = store.pinPackage('scene', second)
    expect(store.readFile('scene', `.revisions/${second}/assets/model.glb`)).toEqual(OTHER_MODEL)
    repinned!.release()
  })

  it('is not pinned under a revision its bytes never had', () => {
    const store = new UserMotifStore(root, new PackageRevisions(null, '', settledClock))
    install(store)
    listed(store)
    expect(() => store.pinPackage('scene', 'f'.repeat(64))).toThrow(/revision changed/)
  })
})

describe('a draft linked to a directory with a model', () => {
  let store: UserMotifStore, workspace: MotifWorkspace, directory: string, model: string, id: string
  const row = () => (workspace.list() as Array<{ id: string; revision: string; diagnostic?: string }>).find(e => e.id === id)!
  beforeEach(() => {
    store = new UserMotifStore(temp(), new PackageRevisions(null, '', settledClock))
    workspace = new MotifWorkspace(store, [])
    directory = temp()
    model = path.join(directory, 'assets', 'model.glb')
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ name: 'Scene', size: [64, 64], default_duration_s: 1, props_schema: {} }))
    writeFileSync(path.join(directory, 'index.html'), '<html><body>one</body></html>')
    mkdirSync(path.dirname(model))
    writeFileSync(model, MODEL)
    id = workspace.open({ kind: 'directory', path: directory }).motif_id
  })
  const mirrored = () => path.join(store.root(), 'drafts', id, 'assets', 'model.glb')

  it('is listed without the directory or its package being read, while neither changed', () => {
    const first = row().revision
    forgetReads()
    expect(row().revision).toBe(first)
    expect(pathsRead()).not.toContain(model)
    expect(pathsRead()).not.toContain(mirrored())
  })

  it('takes an edit made in the directory at the next listing', () => {
    const first = row().revision
    rewrite(model, OTHER_MODEL)
    expect(row().revision).not.toBe(first)
    expect(store.readFile(id, 'assets/model.glb')).toEqual(OTHER_MODEL)
  })

  it('keeps reporting a directory that makes no package, without reading it again', () => {
    writeFileSync(path.join(directory, 'manifest.json'), '{broken')
    const diagnostic = row().diagnostic
    expect(diagnostic).toMatch(/JSON/)
    expect(store.readFile(id, 'assets/model.glb'), 'the last valid package stays').toEqual(MODEL)

    forgetReads()
    expect(row().diagnostic).toBe(diagnostic)
    expect(pathsRead()).not.toContain(model)
  })

  it('recovers when the directory makes a package again', () => {
    const good = readFileSync(path.join(directory, 'manifest.json'))
    writeFileSync(path.join(directory, 'manifest.json'), '{broken')
    expect(row().diagnostic).toBeDefined()
    rewrite(path.join(directory, 'manifest.json'), good)
    expect(row().diagnostic).toBeUndefined()
  })

  it('is mirrored again when its package was changed behind the app', () => {
    row()
    rewrite(mirrored(), OTHER_MODEL)
    row()
    expect(store.readFile(id, 'assets/model.glb')).toEqual(MODEL)
  })
})
