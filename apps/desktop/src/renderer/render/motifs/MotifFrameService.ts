import { localAt } from '../compositionClock';
// Preview warming is renderer-owned. Main owns durable preparation, inventory,
// retries and resource admission; this module declares demand and projects status.

import type { LayerSummary, ProjectSummary } from "../../ipc";
import { useAppSettingsStore } from "../../settings/appSettingsStore";
import {
  setLayerBakeStatuses,
  motifWarmPhase,
  type LayerBakeStatus,
} from "../../timeline/motifBakeStatusStore";
import { compositionLocalUs, forEachLayer, type PlacedLayer } from "../compositionWalk";
import { getMotif } from "./catalog";
import { MotifPrewarmer, type PrewarmContentSpec } from "./MotifPrewarmer";
import { MotifBakeClient } from './bakeClient';
import type { MotifBakePlan, MotifBakeSession, MotifBakeSnapshot, MotifFrameRange } from '../../../shared/motifs/baking';
import { hashCacheKey } from './frameCache';
import { motifFrameDescriptor } from "./motifFrameDescriptor";
import { MOTIF_RECENT_FRAMES } from "./motifFrames";
import {
  resolveMotifFrame,
  sharedBakedKeyIndex,
  sharedMotifFrameCache,
  resetMotifFrameRequests,
  cancelMotifFrameRequest,
  setMotifPreparationCoverage,
} from "./motifRasterCache";
import { onPrebakeRequest } from "./prebakeBus";
import { collectLiveRasterKeys } from "./liveRasterKeys";
import { syncUserMotifsFromBackend } from "./syncCatalog";

/// Schedule `cb` for an idle slice: `requestIdleCallback` when available
/// (with a 200ms timeout floor so the prewarm can't starve indefinitely),
/// else a short `setTimeout`. Returns a cancel token for `cancelIdle`.
function scheduleIdle(cb: () => void): number {
  const g = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    setTimeout: (cb: () => void, ms: number) => number;
  };
  if (typeof g.requestIdleCallback === "function") return g.requestIdleCallback(cb, { timeout: 200 });
  return g.setTimeout(cb, 16);
}

function cancelIdle(token: number): void {
  const g = globalThis as unknown as {
    cancelIdleCallback?: (t: number) => void;
    clearTimeout: (t: number) => void;
  };
  if (typeof g.cancelIdleCallback === "function") g.cancelIdleCallback(token);
  else g.clearTimeout(token);
}

/// Everything the service reads of its owning Compositor. Getters, not values:
/// the snapshot / composition / fps / playhead all change under the service's
/// feet, and a captured copy would silently plan against a stale project.
export interface MotifFrameServiceDeps {
  /// The current project snapshot (null before load / after close).
  projectSummary: () => ProjectSummary | null;
  /// The OPEN composition's id — the walk root for the motif-layer scan.
  openCompositionId: () => string;
  /// The composition fps pair (exact rational) the frame-snap math runs on.
  fpsNum: () => number;
  fpsDen: () => number;
  /// The last composited composition time — where prewarm/bake planning
  /// anchors on a project change.
  currentTimeUs: () => number;
}

// Explicit choices belong to the renderer's workspace session, not a Compositor.
let manualSession: { generation: number; layers: Set<string> } | null = null;

export class MotifFrameService {
  private layerBakeRanges = new Map<string, MotifFrameRange[]>();
  private pendingPriorityGroups: string[][] = [];
  private prewarmer: MotifPrewarmer | null;
  private client: MotifBakeClient | null;
  private bakeStatusByCacheKey = new Map<string, LayerBakeStatus>();
  private lastBakeStatusSig = '';
  private manualPrebakeLayers = new Set<string>();
  private pendingRetryLayers = new Set<string>();
  private liveCacheKeys: string[] = [];
  private prebakeUnsub: (() => void) | null = null;
  private settingsUnsub: (() => void) | null = null;
  private lastPrewarmFrame = -1;
  private disposed = false;
  private generation: number | null = null;
  private projectEpoch = 0;
  private diskDiscoveryPending = false;
  private preparationError: string | null = null;

