// The single owner of the PREVIEW realm's motif raster lifecycle: the L0 warm
// prewarmer, the L2 disk baker, the baked-index hydrate/GC, and the per-layer
// bake-status feed. What triggers it: a project snapshot change
// (`handleProjectChanged` — re-plan targets, re-publish statuses, kick the
// serialized hydrate/GC), the playhead crossing a frame boundary
// (`noteFrameBoundary` — re-plan, throttled to once per composition frame),
// the timeline's "Pre-bake now" bus, and the prewarmer/baker's own progress
// callbacks (status recompute).
//
// Realm gating: the prewarmer and baker are constructed only where `document`
// exists. The export Worker has no DOM — its motif frames arrive injected via
// `Compositor.setMotifFrames`, a different mechanism — so it gets NEITHER,
// and every method here degrades to a no-op there.
//
// Owned by the Compositor as a collaborator. The service never reaches back
// into Compositor internals: everything it reads of the owner arrives through
// the narrow `MotifFrameServiceDeps` getters.

import type { LayerSummary, ProjectSummary } from "../../ipc";
import { useAppSettingsStore } from "../../settings/appSettingsStore";
import {
  setLayerBakeStatuses,
  motifWarmPhase,
  type LayerBakeStatus,
} from "../../timeline/motifBakeStatusStore";
import { compositionLocalUs, forEachLayer } from "../compositionWalk";
import { getMotif } from "./catalog";
import { MotifPrewarmer, type PrewarmContentSpec } from "./MotifPrewarmer";
import { MotifBaker, type BakeContentSpec } from "./MotifBaker";
import { motifFrameDescriptor } from "./motifFrameDescriptor";
import {
  resolveMotifFrame,
  sharedBakedKeyIndex,
  sharedMotifFrameCache,
  acquireBakedMotifFrame,
  resetMotifFrameRequests,
} from "./motifRasterCache";
import { encodeBitmapToPng } from "./pngEncode";
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

