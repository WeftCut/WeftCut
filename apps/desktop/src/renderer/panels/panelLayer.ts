import { type LayerSummary, type TrackSummary } from "../ipc";

/** Resolve the primary Layer from the Project summary supplied to a tool Panel. */
export function findPanelLayer(
  tracks: TrackSummary[],
  layerId: string | null,
): LayerSummary | null {
  if (!layerId) return null;
  for (const track of tracks) {
    const layer = track.layers.find((candidate) => candidate.id === layerId);
    if (layer) return layer;
  }
  return null;
}