  constructor(private readonly deps: MotifFrameServiceDeps) {
    this.prewarmer =
      typeof document !== "undefined"
        ? new MotifPrewarmer({
            capBytes: sharedMotifFrameCache.capacityBytes(),
            hasFrame: (k, f) => sharedMotifFrameCache.hasFrame(k, f),
            prioritizeFrames: (targets) => sharedMotifFrameCache.prioritizeFrames(targets),
            setFrame: (k, f, b) => {
              sharedMotifFrameCache.setFrame(k, f, b);
            },
            schedule: (cb) => scheduleIdle(cb),
            cancel: (t) => cancelIdle(t),
            cancelRequest: cancelMotifFrameRequest,
            onProgress: () => this.recomputeBakeStatuses(),
          })
        : null;
    this.client = this.prewarmer ? new MotifBakeClient(
      snapshot => this.acceptSnapshot(snapshot),
      error => {
        console.warn('[weftcut/motifs] preparation unavailable', error);
        this.preparationError = String(error);
        this.resumeAfterDiskDiscovery();
      },
    ) : null;
    if (this.client) this.settingsUnsub = useAppSettingsStore.subscribe((next, previous) => {
      if (next.settings.prebake_motifs !== previous.settings.prebake_motifs) this.submitBakePlan();
    });
    if (this.client) this.prebakeUnsub = onPrebakeRequest(layerId => {
      const summary = this.deps.projectSummary();
      const selected = summary && Object.values(summary.compositions).flatMap(c => c.tracks.flatMap(t => t.layers)).find(l => l.id === layerId);
      const ids = new Set<string>();
      if (selected?.params.kind === 'CompositionRef') {
        forEachLayer(summary!, selected.params.composition_id, ({ layer }) => {
          if (layer.params.kind === 'Motif') ids.add(layer.id);
        });
      } else if (selected?.params.kind === 'Motif') ids.add(layerId);
      for (const id of ids) {
        this.manualPrebakeLayers.add(id);
        this.pendingRetryLayers.add(id);
      }
      this.pendingPriorityGroups.unshift([...ids]);
      this.submitBakePlan();
    });
  }

  handleProjectChanged(): void {
    if (this.disposed || !this.client) return;
    const epoch = ++this.projectEpoch;
    this.client.invalidate();
    this.lastPrewarmFrame = -1;
    this.diskDiscoveryPending = !!this.deps.projectSummary();
    this.prewarmer?.setTargets([]);
    if (this.diskDiscoveryPending) sharedBakedKeyIndex.beginHydration();
    else {
      sharedBakedKeyIndex.clear();
      this.manualPrebakeLayers.clear();
      this.pendingRetryLayers.clear();
      this.pendingPriorityGroups = [];
      this.bakeStatusByCacheKey.clear();
      this.preparationError = null;
      setLayerBakeStatuses({});
    }
    void syncUserMotifsFromBackend().then(() => {
      if (!this.disposed && epoch === this.projectEpoch) this.submitBakePlan();
    });
  }

  noteFrameBoundary(tUsSnapped: number): void {
    if (!this.prewarmer) return;
    const frameIdx = Math.round(tUsSnapped * this.deps.fpsNum() / (1_000_000 * this.deps.fpsDen()));
    if (frameIdx === this.lastPrewarmFrame) return;
    this.lastPrewarmFrame = frameIdx;
    this.updatePrewarmTargets(tUsSnapped);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.projectEpoch++;
    this.prewarmer?.dispose();
    this.client?.dispose();
    this.prebakeUnsub?.();
    this.settingsUnsub?.();
    sharedBakedKeyIndex.finishHydration();
    // Background jobs and durable coverage survive preview remounts.
  }

  // ============================================================
  // private
  // ============================================================

