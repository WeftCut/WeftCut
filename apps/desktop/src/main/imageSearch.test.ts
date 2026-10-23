import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptableCommonsLicence, downloadImage, lookupImage, parseCommons, readCredits, searchImages, writeCredit, type ImageCandidate } from './imageSearch'

const SEARCH = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '__fixtures__/commons-search.json'), 'utf8'))
const answer = (body: unknown, over: Partial<{ ok: boolean; status: number; url: string; type: string; bytes: Buffer }> = {}) => ({
  ok: over.ok ?? true, status: over.status ?? 200, url: over.url ?? 'https://upload.wikimedia.org/x',
  headers: { get: (n: string) => (n === 'content-type' ? over.type ?? 'application/json' : n === 'content-length' ? String(over.bytes?.length ?? 0) : null) },
  json: async () => body, arrayBuffer: async () => { const b = over.bytes ?? Buffer.alloc(0); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) },
})

describe('open-licence image search (Commons)', () => {
  it('keeps licences that allow changes and commercial use', () => {
    expect(['CC0', 'Public domain', 'PD-old', 'CC BY 2.5', 'CC BY-SA 3.0', 'CC BY-SA 2.0 de'].map(acceptableCommonsLicence))
      .toEqual(['CC0', 'Public domain', 'Public domain', 'CC BY 2.5', 'CC BY-SA 3.0', 'CC BY-SA 2.0 de'])
    expect(['CC BY-NC-SA 2.0', 'CC BY-ND 4.0', 'GFDL', 'Fair use', ''].map(acceptableCommonsLicence)).toEqual([null, null, null, null, null])
  })

  it('reads candidates in search order, with credit, and drops what may not be reused', () => {
    const c = parseCommons(SEARCH)
    expect(c.map((x) => x.candidate_id)).not.toContain('commons:999')
    expect(c.at(-1)).toMatchObject({ candidate_id: 'commons:998', license: 'Public domain', image_url: 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Seahorse_outline.svg' })
    // Looked up at the import width, a vector or large file comes as Commons' own rendering.
    const svg = structuredClone(SEARCH.query.pages['998'])
    Object.assign(svg.imageinfo[0], { thumburl: 'https://thumb.wikimedia.org/x/1920px-Seahorse_outline.svg.png', thumbwidth: 1920, thumbheight: 1920 })
    expect(parseCommons({ query: { pages: { 998: svg } } }, true)[0]).toMatchObject({ image_url: 'https://thumb.wikimedia.org/x/1920px-Seahorse_outline.svg.png', width: 1920, height: 1920 })
    const first = c[0]!
    expect(first.license).toBe('CC BY-SA 3.0')
    expect(first.credit).toMatch(/^".+" by .+, CC BY-SA 3\.0, via Wikimedia Commons$/)
    expect(first.page_url).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/)
    // A 1704 px original comes as is.
    expect(parseCommons(SEARCH, true)[0]!.image_url).toBe(first.image_url)
  })

  it('searches, and looks a candidate up again by its id', async () => {
    const urls: string[] = []
    const fetch = async (u: string) => { urls.push(u); return answer(SEARCH) }
    expect((await searchImages('seahorse skeleton', { limit: 2, fetch: fetch as never })).length).toBe(2)
    expect(new URL(urls[0]!).searchParams.get('gsrsearch')).toBe('seahorse skeleton')
    await lookupImage('commons:998', { fetch: (async (u: string) => { urls.push(u); return answer({ query: { pages: { 998: SEARCH.query.pages['998'] } } }) }) as never })
    expect(new URL(urls.at(-1)!).searchParams.get('pageids')).toBe('998')
    expect(new URL(urls.at(-1)!).searchParams.get('iiurlwidth')).toBe('1920')
    await expect(lookupImage('https://evil.example/x.jpg')).rejects.toThrow(/not one search_images returned/)
    await expect(lookupImage('commons:999', { fetch: (async () => answer({ query: { pages: { 999: SEARCH.query.pages['999'] } } })) as never })).rejects.toThrow(/no longer allows reuse/)
  })

  it('downloads only https images, under a size cap, named after the title', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsearch-'))
    const c = parseCommons(SEARCH)[0]! as ImageCandidate
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const file = await downloadImage(c, dir, { fetch: (async () => answer(null, { type: 'image/png', bytes: png })) as never })
    expect(path.basename(file)).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}\.png$/)
    await expect(downloadImage(c, dir, { fetch: (async () => answer(null, { type: 'text/html', bytes: png })) as never })).rejects.toThrow(/not a JPEG, PNG, WebP or GIF/)
    await expect(downloadImage(c, dir, { fetch: (async () => answer(null, { type: 'image/png', url: 'http://x/y', bytes: png })) as never })).rejects.toThrow(/redirected off https/)
    await expect(downloadImage({ ...c, image_url: 'http://x/y.png' }, dir)).rejects.toThrow(/not served over https/)
  })

  it('keeps credits beside the project, by content hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-'))
    expect(readCredits(dir)).toEqual({})
    const credit = { title: 'T', author: 'A', license: 'CC BY 4.0', license_url: null, page_url: 'https://commons.wikimedia.org/wiki/File:T.jpg', source: 'commons' as const, credit: '"T" by A, CC BY 4.0, via Wikimedia Commons', imported_at: '2026-10-23T00:00:00Z' }
    writeCredit(dir, 'h1', credit); writeCredit(dir, 'h2', { ...credit, title: 'U' })
    expect(Object.keys(readCredits(dir))).toEqual(['h1', 'h2'])
  })
})
