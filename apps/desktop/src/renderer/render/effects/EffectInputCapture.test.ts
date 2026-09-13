// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Matrix, RendererType, Texture, type FilterSystem } from 'pixi.js';
import { EffectInputCapture } from './EffectInputCapture';

afterEach(() => vi.unstubAllGlobals());

describe('effect input readback failures', () => {
  it('reports an unstaged input instead of inventing pixels', async () => {
    const tap = new EffectInputCapture();
    await expect(tap.result()).rejects.toThrow('not visible or ready');
    tap.destroy();
  });

  it('restores the framebuffer and finishes the filter pass when WebGL readback throws', async () => {
    const binding = { target: Texture.WHITE, clear: false };
    const bind = vi.fn(); const applyFilter = vi.fn();
    const system = { calculateSpriteMatrix: () => new Matrix(), applyFilter,
      renderer: { type: RendererType.WEBGL,
        renderTarget: { getBindState: () => binding, bind },
        extract: { pixels: () => { throw new Error('context lost'); } } } } as unknown as FilterSystem;
    const tap = new EffectInputCapture();
    expect(() => tap.apply(system, Texture.WHITE, Texture.WHITE, true)).not.toThrow();
    expect(bind).toHaveBeenCalledWith(binding);
    expect(applyFilter).toHaveBeenCalledOnce();
    await expect(tap.result()).rejects.toThrow('context lost');
    tap.destroy();
  });

  it('releases its staging buffer after a rejected WebGPU mapping', async () => {
    vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, MAP_READ: 1 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const buffer = { mapAsync: vi.fn().mockRejectedValue(new Error('device lost')), destroy: vi.fn() };
    const copy = vi.fn(); const applyFilter = vi.fn();
    const system = { calculateSpriteMatrix: () => new Matrix(), applyFilter,
      renderer: { type: RendererType.WEBGPU,
        renderTarget: { getBindState: () => ({}), bind: vi.fn(), finishRenderPass: vi.fn() },
        gpu: { device: { createBuffer: () => buffer } },
        texture: { getGpuSource: () => ({}) }, encoder: { commandEncoder: { copyTextureToBuffer: copy } } } } as unknown as FilterSystem;
    const tap = new EffectInputCapture();
    tap.apply(system, Texture.WHITE, Texture.WHITE, true);
    expect(copy).toHaveBeenCalledOnce();
    expect(applyFilter).toHaveBeenCalledOnce();
    await expect(tap.result()).rejects.toThrow('device lost');
    tap.destroy();
    expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
