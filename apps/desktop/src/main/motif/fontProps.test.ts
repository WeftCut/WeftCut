// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FaceIndexEntry, FontIndex } from '../../shared/fonts/types'
import type { Manifest } from '../../shared/motifs/catalog'
import { MotifError } from '../../shared/motifs/errors'
import { motifPageFonts, servedMotifFont, setMotifFontSource } from './fontProps'

const sha = (c: string) => c.repeat(64)
/** A face whose file holds its sha: 64 bytes. */
const face = (family: string, c: string, over: Partial<FaceIndexEntry> = {}): FaceIndexEntry =>
  ({ families: [family], weight: 400, italic: false, source: 'system', sha256: sha(c), size: 64, ttcIndex: null, ...over })

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-motif-fonts-')) })
afterEach(() => {
  setMotifFontSource(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A catalog of `faces`, each in `<sha>.ttf` (or `.otf` for `o…`) holding
 *  its sha. */
function wire(faces: FaceIndexEntry[]) {
  const index: FontIndex = { revision: 1, complete: true, faces }
  const fileOf = (s: string) => path.join(dir, `${s}.${s.startsWith('o') ? 'otf' : 'ttf'}`)
  for (const f of faces) fs.writeFileSync(fileOf(f.sha256), f.sha256)
  const has = (s: string) => faces.some(f => f.sha256 === s)
  setMotifFontSource({
    catalog: {
      index: () => index,
      faceFile: s => (has(s) ? { file: fileOf(s), ttcIndex: null } : null),
      faceBytes: async s => (has(s) ? Buffer.from(s) : null),
    },
  })
  return { fileOf }
}

const manifest = (over: Partial<Manifest> = {}): Pick<Manifest, 'props_schema' | 'fonts'> =>
  ({ props_schema: { font_headline: { type: 'string', default: 'serif', max_length: 200 } }, ...over })

const keyedFace = (family: string, c: string, weight = 400) => ({ family, sha256: sha(c), weight, italic: false })

describe('Motif font props at capture', () => {
  it('hands the page every face of the prop\'s families, with CSS descriptors and a URL on the Motif\'s origin', async () => {
    wire([face('Anton', 'a'), face('Anton', 'o', { weight: [100, 900], italic: true })])
    expect(await motifPageFonts('headline', manifest(), { font_headline: "'Anton', sans-serif" })).toEqual([
      { family: 'Anton', weight: '400', style: 'normal', url: `motif://headline/.fonts/${sha('a')}.ttf` },
      { family: 'Anton', weight: '100 900', style: 'italic', url: `motif://headline/.fonts/${sha('o')}.otf` },
    ])
  })

  it('serves only faces a resolve handed to that Motif', async () => {
    wire([face('Anton', 'a'), face('Impact', 'i')])
    await motifPageFonts('headline', manifest(), { font_headline: 'Anton' })

    const served = await servedMotifFont('headline', `.fonts/${sha('a')}.ttf`)
    expect(served?.mime).toBe('font/ttf')
    expect(served?.bytes.toString()).toBe(sha('a'))

    // A catalog face no resolve named, the same face on another Motif's origin, and a malformed path.
    expect(await servedMotifFont('headline', `.fonts/${sha('i')}.ttf`)).toBeNull()
    expect(await servedMotifFont('other', `.fonts/${sha('a')}.ttf`)).toBeNull()
    expect(await servedMotifFont('headline', `.fonts/${sha('a')}`)).toBeNull()
  })

  it('never serves the families the package ships or the bundled ones, even when the renderer keyed them', async () => {
    wire([face('Inter', 'n'), face('Liberation Sans', 'l'), face('Anton', 'a')])
    const m = manifest({ fonts: [{ family: 'Inter', file: 'Inter.woff2' }] })
    expect((await motifPageFonts('fx', m, { font_headline: 'Inter, Liberation Sans, Anton' })).map(f => f.family)).toEqual(['Anton'])
    expect(await motifPageFonts('fx', m, {}, [keyedFace('Inter', 'n'), keyedFace('Liberation Sans', 'l')])).toEqual([])
    expect(await servedMotifFont('fx', `.fonts/${sha('n')}.ttf`)).toBeNull()
    expect(await servedMotifFont('fx', `.fonts/${sha('l')}.ttf`)).toBeNull()
  })

  it('takes the faces the renderer keyed rather than resolving again', async () => {
    wire([face('Anton', 'a'), face('Anton', 'b', { weight: 700 })])
    const fonts = await motifPageFonts('headline', manifest(), { font_headline: 'Anton' }, [keyedFace('Anton', 'b', 700)])
    expect(fonts.map(f => f.url)).toEqual([`motif://headline/.fonts/${sha('b')}.ttf`])
  })

  it('refuses a capture keyed with a face the catalog lacks, as a retryable failure', async () => {
    wire([face('Anton', 'a')])
    const capture = motifPageFonts('headline', manifest(), { font_headline: 'Anton' }, [keyedFace('Anton', 'a'), keyedFace('Anton', 'g')])
    await expect(capture).rejects.toBeInstanceOf(MotifError)
    await expect(capture).rejects.toMatchObject({ code: 'transient' })
  })

  it('refuses a capture keyed with a face whose file is gone, but not an unkeyed one', async () => {
    const { fileOf } = wire([face('Anton', 'a'), face('Anton', 'b', { weight: 700 })])
    fs.rmSync(fileOf(sha('b')))
    await expect(motifPageFonts('headline', manifest(), {}, [keyedFace('Anton', 'b', 700)])).rejects.toMatchObject({ code: 'transient' })
    // An MCP preview keeps no frame under a key: it resolves in main as before.
    expect((await motifPageFonts('headline', manifest(), { font_headline: 'Anton' })).length).toBeGreaterThan(0)
  })
})
