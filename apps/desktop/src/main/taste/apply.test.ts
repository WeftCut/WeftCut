import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { roleTokens, resolveColor, styleText } from './apply'
import { tasteView } from './view'
import { textParamsDefault } from '../state/mutations/add'

const tokens = tasteView({ builtin: path.join(import.meta.dirname, '../../shared/styles/builtin'), user: null }, null).tokens

describe('styleText', () => {
  it('leaves untagged text exactly as the long-standing default', () => {
    const comp = { width: 1920, height: 1080 }
    const base = textParamsDefault('hi', comp)
    expect(styleText(base, roleTokens(tokens, null), tokens, comp)).toEqual(base)
  })

  it('builds a title from its tokens, scaled to a 4K frame', () => {
    const comp = { width: 3840, height: 2160 }
    const t = styleText(textParamsDefault('Title', comp), roleTokens(tokens, 'title'), tokens, comp, 'Inter')
    expect(t.font).toEqual({ family: 'Inter', size_px: 192, weight: 700, italic: false })
    expect(t.transform.position).toEqual({ mode: 'XY', x: { mode: 'Static', value: 1920 }, y: { mode: 'Static', value: 345.6 } })
    expect(t.box_w).toBe(3072)
    expect(t.outline).toEqual({ color: { r: 0, g: 0, b: 0, a: 255 }, width: 6 })
    expect(t.shadow).toEqual({ color: { r: 0, g: 0, b: 0, a: 0x99 }, offset_x: 0, offset_y: 8, blur: 24 })
    expect([t.intro, t.outro]).toEqual(['FadeIn', 'FadeOut'])
  })

  it('falls back to none for a custom role with no tokens, and resolves palette names', () => {
    expect(roleTokens(tokens, 'chapter_card')).toBe(tokens.text!.none)
    expect(resolveColor(tokens, 'accent')).toEqual({ r: 0xff, g: 0xd2, b: 0x3f, a: 255 })
    expect(resolveColor(tokens, 'nope')).toBeNull()
  })
})
