import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initEval } from '../../renderer/eval'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkComposition } from './checkComposition'
import { blankProject, type Layer, type LayerParams, type Project, type TextParams, type Track } from '../state/model'
import { uuidV7Gen } from '../state/ids'
import { textParamsDefault } from '../state/mutations/add'
import { tasteView } from '../taste/view'

const BUILTIN = path.join(import.meta.dirname, '../../shared/styles/builtin')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const S = 1_000_000
beforeAll(initEval)

function setup() {
  const idGen = uuidV7Gen()
  const p: Project = blankProject(idGen, 'lint')
  const comp = p.compositions[p.root_id]!
  comp.width = 1920; comp.height = 1080
  const [aRoll, bRoll] = comp.tracks
  const caption: Track = { ...structuredClone(aRoll!), id: idGen(), role: 'Caption', layers: [] }
  comp.tracks.push(caption)
  const put = (track: typeof caption, params: LayerParams, t0: number, t1: number): Layer => {
    const l: Layer = { id: idGen(), label: null, t_start_us: t0 * S, t_end_us: t1 * S, enabled: true, locked: false, metadata: {}, params, effects: [] }
    track.layers.push(l)
    return l
  }
  const text = (content: string, over: Partial<TextParams> & { graphic_role?: string | null } = {}) =>
    ({ ...textParamsDefault(content, comp), ...over }) as TextParams
  return { p, comp, aRoll: aRoll!, bRoll: bRoll!, caption, put, text }
}
const taste = (md?: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lint-')); roots.push(dir)
  if (md) writeFileSync(path.join(dir, 'TASTE.md'), md)
  return tasteView({ builtin: BUILTIN, user: null }, dir)
}
const rules = (r: ReturnType<typeof checkComposition>) => r.findings.map((f) => f.rule).sort()

