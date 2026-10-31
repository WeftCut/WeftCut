import { CAPTURE_SUPERSEDED_MESSAGE } from '../../shared/motifs/captureErrors';

interface Slot<T> { value: T; affinity: string; size: number; busy: boolean; used: number }
interface Job<R> { affinity: string; size: number; key?: string; current(): boolean; run(value: unknown): Promise<R>; resolve(value: R): void; reject(error: unknown): void }

/** Export-only resident pages. Each page owns one clock and renders serially;
 * independent pages may overlap. Slots are admitted by the native memory
 * authority, never by a larger queue or an unbounded Promise.all. */
export class ExportCapturePool<T> {
  private slots: Slot<T>[] = [];
  private queue: Job<unknown>[] = [];
  private running = 0;
  private sequence = 0;
  private stopped = false;
  constructor(private readonly deps: {
    create(size: number): T;
    close(value: T): void;
    capacity(error: unknown): boolean;
    maxHosts?: number;
    maxConcurrent?: number;
  }) {}

  get retired(): boolean { return this.stopped; }
  get diagnostics() { return { hosts: this.slots.length, running: this.running, queued: this.queue.length }; }

  capture<R>(affinity: string, size: number, key: string | undefined, current: () => boolean, run: (value: T) => Promise<R>): Promise<R> {
    if (this.stopped || !current()) return Promise.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE));
    return new Promise<R>((resolve, reject) => {
      this.queue.push({ affinity, size, key, current, run: value => run(value as T), resolve: value => resolve(value as R), reject });
      this.pump();
    });
  }

  cancel(key: string): void {
    this.queue = this.queue.filter(job => {
      if (job.key !== key) return true;
      job.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE)); return false;
    });
  }

  retire(): void {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE));
    for (const slot of [...this.slots]) if (!slot.busy) this.remove(slot);
    // Running pages and their memory leases remain alive until the operation
    // settles, even on cancellation or renderer exit.
  }

  private remove(slot: Slot<T>): void {
    this.slots.splice(this.slots.indexOf(slot), 1);
    this.deps.close(slot.value);
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.running < (this.deps.maxConcurrent ?? 2) && this.queue.length) {
      this.queue = this.queue.filter(job => {
        if (job.current()) return true;
        job.reject(new Error(CAPTURE_SUPERSEDED_MESSAGE)); return false;
      });
      // Never render two frames on the same page at once, nor create a second
      // copy of a busy affinity just because that page has a queue.
      const index = this.queue.findIndex(job => !this.slots.some(slot => slot.busy && slot.affinity === job.affinity));
      if (index < 0) return;
      const job = this.queue[index]!;
      let slot = this.slots.find(slot => !slot.busy && slot.affinity === job.affinity && slot.size >= job.size);
      if (!slot && this.slots.length < (this.deps.maxHosts ?? 3)) {
        try {
          slot = { value: this.deps.create(job.size), affinity: job.affinity, size: job.size, busy: false, used: 0 };
          this.slots.push(slot);
        } catch (error) {
          if (!this.deps.capacity(error)) { this.queue.splice(index, 1); job.reject(error); continue; }
          // Reduced-memory export plans are allowed to reuse one resident
          // page. Lack of room for an optimization is not an export failure.
          if (!this.slots.length) { this.queue.splice(index, 1); job.reject(error); continue; }
        }
      }
      if (!slot) {
        const idle = this.slots.filter(slot => !slot.busy).sort((a, b) => a.used - b.used);
        slot = idle.find(slot => slot.size >= job.size);
        if (!slot && idle[0]) {
          this.remove(idle[0]);
          continue; // return the old lease before admitting a larger page
        }
      }
      if (!slot) return; // busy residents will replenish capacity on completion
      this.queue.splice(index, 1);
      slot.affinity = job.affinity; slot.busy = true; slot.used = ++this.sequence;
      this.running++;
      const active = slot;
      void Promise.resolve().then(() => {
        if (this.stopped || !job.current()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
        return job.run(active.value);
      }).then(job.resolve, job.reject).finally(() => {
        active.busy = false; this.running--;
        if (this.stopped) this.remove(active);
        else this.pump();
      });
    }
  }
}
