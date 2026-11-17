import type { LayerParams, Project } from '../model'
import { eachLayer, type MotifRebindEntry } from '../model'
import { defaultTransform } from './add'

/** Build Motif LayerParams from canonicalized props.
 *  src_in_us=0, identity transform, Static(1) opacity. `graphicRole` is the
 *  caller's resolved role — the explicit argument, else the manifest's. */
export function motifLayerParams(motifId: string, canonicalProps: Record<string, unknown>, size: readonly [number, number] = [0, 0], graphicRole: string | null = null): LayerParams {
  return {
    kind: 'Motif',
    motif_id: motifId,
    props: canonicalProps,
    src_in_us: 0,
    transform: defaultTransform(size[0] / 2, size[1] / 2),
    opacity: { mode: 'Static', value: 1 },
    graphic_role: graphicRole,
  }
}

/** A new Motif version's rebind (`update_project_motif`): set motif_id/props
 *  on the named Motif-param layers; non-Motif or missing layers are skipped. */
export function applyRebindMotif(draft: Project, updates: MotifRebindEntry[]): void {
  for (const u of updates) {
    for (const { layer } of eachLayer(draft)) {
      if (layer.id === u.layer_id && layer.params.kind === 'Motif') {
        layer.params.motif_id = u.motif_id
        layer.params.props = u.props as Record<string, unknown>
      }
    }
  }
}
