import { contentAtUs } from '../../layerTiming';
import { approximateTime } from '../../timeMapping';
import type { CompositionSummary, LayerSummary, ProjectSummary } from "../../ipc";
import { forEachLayerInTime, instanceKey } from "../compositionWalk";
import { swapKeys } from "../swapKeys";

export interface PreviewDecodeTarget {
  layer: LayerSummary;
  path: string;
  key: string;
  tStartUs: number;
  tEndUs: number;
  sourceUs: number;
}

export interface PreviewDecodePriorityPlan {
  /// Actual preview pool keys protected from capacity reclamation. Both base
  /// and overlap-swap keys are included because either may own the clip's live
  /// hardware session while a resolver-key swap is in flight or completed.
  poolKeys: string[];
  /// Nearest future VideoClip boundary inside the lookahead window.
  nextStartUs: number | null;
  /// Nearest boundary plus bounded, non-overlapping subsequent short cuts.
  upcomingLayers: LayerSummary[];
  activeTargets: PreviewDecodeTarget[];
  upcomingTargets: PreviewDecodeTarget[];
}

/// Plan native decode ownership for one composition time. Active clips and all
/// clips at upcoming boundaries are peers. Look through short sequential cuts:
/// warming only the next cut gives its successor just that short clip's length
/// to open/seek. Keep speculation bounded; main still owns hardware admission.
export function planPreviewDecodePriority(
  composition: CompositionSummary,
  tUs: number,
  windowUs: number,
  summary?: ProjectSummary,
): PreviewDecodePriorityPlan {
  const active: PreviewDecodeTarget[] = [];
  let nextStartUs: number | null = null;
  let upcoming: PreviewDecodeTarget[] = [];
  const future: PreviewDecodeTarget[] = [];
  const horizonEndUs = tUs + windowUs;

  const add = (layer: LayerSummary, path: string, start: number, end: number, headUs: number, rate = 1): void => {
    if (layer.params.kind !== "VideoClip" || start >= end) return;
    const target = { layer, path, key: instanceKey(path, layer.id), tStartUs: start, tEndUs: end,
      sourceUs: contentAtUs(layer.params, headUs + Math.max(0, tUs - start) * rate) };
    if (start <= tUs && tUs < end) active.push(target);
    else if (start > tUs && start <= horizonEndUs) {
      future.push(target);
      if (nextStartUs === null || start < nextStartUs) {
        nextStartUs = start;
        upcoming = [target];
      } else if (start === nextStartUs) upcoming.push(target);
    }
  };
  if (summary) {
    // The same placement walk as export/motifs: trim through every enclosing
    // Group, protect instance keys, and warm the source time actually visible.
    forEachLayerInTime(summary, composition.id, tUs, horizonEndUs + 1, 0,
      p => add(p.layer, p.path, p.tStartUs, p.tEndUs, p.headUs, p.clock ? approximateTime(p.clock.rate) : 1));
  } else {
    for (const track of composition.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (layer.enabled) add(layer, "", layer.t_start_us, layer.t_end_us, 0);
      }
    }
  }

  // Never drop any participant of the nearest boundary. Further speculation
  // is limited to two clips and three total active/upcoming clips, and only
  // crosses non-overlapping cuts (not extra concurrent layers).
  const limit = Math.max(upcoming.length, Math.min(2, 3 - active.length));
  future.sort((a, b) => a.tStartUs - b.tStartUs);
  let endUs = Math.max(...upcoming.map(l => l.tEndUs));
  for (let i = 0; i < future.length && upcoming.length < limit;) {
    const startUs = future[i]!.tStartUs;
    const batch: PreviewDecodeTarget[] = [];
    while (i < future.length && future[i]!.tStartUs === startUs) batch.push(future[i++]!);
    if (startUs < endUs) continue;
    if (upcoming.length + batch.length > limit) break;
    upcoming.push(...batch);
    endUs = Math.max(...batch.map(l => l.tEndUs));
  }

  const poolKeys: string[] = [];
  const seen = new Set<string>();
  for (const { layer, key } of [...active, ...upcoming]) {
    if (layer.params.kind !== "VideoClip") continue;
    const keys = [
      key,
      swapKeys(key, layer.params.media_id).swapLayerId,
    ];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      poolKeys.push(key);
    }
  }

  return { poolKeys, nextStartUs, upcomingLayers: upcoming.map(t => t.layer), activeTargets: active, upcomingTargets: upcoming };
}
