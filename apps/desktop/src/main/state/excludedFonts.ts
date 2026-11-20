// The entry rules of `settings.excluded_fonts`: what `validate` refuses and
// what an open repairs a hand-edited list to. The host op that edits the list
// hands in `normalizeExcludedFonts` output, so an edit never meets the refusal.

/** Longest family name an entry holds, in characters (code points). */
export const MAX_EXCLUDED_FONT_LENGTH = 200

export type ExcludedFontsProblem =
  | { index: null; reason: 'NotList' }
  | { index: number; reason: 'NotString' | 'Empty' | 'Untrimmed' | 'TooLong' | 'Duplicate' }

/** The key two family names are compared under: "Inter" and "inter" are one
 *  family. `toLowerCase`, never `toLocaleLowerCase`, so the answer does not
 *  depend on the machine's locale. */
export function fontFamilyKey(family: string): string {
  return family.normalize('NFC').toLowerCase()
}

/** The first rule `list` breaks, or null when it is a list of trimmed,
 *  non-empty names of at most `MAX_EXCLUDED_FONT_LENGTH` characters, no two
 *  with one `fontFamilyKey`. */
export function excludedFontsProblem(list: unknown): ExcludedFontsProblem | null {
  if (!Array.isArray(list)) return { index: null, reason: 'NotList' }
  const seen = new Set<string>()
  for (const [index, family] of list.entries()) {
    if (typeof family !== 'string') return { index, reason: 'NotString' }
    if (family.trim() === '') return { index, reason: 'Empty' }
    if (family.trim() !== family) return { index, reason: 'Untrimmed' }
    if ([...family].length > MAX_EXCLUDED_FONT_LENGTH) return { index, reason: 'TooLong' }
    const key = fontFamilyKey(family)
    if (seen.has(key)) return { index, reason: 'Duplicate' }
    seen.add(key)
  }
  return null
}

/** `list` cut to what `excludedFontsProblem` accepts: entries trimmed; a
 *  non-string, empty or over-long entry dropped; of names equal under
 *  `fontFamilyKey`, the first kept. Anything but an array is the empty list. */
export function normalizeExcludedFonts(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const family = entry.trim()
    if (family === '' || [...family].length > MAX_EXCLUDED_FONT_LENGTH) continue
    const key = fontFamilyKey(family)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(family)
  }
  return out
}
