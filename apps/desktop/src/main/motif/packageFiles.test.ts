import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hasMotifFile, readMotifDirectory, readMotifFile, sameStamps, stampMotifDirectory } from './packageFiles'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'motif-package-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('Motif package boundary', () => {
  it('snapshots binary assets in stable path order and omits private metadata', () => {
    mkdirSync(path.join(root, 'assets'))
    writeFileSync(path.join(root, 'assets', 'mesh.bin'), Buffer.from([0, 255, 17]))
    writeFileSync(path.join(root, 'index.html'), '<html/>')
    writeFileSync(path.join(root, 'target'), 'private')
    const files = readMotifDirectory(root)
    expect(files.map(f => f.path)).toEqual(['assets/mesh.bin', 'index.html'])
    expect(files[0]!.bytes).toEqual(Buffer.from([0, 255, 17]))
    expect(readMotifFile(root, 'target')).toBeNull()
  })

  it('blocks traversal, absolute paths, Windows streams and aliases', () => {
    writeFileSync(path.join(root, 'index.html'), 'valid')
    for (const rel of ['../index.html', '/index.html', 'a\\index.html', 'index.html:stream', 'CON', 'index.html.', 'index.html ']) {
      expect(readMotifFile(root, rel)).toBeNull()
    }
    expect(readMotifFile(root, 'index.html')?.toString()).toBe('valid')
  })

  it('rejects a directory link during import and when serving an existing package', () => {
    const pkg = path.join(root, 'pkg')
    const outside = path.join(root, 'outside')
    mkdirSync(pkg); mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, path.join(pkg, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(readMotifFile(pkg, 'assets/secret.txt')).toBeNull()
    expect(() => readMotifDirectory(pkg)).toThrow(/symbolic links/)
  })

  it('stamps the files a read returns, under the same refusals, without their bytes', () => {
    mkdirSync(path.join(root, 'assets'))
    writeFileSync(path.join(root, 'assets', 'mesh.bin'), Buffer.from([0, 255, 17]))
    writeFileSync(path.join(root, 'index.html'), '<html/>')
    writeFileSync(path.join(root, 'target'), 'private')
    const stamps = stampMotifDirectory(root)
    expect(stamps.map(f => f.path)).toEqual(readMotifDirectory(root).map(f => f.path))
    expect(stamps.map(f => f.size)).toEqual([3, 7])
    expect(sameStamps(stamps, stampMotifDirectory(root))).toBe(true)

    symlinkSync(path.join(root, 'assets'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => stampMotifDirectory(root)).toThrow(/symbolic links/)
  })

  it('a stamp tells a rewritten, an added and a removed file from the files it was taken of', () => {
    const mesh = path.join(root, 'mesh.bin')
    writeFileSync(mesh, Buffer.from([1, 2, 3]))
    const before = stampMotifDirectory(root)

    const earlier = statSync(mesh).mtimeMs / 1000 - 10
    writeFileSync(mesh, Buffer.from([3, 2, 1]))
    utimesSync(mesh, earlier, earlier)
    expect(sameStamps(before, stampMotifDirectory(root)), 'same size, another modification time').toBe(false)

    rmSync(mesh)
    expect(sameStamps(before, stampMotifDirectory(root))).toBe(false)
    writeFileSync(path.join(root, 'other.bin'), Buffer.from([1, 2, 3]))
    expect(sameStamps(before, stampMotifDirectory(root))).toBe(false)
  })

  it('reports presence under the confinement of a read', () => {
    const pkg = path.join(root, 'pkg')
    const outside = path.join(root, 'outside')
    mkdirSync(pkg); mkdirSync(outside)
    writeFileSync(path.join(pkg, 'index.html'), 'valid')
    writeFileSync(path.join(pkg, 'target'), 'private')
    writeFileSync(path.join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, path.join(pkg, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(hasMotifFile(pkg, 'index.html')).toBe(true)
    for (const rel of ['missing.js', 'target', '../outside/secret.txt', 'assets/secret.txt', 'assets'])
      expect(hasMotifFile(pkg, rel), rel).toBe(false)
  })
})
