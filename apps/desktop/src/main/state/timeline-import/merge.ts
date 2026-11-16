import type { IdGen } from '../ids'
import { rootComposition, type CompositionRefParams, type Layer, type Project } from '../model'
import { applyAddTrack, defaultTransform } from '../mutations/add'
import { applyDurationAutofit } from '../mutations/helpers'
import { frameGrid, snapOnGrid } from '../snap'
import { validate } from '../validate'

export type ImportedCanvasPlacement = 'fit' | 'fill' | 'original'

/** Imports into a Group, not into existing tracks: all authored source timing,
 * clip relationships, marker anchors and per-layer transforms survive intact.
 * The parent sees one independently editable Group, so a viewport mismatch has
 * an explicit whole-composition scaling choice rather than hundreds of guesses.
 * The imported composition must share the parent's frame/audio lattice. */
export function applyImportedTimelineGroup(
  draft: Project, imported: Project, idGen: IdGen, canvas: ImportedCanvasPlacement,
): string {
  const parent = rootComposition(draft)
  const source = rootComposition(imported)
  if (parent.fps.num * source.fps.den !== source.fps.num * parent.fps.den) {
    throw new Error('Frame rates differ. Export the sequence at the destination project rate and review again')
  }
  if (source.sample_rate !== parent.sample_rate || source.channels !== parent.channels) {
    throw new Error('The imported and current projects use different audio editing lattices')
  }
  if (Object.keys(imported.compositions).some(id => draft.compositions[id])) {
    throw new Error('Imported IDs conflict with existing project IDs; review the import again')
  }
  if (!['fit', 'fill', 'original'].includes(canvas)) throw new Error('Choose how the imported canvas should fit')

  validate(imported)
  for (const [id, item] of Object.entries(imported.media_pool)) {
    const held = draft.media_pool[id]
    if (held && JSON.stringify(held) !== JSON.stringify(item)) {
      throw new Error('Import would change an existing media item; review the import again')
    }
    if (!held) draft.media_pool[id] = item
  }
  for (const composition of Object.values(imported.compositions).sort((a, b) => a.ordinal - b.ordinal)) {
    draft.compositions[composition.id] = { ...composition,
      label: composition.id === source.id ? imported.metadata.name : composition.label,
      ordinal: draft.next_group_ordinal++ }
  }
  const trackId = applyAddTrack(draft, idGen, imported.metadata.name, undefined, parent.id)
  const scale = canvas === 'original' ? 1
    : (canvas === 'fill' ? Math.max : Math.min)(
      parent.width / source.width, parent.height / source.height,
    )
  const transform = defaultTransform(parent.width / 2, parent.height / 2)
  transform.scale_x = { mode: 'Static', value: scale }
  transform.scale_y = { mode: 'Static', value: scale }
  const start = snapOnGrid(parent.duration_us, frameGrid(parent.fps))
  const end = snapOnGrid(start + source.duration_us, frameGrid(parent.fps))
  const params: CompositionRefParams = {
    kind: 'CompositionRef', composition: source.id,
    src_in_us: 0, src_out_us: source.duration_us,
    transform, opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal',
  }
  const layer: Layer = {
    id: idGen(), label: imported.metadata.name,
    t_start_us: start, t_end_us: end, enabled: true, locked: false,
    metadata: {}, params, effects: [],
  }
  parent.tracks.find(t => t.id === trackId)!.layers.push(layer)
  applyDurationAutofit(parent)
  return layer.id
}