export class MotifFrameService {
  /// Background filler that warms the shared motif-frame cache ahead of the
  /// playhead. DOM-gated: only a DOM realm (the main-thread preview) creates
  /// one; the export Worker (no `document`, frames injected via
  /// `setMotifFrames`) leaves it null.
  private prewarmer: MotifPrewarmer | null;
  /// L2 writer. DOM-gated like the prewarmer (never in the export Worker).
  private baker: MotifBaker | null;
  /// Latest per-cacheKey bake status from the baker. Fanned out to per-layer
  /// entries in `recomputeBakeStatuses`.
  private bakeStatusByCacheKey = new Map<string, LayerBakeStatus>();
  /// Signature of the last published bake-status map, so recompute is a no-op
  /// when nothing changed (it runs every frame via updateBakeTargets).
  private lastBakeStatusSig = "";
  /// LayerIds the user manually "Pre-bake now"'d this session — baked even
  /// when the global setting is off.
  private manualPrebakeLayers = new Set<string>();
  /// Monotonic epoch, bumped by every project change (both paths). The
  /// hydrate/GC run captures it and bails at each await boundary once it has
  /// moved on — its snapshot-derived reads would be stale against the newer
  /// summary/fps, and the pending re-run supersedes it. Per-Compositor on
  /// purpose even though `sharedBakedKeyIndex` is a process-wide singleton:
  /// preview is the only realm with a baker (see above), so one epoch guards
  /// the one writer.
  private projectEpoch = 0;
  /// Serialization of `hydrateBakedIndexAndGc`: at most one run in flight; a
  /// project change arriving mid-run arms ONE coalesced follow-up, never a
  /// queue (a firehose of snapshots must not stack GC passes).
  private hydrateGcRunning = false;
  private hydrateGcPending = false;
  /// Unsubscribe handle for the prebake bus.
  private prebakeUnsub: (() => void) | null = null;
  /// Last composition frame index we re-planned the prewarm targets at, so the
  /// per-tick refresh in `noteFrameBoundary` only fires on a frame change.
  private lastPrewarmFrame = -1;
  private disposed = false;
  private projectId: string | null = null;

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
            // batchSize 1: captures serialize in the main process (the single
            // capture host's promise chain in main/motif/capture.ts), so a
            // larger batch only adds head-of-line latency for an on-demand
            // scrub. One in-flight capture per loop keeps the shared host
            // queue short.
            batchSize: 1,
            onProgress: () => this.recomputeBakeStatuses(),
          })
        : null;
    this.baker =
      typeof document !== "undefined"
        ? new MotifBaker({
            schedule: (cb) => scheduleIdle(cb),
            cancel: (t) => cancelIdle(t),
            // batchSize 1: same head-of-line rationale as the prewarmer above.
            batchSize: 1,
            isOnDisk: (k, f) => sharedMotifFrameCache.hasPersistedFrame(k, f),
            persist: async (k, f, bmp) => {
              const png = await encodeBitmapToPng(bmp);
              if (this.disposed) return;
              await sharedMotifFrameCache.writeFrame(k, f, png);
            },
            warm: (k, f, bmp) => {
              sharedBakedKeyIndex.add(k);
              sharedMotifFrameCache.setFrame(k, f, bmp);
            },
            onStatus: (cacheKey, status) => {
              this.bakeStatusByCacheKey.set(cacheKey, status);
              this.recomputeBakeStatuses();
            },
          })
        : null;
  }

  /// The project snapshot changed (or was closed — the null path tears down
  /// instead). Bumps the epoch, re-plans prewarm/bake targets at the current
  /// playhead, re-publishes bake statuses, and kicks the serialized
  /// hydrate/GC.
  handleProjectChanged(): void {
    if (this.disposed) return;
    this.projectEpoch += 1;
    this.lastPrewarmFrame = -1;
    const summary = this.deps.projectSummary();
    const projectId = summary?.project_id ?? null;
    if (projectId !== this.projectId) {
      this.projectId = projectId;
      resetMotifFrameRequests();
    }
    if (!summary) {
      this.prewarmer?.setTargets([]);
      this.baker?.setTargets([]);
      this.manualPrebakeLayers.clear();
      sharedBakedKeyIndex.clear();
      this.bakeStatusByCacheKey.clear();
      this.lastBakeStatusSig = "";
      setLayerBakeStatuses({});
      return;
    }
    // Subscribe to the timeline's "Pre-bake now" bus exactly once (DOM-gated
    // by `this.baker`). A request records the layer and refreshes bake targets
    // so it bakes even when the global setting is off.
    if (this.baker && !this.prebakeUnsub) {
      this.prebakeUnsub = onPrebakeRequest((layerId) => {
        this.manualPrebakeLayers.add(layerId);
        this.updateBakeTargets(this.deps.currentTimeUs());
      });
    }
    // Re-plan the prewarm window against the new project at the current
    // playhead. Reached only for a non-null summary (the null branch returns
    // above).
    const tUs = this.deps.currentTimeUs();
    this.updatePrewarmTargets(tUs);
    this.updateBakeTargets(tUs);
    this.recomputeBakeStatuses();
    // Hydrate the on-disk baked-key index + GC orphaned hash dirs against the
    // new project's live keys. Fire-and-forget — never blocks load. Serialized
    // (at most one run, latest-wins coalescing) so overlapping runs can't
    // interleave their readDir/remove or GC against a stale snapshot.
    this.scheduleHydrateBakedIndexAndGc();
  }

  /// The playhead composited at `tUsSnapped` (already on the frame grid).
  /// Refreshes the prewarm + bake windows when the playhead crosses a frame
  /// boundary; throttled to once per composition frame so scrub/play ticks
  /// within the same frame don't re-plan. Runs whether playing or paused.
  noteFrameBoundary(tUsSnapped: number): void {
    if (!this.prewarmer) return;
    const frameIdx = Math.round(
      (tUsSnapped * this.deps.fpsNum()) / (1_000_000 * this.deps.fpsDen()),
    );
    if (frameIdx === this.lastPrewarmFrame) return;
    this.lastPrewarmFrame = frameIdx;
    this.updatePrewarmTargets(tUsSnapped);
    this.updateBakeTargets(tUsSnapped);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.projectEpoch += 1;
    this.hydrateGcPending = false;
    this.prewarmer?.dispose();
    this.prewarmer = null;
    this.baker?.dispose();
    this.baker = null;
    this.prebakeUnsub?.();
    this.prebakeUnsub = null;
    this.manualPrebakeLayers.clear();
    sharedBakedKeyIndex.clear();
    this.bakeStatusByCacheKey.clear();
    this.lastBakeStatusSig = "";
    setLayerBakeStatuses({});
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
  ): void {
    const summary = this.deps.projectSummary();
    if (!summary) return;
    const fpsNum = this.deps.fpsNum();
    const fpsDen = this.deps.fpsDen();
    forEachLayer(summary, this.deps.openCompositionId(), ({ layer, offsetUs }) => {
      if (layer.params.kind !== "Motif") return;
      // `compositionLocalUs`, not a bare subtraction: the descriptor's
      // `contentFrame` becomes a cache key, and the frame the SPRITE ends up
      // asking for is derived through the same re-snap on its way down the
      // nodes. A µs of lattice residual between the two would warm a key
      // nothing ever reads.
      const tLocalUs = compositionLocalUs(tUs - offsetUs, fpsNum, fpsDen);
      f(layer as LayerSummary & { params: { kind: "Motif" } }, tLocalUs - layer.t_start_us);
    });
  }

  /// Map the active motif layers at composition-time `tUs` to prewarm specs
  /// (deduped by cacheKey inside the planner) and hand them to the prewarmer.
  /// Runs whether playing or paused (compositeFrame fires on seek/scrub too), so
  /// the cache warms ahead of the playhead in both states.
  private updatePrewarmTargets(tUs: number): void {
    const summary = this.deps.projectSummary();
    if (!this.prewarmer || !summary) return;
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
        // What one warmed frame costs the byte-bounded L0 cache — the planner
        // budget is in bytes, so a small Motif warms deeper than a 1080p one.
        frameBytes: desc.renderW * desc.renderH * 4,
        // tSec for an arbitrary content frame = frame * fpsDen / fpsNum.
        // Disk-first: prefer a baked frame over a live raster, falling through
        // to `rasterMotifFrame` (CDP) inside the resolver on miss / fs hiccup.
        render: (frame: number) =>
          resolveMotifFrame(
            motif,
            desc.cacheKey,
            frame,
            (frame * fpsDen) / fpsNum,
            durationSec,
            canonicalProps,
            undefined,
            fpsNum,
            fpsDen,
          ),
      });
    });
    this.prewarmer.setTargets(specs);
  }

  /// Feed the L2 baker (the SOLE disk writer). Persists the FULL content of:
  /// every active motif content when the global `prebake_motifs` setting
  /// is on, PLUS any layer the user manually "Pre-bake now"'d this session
  /// (regardless of the setting). Mirrors `updatePrewarmTargets`' descriptor
  /// shape; acquisition reuses L0/in-flight captures. A fresh capture requests
  /// native persistence; an existing bitmap uses the compatibility writer.
  private updateBakeTargets(tUs: number): void {
    const summary = this.deps.projectSummary();
    if (!this.baker || !summary) return;
    const globalOn = useAppSettingsStore.getState().settings.prebake_motifs;
    const specs: BakeContentSpec[] = [];
    this.forEachMotifLayer(tUs, (layer, tInLayerUs) => {
      const wanted = globalOn || this.manualPrebakeLayers.has(layer.id);
      if (!wanted) return;
      const motif = getMotif(layer.params.motif_id);
      if (!motif) return;
      const durationUs = layer.t_end_us - layer.t_start_us;
      const view = layer.params;
      const fpsNum = this.deps.fpsNum();
      const fpsDen = this.deps.fpsDen();
      const desc = motifFrameDescriptor(view, tInLayerUs, durationUs, fpsNum, fpsDen, motif);
      if (!desc) return;
      // Plan-time fps in locals — same closure-capture rationale as
      // `updatePrewarmTargets`.
      const canonicalProps = desc.canonicalProps;
      specs.push({
        cacheKey: desc.cacheKey,
        contentFrame: desc.contentFrame,
        contentDurationFrames: desc.contentDurationFrames,
        // tSec for an arbitrary content frame = frame * fpsDen / fpsNum.
        render: (frame: number) => acquireBakedMotifFrame(motif, desc.cacheKey, frame, fpsNum, fpsDen, canonicalProps),
      });
    });
    const activeKeys = new Set(specs.map((spec) => spec.cacheKey));
    for (const key of this.bakeStatusByCacheKey.keys()) {
      if (!activeKeys.has(key)) this.bakeStatusByCacheKey.delete(key);
    }
    this.baker.setTargets(specs);
    this.recomputeBakeStatuses();
  }

  /// On project load: rebuild the in-RAM baked-key index from what's on disk
  /// (so the resolver's disk-first read fires only for keys that actually have
  /// frames) and reclaim disk for hash dirs no live key references anymore.
  /// Fire-and-forget; any fs error is swallowed so it can never block load.
  ///
  /// Runs only through `scheduleHydrateBakedIndexAndGc` (serialized, epoch-
  /// guarded): two overlapping runs could interleave their readDir/remove, and
  /// a run that computed its live set at T0 would otherwise GC frames a
  /// concurrent baker write or newer snapshot just made live.
  ///
  /// Safety rules for the GC half (see liveRasterKeys.ts for the why):
  /// 1. Re-pull the user-Motif catalog first — project open can win the race
  ///    against the boot-time catalog sync, and GC'ing against a stale catalog
  ///    deletes live frames.
  /// 2. If ANY motif layer is unresolvable afterwards, skip the GC entirely:
  ///    "can't resolve" is not "orphaned".
  /// 3. The live set includes the baker's queued/in-flight target keys, so a
  ///    hash dir the baker is writing into right now is never collected
  ///    mid-write.
  private async hydrateBakedIndexAndGc(): Promise<void> {
    const summary = this.deps.projectSummary();
    if (!summary) return;
    const epoch = this.projectEpoch;
    // True once a newer project change superseded this run: bail before
    // touching shared state — the pending re-run redoes the work against the
    // new snapshot. (sharedBakedKeyIndex is a module singleton, but this guard
    // is per-Compositor; the preview realm is the only one that runs this.)
    const stale = () => this.disposed || this.projectEpoch !== epoch;
    // Preview-realm only: the export Worker has no window/IPC bridge (the
    // sync would warn-fail) and no L2 to GC (rasterRootDir is null there).
    if (this.baker) await syncUserMotifsFromBackend();
    if (stale()) return;
    const { activeKeys, unresolved } = collectLiveRasterKeys(
      summary,
      this.deps.fpsNum(),
      this.deps.fpsDen(),
    );
    sharedBakedKeyIndex.setLiveCandidates(activeKeys);
    try {
      const hashes = await sharedMotifFrameCache.listBakedHashes();
      if (stale()) return; // don't write a stale run's hydration into the index
      sharedBakedKeyIndex.hydrateFromHashes(hashes);
      // The index now reflects on-disk frames; recompute so last-session-baked
      // layers (no live baker status) surface as "ready".
      this.recomputeBakeStatuses();
      if (unresolved.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/motifs] skipping raster GC: ${unresolved.length} motif id(s) unresolvable ` +
            `(${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? ", …" : ""}) — ` +
            `their on-disk frames are kept`,
        );
        return;
      }
      // Live = the snapshot's active keys ∪ what the baker is queued/writing
      // RIGHT NOW: a GC computed from activeKeys alone could delete a hash dir
      // a concurrent bake just created for a newly-targeted content.
      await sharedMotifFrameCache.gcUnreferenced([
        ...activeKeys,
        ...(this.baker?.targetCacheKeys() ?? []),
      ], () => !stale());
    } catch (e) {
      console.warn("[weftcut/motifs] baked-index hydrate/gc failed", e);
    }
  }

  /// Kick `hydrateBakedIndexAndGc` with at most one run in flight. A run that
  /// is already underway is not duplicated; a project change arriving mid-run
  /// arms a single follow-up so the latest snapshot's hydrate/GC still
  /// happens. Never re-arms after dispose.
  private scheduleHydrateBakedIndexAndGc(): void {
    if (this.hydrateGcRunning) {
      this.hydrateGcPending = true;
      return;
    }
    this.hydrateGcRunning = true;
    // Never rejects: hydrate swallows fs errors, and syncUserMotifsFromBackend
    // swallows IPC ones.
    void this.hydrateBakedIndexAndGc().finally(() => {
      this.hydrateGcRunning = false;
      const again = this.hydrateGcPending;
      this.hydrateGcPending = false;
      if (again && !this.disposed) this.scheduleHydrateBakedIndexAndGc();
    });
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
      const live = this.bakeStatusByCacheKey.get(desc.cacheKey);
      // L0 coverage of this layer's content frames — the "is preview warm"
      // signal that drives the green bar — the cache owns exact O(1) counts,
      // including frames that predate this service (e.g. preview remount).
      const covered = sharedMotifFrameCache.frameCount(desc.cacheKey);
      const status = motifWarmPhase(
        live ?? null,
        covered,
        desc.contentDurationFrames,
        sharedBakedKeyIndex.has(desc.cacheKey),
      );
      if (status) byLayer[layer.id] = status;
    });
    const sig = JSON.stringify(byLayer);
    if (sig === this.lastBakeStatusSig) return;
    this.lastBakeStatusSig = sig;
    setLayerBakeStatuses(byLayer);
  }
}
