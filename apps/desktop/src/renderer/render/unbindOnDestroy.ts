// Texture sources that leave every BindGroup holding them before they are
// destroyed, as Pixi asks ("remove it from the shader before destroying it").
//
// A WebGPU batch caches its group for good (`getTextureBatchBindGroup`), so
// every texture a sprite has drawn stays in a group after the sprite moves on.
// The groups are found through their ordinary `change` subscriptions, which
// touches no renderer or cache internals. Use these for every source this code
// creates for a sprite (or for a shader that may outlive it) and destroys.
// Guarded by unbindOnDestroy.test.ts.

import {
  BindGroup, ImageSource, RenderTexture, Texture, TextureSource, type TextureSourceOptions,
} from "pixi.js";

type OnArgs = Parameters<TextureSource["on"]>;

function bindGroupOf([event, , context]: readonly unknown[]): BindGroup | null {
  return event === "change" && context instanceof BindGroup ? context : null;
}

/** Re-points `source`'s slots (and its sampler's) in every group to the empty
 *  texture. Only its own slots: a batch also holds siblings. */
function unbind(source: TextureSource, bindings: Set<BindGroup>): void {
  // setResource unsubscribes, which edits `bindings`: iterate a snapshot.
  for (const group of [...bindings]) {
    for (const [index, resource] of Object.entries(group.resources)) {
      if (resource === source) group.setResource(Texture.EMPTY.source, Number(index));
      else if (resource === source.style) group.setResource(Texture.EMPTY.source.style, Number(index));
    }
  }
  bindings.clear();
}

/** A bitmap or canvas source. Destroying it never closes the resource it wraps. */
export class UnbindingImageSource extends ImageSource {
  readonly #bindings = new Set<BindGroup>();

  override on(...args: OnArgs): this {
    const group = bindGroupOf(args);
    if (group) this.#bindings.add(group);
    return super.on(...args);
  }

  override off(...args: Parameters<TextureSource["off"]>): this {
    const group = bindGroupOf(args);
    if (group) this.#bindings.delete(group);
    return super.off(...args);
  }

  override destroy(): void {
    if (this.destroyed) return;
    unbind(this, this.#bindings);
    super.destroy();
  }
}

/** The source of a render target. Twin of UnbindingImageSource: Pixi's
 *  ImageSource and TextureSource upload differently, so neither can stand in
 *  for the other. */
class UnbindingTextureSource extends TextureSource {
  readonly #bindings = new Set<BindGroup>();

  override on(...args: OnArgs): this {
    const group = bindGroupOf(args);
    if (group) this.#bindings.add(group);
    return super.on(...args);
  }

  override off(...args: Parameters<TextureSource["off"]>): this {
    const group = bindGroupOf(args);
    if (group) this.#bindings.delete(group);
    return super.off(...args);
  }

  override destroy(): void {
    if (this.destroyed) return;
    unbind(this, this.#bindings);
    super.destroy();
  }
}

/** `RenderTexture.create`, over a source that leaves its BindGroups on destroy. */
export function unbindingRenderTexture(options: TextureSourceOptions): RenderTexture {
  return new RenderTexture({ source: new UnbindingTextureSource(options) });
}
