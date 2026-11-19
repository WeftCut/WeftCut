import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "pixi.js";

import { installPreviewPresentation } from "./installPreviewPresentation";
import { setSlotFenceBackend, sharedSlotFenceQueue } from "./decoder/transports/slotFenceQueue";

// A WebGPU device whose copies are recorded, and that can be lost.
function fakeDevice(name: string, copies: string[]) {
  let loseDevice!: () => void;
  const device = {
    lost: new Promise<void>((resolve) => { loseDevice = resolve; }),
    createTexture: () => ({}),
    queue: {
      copyExternalImageToTexture: () => { copies.push(name); },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  } as unknown as GPUDevice;
  return { device, lose: async () => { loseDevice(); await device.lost; } };
}

// The surface of a Pixi Application this install touches: the renderer's
// device, its `contextChange` runner and the ticker the timed present joins.
function fakeApp(device: GPUDevice) {
  const listeners: { contextChange(): void }[] = [];
  const renderer = {
    gpu: { device },
    runners: { contextChange: { add: (item: { contextChange(): void }) => { listeners.push(item); } } },
  };
  const app = { renderer, ticker: { add() {}, remove() {} }, render() {} } as unknown as Application;
  // What Pixi's device restore does: a new device, then `contextChange`.
  const restore = (next: GPUDevice) => {
    renderer.gpu = { device: next };
    for (const l of listeners) l.contextChange();
  };
  return { app, restore };
}

const fence = () => sharedSlotFenceQueue().submit("s", 0, {} as ImageBitmap, () => {}, () => {});

// A WebGPU device whose submitted work completes when the test says so. Once
// lost, work still waiting settles the way `onLost` says (Chromium may reject
// it or report it done), and new waits reject.
function gatedDevice(onLost: "reject" | "resolve") {
  let loseDevice!: () => void;
  let lost = false;
  const copies: number[] = [];
  const waiting: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const issued: Promise<void>[] = [];
  const device = {
    lost: new Promise<void>((resolve) => { loseDevice = resolve; }),
    createTexture: () => ({}),
    queue: {
      copyExternalImageToTexture: () => { copies.push(1); },
      onSubmittedWorkDone: () => {
        const p = lost
          ? Promise.reject(new Error("device lost"))
          : new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
        issued.push(p);
        return p;
      },
    },
  } as unknown as GPUDevice;
  // Settled once every wait this device handed out has settled and their
  // reactions (registered earlier) have run.
  const settled = () => Promise.allSettled(issued).then(() => {});
  return {
    device,
    copies,
    complete: async () => {
      for (const w of waiting.splice(0)) w.resolve();
      await settled();
    },
    lose: async () => {
      lost = true;
      loseDevice();
      for (const w of waiting.splice(0)) {
        if (onLost === "reject") w.reject(new Error("device lost"));
        else w.resolve();
      }
      await device.lost;
      await settled();
    },
    settled,
  };
}

// One bitmap delivered to the shared queue, with what its owner was told.
function deliver() {
  const told: string[] = [];
  const r = sharedSlotFenceQueue().submit(
    "s",
    0,
    { width: 1, height: 1 } as ImageBitmap,
    () => told.push("release"),
    () => told.push("unproven"),
  );
  return { applied: r.applied, told };
}

describe("installPreviewPresentation: slot releases across a device loss", () => {
  beforeEach(() => { vi.stubGlobal("GPUTextureUsage", { COPY_DST: 2, RENDER_ATTACHMENT: 16 }); });
  afterEach(() => {
    sharedSlotFenceQueue().dropFor("s");
    setSlotFenceBackend(null);
    vi.unstubAllGlobals();
  });

  // Between the old device's loss and Pixi adopting the new one, the copy the
  // fence relies on is dropped: nothing orders after Chromium's read, so only a
  // completed one-pixel proof may release (none can run here: no OffscreenCanvas).
  it.each(["reject", "resolve"] as const)(
    "releases nothing without a completed proof before the next device is adopted (lost work: %s)",
    async (onLost) => {
      const first = gatedDevice(onLost);
      const second = gatedDevice(onLost);
      const { app, restore } = fakeApp(first.device);
      installPreviewPresentation(app);
      await first.lose();

      const between = deliver();
      await first.settled();
      expect(between.applied, "no fence on a lost device").not.toBe("fence");
      expect(between.told, "no proof ran, so the slot stays owned").not.toContain("release");

      restore(second.device);
      const after = deliver();
      expect(after.applied).toBe("fence");
      expect(after.told, "the fence waits for the new device's queue").toEqual([]);
      await second.complete();
      expect(after.told).toEqual(["release"]);
    },
  );

  // Pixi drops copies the moment the device is lost but the bitmap was read
  // with a copy that may still be pending: a proof by readback needs a bitmap
  // the ring may already have closed, so the stream is told to close instead.
  it.each(["reject", "resolve"] as const)(
    "never releases a fence pending when its device is lost; its stream is told instead (lost work: %s)",
    async (onLost) => {
      const first = gatedDevice(onLost);
      const { app } = fakeApp(first.device);
      installPreviewPresentation(app);

      const pending = deliver();
      expect(pending.applied).toBe("fence");
      await first.lose();
      expect(pending.told).toEqual(["unproven"]);
      expect(sharedSlotFenceQueue().pendingCount()).toBe(0);
    },
  );

  it("releases with a one-pixel proof between the loss and the adoption, when one can run", async () => {
    vi.resetModules();
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return { drawImage: () => {}, getImageData: () => {} }; }
    });
    const presentation = await import("./installPreviewPresentation");
    const queue = await import("./decoder/transports/slotFenceQueue");
    const first = gatedDevice("reject");
    const { app } = fakeApp(first.device);
    presentation.installPreviewPresentation(app);
    await first.lose();

    const told: string[] = [];
    const r = queue.sharedSlotFenceQueue().submit(
      "s", 0, { width: 1, height: 1 } as ImageBitmap, () => told.push("release"), () => told.push("unproven"),
    );
    await first.settled();
    expect(r.applied).toBe("proof");
    expect(told).toEqual(["release"]);
    queue.setSlotFenceBackend(null);
  });
});

describe("installPreviewPresentation", () => {
  beforeEach(() => { vi.stubGlobal("GPUTextureUsage", { COPY_DST: 2, RENDER_ATTACHMENT: 16 }); });
  afterEach(() => {
    setSlotFenceBackend(null);
    vi.unstubAllGlobals();
  });

  it("fences on the device Pixi presents from, the restored one after a loss", async () => {
    const copies: string[] = [];
    const first = fakeDevice("first", copies);
    const second = fakeDevice("second", copies);
    const { app, restore } = fakeApp(first.device);
    installPreviewPresentation(app);

    expect(fence().applied).toBe("fence");
    await first.lose();
    restore(second.device);
    expect(fence().applied).toBe("fence");
    expect(copies).toEqual(["first", "second"]);
  });

  it("drops copies on every presenting device once it is lost", async () => {
    const copies: string[] = [];
    const first = fakeDevice("first", copies);
    const second = fakeDevice("second", copies);
    const { app, restore } = fakeApp(first.device);
    installPreviewPresentation(app);

    await first.lose();
    fence();
    restore(second.device);
    await second.lose();
    fence();
    expect(copies).toEqual([]);
  });
});
