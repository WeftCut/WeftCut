import { describe, expect, it } from 'vitest'
import { parseProjectPath } from '../../shared/projectPath'
import { portabilityReport, type PortabilityInputs } from './portability'

const inside = parseProjectPath('Media/clip.mp4')
const nothingOutside: PortabilityInputs = {
  media: [{ id: 'm1', label: 'clip.mp4', path: '/p/Media/clip.mp4', path_rel: inside, available: true }],
  unavailableMotifs: [],
  motifTable: ['title'],
  motifFolders: ['title'],
  excludedFonts: [],
  missingFonts: [],
  outsideStyle: null,
}

/** A project that leans on this machine in every way the check knows. */
const incomplete: PortabilityInputs = {
  media: [
    { id: 'm1', label: 'clip.mp4', path: '/p/Media/clip.mp4', path_rel: inside, available: true },
    { id: 'm2', label: 'b-roll.mov', path: '/elsewhere/b-roll.mov', path_rel: null, available: true },
    { id: 'm3', label: 'gone.wav', path: '/p/Media/gone.wav', path_rel: parseProjectPath('Media/gone.wav'), available: false },
    { id: 'm4', label: 'gone-outside.png', path: '/elsewhere/gone-outside.png', path_rel: null, available: false },
  ],
  unavailableMotifs: [
    { motif_id: 'lower', status: 'missing', diagnostic: 'Motifs/lower/ is missing' },
    { motif_id: 'broken', status: 'invalid', diagnostic: 'index.html is missing' },
    { motif_id: 'received', status: 'untrusted', diagnostic: 'not trusted on this machine', revision: 'r' },
  ],
  motifTable: ['lower', 'broken', 'received'],
  motifFolders: ['broken', 'received', 'undone-place'],
  excludedFonts: [{ family: 'Example Sans', installed: true }],
  missingFonts: [{ family: 'Nowhere Serif', weight: 400, italic: false, layer_ids: ['l1'] }],
  outsideStyle: 'my-style',
}

describe('portabilityReport', () => {
  it('lists every outside dependency of an incomplete project, each under its kind', () => {
    const r = portabilityReport(incomplete)
    expect(r.portable).toBe(false)
    expect(r.media.outside.map(m => m.media_id)).toEqual(['m2'])
    expect(r.motifs.missing.map(m => m.motif_id)).toEqual(['lower'])
    expect(r.motifs.invalid.map(m => m.motif_id)).toEqual(['broken'])
    expect(r.motifs.untracked).toEqual(['undone-place'])
    expect(r.fonts.excluded).toEqual([{ family: 'Example Sans', installed: true }])
    expect(r.fonts.missing.map(f => f.family)).toEqual(['Nowhere Serif'])
    expect(r.style.outside).toBe('my-style')
  })

  it('lists a missing file once, as missing, wherever it was', () => {
    const r = portabilityReport(incomplete)
    expect(r.media.missing.map(m => m.media_id)).toEqual(['m4', 'm3'])
    expect(r.media.outside.map(m => m.media_id)).not.toContain('m4')
  })

  it('does not list an untrusted Motif: its files are in the folder', () => {
    const r = portabilityReport(incomplete)
    const listed = [...r.motifs.missing, ...r.motifs.invalid].map(m => m.motif_id)
    expect(listed).not.toContain('received')
    expect(r.motifs.untracked).not.toContain('received')
  })

  it('is portable when nothing comes from outside the folder', () => {
    expect(portabilityReport(nothingOutside).portable).toBe(true)
  })

  it('stays portable with untracked Motif folders, which nothing renders from', () => {
    const r = portabilityReport({ ...nothingOutside, motifFolders: ['title', 'leftover'] })
    expect(r.motifs.untracked).toEqual(['leftover'])
    expect(r.portable).toBe(true)
  })

  it('is not portable with any one outside dependency', () => {
    const one: Partial<PortabilityInputs>[] = [
      { media: [{ ...nothingOutside.media[0]!, path_rel: null }] },
      { media: [{ ...nothingOutside.media[0]!, available: false }] },
      { unavailableMotifs: [{ motif_id: 'title', status: 'missing', diagnostic: 'gone' }] },
      { unavailableMotifs: [{ motif_id: 'title', status: 'invalid', diagnostic: 'no package' }] },
      { excludedFonts: [{ family: 'Example Sans', installed: false }] },
      { missingFonts: [{ family: 'Nowhere Serif', weight: null, italic: null, layer_ids: ['l1'] }] },
      { outsideStyle: 'my-style' },
    ]
    for (const change of one) expect(portabilityReport({ ...nothingOutside, ...change }).portable, JSON.stringify(change)).toBe(false)
  })
})
