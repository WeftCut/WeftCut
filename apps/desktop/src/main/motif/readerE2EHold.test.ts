import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { holdMotifReads, motifReadHoldFrame } from './readerE2EHold'

const file = (frame: number | string) => path.join('workspace', 'Cache', 'raster', 'a'.repeat(32), `${frame}.wfrm`)
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('E2E Motif read hold', () => {
  it('parses only a plain frame number', () => {
    expect(motifReadHoldFrame(undefined)).toBeNull()
    expect(motifReadHoldFrame('')).toBeNull()
    expect(motifReadHoldFrame('-1')).toBeNull()
    expect(motifReadHoldFrame('1.5')).toBeNull()
    expect(motifReadHoldFrame('5000x')).toBeNull()
    expect(motifReadHoldFrame('9'.repeat(16))).toBeNull()
    expect(motifReadHoldFrame('0')).toBe(0)
    expect(motifReadHoldFrame('5000')).toBe(5000)
  })

  it('passes other frames straight through', async () => {
    const read = vi.fn(async (name: string) => name)
    const held = holdMotifReads(read, 5000)
    await expect(held(file(0), 1)).resolves.toBe(file(0))
    await expect(held(file(50000), 2)).resolves.toBe(file(50000))
    await expect(held(path.join('x', '5000.png'), 1)).resolves.toBe(path.join('x', '5000.png'))
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('holds the frame until the next frame number is read, then reads the admitted path', async () => {
    const read = vi.fn(async (name: string, div: number) => `${name}@${div}`)
    const held = holdMotifReads(read, 5000)
    let settled: string | null = null
    const first = held(file(5000), 2).then(value => { settled = value })
    const second = held(path.join('other', '5000.wfrm'), 4)
    await tick()
    expect(settled).toBeNull()
    expect(read).not.toHaveBeenCalled()

    await expect(held(file(5001), 1)).resolves.toBe(`${file(5001)}@1`)
    await first
    expect(settled).toBe(`${file(5000)}@2`)
    await expect(second).resolves.toBe(`${path.join('other', '5000.wfrm')}@4`)

    // A later read of the held frame waits for the next release.
    let later = false
    void held(file(5000), 1).then(() => { later = true })
    await tick()
    expect(later).toBe(false)
  })
})
