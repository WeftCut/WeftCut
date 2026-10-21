import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFrontmatter } from './packages'
import { DEFAULT_STYLE, listStyles, tasteView, type StyleDirs } from './view'
import { BUILTIN_MANIFESTS } from '../../shared/motifs/catalog'

const BUILTIN = path.join(import.meta.dirname, '../../shared/styles/builtin')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function temp() { const r = mkdtempSync(path.join(tmpdir(), 'taste-')); roots.push(r); return r }
function dirs(user: string | null = null): StyleDirs { return { builtin: BUILTIN, user } }
function project(taste?: string) {
  const dir = temp()
  if (taste !== undefined) writeFileSync(path.join(dir, 'TASTE.md'), taste)
  return dir
}
function style(root: string, name: string, frontmatter: string, extra: Record<string, string> = {}) {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(path.join(root, name, 'STYLE.md'), `---\n${frontmatter}\n---\nprose of ${name}\n`)
  for (const [f, text] of Object.entries(extra)) writeFileSync(path.join(root, name, f), text)
}

describe('the built-in default style', () => {
  it('validates with no diagnostics and keeps untagged text at the long-standing default', () => {
    const v = tasteView(dirs(), null)
    expect(v.diagnostics).toEqual([])
    expect(v.style).toMatchObject({ name: DEFAULT_STYLE, origin: 'builtin', pinned: null, pin_matches: null })
    expect(v.taste).toEqual({ path: null, present: false })
    expect(v.tokens.text?.none).toMatchObject({ family: null, size_px: 72, weight: 400, color: 'ink', outline: null, intro: null })
    expect(v.tokens.caption).toMatchObject({ size_px: 54, max_chars_per_line: 42, max_lines: 2 })
    expect(v.provenance['text.title.size_px']).toBe('style')
    expect(v.roles.map((r) => r.name)).toEqual(['title', 'lower_third', 'callout', 'credit', 'logo', 'plate', 'none'])
  })
})

