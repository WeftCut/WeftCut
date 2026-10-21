// apps/desktop/src/main/state/__tests__/mcp.taste-defaults.test.ts
// Layers are born in the project's style (Q9, spec H1-D4): add_text_layer by
// graphic role, apply_transcripts by the caption tokens, and restyle_to_taste
// puts layers back. The default style changes nothing a user made untagged,
// and reproduces today's transcript captions exactly.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type TextParams } from '../model'
import { root } from './fixtures/project'
import { tasteView } from '../../taste/view'
import type { Tokens } from '../../taste/schema'

const BUILTIN = path.join(import.meta.dirname, '../../../shared/styles/builtin')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function tokens(taste?: string): Tokens {
  const dir = mkdtempSync(path.join(tmpdir(), 'taste-defaults-')); roots.push(dir)
  if (taste) writeFileSync(path.join(dir, 'TASTE.md'), taste)
  return tasteView({ builtin: BUILTIN, user: null }, dir).tokens
}
const call = (a: ActorHandle, tool: string, args: Record<string, unknown>) => a.mcpCall(tool, JSON.stringify(args))
const body = <T,>(r: ReturnType<ActorHandle['mcpCall']>): T => { if (!r.ok) throw new Error(r.error.message); return JSON.parse(r.result.content[0].text) as T }
function actor(t: Tokens | null) {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'taste'), idGen: gen, clock: () => '<TS>', tasteTokens: () => t })
  return { a, bRoll: root(a.snapshot()).tracks[1]!.id }
}
const text = (a: ActorHandle, id: string) => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!.params as TextParams
const addText = (a: ActorHandle, track: string, extra: Record<string, unknown> = {}) =>
  body<{ layer_id: string }>(call(a, 'add_text_layer', { track_id: track, content: 'Hi', t_start_us: 0, t_end_us: 4_000_000, ...extra })).layer_id

describe('add_text_layer is born in the style', () => {
  it('leaves untagged text exactly as it was without a style', () => {
    const styled = actor(tokens()), plain = actor(null)
    expect(text(styled.a, addText(styled.a, styled.bRoll))).toEqual(text(plain.a, addText(plain.a, plain.bRoll)))
  })

  it('gives a title its role tokens, and explicit x/y still win', () => {
    const { a, bRoll } = actor(tokens('---\ntokens:\n  text:\n    title: { size_px: 110 }\n---\n'))
    const t = text(a, addText(a, bRoll, { graphic_role: 'title' }))
    expect(t).toMatchObject({ graphic_role: 'title', font: { size_px: 110, weight: 700 }, intro: 'FadeIn', outro: 'FadeOut', align: 'Center' })
    expect(t.transform.position).toEqual({ mode: 'XY', x: { mode: 'Static', value: 960 }, y: { mode: 'Static', value: 172.8 } })
    const placed = text(a, addText(a, bRoll, { graphic_role: 'title', x: 400, y: 300, t_start_us: 5_000_000, t_end_us: 9_000_000 }))
    expect(placed.transform.position).toEqual({ mode: 'XY', x: { mode: 'Static', value: 400 }, y: { mode: 'Static', value: 300 } })
  })
})

describe('apply_transcripts is born in the caption tokens', () => {
  const transcripts = { transcripts: [{ word_timing: 'none', segments: [{ text: 'One cue', t_start_us: 0, t_end_us: 2_000_000, words: [] }] }] }
  const cue = (a: ActorHandle) => root(a.snapshot()).tracks.find((t) => t.role === 'Caption')!.layers[0]!.params as TextParams

  it('reproduces the transcription look exactly under the default style', () => {
    const styled = actor(tokens()), plain = actor(null)
    call(styled.a, 'apply_transcripts', transcripts); call(plain.a, 'apply_transcripts', transcripts)
    expect(cue(styled.a)).toEqual(cue(plain.a))
  })

  it('takes a TASTE caption override', () => {
    const { a } = actor(tokens('---\ntokens:\n  caption: { size_px: 64, weight: 700 }\n---\n'))
    call(a, 'apply_transcripts', transcripts)
    expect(cue(a).font).toMatchObject({ size_px: 64, weight: 700 })
  })
})

describe('restyle_to_taste', () => {
  it('puts look and motion back by role and keeps the placement unless asked', () => {
    const { a, bRoll } = actor(tokens())
    const id = addText(a, bRoll, { graphic_role: 'lower_third' })
    call(a, 'update_layer_params', { layer_id: id, patch: { kind: 'Text', font_size_px: 90, outro: null, x: 50, y: 50 } })
    const r = body<{ restyled: string[]; unchanged: number }>(call(a, 'restyle_to_taste', { graphic_role: 'lower_third' }))
    expect(r).toEqual({ restyled: [id], unchanged: 0 })
    expect(text(a, id)).toMatchObject({ font: { size_px: 48 }, outro: 'FadeOut' })
    expect(text(a, id).transform.position).toMatchObject({ x: { value: 50 }, y: { value: 50 } })
    body(call(a, 'restyle_to_taste', { layer_ids: [id], groups: ['position'] }))
    expect(text(a, id).transform.position).toMatchObject({ x: { value: 153.6 }, y: { value: 907.2 } })
    expect(body<{ unchanged: number }>(call(a, 'restyle_to_taste', { layer_ids: [id], groups: ['look', 'position', 'motion'] })).unchanged).toBe(1)
  })

  it('refuses an ambiguous selection and a non-text layer, and needs a style', () => {
    const { a, bRoll } = actor(tokens())
    expect(call(a, 'restyle_to_taste', { captions: true, graphic_role: 'title' }).ok).toBe(false)
    const color = body<{ layer_id: string }>(call(a, 'add_color_layer', { track_id: bRoll, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 10_000_000, t_end_us: 11_000_000 })).layer_id
    expect(call(a, 'restyle_to_taste', { layer_ids: [color] }).ok).toBe(false)
    const bare = actor(null)
    expect(call(bare.a, 'restyle_to_taste', { captions: true }).ok).toBe(false)
  })
})
