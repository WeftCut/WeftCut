import { describe, expect, it, vi } from "vitest";

import {
  SlotFenceQueue,
  type SlotFenceBackend,
  type SlotFenceProbe,
  type SlotFenceState,
} from "./slotFenceQueue";

/// A probe whose completion the test drives. `signal()` is what a real backend's
/// `onSubmittedWorkDone` does, with its wake-up; `set()` settles the probe
/// without one. A probe left pending models stalled GPU work that must retain
/// ownership until stream teardown.
type ControlledProbe = { signal: () => void; set: (to: SlotFenceState) => void; disposed: boolean };
function controllableBackend(): {
  backend: SlotFenceBackend;
  probes: ControlledProbe[];
} {
  const probes: ControlledProbe[] = [];
  const backend: SlotFenceBackend = {
    submit(_bmp, onSignal) {
      let state: SlotFenceState = "pending";
      const entry: ControlledProbe = {
        signal: () => {
          state = "complete";
          onSignal();
        },
        set: (to) => {
          state = to;
        },
        disposed: false,
      };
      probes.push(entry);
      const probe: SlotFenceProbe = {
        state: () => state,
        dispose: () => {
          entry.disposed = true;
        },
      };
      return probe;
    },
  };
  return { backend, probes };
}

const fakeBitmap = (): ImageBitmap => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;

