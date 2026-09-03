import { describe, expect, it } from "vitest";

import { webgpuDeviceOf } from "./webgpuDevice";

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
