// The font face catalog: every face of every font file in the system font
// directories and in the open project's `Fonts/`, keyed by face, not family.
// Owns scanning, the index the renderer reads, and the bytes of one face.
// Matching a request to a face is ../../shared/fonts/resolve.ts. Free of
// Electron so it runs under unit tests. Not part of the cross-OS determinism
// contract for system faces: different machines, different files.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isBundledFamily } from '../../shared/fonts/resolve.js'
import type { FaceRecord, FaceSource, FontIndex } from '../../shared/fonts/types.js'
import { STAMP_SETTLE_MS } from '../motif/packageRevisions.js'
import { type Coverage, type FaceIdentity, extractFace, readCoverage, readFace, readFaces, readIdentity } from './sfnt.js'

const FONT_DIRS: Record<string, string[]> = {
  win32: [
    path.join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts'),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'),
  ],
  darwin: [
    '/System/Library/Fonts',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library/Fonts'),
  ],
  linux: [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local/share/fonts'),
  ],
}

/** WOFF/WOFF2 are left out: their tables are compressed. */
const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i

/** The directories the system scan walks. In E2E builds only,
 *  `WEFTCUT_E2E_FONT_DIRS` (a `path.delimiter` list) replaces the platform
 *  directories, so a spec controls which fonts count as installed. A
 *  production build folds the flag to '0' (electron.vite.config.ts). */
export function systemFontDirs(): string[] {
  const e2eDirs = process.env.WEFTCUT_E2E_BUILD === '1' ? process.env.WEFTCUT_E2E_FONT_DIRS : undefined
  if (e2eDirs) return e2eDirs.split(path.delimiter).filter(Boolean)
  return FONT_DIRS[process.platform] ?? []
}

/** A font file on disk without its bytes. Times are nanoseconds and `ino` the
 *  file id (0 where the file system has none), as decimal strings: a `bigint`
 *  does not survive JSON. */
interface FontStamp { size: number; mtimeNs: string; ctimeNs: string; ino: string }

/** One face a font file holds: its key and identity. */
interface FileFace extends FaceIdentity { sha256: string; ttcIndex: number | null }

/** What a font file's bytes came to: the file's SHA-256 and its readable faces. */
interface FileFaces { fileSha: string; faces: FileFace[] }

interface FileRecord extends FileFaces { stamp: FontStamp }

interface Entry {
  record: FaceRecord
  /** SHA-256 of the whole file, checked when the bytes are served by a file
   *  that no longer shows `stamp`. */
  fileSha: string
  /** The settled stamp the file was indexed under, or null when its bytes
   *  belong to no settled stamp and are hashed on every serve. */
  stamp: FontStamp | null
}

export interface FontCatalogOptions {
  /** Directories the system scan walks; `systemFontDirs()` by default. */
  systemDirs?: readonly string[]
  /** Keeps the system files' records across launches; without one they last
   *  the process. */
  recordFile?: string
  /** Names the code that derived the records (the app version): a record file
   *  of another generation is dropped, so a release that reads fonts
   *  differently reads every file once. */
  generation?: string
  /** The clock a stamp is judged settled by. */
  now?: () => number
}

/** One per app. The system scan runs once; the project's faces are replaced
 *  by each `rescanProject`. A project face and a system face with the same
 *  key serve the same bytes, so `faceFile` may answer either. A file is read
 *  and hashed only when it does not show its recorded stamp: ADR 0164's rule,
 *  applied to font files (`FileRecords`). */
export class FontCatalog {
  readonly #systemDirs: readonly string[]
  readonly #now: () => number
  #system: Entry[] = []
  #systemScan: Promise<void> | null = null
  #systemScanned = false
  readonly #systemRecords: FileRecords
  /** Project files' records last the process only: reopening a project reads
   *  its `Fonts/` once, which holds only the faces it collected, and no record
   *  of this machine's stamps is written into a folder that travels. */
  readonly #projectRecords = new FileRecords(null, '')
  #projectDir: string | null = null
  #project: Entry[] = []
  /** Bumped by every project switch; a scan that finds it moved since it
   *  started drops its result. */
  #projectGeneration = 0
  #projectScan: Promise<void> | null = null
  #projectScanWanted = false
  #revision = 0
  #bySha = new Map<string, Entry>()
  #coverage = new Map<string, Coverage>()

  constructor(options: FontCatalogOptions = {}) {
    this.#systemDirs = options.systemDirs ?? systemFontDirs()
    this.#now = options.now ?? Date.now
    this.#systemRecords = new FileRecords(options.recordFile ?? null, options.generation ?? '')
  }

