// The preview's Motif demand session: applies the plans of `motifDemand` (the
// lookahead window, durable preparation, layer status) and owns what they need
// across calls — the prewarmer, the bake client, subscriptions, the planning
// signature, disk discovery and the session generation. Preview warming is
// renderer-owned; main owns durable preparation, inventory, retries and
// resource admission.

import type { ProjectSummary } from "../../ipc";
import { useAppSettingsStore } from "../../settings/appSettingsStore";
import {
  setLayerBakeStatuses,
  type LayerBakeStatus,
} from "../../timeline/motifBakeStatusStore";
import { forEachLayer } from "../compositionWalk";
import { getMotif, motifCatalogRevision, subscribeMotifCatalog } from "./catalog";
import { motifPlanningInputs } from './planningInputs';
import { motifLayerStatuses, planMotifDemand, planMotifPreparation } from './motifDemand';
import { MotifPrewarmer } from "./MotifPrewarmer";
import { MotifBakeClient } from './bakeClient';
import type { MotifBakePlan, MotifBakeSession, MotifBakeSnapshot, MotifFrameRange } from '../../../shared/motifs/baking';
import { motifTuning } from "./tuning";
import {
  acquireMotifFrame,
  motifFrameCoverage,
  sharedBakedKeyIndex,
  resetMotifFrameRequests,
  setMotifPreparationCoverage,
} from "./motifFrameSource";
import {
  bindPrebakeIntents,
  clearPrebakeIntents,
  explicitPrebakeLayers,
  resolvePrebakeIntents,
  subscribePrebakeIntents,
  takePrebakePromotions,
} from "./prebakeIntents";
import type { MotifReaderDiv } from "../../../shared/motifs/readerProtocol";

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

/// Everything the session reads of its owning Compositor. Getters, not values:
/// the snapshot / composition / fps / playhead all change under the session's
/// feet, and a captured copy would silently plan against a stale project.
export interface MotifDemandSessionDeps {
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

export class MotifDemandSession {
  /** The L0 budget the lookahead plans against, read when the prewarmer is built. */
  private readonly lookaheadCapBytes: number = 0;
  private layerBakeRanges = new Map<string, MotifFrameRange[]>();
  private prewarmer: MotifPrewarmer | null;
  private client: MotifBakeClient | null;
  private bakeStatusByCacheKey = new Map<string, LayerBakeStatus>();
  private lastBakeStatusSig = '';
  private liveCacheKeys: string[] = [];
  private intentsUnsub: (() => void) | null = null;
  private settingsUnsub: (() => void) | null = null;
  private lastPrewarmFrame = -1;
  private disposed = false;
  private generation: number | null = null;
  private catalogUnsub: (() => void) | null = null;
  private diskDiscoveryPending = false;
  private preparationError: string | null = null;
  private planningSignature: string | null = null;
  private div: MotifReaderDiv = 1;

