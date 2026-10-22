import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initEval } from '../../renderer/eval'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkComposition, compositionRevision } from './checkComposition'
import { blankProject, newComposition, type Layer, type LayerParams, type Project, type TextParams, type Track } from '../state/model'
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
    const lookup = (id: string) => (SIZES[id] ? { size: SIZES[id], props_schema: {} } : null) as never
    const stat = (value: number) => ({ mode: 'Static' as const, value })
    const placed = (text: ReturnType<typeof setup>['text'], id: string, over: Record<string, unknown>) => {
      const m = motif(text, id, 'lower_third') as Extract<LayerParams, { kind: 'Motif' }>
      return { ...m, transform: { ...m.transform, ...over } } as LayerParams
    }
    const at = (x: number, y: number) => ({ position: { mode: 'XY', x: stat(x), y: stat(y) } })
    const check = (p: Project) => checkComposition(p, p.root_id, styled(), undefined, { motif: lookup }).findings.filter((f) => f.rule === 'motif-off-frame')

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

  describe('overlay-echoes-speech', () => {
    const quoteSchema = { quote: { type: 'string', default: '' }, source: { type: 'string', default: '' }, exit: { type: 'enum', options: ['lift', 'fade'], default: 'lift' }, font_body: { type: 'string', default: '' } }
    const lookup = (id: string) => (id === 'quote' ? { size: [1200, 560], props_schema: quoteSchema } : null) as never
    const withProps = (text: ReturnType<typeof setup>['text'], props: Record<string, unknown>) => ({ ...(motif(text, 'quote', 'callout') as object), props }) as LayerParams
    const echoes = (p: Project) => checkComposition(p, p.root_id, styled(), undefined, { motif: lookup }).findings.filter((f) => f.rule === 'overlay-echoes-speech')

    it('reports a quote card of the line being said, from the captions in its span', () => {
      const { p, bRoll, caption, put, text } = setup()
      put(caption, text('A memory is such\na unique network.'), 32, 34.5)
      put(bRoll, withProps(text, { quote: 'A memory is such a unique network.', source: 'Lisa Genzel, on how memory works', exit: 'lift', font_body: 'Georgia' }), 32.2, 36.8)
      const [f] = echoes(p)
      expect(f).toMatchObject({ severity: 'warning', layers: [p.compositions[p.root_id]!.tracks[1]!.layers[0]!.id] })
      expect(f!.message).toContain('A memory is such a unique network.')
    })

    it('leaves alone what adds to the speech, short titles and names, and anything without captions', () => {
      const { p, bRoll, caption, put, text } = setup()
      put(caption, text('The first hub is the hippocampus,\non the left side and on the right.'), 64, 68)
      put(bRoll, withProps(text, { quote: 'Seahorse-shaped, about 4 cm long, one per hemisphere', source: '' }), 64, 68)
      put(bRoll, text('The hippocampus', { graphic_role: 'title' }), 64, 68)
      put(bRoll, withProps(text, { quote: 'The first hub is the hippocampus', source: '' }), 90, 94)
      expect(echoes(p)).toEqual([])
      const { p: q, bRoll: b2, put: put2, text: text2 } = setup()
      put2(b2, withProps(text2, { quote: 'A memory is such a unique network.', source: '' }), 0, 4)
      expect(echoes(q)).toEqual([])
    })

    it('counts CJK by character', () => {
      const { p, bRoll, caption, put, text } = setup()
      put(caption, text('记忆是一个独特的神经网络'), 0, 3)
      put(bRoll, withProps(text, { quote: '记忆是独特的网络', source: '' }), 0, 3)
      put(bRoll, withProps(text, { quote: '海马体', source: '' }), 0, 3)
      expect(echoes(p)).toHaveLength(1)
    })
  })

  it('still hard-fails an undeclared role on a Motif', () => {
    const { p, bRoll, put, text } = setup()
    put(bRoll, motif(text, 'paper-title', 'mascot'), 0, 4)
    expect(rules(checkComposition(p, p.root_id, styled()))).toEqual(['undeclared-role'])
  })
})

