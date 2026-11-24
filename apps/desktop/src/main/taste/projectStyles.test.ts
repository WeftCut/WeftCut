import { afterEach, describe, expect, it, vi } from 'vitest'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { packageHash } from './packages'
import { collectExtendedStyle, styleOutsideProject } from './projectStyles'
import { tasteView, type StyleDirs } from './view'

const BUILTIN = path.join(import.meta.dirname, '../../shared/styles/builtin')
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function temp() { const r = mkdtempSync(path.join(tmpdir(), 'project-styles-')); roots.push(r); return r }
function style(root: string, name: string, size: number) {
  mkdirSync(path.join(root, name, 'parts'), { recursive: true })
  writeFileSync(path.join(root, name, 'STYLE.md'), `---\ntokens: { text: { title: { size_px: ${size} } } }\n---\nprose\n`)
  writeFileSync(path.join(root, name, 'parts', 'notes.txt'), 'kept')
  writeFileSync(path.join(root, name, '.DS_Store'), 'not part of the package')
}
function project(taste: string) {
  const dir = temp()
  writeFileSync(path.join(dir, 'TASTE.md'), taste)
  return dir
}

describe('collectExtendedStyle', () => {
  it('copies the extended user style into Styles/ through a dot-named temp directory renamed into place', async () => {
    const user = temp()
    style(user, 'paper', 40)
    const dirs: StyleDirs = { builtin: BUILTIN, user }
    const pin = packageHash(path.join(user, 'paper')).slice(0, 12)
    const dir = project(`---\nextends: paper@${pin}\n---\n`)
    const renames: Array<[string, string]> = []
    const rename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      renames.push([String(from), String(to)])
      // The destination is absent until the rename: the copy went elsewhere.
      expect(existsSync(String(to))).toBe(false)
      return rename(from, to)
    })

    expect(await collectExtendedStyle(dirs, dir)).toBe('paper')

    const styles = path.join(dir, 'Styles')
    expect(renames).toHaveLength(1)
    expect(path.dirname(renames[0]![0])).toBe(styles)
    expect(path.basename(renames[0]![0])).toMatch(/^\.paper\..+\.part$/)
    expect(renames[0]![1]).toBe(path.join(styles, 'paper'))
    expect(readdirSync(styles)).toEqual(['paper'])
    expect(readFileSync(path.join(styles, 'paper', 'parts', 'notes.txt'), 'utf8')).toBe('kept')
    const v = tasteView(dirs, dir)
    expect(v.style).toMatchObject({ name: 'paper', origin: 'project', pin_matches: true })
  })

  it('keeps a project copy already there, and never copies a built-in', async () => {
    const user = temp()
    style(user, 'paper', 40)
    const dirs: StyleDirs = { builtin: BUILTIN, user }
    const dir = project('---\nextends: paper\n---\n')
    style(path.join(dir, 'Styles'), 'paper', 50)
    expect(await collectExtendedStyle(dirs, dir)).toBeNull()
    expect(tasteView(dirs, dir).tokens.text?.title?.size_px).toBe(50)

    const builtin = project('---\nextends: clipping\n---\n')
    expect(await collectExtendedStyle(dirs, builtin)).toBeNull()
    expect(existsSync(path.join(builtin, 'Styles'))).toBe(false)
  })

  it('removes a temp directory an interrupted copy left behind', async () => {
    const user = temp()
    style(user, 'paper', 40)
    const dir = project('---\nextends: paper\n---\n')
    mkdirSync(path.join(dir, 'Styles', '.paper.stale.part'), { recursive: true })
    expect(await collectExtendedStyle({ builtin: BUILTIN, user }, dir)).toBe('paper')
    expect(readdirSync(path.join(dir, 'Styles'))).toEqual(['paper'])
  })
})

describe('styleOutsideProject', () => {
  it('names a user style TASTE.md extends that the folder does not carry, until it is collected', async () => {
    const user = temp()
    style(user, 'paper', 40)
    const dirs: StyleDirs = { builtin: BUILTIN, user }
    const dir = project('---\nextends: paper\n---\n')
    expect(styleOutsideProject(dirs, dir)).toBe('paper')
    await collectExtendedStyle(dirs, dir)
    expect(styleOutsideProject(dirs, dir)).toBeNull()
  })

  it('names a style that resolves nowhere', () => {
    const dir = project('---\nextends: gone\n---\n')
    expect(styleOutsideProject({ builtin: BUILTIN, user: temp() }, dir)).toBe('gone')
  })

  it('names nothing for a built-in style or a TASTE.md that extends nothing', () => {
    const builtin = readdirSync(BUILTIN).find(n => !n.startsWith('.'))!
    const dirs: StyleDirs = { builtin: BUILTIN, user: temp() }
    expect(styleOutsideProject(dirs, project(`---\nextends: ${builtin}\n---\n`))).toBeNull()
    expect(styleOutsideProject(dirs, project('---\ntokens: {}\n---\n'))).toBeNull()
    expect(styleOutsideProject(dirs, temp())).toBeNull()
  })
})
