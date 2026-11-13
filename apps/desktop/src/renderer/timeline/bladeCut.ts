import type { LinkSummary, TrackSummary } from "../ipc";

/**
 * The layers a blade click on `layerId` at `atUs` splits: that layer and, while
 * the link fans out (`linkFanoutActive`), every link sibling whose span strictly
 * contains `atUs`. A sibling the cut misses, or any sibling under the link
 * override, is left whole.
 *
 * LANDMINE: a twin of the spanning rule in `applySplitLayer`
 * (main/state/mutations/split.ts). If the two drift, the blade mark shows a
 * cut the click does not make.
 */
export function bladeCutLayerIds(
  layerId: string,
  atUs: number,
  tracks: readonly TrackSummary[],
  links: readonly LinkSummary[],
  linkFanout: boolean,
): string[] {
  const link = linkFanout ? links.find((l) => l.layer_ids.includes(layerId)) : undefined;
  if (link === undefined) return [layerId];
  const siblings = new Set(link.layer_ids);
  siblings.delete(layerId);
  const cut = [layerId];
  for (const track of tracks) {
    for (const layer of track.layers) {
      if (siblings.has(layer.id) && layer.t_start_us < atUs && atUs < layer.t_end_us) {
        cut.push(layer.id);
      }
    }
  }
  return cut;
}