  /** Scan the system font directories. One lazy, in-flight-inclusive scan: every
   *  caller shares it, and its result lasts until the app restarts. */
  scanSystem(): Promise<void> {
    return this.#systemScan ??= this.#scanSystem().catch((error: unknown) => {
      this.#systemScan = null
      throw error
    })
  }

  async #scanSystem(): Promise<void> {
    const files: string[] = []
    for (const dir of this.#systemDirs) {
      for await (const file of walk(dir)) if (FONT_FILE.test(file)) files.push(file)
    }
    await this.#systemRecords.load()
    this.#system = await this.#indexFiles(files, 'system', this.#systemRecords)
    this.#systemRecords.retain(files)
    await this.#systemRecords.save()
    this.#systemScanned = true
    this.#changed()
  }

  /** Point the project source at `dir` (the project's `Fonts/`), or at none.
   *  Drops the previous project's faces at once; `rescanProject` reads the
   *  new ones. */
  setProjectDir(dir: string | null): void {
    if (dir === this.#projectDir) return
    this.#projectDir = dir
    this.#projectGeneration++
    if (this.#project.length) {
      this.#project = []
      this.#changed()
    }
  }

  /** Re-read the project directory's top level. Dot-files (temp copies among
   *  them) are ignored, and so is `*.part`: FONT_FILE wants a font extension.
   *  Scans run one at a time; calls made while one runs share one promise,
   *  which resolves once a scan started after the last of them has landed, so
   *  no caller resumes on an index older than the folder at its call. The
   *  revision moves only when the set of faces or their files changed. */
  rescanProject(): Promise<void> {
    this.#projectScanWanted = true
    return this.#projectScan ??= this.#drainProjectScans()
  }

  async #drainProjectScans(): Promise<void> {
    try {
      while (this.#projectScanWanted) {
        this.#projectScanWanted = false
        await this.#scanProject()
      }
    } finally {
      // LANDMINE: cleared here, where no call can land between the last
      // `wanted` check and the clearing. A `.finally()` on the shared promise
      // runs a tick later and would hand a call in that tick a promise that
      // never scans for it.
      this.#projectScan = null
    }
  }

  async #scanProject(): Promise<void> {
    const generation = this.#projectGeneration
    const dir = this.#projectDir
    const files = dir ? await listProjectFonts(dir) : []
    const entries = await this.#indexFiles(files, 'project', this.#projectRecords)
    this.#projectRecords.retain(files)
    if (generation !== this.#projectGeneration) return
    const moved = entriesKey(entries) !== entriesKey(this.#project)
    // Taken even when the faces did not move: the entries carry fresh stamps.
    this.#project = entries
    this.#changed(moved)
  }

  /** The faces without paths, project faces first. */
  index(): FontIndex {
    return {
      revision: this.#revision,
      systemScanned: this.#systemScanned,
      faces: [...this.#project, ...this.#system].map(({ record: { file: _file, ...entry } }) => entry),
    }
  }

  faceFile(sha256: string): { file: string; ttcIndex: number | null } | null {
    const entry = this.#bySha.get(sha256)
    return entry ? { file: entry.record.file, ttcIndex: entry.record.ttcIndex } : null
  }

  /** The face's bytes as a standalone font (a collection face is extracted).
   *  Null when the face is unknown, or its file is gone or no longer holds the
   *  bytes it was indexed with. */
  async faceBytes(sha256: string): Promise<Buffer | null> {
    const entry = this.#bySha.get(sha256)
    const buf = entry ? await readIndexedFile(entry) : null
    if (!entry || !buf) return null
    const { ttcIndex } = entry.record
    return ttcIndex === null ? buf : extractFace(buf, ttcIndex)
  }

  /** The code points the face draws, read on first ask and kept for the
   *  session (a face key names fixed bytes). Null on the same terms as
   *  `faceBytes`, or when the face has no readable `cmap`. */
  async faceCoverage(sha256: string): Promise<Coverage | null> {
    const cached = this.#coverage.get(sha256)
    if (cached) return cached
    const entry = this.#bySha.get(sha256)
    const buf = entry ? await readIndexedFile(entry) : null
    const face = entry && buf ? readFace(buf, entry.record.ttcIndex) : null
    const coverage = face ? readCoverage(face) : null
    if (coverage) this.#coverage.set(sha256, coverage)
    return coverage
  }

  /** Each face's first family name (typographic when the font has one), over
   *  system and project faces, sorted; bundled families left out. */
  listFamilies(): string[] {
    const byKey = new Map<string, string>()
    for (const { record } of [...this.#project, ...this.#system]) {
      const family = record.families[0] as string
      const key = family.toLowerCase()
      if (!byKey.has(key) && !isBundledFamily(family)) byKey.set(key, family)
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b))
  }

  /** Every face of every readable font file, one entry per face key: a file
   *  found twice (the same font in two directories) counts once. */
  async #indexFiles(files: readonly string[], source: FaceSource, records: FileRecords): Promise<Entry[]> {
    const entries: Entry[] = []
    const seen = new Set<string>()
    for (const file of files) {
      const indexed = await this.#indexFile(file, records)
      if (!indexed) continue
      for (const { sha256, ttcIndex, ...identity } of indexed.faces) {
        if (seen.has(sha256)) continue
        seen.add(sha256)
        entries.push({
          fileSha: indexed.fileSha,
          stamp: indexed.stamp,
          record: { ...identity, source, sha256, size: indexed.size, file, ttcIndex },
        })
      }
    }
    return entries
  }

  /** A file's faces: from its record when the file shows the recorded stamp,
   *  settled; else read and hashed once, and recorded when the stamp held
   *  across the read and has settled. Null when the file cannot be read. */
  async #indexFile(file: string, records: FileRecords): Promise<(FileFaces & { stamp: FontStamp | null; size: number }) | null> {
    const takenMs = this.#now()
    const stamp = await stampFile(file)
    if (!stamp) return null
    const known = records.lookup(file, stamp, takenMs)
    if (known) return { ...known, stamp, size: stamp.size }
    const read = await readHashed(file)
    if (!read) {
      records.forget(file)
      return null
    }
    const faces = facesOf(read.buf, read.sha)
    const held = sameStamp(stamp, await stampFile(file)) && settled(stamp, takenMs)
    if (held) records.put(file, { stamp, ...faces })
    else records.forget(file)
    return { ...faces, stamp: held ? stamp : null, size: read.buf.length }
  }

  /** Rebuild the face lookup; `bump` when the face set moved. */
  #changed(bump = true): void {
    if (bump) this.#revision++
    this.#bySha = new Map()
    for (const entry of [...this.#project, ...this.#system]) {
      if (!this.#bySha.has(entry.record.sha256)) this.#bySha.set(entry.record.sha256, entry)
    }
  }
}

