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

const fence = () => sharedSlotFenceQueue().submit("s", 0, {} as ImageBitmap, () => {});

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
