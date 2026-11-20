import { describe, expect, it } from 'vitest'
// Shared with the Rust twin (native/src/state/project_path.rs).
import vectors from '../../fixtures/project-paths.json'
import {
  MEDIA, foldCase, isPortableSegment, isProjectPath, parseProjectPath, portableFileName, projectPathBase,
  projectPathOf, projectPathSegments,
} from './projectPath'

describe('parseProjectPath', () => {
  it.each(vectors.valid)('accepts %j', (s) => {
    const p = parseProjectPath(s)
    expect(p).toBe(s)
    expect(isProjectPath(s)).toBe(true)
    expect(projectPathOf(...projectPathSegments(p))).toBe(p)
  })

  it.each(vectors.invalid)('refuses $path ($why)', ({ path }) => {
    expect(() => parseProjectPath(path)).toThrow(/^Invalid project path/)
    expect(isProjectPath(path)).toBe(false)
  })

  it('names the rule a path breaks', () => {
    expect(() => parseProjectPath('Media\\x.mp4')).toThrow(/backslash/)
    expect(() => parseProjectPath('Media/café.mp4')).toThrow(/not NFC/)
  })

  it('refuses a non-NFC path whose NFC form it accepts', () => {
    const nfd = 'Media/café.mp4'
    expect(isProjectPath(nfd)).toBe(false)
    expect(isProjectPath(nfd.normalize('NFC'))).toBe(true)
  })
})

describe('projectPathOf', () => {
  it('refuses a separator inside a segment', () => {
    expect(() => projectPathOf('Media/x.mp4')).toThrow(/separator/)
    expect(() => projectPathOf('Media', 'a\\b.mp4')).toThrow(/separator/)
  })

  it('refuses no segments and every invalid vector segment', () => {
    expect(() => projectPathOf()).toThrow()
    for (const { path } of vectors.invalid) {
      if (path.includes('\\')) continue
      expect(() => projectPathOf(...path.split('/')), path).toThrow()
    }
  })

  it('MEDIA is the one-segment Media folder', () => {
    expect(projectPathSegments(MEDIA)).toEqual(['Media'])
  })
})

describe('segments', () => {
  it('projectPathBase is the last segment', () => {
    for (const s of vectors.valid) {
      const p = parseProjectPath(s)
      expect(projectPathBase(p)).toBe(projectPathSegments(p).at(-1))
    }
  })

  it('isPortableSegment agrees with parseProjectPath on one-segment paths', () => {
    for (const s of [...vectors.valid, ...vectors.invalid.map((v) => v.path)]) {
      if (s.includes('/') || s.includes('\\')) continue
      expect(isPortableSegment(s), s).toBe(isProjectPath(s))
    }
  })
})

describe('foldCase', () => {
  it('folds case and normalization to one key', () => {
    expect(foldCase('CAFÉ.mp4')).toBe(foldCase('café.mp4'))
    expect(foldCase('Ä.wav')).toBe(foldCase('ä.wav'))
    expect(foldCase('clip.mp4')).not.toBe(foldCase('clip-2.mp4'))
  })
})

describe('portableFileName', () => {
  it.each(vectors.portableFileName)('names $name with $taken taken as $out', ({ name, taken, out }) => {
    const folded = new Set(taken.map(foldCase))
    expect(portableFileName(name, (f) => folded.has(f))).toBe(out)
  })

  it('suffixes past every case-folded name taken, and the result is never taken', () => {
    const folded = new Set(['font.ttf', 'FONT-2.TTF', 'font-3.ttf'].map(foldCase))
    const got = portableFileName('Font.ttf', (f) => folded.has(f))
    expect(got).toBe('Font-4.ttf')
    expect(folded.has(foldCase(got))).toBe(false)
  })

  it('always yields a portable segment, suffixed or not', () => {
    for (const name of ['a\u0001b', '...', 'nul.x.y', `a.${'e'.repeat(200)}`, `COM1${' '.repeat(300)}x`, `${'视'.repeat(100)}.mp4`]) {
      const got = portableFileName(name, () => false)
      expect(isPortableSegment(got), `${JSON.stringify(name)} → ${got}`).toBe(true)
      const suffixed = portableFileName(name, (f) => f === foldCase(got))
      expect(isPortableSegment(suffixed), `${JSON.stringify(name)} → ${suffixed}`).toBe(true)
      expect(foldCase(suffixed)).not.toBe(foldCase(got))
    }
  })
})
