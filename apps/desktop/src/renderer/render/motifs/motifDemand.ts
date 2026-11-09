// Pure Motif demand planning: what main should prepare and how each layer's
// preparation reads on the timeline. Every input is explicit; the caller owns
// sessions, stores and applying the result (MotifFrameService).

import type { ProjectSummary } from "../../ipc";
import type { MotifBakePlan, MotifFrameRange } from "../../../shared/motifs/baking";
import { motifWarmPhase, type LayerBakeStatus } from "../../timeline/motifBakeStatusStore";
import { localAt } from "../compositionClock";
import { compositionLocalUs, forEachLayer, type PlacedLayer } from "../compositionWalk";
import type { Motif } from "./catalog";
import { hashCacheKey } from "./frameCache";
import { collectLiveRasterKeys } from "./liveRasterKeys";
import { motifFrameDescriptor } from "./motifFrameDescriptor";

export type MotifLookup = (id: string) => Motif | null | undefined;

export interface PreparationInput {
  summary: ProjectSummary;
  openCompositionId: string;
  fpsNum: number;
  fpsDen: number;
  /** The workspace session the plan declares to. */
  generation: number;
  /** "Pre-bake all motif content": demand every used range. */
  automatic: boolean;
  /** Motif layers demanded at full content (Pre-bake now). */
  explicit: ReadonlySet<string>;
  /** The Motif layers of each Pre-bake now awaiting its one retry and
   * promotion, newest request first. */
  promote: readonly (readonly string[])[];
  motif: MotifLookup;
}

export interface PreparationDemand {
  plan: MotifBakePlan;
  /** Per Motif layer of the open composition, the content ranges its clips use. */
  layerRanges: Map<string, MotifFrameRange[]>;
  /** Every cache key a live layer can read, deduped. */
  liveCacheKeys: string[];
}

/// The durable preparation `input` demands of main.
export function planMotifPreparation(input: PreparationInput): PreparationDemand {
  const { summary, openCompositionId, fpsNum, fpsDen, explicit, promote } = input;
  const plan: MotifBakePlan = { generation: input.generation, contents: [], live: [], collect: true };
  const layerRanges = new Map<string, MotifFrameRange[]>();
  const { activeKeys, unresolved } = collectLiveRasterKeys(summary, fpsNum, fpsDen, input.motif);
  const liveCacheKeys = [...new Set(activeKeys)];
  plan.live = liveCacheKeys.map(cacheKey => ({ cacheKey, hash: hashCacheKey(cacheKey) }));
  plan.collect = unresolved.length === 0;
  const retryKeys = new Set<string>();
  const priorityRanks = new Map<string, number>();
  const contents = new Map<string, MotifBakePlan['contents'][number]>();
  const roots = new Set([summary.root_id, openCompositionId]);
  // A manually requested layer remains demanded even if its timeline closes.
  for (const [id, comp] of Object.entries(summary.compositions)) {
    if (comp.tracks.some(track => track.layers.some(layer => explicit.has(layer.id)))) roots.add(id);
  }
  const placements: { root: string; rank: number; placed: PlacedLayer }[] = [];
  for (const [rank, root] of [...roots].entries()) forEachLayer(summary, root, placed => placements.push({ root, rank, placed }));
  // Stable ties retain track/layer order. The playhead does not reorder baking.
  placements.sort((a, b) => a.rank - b.rank || a.placed.tStartUs - b.placed.tStartUs);
  plan.sequence = [];
  for (const { root, placed } of placements) {
    const { layer } = placed;
    if (layer.params.kind !== 'Motif') continue;
    const view = layer.params;
    const full = explicit.has(layer.id);
    const motif = input.motif(layer.params.motif_id);
    if (!motif) continue;
    const durationUs = layer.t_end_us - layer.t_start_us;
    const local = (time: number) => (placed.clock ? localAt(placed.clock, time) : compositionLocalUs(time - placed.offsetUs, fpsNum, fpsDen)) - layer.t_start_us;
    const desc = motifFrameDescriptor(layer.params, local(placed.tStartUs), durationUs, fpsNum, fpsDen, motif);
    if (!desc) continue;
    const rank = promote.findIndex(ids => ids.includes(layer.id));
    if (rank >= 0) {
      retryKeys.add(desc.cacheKey);
      priorityRanks.set(desc.cacheKey, Math.min(priorityRanks.get(desc.cacheKey) ?? Infinity, rank));
    }
    // Sample actual root-grid anchors visible through Group trims. The full
    // content duration remains a render input and cache identity.
    const firstRoot = Math.ceil(placed.tStartUs * fpsNum / (1_000_000 * fpsDen) - 0.0001);
    const lastRoot = Math.ceil(placed.tEndUs * fpsNum / (1_000_000 * fpsDen) - 0.0001) - 1;
    if (!full && lastRoot < firstRoot) continue;
    const frameAt = (rootFrame: number) => motifFrameDescriptor(view,
      local(Math.round(rootFrame * 1_000_000 * fpsDen / fpsNum)), durationUs, fpsNum, fpsDen, motif)!.contentFrame;
    const range = full ? { start: 0, end: desc.contentDurationFrames }
      : { start: frameAt(firstRoot), end: frameAt(lastRoot) + 1 };
    if (root === openCompositionId) {
      const ranges = layerRanges.get(layer.id) ?? [];
      ranges.push(range); layerRanges.set(layer.id, ranges);
    }
    // Display coverage describes the clip even when automatic work is off.
    // The toggle controls demand, not whether persisted frames count as ready.
    if ((!input.automatic || (root !== summary.root_id && root !== openCompositionId)) && !full) continue;
    plan.sequence.push({ cacheKey: desc.cacheKey, ranges: [range] });
    const existing = contents.get(desc.cacheKey);
    if (existing) { existing.ranges.push(range); if (full) existing.explicit = true; continue; }
    contents.set(desc.cacheKey, {
      ...(full ? { explicit: true } : {}),
      cacheKey: desc.cacheKey, hash: hashCacheKey(desc.cacheKey),
      contentFrames: desc.contentDurationFrames, ranges: [range],
      capture: { motifId: motif.manifest.id, contentHash: motif.manifest.content_hash ?? '',
        propsJson: JSON.stringify(desc.canonicalProps), width: desc.renderW, height: desc.renderH,
        fpsNum, fpsDen },
    });
  }
  plan.contents = [...contents.values()];
  if (retryKeys.size) {
    plan.retryKeys = [...retryKeys];
    plan.promoteKeys = [...retryKeys].sort((a, b) => priorityRanks.get(a)! - priorityRanks.get(b)!);
  }
  return { plan, layerRanges, liveCacheKeys };
}

