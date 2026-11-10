import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { motifColdStart, type MotifColdStartDeps } from './coldStart'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

/** A closed project with two cached frames and a sibling cache it must keep. */
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-cold-start-test-'))
  roots.push(root)
  fs.writeFileSync(path.join(root, 'project.json'), '{}')
  const hash = path.join(root, 'Cache', 'raster', 'a'.repeat(32))
  fs.mkdirSync(hash, { recursive: true })
  fs.writeFileSync(path.join(hash, '0.wfrm'), Buffer.alloc(100))
  fs.writeFileSync(path.join(hash, '1.wfrm'), Buffer.alloc(28))
  fs.mkdirSync(path.join(root, 'Cache', 'proxy'))
  fs.writeFileSync(path.join(root, 'Cache', 'proxy', 'keep.mp4'), 'x')
  return root
}

function deps(over: Partial<MotifColdStartDeps> = {}): MotifColdStartDeps {
  return { enabled: true, openFolders: () => [null], transitioning: () => false, retireHosts: vi.fn(), log: vi.fn(), ...over }
}

describe('motifColdStart', () => {
  it('retires the hosts and deletes only the raster cache of a closed project', async () => {
    const root = project()
    const d = deps()

    await expect(motifColdStart(root, d)).resolves.toEqual({ files: 2, bytes: 128 })

    expect(d.retireHosts).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(root, 'Cache', 'raster'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'Cache', 'proxy', 'keep.mp4'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'project.json'))).toBe(true)
    expect(d.log).toHaveBeenCalledOnce()
  })

  it('still retires the hosts when nothing is cached', async () => {
    const root = project()
    fs.rmSync(path.join(root, 'Cache', 'raster'), { recursive: true })
    const d = deps()

    await expect(motifColdStart(root, d)).resolves.toEqual({ files: 0, bytes: 0 })
    expect(d.retireHosts).toHaveBeenCalledOnce()
  })

  it.each([
    ['outside a dev build', (root: string) => [root, deps({ enabled: false })] as const],
    ['for a relative folder', () => ['some/project', deps()] as const],
    ['for a folder without project.json', (root: string) => { fs.rmSync(path.join(root, 'project.json')); return [root, deps()] as const }],
    ['for the open project', (root: string) => [root, deps({ openFolders: () => [path.join(root, '.')] })] as const],
    ['while a project opens or closes', (root: string) => [root, deps({ transitioning: () => true })] as const],
  ])('refuses %s and touches nothing', async (_name, setup) => {
    const root = project()
    const [dir, d] = setup(root)

    await expect(motifColdStart(dir, d)).rejects.toThrow()
    expect(d.retireHosts).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'Cache', 'raster', 'a'.repeat(32), '0.wfrm'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('refuses a raster cache that resolves outside the project', async () => {
    const root = project()
    const outside = project()
    fs.rmSync(path.join(root, 'Cache'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'Cache'), path.join(root, 'Cache'))

    const d = deps()
    await expect(motifColdStart(root, d)).rejects.toThrow(/outside the project/)
    expect(d.retireHosts).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(outside, 'Cache', 'raster', 'a'.repeat(32), '0.wfrm'))).toBe(true)
  })
})
