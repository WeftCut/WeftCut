import { describe, expect, it } from 'vitest'
import { zipSync, unzipSync, type Zippable } from 'fflate'
import { decodeMotifZip, encodeMotifZip } from './archive'

const html = Buffer.from('<html>scene</html>')
const model = Buffer.from([0, 255, 1, 128])

describe('Motif ZIP packages', () => {
  it('exports one folder and round-trips nested binary resources without private metadata', () => {
    const files = [
      { path: 'index.html', bytes: html },
      { path: 'assets/model.glb', bytes: model },
      { path: 'params.html', bytes: Buffer.from('controls') },
    ]
    const zip = encodeMotifZip('scene', [...files, { path: 'target', bytes: Buffer.from('old-id') }])
    expect(Object.keys(unzipSync(zip))).toEqual(['scene/index.html', 'scene/assets/model.glb', 'scene/params.html'])
    expect(decodeMotifZip(zip)).toEqual(files)
  })

  it('accepts root files and explicit folder entries from external ZIP tools', () => {
    expect(decodeMotifZip(zipSync({ 'index.html': html, 'assets/': new Uint8Array(), 'assets/model.glb': model })))
      .toEqual([{ path: 'index.html', bytes: html }, { path: 'assets/model.glb', bytes: model }])
    expect(decodeMotifZip(zipSync({ 'scene/': new Uint8Array(), 'scene/index.html': html })))
      .toEqual([{ path: 'index.html', bytes: html }])
  })

  it('drops an imported Update target', () => {
    expect(decodeMotifZip(zipSync({ 'scene/index.html': html, 'scene/target': Buffer.from('victim') })))
      .toEqual([{ path: 'index.html', bytes: html }])
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
