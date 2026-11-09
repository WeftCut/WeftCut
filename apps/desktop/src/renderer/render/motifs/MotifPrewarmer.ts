import { planPrewarmTargets, type PrewarmContent, type PrewarmTarget } from './prewarmPlan';
import { atFrame, type MotifFrameDescriptor } from './motifFrameDescriptor';
import type { acquireMotifFrame, MotifFrameAcquisition, MotifFrameCoverage } from './motifFrameSource';
import type { MotifFramePriority } from '../../../shared/motifs/frameTransport';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';
import { motifTuning } from './tuning';

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
    this.targets.forEach((target, index) => this.requests.get(address(target))?.handle.setPriority(this.priority(target), index));
    this.deps.coverage.prioritize(this.targets.map(target => ({ ...target, scaleDiv: this.specs.get(target.cacheKey)!.scaleDiv })));
    if (this.scheduled === null && this.targets.some(target => !this.requests.has(address(target)) && !this.cached(target))) {
      this.scheduled = this.deps.schedule(() => {
        this.scheduled = null;
        this.pump();
      });
    }
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
      const id = address(target);
      if (this.requests.has(id) || this.cached(target)) return;
      const spec = this.specs.get(target.cacheKey)!;
      const controller = new AbortController();
      const handle = this.deps.acquire(atFrame(spec.descriptor, target.frame), {
        scaleDiv: spec.scaleDiv, signal: controller.signal, priority: this.priority(target), order: index,
      });
      const request = { controller, handle };
      this.requests.set(id, request);
      void this.settle(id, request);
    });
  }

  private async settle(id: string, request: Request): Promise<void> {
    try {
      // The frame is in L0 now; warming holds no pin.
      (await request.handle.lease).release();
    } catch { /* Retry failures on the next demand update, never in a tight loop. */ }
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
    this.targets = [];
    this.specs.clear();
  }
}
