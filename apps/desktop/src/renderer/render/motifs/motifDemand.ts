// Pure Motif demand planning: which frames the preview's lookahead warms, what
// main should prepare, and how each layer's preparation reads on the timeline.
// Every input is explicit; the caller owns sessions, stores and applying the
// result (MotifDemandSession).

import type { ProjectSummary } from "../../ipc";
import type { MotifBakePlan, MotifFrameRange } from "../../../shared/motifs/baking";
import type { MotifContentRef, MotifFramePriority, MotifPresence } from "../../../shared/motifs/frameTransport";
import type { MotifReaderDiv } from "../../../shared/motifs/readerProtocol";
import { motifWarmPhase, type LayerBakeStatus } from "../../timeline/motifBakeStatusStore";
import { localAt } from "../compositionClock";
import { compositionLocalUs, forEachLayer, type PlacedLayer } from "../compositionWalk";
import type { Motif } from "./catalog";
import { hashCacheKey } from "./frameCache";
import { collectLiveRasterKeys } from "./liveRasterKeys";
import { motifFrameDescriptor, type MotifFrameDescriptor } from "./motifFrameDescriptor";

export type MotifLookup = (id: string) => Motif | null | undefined;

export interface LookaheadInput {
  summary: ProjectSummary;
  openCompositionId: string;
  fpsNum: number;
  fpsDen: number;
  /** The composition time lookahead runs from. */
  playheadUs: number;
  /** The Playback Resolution divisor saved frames are read at (ADR 0154). */
  scaleDiv: MotifReaderDiv;
  budget: {
    /** The L0 bytes the window may fill. */
    capBytes: number;
    /** Most requests at once: small authored sizes can fit thousands of
     * frames in the pixel budget, and each costs admission work. */
    requests: number;
    /** How far past the playhead a layer that has not started yet counts. */
    lookaheadUs: number;
    /** Recently passed frames kept eligible for a late completion. */
    historyFrames: number;
  };
  motif: MotifLookup;
  /** Whether every one of `frames` frames of a cache key is saved. */
  complete: (cacheKey: string, frames: number) => boolean;
}

/** One instance window of a content: its frame at the playhead and its cost. */
export interface LookaheadContent {
  cacheKey: string;
  /// Content frame at the current playhead (0-based; clamped to the content).
  contentFrame: number;
  contentDurationFrames: number;
  /// Decoded RGBA bytes per frame of this content (renderW × renderH × 4) —
  /// what one warmed frame costs the byte-bounded L0 cache. The plan budget
  /// is in bytes, so a 480×480 Motif warms ~9× more frames than a 1080p one
  /// while both stay within the same memory bound.
  frameBytes: number;
  /// Keep recently passed frames eligible for a late prewarm completion.
  historyFrames?: number;
  /// The content at the playhead; targets are other frames of it. It binds
  /// the plan-time fps, so a later fps change cannot drift the frames it names.
  descriptor: MotifFrameDescriptor;
  /// The divisor frames are requested at.
  scaleDiv: MotifReaderDiv;
}

/** One frame the lookahead wants in L0. */
export interface LookaheadTarget {
  cacheKey: string;
  frame: number;
  /** The content's descriptor; `atFrame(content, frame)` names the target. */
  content: MotifFrameDescriptor;
  scaleDiv: MotifReaderDiv;
  /** `ahead` at or after the content's earliest playhead, `background` for
   * history behind it. */
  priority: MotifFramePriority;
  /** The target's place in the plan. */
  order: number;
}

/// The lookahead window at `input.playheadUs`: every enabled Motif layer of
/// the open composition, Groups' included, that is visible or starts within
/// `lookaheadUs`. The current frame is never planned here: the preview's own
/// read asks for it.
export function planMotifDemand(input: LookaheadInput): LookaheadTarget[] {
  const { fpsNum, fpsDen, playheadUs: tUs, budget } = input;
  const contents: LookaheadContent[] = [];
  forEachLayer(input.summary, input.openCompositionId, ({ layer, offsetUs, clock, tStartUs, tEndUs }) => {
    if (layer.params.kind !== "Motif") return;
    // Prewarm only the visible/soon-visible window. Root spans already
    // include Group trims; sample a future layer at its actual entry time.
    if (tEndUs <= tUs || tStartUs > tUs + budget.lookaheadUs) return;
    const sampleUs = Math.max(tUs, tStartUs);
    // `compositionLocalUs`, not a bare subtraction: the descriptor's
    // `contentFrame` becomes a cache key, and the frame the SPRITE ends up
    // asking for is derived through the same re-snap on its way down the
    // nodes. A µs of lattice residual between the two would warm a key
    // nothing ever reads.
    const tLocalUs = clock ? localAt(clock, sampleUs) : compositionLocalUs(sampleUs - offsetUs, fpsNum, fpsDen);
    const motif = input.motif(layer.params.motif_id);
    if (!motif) return;
    const durationUs = layer.t_end_us - layer.t_start_us;
    const desc = motifFrameDescriptor(layer.params, tLocalUs - layer.t_start_us, durationUs, fpsNum, fpsDen, motif);
    if (!desc) return;
    // Saved frames read at the divisor; holes are captured at full size.
    // Plan only fully saved content at the smaller size, so the window
    // never outgrows L0 with captures.
    const div = input.complete(desc.cacheKey, desc.contentDurationFrames) ? input.scaleDiv : 1;
    contents.push({
      cacheKey: desc.cacheKey,
      contentFrame: desc.contentFrame,
      contentDurationFrames: desc.contentDurationFrames,
      historyFrames: budget.historyFrames,
      frameBytes: Math.ceil(desc.renderW / div) * Math.ceil(desc.renderH / div) * 4,
      descriptor: desc,
      scaleDiv: input.scaleDiv,
    });
  });
  return planLookaheadTargets(contents, budget.capBytes, budget.requests);
}

