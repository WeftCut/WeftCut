// One in-memory POSIX disk behind every file seam the open and Save As paths
// use: the orchestrator's text files, the pool's stats and the project
// content copies. Files are inodes, so a hard link shares bytes
// and times with its source. Times are whole milliseconds from a counter that
// moves on every write, never the wall clock.
import path from 'node:path'
import { constants } from 'node:fs'
import type { OrchestratorFs } from '../../workspace-orchestrator'
import type { ProjectContentFs } from '../../projectContent'
import type { FileStat } from '../../poolFiles'
import { errno } from './memAtomicIo'

interface Inode { data: string; atimeMs: number; mtimeMs: number }
type Entry = { kind: 'dir' } | { kind: 'symlink'; target: string } | { kind: 'file'; inode: Inode }

export interface MemDisk {
  entries: Map<string, Entry>
  /** Writes a file (creating its folders) with the given mtime in seconds. */
  put(p: string, data: string, mtimeSecs?: number): void
  read(p: string): string | undefined
  files(): string[]
  /** Whether `a` and `b` are one inode. */
  linked(a: string, b: string): boolean
  mtimeMs(p: string): number | undefined
  /** Make the next calls of an operation fail: the clone (copyFile with
   *  COPYFILE_FICLONE_FORCE), the hard link, or the byte copy of a source
   *  `when` picks. */
  refuse: { clone?: string; link?: string; copy?: (src: string) => string | null }
  /** Every content-fs call, in order: `clone`, `link`, `copy`, `utimes`. */
  log: string[]
  fs: OrchestratorFs & { copyFile(src: string, dst: string): void; readdir(dir: string): string[]; rename(a: string, b: string): void }
  contentFs: ProjectContentFs
  poolFs: { stat(p: string): FileStat | null; statAsync(p: string): Promise<FileStat | null> }
}

export function memDisk(): MemDisk {
  const entries = new Map<string, Entry>([['/', { kind: 'dir' }]])
  let clock = 1_000_000
  const tick = () => (clock += 1000)
  const norm = (p: string) => path.posix.resolve(p)
  const file = (p: string) => { const e = entries.get(norm(p)); return e?.kind === 'file' ? e : undefined }
  const mkdirp = (d: string) => {
    for (let cur = norm(d); !entries.has(cur); cur = path.posix.dirname(cur)) entries.set(cur, { kind: 'dir' })
  }
  const requireParent = (p: string) => {
    if (entries.get(path.posix.dirname(norm(p)))?.kind !== 'dir') throw errno('ENOENT')
  }
  const children = (d: string) => {
    const dir = norm(d)
    return [...entries.keys()].filter(k => k !== dir && path.posix.dirname(k) === dir).map(k => path.posix.basename(k))
  }
  const newFile = (p: string, data: string, mtimeMs = tick()) => {
    entries.set(norm(p), { kind: 'file', inode: { data, atimeMs: mtimeMs, mtimeMs } })
  }
  const remove = (p: string) => {
    const root = norm(p)
    for (const k of [...entries.keys()]) if (k === root || k.startsWith(`${root}/`)) entries.delete(k)
  }
  const rename = (a: string, b: string) => {
    const from = norm(a), to = norm(b)
    if (!entries.has(from)) throw errno('ENOENT')
    requireParent(to)
    for (const [k, e] of [...entries]) {
      if (k !== from && !k.startsWith(`${from}/`)) continue
      entries.delete(k)
      entries.set(to + k.slice(from.length), e)
    }
  }
  const stat = (p: string): FileStat | null => {
    const e = file(p)
    return e ? { size: e.inode.data.length, mtimeSecs: Math.floor(e.inode.mtimeMs / 1000) } : null
  }
  const log: string[] = []
  const refuse: MemDisk['refuse'] = {}

  const contentFs: ProjectContentFs = {
    lstat: async (p) => {
      const e = entries.get(norm(p))
      if (!e) throw errno('ENOENT')
      const times = e.kind === 'file' ? e.inode : { atimeMs: 0, mtimeMs: 0 }
      return { isFile: () => e.kind === 'file', isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'symlink', ...times }
    },
    readdir: async (d) => {
      if (entries.get(norm(d))?.kind !== 'dir') throw errno('ENOTDIR')
      return children(d)
    },
    mkdir: async (d) => { mkdirp(d) },
    copyFile: async (src, dst, mode = 0) => {
      const clone = (mode & constants.COPYFILE_FICLONE_FORCE) !== 0
      log.push(clone ? 'clone' : 'copy')
      if (clone && refuse.clone) throw errno(refuse.clone)
      const failure = clone ? null : refuse.copy?.(src)
      if (failure) throw errno(failure)
      const e = file(src)
      if (!e) throw errno('ENOENT')
      requireParent(dst)
      // Into the file already there, as an open with O_TRUNC writes.
      const there = file(dst)
      if (there) { there.inode.data = e.inode.data; there.inode.mtimeMs = tick() } else newFile(dst, e.inode.data)
    },
    link: async (src, dst) => {
      log.push('link')
      if (refuse.link) throw errno(refuse.link)
      const e = file(src)
      if (!e) throw errno('ENOENT')
      if (entries.has(norm(dst))) throw errno('EEXIST')
      requireParent(dst)
      entries.set(norm(dst), e)
    },
    utimes: async (p, atime, mtime) => {
      log.push('utimes')
      const e = file(p)
      if (!e) throw errno('ENOENT')
      e.inode.atimeMs = atime * 1000
      e.inode.mtimeMs = mtime * 1000
    },
    rename: async (a, b) => rename(a, b),
    rm: async (p) => remove(p),
    realpath: async (p) => {
      if (!entries.has(norm(p))) throw errno('ENOENT')
      return norm(p)
    },
  }

  return {
    entries, refuse, log, contentFs,
    put: (p, data, mtimeSecs) => { mkdirp(path.posix.dirname(p)); newFile(p, data, mtimeSecs === undefined ? undefined : mtimeSecs * 1000) },
    read: (p) => file(p)?.inode.data,
    files: () => [...entries].filter(([, e]) => e.kind === 'file').map(([k]) => k),
    linked: (a, b) => { const x = file(a), y = file(b); return !!x && x.inode === y?.inode },
    mtimeMs: (p) => file(p)?.inode.mtimeMs,
    fs: {
      exists: (p) => entries.has(norm(p)),
      readFile: (p) => { const e = file(p); if (!e) throw errno('ENOENT'); return e.inode.data },
      writeFile: (p, t) => { mkdirp(path.posix.dirname(p)); newFile(p, t) },
      mkdirp,
      rm: (p) => { const e = file(p); if (e) entries.delete(norm(p)) },
      copyFile: (s, d) => { const e = file(s); if (!e) throw errno('ENOENT'); newFile(d, e.inode.data) },
      readdir: (d) => children(d),
      rename,
    },
    poolFs: { stat, statAsync: async (p) => stat(p) },
  }
}
