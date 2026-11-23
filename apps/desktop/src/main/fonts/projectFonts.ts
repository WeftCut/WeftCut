// The open project's `Fonts/` folder (ADR 0176): copies the system faces the
// project draws with into it, keeps the exclusion list, and answers Settings >
// Project > Fonts. What counts as a use is ./uses.ts; the face index is
// ./catalog.ts. Free of Electron: the host (index.ts) hands in the file
// system, the trash, the log and the events.

import { randomUUID } from 'node:crypto'
import { foldCase, portableFileName } from '../../shared/projectPath'
import type { FaceIndexEntry, FontCopyProgress, ProjectFontsView } from '../../shared/fonts/types'
import { fontFamilyKey, normalizeExcludedFonts } from '../state/excludedFonts'
import type { Project } from '../state/model'
import type { FontCatalog } from './catalog'
import { readFaces, readIdentity } from './sfnt'
import { fontUseKey, fontUses, type MissingFontUse, type MotifFontManifest } from './uses'

export const FONTS_DIR = 'Fonts'

/** The files the catalog indexes in `Fonts/`; its twin is `FONT_FILE` in
 *  ./catalog.ts. */
const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i

/** Quiet window after the last change to what the project draws before the
 *  uses are walked again: typing changes them on every key. */
export const USE_DEBOUNCE_MS = 500

/** Wait before the one retry of a refused rename. */
export const RENAME_RETRY_MS = 250

/** A copy being written: `.<name>.<uuid>.part`. The catalog skips dot names. */
const PART = /^\..*\.part$/

/** The node:fs/promises calls the store makes; node:fs/promises itself in
 *  production. `stat` rejects for a missing path. */
export interface ProjectFontsFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>
  readdir(dir: string): Promise<string[]>
  readFile(p: string): Promise<Buffer>
  readFile(p: string, encoding: 'utf8'): Promise<string>
  writeFile(p: string, data: Uint8Array | string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(p: string, opts: { force: true }): Promise<void>
  stat(p: string): Promise<unknown>
}

/** A status-log row, in the shape of the host's `emitLog`. */
export interface FontLogEntry {
  level: 'warn'
  category: { kind: 'Project' }
  source: { kind: 'System' }
  message: string
  i18n_key: string
  i18n_args: Record<string, unknown>
  details: Record<string, unknown>
}

export interface ProjectFontStoreDeps {
  catalog: Pick<FontCatalog, 'index' | 'faceFile' | 'faceBytes' | 'faceCoverage' | 'setProjectDir' | 'rescanProject'>
  fs: ProjectFontsFs
  join: (...parts: string[]) => string
  basename: (p: string) => string
  /** Moves a file to the OS trash (`shell.trashItem`). */
  trash: (file: string) => Promise<void>
  /** Writes `settings.excluded_fonts` as an unrecorded settings change; throws
   *  when the project cannot be written now (an export, a replacement). */
  recordExcluded: (list: string[]) => void
  emitLog: (entry: FontLogEntry) => void
  /** `project-fonts:changed`: what Settings > Project > Fonts shows moved. */
  changed: () => void
  /** `fonts:index`: the catalog's face set moved. */
  indexChanged: () => void
  /** `project-fonts:progress`; null when no copy is in flight. */
  progress: (progress: FontCopyProgress | null) => void
  /** Watches `Fonts/` (./watcher.ts). Absent (tests) → nothing watches. */
  watch?: (fontsDir: string, onChange: () => void) => { close(): void }
  uuid?: () => string
  delay?: (ms: number) => Promise<void>
}

/** The project as last published, with the manifests its Motif layers name. */
interface Published { project: Pick<Project, 'compositions' | 'settings'> & { motifs?: Project['motifs'] }; manifest: MotifFontManifest }

/** A face as `Cache/fonts.json` remembers it: first family, weight, italic. */
function identityKey(face: Pick<FaceIndexEntry, 'families' | 'weight' | 'italic'>): string {
  const weight = typeof face.weight === 'number' ? String(face.weight) : `${face.weight[0]}-${face.weight[1]}`
  return `${fontFamilyKey(face.families[0] as string)}\0${weight}\0${face.italic ? 1 : 0}`
}