describe('TASTE.md over its style', () => {
  it('overrides one field at a time and records which layer set each', () => {
    const v = tasteView(dirs(), project('---\nextends: weftcut-default\ntokens:\n  palette: { accent: "#E04329" }\n  text:\n    title: { size_px: 110 }\n---\nOur titles run large.\n'))
    expect(v.diagnostics).toEqual([])
    expect(v.taste.present).toBe(true)
    expect(v.tokens.text?.title).toMatchObject({ size_px: 110, weight: 700, intro: 'FadeIn' })
    expect(v.tokens.palette).toMatchObject({ accent: '#E04329', ink: '#FFFFFF' })
    expect(v.provenance['text.title.size_px']).toBe('taste')
    expect(v.provenance['text.title.weight']).toBe('style')
    expect(v.prose.taste).toBe('Our titles run large.')
  })

  it('replaces outline and shadow whole, never merging half of one', () => {
    const v = tasteView(dirs(), project('---\ntokens:\n  text:\n    title: { outline: null, shadow: { color: shade, offset_x: 2, offset_y: 2, blur: 0 } }\n---\n'))
    expect(v.tokens.text?.title?.outline).toBeNull()
    expect(v.tokens.text?.title?.shadow).toEqual({ color: 'shade', offset_x: 2, offset_y: 2, blur: 0 })
  })

  it('drops a bad field with a diagnostic and keeps the style value for it', () => {
    const v = tasteView(dirs(), project('---\ntokens:\n  text:\n    title: { size_px: "huge", weight: 650, colour: ink }\n  caption: { max_lines: 9 }\n  shapes: {}\n---\n'))
    const paths = v.diagnostics.map((d) => d.path)
    expect(paths).toEqual(expect.arrayContaining(['tokens.text.title.size_px', 'tokens.text.title.weight', 'tokens.text.title.colour', 'tokens.caption.max_lines', 'tokens.shapes']))
    expect(v.diagnostics.every((d) => d.source === 'taste')).toBe(true)
    expect(v.tokens.text?.title?.size_px).toBe(96)
    expect(v.tokens.caption?.max_lines).toBe(2)
  })

  it('refuses tokens for an undeclared role and accepts them once declared', () => {
    const undeclared = tasteView(dirs(), project('---\ntokens:\n  text:\n    chapter_card: { size_px: 80 }\n---\n'))
    expect(undeclared.diagnostics[0]).toMatchObject({ path: 'tokens.text.chapter_card', message: expect.stringContaining('undeclared') })
    expect(undeclared.tokens.text?.chapter_card).toBeUndefined()
    const declared = tasteView(dirs(), project('---\nroles:\n  - { name: chapter_card, description: Full-frame chapter opener }\ntokens:\n  text:\n    chapter_card: { size_px: 80 }\n---\n'))
    expect(declared.diagnostics).toEqual([])
    expect(declared.roles.at(-1)).toEqual({ name: 'chapter_card', builtin: false, declared_by: 'taste', description: 'Full-frame chapter opener' })
    expect(declared.tokens.text?.chapter_card).toEqual({ size_px: 80 })
  })

  it('refuses redeclaring a built-in role', () => {
    const v = tasteView(dirs(), project('---\nroles: [title]\n---\n'))
    expect(v.diagnostics[0]?.message).toContain('built-in')
  })

  it('drops a colour naming a palette entry that does not exist', () => {
    const v = tasteView(dirs(), project('---\ntokens:\n  text:\n    title: { color: brand_red }\n---\n'))
    expect(v.diagnostics).toEqual([expect.objectContaining({ path: 'tokens.text.title.color', message: expect.stringContaining('brand_red') })])
    expect(v.tokens.text?.title?.color).toBeUndefined()
  })

  it('falls back to the style alone when the frontmatter is not YAML', () => {
    const v = tasteView(dirs(), project('---\ntokens: [unclosed\n---\n'))
    expect(v.diagnostics[0]?.message).toMatch(/not valid YAML/)
    expect(v.tokens.text?.title?.size_px).toBe(96)
  })

  it('falls back to the default style for an unknown extends, and reports it', () => {
    const v = tasteView(dirs(), project('---\nextends: vox-ish\n---\n'))
    expect(v.style.name).toBe(DEFAULT_STYLE)
    expect(v.diagnostics[0]).toMatchObject({ path: 'extends', message: expect.stringContaining('vox-ish') })
  })

  it('changes revision when TASTE.md changes', () => {
    const dir = project('---\ntokens: { text: { title: { size_px: 100 } } }\n---\n')
    const a = tasteView(dirs(), dir).revision
    writeFileSync(path.join(dir, 'TASTE.md'), '---\ntokens: { text: { title: { size_px: 101 } } }\n---\n')
    expect(tasteView(dirs(), dir).revision).not.toBe(a)
  })
})

describe('user style packages', () => {
  it('extends a user style, checks the pin against the package hash and declares its roles', () => {
    const user = temp()
    style(user, 'paper-explainer', 'name: paper-explainer\nroles: [{ name: clipping }]\ntokens:\n  palette: { paper: "#DAD9D5" }\n  text:\n    clipping: { color: paper, size_px: 40 }', { 'notes.txt': 'v1' })
    const first = tasteView(dirs(user), project('---\nextends: paper-explainer\n---\n'))
    expect(first.diagnostics).toEqual([])
    expect(first.style).toMatchObject({ name: 'paper-explainer', origin: 'user', pin_matches: null })
    expect(first.tokens.text?.clipping).toEqual({ color: 'paper', size_px: 40 })
    const pin = first.style.hash.slice(0, 12)
    expect(tasteView(dirs(user), project(`---\nextends: paper-explainer@${pin}\n---\n`)).style.pin_matches).toBe(true)
    writeFileSync(path.join(user, 'paper-explainer', 'notes.txt'), 'v2')
    const moved = tasteView(dirs(user), project(`---\nextends: paper-explainer@${pin}\n---\n`))
    expect(moved.style.pin_matches).toBe(false)
    expect(moved.diagnostics[0]).toMatchObject({ severity: 'warning', path: 'extends' })
  })

  it('never lets a user package shadow a built-in name', () => {
    const user = temp()
    style(user, 'weftcut-default', 'tokens: { text: { title: { size_px: 10 } } }')
    expect(tasteView(dirs(user), null).tokens.text?.title?.size_px).toBe(96)
    expect(listStyles(dirs(user))).toEqual([{ name: 'clipping', origin: 'builtin' }, { name: 'weftcut-default', origin: 'builtin' }])
  })
})