describe('check_composition over Groups and the A roll\'s rhythm (H3)', () => {
  const stat = (value: number) => ({ mode: 'Static' as const, value })
  const lookup = (id: string) => (id === 'headline' ? { size: [1400, 400], props_schema: {} } : null) as never
  const clip = (src0: number, src1: number, over: Record<string, unknown> = {}) =>
    ({ kind: 'VideoClip', media: 'm1', src_in_us: src0 * S, src_out_us: src1 * S, transform: { ...textParamsDefault('x', { width: 1920, height: 1080 } as never).transform, scale_x: stat(1), scale_y: stat(1) }, ...over }) as unknown as LayerParams

  /** A Group on the B roll at `t0`, holding one headline Motif placed at (x, y)
   *  in the Group's own 1920×1080 frame from its 0.5 s for 4 s. */
  function grouped(x: number, y: number, t0: number, groupOver: Record<string, unknown> = {}) {
    const env = setup()
    const { p, bRoll, put, text } = env
    const idGen = uuidV7Gen()
    const cid = idGen()
    const child = newComposition(cid, idGen, 'scene', 1, { width: 1920, height: 1080, fps: { num: 25, den: 1 }, sample_rate: 48000, channels: 2, color_space: p.compositions[p.root_id]!.color_space, background: p.compositions[p.root_id]!.background } as never)
    p.compositions[cid] = child
    const m = { kind: 'Motif', motif_id: 'headline', motif_version: 1, props: {}, src_in_us: 0, transform: { ...text('x').transform, position: { mode: 'XY', x: stat(x), y: stat(y) } }, opacity: stat(1), graphic_role: 'title' } as LayerParams
    const inner: Layer = { id: idGen(), label: null, t_start_us: 0.5 * S, t_end_us: 4.5 * S, enabled: true, locked: false, metadata: {}, params: m, effects: [] }
    child.tracks[0]!.layers.push(inner)
    const g = put(bRoll, { kind: 'CompositionRef', composition: cid, src_in_us: 0, src_out_us: 6 * S, transform: { ...text('x').transform, position: { mode: 'XY', x: stat(960), y: stat(540) }, ...groupOver }, opacity: stat(1), blend_mode: 'Normal' } as LayerParams, t0, t0 + 6)
    return { ...env, inner, g, cid }
  }
  const offFrame = (p: Project) => checkComposition(p, p.root_id, null, undefined, { motif: lookup }).findings.filter((f) => f.rule === 'motif-off-frame')

  it('checks a Group\'s contents in the parent\'s frame and time', () => {
    const { p, inner } = grouped(800, 120, 78.88)
    const [f] = offFrame(p)
    expect(f!.layers).toEqual([inner.id])
    expect(f!.message).toContain('px past the top edge')
    expect(f!.message).toContain('inside the Group at 78.88 s')
    expect(f!.range[0]).toBeCloseTo(79.38 * S, -3)
  })

  it('maps through the Group\'s own transform', () => {
    // Inside its Group the headline is in frame, but the Group is pushed right.
    const { p } = grouped(960, 540, 0, { position: { mode: 'XY', x: stat(1500), y: stat(540) } })
    expect(offFrame(p)[0]!.message).toContain('past the right edge')
    const { p: q } = grouped(960, 540, 0)
    expect(offFrame(q)).toEqual([])
  })

  it('goes stale on an edit inside a Group', () => {
    const { p, inner } = grouped(960, 540, 0)
    const before = compositionRevision(p, p.root_id, null)
    ;(inner.params as { props: Record<string, unknown> }).props = { text: 'changed' }
    expect(compositionRevision(p, p.root_id, null)).not.toBe(before)
  })

  it('reports runs of bare jump cuts, not covered or punched-in ones', () => {
    const { p, aRoll, bRoll, put } = setup()
    // Five clips with the pauses between them cut out: four jump cuts.
    put(aRoll, clip(0, 4), 0, 4); put(aRoll, clip(5, 9), 4, 8); put(aRoll, clip(10, 14), 8, 12); put(aRoll, clip(15, 19), 12, 16); put(aRoll, clip(20, 24), 16, 20)
    const runs = () => checkComposition(p, p.root_id, null).findings.filter((f) => f.rule === 'bare-jump-cuts')
    expect(runs()[0]!.message).toMatch(/^4 jump cuts in 12 s/)
    // Punch in on the third clip: the cuts at 8 and 12 are covered, leaving two.
    const third = p.compositions[p.root_id]!.tracks[0]!.layers[2]!
    const tp = third.params as unknown as { transform: Record<string, unknown> }
    tp.transform = { ...tp.transform, scale_x: stat(1.15), scale_y: stat(1.15) }
    expect(runs()).toEqual([])
    // A scene over the first cut as well: still none.
    put(bRoll, clip(100, 104), 3, 5)
    expect(runs()).toEqual([])
  })

  it('reports a long stretch with nothing but the speaker', () => {
    const { p, aRoll, bRoll, put } = setup()
    put(aRoll, clip(0, 90), 0, 90)
    put(bRoll, clip(200, 204), 40, 44)
    const bare = checkComposition(p, p.root_id, null).findings.filter((f) => f.rule === 'bare-talk')
    expect(bare.map((f) => f.range)).toEqual([[0, 40 * S], [44 * S, 90 * S]])
  })
  it('asks a scene of words alone for a picture', () => {
    const MOTIFS: Record<string, unknown> = {
      headline: { size: [1400, 400], props_schema: { text: { type: 'string', default: '' } } },
      sticker: { size: [900, 760], graphic_role: 'illustration', props_schema: { photo: { type: 'media', default: '' } } },
    }
    const motifs = (id: string) => (MOTIFS[id] ?? null) as never
    const { p, inner, cid } = grouped(960, 540, 10)
    ;(inner.params as { props: Record<string, unknown> }).props = { text: 'HIPPOCAMPUS' }
    const scene = p.compositions[cid]!
    const second: Layer = { ...structuredClone(inner), id: 'tag' }
    scene.tracks[1]!.layers.push(second)
    const asks = () => checkComposition(p, p.root_id, null, undefined, { motif: motifs }).findings.filter((f) => f.rule === 'scene-all-words')
    expect(asks().map((f) => [f.severity, f.message])).toEqual([['review', 'scene of 2 layers shows only words: no photo, still or drawing']])
    // A sticker, even one drawing its own art, is a picture.
    second.params = { ...second.params, motif_id: 'sticker', props: {} } as LayerParams
    expect(asks()).toEqual([])
    // Without Motif manifests, nothing is judged.
    second.params = { ...second.params, motif_id: 'headline', props: { text: 'TAG' } } as LayerParams
    expect(checkComposition(p, p.root_id, null).findings.filter((f) => f.rule === 'scene-all-words')).toEqual([])
  })
})
