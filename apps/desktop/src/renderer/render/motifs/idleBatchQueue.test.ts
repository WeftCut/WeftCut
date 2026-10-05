import { describe, expect, it, vi } from "vitest";
import { IdleBatchQueue } from "./idleBatchQueue";

/// Drive the loop deterministically, mirroring MotifPrewarmer/MotifBaker's
/// tests: run each scheduled callback, then let the async batch fully settle
/// (a macrotask flush) before checking for the re-armed callback.
async function drain(pending: (() => void)[]): Promise<void> {
  let guard = 0;
  while (pending.length > 0 && guard++ < 50) {
    pending.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// A queue over raw number targets with identity `take` unless overridden.
function makeQueue(overrides: {
  batchSize?: number;
  take?: (t: number) => number | null;
  run?: (item: number) => Promise<void>;
  onBatchDone?: () => void;
  pending: (() => void)[];
  cancel?: (token: number) => void;
}) {
  const { pending } = overrides;
  const schedule = vi.fn((cb: () => void) => {
    pending.push(cb);
    return pending.length;
  });
  const cancel = overrides.cancel ?? vi.fn();
  const run = overrides.run ?? (async () => {});
  const q = new IdleBatchQueue<number, number>({
    schedule,
    cancel,
    batchSize: overrides.batchSize ?? 2,
    take: overrides.take ?? ((t) => t),
    run,
    ...(overrides.onBatchDone ? { onBatchDone: overrides.onBatchDone } : {}),
  });
  return { q, schedule, cancel, run };
}

describe("IdleBatchQueue", () => {
  it("refills a free slot without waiting for the slowest sibling", async () => {
    const pending: (() => void)[] = [];
    const releases = new Map<number, () => void>();
    const ran: number[] = [];
    const { q } = makeQueue({ pending, batchSize: 3, run: n => {
      ran.push(n);
      return new Promise<void>(resolve => releases.set(n, resolve));
    } });
    q.setQueue([0, 1, 2, 3, 4]);
    pending.shift()!();
    expect(ran).toEqual([0, 1, 2]);
    releases.get(1)!();
    await new Promise(r => setTimeout(r, 0));
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(ran).toEqual([0, 1, 2, 3]);
    expect(pending).toHaveLength(0); // three unresolved items still cap admission
    q.dispose();
    releases.forEach(release => release());
  });

  it("never arms with an empty queue", () => {
    const pending: (() => void)[] = [];
    const { q, schedule } = makeQueue({ pending });
    q.setQueue([]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("runs every queued item across batches, onBatchDone once per batch", async () => {
    const pending: (() => void)[] = [];
    const ran: number[] = [];
    const onBatchDone = vi.fn();
    const { q } = makeQueue({
      pending,
      batchSize: 2,
      run: async (n) => { ran.push(n); },
      onBatchDone,
    });
    q.setQueue([0, 1, 2, 3, 4]);
    await drain(pending);
    expect(ran).toEqual([0, 1, 2, 3, 4]);
    expect(onBatchDone).toHaveBeenCalledTimes(3); // batches of 2, 2, 1
    // Drained to empty: nothing left scheduled (never arm when empty).
    expect(pending).toHaveLength(0);
  });

  it("drops targets whose take returns null, without running them", async () => {
    const pending: (() => void)[] = [];
    const ran: number[] = [];
    const { q } = makeQueue({
      pending,
      batchSize: 3,
      take: (t) => (t === 1 ? null : t),
      run: async (n) => { ran.push(n); },
    });
    q.setQueue([0, 1, 2]);
    await drain(pending);
    expect(ran.sort()).toEqual([0, 2]);
  });

  it("a throwing item is dropped; the batch and the loop keep going", async () => {
    const pending: (() => void)[] = [];
    const ran: number[] = [];
    const onBatchDone = vi.fn();
    const { q } = makeQueue({
      pending,
      batchSize: 2,
      run: async (n) => {
        if (n === 0) throw new Error("boom");
        ran.push(n);
      },
      onBatchDone,
    });
    q.setQueue([0, 1, 2]);
    await drain(pending);
    expect(ran.sort()).toEqual([1, 2]); // item 0 failed, siblings unaffected
    expect(onBatchDone).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels the pending callback; a stale callback and later setQueue are no-ops", async () => {
    const pending: (() => void)[] = [];
    const cancel = vi.fn();
    const run = vi.fn(async () => {});
    const { q, schedule } = makeQueue({ pending, cancel, run });
    q.setQueue([0, 1]);
    expect(schedule).toHaveBeenCalledTimes(1);
    q.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
    await drain(pending); // the stale callback must not run any item
    expect(run).not.toHaveBeenCalled();
    q.setQueue([2]); // disposed: ignored
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm while a batch is running; completion re-arms once", async () => {
    const pending: (() => void)[] = [];
    let release: (() => void) | null = null;
    const { q, schedule } = makeQueue({
      pending,
      batchSize: 1,
      run: () => new Promise<void>((r) => { release = r; }),
    });
    q.setQueue([0]);
    expect(schedule).toHaveBeenCalledTimes(1);
    pending.shift()!(); // batch starts, run blocks
    q.setQueue([1, 2]); // mid-flight re-plan: must NOT schedule (running)
    expect(schedule).toHaveBeenCalledTimes(1);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    expect(schedule).toHaveBeenCalledTimes(2); // completion re-armed exactly once
  });

  it("onBatchDone fires even when disposed mid-batch", async () => {
    const pending: (() => void)[] = [];
    let release: (() => void) | null = null;
    const onBatchDone = vi.fn();
    const { q } = makeQueue({
      pending,
      batchSize: 1,
      run: () => new Promise<void>((r) => { release = r; }),
      onBatchDone,
    });
    q.setQueue([0]);
    pending.shift()!();
    q.dispose();
    release!();
    await new Promise((r) => setTimeout(r, 0));
    expect(onBatchDone).toHaveBeenCalledTimes(1);
  });
});
