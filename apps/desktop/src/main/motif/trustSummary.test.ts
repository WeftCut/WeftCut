// The trust card's static summary: each sign of code it reports, on small
// packages, and the bounds on what it reads.
import { describe, expect, it } from 'vitest'
import type { MotifFile } from './packageFiles'
import { MINIFIED_LINE_CHARS, MINIFIED_PUNCTUATION_SHARE, motifTrustSummary, SCAN_FILE_BYTES, SCAN_TOTAL_BYTES, summarizeMotifFiles } from './trustSummary'

const file = (path: string, bytes: string | Buffer): MotifFile => ({ path, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) })
const PAGE = '<!doctype html><html><body><p>hi</p></body></html>'

describe('the trust summary', () => {
  it('counts files, bytes and binary files', () => {
    const files = [file('index.html', PAGE), file('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])), file('notes.txt', 'plain')]
    expect(summarizeMotifFiles(files)).toMatchObject({ files: 3, bytes: files.reduce((n, f) => n + f.bytes.length, 0), binary: 1,
      scripts: [], workers: [], wasm: [], minified: [], unscanned: [] })
  })

  it('lists script files, and markup only when it holds a script', () => {
    const summary = summarizeMotifFiles([file('index.html', '<html><SCRIPT>x()</SCRIPT></html>'), file('plain.html', PAGE),
      file('lib/a.js', 'a()'), file('b.mjs', 'b()'), file('c.cjs', 'c()'), file('data.json', '{"script": "<script"}')])
    expect(summary.scripts.map(s => s.path)).toEqual(['b.mjs', 'c.cjs', 'index.html', 'lib/a.js'])
    expect(summary.scripts.find(s => s.path === 'lib/a.js')!.bytes).toBe(3)
  })

  it('names the files that start a worker of any kind', () => {
    const summary = summarizeMotifFiles([file('a.js', 'const w = new Worker("w.js")'), file('b.js', 'new SharedWorker (u)'),
      file('c.js', 'importScripts("x.js")'), file('d.js', 'navigator.serviceWorker.register("/s.js")'), file('e.js', 'const Worker = 1')])
    expect(summary.workers).toEqual(['a.js', 'b.js', 'c.js', 'd.js'])
  })

  it('names WebAssembly by extension, by its magic and by the calls that compile it', () => {
    const magic = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])])
    const summary = summarizeMotifFiles([file('a.wasm', 'not really'), file('blob.bin', magic),
      file('b.js', 'WebAssembly.instantiate(bytes)'), file('c.js', 'new WebAssembly.Module(b)'), file('d.js', 'WebAssembly.validate(b)')])
    expect(summary.wasm).toEqual(['a.wasm', 'b.js', 'blob.bin', 'c.js'])
  })

  it('flags a long line dense in code punctuation as minified, and not a long base64 or prose line', () => {
    const unit = 'a=b(c);'
    const minified = unit.repeat(Math.ceil(MINIFIED_LINE_CHARS / unit.length))
    const base64 = 'QUJD'.repeat(MINIFIED_LINE_CHARS)
    const prose = 'word '.repeat(MINIFIED_LINE_CHARS)
    const justShort = unit.repeat(Math.floor((MINIFIED_LINE_CHARS - 1) / unit.length))
    const summary = summarizeMotifFiles([file('min.js', `// header\n${minified}\nshort();`), file('index.html', `<img src="data:image/png;base64,${base64}">`),
      file('prose.js', prose), file('short.js', justShort), file('min.txt', minified)])
    expect(summary.minified).toEqual([{ path: 'min.js', longest_line: minified.length }])
    // The threshold the product enforces, not a measured share.
    expect([...minified].filter(c => ';{}()=,'.includes(c)).length / minified.length).toBeGreaterThanOrEqual(MINIFIED_PUNCTUATION_SHARE)
  })

  it('does not read a file over the per-file bound, but still names it by its path', () => {
    const big = Buffer.alloc(SCAN_FILE_BYTES + 1, 'a')
    big.write('new Worker(x)', 0)
    const summary = summarizeMotifFiles([file('big.js', big), file('big.wasm', Buffer.alloc(SCAN_FILE_BYTES + 1))])
    expect(summary.unscanned).toEqual(['big.js', 'big.wasm'])
    expect(summary.workers).toEqual([])
    expect(summary.scripts.map(s => s.path)).toEqual(['big.js'])
    expect(summary.wasm).toEqual(['big.wasm'])
  })

  it('reads no file past the package budget, in path order', () => {
    const files = Array.from({ length: Math.floor(SCAN_TOTAL_BYTES / SCAN_FILE_BYTES) + 1 }, (_, i) =>
      file(`part-${String(i).padStart(3, '0')}.js`, Buffer.alloc(SCAN_FILE_BYTES, 'a')))
    const summary = summarizeMotifFiles(files)
    expect(summary.unscanned).toEqual([files.at(-1)!.path])
    expect(summary.files).toBe(files.length)
  })

  it('keeps a revision\'s summary: a revision is its bytes', () => {
    let reads = 0
    const files = () => { reads++; return [file('a.js', 'a()')] }
    const revision = 'e'.repeat(64)
    const first = motifTrustSummary(revision, files)
    expect(motifTrustSummary(revision, files)).toBe(first)
    expect(reads).toBe(1)
  })
})