describe('the built-in clipping style', () => {
  it('validates against the built-in catalog with no diagnostics and draws four roles with its Motifs', () => {
    const v = tasteView(dirs(), project('---\nextends: clipping\n---\n'), { motif: (id) => BUILTIN_MANIFESTS.get(id) ?? null, fonts: new Set(['impact', 'microsoft yahei', 'georgia', 'simsun', 'consolas']) })
    expect(v.diagnostics).toEqual([])
    expect(v.style).toMatchObject({ name: 'clipping', origin: 'builtin' })
    expect(Object.fromEntries(Object.entries(v.motifs).map(([r, m]) => [r, m.ids]))).toEqual({
      title: ['clipping-headline'], lower_third: ['clipping-stamp'], callout: ['clipping-quote', 'clipping-pointer'], plate: ['clipping-paper'] })
    expect(v.fonts?.headline).toMatchObject({ resolved: 'Impact', missing: ['Anton', 'Bebas Neue', 'Arial Black', 'Noto Sans SC Black'] })
    expect(v.tokens.caption).toMatchObject({ max_chars_per_line: 42, max_lines: 2 })
  })
})

describe('Motifs by role', () => {
  const manifest = (id: string, role: string | null) => ({ id, name: id.toUpperCase(), version: 1, size: [800, 200] as [number, number], default_duration_s: 4,
    graphic_role: role, props_schema: { text: { type: 'string' as const, default: 'x' } } })
  const catalog = new Map([['paper-title', manifest('paper-title', 'title')], ['paper-label', manifest('paper-label', 'lower_third')], ['big-title', manifest('big-title', 'title')]])
  const motif = (id: string) => catalog.get(id) ?? null

  it('lists the Motifs a style draws each role with, as the catalog describes them', () => {
    const user = temp()
    style(user, 'paper', 'motifs:\n  title: paper-title\n  lower_third: [paper-label]')
    const v = tasteView(dirs(user), project('---\nextends: paper\n---\n'), { motif })
    expect(v.diagnostics).toEqual([])
    expect(v.motifs.title).toEqual({ ids: ['paper-title'], source: 'style', motifs: [{ id: 'paper-title', name: 'PAPER-TITLE', size: [800, 200], graphic_role: 'title', props_schema: { text: { type: 'string', default: 'x' } } }] })
    expect(v.motifs.lower_third?.ids).toEqual(['paper-label'])
    expect(v.provenance['motifs.title']).toBe('style')
  })

  it('lets TASTE.md replace one role and keeps the others', () => {
    const user = temp()
    style(user, 'paper', 'motifs: { title: paper-title, lower_third: paper-label }')
    const v = tasteView(dirs(user), project('---\nextends: paper\nmotifs: { title: [big-title, paper-title] }\n---\n'), { motif })
    expect(v.motifs.title).toMatchObject({ ids: ['big-title', 'paper-title'], source: 'taste' })
    expect(v.motifs.lower_third).toMatchObject({ ids: ['paper-label'], source: 'style' })
    expect(v.provenance['motifs.title']).toBe('taste')
  })

  it('drops an id the catalog lacks, and a role nobody declared, without failing the read', () => {
    const user = temp()
    style(user, 'paper', 'motifs: { title: [gone, paper-title], logo: gone-too, mascot: paper-title }')
    const v = tasteView(dirs(user), project('---\nextends: paper\n---\n'), { motif })
    expect(v.motifs.title?.ids).toEqual(['paper-title'])
    expect(v.motifs.logo).toBeUndefined()
    expect(v.motifs.mascot).toBeUndefined()
    expect(v.diagnostics.map((d) => d.path)).toEqual(expect.arrayContaining(['motifs.mascot', 'motifs.title', 'motifs.logo']))
  })

  it('lists ids unchecked when no catalog is given', () => {
    const user = temp()
    style(user, 'paper', 'motifs: { title: anything }')
    expect(tasteView(dirs(user), project('---\nextends: paper\n---\n')).motifs.title).toEqual({ ids: ['anything'], source: 'style' })
  })
})

describe('readFrontmatter', () => {
  it('treats a file with no fence as prose and refuses YAML aliases', () => {
    expect(readFrontmatter('just words')).toEqual({ data: null, prose: 'just words' })
    expect(readFrontmatter('---\na: &x [1]\nb: *x\n---\n').error).toMatch(/YAML/)
  })
})