  /// Every enabled Motif layer reachable from the drawn composition, Groups'
  /// included, with the LOCAL time `tUs` maps to inside it — the motif
  /// planners' one walk.
  private forEachMotifLayer(
    tUs: number,
    f: (layer: LayerSummary & { params: { kind: "Motif" } }, tInLayerUs: number) => void,
    lookaheadUs?: number,
  ): void {
    const summary = this.deps.projectSummary();
    if (!summary) return;
    const fpsNum = this.deps.fpsNum();
    const fpsDen = this.deps.fpsDen();
    forEachLayer(summary, this.deps.openCompositionId(), ({ layer, offsetUs, clock, tStartUs, tEndUs }) => {
      if (layer.params.kind !== "Motif") return;
      // Prewarm only the visible/soon-visible window. Root spans already
      // include Group trims; sample a future layer at its actual entry time.
      if (lookaheadUs !== undefined && (tEndUs <= tUs || tStartUs > tUs + lookaheadUs)) return;
      const sampleUs = lookaheadUs === undefined ? tUs : Math.max(tUs, tStartUs);
      // `compositionLocalUs`, not a bare subtraction: the descriptor's
      // `contentFrame` becomes a cache key, and the frame the SPRITE ends up
      // asking for is derived through the same re-snap on its way down the
      // nodes. A µs of lattice residual between the two would warm a key
      // nothing ever reads.
      const tLocalUs = clock ? localAt(clock, sampleUs) : compositionLocalUs(sampleUs - offsetUs, fpsNum, fpsDen);
      f(layer as LayerSummary & { params: { kind: "Motif" } }, tLocalUs - layer.t_start_us);
    });
  }

  /// Map the active motif layers at composition-time `tUs` to prewarm specs
  /// (deduped by cacheKey inside the planner) and hand them to the prewarmer.
  /// Runs whether playing or paused (compositeFrame fires on seek/scrub too), so
  /// the cache warms ahead of the playhead in both states.
  private updatePrewarmTargets(tUs: number): void {
    const summary = this.deps.projectSummary();
    if (!this.prewarmer || !summary || this.diskDiscoveryPending) return;
    // A rejected durable plan is not permission to launch a second background
    // producer that only fills RAM. Foreground preview can still read/capture.
    if (this.preparationError) { this.prewarmer.setTargets([]); return; }
    const specs: PrewarmContentSpec[] = [];
    this.forEachMotifLayer(tUs, (layer, tInLayerUs) => {
      const motif = getMotif(layer.params.motif_id);
      if (!motif) return;
      const durationUs = layer.t_end_us - layer.t_start_us;
      const view = layer.params;
      const fpsNum = this.deps.fpsNum();
      const fpsDen = this.deps.fpsDen();
      const desc = motifFrameDescriptor(view, tInLayerUs, durationUs, fpsNum, fpsDen, motif);
      if (!desc) return;
      // Capture the plan-time inputs in locals so the async render closure
      // binds the values that produced THIS cacheKey, not whatever the fps
      // getters return at raster time (which could drift if the project fps
      // changes).
      const canonicalProps = desc.canonicalProps;
      const durationSec = desc.durationSec;
      specs.push({
        cacheKey: desc.cacheKey,
        contentFrame: desc.contentFrame,
        contentDurationFrames: desc.contentDurationFrames,
        historyFrames: MOTIF_RECENT_FRAMES,
        // What one warmed frame costs the byte-bounded L0 cache — the planner
        // budget is in bytes, so a small Motif warms deeper than a 1080p one.
        frameBytes: desc.renderW * desc.renderH * 4,
        // tSec for an arbitrary content frame = frame * fpsDen / fpsNum.
        // Disk-first: prefer a baked frame over a live raster, falling through
        // to `rasterMotifFrame` (CDP) inside the resolver on miss / fs hiccup.
        render: (frame: number, requestKey: string) =>
          resolveMotifFrame(
            motif,
            desc.cacheKey,
            frame,
            (frame * fpsDen) / fpsNum,
            durationSec,
            canonicalProps,
            requestKey,
            fpsNum,
            fpsDen,
            false,
            'background',
          ),
      });
    }, 500_000);
    this.prewarmer.setTargets(specs);
  }

  private submitBakePlan(): void {
    this.client?.reconcile(this.deps.projectSummary()?.project_id ?? null, session => this.buildBakePlan(session));
  }

