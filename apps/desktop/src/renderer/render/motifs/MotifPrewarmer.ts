import { atFrame } from './motifFrameDescriptor';
import type { acquireMotifFrame, MotifFrameAcquisition, MotifFrameCoverage } from './motifFrameSource';
import type { LookaheadTarget } from './motifDemand';
import { motifErrorCode } from '../../../shared/motifs/errors';
import { MOTIF_DEADLINES } from '../../../shared/motifs/tuning';

export interface MotifPrewarmerDeps {
  coverage: Pick<MotifFrameCoverage, 'has' | 'prioritize'>;
  acquire: typeof acquireMotifFrame;
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  onProgress?: () => void;
}

const address = (target: LookaheadTarget) => JSON.stringify([target.cacheKey, target.frame]);

interface Request { controller: AbortController; handle: MotifFrameAcquisition }

/** Applies the lookahead plan (`planMotifDemand`). Register the whole window
 * so holes waiting for capture cannot hide saved frames further ahead. A
 * request lands its frame in L0; replans abort obsolete requests and re-class
 * and re-rank kept ones, so a playhead that passes a frame or seeks back
 * before it moves it. */
export class MotifPrewarmer {
  private targets: readonly LookaheadTarget[] = [];
  private readonly requests = new Map<string, Request>();
  /** Targets admission refused `capacity` (an export holds its plan): each
   * waits out the preview's retry delays before it is requested again. */
  private readonly refused = new Map<string, { until: number; count: number }>();
  private scheduled: number | null = null;
  private disposed = false;

  constructor(private readonly deps: MotifPrewarmerDeps) {}

  setTargets(targets: readonly LookaheadTarget[]): void {
    if (this.disposed) return;
    this.targets = targets;
    const wanted = new Set(this.targets.map(address));
    for (const [id, request] of this.requests) {
      if (!wanted.has(id)) {
        this.requests.delete(id);
        request.controller.abort();
      }
    }
    for (const id of this.refused.keys()) if (!wanted.has(id)) this.refused.delete(id);
    for (const target of this.targets) this.requests.get(address(target))?.handle.setPriority(target.priority, target.order);
    this.deps.coverage.prioritize(this.targets.map(({ cacheKey, frame, scaleDiv }) => ({ cacheKey, frame, scaleDiv })));
    if (this.scheduled === null && this.targets.some(target => this.due(target))) {
      this.scheduled = this.deps.schedule(() => {
        this.scheduled = null;
        this.pump();
      });
    }
  }

  /** Neither in flight, nor in L0, nor waiting out a refusal. */
  private due(target: LookaheadTarget): boolean {
    const id = address(target);
    if (this.requests.has(id) || this.cached(target)) return false;
    return performance.now() >= (this.refused.get(id)?.until ?? 0);
  }

  private cached({ cacheKey, frame, scaleDiv }: LookaheadTarget): boolean {
    return this.deps.coverage.has(cacheKey, frame, scaleDiv);
  }

  private pump(): void {
    if (this.disposed) return;
    for (const target of this.targets) {
      if (!this.due(target)) continue;
      const id = address(target);
      const controller = new AbortController();
      let handle: MotifFrameAcquisition;
      try {
        handle = this.deps.acquire(atFrame(target.content, target.frame), {
          scaleDiv: target.scaleDiv, signal: controller.signal, priority: target.priority, order: target.order,
        });
      } catch {
        // As a failed request: retried on the next demand update, and the
        // other targets still go.
        continue;
      }
      const request = { controller, handle };
      this.requests.set(id, request);
      void this.settle(id, request);
    }
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
  }
}
