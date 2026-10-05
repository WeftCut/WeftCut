import { CAPTURE_SUPERSEDED_MESSAGE } from '../../../shared/motifs/captureErrors';
import type { FrameTicket } from './FrameBroker';
import type { CapturedFrame } from './frameTransport';

interface Request {
  cacheKey: string;
  frame: number;
  ticket: FrameTicket;
  capture: () => Promise<CapturedFrame>;
  captureOnly: boolean;
}
interface Job extends Request {
  epoch: number;
  readMiss: boolean;
  resolve: (value: CapturedFrame) => void;
  reject: (error: unknown) => void;
}

/** Resource admission AFTER broker deduplication. A bounded prewarm window
 * can contain both saved pixels and holes. Waiting captures never occupy a
 * disk-read slot; failed reads release theirs before joining capture work.
 * Priority and coverage are read at admission, not snapshotted by callers. */
export class MotifFrameScheduler {
  private queue: Job[] = [];
  private reads = 0;
  private captures = 0;
  private scheduled = false;
  private epoch = 0;
  private preferBake = false;

  constructor(private readonly deps: {
    shouldRead: (cacheKey: string, frame: number) => boolean;
    read: (cacheKey: string, frame: number) => Promise<ImageBitmap | null>;
    readMiss: (cacheKey: string, frame: number) => void;
  }) {}

  acquire(request: Request): Promise<CapturedFrame> {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...request, epoch: this.epoch, readMiss: false, resolve, reject });
      this.wake();
    });
  }

  /** Coverage, subscriber cancellation or foreground promotion changed. */
  wake(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }

  reset(): void {
    this.epoch++;
    this.preferBake = false;
    for (const job of this.queue) job.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE));
    this.queue = [];
    // Admitted work keeps its resource until it actually settles. Its result
    // cannot cross into the new project opening.
  }

  private wanted(job: Job): boolean {
    return job.epoch === this.epoch && job.ticket.wanted();
  }

  private readsDisk(job: Job): boolean {
    return !job.captureOnly && !job.readMiss && this.deps.shouldRead(job.cacheKey, job.frame);
  }

  private drain(): void {
    this.queue = this.queue.filter(job => {
      if (this.wanted(job)) return true;
      job.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE));
      return false;
    });
    for (const high of [true, false]) {
      for (let i = 0; i < this.queue.length;) {
        const job = this.queue[i]!;
        if (job.ticket.high() !== high) { i++; continue; }
        if (!this.readsDisk(job) || this.reads >= 3) { i++; continue; }
        this.queue.splice(i, 1);
        this.reads++;
        void this.run(job, true);
      }
      if (this.captures < 1) {
        const candidates = this.queue.filter(job => job.ticket.high() === high && !this.readsDisk(job));
        // A whole speculative window must not put hundreds of captures in
        // front of the idle baker. Foreground always wins; background bake
        // and prewarm take turns when both have work.
        const job = (high ? undefined : candidates.find(job => !!job.ticket.bake() === this.preferBake)) ?? candidates[0];
        if (job) {
          this.queue.splice(this.queue.indexOf(job), 1);
          this.captures++;
          if (!high) this.preferBake = !job.ticket.bake();
          void this.run(job, false);
        }
      }
    }
  }

  private async run(job: Job, read: boolean): Promise<void> {
    try {
      let value: CapturedFrame;
      if (read) {
        let bitmap: ImageBitmap | null = null;
        try { bitmap = await this.deps.read(job.cacheKey, job.frame); }
        catch { /* Missing/corrupt/unavailable pixels use the capture budget. */ }
        if (!bitmap) {
          if (!this.wanted(job)) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
          job.readMiss = true;
          this.deps.readMiss(job.cacheKey, job.frame);
          this.queue.push(job);
          return;
        }
        value = { bitmap, persisted: true };
      } else {
        value = await job.capture();
      }
      if (!this.wanted(job)) {
        value.bitmap.close();
        throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
      }
      job.resolve(value);
    } catch (error) {
      job.reject(error);
    } finally {
      if (read) this.reads--; else this.captures--;
      this.wake();
    }
  }
}
