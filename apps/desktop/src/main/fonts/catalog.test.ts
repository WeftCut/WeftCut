// @vitest-environment node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { resolveFace } from '../../shared/fonts/resolve.js'
import { STAMP_SETTLE_MS } from '../motif/packageRevisions.js'
import { FontCatalog, systemFontDirs } from './catalog.js'
import { hasGlyph, readFaces, readIdentity } from './sfnt.js'
import { cmapFormat12, cmapTable, faceTables, font, ttc } from './testing/syntheticFonts.js'

// Every hash the catalog takes goes through here, so a test can tell that
// none was taken.
vi.mock('node:crypto', async importOriginal => {
  const crypto = await importOriginal<typeof import('node:crypto')>()
  return { ...crypto, createHash: vi.fn(crypto.createHash) }
})

let root: string
let systemDir: string
let projectDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-font-catalog-'))
  systemDir = path.join(root, 'system')
  projectDir = path.join(root, 'project', 'Fonts')
  fs.mkdirSync(path.join(systemDir, 'nested'), { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function write(dir: string, name: string, bytes: Buffer): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, bytes)
  return file
}

async function scanned(): Promise<FontCatalog> {
  const catalog = new FontCatalog({ systemDirs: [systemDir] })
  await catalog.scanSystem()
  return catalog
}

