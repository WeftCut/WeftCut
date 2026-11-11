// In-memory `AtomicWriteIo` over a path → contents map, with one-shot or
// standing faults per step, so a test can fail an atomic write at the step it
// names and then read what the map holds.
import type { AtomicWriteIo } from '../../../atomicWrite'

type Step = 'open' | 'write' | 'fsync' | 'close' | 'rename'

export interface MemAtomicIo extends AtomicWriteIo {
  files: Map<string, string>
  /** Fails `step` with `error` on its next `times` calls (default: every call). */
  fail(step: Step, error: Error, times?: number): void
  /** Drops every pending fault. */
  heal(): void
  /** Calls per step, in order, for asserting retries and ordering. */
  log: string[]
}

export function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

export function memAtomicIo(files = new Map<string, string>()): MemAtomicIo {
  const faults = new Map<Step, { error: Error; left: number }>()
  const open = new Map<number, string>()
  const log: string[] = []
  let nextFd = 3
  const step = (name: Step) => {
    log.push(name)
    const fault = faults.get(name)
    if (!fault) return
    if (--fault.left <= 0) faults.delete(name)
    throw fault.error
  }
  return {
    files, log,
    fail: (s, error, times = Infinity) => { faults.set(s, { error, left: times }) },
    heal: () => { faults.clear() },
    open: (path) => {
      step('open')
      const fd = nextFd++
      // Truncates on open, as node's 'w' does.
      open.set(fd, path); files.set(path, '')
      return fd
    },
    write: (fd, text) => {
      const path = open.get(fd)!
      // A failed write may already have put part of the text on disk.
      files.set(path, text.slice(0, Math.ceil(text.length / 2)))
      step('write')
      files.set(path, text)
    },
    fsync: () => { step('fsync') },
    close: (fd) => { open.delete(fd); step('close') },
    rename: (from, to) => {
      step('rename')
      const text = files.get(from)
      if (text === undefined) throw errno('ENOENT')
      files.set(to, text); files.delete(from)
    },
    rm: (p) => { log.push('rm'); files.delete(p) },
    pause: () => { log.push('pause') },
  }
}
