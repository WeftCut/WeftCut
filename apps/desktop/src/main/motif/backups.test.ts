import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeMotifHtml } from '../../shared/motifs/catalog'
import { MOTIF_BACKUPS_DIR, MotifBackups } from './backups'
import { declaredPackage } from './motifPackage'
import { readMotifDirectory, type MotifFile } from './packageFiles'
import { PROJECT_MOTIFS_DIR } from './projectStore'

let projectDir: string
let backups: MotifBackups
beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'motif-backups-'))
  backups = new MotifBackups(projectDir)
})
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }) })

const file = (p: string, text: string): MotifFile => ({ path: p, bytes: Buffer.from(text) })
/** A page of Motif `id` whose script says `body`. */
const page = (id: string, body: string) => file('index.html', composeMotifHtml({ id, name: id, version: 1, size: [64, 64], default_duration_s: 1, props_schema: {} },
  `<html><head></head><body><script>motif.define({frame(t){ /* ${body} */ }})</script></body></html>`))
/** `files` with the revision they make as Motif `id`. */
const pkg = (id: string, ...files: MotifFile[]) => ({ files, revision: declaredPackage(files, id).revision })
const record = (id: string, revision: string) => path.join(projectDir, MOTIF_BACKUPS_DIR, id, `${revision}.json`)
const blobs = () => readdirSync(path.join(projectDir, MOTIF_BACKUPS_DIR, '.blobs')).sort()

describe('Motif backups', () => {
  it('keeps bytes shared by revisions once', () => {
    const a = pkg('lower', page('lower', 'one'), file('art.svg', '<svg/>'))
    const b = pkg('lower', page('lower', 'two'), file('art.svg', '<svg/>'))
    const c = pkg('title', page('lower', 'one'))
    backups.backup('lower', a.files, a.revision)
    backups.backup('lower', b.files, b.revision)
    backups.backup('title', c.files, c.revision)
    // Three distinct contents across five files.
    expect(blobs()).toHaveLength(3)
    expect(backups.has('lower', a.revision) && backups.has('lower', b.revision) && backups.has('title', c.revision)).toBe(true)
  })

  it('restores a revision into the project folder, byte for byte, replacing what is there', () => {
    const a = pkg('lower', page('lower', 'one'), file('assets/art.bin', '\u0000ÿ binary'), file('style.css', 'a{}'))
    const b = pkg('lower', page('lower', 'two'))
    backups.backup('lower', a.files, a.revision)
    backups.backup('lower', b.files, b.revision)
    backups.restore('lower', b.revision)
    backups.restore('lower', a.revision)
    const restored = readMotifDirectory(path.join(projectDir, PROJECT_MOTIFS_DIR, 'lower'))
    expect(restored).toEqual([...a.files].sort((x, y) => x.path < y.path ? -1 : 1))
  })

  it('refuses a revision it never kept, changing nothing', () => {
    expect(() => backups.restore('lower', 'a'.repeat(64))).toThrow(/no backup/)
  })

  it('refuses a record whose files make another revision than it names, changing nothing', () => {
    const kept = pkg('lower', page('lower', 'kept'))
    const planted = pkg('lower', page('lower', 'planted'))
    backups.backup('lower', kept.files, kept.revision)
    backups.restore('lower', kept.revision)
    // A received project's record names the kept revision with other bytes.
    backups.backup('lower', planted.files, planted.revision)
    writeFileSync(record('lower', kept.revision), readFileSync(record('lower', planted.revision)))
    expect(() => backups.restore('lower', kept.revision)).toThrow(/other files/)
    expect(() => backups.files('lower', kept.revision)).toThrow(/other files/)
    expect(readMotifDirectory(path.join(projectDir, PROJECT_MOTIFS_DIR, 'lower'))).toEqual(kept.files)
  })

  it('writes over a record that names other files than the revision it is given', () => {
    const kept = pkg('lower', page('lower', 'kept'))
    const planted = pkg('lower', page('lower', 'planted'))
    backups.backup('lower', planted.files, planted.revision)
    writeFileSync(record('lower', kept.revision), readFileSync(record('lower', planted.revision)))
    backups.backup('lower', kept.files, kept.revision)
    expect(backups.files('lower', kept.revision)).toEqual(kept.files)
  })

  it('collects every revision not kept and the bytes only they held', () => {
    const a = pkg('lower', page('lower', 'one'), file('art.svg', '<svg/>'))
    const b = pkg('lower', page('lower', 'two'), file('art.svg', '<svg/>'))
    const c = pkg('title', page('title', 'title'))
    backups.backup('lower', a.files, a.revision)
    backups.backup('lower', b.files, b.revision)
    backups.backup('title', c.files, c.revision)
    backups.gc([['lower', b.revision]])
    expect(backups.has('lower', b.revision)).toBe(true)
    expect(backups.has('lower', a.revision)).toBe(false)
    expect(backups.has('title', c.revision)).toBe(false)
    expect(blobs()).toHaveLength(2)
    backups.restore('lower', b.revision)
    expect(readMotifDirectory(path.join(projectDir, PROJECT_MOTIFS_DIR, 'lower'))).toEqual([file('art.svg', '<svg/>'), b.files[0]])
  })
})
