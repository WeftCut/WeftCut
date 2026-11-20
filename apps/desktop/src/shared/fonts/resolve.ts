// Which catalog face draws a (family, weight, italic) request: one pure rule
// shared by main (what to copy into Fonts/) and the renderer (what to register
// and draw), so both pick the same face. Bundled families (../fonts.ts) and
// CSS generic families are never resolved here; callers fall back to them.
// Which leaves count as missing is ./missing.ts.

import { BUNDLED_FONT_FAMILIES } from '../fonts'
import type { FaceSource, FaceWeight } from './types'

/** The fields matching reads; FaceRecord and FaceIndexEntry both carry them. */
type Matchable = { families: readonly string[]; weight: FaceWeight; italic: boolean; source: FaceSource }

/** The leaves of a CSS font-family list, in order: commas split (outside
 *  quotes), quotes and surrounding whitespace stripped, whitespace runs inside
 *  an unquoted name collapsed to one space, empty leaves dropped. */
export function parseFamilyList(css: string): string[] {
  const out: string[] = []
  let leaf = ''
  // The leaf is a quoted string; text after its closing quote is dropped.
  let quoted = false
  let quote: string | null = null
  const flush = () => {
    const name = quoted ? leaf.trim() : leaf.trim().replace(/\s+/g, ' ')
    if (name) out.push(name)
    leaf = ''
    quoted = false
  }
  for (const ch of css) {
    if (quote) {
      if (ch === quote) quote = null
      else leaf += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
      leaf = ''
    } else if (ch === ',') {
      flush()
    } else if (!quoted) {
      leaf += ch
    }
  }
  flush()
  return out
}

const BUNDLED = new Set(BUNDLED_FONT_FAMILIES.map(f => f.toLowerCase()))

export function isBundledFamily(family: string): boolean {
  return BUNDLED.has(family.trim().toLowerCase())
}

/** The CSS generic families. They name no catalog face, so they are never
 *  collected and never missing: in a Text layer the bundled chain draws in
 *  their place, and in a Motif the capture browser maps them. A walk through
 *  a family list stops at one, as at a bundled family. */
export const GENERIC_FONT_FAMILIES: readonly string[] = [
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math', 'emoji', 'fangsong',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
]

const GENERIC = new Set(GENERIC_FONT_FAMILIES)

export function isGenericFamily(family: string): boolean {
  return GENERIC.has(family.trim().toLowerCase())
}

/** The weight a request asks for: a stored 0 (unset) is Regular. Every
 *  caller of `resolveFace` passes a layer's weight through here. */
export function requestWeight(weight: number | null | undefined): number {
  return weight || 400
}

/** The italic a request asks for: anything but `true` is upright. */
export function requestItalic(italic: boolean | null | undefined): boolean {
  return italic === true
}

/** The family name a renderer registers a catalog face under: one alias per
 *  face, so faces of one family from different sources never merge in a
 *  FontFaceSet. */
export function faceAlias(sha256: string): string {
  return `wf-${sha256.slice(0, 16)}`
}

function hasFamily(face: Matchable, family: string): boolean {
  const key = family.trim().toLowerCase()
  return face.families.some(f => f.toLowerCase() === key)
}

function sameIdentity(a: Matchable, b: Matchable): boolean {
  if (a.italic !== b.italic) return false
  if (typeof a.weight === 'number' || typeof b.weight === 'number') return a.weight === b.weight
  return a.weight[0] === b.weight[0] && a.weight[1] === b.weight[1]
}

/** Every face that answers to `family`: the project's faces, then each system
 *  face no project face of the same weight and italic replaces. Empty for a
 *  bundled, generic or unknown family.
 *
 *  Sources merge rather than the project shadowing the whole family: a project
 *  holding only some faces of a family still reaches the system's others, so
 *  the copier sees them as used and collects them. */
export function familyFaces<F extends Matchable>(faces: readonly F[], family: string): F[] {
  if (isBundledFamily(family) || isGenericFamily(family)) return []
  const matching = faces.filter(f => hasFamily(f, family))
  const project = matching.filter(f => f.source === 'project')
  const system = matching.filter(f => f.source === 'system' && !project.some(p => sameIdentity(p, f)))
  return [...project, ...system]
}

/** The face CSS Fonts 4 §5.2 font matching picks for `family` at `weight`
 *  and `italic`, among `familyFaces`; null when the family has none.
 *  Style narrows first (italic wants italic, then upright; upright wants
 *  upright, then italic), then weight (`weightRank`); among equal matches the
 *  earlier face in `familyFaces` order wins, which puts project faces first. */
export function resolveFace<F extends Matchable>(faces: readonly F[], family: string, weight: number, italic: boolean): F | null {
  let best: F | null = null
  let bestKey: number[] = []
  for (const face of familyFaces(faces, family)) {
    const key = [face.italic === italic ? 0 : 1, weightRank(weight, face.weight)]
    if (!best || lexicographicLess(key, bestKey)) {
      best = face
      bestKey = key
    }
  }
  return best
}

function lexicographicLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number)
  }
  return false
}

/** How well a face's weight serves `desired` (lower is better), per CSS
 *  Fonts 4 §5.2: for 400–500, weights from `desired` up to 500 ascending, then
 *  below `desired` descending, then above 500 ascending; below 400, weights at
 *  or below descending, then above ascending; above 500, weights at or above
 *  ascending, then below descending. A variable range counts as the value
 *  nearest `desired` it can reach. */
export function weightRank(desired: number, weight: FaceWeight): number {
  const w = typeof weight === 'number' ? weight : Math.min(Math.max(desired, weight[0]), weight[1])
  const tier = (n: number, distance: number) => n * 10_000 + distance
  if (desired >= 400 && desired <= 500) {
    if (w >= desired && w <= 500) return tier(0, w - desired)
    if (w < desired) return tier(1, desired - w)
    return tier(2, w - 500)
  }
  if (desired < 400) return w <= desired ? tier(0, desired - w) : tier(1, w - desired)
  return w >= desired ? tier(0, w - desired) : tier(1, desired - w)
}
