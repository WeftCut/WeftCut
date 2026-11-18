// A project's Motif folders on a case-insensitive, case-preserving file system
// (macOS, Windows), played here on any system: every path under the test root
// resolves its segments as such a file system does, while `readdirSync` names
// each entry as it was written. A folder answers only to its exact name, so a
// table key never reads a folder written in another case (Motif trust).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeMotifHtml } from '../../shared/motifs/catalog'
import { ProjectMotifStore } from './projectStore'
import { MotifResolver } from './resolver'
import { UserMotifStore } from './store'
import { MotifTrust } from './trust'

/** The folder whose paths resolve case-insensitively; none while empty. */
const folded = vi.hoisted(() => ({ root: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const { join, sep } = await import('node:path')
  /** `p` with each segment under the folded root spelled as on disk. */
  const onDisk = (p: unknown): unknown => {
    if (typeof p !== 'string' || !folded.root || !p.startsWith(folded.root + sep)) return p
    let at = folded.root
    for (const segment of p.slice(folded.root.length + 1).split(sep)) {
      let names: string[] = []
      try { names = fs.readdirSync(at) } catch { /* no folder: the segment stays as asked */ }
      at = join(at, names.includes(segment) ? segment : names.find(n => n.toLowerCase() === segment.toLowerCase()) ?? segment)
    }
    return at
  }
  const fold = <F>(f: F): F => ((p: unknown, ...rest: unknown[]) => (f as (...a: unknown[]) => unknown)(onDisk(p), ...rest)) as unknown as F
  const mocked = { ...fs, existsSync: fold(fs.existsSync), lstatSync: fold(fs.lstatSync), statSync: fold(fs.statSync),
    readFileSync: fold(fs.readFileSync), readdirSync: fold(fs.readdirSync) }
  return { ...mocked, default: mocked }
})

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'motif-case-'))
  folded.root = root
})
afterEach(() => {
  folded.root = ''
  rmSync(root, { recursive: true, force: true })
})

const page = (body: string) => composeMotifHtml({ id: 'x', name: 'Evil', version: 1, size: [64, 64], default_duration_s: 1, props_schema: {} },
  `<html><head></head><body><script>motif.define({frame(t){ /* ${body} */ }})</script></body></html>`)

/** A project whose `Motifs/Evil/` holds a package. */
function received(): ProjectMotifStore {
  const project = new ProjectMotifStore(path.join(root, 'Film'))
  mkdirSync(path.join(project.root(), 'Evil'), { recursive: true })
  writeFileSync(path.join(project.root(), 'Evil', 'index.html'), page('received'))
  // The file system answers the lowercase name with the folder, as macOS and Windows do.
  expect(existsSync(path.join(project.root(), 'evil', 'index.html'))).toBe(true)
  return project
}

describe('a Motif folder named in another case than its key', () => {
  it('is read under no other name, and under its own as a name no key can take', () => {
    const project = received()
    expect(project.status('evil')).toEqual({ status: 'missing', revision: null })
    expect(project.describe('evil')).toBeNull()
    expect(project.snapshot('evil')).toBeNull()
    expect(project.readFile('evil', 'index.html')).toBeNull()
    expect(project.status('Evil')).toMatchObject({ status: 'invalid', revision: null, diagnostic: expect.stringMatching(/folder name must be/) })
    expect(() => project.describe('Evil')).toThrow(/folder name must be/)
    expect(project.readFile('Evil', 'index.html')).toBeNull()
  })

  it('is served under neither name, and earns nothing when the project opens', () => {
    const project = received()
    const library = new UserMotifStore(path.join(root, 'library'))
    const trust = new MotifTrust(path.join(root, 'trust.json'), () => [])
    const resolver = new MotifResolver(library, [], trust)
    const causes: string[] = []
    resolver.onRevisionSeen((_id, revision, cause, base) => { causes.push(cause); trust.seen(revision, cause, base) })
    resolver.setProject(project)
    expect(causes).toEqual([])
    expect(resolver.resolve('evil')).toMatchObject({ status: 'missing', revision: null })
    expect(resolver.resolve('Evil')).toMatchObject({ status: 'invalid', revision: null })
    expect(resolver.readFile('evil', 'index.html')).toBeNull()
    expect(resolver.readFile('Evil', 'index.html')).toBeNull()
  })
})
