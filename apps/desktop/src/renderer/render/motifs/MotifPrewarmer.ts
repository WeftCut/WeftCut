import { planPrewarmTargets, type PrewarmContent, type PrewarmTarget } from './prewarmPlan';

export interface PrewarmContentSpec extends PrewarmContent {
  /// The shared acquisition module owns disk/capture admission. The request
  /// key is a cancellable BACKGROUND subscription, not foreground demand.
  render: (frame: number, requestKey: string) => Promise<ImageBitmap>;
}

export interface MotifPrewarmerDeps {
  capBytes: number;
  hasFrame: (cacheKey: string, frame: number) => boolean;
  setFrame: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  prioritizeFrames: (targets: readonly PrewarmTarget[]) => void;
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  cancelRequest: (requestKey: string) => void;
  onProgress?: () => void;
}

interface Request extends PrewarmTarget { key: string }
const address = (target: PrewarmTarget) => JSON.stringify([target.cacheKey, target.frame]);
// Small authored sizes can fit thousands of frames in the pixel budget. Also
// bound subscription metadata and synchronous admission work (4s at 60 fps).
const MAX_PREWARM_REQUESTS = 256;

/** Owns a byte-bounded, playhead-relative demand window. Register the whole
 * window so holes waiting for capture cannot hide saved frames further ahead.
 * Requests carry metadata only until the shared acquisition module admits
 * actual work. Replans retain useful subscriptions and cancel obsolete ones. */
export class MotifPrewarmer {
  private specs = new Map<string, PrewarmContentSpec>();
  private targets: PrewarmTarget[] = [];
  private readonly requests = new Map<string, Request>();
  private readonly prefix = `motif-prewarm:${crypto.randomUUID()}`;
  private sequence = 0;
  private scheduled: number | null = null;
  private disposed = false;

  constructor(private readonly deps: MotifPrewarmerDeps) {}

  setTargets(specs: PrewarmContentSpec[]): void {
    if (this.disposed) return;
    this.specs = new Map(specs.map(spec => [spec.cacheKey, spec]));
    this.targets = planPrewarmTargets(specs, this.deps.capBytes, MAX_PREWARM_REQUESTS);
    const wanted = new Set(this.targets.map(address));
    for (const [id, request] of this.requests) {
      if (!wanted.has(id)) {
        this.requests.delete(id);
        this.deps.cancelRequest(request.key);
      }
    }
    this.deps.prioritizeFrames(this.targets);
    if (this.scheduled === null && this.targets.some(target =>
      !this.requests.has(address(target)) && !this.deps.hasFrame(target.cacheKey, target.frame))) {
      this.scheduled = this.deps.schedule(() => {
        this.scheduled = null;
        this.pump();
      });
    }
  }

  private pump(): void {
    if (this.disposed) return;
    for (const target of this.targets) {
      const id = address(target);
      if (this.requests.has(id) || this.deps.hasFrame(target.cacheKey, target.frame)) continue;
      const spec = this.specs.get(target.cacheKey);
      if (!spec) continue;
      const request = { ...target, key: `${this.prefix}:${++this.sequence}` };
      this.requests.set(id, request);
      void this.acquire(id, request, spec);
    }
  }

  private async acquire(id: string, request: Request, spec: PrewarmContentSpec): Promise<void> {
    let owned: ImageBitmap | null = null;
    try {
      owned = await spec.render(request.frame, request.key);
      if (this.disposed || this.requests.get(id) !== request) return;
      this.deps.setFrame(request.cacheKey, request.frame, owned);
      owned = null;
    } catch { /* Retry failures on the next demand update, never in a tight loop. */ }
    finally {
      owned?.close();
      if (this.requests.get(id) === request) this.requests.delete(id);
      if (!this.disposed) this.deps.onProgress?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled !== null) this.deps.cancel(this.scheduled);
    this.scheduled = null;
    for (const request of this.requests.values()) this.deps.cancelRequest(request.key);
    this.requests.clear();
    this.targets = [];
    this.specs.clear();
  }
}
