// apps/desktop/src/main/taste/apply.ts
//
// Tokens → layer params: what makes a layer born in style (Q9, spec H1-D4).
// Pure. The actor asks for the merged tokens at creation time and lays the
// role's tokens over the default Text params; a token the style leaves out
// keeps the default, and an explicit argument from the caller wins over both.
//
// Pixel tokens are for a 1080-pixel-tall frame and scale with the composition
// height; positions and box widths are fractions of the composition.

import type { Outline, Rgba, Shadow, TextParams } from '../state/model'
import { quantizeExtentPx, quantizeParam } from '../state/quantize'
import type { CaptionTokens, ColorToken, OutlineToken, ShadowToken, TextTokens, Tokens } from './schema'

const REF_HEIGHT = 1080

/** `#RRGGBB[AA]` or a palette name → Rgba; null when it resolves to nothing
 *  (the view already dropped such a token, so this is belt and braces). */
export function resolveColor(tokens: Tokens, c: ColorToken): Rgba | null {
  const hex = c.startsWith('#') ? c : tokens.palette?.[c]
  if (!hex) return null
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16)
  return { r: n(1), g: n(3), b: n(5), a: hex.length === 9 ? n(7) : 255 }
}

const px = (v: number, scale: number) => Math.round(v * scale * 100) / 100

function outline(tokens: Tokens, o: OutlineToken | null, scale: number): Outline | null | undefined {
  if (o === null) return null
  const color = resolveColor(tokens, o.color)
  return color ? { color, width: px(o.width, scale) } : undefined
}

function shadow(tokens: Tokens, s: ShadowToken | null, scale: number): Shadow | null | undefined {
  if (s === null) return null
  const color = resolveColor(tokens, s.color)
  return color ? { color, offset_x: px(s.offset_x, scale), offset_y: px(s.offset_y, scale), blur: px(s.blur, scale) } : undefined
}

/** The styled fields of `base` replaced by `t`'s, for a composition of the
 *  given size. `appFont` stands in for a null family (the app's default text
 *  font setting, else the bundled face `base` already carries). */
export function styleText(base: TextParams, t: TextTokens | CaptionTokens | undefined, tokens: Tokens, comp: { width: number; height: number }, appFont?: string): TextParams {
  if (!t) return base
  const scale = comp.height / REF_HEIGHT
  const out: TextParams = { ...base, font: { ...base.font }, transform: { ...base.transform } }
  if (t.family !== undefined) out.font.family = t.family ?? appFont ?? base.font.family
  if (t.size_px !== undefined) out.font.size_px = px(t.size_px, scale)
  if (t.weight !== undefined) out.font.weight = t.weight
  if (t.italic !== undefined) out.font.italic = t.italic
  if (t.color !== undefined) { const c = resolveColor(tokens, t.color); if (c) out.color = { mode: 'Static', value: c } }
  if ('align' in t && t.align !== undefined) out.align = t.align
  if (t.position !== undefined) out.transform.position = { mode: 'XY', x: { mode: 'Static', value: quantizeParam('x', t.position[0] * comp.width) }, y: { mode: 'Static', value: quantizeParam('y', t.position[1] * comp.height) } }
  if (t.anchor !== undefined) { out.transform.anchor_x = { mode: 'Static', value: t.anchor[0] }; out.transform.anchor_y = { mode: 'Static', value: t.anchor[1] } }
  if (t.box_w !== undefined) out.box_w = t.box_w === null ? null : quantizeExtentPx(t.box_w * comp.width)
  if (t.outline !== undefined) { const o = outline(tokens, t.outline, scale); if (o !== undefined) out.outline = o }
  if (t.shadow !== undefined) { const s = shadow(tokens, t.shadow, scale); if (s !== undefined) out.shadow = s }
  if ('intro' in t && t.intro !== undefined) out.intro = t.intro
  if ('outro' in t && t.outro !== undefined) out.outro = t.outro
  return out
}

/** The text tokens for a role: the role's own, else `none`'s for an untagged
 *  layer. A custom role with no tokens takes `none`'s too. */
export function roleTokens(tokens: Tokens | null, role: string | null): TextTokens | undefined {
  if (!tokens?.text) return undefined
  return (role !== null ? tokens.text[role] : undefined) ?? tokens.text.none
}
