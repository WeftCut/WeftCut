// The renderer's one way to get a Motif frame: `acquireMotifFrame` for any
// frame, `peekMotifFrame` for a synchronous L0 hit, `motifFrameCoverage` for
// what L0 holds. Owns L0 (both lanes), the baked-key index, request
// deduplication and admission; main owns capture and storage. See
// docs/motifs.md#admission.

import { MotifFrameCache } from "./frameCache";
import { BakedKeyIndex } from "./bakedKeyIndex";
import { motifPreviewActive, subscribeMotifPreview } from "./previewOverlay";
import { MotifFrameScheduler, type FrameResult, type ScheduledFrame } from './MotifFrameScheduler';
import { captureMotif } from './frameTransport';
import type { MotifFrameDescriptor } from './motifFrameDescriptor';
import { motifSuperseded } from '../../../shared/motifs/errors';
import { hashCacheKey } from '../../../shared/motifs/cacheKey';
import type { MotifFramePriority } from '../../../shared/motifs/frameTransport';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';

/// Process-wide per-frame cache shared by every request, so identical
/// (motif, props, dims, fps, frame) rasters resolve from one bitmap. Tests and
/// e2e hooks seed and clear it directly; everything else goes through
/// acquire, peek and coverage.
export const sharedMotifFrameCache = new MotifFrameCache();

/// The preview-overlay gesture lane: a separate LRU sharing the same aggregate
/// retention allowance for frames whose descriptor resolved with a pending
/// (uncommitted) params-page patch (`overlayActive`). Without it, every
/// gesture tick's fresh cacheKey would enter `sharedMotifFrameCache` and evict
/// COMMITTED content under the playhead. Its frames have no cache address:
/// never read, never stored.
export const sharedMotifOverlayCache = new MotifFrameCache();

// The lane is transient: when the last pending patch clears (gesture commit
// / cancel / panel teardown), every frame in it is garbage. Wipe on that
// transition instead of letting stale gesture rasters linger at full byte
// cost until LRU churn. `clearAll` retires rather than force-closes, so a
// sprite still binding a lane frame keeps it until its lease is released.
subscribeMotifPreview(() => {
  if (!motifPreviewActive()) sharedMotifOverlayCache.clearAll();
});

/// Process-wide index of which cacheKeys have frames baked on disk.
/// MotifFrameService restores it from main's bake snapshot; a frame main
/// reports stored is added.
export const sharedBakedKeyIndex = new BakedKeyIndex(() => scheduler.wake());

let mainPreparedKeys = new Set<string>();
const scheduler = new MotifFrameScheduler({
  shouldRead: (key, frame) => sharedBakedKeyIndex.hasFrame(key, frame) !== false,
  readMiss: (key, frame) => sharedBakedKeyIndex.forgetFrame(key, frame),
  stored: (key, frame) => sharedBakedKeyIndex.add(key, frame),
  backgroundCaptureAllowed: key => !mainPreparedKeys.has(key),
});

/** Durable preparation is the sole background producer for its content.
 * Renderer prewarming shares disk-read admission and waits for coverage; it
 * never competes with main's page-local capture slices. */
export function setMotifPreparationCoverage(cacheKeys: Iterable<string>): void {
  mainPreparedKeys = new Set(cacheKeys);
  scheduler.coverageChanged();
}

/** A frame held for its holder. Preview leases pin the L0 bitmap, so eviction
 * cannot close it while bound; an export lease owns its bitmap. `release` is
 * idempotent. */
export interface MotifFrameLease {
  readonly bitmap: ImageBitmap;
  /** The content frame the bitmap shows. */
  readonly frame: number;
  release(): void;
}

export interface MotifFrameRequest {
  /** Preview's Playback Resolution divisor; export reads at 1. */
  scaleDiv: MotifReaderDiv;
  priority: MotifFramePriority;
  /** Rank within its priority class: lower is sent to main first, equal ranks
   * in arrival order. Unranked requests go after ranked ones. */
  order?: number;
  /** Aborting rejects the request with `superseded`; the work stops once
   * nobody else wants the frame. */
  signal: AbortSignal;
  /** A newer `current` request from the same owner supersedes this one. */
  owner?: object;
  /** `export` skips L0 and gets a bitmap of its own; main keeps the frame. */
  purpose?: 'preview' | 'export';
  finalizationToken?: string;
}

/** A request in progress. `setPriority` re-classes and re-ranks it (`order`
 * omitted keeps its rank); its job follows, a capture in main moves between
 * classes, and once the request settled it does nothing. */
export interface MotifFrameAcquisition {
  readonly lease: Promise<MotifFrameLease>;
  setPriority(priority: MotifFramePriority, order?: number): void;
}

/** `committed` and `overlay` publish into their L0 lane; `export` never
 * touches L0. */
type Lane = 'committed' | 'overlay' | 'export';

