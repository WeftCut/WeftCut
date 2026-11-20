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
import { type Coverage, extractFace, readCoverage, readFace, readFaces, readIdentity } from './sfnt.js'

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

interface Entry {
  record: FaceRecord
  /** SHA-256 of the whole file, checked again when the bytes are served. */
  fileSha: string
}

export interface FontCatalogOptions {
  /** Directories the system scan walks; `systemFontDirs()` by default. */
  systemDirs?: readonly string[]
}

/** One per app. The system scan runs once; the project's faces are replaced
 *  by each `rescanProject`. A project face and a system face with the same
 *  key serve the same bytes, so `faceFile` may answer either. */
export class FontCatalog {
  readonly #systemDirs: readonly string[]
  #system: Entry[] = []
  #systemScan: Promise<void> | null = null
  #systemScanned = false
  #projectDir: string | null = null
  #project: Entry[] = []
  /** Bumped by every project switch and rescan; a scan that finds it moved
   *  since it started is superseded and drops its result. */
  #projectGeneration = 0
  #revision = 0
  #bySha = new Map<string, Entry>()
  #coverage = new Map<string, Coverage>()

  constructor(options: FontCatalogOptions = {}) {
    this.#systemDirs = options.systemDirs ?? systemFontDirs()
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
    this.#system = await indexFiles(files, 'system')
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
   *  The latest call wins; the revision moves only when the set of faces or
   *  their files changed. */
  async rescanProject(): Promise<void> {
    const generation = ++this.#projectGeneration
    const dir = this.#projectDir
    const files = dir ? await listProjectFonts(dir) : []
    const entries = await indexFiles(files, 'project')
    if (generation !== this.#projectGeneration) return
    if (entriesKey(entries) === entriesKey(this.#project)) return
    this.#project = entries
    this.#changed()
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

  #changed(): void {
    this.#revision++
    this.#bySha = new Map()
    for (const entry of [...this.#project, ...this.#system]) {
      if (!this.#bySha.has(entry.record.sha256)) this.#bySha.set(entry.record.sha256, entry)
    }
  }
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The entry's file, or null when it is gone or its bytes changed since the
 *  scan (the index is stale until the next scan). */
async function readIndexedFile(entry: Entry): Promise<Buffer | null> {
  try {
    const buf = await fs.promises.readFile(entry.record.file)
    return sha256Hex(buf) === entry.fileSha ? buf : null
  } catch {
    return null
  }
}

/** Every face of every readable font file, one entry per face key: a file
 *  found twice (the same font in two directories) counts once. */
async function indexFiles(files: readonly string[], source: FaceSource): Promise<Entry[]> {
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const file of files) {
    let buf: Buffer
    try {
      buf = await fs.promises.readFile(file)
    } catch {
      continue
    }
    const fileSha = sha256Hex(buf)
    for (const face of readFaces(buf)) {
      const identity = readIdentity(face)
      if (!identity) continue
      const sha256 = face.ttcIndex === null ? fileSha : sha256Hex(`${fileSha}#${face.ttcIndex}`)
      if (seen.has(sha256)) continue
      seen.add(sha256)
      entries.push({ fileSha, record: { ...identity, source, sha256, size: buf.length, file, ttcIndex: face.ttcIndex } })
    }
  }
  return entries
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
