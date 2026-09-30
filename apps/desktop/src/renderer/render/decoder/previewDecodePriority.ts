import type { CompositionSummary, LayerSummary } from "../../ipc";
import { swapKeys } from "../swapKeys";

export interface PreviewDecodePriorityPlan {
  /// Actual preview pool keys protected from capacity reclamation. Both base
  /// and overlap-swap keys are included because either may own the clip's live
  /// hardware session while a resolver-key swap is in flight or completed.
  poolKeys: string[];
  /// Nearest future VideoClip boundary inside the lookahead window.
  nextStartUs: number | null;
  /// Nearest boundary plus bounded, non-overlapping subsequent short cuts.
  upcomingLayers: LayerSummary[];
}

/// Plan native decode ownership for one composition time. Active clips and all
/// clips at upcoming boundaries are peers. Look through short sequential cuts:
/// warming only the next cut gives its successor just that short clip's length
/// to open/seek. Keep speculation bounded; main still owns hardware admission.
export function planPreviewDecodePriority(
  composition: CompositionSummary,
  tUs: number,
  windowUs: number,
): PreviewDecodePriorityPlan {
  const active: LayerSummary[] = [];
  let nextStartUs: number | null = null;
  let upcomingLayers: LayerSummary[] = [];
  const future: LayerSummary[] = [];
  const horizonEndUs = tUs + windowUs;

  for (const track of composition.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers) {
      if (!layer.enabled || layer.params.kind !== "VideoClip") continue;
      if (layer.t_start_us <= tUs && tUs < layer.t_end_us) {
        active.push(layer);
        continue;
      }
      if (layer.t_start_us <= tUs || layer.t_start_us > horizonEndUs) continue;
      future.push(layer);
      if (nextStartUs === null || layer.t_start_us < nextStartUs) {
        nextStartUs = layer.t_start_us;
        upcomingLayers = [layer];
      } else if (layer.t_start_us === nextStartUs) {
        upcomingLayers.push(layer);
      }
    }
  }

  // Never drop any participant of the nearest boundary. Further speculation
  // is limited to two clips and three total active/upcoming clips, and only
  // crosses non-overlapping cuts (not extra concurrent layers).
  const limit = Math.max(upcomingLayers.length, Math.min(2, 3 - active.length));
  future.sort((a, b) => a.t_start_us - b.t_start_us);
  let endUs = Math.max(...upcomingLayers.map(l => l.t_end_us));
  for (let i = 0; i < future.length && upcomingLayers.length < limit;) {
    const startUs = future[i]!.t_start_us;
    const batch: LayerSummary[] = [];
    while (i < future.length && future[i]!.t_start_us === startUs) batch.push(future[i++]!);
    if (startUs < endUs) continue;
    if (upcomingLayers.length + batch.length > limit) break;
    upcomingLayers.push(...batch);
    endUs = Math.max(...batch.map(l => l.t_end_us));
  }

  const poolKeys: string[] = [];
  const seen = new Set<string>();
  for (const layer of [...active, ...upcomingLayers]) {
    if (layer.params.kind !== "VideoClip") continue;
    const keys = [
      layer.id,
      swapKeys(layer.id, layer.params.media_id).swapLayerId,
    ];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      poolKeys.push(key);
    }
  }

  return { poolKeys, nextStartUs, upcomingLayers };
}
