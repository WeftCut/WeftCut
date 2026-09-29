import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readMotifDirectory, readMotifFile } from './packageFiles'

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
})