  private buildBakePlan(session: MotifBakeSession): MotifBakePlan {
    if (this.generation !== session.generation) {
      if (manualSession && manualSession.generation === session.generation) {
        for (const id of this.manualPrebakeLayers) manualSession.layers.add(id);
        this.manualPrebakeLayers = manualSession.layers;
      } else {
        if (this.generation !== null) {
          this.manualPrebakeLayers.clear();
          this.pendingRetryLayers.clear();
          this.pendingPriorityGroups = [];
        }
        manualSession = { generation: session.generation, layers: this.manualPrebakeLayers };
      }
      this.generation = session.generation;
      resetMotifFrameRequests();
      sharedBakedKeyIndex.clear();
      if (this.diskDiscoveryPending) sharedBakedKeyIndex.beginHydration();
      this.bakeStatusByCacheKey.clear();
    }
    const summary = this.deps.projectSummary();
    const plan: MotifBakePlan = { generation: session.generation, contents: [], live: [], collect: true };
    this.layerBakeRanges.clear();
    if (!summary) { this.liveCacheKeys = []; return plan; }
    const fpsNum = this.deps.fpsNum(), fpsDen = this.deps.fpsDen();
    const { activeKeys, unresolved } = collectLiveRasterKeys(summary, fpsNum, fpsDen);
    this.liveCacheKeys = [...new Set(activeKeys)];
    plan.live = this.liveCacheKeys.map(cacheKey => ({ cacheKey, hash: hashCacheKey(cacheKey) }));
    plan.collect = unresolved.length === 0;
    const globalOn = useAppSettingsStore.getState().settings.prebake_motifs;
    const retryKeys = new Set<string>();
    const priorityRanks = new Map<string, number>();
    const contents = new Map<string, MotifBakePlan['contents'][number]>();
    const roots = new Set([summary.root_id, this.deps.openCompositionId()]);
    // A manually requested layer remains demanded even if its timeline closes.
    for (const [id, comp] of Object.entries(summary.compositions)) {
      if (comp.tracks.some(track => track.layers.some(layer => this.manualPrebakeLayers.has(layer.id)))) roots.add(id);
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
      const full = this.manualPrebakeLayers.has(layer.id);
      const motif = getMotif(layer.params.motif_id);
      if (!motif) continue;
      const durationUs = layer.t_end_us - layer.t_start_us;
      const local = (time: number) => (placed.clock ? localAt(placed.clock, time) : compositionLocalUs(time - placed.offsetUs, fpsNum, fpsDen)) - layer.t_start_us;
      const desc = motifFrameDescriptor(layer.params, local(placed.tStartUs), durationUs, fpsNum, fpsDen, motif);
      if (!desc) continue;
      if (this.pendingRetryLayers.has(layer.id)) {
        retryKeys.add(desc.cacheKey);
        const rank = this.pendingPriorityGroups.findIndex(ids => ids.includes(layer.id));
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
      if (root === this.deps.openCompositionId()) {
        const ranges = this.layerBakeRanges.get(layer.id) ?? [];
        ranges.push(range); this.layerBakeRanges.set(layer.id, ranges);
      }
      // Display coverage describes the clip even when automatic work is off.
      // The toggle controls demand, not whether persisted frames count as ready.
      if ((!globalOn || (root !== summary.root_id && root !== this.deps.openCompositionId())) && !full) continue;
      plan.sequence.push({ cacheKey: desc.cacheKey, ranges: [range] });
      const existing = contents.get(desc.cacheKey);
      if (existing) { existing.ranges.push(range); if (full) existing.explicit = true; continue; }
      contents.set(desc.cacheKey, {
        ...(full ? { explicit: true } : {}),
        cacheKey: desc.cacheKey, hash: hashCacheKey(desc.cacheKey),
        contentFrames: desc.contentDurationFrames, ranges: [range],
        capture: { motifId: motif.manifest.id, contentHash: motif.manifest.content_hash ?? '',
          propsJson: JSON.stringify(desc.canonicalProps), width: desc.renderW, height: desc.renderH,
          settleRafs: motif.manifest.settle_rafs ?? null, fpsNum, fpsDen },
      });
    }
    plan.contents = [...contents.values()];
    if (retryKeys.size) {
      plan.retryKeys = [...retryKeys];
      plan.promoteKeys = [...retryKeys].sort((a, b) => priorityRanks.get(a)! - priorityRanks.get(b)!);
    }
    // A user action is one retry submission, even if a project update
    // supersedes its eventual acknowledgement. Ordinary re-plans cannot reset
    // the main-owned finite retry budget repeatedly.
    this.pendingRetryLayers.clear();
    this.pendingPriorityGroups = [];
    return plan;
  }

  private acceptSnapshot(snapshot: MotifBakeSnapshot): void {
    if (this.disposed || snapshot.generation !== this.generation) return;
    this.preparationError = null;
    // Replace inventory because retention can evict frames between snapshots.
    sharedBakedKeyIndex.clear();
    // Missing coverage means discovery failed or is still unknown, not that
    // there are no saved frames. Keep the disk-first probe available for those
    // live keys; exact empty inventories below still prove actual holes.
    for (const key of this.liveCacheKeys) {
      if (!(key in snapshot.coverage)) sharedBakedKeyIndex.add(key);
    }
    for (const [key, frames] of Object.entries(snapshot.coverage)) sharedBakedKeyIndex.restoreFrames(key, new Set(frames));
    this.bakeStatusByCacheKey = new Map(Object.entries(snapshot.statuses));
    setMotifPreparationCoverage(this.bakeStatusByCacheKey.keys());
    this.resumeAfterDiskDiscovery();
    this.recomputeBakeStatuses();
  }

  private resumeAfterDiskDiscovery(): void {
    this.diskDiscoveryPending = false;
    sharedBakedKeyIndex.finishHydration();
    this.updatePrewarmTargets(this.deps.currentTimeUs());
    this.recomputeBakeStatuses();
  }

  /// Build the per-layer bake-status map and publish it to the store. A layer
  /// shows: its baker status if live; else "ready" if its frames are already on
  /// disk (sharedBakedKeyIndex — e.g. baked last session, toggle off); else it
  /// is omitted (idle → no dot). O(motif layers); called on every onStatus,
  /// updateBakeTargets, and project change.
  private recomputeBakeStatuses(): void {
    if (this.disposed) return;
    const summary = this.deps.projectSummary();
    if (!summary) {
      if (this.lastBakeStatusSig !== "") { this.lastBakeStatusSig = ""; setLayerBakeStatuses({}); }
      return;
    }
    const byLayer: Record<string, LayerBakeStatus> = {};
    this.forEachMotifLayer(0, (layer) => {
      const motif = getMotif(layer.params.motif_id);
      if (!motif) return;
      const durationUs = layer.t_end_us - layer.t_start_us;
      const view = layer.params;
      const desc = motifFrameDescriptor(
        view, 0, durationUs, this.deps.fpsNum(), this.deps.fpsDen(), motif,
      );
      if (!desc) return;
      let live = this.bakeStatusByCacheKey.get(desc.cacheKey);
      if (this.preparationError && (useAppSettingsStore.getState().settings.prebake_motifs || this.manualPrebakeLayers.has(layer.id))) {
        live = { phase: 'error', done: 0, total: desc.contentDurationFrames, error: this.preparationError };
      }
      const requested = this.layerBakeRanges.get(layer.id);
      const saved = sharedBakedKeyIndex.framesFor(desc.cacheKey);
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
      // L0 coverage of this layer's content frames — the "is preview warm"
      // signal that drives the green bar — the cache owns exact O(1) counts,
      // including frames that predate this service (e.g. preview remount).
      const covered = sharedMotifFrameCache.frameCount(desc.cacheKey);
      const status = motifWarmPhase(
        live ?? null,
        covered,
        desc.contentDurationFrames,
        sharedBakedKeyIndex.isComplete(desc.cacheKey, desc.contentDurationFrames),
      );
      if (status) byLayer[layer.id] = status;
    });
    const sig = JSON.stringify(byLayer);
    if (sig === this.lastBakeStatusSig) return;
    this.lastBakeStatusSig = sig;
    setLayerBakeStatuses(byLayer);
  }
}