export interface LayerStatusInput {
  summary: ProjectSummary;
  openCompositionId: string;
  fpsNum: number;
  fpsDen: number;
  motif: MotifLookup;
  /** Main's latest status per cache key. */
  statuses: ReadonlyMap<string, LayerBakeStatus>;
  /** `PreparationDemand.layerRanges` of the last plan. */
  layerRanges: ReadonlyMap<string, readonly MotifFrameRange[]>;
  /** Why preparation is unavailable, or null. */
  preparationError: string | null;
  automatic: boolean;
  explicit: ReadonlySet<string>;
  /** Saved frames of a cache key, when its inventory is known. */
  saved: (cacheKey: string) => ReadonlySet<number> | undefined;
  /** Whether every one of `total` frames of a cache key is saved. */
  complete: (cacheKey: string, total: number) => boolean;
  /** Frames of a cache key warm in memory at the preview's divisor. */
  warm: (cacheKey: string) => number;
}

/// Each Motif layer of the open composition's preparation status; a layer
/// with nothing to show is omitted. A layer shows main's status if it has
/// one, "ready" when its frames are on disk (saved last session, or with
/// automatic work off), else its warmth in memory.
export function motifLayerStatuses(input: LayerStatusInput): Record<string, LayerBakeStatus> {
  const byLayer: Record<string, LayerBakeStatus> = {};
  forEachLayer(input.summary, input.openCompositionId, ({ layer }) => {
    if (layer.params.kind !== 'Motif') return;
    const motif = input.motif(layer.params.motif_id);
    if (!motif) return;
    const durationUs = layer.t_end_us - layer.t_start_us;
    const desc = motifFrameDescriptor(layer.params, 0, durationUs, input.fpsNum, input.fpsDen, motif);
    if (!desc) return;
    let live = input.statuses.get(desc.cacheKey);
    if (input.preparationError && (input.automatic || input.explicit.has(layer.id))) {
      live = { phase: 'error', done: 0, total: desc.contentDurationFrames, error: input.preparationError };
    }
    const requested = input.layerRanges.get(layer.id);
    const saved = input.saved(desc.cacheKey);
    if (requested && saved) {
      const ranges: MotifFrameRange[] = [];
      for (const r of [...requested].sort((a, b) => a.start - b.start)) {
        const last = ranges.at(-1);
        if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
        else ranges.push({ ...r });
      }
      const total = ranges.reduce((n, r) => n + r.end - r.start, 0);
      let done = 0;
      for (const frame of saved) if (ranges.some(r => frame >= r.start && frame < r.end)) done++;
      // A later occurrence of shared content cannot keep a completed clip
      // looking unfinished. Progress belongs to this clip's requested range.
      if (done === total) live = { phase: 'ready', done, total };
      else if (live) live = { ...live, done, total };
    }
    // L0 coverage is the "is preview warm" signal that drives the green bar,
    // including frames that predate the asking service (a preview remount).
    const status = motifWarmPhase(
      live ?? null,
      input.warm(desc.cacheKey),
      desc.contentDurationFrames,
      input.complete(desc.cacheKey, desc.contentDurationFrames),
    );
    if (status) byLayer[layer.id] = status;
  });
  return byLayer;
}
