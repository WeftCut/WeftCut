// apps/desktop/src/main/mcp/frameSamples.ts
//
// Where `render_frames { layer_ids }` looks (spec H3-D3): a beat is judged
// over its whole span, not at its first frame. Each layer is sampled once
// settled, at its middle, during its exit, and just after every change of
// picture under it: a cut between A-roll clips, or a shot change inside the
// source. The H2 title that covered the speaker sat right after such a change.
// Pure: the project and the source shot starts in, times out.

import type { Layer, Project, VideoClipParams } from '../state/model'

export interface Sample { t_us: number; layer_id: string; why: 'settled' | 'middle' | 'exit' | 'after cut' | 'after shot change' }

export const MAX_SAMPLES_PER_LAYER = 8
export const MAX_SAMPLES = 24
const SETTLE_US = 400_000
const EXIT_US = 250_000
const AFTER_CHANGE_US = 200_000
const MERGE_US = 300_000

function findLayer(project: Project, id: string): Layer | null {
  const root = project.compositions[project.root_id]
  for (const t of root?.tracks ?? []) for (const l of t.layers) if (l.id === id) return l
  return null
}

/** Samples for each root layer in `layerIds`, in time order. `shotStarts`
 *  gives a media's shot start times (source µs), or null when unknown. Throws
 *  on a layer id that is not on the root. */
export function beatSamples(project: Project, layerIds: readonly string[], shotStarts: (mediaId: string) => readonly number[] | null): Sample[] {
  const root = project.compositions[project.root_id]!
  const aroll = root.tracks.filter((t) => t.role === 'ARoll' && t.enabled !== false).flatMap((t) => t.layers)
    .filter((l): l is Layer & { params: VideoClipParams } => l.enabled && l.params.kind === 'VideoClip')
  const out: Sample[] = []
  for (const id of layerIds) {
    const l = findLayer(project, id)
    if (!l) throw new Error(`no layer ${id} on the root composition`)
    const a = l.t_start_us, b = l.t_end_us, d = b - a
    const mine: Sample[] = [
      { t_us: a + Math.min(SETTLE_US, d / 4), layer_id: id, why: 'settled' },
      { t_us: a + d / 2, layer_id: id, why: 'middle' },
      { t_us: b - Math.min(EXIT_US, d / 8), layer_id: id, why: 'exit' },
    ]
    for (const c of aroll) {
      if (c.t_start_us > a && c.t_start_us < b) mine.push({ t_us: c.t_start_us + AFTER_CHANGE_US, layer_id: id, why: 'after cut' })
      const rate = c.params.time_map ? null : 1
      if (rate === null) continue
      for (const s of shotStarts(c.params.media) ?? []) {
        if (s <= c.params.src_in_us || s >= c.params.src_out_us) continue
        const t = c.t_start_us + (s - c.params.src_in_us)
        if (t > a && t < b) mine.push({ t_us: t + AFTER_CHANGE_US, layer_id: id, why: 'after shot change' })
      }
    }
    // Keep the three anchors, then the changes in time order, merged and capped.
    const kept: Sample[] = []
    for (const s of mine.map((x) => ({ ...x, t_us: Math.round(Math.min(Math.max(x.t_us, a), b - 1)) }))) {
      if (kept.length >= MAX_SAMPLES_PER_LAYER) break
      if (kept.some((k) => Math.abs(k.t_us - s.t_us) < MERGE_US)) continue
      kept.push(s)
    }
    out.push(...kept)
  }
  return out.sort((x, y) => x.t_us - y.t_us).slice(0, MAX_SAMPLES)
}
