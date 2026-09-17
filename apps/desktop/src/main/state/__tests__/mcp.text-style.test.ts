// apps/desktop/src/main/state/__tests__/mcp.text-style.test.ts
// The Text face and shadow through update_layer_params (audit §3: readable,
// unwritable). `background` is not in the model and is deliberately absent.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type TextParams } from '../model'
import { root } from './fixtures/project'

function withTitle() {
  const gen = seededGen()
  const a = createActor({ initial: blankProject(gen, 'text'), idGen: gen, clock: () => '<TS>' })
  const r = a.mcpCall('add_text_layer', JSON.stringify({ track_id: root(a.snapshot()).tracks[1].id, content: 'Hi', t_start_us: 0, t_end_us: 1_000_000 }))
  if (!r.ok) throw new Error(r.error.message)
  return { a, id: (JSON.parse(r.result.content[0].text) as { layer_id: string }).layer_id }
}
const patch = (a: ActorHandle, id: string, p: Record<string, unknown>) => a.mcpCall('update_layer_params', JSON.stringify({ layer_id: id, patch: { kind: 'Text', ...p } }))
const text = (a: ActorHandle, id: string): TextParams => root(a.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!.params as TextParams
const SHADOW = { color: { r: 0, g: 0, b: 0, a: 160 }, offset_x: 2, offset_y: 3, blur: 4 }

describe('Text face and shadow', () => {
  it('font_weight and italic write the face; a shadow record lands whole and null removes it', () => {
    const { a, id } = withTitle()
    expect(patch(a, id, { font_weight: 700, italic: true, shadow: SHADOW }).ok).toBe(true)
    const t = text(a, id)
    expect(t.font.weight).toBe(700)
    expect(t.font.italic).toBe(true)
    expect(t.shadow).toEqual(SHADOW)
    expect(patch(a, id, { shadow: null }).ok).toBe(true)
    expect(text(a, id).shadow).toBeNull()
  })

  it('refuses a weight off the CSS scale, a shadow with a negative blur, and a shadow field it does not know — writing nothing', () => {
    const { a, id } = withTitle()
    const before = text(a, id)
    const weight = patch(a, id, { font_weight: 950, italic: true })
    expect(!weight.ok && weight.error.message).toContain('100 to 900')
    const blur = patch(a, id, { shadow: { ...SHADOW, blur: -1 } })
    expect(!blur.ok && blur.error.message).toContain('shadow.blur')
    const unknown = patch(a, id, { shadow: { ...SHADOW, spread: 2 } })
    expect(!unknown.ok && unknown.error.message).toContain('spread')
    expect(text(a, id)).toEqual(before) // italic from the refused patch did not land either
  })

  it('a shadow missing a field is refused naming it, and a non-Text kind has no shadow', () => {
    const { a, id } = withTitle()
    const partial = patch(a, id, { shadow: { color: SHADOW.color, offset_x: 1, offset_y: 1 } })
    expect(!partial.ok && partial.error.message).toContain('blur')
    const c = a.mcpCall('add_color_layer', JSON.stringify({ track_id: root(a.snapshot()).tracks[0].id, color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }))
    if (!c.ok) throw new Error(c.error.message)
    const colorId = (JSON.parse(c.result.content[0].text) as { layer_id: string }).layer_id
    const r = a.mcpCall('update_layer_params', JSON.stringify({ layer_id: colorId, patch: { kind: 'Color', shadow: SHADOW } }))
    expect(!r.ok && r.error.message).toContain('not a Color param')
  })
})
