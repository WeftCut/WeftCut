import { BindGroup, ImageSource, Texture } from "pixi.js";

/**
 * Pixi 8 caches WebGPU batch groups beyond a sprite's lifetime. Observe their
 * normal resource subscriptions so we can detach this source and its owned
 * sampler before destroying them. No renderer/global cache internals touched.
 * The real-Pixi MotifSprite.texture tests guard this subscription contract.
 */
export class MotifTextureSource extends ImageSource {
  private readonly bindings = new Set<BindGroup>();

  override on(...args: Parameters<ImageSource["on"]>): this {
    const [event, , context] = args;
    if (event === "change" && context instanceof BindGroup) {
      this.bindings.add(context);
    }
    return super.on(...args);
  }

  override off(...args: Parameters<ImageSource["off"]>): this {
    const [event, , context] = args;
    if (event === "change" && context instanceof BindGroup) {
      this.bindings.delete(context);
    }
    return super.off(...args);
  }

  override destroy(): void {
    if (this.destroyed) return;
    // setResource removes subscriptions (and thus entries from bindings), so
    // iterate a snapshot. Replace only our slots; a batch may hold siblings.
    for (const group of [...this.bindings]) {
      for (const [index, resource] of Object.entries(group.resources)) {
        if (resource === this) {
          group.setResource(Texture.EMPTY.source, Number(index));
        } else if (resource === this.style) {
          group.setResource(Texture.EMPTY.source.style, Number(index));
        }
      }
    }
    this.bindings.clear();
    // Frees GPU allocations but never closes the cache-owned ImageBitmap.
    super.destroy();
  }
}
