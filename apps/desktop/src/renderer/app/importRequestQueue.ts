import type { ResourceAllocation } from '../../shared/resource-policy';

/** Admission lookahead, not a promise of simultaneous processing. Each native
 * preparation claims one CPU slot and 128 MiB; never feed more unfinished
 * imports than the configured work envelope could hold. Native admission is
 * authoritative and may run fewer (currently one preparation at a time).
 * This is a conservative backpressure policy, not a measured throughput optimum.
 */
export function importRequestWindow(allocation: ResourceAllocation): number {
  return Math.max(1, Math.min(allocation.cpu_threads, Math.floor(allocation.work_mib / 128)));
}

type Selection = {
  paths: readonly string[];
  next: number;
  active: number;
  current: () => boolean;
  failed: boolean;
  error?: unknown;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** One rolling request window across picker/drop selections. Keep one promise
 * per selection and only window-sized active operations, even for huge lists.
 * Round-robin selections so another drop can progress alongside a large import.
 */
export class ImportRequestQueue {
  private selections = new Set<Selection>();
  private active = 0;

  constructor(private importFile: (path: string) => Promise<unknown>, private capacity: () => number) {}

  enqueue(paths: readonly string[], current: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.selections.add({ paths: paths.slice(), next: 0, active: 0, current, failed: false, resolve, reject });
      this.refresh();
    });
  }

  /** Called on completion, allocation/pressure changes, and workspace change.
   * Lowering capacity lets active work drain; cancellation retires unsent paths.
   */
  refresh = (): void => {
    for (const selection of this.selections) {
      if (!selection.current() || selection.failed) selection.next = selection.paths.length;
      if (selection.next === selection.paths.length && selection.active === 0) {
        this.selections.delete(selection);
        if (selection.failed) selection.reject(selection.error);
        else selection.resolve();
      }
    }
    const capacity = this.capacity();
    while (this.active < capacity) {
      const selection = [...this.selections].find(item => item.next < item.paths.length);
      if (!selection) break;
      const path = selection.paths[selection.next++]!;
      selection.active++;
      this.active++;
      this.selections.delete(selection);
      this.selections.add(selection);
      let operation: Promise<unknown>;
      try { operation = this.importFile(path); }
      catch (error) { operation = Promise.reject(error); }
      void operation.then(
        () => this.finish(selection),
        error => {
          if (!selection.failed) selection.error = error;
          selection.failed = true;
          this.finish(selection);
        },
      );
    }
  };

  private finish(selection: Selection): void {
    selection.active--;
    this.active--;
    this.refresh();
  }
}
