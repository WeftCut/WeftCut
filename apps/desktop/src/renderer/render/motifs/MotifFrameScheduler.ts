import { MotifError, motifSuperseded } from '../../../shared/motifs/errors';
import type { MotifFramePriority } from '../../../shared/motifs/frameTransport';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';
import type { MotifCaptureCall } from './frameTransport';
import type { MotifFrameDiv } from './frameCache';
import { motifTuning } from './tuning';

const PRIORITIES: readonly MotifFramePriority[] = ['current', 'ahead', 'background'];

/** One deduplicated frame request (`motifFrameSource.ts`). */
export interface FrameWork {
  cacheKey: string;
  frame: number;
  /** The divisor a stored frame is read at; a capture is full size. */
  scaleDiv: MotifReaderDiv;
  /** A parameter-preview frame has no cache address: it is never read. */
  captureOnly: boolean;
  /** Export work starts at once, outside the read slots and the send window:
   * the export stream's byte budget bounds it, and it pipelines frames. */
  unbounded: boolean;
  /** The highest priority among its subscribers, read at admission. */
  priority(): MotifFramePriority;
  /** Its rank within its priority class, lowest sent first: the lowest among
   * its subscribers, read at admission. */
  order(): number;
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
  /** Its last read missed: it captures instead of reading. */
  readMissed: boolean;
  /** Main answered it `stored`: every later capture it sends is `afterMiss`. */
  answeredStored: boolean;
  call: MotifCaptureCall | null;
  sentPriority: MotifFramePriority;
  /** Its capture holds a place in the send window until it settles, even
   * once promoted to `current`: a promotion never lets more lookahead in. */
  windowed: boolean;
  resolve: (value: FrameResult) => void;
  reject: (error: unknown) => void;
}

/** Resource admission after deduplication: `readsInFlight` disk-read slots,
 * the reader's own bound, and a capture send window, served `current`, then
 * `ahead`, then `background`. A `current` capture is sent at once; `ahead` and
 * `background` ones are sent lowest order first, ties in arrival order, while
 * fewer than `captureRequests` of them are in main (main orders what it holds,
 * ADR 0161). A bounded prewarm window can contain both saved pixels and holes.
 * Waiting captures never occupy a disk-read slot. Priority, order and coverage
 * are read at admission, not snapshotted by callers.
 *
 * One bounded loop per frame: a read miss queues it again as a capture, and
 * a `stored` reply queues it again as a read. The first capture lets main
 * check the store, so a stale miss of a stored frame captures nothing; once
 * main has answered `stored`, the next capture is `afterMiss`, which main
 * never answers `stored` (ADR 0160). A stale miss costs one more read, a
 * corrupt file one capture after that second read. A `stored` reply to
 * `afterMiss` rejects as a `miss` and the caller backs off: reading again
 * would cycle between the reply and a failed read. A read's transport error
 * rejects: it says nothing about the file, so it never captures. */
export class MotifFrameScheduler {
  private queue: Entry[] = [];
  private reads = 0;
  /** Captures in main holding a place in the send window. */
  private sent = 0;
  private readonly readSlots = motifTuning().readsInFlight;
  private readonly captureRequests = motifTuning().captureRequests;
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
      entry = {
        work, epoch: this.epoch, readMissed: false, answeredStored: false,
        call: null, sentPriority: 'background', windowed: false, resolve, reject,
      };
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
        if (priority !== entry.sentPriority) {
          entry.sentPriority = priority;
          call.setPriority(priority);
        }
        // A `current` capture demoted while in main takes a place in the
        // window from then on, so the window counts what main holds.
        if (priority !== 'current' && !entry.windowed && !entry.work.unbounded) this.hold(entry);
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
      // Main-owned preparation has no competing speculative capture here;
      // saved frames use separate read slots even while a different content
      // is being captured. `sort` is stable: equal orders keep arrival order.
      const captures = this.queue.filter(entry => entry.work.priority() === priority && !this.readsDisk(entry));
      if (priority !== 'current') captures.sort((a, b) => Math.sign(a.work.order() - b.work.order()) || 0);
      for (const entry of captures) {
        if (priority !== 'current' && (!this.deps.backgroundCaptureAllowed(entry.work.cacheKey) ||
          (!entry.work.unbounded && this.sent >= this.captureRequests))) continue;
        this.queue.splice(this.queue.indexOf(entry), 1);
        void this.run(entry, 'capture');
      }
    }
  }

  private hold(entry: Entry): void {
    entry.windowed = true;
    this.sent++;
  }

  private async run(entry: Entry, kind: 'read' | 'capture'): Promise<void> {
    const { work } = entry;
    const bounded = !work.unbounded;
    if (bounded && kind === 'read') this.reads++;
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
      if (bounded && entry.sentPriority !== 'current') this.hold(entry);
      const afterMiss = entry.answeredStored;
      entry.call = work.capture(afterMiss, entry.sentPriority);
      const reply = await entry.call.reply;
      if (reply.kind === 'stored') {
        if (afterMiss) throw new MotifError('miss', 'Motif frame answered stored after its read missed');
        entry.answeredStored = true;
        this.recordStored(entry);
        if (!this.wanted(entry)) throw motifSuperseded();
        entry.readMissed = false;
        again = true;
        return;
      }
      if (reply.persisted) this.recordStored(entry);
      this.settle(entry, { bitmap: reply.bitmap, div: 'live', persisted: reply.persisted });
    } catch (error) {
      entry.reject(error);
    } finally {
      entry.call = null;
      if (bounded && kind === 'read') this.reads--;
      if (entry.windowed) { entry.windowed = false; this.sent--; }
      if (again) this.queue.push(entry);
      this.wake();
    }
  }

  /** Coverage is true whoever still wants the frame, but only for the
   * project opening that asked. */
  private recordStored(entry: Entry): void {
    if (entry.epoch === this.epoch) this.deps.stored(entry.work.cacheKey, entry.work.frame);
  }

  private settle(entry: Entry, value: FrameResult): void {
    if (this.wanted(entry)) { entry.resolve(value); return; }
    value.bitmap.close();
    entry.reject(motifSuperseded());
  }
}