describe('check_composition v1', () => {
  it('a styled title and lower third held long enough raise nothing', () => {
    const { p, bRoll, put, text } = setup()
    const t = taste()
    const title = t.tokens.text!.title!, lower = t.tokens.text!.lower_third!
    put(bRoll, text('A title', { graphic_role: 'title', font: { family: 'Liberation Sans, Noto Sans SC', size_px: title.size_px!, weight: title.weight!, italic: false }, intro: 'FadeIn', outro: 'FadeOut',
      transform: { ...text('x').transform, position: { mode: 'XY', x: { mode: 'Static', value: 960 }, y: { mode: 'Static', value: 170 } } } }), 0, 4)
    put(bRoll, text('Ada Lovelace\nAnalyst', { graphic_role: 'lower_third', align: 'Left', font: { family: 'Liberation Sans, Noto Sans SC', size_px: lower.size_px!, weight: lower.weight!, italic: false }, intro: 'SlideUp', outro: 'FadeOut',
      transform: { ...text('x').transform, anchor_x: { mode: 'Static', value: 0 }, anchor_y: { mode: 'Static', value: 1 }, position: { mode: 'XY', x: { mode: 'Static', value: 154 }, y: { mode: 'Static', value: 907 } } } }), 5, 10)
    const r = checkComposition(p, p.root_id, t)
    expect(r.findings).toEqual([])
    expect(r.counts).toEqual({ hard: 0, warning: 0, review: 0 })
  })

  it('reports the baseline defaults: a 2 s lower third that pops, a centred untagged-size title that pops', () => {
    const { p, bRoll, put, text } = setup()
    put(bRoll, text('Title', { graphic_role: 'title' }), 0, 2)
    put(bRoll, text('Name\nRole', { graphic_role: 'lower_third' }), 3, 5)
    const r = checkComposition(p, p.root_id, taste())
    expect(rules(r)).toEqual(['lower-third-hold', 'text-pops', 'text-pops', 'title-hold', 'token-drift', 'token-drift'])
    const hold = r.findings.find((f) => f.rule === 'lower-third-hold')!
    expect(hold).toMatchObject({ severity: 'warning', range: [3 * S, 5 * S] })
    expect(hold.message).toContain('under 4 s')
    expect(r.findings.find((f) => f.rule === 'token-drift')!.severity).toBe('review')
  })

  it('checks captions against the craft numbers, tightened by the style', () => {
    const { p, caption, put, text } = setup()
    put(caption, text('This transcription cue runs on far past what one caption line should hold'), 0, 3)
    put(caption, text('Too quick'), 3, 3.4)
    put(caption, text('one\ntwo\nthree'), 4, 12)
    const r = checkComposition(p, p.root_id, taste())
    expect(rules(r)).toEqual(['caption-cue-max', 'caption-cue-min', 'caption-line-length', 'caption-lines'])
    const tighter = checkComposition(p, p.root_id, taste('---\ntokens:\n  caption: { max_chars_per_line: 8 }\n---\n'))
    expect(tighter.findings.filter((f) => f.rule === 'caption-line-length')).toHaveLength(2)
    const looser = checkComposition(p, p.root_id, taste('---\ntokens:\n  floors: { caption-line-length: 100 }\n---\n'))
    expect(looser.findings.filter((f) => f.rule === 'caption-line-length')).toHaveLength(1)
  })

  it('flags A-roll fragments under 1 s but not B-roll inserts', () => {
    const { p, aRoll, bRoll, put } = setup()
    put(aRoll, { kind: 'VideoClip' } as LayerParams, 0, 0.4)
    put(aRoll, { kind: 'VideoClip' } as LayerParams, 0.4, 3)
    put(bRoll, { kind: 'VideoClip' } as LayerParams, 1, 1.5)
    const r = checkComposition(p, p.root_id, taste())
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'short-clip', range: [0, 0.4 * S] })])
  })

  it('hard-fails an undeclared role and text wholly off frame', () => {
    const { p, bRoll, put, text } = setup()
    put(bRoll, text('x', { graphic_role: 'chapter_card' }), 0, 4)
    put(bRoll, text('gone', { transform: { ...text('x').transform, position: { mode: 'XY', x: { mode: 'Static', value: 4000 }, y: { mode: 'Static', value: 540 } } } }), 0, 4)
    const r = checkComposition(p, p.root_id, taste())
    expect(r.findings.filter((f) => f.severity === 'hard').map((f) => f.rule).sort()).toEqual(['text-offscreen', 'undeclared-role'])
    const declared = checkComposition(p, p.root_id, taste('---\nroles: [chapter_card]\n---\n'))
    expect(declared.findings.map((f) => f.rule)).not.toContain('undeclared-role')
  })

  it('reports one role in two looks once, naming both', () => {
    const { p, bRoll, put, text } = setup()
    const base = { graphic_role: 'callout', intro: 'FadeIn' as const, outro: 'FadeOut' as const }
    put(bRoll, text('A', { ...base, font: { family: 'Liberation Sans, Noto Sans SC', size_px: 44, weight: 600, italic: false } }), 0, 3)
    put(bRoll, text('B', { ...base, font: { family: 'Liberation Sans, Noto Sans SC', size_px: 60, weight: 600, italic: false } }), 4, 7)
    const r = checkComposition(p, p.root_id, taste())
    const f = r.findings.filter((x) => x.rule === 'role-inconsistency')
    expect(f).toHaveLength(1)
    expect(f[0]!.layers).toHaveLength(2)
    expect(f[0]!.message).toContain('2 looks')
  })

  it('keeps the revision while nothing changes, and narrows to a range', () => {
    const { p, bRoll, put, text } = setup()
    put(bRoll, text('Title', { graphic_role: 'title' }), 0, 2)
    put(bRoll, text('Later', { graphic_role: 'title' }), 20, 21)
    const t = taste()
    const a = checkComposition(p, p.root_id, t)
    expect(checkComposition(p, p.root_id, t).revision).toBe(a.revision)
    expect(checkComposition(p, p.root_id, t, [15 * S, 30 * S]).findings.every((f) => f.range[0] >= 20 * S)).toBe(true)
    p.compositions[p.root_id]!.tracks[1]!.layers[0]!.t_end_us = 5 * S
    expect(checkComposition(p, p.root_id, t).revision).not.toBe(a.revision)
  })
})