function familyKeys(face: Pick<FaceIndexEntry, 'families'>): string[] {
  return face.families.map(fontFamilyKey)
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined
}

/** The file name a face is copied under: the source file's own name, or for a
 *  face taken out of a collection, its family, weight and style with the
 *  extension its outlines want. */
function copyName(face: FaceIndexEntry, source: { file: string; ttcIndex: number | null } | null, bytes: Uint8Array, basename: (p: string) => string): string {
  if (source && source.ttcIndex === null) return basename(source.file)
  const cff = bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f // 'OTTO'
  const weight = typeof face.weight === 'number' ? String(face.weight) : `${face.weight[0]}-${face.weight[1]}`
  return `${face.families[0] as string}-${weight}${face.italic ? '-Italic' : ''}.${cff ? 'otf' : 'ttf'}`
}

export class ProjectFontStore {
  readonly #deps: ProjectFontStoreDeps
  #dir: string | null = null
  /** Bumped when the project folder changes: work started for another
   *  folder stops at its next step. */
  #generation = 0
  /** Set by `drain` until `projectChanged`: no batch is asked for. */
  #refusing = false
  /** A trigger arrived while refusing or debouncing; run once allowed. */
  #missed = false
  /** The next batch first cleans up and indexes the folder just opened. */
  #opening = false
  #published: Published | null = null
  #useKey: string | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #again = false
  /** A batch asked for since the last one started may copy; one asked for
   *  by `rescan` only walks. */
  #copyAsked = false
  #inflight: Promise<unknown> | null = null
  #progress: { done: number; total: number } | null = null
  #closing = false
  #missing: MissingFontUse[] = []
  #reportedMissing = new Set<string>()
  /** Family keys Allow copying asked for: their copies log nothing. */
  #quiet = new Set<string>()
  /** Family keys `exclude` took out since the folder opened, read with the
   *  published list: the exclusion's publish may land after a copy starts. */
  #excluding = new Set<string>()
  /** Face identities seen in `Fonts/` (`Cache/fonts.json`); null until read
   *  for the open folder. */
  #memory: Set<string> | null = null
  #toldRevision = -1
  #watcher: { close(): void } | null = null

  constructor(deps: ProjectFontStoreDeps) {
    this.#deps = deps
  }

