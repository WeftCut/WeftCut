// Which leaves of a font-family list are missing (ADR 0176): one rule for main
// (`project://session` `fonts.missing`, the `log.fonts_missing` line) and the
// renderer (the properties panel's note), so both name the same families for
// the same layer and face index.

import { isBundledFamily, isGenericFamily } from './resolve'

export interface MissingLeaves {
  /** The missing leaves, in list order, each once (compared without case). */
  missing: string[]
  /** The leaf that draws in their place: the first that resolves or is
   *  bundled or generic; null when no leaf does. */
  fallback: string | null
}

/** Missing is every leaf before the first that draws, bundled and generic
 *  ones aside: the author's earlier choices, not available here. A leaf
 *  after the first that draws is a fallback the author allowed for, so it is
 *  never missing, whatever characters reach it. `resolves` says whether a
 *  leaf has a face here: in `Fonts/`, installed, or for a Motif, shipped by
 *  its package. */
export function missingLeaves(leaves: readonly string[], resolves: (leaf: string) => boolean): MissingLeaves {
  const missing: string[] = []
  for (const leaf of leaves) {
    if (isBundledFamily(leaf) || isGenericFamily(leaf) || resolves(leaf)) return { missing, fallback: leaf }
    const key = leaf.toLowerCase()
    if (!missing.some(m => m.toLowerCase() === key)) missing.push(leaf)
  }
  return { missing, fallback: null }
}
