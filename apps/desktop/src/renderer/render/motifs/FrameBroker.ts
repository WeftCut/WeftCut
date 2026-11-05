import { CAPTURE_SUPERSEDED_MESSAGE } from '../../../shared/motifs/captureErrors';
import type { CapturedFrame } from './frameTransport';
import type { MotifFrameCache } from './frameCache';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';

export interface FrameTicket {
  key: string;
  wanted(): boolean;
  high(): boolean;
}
interface Subscriber { active: boolean; high: boolean; cancel(): void }
interface Job {
  key: string;
  subscribers: Set<Subscriber>;
  holds: number;
  result: Promise<CapturedFrame>;
  value?: CapturedFrame;
  cached: boolean;
  release(): void;
}

/** Deduplicates acquisition, not persistence. Callers receive owned clones so
 * stale prewarm completion and eviction cannot close another
 * consumer's bitmap. Only callers publish into L0, after their stale checks. */
export class FrameBroker {
  private jobs = new Map<string, Job>();
  private latest = new Map<string, Subscriber>();
  private sequence = 0;
  private readonly prefix = crypto.randomUUID();
  constructor(private readonly deps: {
    cache: MotifFrameCache;
    clone: (bitmap: ImageBitmap) => Promise<ImageBitmap>;
    control: (key: string, action: 'promote' | 'cancel') => void;
  }) {}

  /** A new workspace may reuse pixels, but must not inherit another workspace's
   * persisted acknowledgement. Existing consumers keep their owned results. */
  reset(): void { this.jobs.clear(); }

  cancel(coalesceKey: string): void { this.latest.get(coalesceKey)?.cancel(); }

  acquire(identity: string, frame: number, scaleDiv: MotifReaderDiv, produce: (ticket: FrameTicket) => Promise<CapturedFrame>, coalesceKey?: string, priority: 'foreground' | 'background' = 'foreground'): Promise<CapturedFrame> {
    if (coalesceKey) this.latest.get(coalesceKey)?.cancel();
    const address = JSON.stringify([identity, frame, scaleDiv]);
    let job = this.jobs.get(address);
    if (!job) {
      const cached = this.deps.cache.getFrame(identity, frame, scaleDiv);
      if (cached) this.deps.cache.retain(cached);
      const subscribers = new Set<Subscriber>();
      const key = `motif-job:${this.prefix}:${++this.sequence}`;
      job = {
        key, subscribers, holds: 0, cached: !!cached,
        result: Promise.resolve(null as unknown as CapturedFrame),
        release: () => { if (cached) this.deps.cache.release(cached); else job!.value?.bitmap.close(); },
      };
      const created = job;
      this.jobs.set(address, created);
      // Microtask admission lets synchronous subscribers join before choosing
      // priority. A disk read may await; producer rechecks ticket before capture.
      created.result = Promise.resolve().then(() => {
        if (!subscribers.size) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
        // A hit may be a live capture serving this divisor; callers re-store
        // it at `scaleDiv`, and L0 keeps the entry that already serves it.
        return cached ? { bitmap: cached, persisted: false, scaleDiv } : produce({
          key, wanted: () => subscribers.size > 0,
          high: () => [...subscribers].some(s => s.high),
        });
      }).then(value => { created.value = value; return value; });
    }
    const current = job;
    current.holds++;
    return new Promise<CapturedFrame>((resolve, reject) => {
      const retire = () => {
        current.subscribers.delete(subscriber);
        if (coalesceKey && this.latest.get(coalesceKey) === subscriber) this.latest.delete(coalesceKey);
        if (!current.subscribers.size) {
          if (this.jobs.get(address) === current) this.jobs.delete(address);
          if (!current.cached && !current.value) this.deps.control(current.key, 'cancel');
        }
      };
      const subscriber: Subscriber = {
        active: true, high: !!coalesceKey && priority === 'foreground',
        cancel: () => {
          if (!subscriber.active) return;
          subscriber.active = false; reject(new Error(CAPTURE_SUPERSEDED_MESSAGE)); retire();
        },
      };
      current.subscribers.add(subscriber);
      if (coalesceKey) {
        this.latest.set(coalesceKey, subscriber);
        if (subscriber.high && !current.cached) this.deps.control(current.key, 'promote');
      }
      void current.result.then(async value => {
        if (!subscriber.active) return;
        const bitmap = await this.deps.clone(value.bitmap);
        if (!subscriber.active) { bitmap.close(); return; }
        resolve({ ...value, bitmap });
      }).catch(error => { if (subscriber.active) reject(error); }).finally(() => {
        subscriber.active = false; retire();
        if (--current.holds === 0) current.release();
      });
    });
  }
}
