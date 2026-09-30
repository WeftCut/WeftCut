import { describe, expect, it, vi } from "vitest";
import { MotifFrameProducer, MotifFrameInbox, closeMotifPacket, type MotifFramePacket } from "./motifStream";

const bitmap = () => ({ width: 2, height: 2, close: vi.fn() }) as unknown as ImageBitmap;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Motif export credits", () => {
  it("stops admission immediately if transferring a packet fails", () => {
    const plan = vi.fn(() => []), fail = vi.fn();
    const producer = new MotifFrameProducer({ totalFrames: 1000, plan, fail,
      send: () => { throw new Error('worker terminated'); },
    });
    producer.start();
    expect(fail).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledOnce();
  });
  it("starts before later reads finish and budgets reading, transferred and retained frames together", async () => {
    const reads = Array.from({ length: 1000 }, () => deferred<ImageBitmap>());
    const send = vi.fn(), fail = vi.fn(), plan = vi.fn(index => [{
      layerId: 'm', frame: index, bytes: 16, read: () => reads[index]!.promise,
    }]);
    const producer = new MotifFrameProducer({ totalFrames: 1000, maxBytes: 64, maxFrames: 3, plan, send, fail });
    producer.start();
    reads[0]!.resolve(bitmap());
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].index).toBe(0);
    expect(producer.stats.peakBytes).toBe(64);
    reads[1]!.resolve(bitmap());
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    // Transfer is not a release. It must not admit frame 2 before consumption.
    expect(send.mock.calls.map(c => c[0].index)).toEqual([0, 1]);
    producer.release(0);
    reads[2]!.resolve(bitmap());
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(producer.stats.peakBytes).toBe(64);
    producer.dispose();
    for (const [p] of send.mock.calls) closeMotifPacket(p);
    expect(fail).not.toHaveBeenCalled();
  });

  it("cancels during a read, closes late results and never starts another task", async () => {
    const wait = deferred<ImageBitmap>(), late = bitmap(), readNext = vi.fn(async () => bitmap());
    const send = vi.fn(), fail = vi.fn();
    const producer = new MotifFrameProducer({ totalFrames: 2, maxFrames: 1, send, fail,
      plan: () => [{ layerId: 'a', frame: 0, bytes: 16, read: () => wait.promise },
        { layerId: 'b', frame: 0, bytes: 16, read: readNext }],
    });
    producer.start(); producer.dispose(); wait.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(readNext).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
  });

  it("closes partial and concurrent packets when one capture fails", async () => {
    const first = bitmap(), late = bitmap(), wait = deferred<ImageBitmap>();
    const fail = vi.fn(), send = vi.fn();
    const producer = new MotifFrameProducer({ totalFrames: 2, send, fail,
      plan: index => index === 0 ? [
        { layerId: 'a', frame: 0, bytes: 16, read: async () => first },
        { layerId: 'b', frame: 0, bytes: 16, read: async () => { throw new Error('capture failed'); } },
      ] : [{ layerId: 'c', frame: 0, bytes: 16, read: () => wait.promise }],
    });
    producer.start();
    await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
    wait.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(first.close).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  });

  it("admits a frame larger than the budget alone without deadlocking", async () => {
    const send = vi.fn();
    const producer = new MotifFrameProducer({ totalFrames: 2, maxBytes: 1, send, fail: vi.fn(),
      plan: index => [{ layerId: 'a', frame: index, bytes: 16, read: async () => bitmap() }],
    });
    producer.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    producer.release(0);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(producer.stats.peakBytes).toBe(32);
    producer.dispose(); for (const [p] of send.mock.calls) closeMotifPacket(p);
  });
});

it("renders in requested order, and rejects waits / closes queued and late packets on teardown", async () => {
  const inbox = new MotifFrameInbox();
  const packet = (index: number): MotifFramePacket => ({ index, frames: { a: { frame: index, bitmap: bitmap() } } });
  const zero = packet(0), one = packet(1), late = packet(3);
  inbox.push(one);
  const waiting = inbox.take(0);
  inbox.push(zero);
  expect(await waiting).toBe(zero);
  closeMotifPacket(zero);
  const rejected = expect(inbox.take(2)).rejects.toThrow('cancelled');
  inbox.dispose(); inbox.push(late);
  await rejected;
  expect(one.frames.a!.bitmap.close).toHaveBeenCalledOnce();
  expect(late.frames.a!.bitmap.close).toHaveBeenCalledOnce();
});