export interface PresenceInput {
  summary: ProjectSummary;
  openCompositionId: string;
  fpsNum: number;
  fpsDen: number;
  playheadUs: number;
  /** How far past the playhead the next Motif to enter counts
   * (`presenceLookaheadMs`). */
  lookaheadUs: number;
  motif: MotifLookup;
}

/// The Motif content versions on screen at the playhead, Groups' included,
/// and the soonest one not on screen to enter within `lookaheadUs` with the
/// size it captures at, each once, for main's capture hosts (ADR 0161). A
/// content version is its Motif and content hash: props do not change the
/// host that renders it.
export function planMotifPresence(input: PresenceInput): Omit<MotifPresence, 'playing'> {
  const { fpsNum, fpsDen, playheadUs: tUs } = input;
  const visible = new Map<string, MotifContentRef>();
  const entering: { ref: MotifContentRef; atUs: number; width: number; height: number }[] = [];
  forEachLayer(input.summary, input.openCompositionId, ({ layer, offsetUs, clock, tStartUs, tEndUs }) => {
    if (layer.params.kind !== "Motif") return;
    if (tEndUs <= tUs || tStartUs > tUs + input.lookaheadUs) return;
    const motif = input.motif(layer.params.motif_id);
    if (!motif) return;
    const sampleUs = Math.max(tUs, tStartUs);
    const tLocalUs = clock ? localAt(clock, sampleUs) : compositionLocalUs(sampleUs - offsetUs, fpsNum, fpsDen);
    const desc = motifFrameDescriptor(layer.params, tLocalUs - layer.t_start_us, layer.t_end_us - layer.t_start_us, fpsNum, fpsDen, motif);
    if (!desc) return;
    const ref = { motifId: desc.motifId, contentHash: desc.contentHash };
    if (tStartUs <= tUs) visible.set(contentKey(ref), ref);
    else entering.push({ ref, atUs: tStartUs, width: desc.renderW, height: desc.renderH });
  });
  let next: (typeof entering)[number] | null = null;
  for (const e of entering) if (!visible.has(contentKey(e.ref)) && (!next || e.atUs < next.atUs)) next = e;
  return {
    visible: [...visible.values()],
    next: next ? { ...next.ref, inMs: (next.atUs - tUs) / 1000, width: next.width, height: next.height } : null,
  };
}

const contentKey = (ref: MotifContentRef) => `${ref.motifId}\0${ref.contentHash}`;

/// Share the byte budget across content identities, then round-robin both
/// contents and their instance windows. Repeated Group instances can need
/// different frames of the same content without paying twice for shared ones.
/// Frames at or after a content's earliest playhead are `ahead`, history
/// behind it `background`.
export function planLookaheadTargets(
  contents: readonly LookaheadContent[],
  capBytes: number,
  maxTargets = Number.POSITIVE_INFINITY,
): LookaheadTarget[] {
  const groups = new Map<string, LookaheadContent[]>();
  /** Per content, the window whose descriptor and divisor its targets use. */
  const named = new Map<string, LookaheadContent>();
  const playheads = new Map<string, number>();
  for (const c of contents) {
    const windows = groups.get(c.cacheKey) ?? [];
    if (!windows.some(w => w.contentFrame === c.contentFrame)) windows.push(c);
    groups.set(c.cacheKey, windows);
    named.set(c.cacheKey, c);
    playheads.set(c.cacheKey, Math.min(playheads.get(c.cacheKey) ?? Infinity, c.contentFrame));
  }
  const keys = [...groups.keys()];
  const perContent = [...groups.values()].map(windows => {
    const frameBytes = Math.max(1, ...windows.map(c => c.frameBytes));
    const budget = Math.min(maxTargets, Math.max(0, Math.floor(capBytes / (keys.length * frameBytes))));
    const orders = windows.map(c => {
      const n = c.contentDurationFrames;
      const want = Math.min(budget, n);
      const start = Math.max(0, Math.min(c.contentFrame, n - 1));
      const history = Math.min(c.historyFrames ?? 0, start, Math.max(0, want - 1));
      const order: number[] = [];
      for (let f = start; f < n && order.length < want - history; f++) order.push(f);
      for (let f = start - 1; f >= start - history && order.length < want; f--) order.push(f);
      for (let f = 0; f < start && order.length < want; f++) {
        if (f < start - history) order.push(f);
      }
      return order;
    });
    const frames = new Set<number>();
    const depth = Math.max(0, ...orders.map(a => a.length));
    for (let i = 0; i < depth && frames.size < budget; i++) {
      for (const order of orders) {
        if (i < order.length && frames.size < budget) frames.add(order[i]!);
      }
    }
    return [...frames];
  });

  const out: LookaheadTarget[] = [];
  const maxLen = perContent.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen && out.length < maxTargets; i++) {
    for (let c = 0; c < keys.length && out.length < maxTargets; c++) {
      const frames = perContent[c]!;
      if (i >= frames.length) continue;
      const cacheKey = keys[c]!, frame = frames[i]!;
      const { descriptor, scaleDiv } = named.get(cacheKey)!;
      out.push({
        cacheKey, frame, content: descriptor, scaleDiv,
        priority: frame >= playheads.get(cacheKey)! ? 'ahead' : 'background',
        order: out.length,
      });
    }
  }
  return out;
}

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
