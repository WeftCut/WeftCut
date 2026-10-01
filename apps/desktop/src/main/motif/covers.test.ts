import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MotifCovers, type CoverSource } from './covers'

let root: string
let source: CoverSource
let version: string
const png = Buffer.from('valid-thumbnail')
const resolve = vi.fn(() => source)
const capture = vi.fn(async () => Buffer.from('full-size-capture'))
const thumbnail = vi.fn(() => png)
const valid = (bytes: Buffer) => bytes.equals(png)
const make = (directory = root) => new MotifCovers(directory, { resolve, capture, thumbnail, valid, renderVersion: () => version })
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'motif-cover-'))
  source = { contentHash: 'package-a', manifest: {
    id: 'badge', name: 'Badge', version: 1, size: [1920, 1080], default_duration_s: 5,
    content_duration_s: 1, settle_rafs: 3, props_schema: { title: { type: 'string', default: 'Hello' } },
  } }
  version = 'runtime-a'
  vi.clearAllMocks()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('Motif covers', () => {
  it('coalesces requests and reuses actual pixels in a new service instance', async () => {
    const covers = make()
    const [a, b] = await Promise.all([covers.get('badge', 'package-a'), covers.get('badge', 'package-a')])
    expect(a).toEqual(png); expect(b).toEqual(png)
    expect(capture).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledWith({
      motifId: 'badge', contentHash: 'package-a', width: 1920, height: 1080,
      propsJson: '{"title":"Hello"}', tSec: 1, settleRafs: 3, fpsNum: 30, fpsDen: 1,
    })
    expect(thumbnail).toHaveBeenCalledWith(Buffer.from('full-size-capture'))
    expect(await make().get('badge', 'package-a')).toEqual(png)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('replaces one slot for package and rendering changes, never accumulating edit versions', async () => {
    await make().get('badge', 'package-a')
    source = { ...source, contentHash: 'asset-only-edit' }
    await make().get('badge', 'asset-only-edit')
    version = 'runtime-b'
    await make().get('badge', 'asset-only-edit')
    expect(capture).toHaveBeenCalledTimes(3)
    expect(await readdir(root)).toHaveLength(1)
  })

  it('rejects stale catalog requests without rendering and does not persist a capture edited in flight', async () => {
    const covers = make()
    await expect(covers.get('badge', 'old-hash')).rejects.toThrow(/changed/)
    expect(capture).not.toHaveBeenCalled()
    capture.mockImplementationOnce(async () => { source = { ...source, contentHash: 'new' }; return png })
    await expect(covers.get('badge', 'package-a')).rejects.toThrow(/changed/)
    expect(await readdir(root)).toEqual([])
    await expect(covers.get('badge', 'new')).resolves.toEqual(png)
  })

  it('recovers from corrupt metadata, corrupt PNG bytes and failed captures', async () => {
    await make().get('badge', 'package-a')
    const file = path.join(root, (await readdir(root))[0]!)
    const saved = JSON.parse(await readFile(file, 'utf8')) as { key: string; png: string }
    await writeFile(file, JSON.stringify({ ...saved, png: 'invalid' }))
    await make().get('badge', 'package-a')
    await writeFile(file, '{broken')
    const covers = make()
    capture.mockRejectedValueOnce(new Error('capture failed'))
    await expect(covers.get('badge', 'package-a')).rejects.toThrow('capture failed')
    await expect(covers.get('badge', 'package-a')).resolves.toEqual(png)
    expect(capture).toHaveBeenCalledTimes(4)
  })

  it('returns the image when persistence is unavailable', async () => {
    const file = path.join(root, 'not-a-directory')
    await writeFile(file, 'occupied')
    await expect(make(file).get('badge', 'package-a')).resolves.toEqual(png)
  })

  it('does not serve deleted sources and reclaims only owned cache slots on startup', async () => {
    await make().get('badge', 'package-a')
    const slot = (await readdir(root))[0]!
    await writeFile(path.join(root, `${slot}.1234-abcd.tmp`), 'interrupted')
    await writeFile(path.join(root, 'unrelated.txt'), 'keep')
    await make().prune(['badge'])
    expect((await readdir(root)).sort()).toEqual([slot, 'unrelated.txt'].sort())
    resolve.mockImplementationOnce(() => { throw new Error('unknown motif') })
    await expect(make().get('badge', 'package-a')).rejects.toThrow('unknown motif')
    await make().prune([])
    expect(await readdir(root)).toEqual(['unrelated.txt'])
  })
})
