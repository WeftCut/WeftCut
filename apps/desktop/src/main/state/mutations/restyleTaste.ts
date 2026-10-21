// apps/desktop/src/main/state/mutations/restyleTaste.ts
//
// `restyle_to_taste` (spec H1-D4, Q9): put Text layers back to the project's
// style tokens — their graphic role's, or the caption tokens on a caption
// track. One recorded edit over the whole selection; every layer is checked
// before any is written, so a refusal changes nothing.
//
// Fields come in three groups so a deliberate placement can survive a restyle:
// `look` (face, size, weight, colour, alignment, outline, shadow, box width),
// `position` (position and anchor) and `motion` (intro and outro).

import type { Project, TextParams, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { checkLayerEditable } from './helpers'
import { roleTokens, styleText } from '../../taste/apply'
import type { CaptionTokens, TextTokens, Tokens } from '../../taste/schema'

export type RestyleGroup = 'look' | 'position' | 'motion'
export const RESTYLE_GROUPS: readonly RestyleGroup[] = ['look', 'position', 'motion']

const GROUP_FIELDS: Record<RestyleGroup, readonly string[]> = {
  look: ['family', 'size_px', 'weight', 'italic', 'color', 'align', 'outline', 'shadow', 'box_w'],
  position: ['position', 'anchor'],
  motion: ['intro', 'outro'],
}

function pick(t: TextTokens | CaptionTokens | undefined, groups: ReadonlySet<RestyleGroup>): TextTokens | undefined {
  if (!t) return undefined
  const keep = new Set([...groups].flatMap((g) => GROUP_FIELDS[g]))
  return Object.fromEntries(Object.entries(t).filter(([k]) => keep.has(k))) as TextTokens
}

/** Restyle `layerIds`; returns the ids whose params changed. */
export function applyRestyleToTaste(p: Project, layerIds: readonly Uuid[], tokens: Tokens, groups: ReadonlySet<RestyleGroup>, appFont?: string): Uuid[] {
  const located = layerIds.map((id) => {
    const at = checkLayerEditable(p, id)
    if (at.layer.params.kind !== 'Text') throw new CommandFailure({ error: 'WrongLayerKind', layer: id, expected: 'Text' })
    return at
  })
  const changed: Uuid[] = []
  for (const { layer, track, comp } of located) {
    const params = layer.params as TextParams
    const caption = track.role === 'Caption'
    const source = caption ? tokens.caption : roleTokens(tokens, params.graphic_role)
    // Captions keep the bundled caption face for a null family, as the
    // transcription tool lays them; other text takes the app's default font.
    const next = styleText(params, pick(source, groups), tokens, comp, caption ? undefined : appFont)
    if (JSON.stringify(next) !== JSON.stringify(params)) { layer.params = next; changed.push(layer.id) }
  }
  return changed
}