describe("SlotFenceQueue", () => {
  it("reports live stalled-slot age even when no more frames arrive", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const q = new SlotFenceQueue(); const { backend, probes } = controllableBackend();
    q.setBackend(backend); q.submit("s", 0, fakeBitmap(), vi.fn(), vi.fn());
    now.mockReturnValue(190);
    expect(q.turnover("s")).toEqual({ pending: 1, oldestMs: 90, completed: 0, waitP95Ms: null });
    probes[0]!.signal();
    expect(q.turnover("s")).toEqual({ pending: 0, oldestMs: 0, completed: 1, waitP95Ms: 90 });
    q.dropFor("s"); expect(q.turnover("s")).toBeNull(); now.mockRestore();
  });
  it("acks a slot once its probe signals, and reports the fence it took", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const ack = vi.fn();

    const r = q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
    expect(r.applied).toBe("fence");
    // Deferred, not synchronous — the whole point of the mode.
    expect(ack).not.toHaveBeenCalled();
    expect(q.pendingCount()).toBe(1);

    q.drain();
    expect(ack).not.toHaveBeenCalled(); // still in flight

    probes[0]!.signal();
    q.drain();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(q.pendingCount()).toBe(0);
    // The probe holds a GPU object; leaking one per frame is not survivable.
    expect(probes[0]!.disposed).toBe(true);
  });

  // The invariant the whole file exists for. A frame the ring evicts, or one that
  // arrives while nothing is compositing, still holds a shared-texture slot —
  // `pool_size` stranded slots wedge the session for good. So the queue is told
  // about a bitmap on DELIVERY and never learns whether it was painted.
  it("acks exactly once per submitted bitmap, painted or not", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const acks: number[] = [];

    for (let slot = 0; slot < 3; slot++) {
      q.submit("s1", slot, fakeBitmap(), () => acks.push(slot), vi.fn());
    }
    for (const p of probes) p.signal();
    // Drained repeatedly: an already-acked entry must not ack a second time.
    q.drain();
    q.drain();
    q.drain();

    expect(acks.sort()).toEqual([0, 1, 2]);
  });

  // Slots are independently owned — native's ConsumeAck(slot) sets a per-slot
  // free flag with no ordering assumption — so a later frame's probe signalling
  // first must release that slot, not wait behind the earlier one.
  it("acks out of order when a later probe signals first", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const acks: number[] = [];
    q.submit("s1", 0, fakeBitmap(), () => acks.push(0), vi.fn());
    q.submit("s1", 1, fakeBitmap(), () => acks.push(1), vi.fn());

    probes[1]!.signal();
    q.drain();
    expect(acks).toEqual([1]);

    probes[0]!.signal();
    q.drain();
    expect(acks).toEqual([1, 0]);
  });

  // Recycling an unsignalled slot lets native overwrite the shared texture while
  // Chromium is still reading it. That is pixel corruption even when the frame
  // metadata remains perfectly ordered, so elapsed wall time is never evidence
  // that the slot is safe to release.
  it("keeps an unsignalled slot owned after the old deadline, until the stream closes", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const ack = vi.fn();

    q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
    now.mockReturnValue(1_000);
    q.drain();
    const forcedWaits = q.stats("s1")?.forcedWaits;
    const pendingBeforeClose = q.pendingCount();
    const disposedBeforeClose = probes[0]!.disposed;

    q.dropFor("s1");
    now.mockRestore();

    expect(ack).not.toHaveBeenCalled();
    expect(forcedWaits).toBe(0);
    expect(pendingBeforeClose).toBe(1);
    expect(disposedBeforeClose).toBe(false);
    expect(probes[0]!.disposed).toBe(true);
    expect(q.pendingCount()).toBe(0);
  });

  it("does not count a forced wait when the probe signalled in time", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    q.submit("s1", 0, fakeBitmap(), vi.fn(), vi.fn());
    probes[0]!.signal();
    q.drain();
    expect(q.stats("s1")?.forcedWaits).toBe(0);
  });

  it("releases every signalled slot when one probe throws during cleanup", () => {
    const q = new SlotFenceQueue();
    let slot = 0;
    q.setBackend({
      submit: () => {
        const ownSlot = slot++;
        return {
          state: () => "complete",
          dispose: () => {
            if (ownSlot === 1) throw new Error("device already lost");
          },
        };
      },
    });
    const acks: number[] = [];
    q.submit("s1", 0, fakeBitmap(), () => acks.push(0), vi.fn());
    q.submit("s1", 1, fakeBitmap(), () => acks.push(1), vi.fn());

    expect(() => q.drain()).not.toThrow();
    expect(acks.sort()).toEqual([0, 1]);
    expect(q.pendingCount()).toBe(0);
  });

  it("keeps an unreadable probe owned without blocking other completed slots", () => {
    const q = new SlotFenceQueue();
    let slot = 0;
    const disposed: number[] = [];
    q.setBackend({
      submit: () => {
        const ownSlot = slot++;
        return {
          state: () => {
            if (ownSlot === 0) throw new Error("device query failed");
            return "complete";
          },
          dispose: () => disposed.push(ownSlot),
        };
      },
    });
    const acks: number[] = [];
    q.submit("s1", 0, fakeBitmap(), () => acks.push(0), vi.fn());
    q.submit("s1", 1, fakeBitmap(), () => acks.push(1), vi.fn());

    expect(() => q.drain()).not.toThrow();
    expect(acks).toEqual([1]);
    expect(q.pendingCount()).toBe(1);

    q.dropFor("s1");
    expect(disposed.sort()).toEqual([0, 1]);
    expect(acks).toEqual([1]);
    expect(q.pendingCount()).toBe(0);
  });

  it("continues releasing completed slots when one ack callback throws", () => {
    const q = new SlotFenceQueue();
    q.setBackend({ submit: () => ({ state: () => "complete", dispose: () => {} }) });
    const acked: number[] = [];
    q.submit("s1", 0, fakeBitmap(), () => acked.push(0), vi.fn());
    q.submit("s1", 1, fakeBitmap(), () => {
      throw new Error("port failed");
    }, vi.fn());

    expect(() => q.drain()).not.toThrow();
    expect(acked).toEqual([0]);
    expect(q.pendingCount()).toBe(0);
  });

  // Teardown ordering, renderer side: the native close joins the decode thread,
  // so a dropped stream's slots cease to exist. Acking into a session main is
  // mid-closing is exactly what both sides' ordering exists to prevent.
  it("drops a closing stream's pending slots WITHOUT acking", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const ack = vi.fn();
    q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
    q.submit("s1", 1, fakeBitmap(), ack, vi.fn());

    q.dropFor("s1");
    expect(ack).not.toHaveBeenCalled();
    expect(q.pendingCount()).toBe(0);
    // Dropped, not leaked.
    expect(probes.every((p) => p.disposed)).toBe(true);

    // And a probe signalling after the drop can't resurrect the ack.
    probes[0]!.signal();
    q.drain();
    expect(ack).not.toHaveBeenCalled();
  });

  it("finishes closing a stream when one probe throws during cleanup", () => {
    const q = new SlotFenceQueue();
    const disposed: number[] = [];
    let slot = 0;
    q.setBackend({
      submit: () => {
        const ownSlot = slot++;
        return {
          state: () => "pending",
          dispose: () => {
            disposed.push(ownSlot);
            if (ownSlot === 1) throw new Error("device already lost");
          },
        };
      },
    });
    const ack = vi.fn();
    q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
    q.submit("s1", 1, fakeBitmap(), ack, vi.fn());

    expect(() => q.dropFor("s1")).not.toThrow();
    expect(disposed.sort()).toEqual([0, 1]);
    expect(q.pendingCount()).toBe(0);
    expect(ack).not.toHaveBeenCalled();
  });

  // A probe whose device was lost first proves nothing. Its slot must stay
  // native's; its owner closes the stream, and that close may come from inside
  // the drain without stranding another stream's completed slot.
  it("never releases an unproven slot, and tells its owner after releasing the proven ones", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const log: string[] = [];
    q.submit("s1", 0, fakeBitmap(), () => log.push("release s1/0"), () => {
      log.push("unproven s1/0");
      q.dropFor("s1");
    });
    q.submit("s1", 1, fakeBitmap(), () => log.push("release s1/1"), () => log.push("unproven s1/1"));
    q.submit("s2", 0, fakeBitmap(), () => log.push("release s2/0"), () => log.push("unproven s2/0"));

    // Both settle before the queue looks: one drain pass sees both.
    probes[0]!.set("unproven");
    probes[2]!.set("complete");
    q.drain();

    expect(log).toEqual(["release s2/0", "unproven s1/0"]);
    expect(probes[0]!.disposed).toBe(true);
    expect(q.pendingCount(), "the owner's close dropped its other slot").toBe(0);
    probes[1]!.signal();
    q.drain();
    expect(log).not.toContain("release s1/1");
  });

  it("drops only the named stream", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const a = vi.fn();
    const b = vi.fn();
    q.submit("s1", 0, fakeBitmap(), a, vi.fn());
    q.submit("s2", 0, fakeBitmap(), b, vi.fn());

    q.dropFor("s1");
    probes[1]!.signal();
    q.drain();

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  // The backend's completion callback covers gaps between frames without a poll:
  // with one clip at 30fps most signals land between deliveries.
  it("drains from the completion wake-up, with no frame arriving to poke it", async () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    const ack = vi.fn();
    q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
    probes[0]!.signal();

    await new Promise((r) => setTimeout(r, 0));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(q.pendingCount()).toBe(0);
  });

  // No device (no Application yet, or a WebGL preview) must degrade to SLOW, not
  // to INCORRECT — and must say so, or a bench leg publishes the fallback's cost
  // under the fence's name. In this environment there is no OffscreenCanvas
  // either, so the ladder bottoms out at `none`, which is the alarm reading.
  it("reports failure without releasing an unproven read when no device is registered", () => {
    const q = new SlotFenceQueue();
    const ack = vi.fn();
    const r = q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
    expect(r.applied).not.toBe("fence");
    expect(ack).not.toHaveBeenCalled();
    expect(q.pendingCount()).toBe(0);
  });

  it("releases at once after the one-pixel proof when no device can take a fence", async () => {
    vi.resetModules();
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        return { drawImage: () => {}, getImageData: () => {} };
      }
    });
    try {
      const { SlotFenceQueue: WithProof } = await import("./slotFenceQueue");
      const q = new WithProof();
      const ack = vi.fn();
      const r = q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
      expect(r.applied).toBe("proof");
      expect(ack).toHaveBeenCalledOnce();
      expect(q.pendingCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back the same way when the device refuses the submit", () => {
    const q = new SlotFenceQueue();
    q.setBackend({ submit: () => null });
    const ack = vi.fn();
    const r = q.submit("s1", 0, fakeBitmap(), ack, vi.fn());
    expect(r.applied).not.toBe("fence");
    expect(ack).not.toHaveBeenCalled();
  });

  // The bottom rung must not be able to break the invariant either: `drawImage`
  // THROWS on a detached bitmap where the backend merely returns null, and a
  // throw escaping `submit` would strand the slot for good.
  it("does not ack when the fallback itself throws", () => {
    const q = new SlotFenceQueue();
    q.setBackend({
      submit: () => {
        throw new Error("device lost");
      },
    });
    const ack = vi.fn();
    const detached = {
      width: 1,
      height: 1,
      close: vi.fn(),
    } as unknown as ImageBitmap;

    expect(() => q.submit("s1", 0, detached, ack, vi.fn())).not.toThrow();
    expect(ack).not.toHaveBeenCalled();
    expect(q.pendingCount()).toBe(0);
  });

  // Health as the handoff window records it. `waitMs` is absent until something
  // completes (a zero would read as an instant fence), and the peak is the depth
  // that says whether the deferral is freeing the producer or starving it.
  it("reports queue health with no wait until the first slot completes", () => {
    const q = new SlotFenceQueue();
    const { backend, probes } = controllableBackend();
    q.setBackend(backend);
    expect(q.stats("s1")).toBeUndefined();

    q.submit("s1", 0, fakeBitmap(), vi.fn(), vi.fn());
    q.submit("s1", 1, fakeBitmap(), vi.fn(), vi.fn());
    expect(q.stats("s1")).toEqual({ pendingPeak: 2, forcedWaits: 0, forcedWaitMsTotal: 0 });

    probes[0]!.signal();
    q.drain();
    const s = q.stats("s1")!;
    expect(s.pendingPeak).toBe(2);
    expect(s.waitMs).toBeGreaterThanOrEqual(0);
  });

  // The explicitly unsafe compatibility path has no blocking spin either: its
  // timer releases immediately. Keep that distinction visible in old bench data.
  it("reports zero spin time in the explicit unsafe deadline mode", () => {
    const q = new SlotFenceQueue({ mode: "unsafe-deadline", deadlineMs: 0 });
    const { backend } = controllableBackend();
    q.setBackend(backend);
    q.submit("s1", 0, fakeBitmap(), vi.fn(), vi.fn());
    q.drain();
    const s = q.stats("s1")!;
    expect(s.forcedWaits).toBe(1);
    expect(s.forcedWaitMsTotal).toBe(0);
  });
});
