import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
