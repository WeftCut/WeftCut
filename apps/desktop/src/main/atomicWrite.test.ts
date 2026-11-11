import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ATOMIC_TEMP_SUFFIX, nodeAtomicWriteIo, writeFileAtomic } from './atomicWrite'
import { errno, memAtomicIo } from './state/__tests__/fixtures/memAtomicIo'

const TARGET = '/ws/project.json'
const TEMP = TARGET + ATOMIC_TEMP_SUFFIX
const GOOD = '{"previous":"good"}'
const NEXT = '{"next":"edit"}'

function thrown(fn: () => void): unknown {
  try { fn() } catch (error) { return error }
  throw new Error('expected a throw')
}

describe('writeFileAtomic', () => {
  it('replaces the file with the full text, flushed before the rename, and leaves no temp', () => {
    const io = memAtomicIo(new Map([[TARGET, GOOD]]))
    writeFileAtomic(io, TARGET, NEXT)
    expect(io.files.get(TARGET)).toBe(NEXT)
    expect(io.files.has(TEMP)).toBe(false)
    expect(io.log.indexOf('fsync')).toBeLessThan(io.log.indexOf('close'))
    expect(io.log.indexOf('close')).toBeLessThan(io.log.indexOf('rename'))
  })

  it.each(['open', 'write', 'fsync', 'close', 'rename'] as const)(
    'a failure at %s keeps the previous file exactly, removes the temp and throws the original error',
    (step) => {
      const io = memAtomicIo(new Map([[TARGET, GOOD]]))
      const failure = errno('ENOSPC')
      io.fail(step, failure)
      expect(thrown(() => writeFileAtomic(io, TARGET, NEXT))).toBe(failure)
      expect(io.files.get(TARGET)).toBe(GOOD)
      expect(io.files.has(TEMP)).toBe(false)
    },
  )

  it('a failed write into a folder with no project yet leaves nothing behind', () => {
    const io = memAtomicIo()
    io.fail('rename', errno('ENOSPC'))
    expect(() => writeFileAtomic(io, TARGET, NEXT)).toThrow()
    expect([...io.files.keys()]).toEqual([])
  })

  it('retries a rename refused while another process holds the file, then replaces it', () => {
    const io = memAtomicIo(new Map([[TARGET, GOOD]]))
    io.fail('rename', errno('EPERM'), 1)
    writeFileAtomic(io, TARGET, NEXT)
    expect(io.files.get(TARGET)).toBe(NEXT)
    expect(io.log.filter((s) => s === 'rename').length).toBeGreaterThan(1)
    // The retry waits before trying again.
    expect(io.log.indexOf('pause')).toBeGreaterThan(io.log.indexOf('rename'))
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('gives up on a rename that stays refused (%s), keeping the previous file', (code) => {
    const io = memAtomicIo(new Map([[TARGET, GOOD]]))
    const failure = errno(code)
    io.fail('rename', failure)
    expect(thrown(() => writeFileAtomic(io, TARGET, NEXT))).toBe(failure)
    expect(io.log.filter((s) => s === 'rename').length).toBeGreaterThan(1)
    expect(io.files.get(TARGET)).toBe(GOOD)
    expect(io.files.has(TEMP)).toBe(false)
  })

  it('does not retry a rename failure that waiting cannot fix', () => {
    const io = memAtomicIo(new Map([[TARGET, GOOD]]))
    io.fail('rename', errno('EXDEV'))
    expect(() => writeFileAtomic(io, TARGET, NEXT)).toThrow()
    expect(io.log.filter((s) => s === 'rename')).toHaveLength(1)
    expect(io.log).not.toContain('pause')
  })

  it('overwrites a temp left behind by an interrupted write', () => {
    const io = memAtomicIo(new Map([[TARGET, GOOD], [TEMP, '{"half":']]))
    writeFileAtomic(io, TARGET, NEXT)
    expect(io.files.get(TARGET)).toBe(NEXT)
    expect(io.files.has(TEMP)).toBe(false)
  })
})

describe('nodeAtomicWriteIo', () => {
  let dir: string | null = null
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

  it('replaces a file on disk and leaves only the target in its folder', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'weftcut-atomic-write-'))
    const target = path.join(dir, 'project.json')
    writeFileAtomic(nodeAtomicWriteIo, target, GOOD)
    writeFileAtomic(nodeAtomicWriteIo, target, NEXT)
    expect(readFileSync(target, 'utf8')).toBe(NEXT)
    expect(readdirSync(dir)).toEqual(['project.json'])
  })

  it('throws the original error when the folder is gone, creating nothing', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'weftcut-atomic-write-'))
    const target = path.join(dir, 'missing', 'project.json')
    expect(thrown(() => writeFileAtomic(nodeAtomicWriteIo, target, NEXT))).toMatchObject({ code: 'ENOENT' })
    expect(readdirSync(dir)).toEqual([])
  })
})