describe('check_composition over Motif layers (H2)', () => {
  const motif = (text: ReturnType<typeof setup>['text'], motif_id: string, graphic_role: string | null) =>
    ({ kind: 'Motif', motif_id, motif_version: 1, props: {}, src_in_us: 0, transform: text('x').transform, opacity: { mode: 'Static', value: 1 }, graphic_role }) as LayerParams
  const styled = () => taste('---\nmotifs: { title: paper-title, lower_third: paper-label }\n---\n')

  it('holds Motif titles and lower thirds to the craft numbers, without asking a Motif for intro or outro', () => {
    const { p, bRoll, put, text } = setup()
    put(bRoll, motif(text, 'paper-title', 'title'), 0, 2)
    put(bRoll, motif(text, 'paper-label', 'lower_third'), 3, 10)
    expect(rules(checkComposition(p, p.root_id, styled()))).toEqual(['title-hold'])
  })

  it('leaves the choice of Motif to the agent: plain text and two different title Motifs raise nothing', () => {
    const { p, bRoll, put, text } = setup()
    put(bRoll, text('A title', { graphic_role: 'title', intro: 'FadeIn', outro: 'FadeOut' }), 0, 4)
    put(bRoll, motif(text, 'paper-title', 'title'), 5, 9)
    put(bRoll, motif(text, 'big-title', 'title'), 10, 14)
    const found = rules(checkComposition(p, p.root_id, styled()))
    expect(found).not.toContain('role-inconsistency')
    expect(found).not.toContain('role-motif')
  })

  describe('motif-off-frame', () => {
    const SIZES: Record<string, [number, number]> = { stamp: [1100, 300], plate: [1920, 1080] }
    const motifSize = (id: string) => SIZES[id] ?? null
    const stat = (value: number) => ({ mode: 'Static' as const, value })
    const placed = (text: ReturnType<typeof setup>['text'], id: string, over: Record<string, unknown>) => {
      const m = motif(text, id, 'lower_third') as Extract<LayerParams, { kind: 'Motif' }>
      return { ...m, transform: { ...m.transform, ...over } } as LayerParams
    }
    const at = (x: number, y: number) => ({ position: { mode: 'XY', x: stat(x), y: stat(y) } })
    const check = (p: Project) => checkComposition(p, p.root_id, styled(), undefined, { motifSize }).findings.filter((f) => f.rule === 'motif-off-frame')

    it('reports a canvas placed with its centre near the edge, from the real anchor', () => {
      const { p, bRoll, put, text } = setup()
      put(bRoll, placed(text, 'stamp', at(330, 700)), 1, 6)
      const [f] = check(p)
      expect(f).toMatchObject({ severity: 'warning', range: [1 * S, 6 * S] })
      expect(f!.message).toContain('220 px past the left edge')
      // The same x with the anchor on the left edge keeps it in.
      const { p: q, bRoll: b2, put: put2, text: text2 } = setup()
      put2(b2, placed(text2, 'stamp', { ...at(330, 700), anchor_x: stat(0) }), 1, 6)
      expect(check(q)).toEqual([])
    })

    it('turns the canvas about its anchor and scales it', () => {
      const { p, bRoll, put, text } = setup()
      put(bRoll, placed(text, 'stamp', { ...at(960, 1000), scale_x: stat(0.5), scale_y: stat(0.5) }), 0, 4)
      expect(check(p)).toEqual([])
      const { p: q, bRoll: b2, put: put2, text: text2 } = setup()
      put2(b2, placed(text2, 'stamp', { ...at(960, 1000), scale_x: stat(0.5), scale_y: stat(0.5), rotation_deg: stat(30) }), 0, 4)
      expect(check(q)[0]!.message).toContain('past the bottom edge')
    })

    it('checks every keyframe inside the layer, not just the first value', () => {
      const { p, bRoll, put, text } = setup()
      const key = (t_us: number, value: number, i: number) => ({ id: `10000000-0000-4000-8000-00000000000${i}`, t_us, value, segment: { kind: 'Linear' }, continuity: 'Broken',
        in: { x: 0.7, y: 0.85, mode: 'Free' }, out: { x: 0.3, y: 0.1, mode: 'Free' } })
      const x = { mode: 'Keyframed', extrapolate: { before: 'Hold', after: 'Hold' }, value: [key(0, 960, 1), key(3 * S, 1800, 2)] }
      put(bRoll, placed(text, 'stamp', { position: { mode: 'XY', x, y: stat(700) } }), 0, 4)
      expect(check(p)[0]!.message).toContain('past the right edge at 3 s')
    })

    it('leaves a full-frame plate alone, and a Motif it cannot size', () => {
      const { p, bRoll, put, text } = setup()
      put(bRoll, placed(text, 'plate', { ...at(960, 540), scale_x: stat(1.1), scale_y: stat(1.1) }), 0, 4)
      put(bRoll, placed(text, 'unknown', at(0, 0)), 0, 4)
      expect(check(p)).toEqual([])
    })
  })

  it('still hard-fails an undeclared role on a Motif', () => {
    const { p, bRoll, put, text } = setup()
    put(bRoll, motif(text, 'paper-title', 'mascot'), 0, 4)
    expect(rules(checkComposition(p, p.root_id, styled()))).toEqual(['undeclared-role'])
  })
})
