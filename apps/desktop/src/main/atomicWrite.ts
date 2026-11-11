// apps/desktop/src/main/atomicWrite.ts
//
// Whole-file replacement that a crash or a failed write cannot leave half done:
// the target holds either its previous bytes or the complete new text. Owns the
// write → fsync → rename sequence and its temp file; `writeFileAtomic` is pure
// over an injected `AtomicWriteIo`, `nodeAtomicWriteIo` binds it to node:fs.
// The workspace adapter's `writeFile` (project.json, pre-upgrade backups) is
// this function.
import fs from 'node:fs'

/** The file-level steps `writeFileAtomic` composes; node:fs in production. */
export interface AtomicWriteIo {
  /** Creates or truncates the file for writing; returns its descriptor. */
  open(path: string): number
  /** Writes the whole text (UTF-8). */
  write(fd: number, text: string): void
  /** Flushes the file's data to the device. */
  fsync(fd: number): void
  close(fd: number): void
  /** Replaces `to` with `from` in one step (same directory). */
  rename(from: string, to: string): void
  /** Must not throw on a missing file. */
  rm(path: string): void
  /** Blocks the calling thread for `ms`. */
  pause(ms: number): void
}

/** Beside the target, so the rename stays on one volume; a fixed name, so a
 *  temp left by a crash is truncated and renamed away by the next write. Not
 *  `*.json`: nothing that lists a workspace mistakes it for a project or a
 *  backup. */
export const ATOMIC_TEMP_SUFFIX = '.tmp'

/** Rename retry for a target or temp another process holds open. Landmine:
 *  Windows refuses to replace a file opened without FILE_SHARE_DELETE (Defender
 *  and other scanners, the search indexer, sync clients) with
 *  EPERM/EACCES/EBUSY until that handle closes, which is usually within
 *  milliseconds of our own close. The waits block the main thread, so they stay
 *  short and bounded; past them the caller sees the error and the autosave
 *  retries on a later cycle. */
const RENAME_RETRY_PAUSES_MS = [10, 20, 40] as const
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Replaces `path` with `text`. On any failure the previous file stays as it
 *  was, the temp file is removed and the original error is thrown. */
export function writeFileAtomic(io: AtomicWriteIo, path: string, text: string): void {
  const temp = path + ATOMIC_TEMP_SUFFIX
  try {
    const fd = io.open(temp)
    try {
      io.write(fd, text)
      io.fsync(fd)
    } catch (error) {
      try { io.close(fd) } catch { /* the write's error is the one to report */ }
      throw error
    }
    // Not in a finally: a failed close can be the first report of a failed
    // write, so it aborts the replacement too.
    io.close(fd)
    renameWithRetry(io, temp, path)
  } catch (error) {
    try { io.rm(temp) } catch { /* a leftover temp is overwritten by the next write */ }
    throw error
  }
}

function renameWithRetry(io: AtomicWriteIo, from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { io.rename(from, to); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (attempt >= RENAME_RETRY_PAUSES_MS.length || code === undefined || !RENAME_RETRY_CODES.has(code)) throw error
      io.pause(RENAME_RETRY_PAUSES_MS[attempt])
    }
  }
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4))

export const nodeAtomicWriteIo: AtomicWriteIo = {
  open: (p) => fs.openSync(p, 'w'),
  // writeFileSync on a descriptor loops until every byte is written; a bare
  // writeSync may stop short.
  write: (fd, text) => fs.writeFileSync(fd, text, 'utf8'),
  fsync: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  rename: (from, to) => fs.renameSync(from, to),
  rm: (p) => fs.rmSync(p, { force: true }),
  pause: (ms) => { Atomics.wait(pauseCell, 0, 0, ms) },
}
