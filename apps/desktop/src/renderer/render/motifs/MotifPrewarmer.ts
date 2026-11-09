import { planPrewarmTargets, type PrewarmContent, type PrewarmTarget } from './prewarmPlan';
import { atFrame, type MotifFrameDescriptor } from './motifFrameDescriptor';
import type { acquireMotifFrame, MotifFrameAcquisition, MotifFrameCoverage } from './motifFrameSource';
import type { MotifFramePriority } from '../../../shared/motifs/frameTransport';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';
import { motifTuning } from './tuning';
import { motifErrorCode } from '../../../shared/motifs/errors';
import { MOTIF_DEADLINES } from '../../../shared/motifs/tuning';

export interface PrewarmContentSpec extends PrewarmContent {
  /// The content at the playhead; targets are other frames of it.
  descriptor: MotifFrameDescriptor;
  /// The divisor frames are requested at.
  scaleDiv: MotifReaderDiv;
}

export interface MotifPrewarmerDeps {
  capBytes: number;
  coverage: Pick<MotifFrameCoverage, 'has' | 'prioritize'>;
  acquire: typeof acquireMotifFrame;
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  onProgress?: () => void;
}

const address = (target: PrewarmTarget) => JSON.stringify([target.cacheKey, target.frame]);

interface Request { controller: AbortController; handle: MotifFrameAcquisition }

/** Owns a byte-bounded, playhead-relative demand window. Register the whole
 * window so holes waiting for capture cannot hide saved frames further ahead.
 * Frames at or after a playhead are `ahead`, history behind it `background`;
 * a request's order is its target's place in the plan. A request lands its
 * frame in L0; replans abort obsolete requests and re-class and re-rank kept
 * ones, so a playhead that passes a frame or seeks back before it moves it. */
export class MotifPrewarmer {
  private specs = new Map<string, PrewarmContentSpec>();
  /** Per content, the earliest playhead among its windows. */
  private playheads = new Map<string, number>();
  private targets: PrewarmTarget[] = [];
  private readonly requests = new Map<string, Request>();
  /** Targets admission refused `capacity` (an export holds its plan): each
   * waits out the preview's retry delays before it is requested again. */
  private readonly refused = new Map<string, { until: number; count: number }>();
  private scheduled: number | null = null;
  private disposed = false;

  constructor(private readonly deps: MotifPrewarmerDeps) {}

  setTargets(specs: PrewarmContentSpec[]): void {
    if (this.disposed) return;
    this.specs = new Map(specs.map(spec => [spec.cacheKey, spec]));
    this.playheads = new Map();
    for (const { cacheKey, contentFrame } of specs) {
      this.playheads.set(cacheKey, Math.min(this.playheads.get(cacheKey) ?? Infinity, contentFrame));
    }
    // Small authored sizes can fit thousands of frames in the pixel budget;
    // `prewarmRequests` also bounds requests and admission work.
    this.targets = planPrewarmTargets(specs, this.deps.capBytes, motifTuning().prewarmRequests);
    const wanted = new Set(this.targets.map(address));
    for (const [id, request] of this.requests) {
      if (!wanted.has(id)) {
        this.requests.delete(id);
        request.controller.abort();
      }
    }
    for (const id of this.refused.keys()) if (!wanted.has(id)) this.refused.delete(id);
    this.targets.forEach((target, index) => this.requests.get(address(target))?.handle.setPriority(this.priority(target), index));
    this.deps.coverage.prioritize(this.targets.map(target => ({ ...target, scaleDiv: this.specs.get(target.cacheKey)!.scaleDiv })));
    if (this.scheduled === null && this.targets.some(target => this.due(target))) {
      this.scheduled = this.deps.schedule(() => {
        this.scheduled = null;
        this.pump();
      });
    }
  }

  /** Neither in flight, nor in L0, nor waiting out a refusal. */
  private due(target: PrewarmTarget): boolean {
    const id = address(target);
    if (this.requests.has(id) || this.cached(target)) return false;
    return performance.now() >= (this.refused.get(id)?.until ?? 0);
  }

  private cached({ cacheKey, frame }: PrewarmTarget): boolean {
    return this.deps.coverage.has(cacheKey, frame, this.specs.get(cacheKey)!.scaleDiv);
  }

  private priority({ cacheKey, frame }: PrewarmTarget): MotifFramePriority {
    return frame >= this.playheads.get(cacheKey)! ? 'ahead' : 'background';
  }

  private pump(): void {
    if (this.disposed) return;
    this.targets.forEach((target, index) => {
      if (!this.due(target)) return;
      const id = address(target);
      const spec = this.specs.get(target.cacheKey)!;
      const controller = new AbortController();
      let handle: MotifFrameAcquisition;
      try {
        handle = this.deps.acquire(atFrame(spec.descriptor, target.frame), {
          scaleDiv: spec.scaleDiv, signal: controller.signal, priority: this.priority(target), order: index,
        });
      } catch {
        // As a failed request: retried on the next demand update, and the
        // other targets still go.
        return;
      }
      const request = { controller, handle };
      this.requests.set(id, request);
      void this.settle(id, request);
    });
  }

  private async settle(id: string, request: Request): Promise<void> {
    try {
      // The frame is in L0 now; warming holds no pin.
      (await request.handle.lease).release();
      this.refused.delete(id);
    } catch (error) {
      // Retry failures on the next demand update, never in a tight loop.
      if (motifErrorCode(error) === 'capacity' && this.requests.get(id) === request) {
        const delays = MOTIF_DEADLINES.previewRetryMs;
        const count = this.refused.get(id)?.count ?? 0;
        this.refused.set(id, { until: performance.now() + delays[Math.min(count, delays.length - 1)]!, count: count + 1 });
      }
    }
    finally {
      if (this.requests.get(id) === request) this.requests.delete(id);
      if (!this.disposed) this.deps.onProgress?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled !== null) this.deps.cancel(this.scheduled);
    this.scheduled = null;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.refused.clear();
    this.targets = [];
    this.specs.clear();
  }
}