  constructor(private readonly deps: MotifDemandSessionDeps) {
    if (typeof document !== "undefined") this.lookaheadCapBytes = motifFrameCoverage.capacityBytes();
    this.prewarmer =
      typeof document !== "undefined"
        ? new MotifPrewarmer({
            coverage: motifFrameCoverage,
            acquire: acquireMotifFrame,
            schedule: (cb) => scheduleIdle(cb),
            cancel: (t) => cancelIdle(t),
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
    // Startup hydrates the catalog; motifs:changed refreshes it. Timeline
    // edits must not synchronously scan/hash every Motif package in main.
    if (this.client) this.catalogUnsub = subscribeMotifCatalog(() => this.handleProjectChanged());
    if (this.client) this.settingsUnsub = useAppSettingsStore.subscribe((next, previous) => {
      if (next.settings.prebake_motifs !== previous.settings.prebake_motifs) this.handleProjectChanged();
    });
    if (this.client) this.intentsUnsub = subscribePrebakeIntents(() => {
      if (this.resolvePrebakes()) this.submitBakePlan();
    });
  }

  /// Brings the Pre-bake now intents up to this session's project, expanding
  /// a requested Group to the Motifs it holds now. Returns whether any request
  /// resolved.
  private resolvePrebakes(): boolean {
    const summary = this.deps.projectSummary();
    if (!summary) return false;
    return resolvePrebakeIntents(summary, this.generation, selected => {
      if (selected.params.kind === 'Motif') return [selected.id];
      if (selected.params.kind !== 'CompositionRef') return [];
      const ids: string[] = [];
      forEachLayer(summary, selected.params.composition_id, ({ layer }) => {
        if (layer.params.kind === 'Motif') ids.push(layer.id);
      });
      return ids;
    });
  }

  handleProjectChanged(): void {
    if (this.disposed || !this.client) return;
    const resolved = this.resolvePrebakes();
    const signature = JSON.stringify([motifPlanningInputs(this.deps.projectSummary()),
      this.deps.openCompositionId(), this.deps.fpsNum(), this.deps.fpsDen(),
      motifCatalogRevision(), useAppSettingsStore.getState().settings.prebake_motifs]);
    // Do not invalidate an in-flight acknowledgement, disk inventory or warm
    // targets for unrelated edits. Session-ready recovery belongs to the client
    // and explicit requests submit directly, bypassing this project-input gate.
    if (signature === this.planningSignature && !this.preparationError) {
      if (resolved) this.submitBakePlan();
      return;
    }
    this.planningSignature = signature;
    this.client.invalidate();
    this.lastPrewarmFrame = -1;
    this.diskDiscoveryPending = !!this.deps.projectSummary();
    this.prewarmer?.setTargets([]);
    if (this.diskDiscoveryPending) sharedBakedKeyIndex.beginHydration();
    else {
      sharedBakedKeyIndex.clear();
      clearPrebakeIntents();
      this.bakeStatusByCacheKey.clear();
      this.preparationError = null;
      setLayerBakeStatuses({});
    }
    this.submitBakePlan();
  }

  /// The Playback Resolution divisor preview, scrub and prewarm read stored
  /// Motif frames at (ADR 0154). Export and finalization always read at 1.
  get scaleDiv(): MotifReaderDiv {
    return this.div;
  }

  /// A new divisor: requests at the old one are obsolete. L0 is not cleared:
  /// frames read at another divisor stop matching and age out, live captures
  /// still serve; the window refills at `div`.
  setScaleDiv(div: MotifReaderDiv): void {
    if (div === this.div) return;
    this.div = div;
    this.prewarmer?.setTargets([]);
    this.lastPrewarmFrame = -1;
    this.updatePrewarmTargets(this.deps.currentTimeUs());
    this.recomputeBakeStatuses();
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
    this.prewarmer?.dispose();
    this.client?.dispose();
    this.intentsUnsub?.();
    this.settingsUnsub?.();
    this.catalogUnsub?.();
    sharedBakedKeyIndex.finishHydration();
    // Background jobs and durable coverage survive preview remounts.
  }

  // ============================================================
  // private
  // ============================================================

  /// Plan the lookahead at composition-time `tUs` and hand it to the
  /// prewarmer. Runs whether playing or paused (compositeFrame fires on
  /// seek/scrub too), so the cache warms ahead of the playhead in both states.
  private updatePrewarmTargets(tUs: number): void {
    const summary = this.deps.projectSummary();
    if (!this.prewarmer || !summary || this.diskDiscoveryPending) return;
    // A rejected durable plan is not permission to launch a second background
    // producer that only fills RAM. Foreground preview can still read/capture.
    if (this.preparationError) { this.prewarmer.setTargets([]); return; }
    const tuning = motifTuning();
    this.prewarmer.setTargets(planMotifDemand({
      summary, openCompositionId: this.deps.openCompositionId(),
      fpsNum: this.deps.fpsNum(), fpsDen: this.deps.fpsDen(),
      playheadUs: tUs, scaleDiv: this.div,
      budget: { capBytes: this.lookaheadCapBytes, requests: tuning.prewarmRequests,
        lookaheadUs: tuning.prewarmLookaheadMs * 1000, historyFrames: tuning.recentFrames },
      motif: getMotif,
      complete: (key, frames) => sharedBakedKeyIndex.isComplete(key, frames),
    }));
  }

  private submitBakePlan(): void {
    this.client?.reconcile(this.deps.projectSummary()?.project_id ?? null, session => this.buildBakePlan(session));
  }

  private buildBakePlan(session: MotifBakeSession): MotifBakePlan {
    if (this.generation !== session.generation) {
      bindPrebakeIntents(session.generation);
      this.generation = session.generation;
      resetMotifFrameRequests();
      sharedBakedKeyIndex.clear();
      if (this.diskDiscoveryPending) sharedBakedKeyIndex.beginHydration();
      this.bakeStatusByCacheKey.clear();
    }
    const summary = this.deps.projectSummary();
    if (!summary) {
      this.layerBakeRanges.clear();
      this.liveCacheKeys = [];
      return { generation: session.generation, contents: [], live: [], collect: true };
    }
    const demand = planMotifPreparation({
      summary, openCompositionId: this.deps.openCompositionId(),
      fpsNum: this.deps.fpsNum(), fpsDen: this.deps.fpsDen(), generation: session.generation,
      automatic: useAppSettingsStore.getState().settings.prebake_motifs,
      explicit: explicitPrebakeLayers(),
      // Taken by this plan even if a project update supersedes its acknowledgement.
      promote: takePrebakePromotions(),
      motif: getMotif,
    });
    this.layerBakeRanges = demand.layerRanges;
    this.liveCacheKeys = demand.liveCacheKeys;
    return demand.plan;
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

  /// Publish the per-layer bake statuses (`motifLayerStatuses`) when they
  /// change. O(motif layers); called on every snapshot, prewarm progress and
  /// project change.
  private recomputeBakeStatuses(): void {
    if (this.disposed) return;
    const summary = this.deps.projectSummary();
    if (!summary) {
      if (this.lastBakeStatusSig !== "") { this.lastBakeStatusSig = ""; setLayerBakeStatuses({}); }
      return;
    }
    const byLayer = motifLayerStatuses({
      summary, openCompositionId: this.deps.openCompositionId(),
      fpsNum: this.deps.fpsNum(), fpsDen: this.deps.fpsDen(), motif: getMotif,
      statuses: this.bakeStatusByCacheKey, layerRanges: this.layerBakeRanges,
      preparationError: this.preparationError,
      automatic: useAppSettingsStore.getState().settings.prebake_motifs,
      explicit: explicitPrebakeLayers(),
      saved: key => sharedBakedKeyIndex.framesFor(key),
      complete: (key, total) => sharedBakedKeyIndex.isComplete(key, total),
      warm: key => motifFrameCoverage.count(key, this.div),
    });
    const sig = JSON.stringify(byLayer);
    if (sig === this.lastBakeStatusSig) return;
    this.lastBakeStatusSig = sig;
    setLayerBakeStatuses(byLayer);
  }
}
