import { motifSuperseded } from '../../../shared/motifs/errors';
import type { MotifFramePriority } from '../../../shared/motifs/frameTransport';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';
import type { MotifCaptureCall } from './frameTransport';
import type { MotifFrameDiv } from './frameCache';
import { motifTuning } from './tuning';

const PRIORITIES: readonly MotifFramePriority[] = ['current', 'ahead', 'background'];
const rank = (priority: MotifFramePriority) => PRIORITIES.indexOf(priority);

/** One deduplicated frame request (`motifFrameSource.ts`). */
export interface FrameWork {
  cacheKey: string;
  frame: number;
  /** The divisor a stored frame is read at; a capture is full size. */
  scaleDiv: MotifReaderDiv;
  /** A parameter-preview frame has no cache address: it is never read. */
  captureOnly: boolean;
  /** Export work starts at once, outside the read and capture slots: the
   * export stream's byte budget bounds it, and it pipelines frames. */
  unbounded: boolean;
  /** The highest priority among its subscribers, read at admission. */
  priority(): MotifFramePriority;
  wanted(): boolean;
  /** A stored frame, or null when it is absent or invalid. */
  read(): Promise<ImageBitmap | null>;
  capture(afterMiss: boolean, priority: MotifFramePriority): MotifCaptureCall;
}

export interface FrameResult { bitmap: ImageBitmap; div: MotifFrameDiv; persisted: boolean }
/** `changed` reports a new priority or a lost subscriber. */
export interface ScheduledFrame { result: Promise<FrameResult>; changed(): void }

interface Entry {
  work: FrameWork;
  epoch: number;
  /** Its read missed: the next capture is `afterMiss`. */
  readMissed: boolean;
  call: MotifCaptureCall | null;
  sentPriority: MotifFramePriority;
  resolve: (value: FrameResult) => void;
  reject: (error: unknown) => void;
}

/** Resource admission after deduplication: `readsInFlight` disk-read slots,
 * the reader's own bound, and `captureSlots` capture slots, served `current`,
 * then `ahead`, then `background`. A bounded prewarm window can contain both
 * saved pixels and holes. Waiting captures never occupy a disk-read slot.
 * Priority and coverage are read at admission, not snapshotted by callers.
 *
 * One loop per frame: a read miss queues it again as a capture `afterMiss`;
 * a `stored` capture reply queues it again as a read. A read's transport
 * error rejects: it says nothing about the file, so it never captures. */
export class MotifFrameScheduler {
  private queue: Entry[] = [];
  private reads = 0;
  private captures = 0;
  private readonly readSlots = motifTuning().readsInFlight;
  private readonly captureSlots = motifTuning().captureSlots;
  private scheduled = false;
  private epoch = 0;

  constructor(private readonly deps: {
    shouldRead: (cacheKey: string, frame: number) => boolean;
    readMiss: (cacheKey: string, frame: number) => void;
    /** Main reported the frame stored. */
    stored: (cacheKey: string, frame: number) => void;
    /** Main owns background production for these content keys. A `current`
     * subscriber can still promote the same queued request immediately. */
    backgroundCaptureAllowed: (cacheKey: string) => boolean;
  }) {}

  schedule(work: FrameWork): ScheduledFrame {
    let entry!: Entry;
    const result = new Promise<FrameResult>((resolve, reject) => {
      entry = { work, epoch: this.epoch, readMissed: false, call: null, sentPriority: 'background', resolve, reject };
    });
    this.queue.push(entry);
    this.wake();
    return { result, changed: () => this.changed(entry) };
  }

  /** Coverage or a priority changed. */
  wake(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }

  /** Authoritative disk coverage changed. A previously missing frame may now
   * be saved; retry its read without ever opening a competing background page. */
  coverageChanged(): void {
    for (const entry of this.queue) {
      if (entry.readMissed && this.deps.shouldRead(entry.work.cacheKey, entry.work.frame)) entry.readMissed = false;
    }
    this.wake();
  }

  /** Rejects queued work. Admitted work keeps its slot until it settles; its
   * result cannot cross into the next project opening. */
  reset(): void {
    this.epoch++;
    for (const entry of this.queue) entry.reject(motifSuperseded());
    this.queue = [];
  }

  private changed(entry: Entry): void {
    const { call } = entry;
    if (call) {
      if (!this.wanted(entry)) call.cancel();
      else {
        const priority = entry.work.priority();
        if (rank(priority) < rank(entry.sentPriority)) {
          entry.sentPriority = priority;
          call.setPriority(priority);
        }
      }
    }
    this.wake();
  }

  private wanted(entry: Entry): boolean {
    return entry.epoch === this.epoch && entry.work.wanted();
  }

  private readsDisk(entry: Entry): boolean {
    return !entry.work.captureOnly && !entry.readMissed && this.deps.shouldRead(entry.work.cacheKey, entry.work.frame);
  }

  private drain(): void {
    this.queue = this.queue.filter(entry => {
      if (this.wanted(entry)) return true;
      entry.reject(motifSuperseded());
      return false;
    });
    for (const priority of PRIORITIES) {
      for (let i = 0; i < this.queue.length;) {
        const entry = this.queue[i]!;
        if (entry.work.priority() !== priority || !this.readsDisk(entry) ||
          (!entry.work.unbounded && this.reads >= this.readSlots)) { i++; continue; }
        this.queue.splice(i, 1);
        void this.run(entry, 'read');
      }
      for (;;) {
        // Main-owned preparation has no competing speculative capture here;
        // saved frames use separate read slots even while a different content
        // is being captured.
        const entry = this.queue.find(entry => entry.work.priority() === priority && !this.readsDisk(entry)
          && (entry.work.unbounded || this.captures < this.captureSlots)
          && (priority === 'current' || this.deps.backgroundCaptureAllowed(entry.work.cacheKey)));
        if (!entry) break;
        this.queue.splice(this.queue.indexOf(entry), 1);
        void this.run(entry, 'capture');
      }
    }
  }

  private async run(entry: Entry, kind: 'read' | 'capture'): Promise<void> {
    const { work } = entry;
    const bounded = !work.unbounded;
    if (bounded) { if (kind === 'read') this.reads++; else this.captures++; }
    let again = false;
    try {
      if (kind === 'read') {
        const bitmap = await work.read();
        if (!bitmap) {
          if (!this.wanted(entry)) throw motifSuperseded();
          entry.readMissed = true;
          this.deps.readMiss(work.cacheKey, work.frame);
          again = true;
          return;
        }
        this.settle(entry, { bitmap, div: work.scaleDiv, persisted: true });
        return;
      }
      entry.sentPriority = work.priority();
      entry.call = work.capture(entry.readMissed, entry.sentPriority);
      const reply = await entry.call.reply;
      if (reply.kind === 'stored') {
        if (!this.wanted(entry)) throw motifSuperseded();
        entry.readMissed = false;
        this.deps.stored(work.cacheKey, work.frame);
        again = true;
        return;
      }
      if (reply.persisted && this.wanted(entry)) this.deps.stored(work.cacheKey, work.frame);
      this.settle(entry, { bitmap: reply.bitmap, div: 'live', persisted: reply.persisted });
    } catch (error) {
      entry.reject(error);
    } finally {
      entry.call = null;
      if (bounded) { if (kind === 'read') this.reads--; else this.captures--; }
      if (again) this.queue.push(entry);
      this.wake();
    }
  }

  private settle(entry: Entry, value: FrameResult): void {
    if (this.wanted(entry)) { entry.resolve(value); return; }
    value.bitmap.close();
    entry.reject(motifSuperseded());
  }
}
