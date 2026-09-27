// Live-key computation for the L2 raster store (`Cache/raster/<hash>`). One
// pure seam so the GC decision is unit-testable without a Compositor, a DOM,
// or the fs bridge.
//
// The rule that keeps this safe: a motif layer whose catalog entry CANNOT be
// resolved (`getMotif` → undefined — catalog sync lost the race with project
// open, a transient `list_motifs` IPC failure, or a data-root fallback) is
// reported in `unresolved`, and the caller must NOT garbage-collect anything.
// "Unresolvable right now" is not "orphaned": its `<hash>` dirs are exactly
// the frames that make an old project playable, and deleting them on a guess
// is unrecoverable data loss (the full re-bake costs tens of minutes of serial
// capture time). The conservative tradeoff is deliberate: a draft the user
// truly deleted leaves its dirs behind until its layers leave every timeline.

import type { ProjectSummary } from "../../ipc";
import { forEachLayer } from "../compositionWalk";
import { getMotif, type Motif } from "./catalog";
import { motifFrameDescriptor } from "./motifFrameDescriptor";

export interface LiveRasterKeys {
  /// cacheKeys of every RESOLVED motif layer, every composition included — a
  /// key is live while any timeline in the project holds it.
  activeKeys: string[];
  /// motif_ids referenced by layers the catalog could not resolve. Non-empty
  /// ⇒ the caller must skip GC for the whole store.
  unresolved: string[];
}

export function collectLiveRasterKeys(
  summary: ProjectSummary,
  fpsNum: number,
  fpsDen: number,
  motifFor: (id: string) => Motif | null | undefined = getMotif,
): LiveRasterKeys {
  const activeKeys: string[] = [];
  const unresolved = new Set<string>();
  for (const compId of Object.keys(summary.compositions)) {
    forEachLayer(summary, compId, ({ layer }) => {
      if (layer.params.kind !== "Motif") return;
      const motif = motifFor(layer.params.motif_id);
      if (!motif) {
        unresolved.add(layer.params.motif_id);
        return;
      }
      const durationUs = layer.t_end_us - layer.t_start_us;
      // tInLayerUs=0: the cacheKey is window/time-independent (it folds props,
      // dims, fps and content-duration, not the playhead), so only desc.cacheKey
      // is read here.
      const desc = motifFrameDescriptor(layer.params, 0, durationUs, fpsNum, fpsDen, motif);
      if (desc) activeKeys.push(desc.cacheKey);
    });
  }
  return { activeKeys, unresolved: [...unresolved] };
}