interface Subscriber {
  priority: MotifFramePriority;
  order: number;
  owner: object | undefined;
  job: Job | null;
  settled: boolean;
  resolve: (lease: MotifFrameLease) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

interface Job {
  key: string;
  lane: Lane;
  cacheKey: string;
  frame: number;
  subscribers: Set<Subscriber>;
  scheduled: ScheduledFrame;
}

const jobs = new Map<string, Job>();
const unsettled = new Set<Subscriber>();
const owners = new WeakMap<object, Subscriber>();

/** A new workspace may reuse pixels, but must not inherit another workspace's
 * work: every pending request is superseded, and admitted work's results are
 * closed when they arrive. Leases already handed out stay valid. */
export function resetMotifFrameRequests(): void {
  mainPreparedKeys.clear();
  scheduler.reset();
  for (const subscriber of [...unsettled]) reject(subscriber, motifSuperseded());
  jobs.clear();
}

/** Coverage of L0's committed lane, for warming and status. */
export const motifFrameCoverage = {
  has: (cacheKey: string, frame: number, scaleDiv: MotifReaderDiv) => sharedMotifFrameCache.hasFrame(cacheKey, frame, scaleDiv),
  count: (cacheKey: string, scaleDiv: MotifReaderDiv) => sharedMotifFrameCache.frameCount(cacheKey, scaleDiv),
  capacityBytes: () => sharedMotifFrameCache.capacityBytes(),
  /** Keeps these frames, highest priority first, ahead of recently played ones. */
  prioritize: (targets: readonly { cacheKey: string; frame: number; scaleDiv: MotifReaderDiv }[]) =>
    sharedMotifFrameCache.prioritizeFrames(targets),
};
export type MotifFrameCoverage = typeof motifFrameCoverage;

const laneOf = (d: MotifFrameDescriptor): MotifFrameCache => d.overlayActive ? sharedMotifOverlayCache : sharedMotifFrameCache;

function pinned(cache: MotifFrameCache, bitmap: ImageBitmap, frame: number): MotifFrameLease {
  cache.retain(bitmap);
  let held = true;
  return { bitmap, frame, release: () => { if (held) { held = false; cache.release(bitmap); } } };
}

function owned(bitmap: ImageBitmap, frame: number): MotifFrameLease {
  let held = true;
  return { bitmap, frame, release: () => { if (held) { held = false; bitmap.close(); } } };
}

/** The frame from L0 at `scaleDiv`, pinned, or null. `frame` defaults to the
 * descriptor's. */
export function peekMotifFrame(d: MotifFrameDescriptor, scaleDiv: MotifReaderDiv, frame = d.contentFrame): MotifFrameLease | null {
  const cache = laneOf(d);
  const bitmap = cache.getFrame(d.cacheKey, frame, scaleDiv);
  return bitmap ? pinned(cache, bitmap, frame) : null;
}

const settledAcquisition = (lease: Promise<MotifFrameLease>): MotifFrameAcquisition => ({ lease, setPriority: () => {} });

/** One Motif frame: L0, else a stored frame read at `scaleDiv`, else a full-
 * size capture. Identical requests share one job whose priority is the highest
 * of its subscribers and whose order the lowest; a preview result is published
 * to L0 once and each subscriber gets its own pin. A `MotifTransportError`
 * rejects: it is not a miss and captures nothing. */
export function acquireMotifFrame(d: MotifFrameDescriptor, request: MotifFrameRequest): MotifFrameAcquisition {
  const { signal, owner, priority } = request;
  const lane: Lane = request.purpose === 'export' ? 'export' : d.overlayActive ? 'overlay' : 'committed';
  if (signal.aborted) return settledAcquisition(Promise.reject(motifSuperseded()));
  if (owner && priority === 'current') {
    const previous = owners.get(owner);
    if (previous) reject(previous, motifSuperseded());
  }
  if (lane !== 'export') {
    const hit = peekMotifFrame(d, request.scaleDiv);
    if (hit) return settledAcquisition(Promise.resolve(hit));
  }
  let subscriber!: Subscriber;
  const lease = new Promise<MotifFrameLease>((resolve, rejectRequest) => {
    subscriber = {
      priority, order: request.order ?? Infinity, owner, job: null, settled: false,
      resolve, reject: rejectRequest, detach: () => {},
    };
  });
  const abort = () => reject(subscriber, motifSuperseded());
  signal.addEventListener('abort', abort, { once: true });
  subscriber.detach = () => signal.removeEventListener('abort', abort);
  unsettled.add(subscriber);
  if (owner && priority === 'current') owners.set(owner, subscriber);
  void admit(subscriber, d, request, lane);
  return {
    lease,
    setPriority: (next, order = subscriber.order) => {
      if (subscriber.settled || (next === subscriber.priority && order === subscriber.order)) return;
      subscriber.priority = next;
      subscriber.order = order;
      subscriber.job?.scheduled.changed();
    },
  };
}

async function admit(subscriber: Subscriber, d: MotifFrameDescriptor, request: MotifFrameRequest, lane: Lane): Promise<void> {
  // An overlay frame is never stored, so it does not wait for the inventory.
  if (lane !== 'overlay') await sharedBakedKeyIndex.whenHydrated();
  if (subscriber.settled) return;
  if (lane !== 'export') {
    const hit = peekMotifFrame(d, request.scaleDiv);
    if (hit) { resolve(subscriber, hit); return; }
  }
  const token = request.finalizationToken;
  const key = JSON.stringify([lane, d.cacheKey, d.contentFrame, request.scaleDiv, token ?? null]);
  const job = jobs.get(key) ?? createJob(key, lane, d, request.scaleDiv, token);
  job.subscribers.add(subscriber);
  subscriber.job = job;
  job.scheduled.changed();
}

function createJob(key: string, lane: Lane, d: MotifFrameDescriptor, scaleDiv: MotifReaderDiv, token: string | undefined): Job {
  const { cacheKey, contentFrame: frame } = d;
  const subscribers = new Set<Subscriber>();
  const address = lane === 'overlay' ? undefined : { hash: hashCacheKey(cacheKey), frame };
  const job: Job = {
    key, lane, cacheKey, frame, subscribers,
    scheduled: scheduler.schedule({
      cacheKey, frame, scaleDiv,
      captureOnly: lane === 'overlay',
      unbounded: lane === 'export',
      priority: () => highest(subscribers),
      order: () => lowestOrder(subscribers),
      wanted: () => subscribers.size > 0,
      read: () => sharedMotifFrameCache.readBitmap(cacheKey, frame, scaleDiv, token ? { finalizationToken: token } : {}),
      capture: (afterMiss, priority) => captureMotif({
        motifId: d.motifId, tSec: d.tSec, propsJson: JSON.stringify(d.canonicalProps),
        width: d.renderW, height: d.renderH, contentHash: d.contentHash, fpsNum: d.fpsNum, fpsDen: d.fpsDen,
        priority,
        ...(address ? { address } : {}),
        ...(lane === 'export' ? { store: 'keep' as const } : {}),
        ...(afterMiss ? { afterMiss } : {}),
        ...(token ? { finalizationToken: token } : {}),
      }),
    }),
  };
  jobs.set(key, job);
  job.scheduled.result.then(value => publish(job, value), error => fail(job, error));
  return job;
}

function highest(subscribers: Set<Subscriber>): MotifFramePriority {
  let best: MotifFramePriority = 'background';
  for (const { priority } of subscribers) {
    if (priority === 'current') return priority;
    if (priority === 'ahead') best = priority;
  }
  return best;
}

function lowestOrder(subscribers: Set<Subscriber>): number {
  let lowest = Infinity;
  for (const { order } of subscribers) lowest = Math.min(lowest, order);
  return lowest;
}

function retire(job: Job): Subscriber[] {
  if (jobs.get(job.key) === job) jobs.delete(job.key);
  const subscribers = [...job.subscribers];
  job.subscribers.clear();
  return subscribers;
}

function publish(job: Job, { bitmap, div }: FrameResult): void {
  const subscribers = retire(job);
  if (!subscribers.length) { bitmap.close(); return; }
  if (job.lane === 'export') { void deliverOwned(subscribers, bitmap, job.frame); return; }
  const cache = job.lane === 'overlay' ? sharedMotifOverlayCache : sharedMotifFrameCache;
  const canonical = cache.setFrame(job.cacheKey, job.frame, div, bitmap);
  for (const subscriber of subscribers) resolve(subscriber, pinned(cache, canonical, job.frame));
}

/** Each export subscriber owns a bitmap: clones for all but one, which gets
 * the original once the clones are made. */
async function deliverOwned(subscribers: Subscriber[], bitmap: ImageBitmap, frame: number): Promise<void> {
  const [first, ...rest] = subscribers;
  const copies = await Promise.allSettled(rest.map(() => createImageBitmap(bitmap)));
  rest.forEach((subscriber, i) => {
    const copy = copies[i]!;
    if (copy.status === 'rejected') reject(subscriber, copy.reason);
    else if (subscriber.settled) copy.value.close();
    else resolve(subscriber, owned(copy.value, frame));
  });
  if (first!.settled) bitmap.close();
  else resolve(first!, owned(bitmap, frame));
}

function fail(job: Job, error: unknown): void {
  for (const subscriber of retire(job)) reject(subscriber, error);
}

function settle(subscriber: Subscriber): void {
  subscriber.settled = true;
  subscriber.detach();
  unsettled.delete(subscriber);
  if (subscriber.owner && owners.get(subscriber.owner) === subscriber) owners.delete(subscriber.owner);
}

function resolve(subscriber: Subscriber, lease: MotifFrameLease): void {
  if (subscriber.settled) { lease.release(); return; }
  settle(subscriber);
  subscriber.resolve(lease);
}

/** Withdraws a subscriber; its job stops once nobody wants the frame. */
function reject(subscriber: Subscriber, error: unknown): void {
  if (subscriber.settled) return;
  settle(subscriber);
  const { job } = subscriber;
  if (job?.subscribers.delete(subscriber)) {
    if (!job.subscribers.size && jobs.get(job.key) === job) jobs.delete(job.key);
    job.scheduled.changed();
  }
  subscriber.reject(error);
}
