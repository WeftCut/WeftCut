import { describe, expect, it } from 'vitest'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { normalize } from './motifPackage'

const manifest: Manifest = { id: 'x', name: 'Card', version: 1, size: [64, 64], default_duration_s: 1, props_schema: {} }
const json = { path: 'manifest.json', bytes: Buffer.from(JSON.stringify({ name: 'Card', size: [64, 64], default_duration_s: 1, props_schema: {} })) }
const bytesOf = (files: readonly { path: string; bytes: Buffer }[]) => Object.fromEntries(files.map(f => [f.path, f.bytes.toString('utf8')]))

describe('normalize', () => {
  for (const [label, html] of [
    ['a page with a head', '<!doctype html><html><head><title>t</title></head><body><script>motif.define({frame(t){}})</script></body></html>'],
    ['a page without a head', '<script>motif.define({frame(t){}})</script>'],
    ['a page with its own island', composeMotifHtml({ ...manifest, name: 'Older' }, '<html><head>\n  <meta charset="utf-8"></head><body></body></html>')],
  ] as const) {
    it(`changes no byte of a package it normalised, under the same id and version (${label})`, () => {
      const once = normalize([{ path: 'index.html', bytes: Buffer.from(html) }, json, { path: 'assets/a.txt', bytes: Buffer.from('a') }], 'card', 3)
      const twice = normalize(once.files, 'card', 3)
      expect(bytesOf(twice.files)).toEqual(bytesOf(once.files))
      expect(twice.revision).toBe(once.revision)
    })
  }

  it('restamps only the island and manifest under another id or version', () => {
    const once = normalize([{ path: 'index.html', bytes: Buffer.from('<html><head></head><body>b</body></html>') }, json], 'card', 1)
    const again = normalize(once.files, 'card', 2)
    expect(again.manifest.version).toBe(2)
    expect(again.html.replace(/"version": 2/, '"version": 1')).toBe(once.html)
  })
})