  /** The project as just published. Walks the uses again, after the quiet
   *  window, only when what they depend on moved (`fontUseKey`). */
  published(project: Published['project'], manifest: MotifFontManifest): void {
    this.#published = { project, manifest }
    const key = fontUseKey(project)
    if (key === this.#useKey) return
    this.#useKey = key
    this.#schedule()
  }

  /** The open project's folder after a replacement settled (`null`: none).
   *  Lifts `drain`'s refusal. A new folder is cleaned of stale `.part` files,
   *  indexed and reconciled at once; the same folder catches up on what
   *  arrived while refused. */
  projectChanged(dir: string | null): void {
    this.#refusing = false
    if (dir === this.#dir) {
      if (this.#missed) this.#kick()
      return
    }
    this.#generation++
    this.#clearTimer()
    this.#watcher?.close()
    this.#watcher = null
    this.#dir = dir
    this.#missed = false
    this.#useKey = null
    this.#missing = []
    this.#reportedMissing.clear()
    this.#quiet.clear()
    this.#excluding.clear()
    this.#memory = null
    if (dir === null) this.#published = null
    this.#deps.catalog.setProjectDir(dir === null ? null : this.#fontsDir(dir))
    this.#tellIndex()
    if (dir !== null) {
      this.#watcher = this.#deps.watch?.(this.#fontsDir(dir), () => { void this.rescan() }) ?? null
      this.#opening = true
      this.#kick()
    }
    this.#deps.changed()
  }

  /** The system scan landed: faces that were not known may now be copied. */
  systemScanned(): void {
    this.#tellIndex()
    this.#kick()
  }

  /** Finishes the batch under way and any already asked for, the one an
   *  edit's quiet window still holds included, then refuses new ones until
   *  `projectChanged`. Never rejects. */
  drain(): Promise<void> {
    // The last edit's uses are collected before the folder is let go.
    if (this.#timer) this.#kick()
    this.#refusing = true
    const running = this.#running
    if (!running) return Promise.resolve()
    this.#closing = true
    if (this.#progress) this.#emitProgress()
    return running.finally(() => { this.#closing = false })
  }

  /** Resolves once no batch runs. */
  async settled(): Promise<void> {
    while (this.#running) await this.#running
  }

  /** Families the open project asks for that resolve nowhere, as of the last
   *  walk; empty until the system scan has landed. */
  missing(): MissingFontUse[] {
    return this.#missing
  }

  /** `Fonts/` changed on disk: index it again, tell, and walk the uses again
   *  so `missing` follows the folder. Never copies: a face deleted by hand
   *  comes back at the next open or change to what the project draws, not
   *  while a sync may still be writing the folder. */
  async rescan(): Promise<void> {
    if (this.#dir === null) return
    await this.#rescan(this.#generation)
    this.#deps.changed()
    this.#kick(false)
  }

  view(): ProjectFontsView | null {
    if (this.#dir === null) return null
    const { faces } = this.#deps.catalog.index()
    const copied = new Map<string, { family: string; files: Map<string, number> }>()
    for (const face of faces) {
      if (face.source !== 'project') continue
      const family = face.families[0] as string
      const key = fontFamilyKey(family)
      const entry = copied.get(key) ?? { family, files: new Map<string, number>() }
      copied.set(key, entry)
      entry.files.set(this.#deps.catalog.faceFile(face.sha256)?.file ?? face.sha256, face.size)
    }
    const installed = (family: string) => {
      const key = fontFamilyKey(family)
      return faces.some(f => f.source === 'system' && familyKeys(f).includes(key))
    }
    return {
      dir: this.#fontsDir(this.#dir),
      copied: [...copied.values()]
        .map(({ family, files }) => ({ family, files: files.size, bytes: [...files.values()].reduce((a, b) => a + b, 0) }))
        .sort((a, b) => a.family.localeCompare(b.family)),
      excluded: this.#excludedList().map(family => ({ family, installed: installed(family) })),
    }
  }

  /** Adds `family` to the exclusion list, then moves every file of it in
   *  `Fonts/` to the OS trash. No copy of it starts once this is called; one
   *  already in flight finishes first, and the files are found by reading the
   *  folder, since the catalog's index may predate that copy. */
  async exclude(family: string): Promise<ProjectFontsView | null> {
    if (this.#dir === null) return null
    const generation = this.#generation
    const key = fontFamilyKey(family.trim())
    this.#excluding.add(key)
    this.#deps.recordExcluded(normalizeExcludedFonts([...this.#excludedList(), family]))
    await this.#inflight?.catch(() => {})
    if (generation !== this.#generation || this.#dir === null) return this.view()
    for (const file of await this.#filesOf(this.#fontsDir(this.#dir), key)) {
      try { await this.#deps.trash(file) }
      catch (error) { console.warn('[fonts] could not move an excluded font to the trash', file, error) }
    }
    await this.#rescan(generation)
    this.#deps.changed()
    return this.view()
  }

  /** Takes `family` off the exclusion list and copies what the project draws
   *  with of it at once, without a log line: the user asked for it. */
  async allow(family: string): Promise<ProjectFontsView | null> {
    if (this.#dir === null) return null
    const key = fontFamilyKey(family.trim())
    this.#excluding.delete(key)
    this.#deps.recordExcluded(this.#excludedList().filter(f => fontFamilyKey(f) !== key))
    this.#quiet.add(key)
    this.#kick()
    await this.settled()
    this.#deps.changed()
    return this.view()
  }

  #excludedList(): string[] {
    return this.#published?.project.settings.excluded_fonts ?? []
  }

  /** The font files in `fontsDir` with a face answering to family `key`, as
   *  their own name tables say. */
  async #filesOf(fontsDir: string, key: string): Promise<string[]> {
    const out: string[] = []
    for (const name of await this.#readdir(fontsDir)) {
      if (name.startsWith('.') || !FONT_FILE.test(name)) continue
      const file = this.#deps.join(fontsDir, name)
      let bytes: Buffer
      try { bytes = await this.#deps.fs.readFile(file) } catch { continue }
      if (readFaces(bytes).some(face => readIdentity(face)?.families.some(f => fontFamilyKey(f) === key))) out.push(file)
    }
    return out
  }

  #fontsDir(dir: string): string {
    return this.#deps.join(dir, FONTS_DIR)
  }

  #clearTimer(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
  }

  #schedule(): void {
    if (this.#refusing || this.#dir === null) { this.#missed = true; return }
    this.#clearTimer()
    this.#timer = setTimeout(() => { this.#timer = null; this.#kick() }, USE_DEBOUNCE_MS)
  }

  /** Starts a batch now, or one more after the batch under way. `copy`
   *  false: the batch walks the uses but copies nothing, unless a copying
   *  batch was asked for too. */
  #kick(copy = true): void {
    if (copy) this.#clearTimer()
    if (this.#refusing || this.#dir === null) { this.#missed = true; return }
    if (copy) { this.#missed = false; this.#copyAsked = true }
    if (this.#running) { this.#again = true; return }
    const run = async () => {
      try {
        do {
          this.#again = false
          const copying = this.#copyAsked
          this.#copyAsked = false
          await this.#batch(copying)
        } while (this.#again)
      } finally { this.#running = null }
    }
    this.#running = run()
  }

  #tellIndex(): void {
    const { revision } = this.#deps.catalog.index()
    if (revision === this.#toldRevision) return
    this.#toldRevision = revision
    this.#deps.indexChanged()
  }

  /** One reconcile: walk the uses, note what is missing, and with `copy`,
   *  copy what is not in `Fonts/`. Never throws. */
  async #batch(copy: boolean): Promise<void> {
    const generation = this.#generation
    const dir = this.#dir
    if (dir === null) return
    const fontsDir = this.#fontsDir(dir)
    let quiet: ReadonlySet<string> = new Set()
    try {
      if (this.#opening) {
        this.#opening = false
        await this.#open(dir, generation)
      }
      // Read with `published`, in one synchronous step: `allow` publishes the
      // shorter list and marks the family quiet in one step too, so a walk
      // that sees the family allowed also sees its copy as asked for.
      if (copy) quiet = new Set(this.#quiet)
      const published = this.#published
      if (!published || generation !== this.#generation) return
      const index = this.#deps.catalog.index()
      const uses = await fontUses({
        project: published.project, faces: index.faces, motifManifest: published.manifest,
        coverage: (sha) => this.#deps.catalog.faceCoverage(sha),
      })
      if (generation !== this.#generation) return
      this.#noteMissing(index.systemScanned ? uses.missing : [])
      const bySha = new Map(index.faces.map(f => [f.sha256, f]))
      const planned = uses.collect.map(sha => bySha.get(sha)).filter((f): f is FaceIndexEntry => !!f)
      if (copy && planned.length > 0) await this.#copyAll(planned, fontsDir, generation, quiet)
    } catch (error) {
      console.warn('[fonts] project font reconcile failed', error)
    } finally {
      for (const key of quiet) this.#quiet.delete(key)
    }
  }

  /** A folder just opened: drop copies an earlier session left unfinished,
   *  read what this machine remembers of the folder, index it. */
  async #open(dir: string, generation: number): Promise<void> {
    const fontsDir = this.#fontsDir(dir)
    for (const name of await this.#readdir(fontsDir)) {
      if (PART.test(name)) await this.#deps.fs.rm(this.#deps.join(fontsDir, name), { force: true }).catch(() => {})
    }
    const memory = await this.#loadMemory(dir)
    if (generation !== this.#generation) return
    this.#memory = memory
    await this.#rescan(generation)
  }

  async #readdir(dir: string): Promise<string[]> {
    try { return await this.#deps.fs.readdir(dir) } catch { return [] }
  }

  #memoryFile(dir: string): string {
    return this.#deps.join(dir, 'Cache', 'fonts.json')
  }

  async #loadMemory(dir: string): Promise<Set<string>> {
    try {
      const parsed = JSON.parse(await this.#deps.fs.readFile(this.#memoryFile(dir), 'utf8')) as { faces?: unknown }
      return new Set(Array.isArray(parsed.faces) ? parsed.faces.filter((f): f is string => typeof f === 'string') : [])
    } catch {
      return new Set()
    }
  }

  /** Re-index `Fonts/`, tell a moved index, and remember the faces it holds. */
  async #rescan(generation: number): Promise<void> {
    await this.#deps.catalog.rescanProject()
    if (generation !== this.#generation) return
    this.#tellIndex()
    const memory = this.#memory
    const dir = this.#dir
    if (!memory || dir === null) return
    let grew = false
    for (const face of this.#deps.catalog.index().faces) {
      if (face.source !== 'project') continue
      const key = identityKey(face)
      if (!memory.has(key)) { memory.add(key); grew = true }
    }
    if (!grew) return
    try {
      await this.#deps.fs.mkdir(this.#deps.join(dir, 'Cache'), { recursive: true })
      await this.#deps.fs.writeFile(this.#memoryFile(dir), JSON.stringify({ faces: [...memory].sort() }))
    } catch (error) {
      console.warn('[fonts] could not write Cache/fonts.json', error)
    }
  }

  #emitProgress(): void {
    const p = this.#progress
    this.#deps.progress(p ? { ...p, closing: this.#closing } : null)
  }

  #excludedNow(face: FaceIndexEntry): boolean {
    const excluded = new Set([...this.#excludedList().map(fontFamilyKey), ...this.#excluding])
    return familyKeys(face).some(k => excluded.has(k))
  }

  async #copyAll(planned: readonly FaceIndexEntry[], fontsDir: string, generation: number, quiet: ReadonlySet<string>): Promise<void> {
    const copied: FaceIndexEntry[] = []
    this.#progress = { done: 0, total: planned.length }
    this.#emitProgress()
    try {
      await this.#deps.fs.mkdir(fontsDir, { recursive: true })
      const taken = new Set((await this.#readdir(fontsDir)).map(foldCase))
      for (const face of planned) {
        if (generation !== this.#generation) break
        if (!this.#excludedNow(face)) {
          const copy = this.#copyOne(face, fontsDir, taken)
          this.#inflight = copy
          try { if (await copy) copied.push(face) } finally { this.#inflight = null }
        }
        this.#progress = { done: this.#progress.done + 1, total: planned.length }
        this.#emitProgress()
      }
    } finally {
      this.#progress = null
      this.#emitProgress()
    }
    if (generation !== this.#generation || copied.length === 0) return
    // Read before the rescan below remembers what was just copied.
    const remembered = new Set(this.#memory ?? [])
    await this.#rescan(generation)
    // A family excluded while the batch ran is being trashed: not a copy.
    this.#logCopies(copied.filter(face => !this.#excludedNow(face)), remembered, quiet)
    this.#deps.changed()
  }

  /** Writes one face as `.part`, then renames it to a free portable name.
   *  Resolves to whether the face is now in `Fonts/`. */
  async #copyOne(face: FaceIndexEntry, fontsDir: string, taken: Set<string>): Promise<boolean> {
    const { fs, join } = this.#deps
    const bytes = await this.#deps.catalog.faceBytes(face.sha256)
    if (!bytes) return false
    const wanted = copyName(face, this.#deps.catalog.faceFile(face.sha256), bytes, this.#deps.basename)
    let name = portableFileName(wanted, f => taken.has(f))
    const part = join(fontsDir, `.${name}.${(this.#deps.uuid ?? randomUUID)()}.part`)
    try {
      await fs.writeFile(part, bytes)
      // A file that took the name meanwhile keeps it; the copy takes the next.
      while (await fs.stat(join(fontsDir, name)).then(() => true, () => false)) {
        taken.add(foldCase(name))
        name = portableFileName(wanted, f => taken.has(f))
      }
      taken.add(foldCase(name))
      await this.#rename(part, join(fontsDir, name))
      return true
    } catch (error) {
      // LANDMINE: a rename refused twice (EBUSY/EPERM: on Windows an antivirus
      // or indexer holds the new file) leaves the `.part`, which the next open
      // deletes; removing it now would be refused the same way.
      const busy = errorCode(error) === 'EBUSY' || errorCode(error) === 'EPERM'
      if (!busy) await fs.rm(part, { force: true }).catch(() => {})
      console.warn('[fonts] could not copy a font into Fonts/', name, error)
      return false
    }
  }

  async #rename(from: string, to: string): Promise<void> {
    try { await this.#deps.fs.rename(from, to) }
    catch (error) {
      const code = errorCode(error)
      if (code !== 'EBUSY' && code !== 'EPERM') throw error
      await (this.#deps.delay ?? ((ms) => new Promise<void>(r => setTimeout(r, ms))))(RENAME_RETRY_MS)
      await this.#deps.fs.rename(from, to)
    }
  }

  /** One line for the families this batch copied for the first time, one per
   *  family copied again after it went missing; none for Allow copying. */
  #logCopies(copied: readonly FaceIndexEntry[], remembered: ReadonlySet<string>, quiet: ReadonlySet<string>): void {
    const first = new Map<string, string>()
    const again = new Map<string, string>()
    for (const face of copied) {
      if (familyKeys(face).some(k => quiet.has(k))) continue
      const family = face.families[0] as string
      const key = fontFamilyKey(family)
      if (remembered.has(identityKey(face))) { if (!first.has(key)) again.set(key, family) }
      else { first.set(key, family); again.delete(key) }
    }
    if (first.size > 0) {
      const names = [...first.values()]
      const more = Math.max(0, names.length - 2)
      const listed = names.slice(0, 2)
      this.#log(
        `Copied ${listed.join(', ')}${more ? ` and ${more} more` : ''} into Fonts/. Check their licenses before you share the project folder.`,
        more ? 'log.fonts_copied_more' : 'log.fonts_copied', { names: listed, more },
        { kind: 'FontsCopied', families: names },
      )
    }
    for (const name of again.values()) {
      this.#log(
        `${name} was missing from Fonts/ and was copied again. To keep a font out of the project, exclude it in Settings > Project > Fonts.`,
        'log.font_recopied', { name }, { kind: 'FontRecopied', family: name },
      )
    }
  }

  /** Keeps the walk's missing list, and logs each family the first time one
   *  of its faces is found missing since the folder opened. */
  #noteMissing(missing: MissingFontUse[]): void {
    this.#missing = missing
    const fresh = new Map<string, { family: string; layers: Set<string> }>()
    for (const use of missing) {
      const key = `${fontFamilyKey(use.family)}\0${use.weight}\0${use.italic}`
      if (this.#reportedMissing.has(key)) continue
      this.#reportedMissing.add(key)
      const family = fresh.get(fontFamilyKey(use.family)) ?? { family: use.family, layers: new Set<string>() }
      fresh.set(fontFamilyKey(use.family), family)
      for (const id of use.layer_ids) family.layers.add(id)
    }
    for (const { family, layers } of fresh.values()) {
      this.#log(
        `${family} is not in Fonts/ and not installed on this computer; ${layers.size} layer(s) draw with another font.`,
        'log.fonts_missing', { name: family, layers: layers.size },
        { kind: 'FontsMissing', family, layer_ids: [...layers] },
      )
    }
  }

  #log(message: string, key: string, args: Record<string, unknown>, details: Record<string, unknown>): void {
    try {
      this.#deps.emitLog({ level: 'warn', category: { kind: 'Project' }, source: { kind: 'System' }, message, i18n_key: key, i18n_args: args, details })
    } catch (error) {
      console.warn('[fonts] emitLog failed', error)
    }
  }
}
