// The one thing Pixi leaves to whoever owns an Application: ending the life of
// the WebGPU device behind it. Structural access only — no pixi import — so the
// decoder transports can share it. ADR 0059.

/// The device of a WebGPU-backed Pixi renderer, or null for a WebGL/Canvas
/// renderer, a renderer that never initialized, or no renderer at all.
///
/// Owners destroy it right AFTER Pixi's own teardown of the Application. Pixi
/// drops its reference and nothing more, and a device left to the garbage
/// collector dies at an arbitrary later moment — in practice while the NEXT
/// Application's first work is in flight, which stalls the renderer main
/// thread for tens of seconds on Chromium 152. The order is load-bearing:
/// destroying the device BEFORE Pixi has released the canvas swap chain and
/// its textures stalls the same way.
export function webgpuDeviceOf(renderer: unknown): GPUDevice | null {
  const gpu = (renderer as { gpu?: { device?: GPUDevice | null } | null } | null | undefined)
    ?.gpu;
  return gpu?.device ?? null;
}