describe('system scan', () => {
  it('indexes Regular and Bold of one family as two faces', async () => {
    write(systemDir, 'Example-Regular.ttf', font({ family: 'Example', weight: 400 }))
    write(path.join(systemDir, 'nested'), 'Example-Bold.otf', font({ family: 'Example', weight: 700 }))
    const { faces } = (await scanned()).index()
    expect(faces.map(f => f.weight).sort()).toEqual([400, 700])
    expect(resolveFace(faces, 'Example', 700, false)?.weight).toBe(700)
    expect(resolveFace(faces, 'Example', 400, false)?.weight).toBe(400)
  })

  it('finds a SemiBold face by its typographic family and by its legacy name', async () => {
    write(systemDir, 'Example-SemiBold.ttf', font({ family: 'Example SemiBold', typographicFamily: 'Example', subfamily: 'SemiBold', weight: 600 }))
    const { faces } = (await scanned()).index()
    const byTypographic = resolveFace(faces, 'Example', 600, false)
    expect(byTypographic?.weight).toBe(600)
    expect(resolveFace(faces, 'Example SemiBold', 400, false)).toEqual(byTypographic)
  })

  it('indexes every face of a collection under its own key', async () => {
    write(systemDir, 'Pair.ttc', ttc([faceTables({ family: 'Pair', weight: 400 }), faceTables({ family: 'Pair', weight: 700, italic: true })]))
    const { faces } = (await scanned()).index()
    expect(faces.map(f => [f.ttcIndex, f.weight, f.italic])).toEqual([[0, 400, false], [1, 700, true]])
    expect(new Set(faces.map(f => f.sha256)).size).toBe(2)
  })

  it('serves a collection face as a standalone font of that face', async () => {
    write(systemDir, 'Pair.ttc', ttc([faceTables({ family: 'Pair', weight: 400 }), faceTables({ family: 'Pair', weight: 700 })]))
    const catalog = await scanned()
    const bold = catalog.index().faces.find(f => f.weight === 700)!
    const bytes = (await catalog.faceBytes(bold.sha256))!
    const faces = readFaces(bytes)
    expect(faces.map(f => f.ttcIndex)).toEqual([null])
    expect(readIdentity(faces[0]!)).toEqual({ families: bold.families, weight: bold.weight, italic: bold.italic })
  })

  it('a file changed on disk since the scan serves no bytes', async () => {
    const file = write(systemDir, 'Example.ttf', font({ family: 'Example' }))
    const catalog = await scanned()
    const [entry] = catalog.index().faces
    expect(await catalog.faceBytes(entry!.sha256)).toEqual(fs.readFileSync(file))
    fs.writeFileSync(file, font({ family: 'Example', weight: 500 }))
    expect(await catalog.faceBytes(entry!.sha256)).toBeNull()
    fs.rmSync(file)
    expect(await catalog.faceBytes(entry!.sha256)).toBeNull()
    expect(await catalog.faceBytes('unknown')).toBeNull()
  })

  it('reads the coverage of a face on demand', async () => {
    const cmap = cmapTable([{ platform: 3, encoding: 10, data: cmapFormat12([{ start: 0x4e00, end: 0x4e2d, glyph: 1 }]) }])
    write(systemDir, 'Han.ttc', ttc([faceTables({ family: 'Han Fallback' }), faceTables({ family: 'Han', cmap })]))
    const catalog = await scanned()
    const han = catalog.index().faces.find(f => f.families.includes('Han'))!
    const coverage = (await catalog.faceCoverage(han.sha256))!
    expect(hasGlyph(coverage, 0x4e2d)).toBe(true)
    expect(hasGlyph(coverage, 0x41)).toBe(false)
  })

  it('shares one scan between concurrent callers and skips unreadable files', async () => {
    write(systemDir, 'Example.ttf', font({ family: 'Example' }))
    write(systemDir, 'broken.ttf', Buffer.from('not a font'))
    write(systemDir, 'notes.txt', font({ family: 'Not A Font File' }))
    const catalog = new FontCatalog({ systemDirs: [systemDir, path.join(root, 'missing')] })
    const readdir = vi.spyOn(fs.promises, 'readdir')
    await Promise.all([catalog.scanSystem(), catalog.scanSystem()])
    await catalog.scanSystem()
    const dirsRead = readdir.mock.calls.map(([dir]) => String(dir))
    expect(new Set(dirsRead).size).toBe(dirsRead.length)
    expect(catalog.listFamilies()).toEqual(['Example'])
    expect(catalog.index().complete).toBe(true)
  })

  it('lists each face family once, sorted, without bundled families', async () => {
    write(systemDir, 'b1.ttf', font({ family: 'Beta' }))
    write(systemDir, 'b2.ttf', font({ family: 'beta', weight: 700 }))
    write(systemDir, 'a.ttf', font({ family: 'Alpha SemiBold', typographicFamily: 'Alpha', weight: 600 }))
    write(systemDir, 'bundled.ttf', font({ family: 'Liberation Sans' }))
    const catalog = await scanned()
    write(projectDir, 'c.ttf', font({ family: 'Gamma' }))
    catalog.setProjectDir(projectDir)
    await catalog.rescanProject()
    expect(catalog.listFamilies()).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})

describe('project fonts', () => {
  it('a project face wins over a system face of the same identity', async () => {
    write(systemDir, 'Example.ttf', font({ family: 'Example', weight: 400 }))
    const projectFile = write(projectDir, 'Example.ttf', font({ family: 'Example', weight: 400, typographicFamily: 'Example' }))
    const catalog = await scanned()
    catalog.setProjectDir(projectDir)
    await catalog.rescanProject()
    const picked = resolveFace(catalog.index().faces, 'Example', 400, false)!
    expect(picked.source).toBe('project')
    expect(catalog.faceFile(picked.sha256)).toEqual({ file: projectFile, ttcIndex: null })
  })

  it('ignores dot-files, partial copies and subfolders', async () => {
    write(projectDir, '.Hidden.ttf', font({ family: 'Hidden' }))
    write(projectDir, '.Example.ttf.1234.part', font({ family: 'Temp' }))
    write(projectDir, 'Example.ttf.part', font({ family: 'Partial' }))
    fs.mkdirSync(path.join(projectDir, 'sub'))
    write(path.join(projectDir, 'sub'), 'Nested.ttf', font({ family: 'Nested' }))
    write(projectDir, 'Kept.otf', font({ family: 'Kept' }))
    const catalog = new FontCatalog({ systemDirs: [] })
    catalog.setProjectDir(projectDir)
    await catalog.rescanProject()
    expect(catalog.index().faces.map(f => f.families[0])).toEqual(['Kept'])
  })

  it('is not complete from pointing at a project folder until its first scan lands, even an empty one', async () => {
    const catalog = await scanned()
    expect(catalog.index().complete).toBe(true)
    catalog.setProjectDir(projectDir)
    const pointed = catalog.index()
    expect(pointed.complete).toBe(false)
    await catalog.rescanProject()
    expect(catalog.index()).toMatchObject({ complete: true, faces: [] })
    expect(catalog.index().revision).toBeGreaterThan(pointed.revision)
    catalog.setProjectDir(null)
    expect(catalog.index().complete).toBe(true)
  })

  it('the revision moves when the face set changes and only then', async () => {
    write(projectDir, 'A.ttf', font({ family: 'A' }))
    const catalog = new FontCatalog({ systemDirs: [] })
    catalog.setProjectDir(projectDir)
    await catalog.rescanProject()
    const first = catalog.index().revision
    await catalog.rescanProject()
    expect(catalog.index().revision).toBe(first)
    write(projectDir, 'B.ttf', font({ family: 'B' }))
    await catalog.rescanProject()
    expect(catalog.index().revision).toBeGreaterThan(first)
  })

  it('a rescan overtaken by a later one resolves once the later folder state has landed', async () => {
    write(projectDir, 'A.ttf', font({ family: 'A' }))
    const catalog = new FontCatalog({ systemDirs: [] })
    catalog.setProjectDir(projectDir)
    const first = catalog.rescanProject()
    write(projectDir, 'B.ttf', font({ family: 'B' }))
    void catalog.rescanProject()
    await first
    expect(catalog.index().faces.map(f => f.families[0]).sort()).toEqual(['A', 'B'])
  })

  it("switching projects drops the old project's faces, even from a scan still running", async () => {
    write(projectDir, 'Old.ttf', font({ family: 'Old' }))
    const catalog = new FontCatalog({ systemDirs: [] })
    catalog.setProjectDir(projectDir)
    const stale = catalog.rescanProject()
    catalog.setProjectDir(null)
    await stale
    expect(catalog.index().faces).toEqual([])
  })
})

describe('file records', () => {
  /** A clock past the settle window of every file the test wrote. */
  const settledClock = (): number => Date.now() + STAMP_SETTLE_MS + 1000
  /** A clock at the moment `file` was last written: its stamp has not settled. */
  const writtenClock = (file: string) => {
    const s = fs.statSync(file)
    return () => Math.max(s.mtimeMs, s.ctimeMs)
  }
  const recordFile = () => path.join(root, 'cache', 'font-records.json')
  const systemCatalog = (now: () => number) =>
    new FontCatalog({ systemDirs: [systemDir], recordFile: recordFile(), generation: 'test', now })
  const reads = (spy: MockInstance, file: string) => spy.mock.calls.filter(([p]) => String(p) === file).length

  it('a second catalog on the same record file indexes an unchanged file without reading or hashing it', async () => {
    const file = write(systemDir, 'Pair.ttc', ttc([faceTables({ family: 'Pair', weight: 400 }), faceTables({ family: 'Pair', weight: 700 })]))
    const first = systemCatalog(settledClock)
    await first.scanSystem()
    const open = vi.spyOn(fs.promises, 'open')
    const readFile = vi.spyOn(fs.promises, 'readFile')
    vi.mocked(createHash).mockClear()
    const second = systemCatalog(settledClock)
    await second.scanSystem()
    expect(second.index().faces).toEqual(first.index().faces)
    expect(reads(open, file) + reads(readFile, file)).toBe(0)
    expect(createHash).not.toHaveBeenCalled()
  })

  it('a record of another generation is not believed', async () => {
    const file = write(systemDir, 'Example.ttf', font({ family: 'Example' }))
    await systemCatalog(settledClock).scanSystem()
    const open = vi.spyOn(fs.promises, 'open')
    await new FontCatalog({ systemDirs: [systemDir], recordFile: recordFile(), generation: 'other', now: settledClock }).scanSystem()
    expect(reads(open, file)).toBe(1)
  })

  it('a stamp within the settle window is neither recorded nor believed', async () => {
    const file = write(systemDir, 'Example.ttf', font({ family: 'Example' }))
    const open = vi.spyOn(fs.promises, 'open')
    await systemCatalog(writtenClock(file)).scanSystem()
    await systemCatalog(settledClock).scanSystem()
    expect(reads(open, file), 'an unsettled stamp leaves no record').toBe(2)
    await systemCatalog(writtenClock(file)).scanSystem()
    expect(reads(open, file), 'a recorded stamp that has not settled is read again').toBe(3)
  })

  it('a project file whose stamp changed is read and hashed once, under a new key', async () => {
    const file = write(projectDir, 'A.ttf', font({ family: 'A', weight: 400 }))
    const catalog = new FontCatalog({ systemDirs: [], now: settledClock })
    catalog.setProjectDir(projectDir)
    await catalog.rescanProject()
    const before = catalog.index()
    fs.writeFileSync(file, font({ family: 'A', weight: 500 }))
    const open = vi.spyOn(fs.promises, 'open')
    await catalog.rescanProject()
    await catalog.rescanProject()
    expect(reads(open, file)).toBe(1)
    const after = catalog.index()
    expect(after.faces[0]!.sha256).not.toBe(before.faces[0]!.sha256)
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  it('serves a face of an unchanged file without hashing it, and no bytes once the file changed', async () => {
    const cmap = cmapTable([{ platform: 3, encoding: 10, data: cmapFormat12([{ start: 0x41, end: 0x5a, glyph: 1 }]) }])
    const file = write(systemDir, 'Pair.ttc', ttc([faceTables({ family: 'Pair', weight: 400 }), faceTables({ family: 'Pair', weight: 700, cmap })]))
    const catalog = new FontCatalog({ systemDirs: [systemDir], now: settledClock })
    await catalog.scanSystem()
    const bold = catalog.index().faces.find(f => f.weight === 700)!
    vi.mocked(createHash).mockClear()
    const bytes = (await catalog.faceBytes(bold.sha256))!
    expect(readIdentity(readFaces(bytes)[0]!)?.weight).toBe(700)
    expect(hasGlyph((await catalog.faceCoverage(bold.sha256))!, 0x41)).toBe(true)
    expect(createHash).not.toHaveBeenCalled()
    fs.writeFileSync(file, font({ family: 'Pair', weight: 700 }))
    expect(await catalog.faceBytes(bold.sha256)).toBeNull()
  })
})

describe('systemFontDirs', () => {
  it('WEFTCUT_E2E_FONT_DIRS replaces the platform directories in E2E builds only', () => {
    const dirs = [path.join(root, 'a'), path.join(root, 'b')]
    vi.stubEnv('WEFTCUT_E2E_FONT_DIRS', dirs.join(path.delimiter))
    vi.stubEnv('WEFTCUT_E2E_BUILD', '1')
    expect(systemFontDirs()).toEqual(dirs)
    vi.stubEnv('WEFTCUT_E2E_BUILD', '0')
    expect(systemFontDirs()).not.toEqual(dirs)
  })
})
