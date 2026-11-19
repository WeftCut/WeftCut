import { describe, expect, it } from "vitest";

import { dropCopiesOnceLost, webgpuDeviceOf } from "./webgpuDevice";

describe("webgpuDeviceOf", () => {
  it("hands back the device of a WebGPU renderer", () => {
    const device = { destroy() {} } as unknown as GPUDevice;
    expect(webgpuDeviceOf({ gpu: { adapter: {}, device } })).toBe(device);
  });

  it("is null for a WebGL renderer, a renderer without a device, and no renderer", () => {
    expect(webgpuDeviceOf({ gl: {} })).toBeNull();
    expect(webgpuDeviceOf({ gpu: null })).toBeNull();
    expect(webgpuDeviceOf({ gpu: { adapter: {}, device: null } })).toBeNull();
    expect(webgpuDeviceOf(undefined)).toBeNull();
    expect(webgpuDeviceOf(null)).toBeNull();
  });
});

describe("dropCopiesOnceLost", () => {
  const fakeDevice = () => {
    let loseDevice!: () => void;
    const copies: unknown[] = [];
    const device = {
      lost: new Promise<void>((resolve) => { loseDevice = resolve; }),
      queue: { copyExternalImageToTexture: (info: { source: unknown }) => { copies.push(info.source); } },
    } as unknown as GPUDevice;
    return { device, copies, lose: async () => { loseDevice(); await device.lost; } };
  };
  const copy = (device: GPUDevice, source: string) =>
    device.queue.copyExternalImageToTexture(
      { source } as unknown as GPUCopyExternalImageSourceInfo,
      {} as GPUCopyExternalImageDestInfo,
      [1, 1],
    );

  it("passes copies through while the device lives and drops them once it is lost", async () => {
    const { device, copies, lose } = fakeDevice();
    dropCopiesOnceLost(device);
    copy(device, "live");
    await lose();
    copy(device, "lost");
    expect(copies).toEqual(["live"]);
  });

  it("guards a device once however often it is adopted", async () => {
    const { device, copies, lose } = fakeDevice();
    dropCopiesOnceLost(device);
    dropCopiesOnceLost(device);
    copy(device, "live");
    await lose();
    copy(device, "lost");
    expect(copies).toEqual(["live"]);
  });
});
