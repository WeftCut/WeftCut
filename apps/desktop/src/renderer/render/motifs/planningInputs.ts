import type { ProjectSummary } from '../../ipc';
import type { FaceIndexEntry } from '../../../shared/fonts/types';
import { motifFonts } from '../../../shared/motifs/fontProps';
import { canonicalizePropsLenient, type Motif } from './catalog';

/** Inputs shared by durable demand, live-key retention and preview warming.
 * All compositions matter for retention, including currently closed timelines.
 * Placement and Group clocks affect demand; visual transforms affect neither
 * captured content nor the used content interval. Keep that knowledge here. */
export function motifPlanningInputs(summary: ProjectSummary | null): unknown {
  if (!summary) return null;
  return [summary.project_id, summary.root_id, Object.entries(summary.compositions).map(([id, comp]) => [
    id, comp.tracks.filter(track => track.enabled).flatMap(track => track.layers.flatMap(layer => {
      if (!layer.enabled) return [];
      const p = layer.params;
      if (p.kind !== 'Motif' && p.kind !== 'CompositionRef') return [];
      return [[layer.id, layer.t_start_us, layer.t_end_us,
        p.kind, p.src_in_us, p.time_map, p.source_phase, p.content_window,
        p.kind === 'Motif' ? [p.motif_id, p.props] : [p.composition_id, p.src_out_us]]];
    })),
  ])];
}

/** The font keys of every enabled Motif layer with font props, against the
 *  font index's `faces`: what an index change alters in the cache keys
 *  (`motifFrameDescriptor`). Unchanged by index changes that touch no
 *  Motif's families, so those do not replan. */
export function motifFontPlanningInputs(summary: ProjectSummary | null, motif: (id: string) => Motif | null | undefined, faces: readonly FaceIndexEntry[]): unknown {
  if (!summary) return null;
  const out: unknown[] = [];
  for (const comp of Object.values(summary.compositions)) {
    for (const track of comp.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        const p = layer.params;
        const m = layer.enabled && p.kind === 'Motif' ? motif(p.motif_id) : null;
        if (!m || p.kind !== 'Motif') continue;
        const fonts = motifFonts(m.manifest, canonicalizePropsLenient(p.props, m.manifest), faces);
        if (fonts) out.push([layer.id, fonts.keys]);
      }
    }
  }
  return out;
}
