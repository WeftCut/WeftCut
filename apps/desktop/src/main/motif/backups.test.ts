import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MOTIF_BACKUPS_DIR, MotifBackups } from './backups'
import { readMotifDirectory, type MotifFile } from './packageFiles'
import { PROJECT_MOTIFS_DIR } from './projectStore'

let projectDir: string
let backups: MotifBackups
beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'motif-backups-'))
  backups = new MotifBackups(projectDir)
})
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }) })

const REV_A = 'a'.repeat(64), REV_B = 'b'.repeat(64), REV_C = 'c'.repeat(64)
const file = (p: string, text: string): MotifFile => ({ path: p, bytes: Buffer.from(text) })
const blobs = () => readdirSync(path.join(projectDir, MOTIF_BACKUPS_DIR, '.blobs')).sort()

describe('Motif backups', () => {
  it('keeps bytes shared by revisions once', () => {
    backups.backup('lower', [file('index.html', 'page one'), file('art.svg', '<svg/>')], REV_A)
    backups.backup('lower', [file('index.html', 'page two'), file('art.svg', '<svg/>')], REV_B)
    backups.backup('title', [file('index.html', 'page one')], REV_C)
    // Three distinct contents across five files.
    expect(blobs()).toHaveLength(3)
    expect(backups.has('lower', REV_A) && backups.has('lower', REV_B) && backups.has('title', REV_C)).toBe(true)
  })

  it('restores a revision into the project folder, byte for byte, replacing what is there', () => {
    const kept = [file('index.html', 'page one'), file('assets/art.bin', '\u0000ÿ binary'), file('style.css', 'a{}')]
    backups.backup('lower', kept, REV_A)
    backups.backup('lower', [file('index.html', 'page two')], REV_B)
    backups.restore('lower', REV_B)
    backups.restore('lower', REV_A)
    const restored = readMotifDirectory(path.join(projectDir, PROJECT_MOTIFS_DIR, 'lower'))
    expect(restored).toEqual([...kept].sort((a, b) => a.path < b.path ? -1 : 1))
  })

  it('refuses a revision it never kept, changing nothing', () => {
    expect(() => backups.restore('lower', REV_A)).toThrow(/no backup/)
  })

  it('collects every revision not kept and the bytes only they held', () => {
    backups.backup('lower', [file('index.html', 'page one'), file('art.svg', '<svg/>')], REV_A)
    backups.backup('lower', [file('index.html', 'page two'), file('art.svg', '<svg/>')], REV_B)
    backups.backup('title', [file('index.html', 'title')], REV_C)
    backups.gc([['lower', REV_B]])
    expect(backups.has('lower', REV_B)).toBe(true)
    expect(backups.has('lower', REV_A)).toBe(false)
    expect(backups.has('title', REV_C)).toBe(false)
    expect(blobs()).toHaveLength(2)
    backups.restore('lower', REV_B)
    expect(readMotifDirectory(path.join(projectDir, PROJECT_MOTIFS_DIR, 'lower')).map(f => f.bytes.toString())).toEqual(['<svg/>', 'page two'])
  })
})
