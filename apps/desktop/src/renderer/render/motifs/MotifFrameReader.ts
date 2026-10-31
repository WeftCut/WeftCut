import { hashCacheKey } from '../../../shared/motifs/cacheKey';
import type { MotifCacheAddress, MotifTextureReadRequest } from '../../../shared/motifs/frameTransport';
import { isMotifReaderDiv, type MotifReaderDiv, type MotifReadRequest } from '../../../shared/motifs/readerProtocol';
import { rendererOS } from '../../platform';
import {
  MotifTransportError, readMotifTexture,
  type MotifReaderLane, type MotifTextureRead, type MotifTransportFailure,
} from './frameTransport';
import type { MotifReaderWorkerIn, MotifReaderWorkerOut } from './motifReaderWorker';

export { MotifTransportError, type MotifReaderLane, type MotifTransportFailure } from './frameTransport';

/** At most three reads in flight per document (ADR 0154); later reads queue. */
export const MOTIF_READS_IN_FLIGHT = 3;
const READ_TIMEOUT_MS = 15_000;
const STAGE_WINDOW = 64;

/** Native stages, then the texture lane's upload and import or the utility
 * lane's worker bitmap. */
export type MotifReaderStage = 'readMs' | 'decodeMs' | 'hashMs' | 'scaleMs' | 'uploadMs' | 'importMs' | 'bitmapMs';
const STAGES: readonly MotifReaderStage[] = ['readMs', 'decodeMs', 'hashMs', 'scaleMs', 'uploadMs', 'importMs', 'bitmapMs'];

export interface MotifReaderStats {
  /** Reads each lane answered, misses included. */
  reads: Record<MotifReaderLane, number>;
  misses: number;
  /** Texture-lane reads answered `unavailable` and read on the utility lane. */
  fallbacks: number;
  transportFailures: number;
  /** Utility-lane connections dropped after a failure; the next read reconnects. */
  restarts: number;
  /** Medians over the last 64 frames; null before the first sample. */
  stages: Record<MotifReaderStage, number | null>;
}

export interface MotifReadOptions { finalizationToken?: string }

/** E2E builds only: wraps each admitted read, so a spec can delay it or answer
 * a stale miss on every lane. */
type E2EMotifReadInterceptor = (
  address: MotifCacheAddress,
  scaleDiv: MotifReaderDiv,
  next: () => Promise<ImageBitmap | null>,
) => Promise<ImageBitmap | null>;

