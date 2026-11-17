import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeMotifHtml } from '../../shared/motifs/catalog'
import { MotifBackups } from './backups'
import { declaredPackage } from './motifPackage'
import { copyProjectMotifs } from './projectCopy'

const roots: string[] = []
function project(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wc-project-copy-'))
  roots.push(dir)
  return dir
}
function write(dir: string, rel: string, text: string): void {
  const file = path.join(dir, ...rel.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('copyProjectMotifs', () => {
  it('copies the named folders whole and nothing else', () => {
    const from = project(), to = project()
    write(from, 'Motifs/title-card/index.html', '<p>title</p>')
    write(from, 'Motifs/title-card/assets/bg.svg', '<svg/>')
    write(from, 'Motifs/untracked/index.html', '<p>left over</p>')
    copyProjectMotifs(from, to, ['title-card'])
    expect(readFileSync(path.join(to, 'Motifs/title-card/index.html'), 'utf8')).toBe('<p>title</p>')
    expect(readFileSync(path.join(to, 'Motifs/title-card/assets/bg.svg'), 'utf8')).toBe('<svg/>')
    expect(existsSync(path.join(to, 'Motifs/untracked'))).toBe(false)
  })

  it('replaces a folder of the same id at the target rather than merging into it', () => {
    const from = project(), to = project()
    write(from, 'Motifs/title-card/index.html', '<p>new</p>')
    write(to, 'Motifs/title-card/index.html', '<p>old</p>')
    write(to, 'Motifs/title-card/stale.js', 'old()')
    copyProjectMotifs(from, to, ['title-card'])
    expect(readFileSync(path.join(to, 'Motifs/title-card/index.html'), 'utf8')).toBe('<p>new</p>')
    expect(existsSync(path.join(to, 'Motifs/title-card/stale.js'))).toBe(false)
  })

  it('skips a Motif missing in the original, which the copy then shows missing too', () => {
    const from = project(), to = project()
    copyProjectMotifs(from, to, ['gone'])
    expect(existsSync(path.join(to, 'Motifs/gone'))).toBe(false)
  })

  it('leaves the folders alone when saving over the same project', () => {
    const dir = project()
    write(dir, 'Motifs/title-card/index.html', '<p>title</p>')
    copyProjectMotifs(dir, dir, ['title-card'])
    expect(readFileSync(path.join(dir, 'Motifs/title-card/index.html'), 'utf8')).toBe('<p>title</p>')
  })
})

describe('copyProjectMotifs onto the same folder under another name', () => {
  it('leaves the folders alone when the target is a link to the original', () => {
    const dir = project()
    write(dir, 'Motifs/title-card/index.html', '<p>title</p>')
    const link = path.join(project(), 'Film')
    symlinkSync(dir, link, 'junction')
    const folder = statSync(path.join(dir, 'Motifs/title-card')).ino
    copyProjectMotifs(dir, link, ['title-card'])
    expect(readFileSync(path.join(dir, 'Motifs/title-card/index.html'), 'utf8')).toBe('<p>title</p>')
    // Not copied over itself: the folder is the one that was there.
    expect(statSync(path.join(dir, 'Motifs/title-card')).ino).toBe(folder)
  })
})

// Unreadable by the owner only where the owner is not exempt from modes.
const modesBind = process.platform !== 'win32' && process.getuid?.() !== 0

describe('a copy that fails', () => {
  it.runIf(modesBind)('keeps the folder the target held', () => {
    const from = project(), to = project()
    write(from, 'Motifs/title-card/index.html', '<p>new</p>')
    write(from, 'Motifs/title-card/locked.js', 'secret()')
    chmodSync(path.join(from, 'Motifs/title-card/locked.js'), 0o000)
    write(to, 'Motifs/title-card/index.html', '<p>old</p>')
    expect(() => copyProjectMotifs(from, to, ['title-card'])).toThrow()
    expect(readFileSync(path.join(to, 'Motifs/title-card/index.html'), 'utf8')).toBe('<p>old</p>')
  })
})

describe('the Motif backups', () => {
  it('go with the folders, so undo in the copy can put a folder back', () => {
    const from = project(), to = project()
    write(from, 'Motifs/title-card/index.html', '<p>title</p>')
    const before = [{ path: 'index.html', bytes: Buffer.from(composeMotifHtml({ id: 'title-card', name: 'Before', version: 1, size: [64, 64], default_duration_s: 1, props_schema: {} },
      '<html><head></head><body><script>motif.define({frame(t){}})</script></body></html>')) }]
    const { revision } = declaredPackage(before, 'title-card')
    new MotifBackups(from).backup('title-card', before, revision)
    copyProjectMotifs(from, to, ['title-card'])
    new MotifBackups(to).restore('title-card', revision)
    expect(readFileSync(path.join(to, 'Motifs/title-card/index.html'))).toEqual(before[0]!.bytes)
  })
})
