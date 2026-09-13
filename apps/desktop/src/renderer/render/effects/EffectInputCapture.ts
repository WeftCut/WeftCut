import { AlphaFilter, Matrix, Sprite, Texture, RendererType } from 'pixi.js';
import type { FilterSystem, RenderSurface, WebGPURenderer } from 'pixi.js';
import type { PreviewFrame } from '../../colorpick/previewSamplerRegistry';

/** A one-render tap at the target effect's input, before sibling compositing.
 * Reads the filter texture while Pixi still owns it; only CPU bytes survive.
 * No private FilterSystem fields or pooled textures escape this module. */
export class EffectInputCapture extends AlphaFilter {
  private readonly origin = new Sprite(Texture.WHITE);
  private frame: PreviewFrame | null = null;
  private failure: unknown;
  private gpuRead: { buffer: GPUBuffer; width: number; height: number; stride: number; bgra: boolean;
    region: NonNullable<PreviewFrame['region']> } | null = null;

  constructor() {
    // Inherit the chain's resolution; this tap must not lower its quality.
    super({ alpha: 1, resolution: 'inherit' });
  }

  override apply(system: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    if (!this.frame && !this.gpuRead && !this.failure) {
      const renderer = system.renderer;
      const binding = renderer.renderTarget.getBindState();
      try {
        // calculateSpriteMatrix maps filter UVs into a sprite's texture UVs.
        // An identity sprite supplies a composition-space reference, including
        // Pixi's actual padding and clipping (not guessed from layer bounds).
        const map = system.calculateSpriteMatrix(new Matrix(), this.origin);
        const region = {
          x: map.tx * this.origin.texture.orig.width,
          y: map.ty * this.origin.texture.orig.height,
          width: input.frame.width, height: input.frame.height,
        };
        if (renderer.type === RendererType.WEBGPU) {
          const gpuRenderer = renderer as WebGPURenderer;
          const format = input.source.format;
          if (format !== 'rgba8unorm' && format !== 'bgra8unorm') throw new Error(`Unsupported pick texture format: ${format}`);
          const width = Math.round(input.frame.width * input.source.resolution);
          const height = Math.round(input.frame.height * input.source.resolution);
          const stride = Math.ceil(width * 4 / 256) * 256;
          const buffer = gpuRenderer.gpu.device.createBuffer({ size: stride * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          this.gpuRead = { buffer, width, height, stride, bgra: format === 'bgra8unorm', region };
          // Encode BEFORE the texture pool reuses this input, on the same
          // command encoder as the render. Canvas extraction submits a separate
          // encoder and color/alpha-converts, so it cannot read this input.
          renderer.renderTarget.finishRenderPass();
          gpuRenderer.encoder.commandEncoder.copyTextureToBuffer({
            texture: gpuRenderer.texture.getGpuSource(input.source),
            origin: { x: Math.round(input.frame.x * input.source.resolution), y: Math.round(input.frame.y * input.source.resolution) },
          }, { buffer, bytesPerRow: stride }, { width, height });
        } else {
          this.frame = { ...renderer.extract.pixels(input), region };
        }
      } catch (error) {
        // Finish the render normally even if readback fails, so Pixi can return
        // its temporary textures and unwind its filter stack.
        this.failure = error;
      } finally {
        renderer.renderTarget.bind(binding);
      }
    }
    super.apply(system, input, output, clear);
  }

  async result(): Promise<PreviewFrame> {
    if (this.failure) throw this.failure;
    if (this.gpuRead) {
      const { buffer, width, height, stride, bgra, region } = this.gpuRead;
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) pixels.set(mapped.subarray(y * stride, y * stride + width * 4), y * width * 4);
      if (bgra) for (let i = 0; i < pixels.length; i += 4) [pixels[i], pixels[i + 2]] = [pixels[i + 2]!, pixels[i]!];
      buffer.unmap();
      this.frame = { pixels, width, height, region };
    }
    if (!this.frame) throw new Error('Effect input is not visible or ready');
    return this.frame;
  }

  override destroy(): void {
    this.origin.destroy();
    this.gpuRead?.buffer.destroy();
    this.gpuRead = null;
    this.frame = null;
    super.destroy();
  }
}

export interface EffectInputRequest {
  layerId: string;
  effectId: string;
  tap: EffectInputCapture;
}
