import { describe, expect, it } from 'vitest'
import { zipSync, unzipSync, type Zippable } from 'fflate'
import { LINEAGE_ENTRY, MAX_ENTRIES, decodeMotifZip, encodeMotifZip } from './archive'

const LINEAGE = '3f9a2c1d-0b4e-4c5a-9d7e-2a6b8c0d1e2f'

const html = Buffer.from('<html>scene</html>')
const model = Buffer.from([0, 255, 1, 128])

describe('Motif ZIP packages', () => {
  it('exports one folder with its lineage beside it and round-trips nested binary resources', () => {
    const files = [
      { path: 'index.html', bytes: html },
      { path: 'assets/model.glb', bytes: model },
      { path: 'params.html', bytes: Buffer.from('controls') },
      // No package path is private: a file named like old releases' metadata is the package's.
      { path: 'target', bytes: Buffer.from('a package file') },
    ]
    const zip = encodeMotifZip('scene', files, LINEAGE)
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([LINEAGE_ENTRY, ...files.map(f => `scene/${f.path}`)].sort())
    expect(decodeMotifZip(zip)).toEqual({ files, lineage: LINEAGE })
  })

  it('accepts root files and explicit folder entries from external ZIP tools, which claim no lineage', () => {
    expect(decodeMotifZip(zipSync({ 'index.html': html, 'assets/': new Uint8Array(), 'assets/model.glb': model })))
      .toEqual({ files: [{ path: 'index.html', bytes: html }, { path: 'assets/model.glb', bytes: model }], lineage: null })
    expect(decodeMotifZip(zipSync({ 'scene/': new Uint8Array(), 'scene/index.html': html })))
      .toEqual({ files: [{ path: 'index.html', bytes: html }], lineage: null })
  })

  it('reads the lineage entry only beside a Motif folder, and only a valid uid', () => {
    const entry = Buffer.from(JSON.stringify({ lineage: LINEAGE }))
    // Beside the package's own index.html it is one of the package's files.
    expect(decodeMotifZip(zipSync({ 'index.html': html, [LINEAGE_ENTRY]: entry })))
      .toEqual({ files: [{ path: 'index.html', bytes: html }, { path: LINEAGE_ENTRY, bytes: entry }], lineage: null })
    for (const bad of ['{"lineage":"not-a-uid"}', '{"lineage":"3F9A2C1D-0B4E-4C5A-9D7E-2A6B8C0D1E2F"}', 'not json'])
      expect(decodeMotifZip(zipSync({ 'scene/index.html': html, [LINEAGE_ENTRY]: Buffer.from(bad) })))
        .toEqual({ files: [{ path: 'index.html', bytes: html }], lineage: null })
  })

  it('imports back a package holding as many files as an archive may', () => {
    const files = [{ path: 'index.html', bytes: html },
      ...Array.from({ length: MAX_ENTRIES - 1 }, (_, i) => ({ path: `f/${i}.txt`, bytes: Buffer.from('x') }))]
    expect(decodeMotifZip(encodeMotifZip('scene', files, LINEAGE)).files).toHaveLength(MAX_ENTRIES)
  })

  it('refuses to export without a lineage or under the entry\'s name', () => {
    const files = [{ path: 'index.html', bytes: html }]
    expect(() => encodeMotifZip('scene', files, 'not-a-uid')).toThrow(/lineage/)
    expect(() => encodeMotifZip(LINEAGE_ENTRY, files, LINEAGE)).toThrow(/folder name/)
  })

  it.each(['../escape', '/absolute', 'C:/escape', 'assets\\escape', 'asset:stream', 'NUL.txt', 'name.', 'dir/../bad'])
    ('rejects unsafe ZIP entry %s', name => {
      expect(() => decodeMotifZip(zipSync({ 'index.html': html, [name]: model }))).toThrow(/path/)
    })

  it.each<Zippable>([
    { 'index.html': html, 'INDEX.html': html },
    { 'index.html': html, 'assets': model, 'assets/model.glb': model },
    { 'index.html': html, 'Assets/a': model, 'assets/b': model },
  ])('rejects aliases and file/directory collisions before import', entries => {
    expect(() => decodeMotifZip(zipSync(entries))).toThrow(/Duplicate|Conflicting/)
  })

  it.each<Zippable>([
    {}, { 'scene.js': model },
    { 'one/index.html': html, 'two/index.html': html },
    { 'scene/index.html': html, 'outside.js': model },
  ])('rejects missing or ambiguous package roots', entries => {
    expect(() => decodeMotifZip(zipSync(entries))).toThrow(/index.html/)
  })

  it('rejects corrupt archives and excessive advertised expansion before allocating', () => {
    expect(() => decodeMotifZip(Buffer.from('not a zip'))).toThrow()
    const zip = Buffer.from(zipSync({ 'index.html': html }))
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(300 * 1024 * 1024, central + 24)
    expect(() => decodeMotifZip(zip)).toThrow(/expanded size/)
  })
})