/** What font files' bytes came to, keyed by path and believed while a file
 *  shows the recorded stamp. Derived data: with a `file` the records last
 *  across launches, written whole and atomically, and a file of another
 *  `generation` is dropped. A missing, unreadable or unwritable file costs
 *  reads, never an error. */
class FileRecords {
  readonly #entries = new Map<string, FileRecord>()
  #loaded: Promise<void> | null = null
  #dirty = false

  constructor(
    private readonly file: string | null,
    private readonly generation: string,
  ) {}

  load(): Promise<void> {
    return this.#loaded ??= this.#load()
  }

  async #load(): Promise<void> {
    if (!this.file) return
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as { generation?: unknown; files?: unknown }
      if (saved.generation !== this.generation || !saved.files || typeof saved.files !== 'object') return
      for (const [file, record] of Object.entries(saved.files as Record<string, unknown>)) {
        if (isFileRecord(record)) this.#entries.set(file, record)
      }
    } catch { /* Absent or unreadable: every file is read once. */ }
  }

  /** The faces recorded for `file` when it shows exactly `stamp` and that
   *  stamp has settled by `takenMs`, else null. */
  lookup(file: string, stamp: FontStamp, takenMs: number): FileFaces | null {
    const record = this.#entries.get(file)
    return record && sameStamp(record.stamp, stamp) && settled(stamp, takenMs)
      ? { fileSha: record.fileSha, faces: record.faces }
      : null
  }

  /** `record.stamp` must be settled and the one its bytes were read under. */
  put(file: string, record: FileRecord): void {
    this.#entries.set(file, record)
    this.#dirty = true
  }

  forget(file: string): void {
    if (this.#entries.delete(file)) this.#dirty = true
  }

  /** Drop the records of every file not in `files`. */
  retain(files: readonly string[]): void {
    const kept = new Set(files)
    for (const file of [...this.#entries.keys()]) if (!kept.has(file)) this.forget(file)
  }

  async save(): Promise<void> {
    if (!this.file || !this.#dirty) return
    this.#dirty = false
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      await fs.promises.writeFile(temp, JSON.stringify({ generation: this.generation, files: Object.fromEntries(this.#entries) }))
      await fs.promises.rename(temp, this.file)
    } catch {
      await fs.promises.rm(temp, { force: true }).catch(() => {})
    }
  }
}

const DECIMAL = /^\d+$/

function isFileRecord(value: unknown): value is FileRecord {
  const r = value as Partial<FileRecord> | null
  const s = r?.stamp
  return !!r && !!s && typeof s.size === 'number'
    && [s.mtimeNs, s.ctimeNs, s.ino].every(v => typeof v === 'string' && DECIMAL.test(v))
    && typeof r.fileSha === 'string' && Array.isArray(r.faces) && r.faces.every(isFileFace)
}

function isFileFace(value: unknown): value is FileFace {
  const f = value as Partial<FileFace> | null
  const weight = f?.weight as unknown
  return !!f && typeof f.sha256 === 'string'
    && (f.ttcIndex === null || Number.isInteger(f.ttcIndex))
    && Array.isArray(f.families) && f.families.length > 0 && f.families.every(n => typeof n === 'string')
    && (typeof weight === 'number' || (Array.isArray(weight) && weight.length === 2 && weight.every(w => typeof w === 'number')))
    && typeof f.italic === 'boolean'
}

async function stampFile(file: string): Promise<FontStamp | null> {
  try {
    const s = await fs.promises.stat(file, { bigint: true })
    if (!s.isFile()) return null
    return { size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), ino: String(s.ino) }
  } catch {
    return null
  }
}

function sameStamp(a: FontStamp | null, b: FontStamp | null): boolean {
  return !!a && !!b && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino
}

/** Whether a stamp taken at `takenMs` may be believed: a file modified or
 *  changed less than `STAMP_SETTLE_MS` before can change again without its
 *  times moving (ADR 0164). */
function settled(stamp: FontStamp, takenMs: number): boolean {
  const limitNs = BigInt(Math.floor(takenMs - STAMP_SETTLE_MS)) * 1_000_000n
  return BigInt(stamp.mtimeNs) <= limitNs && BigInt(stamp.ctimeNs) <= limitNs
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The readable faces of a font file's bytes, keyed per `FaceRecord.sha256`. */
function facesOf(buf: Buffer, fileSha: string): FileFaces {
  const faces: FileFace[] = []
  for (const face of readFaces(buf)) {
    const identity = readIdentity(face)
    if (!identity) continue
    const sha256 = face.ttcIndex === null ? fileSha : sha256Hex(`${fileSha}#${face.ttcIndex}`)
    faces.push({ ...identity, sha256, ttcIndex: face.ttcIndex })
  }
  return { fileSha, faces }
}

/** Bytes read and hashed per step: each step returns to the event loop, so a
 *  collection of tens of megabytes never holds the main process for long. */
const HASH_CHUNK = 4 * 1024 * 1024

/** A file's bytes and their SHA-256, or null when it cannot be read whole. */
async function readHashed(file: string): Promise<{ buf: Buffer; sha: string } | null> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, 'r')
    const { size } = await handle.stat()
    const buf = Buffer.allocUnsafe(size)
    const hash = createHash('sha256')
    let at = 0
    while (at < size) {
      const { bytesRead } = await handle.read(buf, at, Math.min(HASH_CHUNK, size - at), at)
      if (bytesRead === 0) return null
      hash.update(buf.subarray(at, at + bytesRead))
      at += bytesRead
    }
    return { buf, sha: hash.digest('hex') }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The entry's file, or null when it is gone or no longer holds the bytes it
 *  was indexed with (the index is stale until the next scan). A file showing
 *  its indexed stamp before and after the read is served unhashed: the stamp
 *  had settled when it was taken, and times only move forward. */
async function readIndexedFile(entry: Entry): Promise<Buffer | null> {
  const { file } = entry.record
  if (entry.stamp && sameStamp(entry.stamp, await stampFile(file))) {
    const buf = await fs.promises.readFile(file).catch(() => null)
    if (buf && sameStamp(entry.stamp, await stampFile(file))) return buf
  }
  const read = await readHashed(file)
  return read?.sha === entry.fileSha ? read.buf : null
}

function entriesKey(entries: readonly Entry[]): string {
  return entries.map(e => `${e.record.sha256}\0${e.record.file}`).sort().join('\n')
}

async function listProjectFonts(dir: string): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && FONT_FILE.test(e.name))
    .map(e => path.join(dir, e.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  // Sorted so the index order, and with it resolve's tie-break, is stable.
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) yield p
  }
}
