// Style Motifs are born in the project's style (spec H2-D2): token-backed
// props on placement, restyle puts them back, and the audit reports drift.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fontStack, motifTokenProps } from './motifProps'
import { tasteView } from './view'
import type { Tokens } from './schema'
import { createActor, type ActorHandle } from '../state/actor'
import { seededGen } from '../state/ids'
import { blankProject, type MotifParams } from '../state/model'
import { root } from '../state/__tests__/fixtures/project'
import { BUILTIN_MANIFESTS, type Manifest } from '../../shared/motifs/catalog'
import { checkComposition } from '../lint/checkComposition'

const BUILTIN = path.join(import.meta.dirname, '../../shared/styles/builtin')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const motif = (id: string) => BUILTIN_MANIFESTS.get(id) ?? null
function view(taste: string, fonts: ReadonlySet<string> | null = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'motif-props-')); roots.push(dir)
  writeFileSync(path.join(dir, 'TASTE.md'), taste)
  return tasteView({ builtin: BUILTIN, user: null }, dir, { motif, fonts })
}
const STYLED = '---\nmotifs: { lower_third: lower-third }\ntokens:\n  palette: { red: "#D2261C" }\n  motif: { accent: red, align: right, nope: 3 }\n  fonts: { headline: [Anton, Impact] }\n---\n'

const schema = (props: Manifest['props_schema']) => ({ props_schema: props })

describe('motifTokenProps', () => {
  const tokens: Tokens = { palette: { red: '#D2261C', glass: '#FFFFFF80' }, motif: { accent: 'red', tint: 'glass', tilt_deg: 12, band: 'ink', label: 'x' }, fonts: { headline: ['Anton', 'Impact'] } }

  it('takes a token only where the schema has the key and the value fits its type', () => {
    expect(motifTokenProps(schema({
      accent: { type: 'color', default: '#000' }, tint: { type: 'color', default: '#000' },
      tilt_deg: { type: 'number', default: 0, min: -8, max: 8 }, band: { type: 'enum', default: 'paper', options: ['paper', 'ink'] },
      label: { type: 'number', default: 1 }, other: { type: 'string', default: '' },
    }), tokens, null)).toEqual({ accent: '#D2261C', tint: '#FFFFFF80', band: 'ink' })
  })

  it('resolves a font slot to its installed families in order, else the whole list', () => {
    const s = schema({ font_headline: { type: 'string', default: 'serif', max_length: 200 } })
    expect(motifTokenProps(s, tokens, new Set(['impact']))).toEqual({ font_headline: "'Impact'" })
    expect(motifTokenProps(s, tokens, new Set(['impact', 'anton']))).toEqual({ font_headline: "'Anton', 'Impact'" })
    expect(motifTokenProps(s, tokens, null)).toEqual({ font_headline: "'Anton', 'Impact'" })
    expect(fontStack(['Noto Sans SC Black'], new Set())).toBe("'Noto Sans SC Black'")
  })
})

describe('the taste view', () => {
  it('merges motif and font tokens and reports which families this machine has', () => {
    const v = view(STYLED, new Set(['impact']))
    expect(v.tokens.motif).toEqual({ accent: 'red', align: 'right', nope: 3 })
    expect(v.fonts).toEqual({ headline: { wanted: ['Anton', 'Impact'], resolved: 'Impact', missing: ['Anton'] } })
    expect(v.provenance['fonts.headline']).toBe('taste')
    expect(view('---\ntokens: { fonts: { headline: ["Anton, Impact"] }, motif: { font_x: a } }\n---\n').diagnostics.map((d) => d.path).sort()).toEqual(['tokens.fonts.headline', 'tokens.motif.font_x'])
  })
})

describe('placing and restyling a style Motif', () => {
  function actor(t: Tokens | null) {
    const gen = seededGen()
    const a = createActor({ initial: blankProject(gen, 'm'), idGen: gen, clock: () => '<TS>', tasteTokens: () => t, installedFonts: () => new Set(['impact']) })
    return a
  }
  const call = (a: ActorHandle, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
  const layer = (a: ActorHandle) => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.params.kind === 'Motif')!
  const props = (a: ActorHandle) => (layer(a).params as MotifParams).props

  it('fills the props the call leaves out from the tokens; explicit props win', () => {
    const tokens = view(STYLED).tokens
    const a = actor(tokens)
    expect(call(a, 'add_motif_layer', { motif_id: 'lower-third', t_start_us: 0, graphic_role: 'lower_third', props: { title: 'Ann' } }).ok).toBe(true)
    expect(props(a)).toMatchObject({ title: 'Ann', accent: '#D2261C', align: 'right' })
    const b = actor(tokens)
    call(b, 'add_motif_layer', { motif_id: 'lower-third', t_start_us: 0, props: { accent: '#00FF00' } })
    expect(props(b)).toMatchObject({ accent: '#00FF00', align: 'right' })
    const plain = actor(null)
    call(plain, 'add_motif_layer', { motif_id: 'lower-third', t_start_us: 0 })
    expect(props(plain)).toMatchObject({ accent: '#ff4d4d', align: 'left' })
  })

  it('restyle_to_taste puts token-backed props back by role, and the audit reports the drift before', () => {
    const v = view(STYLED)
    const a = actor(v.tokens)
    call(a, 'add_motif_layer', { motif_id: 'lower-third', t_start_us: 0, graphic_role: 'lower_third' })
    const id = layer(a).id
    expect(call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Motif', props: { accent: '#00FF00' } } }).ok).toBe(true)
    const snap = a.snapshot()
    const drift = checkComposition(snap, snap.root_id, v).findings.filter((f) => f.rule === 'token-drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]!.message).toContain('accent')
    const r = call(a, 'restyle_to_taste', { graphic_role: 'lower_third' })
    expect(r.ok && JSON.parse(r.result.content[0]!.text)).toEqual({ restyled: [id], unchanged: 0 })
    expect(props(a)).toMatchObject({ accent: '#D2261C' })
    const after = a.snapshot()
    expect(checkComposition(after, after.root_id, v).findings.filter((f) => f.rule === 'token-drift')).toEqual([])
  })
})
