// apps/desktop/src/main/taste/motifProps.ts
//
// Tokens → Motif props (spec H2-D2): what makes a style Motif born in the
// project's style. Pure. A prop takes a token only when the Motif's schema
// has that key and the value fits the prop's type; everything else keeps the
// manifest default, and an explicit prop from the caller wins over both.
//
// Font props (`font_<slot>`) take the slot's families that are installed here,
// in the list's order, so frames and cache keys follow what actually renders
// and a family without some glyphs (a Latin face, CJK text) still falls back
// to the next installed one. Without the installed list, or with none of the
// families installed, the prop gets the whole list.

import type { Manifest, PropSpec } from '../../shared/motifs/catalog'
import { resolveColor } from './apply'
import type { Tokens } from './schema'

const hex2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase()

function colorValue(tokens: Tokens, v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const c = resolveColor(tokens, v)
  return c ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a === 255 ? '' : hex2(c.a)}` : undefined
}

/** A slot's families as a `font-family` value: the installed ones in order,
 *  else the whole list. */
export function fontStack(families: readonly string[], installed: ReadonlySet<string> | null): string {
  const found = installed ? families.filter((f) => installed.has(f.toLowerCase())) : []
  return (found.length ? found : families).map((f) => `'${f}'`).join(', ')
}

function fits(spec: PropSpec, v: unknown): boolean {
  switch (spec.type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v) && (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max)
    case 'enum': return typeof v === 'string' && spec.options.includes(v)
    case 'string': return typeof v === 'string' && (spec.max_length === undefined || [...v].length <= spec.max_length)
    case 'color': return typeof v === 'string'
    case 'media': return false
  }
  return false
}

/** The props `manifest` takes from `tokens`, keyed by prop. `step_fps` is
 *  the motion group; every other token-backed prop is look. */
export function motifTokenProps(manifest: Pick<Manifest, 'props_schema'>, tokens: Tokens | null, installed: ReadonlySet<string> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!tokens) return out
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    if (key.startsWith('font_') && spec.type === 'string') {
      const families = tokens.fonts?.[key.slice(5)]
      if (families) { const v = fontStack(families, installed); if (fits(spec, v)) out[key] = v }
      continue
    }
    const raw = tokens.motif?.[key]
    if (raw === undefined) continue
    const v = spec.type === 'color' ? colorValue(tokens, raw) : raw
    if (v !== undefined && fits(spec, v)) out[key] = v
  }
  return out
}

export const MOTION_PROPS: ReadonlySet<string> = new Set(['step_fps'])
