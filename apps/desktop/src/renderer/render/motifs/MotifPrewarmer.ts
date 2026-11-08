import { planPrewarmTargets, type PrewarmContent, type PrewarmTarget } from './prewarmPlan';
import { atFrame, type MotifFrameDescriptor } from './motifFrameDescriptor';
import type { acquireMotifFrame, MotifFrameCoverage } from './motifFrameSource';
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

/** Owns a byte-bounded, playhead-relative demand window. Register the whole
 * window so holes waiting for capture cannot hide saved frames further ahead.
 * Frames at or after a playhead are `ahead`, history behind it `background`.
 * A request lands its frame in L0; replans keep useful requests and abort
 * obsolete ones. */
export class MotifPrewarmer {
  private specs = new Map<string, PrewarmContentSpec>();
  /** Per content, the earliest playhead among its windows. */
  private playheads = new Map<string, number>();
  private targets: PrewarmTarget[] = [];
  private readonly requests = new Map<string, AbortController>();
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
        request.abort();
      }
    }
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

  private pump(): void {
    if (this.disposed) return;
    for (const target of this.targets) {
      const id = address(target);
      if (this.requests.has(id) || this.cached(target)) continue;
      const controller = new AbortController();
      this.requests.set(id, controller);
      void this.acquire(id, controller, this.specs.get(target.cacheKey)!, target.frame);
    }
  }

  private async acquire(id: string, controller: AbortController, spec: PrewarmContentSpec, frame: number): Promise<void> {
    try {
      const lease = await this.deps.acquire(atFrame(spec.descriptor, frame), {
        scaleDiv: spec.scaleDiv, signal: controller.signal,
        priority: frame >= this.playheads.get(spec.cacheKey)! ? 'ahead' : 'background',
      });
      // The frame is in L0 now; warming holds no pin.
      lease.release();
    } catch { /* Retry failures on the next demand update, never in a tight loop. */ }
    finally {
      if (this.requests.get(id) === controller) this.requests.delete(id);
      if (!this.disposed) this.deps.onProgress?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled !== null) this.deps.cancel(this.scheduled);
    this.scheduled = null;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.targets = [];
    this.specs.clear();
  }
}