/** `Worker`, as far as the reader uses it. */
export interface MotifReaderWorkerLike {
  onmessage: ((event: MessageEvent<MotifReaderWorkerOut>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: MotifReaderWorkerIn, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface MotifFrameReaderDeps {
  /** Try the Windows texture lane first. */
  textureLane: boolean;
  readTexture(request: MotifTextureReadRequest): Promise<MotifTextureRead>;
  createWorker(): MotifReaderWorkerLike;
  /** `motif:reader-connect`: main answers with one port and retires the previous one. */
  connect(): void;
  /** Ports and resets the preload forwards from main. */
  listen(events: { port(port: MessagePort): void; reset(): void }): void;
  timeoutMs?: number;
}

type Stages = Partial<Record<MotifReaderStage, number>>;
interface LaneFrame { bitmap: ImageBitmap; stages: Stages }

/** The one renderer operation for stored Motif frames (ADR 0154): read
 * `(cacheKey, frame, scaleDiv)` into an `ImageBitmap`, or null when the frame
 * is not stored or is invalid. Lane choice, fallback, the worker and its port
 * stay behind it. A transport failure is never null: the lane restarts and
 * the read retries once, then throws `MotifTransportError`. */
export class MotifFrameReader {
  private readonly utility: UtilityLane;
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly counts = { texture: 0, utility: 0, misses: 0, fallbacks: 0, transportFailures: 0 };
  private readonly samples = new Map<MotifReaderStage, number[]>();

  constructor(private readonly deps: MotifFrameReaderDeps) {
    this.utility = new UtilityLane(deps, deps.timeoutMs ?? READ_TIMEOUT_MS);
  }

  read(cacheKey: string, frame: number, scaleDiv: MotifReaderDiv, options: MotifReadOptions = {}): Promise<ImageBitmap | null> {
    return this.readAddress({ hash: hashCacheKey(cacheKey), frame }, scaleDiv, options);
  }

  /** The same read by hashed address, which is all a capture's `stored`
   * reply names. */
  async readAddress(address: MotifCacheAddress, scaleDiv: MotifReaderDiv, options: MotifReadOptions = {}): Promise<ImageBitmap | null> {
    if (!isMotifReaderDiv(scaleDiv)) throw new RangeError(`Invalid Motif read divisor: ${String(scaleDiv)}`);
    await this.admit();
    try { return await this.intercept(address, scaleDiv, () => this.readAdmitted(address, scaleDiv, options)); }
    finally { this.release(); }
  }

  get stats(): MotifReaderStats {
    const stages = {} as Record<MotifReaderStage, number | null>;
    for (const stage of STAGES) stages[stage] = median(this.samples.get(stage));
    const { texture, utility, misses, fallbacks, transportFailures } = this.counts;
    return { reads: { texture, utility }, misses, fallbacks, transportFailures, restarts: this.utility.restarts, stages };
  }

  private intercept(address: MotifCacheAddress, scaleDiv: MotifReaderDiv, next: () => Promise<ImageBitmap | null>): Promise<ImageBitmap | null> {
    // Production builds fold this branch away.
    if (import.meta.env.VITE_WEFTCUT_E2E === '1') {
      const interceptor = (globalThis as typeof globalThis & {
        __weftcutE2EMotifReadInterceptor?: E2EMotifReadInterceptor;
      }).__weftcutE2EMotifReadInterceptor;
      if (interceptor) return interceptor(address, scaleDiv, next);
    }
    return next();
  }

  private async readAdmitted(address: MotifCacheAddress, div: MotifReaderDiv, options: MotifReadOptions): Promise<ImageBitmap | null> {
    let lane: MotifReaderLane = this.deps.textureLane ? 'texture' : 'utility';
    let retried = false;
    for (;;) {
      try {
        const frame = lane === 'texture'
          ? await this.readTexture({ ...address, div, ...(options.finalizationToken ? { finalizationToken: options.finalizationToken } : {}) })
          : await this.utility.read({ ...address, div });
        // Not a miss and not a failure: this read goes to the utility lane.
        if (frame === 'unavailable') { this.counts.fallbacks++; lane = 'utility'; continue; }
        this.counts[lane]++;
        if (!frame) { this.counts.misses++; return null; }
        this.record(frame.stages);
        return frame.bitmap;
      } catch (error) {
        const failure = error instanceof MotifTransportError
          ? error : new MotifTransportError(lane, 'error', String((error as Error)?.message ?? error));
        this.counts.transportFailures++;
        if (retried) throw failure;
        retried = true;
      }
    }
  }

  private async readTexture(request: MotifTextureReadRequest): Promise<LaneFrame | 'unavailable' | null> {
    const result = await this.deps.readTexture(request);
    if (result === null || result === 'unavailable') return result;
    const stages: Stages = {};
    if (result.timing) {
      const { read, premultiplyMs, acquireMs, gpuMs } = result.timing;
      Object.assign(stages, read, { uploadMs: premultiplyMs + acquireMs + gpuMs });
    }
    if (result.importMs !== undefined) stages.importMs = result.importMs;
    return { bitmap: result.bitmap, stages };
  }

  private admit(): Promise<void> {
    if (this.active < MOTIF_READS_IN_FLIGHT) { this.active++; return Promise.resolve(); }
    // The finishing read hands its slot over without releasing it.
    return new Promise(resolve => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }

  private record(stages: Stages): void {
    for (const stage of STAGES) {
      const value = stages[stage];
      if (value === undefined || !Number.isFinite(value)) continue;
      let window = this.samples.get(stage);
      if (!window) this.samples.set(stage, window = []);
      window.push(value);
      if (window.length > STAGE_WINDOW) window.shift();
    }
  }
}

function median(values: readonly number[] | undefined): number | null {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface PendingRead {
  request: MotifReadRequest;
  /** The port epoch it was posted on; null while it waits for a port. */
  epoch: number | null;
  timer: ReturnType<typeof setTimeout>;
  resolve(frame: LaneFrame | null): void;
  reject(error: MotifTransportError): void;
}

/** One reader worker and one utility port per document. Connects one at a
 * time; the newest port main sends is current, because each connect retires
 * the previous one in main. */
class UtilityLane {
  restarts = 0;
  private worker: MotifReaderWorkerLike | null = null;
  private state: 'idle' | 'connecting' | 'open' = 'idle';
  private epoch = 0;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRead>();

  constructor(private readonly deps: MotifFrameReaderDeps, private readonly timeoutMs: number) {
    deps.listen({
      port: port => this.attach(port),
      // While connecting, the port main is about to send is already the
      // restarted utility's.
      reset: () => { if (this.state === 'open') this.fail('reset'); },
    });
  }

  read(address: { hash: string; frame: number; div: MotifReaderDiv }): Promise<LaneFrame | null> {
    return new Promise((resolve, reject) => {
      const request: MotifReadRequest = { id: ++this.nextId, ...address };
      // A silent port, or a connect main never answers.
      const timer = setTimeout(() => this.fail('timeout'), this.timeoutMs);
      const read: PendingRead = { request, epoch: null, timer, resolve, reject };
      this.pending.set(request.id, read);
      if (this.state === 'open') this.send(read);
      else if (this.state === 'idle') {
        this.state = 'connecting';
        this.deps.connect();
      }
    });
  }

  private attach(port: MessagePort): void {
    const worker = this.worker ??= this.spawn();
    // Reads posted on a superseded port will not be answered.
    if (this.state === 'open') this.fail('closed', read => read.epoch !== null);
    const epoch = ++this.epoch;
    this.state = 'open';
    worker.postMessage({ port, epoch }, [port]);
    for (const read of this.pending.values()) if (read.epoch === null) this.send(read);
  }

  private send(read: PendingRead): void {
    read.epoch = this.epoch;
    this.worker!.postMessage(read.request);
  }

  private spawn(): MotifReaderWorkerLike {
    const worker = this.deps.createWorker();
    worker.onmessage = ({ data }) => this.reply(data);
    worker.onerror = event => {
      event.preventDefault?.();
      if (this.worker !== worker) return;
      this.worker = null;
      worker.terminate();
      this.fail('error');
    };
    return worker;
  }

  private reply(data: MotifReaderWorkerOut): void {
    if ('closed' in data) {
      if (data.closed === this.epoch && this.state === 'open') this.fail('closed');
      return;
    }
    const read = this.pending.get(data.id);
    if (!read) { if ('bitmap' in data) data.bitmap.close(); return; }
    this.pending.delete(data.id);
    clearTimeout(read.timer);
    if ('error' in data) read.reject(new MotifTransportError('utility', 'error', data.error));
    else if ('miss' in data) read.resolve(null);
    else read.resolve({ bitmap: data.bitmap, stages: { ...data.timing, bitmapMs: data.bitmapMs } });
  }

  /** The port is gone or silent: fail its reads; the next read reconnects. */
  private fail(reason: MotifTransportFailure, which: (read: PendingRead) => boolean = () => true): void {
    if (this.state !== 'idle') this.restarts++;
    this.state = 'idle';
    for (const [id, read] of this.pending) {
      if (!which(read)) continue;
      this.pending.delete(id);
      clearTimeout(read.timer);
      read.reject(new MotifTransportError('utility', reason));
    }
  }
}

let shared: MotifFrameReader | null = null;

/** The document's reader if a read has created it, else null. Diagnostics
 * read this, so polling them never listens, spawns the worker or connects. */
export function currentMotifFrameReader(): MotifFrameReader | null {
  return shared;
}

/** Stats before the first read: zero counts, no stage samples. */
export function idleMotifReaderStats(): MotifReaderStats {
  const stages = {} as Record<MotifReaderStage, number | null>;
  for (const stage of STAGES) stages[stage] = null;
  return { reads: { texture: 0, utility: 0 }, misses: 0, fallbacks: 0, transportFailures: 0, restarts: 0, stages };
}

/** The document's reader. */
export function motifFrameReader(): MotifFrameReader {
  return shared ??= new MotifFrameReader({
    // Main serves the texture lane only on Windows; elsewhere it would answer
    // every read `unavailable`.
    textureLane: rendererOS === 'windows',
    readTexture: readMotifTexture,
    createWorker: () => new Worker(new URL('./motifReaderWorker.ts', import.meta.url), { type: 'module' }) as MotifReaderWorkerLike,
    connect: () => window.postMessage({ type: 'weftcut:motif-reader-connect' }, '*'),
    listen: ({ port, reset }) => window.addEventListener('message', event => {
      if (event.source !== window) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === 'weftcut:motif-reader-port' && event.ports[0]) port(event.ports[0]);
      else if (type === 'weftcut:motif-reader-reset') reset();
    }),
  });
}
