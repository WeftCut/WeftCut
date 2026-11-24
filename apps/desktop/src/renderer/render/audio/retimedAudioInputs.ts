import type { ProjectSummary } from '../../ipc';
import { layerRateNumber } from '../../layerTiming';
import { MAX_COMPOSITION_DEPTH } from '../compositionWalk';

/** The preparation dependency, not a disk cache key. Keep Group scopes intact:
 * stretching a child stem then its parent is not equivalent to flattening rates.
 * Native audio/retime.rs consumes these fields; labels, markers and visual
 * transforms do not participate. Resolved sources include landed effect bakes. */
export function retimedAudioInputs(
  summary: ProjectSummary,
  targetId: string,
  resolveSource: (layerId: string, mediaId: string) => string | null,
): string | null {
  let retimed = false;
  const visited = new Set<string>();
  const compositions: unknown[] = [];
  const mediaById = new Map(summary.media.map(media => [media.id, media]));
  const visit = (id: string, depth: number): void => {
    if (depth > MAX_COMPOSITION_DEPTH || visited.has(id)) return;
    visited.add(id);
    const comp = summary.compositions[id];
    if (!comp) return;
    const layers: unknown[] = [];
    const audioIds = new Set(comp.tracks.flatMap(track => track.layers.filter(layer => layer.kind === 'Audio').map(layer => layer.id)));
    const transitions = comp.transitions.filter(tr => audioIds.has(tr.from_layer) && audioIds.has(tr.to_layer));
    compositions.push([id, comp.duration_us, layers, transitions]);
    for (const track of comp.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled) continue;
        const p = layer.params;
        if (p.kind !== 'Audio' && p.kind !== 'CompositionRef') continue;
        retimed ||= layerRateNumber(p) !== 1 || p.source_phase !== undefined;
        if (p.kind === 'Audio') {
          const { media_label: _label, ...audio } = p;
          layers.push([layer.id, layer.locked, layer.t_start_us, layer.t_end_us,
            audio, layer.effects, resolveSource(layer.id, p.media_id), mediaById.get(p.media_id)?.content_hash]);
        } else {
          layers.push([layer.id, layer.t_start_us, layer.t_end_us,
            p.composition_id, p.src_in_us, p.src_out_us, p.time_map, p.source_phase,
            p.preserve_pitch]);
          visit(p.composition_id, depth + 1);
        }
      }
    }
  };
  visit(targetId, 0);
  // Role mute/solo affects native stem inclusion; role gain is subsequently
  // applied by the live mixer. Retain the table until native prepares all roles.
  return retimed ? JSON.stringify([summary.project_id, targetId, compositions, summary.audio_roles]) : null;
}
