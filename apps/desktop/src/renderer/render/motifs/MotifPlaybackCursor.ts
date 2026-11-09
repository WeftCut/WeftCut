import { atFrame, type MotifFrameDescriptor } from './motifFrameDescriptor';
import { acquireMotifFrame, peekMotifFrame, type MotifFrameLease } from './motifFrameSource';
import { motifErrorCode } from '../../../shared/motifs/errors';
import { MOTIF_DEADLINES } from '../../../shared/motifs/tuning';
import { motifTuning } from './tuning';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';

export interface MotifPlaybackSnapshot {
  targetFrame: number | null;
  /** The frame bound for the current target; a reset (seek, play or pause,
   * content refresh) clears it. */
  boundFrame: number | null;
  /** The frame on screen. A reset keeps it: the sprite holds its bitmap until
   * the next frame binds. */
  shownFrame: number | null;
  lagFrames: number | null;
  heldMs: number;
  maxLagFrames: number;
  maxHeldMs: number;
  pending: boolean;
  completed: number;
  discarded: number;
}

interface Request { descriptor: MotifFrameDescriptor; epoch: number; scaleDiv: MotifReaderDiv; controller: AbortController }

/** Per-instance preview demand and frame selection. Ordinary forward playback
 * coalesces BEHIND admitted work; only discontinuities abort it. Requests are
 * `current` and owned by the cursor (`acquireMotifFrame`), which deduplicates
 * across consumers. Each bound frame is a lease the sprite holds. */
export class MotifPlaybackCursor {
  private target: MotifFrameDescriptor | null = null;
  /** The Playback Resolution divisor of `target`; L0 hits match it exactly. */
  private scaleDiv: MotifReaderDiv = 1;
  private boundFrame: number | null = null;
  private shownFrame: number | null = null;
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
    /** Takes the lease; the sprite draws it at the descriptor's render size. */
    bind: (lease: MotifFrameLease, descriptor: MotifFrameDescriptor) => void;
    onLoaded: () => void;
    /** Preview's Playback Resolution divisor, read on each update. */
    scaleDiv: () => MotifReaderDiv;
  }) {}

  update(descriptor: MotifFrameDescriptor, playing: boolean): void {
    if (this.disposed) return;
    const previous = this.target;
    const scaleDiv = this.deps.scaleDiv();
    if (!previous) this.boundAt = performance.now();
    // A divisor change refills like a content refresh: the bound frame stays
    // on screen until the frame at the new divisor arrives.
    if (previous && (previous.cacheKey !== descriptor.cacheKey || scaleDiv !== this.scaleDiv ||
      previous.overlayActive !== descriptor.overlayActive ||
      descriptor.contentFrame < previous.contentFrame ||
      (!playing && descriptor.contentFrame !== previous.contentFrame) || this.playing !== playing)) {
      this.invalidate();
    }
    this.playing = playing;
    this.target = descriptor;
    this.scaleDiv = scaleDiv;
    this.measureHold();
    this.pump();
  }

  /** Seek (including same-target seeks), content refresh, or suspension. */
  invalidate(): void {
    this.epoch++;
    this.pending?.controller.abort();
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
      shownFrame: this.shownFrame, lagFrames, heldMs, maxLagFrames: this.maxLagFrames, maxHeldMs: this.maxHeldMs,
      pending: this.pending !== null, completed: this.completed, discarded: this.discarded };
  }

  dispose(): void { this.invalidate(); this.disposed = true; }

  private measureHold(): { lagFrames: number | null; heldMs: number } {
    const lagFrames = this.target && this.boundFrame !== null
      ? Math.max(0, this.target.contentFrame - this.boundFrame) : null;
    const heldMs = this.playing && this.target && lagFrames !== 0
      ? Math.max(0, performance.now() - this.boundAt) : 0;
    this.maxLagFrames = Math.max(this.maxLagFrames, lagFrames ?? 0);
    this.maxHeldMs = Math.max(this.maxHeldMs, heldMs);
    return { lagFrames, heldMs };
  }

  private bind(d: MotifFrameDescriptor, lease: MotifFrameLease): void {
    this.measureHold();
    this.deps.bind(lease, d);
    this.boundFrame = d.contentFrame;
    this.shownFrame = d.contentFrame;
    this.boundAt = performance.now();
    this.failures = 0;
    this.retryAt = 0;
  }

  private pump(): void {
    const d = this.target;
    if (this.disposed || !d || this.boundFrame === d.contentFrame) return;
    // Cache progress can overtake an admitted read; adopt it immediately and
    // never allow that older completion to roll the bitmap back.
    const cached = peekMotifFrame(d, this.scaleDiv);
    if (cached) { this.bind(d, cached); return; }
    if (this.playing) {
      const oldest = Math.max(0, d.contentFrame - motifTuning().recentFrames, (this.boundFrame ?? -1) + 1);
      for (let frame = d.contentFrame - 1; frame >= oldest; frame--) {
        const recent = peekMotifFrame(d, this.scaleDiv, frame);
        if (recent) { this.bind(atFrame(d, frame), recent); break; }
      }
    }
    if (this.pending || performance.now() < this.retryAt) return;
    const request = { descriptor: d, epoch: this.epoch, scaleDiv: this.scaleDiv, controller: new AbortController() };
    this.pending = request;
    void this.acquire(request);
  }

  private async acquire(request: Request): Promise<void> {
    const d = request.descriptor;
    try {
      const lease = await acquireMotifFrame(d, {
        scaleDiv: request.scaleDiv, priority: 'current', signal: request.controller.signal, owner: this,
      }).lease;
      if (this.disposed || request.epoch !== this.epoch) {
        lease.release(); this.discarded++; return;
      }
      this.completed++;
      const target = this.target;
      if (target && d.contentFrame <= target.contentFrame &&
        (this.boundFrame === null || d.contentFrame > this.boundFrame) &&
        (this.playing || d.contentFrame === target.contentFrame)) {
        this.bind(d, lease);
        this.deps.onLoaded();
      } else lease.release();
    } catch (error) {
      if (this.disposed || request.epoch !== this.epoch) return;
      // A warmed frame can overtake the read before it fails. That is already
      // successful progress, so the obsolete failure must not throttle demand.
      if (this.boundFrame !== null && this.boundFrame >= d.contentFrame) return;
      // A superseded request is not a failure. Any other, a
      // `MotifTransportError` included, keeps the bound frame and retries with
      // backoff; it never forgets or recaptures.
      if (motifErrorCode(error) !== 'superseded') {
        const retries = MOTIF_DEADLINES.previewRetryMs;
        this.retryAt = performance.now() + retries[Math.min(this.failures++, retries.length - 1)]!;
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
