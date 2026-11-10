import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PackageRevisions, STAMP_SETTLE_MS } from './packageRevisions'

// Runs once after the next whole-directory read, standing in for an editor
// that saves while the app is reading.
let afterRead: (() => void) | null = null
vi.mock('./packageFiles', async importOriginal => {
  const actual = await importOriginal<typeof import('./packageFiles')>()
  return {
    ...actual,
    readMotifDirectory: (root: string) => {
      const files = actual.readMotifDirectory(root)
      const run = afterRead
      afterRead = null
      run?.()
      return files
    },
  }
})

/** A clock far enough ahead that files written by the test have settled. */
const settledClock = () => Date.now() + 2 * STAMP_SETTLE_MS

/** New bytes of the same length, with a modification time no earlier write had. */
function rewrite(file: string, bytes: Buffer): void {
  const earlier = statSync(file).mtimeMs / 1000 - 10
  writeFileSync(file, bytes)
  utimesSync(file, earlier, earlier)
}

let root: string, pkg: string, model: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'motif-revisions-'))
  pkg = path.join(root, 'pkg')
  model = path.join(pkg, 'assets', 'model.glb')
  mkdirSync(path.dirname(model), { recursive: true })
  writeFileSync(path.join(pkg, 'index.html'), '<html/>')
  writeFileSync(model, Buffer.from([1, 2, 3, 4]))
})
afterEach(() => { afterRead = null; rmSync(root, { recursive: true, force: true }) })

describe('package revision records', () => {
  it('answer only for the very files they were recorded for', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    const stamp = revisions.stamp(pkg)
    revisions.record(pkg, stamp, { revision: 'r1' })
    expect(revisions.lookup(pkg, revisions.stamp(pkg))).toEqual({ revision: 'r1' })

    rewrite(model, Buffer.from([4, 3, 2, 1]))
    expect(revisions.lookup(pkg, revisions.stamp(pkg))).toBeNull()
  })

  it('answer for no other directory', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    const stamp = revisions.stamp(pkg)
    revisions.record(pkg, stamp, { revision: 'r1' })
    expect(revisions.lookup(path.join(root, 'other'), stamp)).toBeNull()
  })

  it('are not made of files changed within the settle window', () => {
    const revisions = new PackageRevisions()
    const stamp = revisions.stamp(pkg)
    revisions.record(pkg, stamp, { revision: 'r1' })
    expect(revisions.lookup(pkg, stamp)).toBeNull()
  })

  it('an unsettled stamp also retires the record it would have replaced', () => {
    let ahead = 2 * STAMP_SETTLE_MS
    const revisions = new PackageRevisions(null, '', () => Date.now() + ahead)
    const first = revisions.stamp(pkg)
    revisions.record(pkg, first, { revision: 'r1' })
    ahead = 0
    revisions.record(pkg, revisions.stamp(pkg), { revision: 'r2' })
    expect(revisions.lookup(pkg, first)).toBeNull()
  })

  it('keep a refusal as well as a revision', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    const stamp = revisions.stamp(pkg)
    revisions.record(pkg, stamp, { diagnostic: 'Error: no manifest' })
    expect(revisions.lookup(pkg, stamp)).toEqual({ diagnostic: 'Error: no manifest' })
  })

  it('are dropped for a directory that can no longer be stamped', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    const stamp = revisions.stamp(pkg)
    revisions.record(pkg, stamp, { revision: 'r1' })
    rmSync(pkg, { recursive: true })
    expect(() => revisions.stamp(pkg)).toThrow()
    expect(revisions.lookup(pkg, stamp)).toBeNull()
  })

  it('are forgotten on request', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    const stamp = revisions.stamp(pkg)
    revisions.record(pkg, stamp, { revision: 'r1' })
    revisions.forget(pkg)
    expect(revisions.lookup(pkg, stamp)).toBeNull()
  })
})

describe('reading a package under a stamp', () => {
  it('gives the bytes with the stamp they were read under', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    const { files, stamp } = revisions.read(pkg)
    expect(files.map(f => f.path)).toEqual(['assets/model.glb', 'index.html'])
    expect(stamp?.files.map(f => f.path)).toEqual(['assets/model.glb', 'index.html'])
  })

  it('gives no stamp when a file changed while the bytes were read', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    afterRead = () => rewrite(model, Buffer.from([9, 9, 9, 9]))
    expect(revisions.read(pkg).stamp).toBeNull()
  })

  it('gives no stamp when a file appeared while the bytes were read', () => {
    const revisions = new PackageRevisions(null, '', settledClock)
    afterRead = () => writeFileSync(path.join(pkg, 'late.js'), 'x')
    expect(revisions.read(pkg).stamp).toBeNull()
  })
})

describe('records kept in a file', () => {
  const file = () => path.join(root, 'cache', 'motif-revisions.json')

  it('answer the next launch of the same generation', () => {
    const first = new PackageRevisions(file(), 'gen-1', settledClock)
    first.record(pkg, first.stamp(pkg), { revision: 'r1' })
    const second = new PackageRevisions(file(), 'gen-1', settledClock)
    expect(second.lookup(pkg, second.stamp(pkg))).toEqual({ revision: 'r1' })
  })

  it('do not answer another generation', () => {
    const first = new PackageRevisions(file(), 'gen-1', settledClock)
    first.record(pkg, first.stamp(pkg), { revision: 'r1' })
    const second = new PackageRevisions(file(), 'gen-2', settledClock)
    expect(second.lookup(pkg, second.stamp(pkg))).toBeNull()
  })

  it('read as none when the file is not a record file', () => {
    mkdirSync(path.dirname(file()), { recursive: true })
    for (const text of ['{broken', '[]', JSON.stringify({ generation: 'gen-1', packages: { [pkg]: { files: [{ path: 1 }], outcome: {} } } })]) {
      writeFileSync(file(), text)
      const revisions = new PackageRevisions(file(), 'gen-1', settledClock)
      expect(revisions.lookup(pkg, revisions.stamp(pkg))).toBeNull()
    }
  })

  it('cost nothing but the record when the file cannot be written', () => {
    writeFileSync(path.join(root, 'cache'), 'a file where the folder should be')
    const revisions = new PackageRevisions(file(), 'gen-1', settledClock)
    const stamp = revisions.stamp(pkg)
    expect(() => revisions.record(pkg, stamp, { revision: 'r1' })).not.toThrow()
    expect(revisions.lookup(pkg, stamp)).toEqual({ revision: 'r1' })
  })
})
