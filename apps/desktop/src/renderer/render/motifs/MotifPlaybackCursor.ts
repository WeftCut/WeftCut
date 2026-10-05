import type { Motif } from './catalog';
import type { MotifFrameDescriptor } from './motifFrameDescriptor';
import type { MotifFrameCache } from './frameCache';
import { cancelMotifFrameRequest, resolveMotifFrame, sharedMotifFrameCache, sharedMotifOverlayCache } from './motifRasterCache';
import { isCaptureSuperseded } from './host';
import { MOTIF_RECENT_FRAMES } from './motifFrames';

export interface MotifPlaybackSnapshot {
  targetFrame: number | null;
  boundFrame: number | null;
  lagFrames: number | null;
  heldMs: number;
  maxLagFrames: number;
  maxHeldMs: number;
  pending: boolean;
  completed: number;
  discarded: number;
}

interface Request { descriptor: MotifFrameDescriptor; epoch: number }
const RETRY_MS = [250, 1_000, 4_000];

/** Per-instance preview demand and frame selection. Ordinary forward playback
 * coalesces BEHIND admitted work; only discontinuities revoke its ownership.
 * The shared broker still owns cross-consumer deduplication and transport.
 * Bitmaps are cache-owned before bind; the sprite retains its existing pin. */
export class MotifPlaybackCursor {
  private readonly requestKey = `motif-preview:${crypto.randomUUID()}`;
  private target: MotifFrameDescriptor | null = null;
  private boundFrame: number | null = null;
  private boundAt = 0;
  private playing = false;
  private epoch = 0;
  private pending: Request | null = null;
  private disposed = false;
  private failures = 0;
  private retryAt = 0;
  private maxLagFrames = 0;
  private maxHeldMs = 0;
  private completed = 0;
  private discarded = 0;

  constructor(private readonly deps: {
    motif: () => Motif | null;
    fpsNum: number;
    fpsDen: number;
    bind: (bitmap: ImageBitmap, lane: MotifFrameCache) => void;
    onLoaded: () => void;
  }) {}

  update(descriptor: MotifFrameDescriptor, playing: boolean): void {
    if (this.disposed) return;
    const previous = this.target;
    if (!previous) this.boundAt = performance.now();
    if (previous && (previous.cacheKey !== descriptor.cacheKey ||
      previous.overlayActive !== descriptor.overlayActive ||
      descriptor.contentFrame < previous.contentFrame ||
      (!playing && descriptor.contentFrame !== previous.contentFrame) || this.playing !== playing)) {
      this.invalidate();
    }
    this.playing = playing;
    this.target = descriptor;
    this.measureHold();
    this.pump();
  }

  /** Seek (including same-target seeks), content refresh, or suspension. */
  invalidate(): void {
    this.epoch++;
    if (this.pending) cancelMotifFrameRequest(this.requestKey);
    this.pending = null;
    this.target = null;
    this.boundFrame = null;
    this.boundAt = performance.now();
    this.failures = 0;
    this.retryAt = 0;
    this.maxLagFrames = 0;
    this.maxHeldMs = 0;
  }

  snapshot(): MotifPlaybackSnapshot {
    const { lagFrames, heldMs } = this.measureHold();
    return { targetFrame: this.target?.contentFrame ?? null, boundFrame: this.boundFrame,
      lagFrames, heldMs, maxLagFrames: this.maxLagFrames, maxHeldMs: this.maxHeldMs,
      pending: this.pending !== null, completed: this.completed, discarded: this.discarded };
  }

  dispose(): void { this.invalidate(); this.disposed = true; }

  private lane(d: MotifFrameDescriptor): MotifFrameCache {
    return d.overlayActive ? sharedMotifOverlayCache : sharedMotifFrameCache;
  }

  private measureHold(): { lagFrames: number | null; heldMs: number } {
    const lagFrames = this.target && this.boundFrame !== null
      ? Math.max(0, this.target.contentFrame - this.boundFrame) : null;
    const heldMs = this.playing && this.target && lagFrames !== 0
      ? Math.max(0, performance.now() - this.boundAt) : 0;
    this.maxLagFrames = Math.max(this.maxLagFrames, lagFrames ?? 0);
    this.maxHeldMs = Math.max(this.maxHeldMs, heldMs);
    return { lagFrames, heldMs };
  }

  private bind(d: MotifFrameDescriptor, bitmap: ImageBitmap): void {
    this.measureHold();
    this.deps.bind(bitmap, this.lane(d));
    this.boundFrame = d.contentFrame;
    this.boundAt = performance.now();
    this.failures = 0;
    this.retryAt = 0;
  }

  private pump(): void {
    const d = this.target;
    if (this.disposed || !d || this.boundFrame === d.contentFrame) return;
    // Cache progress can overtake an admitted read; adopt it immediately and
    // never allow that older completion to roll the bitmap back.
    const cached = this.lane(d).getFrame(d.cacheKey, d.contentFrame);
    if (cached) { this.bind(d, cached); return; }
    if (this.playing) {
      const oldest = Math.max(0, d.contentFrame - MOTIF_RECENT_FRAMES, (this.boundFrame ?? -1) + 1);
      for (let frame = d.contentFrame - 1; frame >= oldest; frame--) {
        const recent = this.lane(d).getFrame(d.cacheKey, frame);
        if (recent) { this.bind({ ...d, contentFrame: frame }, recent); break; }
      }
    }
    if (this.pending || performance.now() < this.retryAt) return;
    const motif = this.deps.motif();
    if (!motif) return;
    const request = { descriptor: d, epoch: this.epoch };
    this.pending = request;
    void this.acquire(request, motif);
  }

  private async acquire(request: Request, motif: Motif): Promise<void> {
    const d = request.descriptor;
    try {
      const bitmap = await resolveMotifFrame(motif, d.cacheKey, d.contentFrame,
        d.tSec, d.durationSec, d.canonicalProps, this.requestKey,
        this.deps.fpsNum, this.deps.fpsDen, d.overlayActive);
      if (this.disposed || request.epoch !== this.epoch) {
        bitmap.close(); this.discarded++; return;
      }
      const canonical = this.lane(d).setFrame(d.cacheKey, d.contentFrame, bitmap);
      this.completed++;
      const target = this.target;
      if (target && d.contentFrame <= target.contentFrame &&
        (this.boundFrame === null || d.contentFrame > this.boundFrame) &&
        (this.playing || d.contentFrame === target.contentFrame)) {
        this.bind(d, canonical);
        this.deps.onLoaded();
      }
    } catch (error) {
      if (this.disposed || request.epoch !== this.epoch) return;
      // A warmed frame can overtake the read before it fails. That is already
      // successful progress, so the obsolete failure must not throttle demand.
      if (this.boundFrame !== null && this.boundFrame >= d.contentFrame) return;
      if (!isCaptureSuperseded(error)) {
        this.retryAt = performance.now() + RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]!;
        if (this.failures <= 3 || this.failures % 10 === 0) console.error('[weftcut/motifs] preview frame failed', error);
      }
    } finally {
      if (this.pending === request) {
        this.pending = null;
        // Coalesced demand may have moved while awaiting. No replay queue.
        // Failed/superseded same-target work retries on the next update, not
        // recursively in a microtask loop.
        if (this.target !== d) this.pump();
      }
    }
  }
}
