import { layerEditLock } from "../../shared/layerLocks";
import type { TrackSummary } from "../ipc";

export function layerIsReadOnly(tracks: readonly TrackSummary[], id: string): boolean {
  for (const track of tracks) {
    const layer = track.layers.find(candidate => candidate.id === id);
    if (layer) return layerEditLock(layer, track) !== null;
  }
  return true;
}
