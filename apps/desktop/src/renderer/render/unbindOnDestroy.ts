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
type OffArgs = Parameters<TextureSource["off"]>;
/** The `change` listener a group subscribed with; it serves the sampler slot too. */
type GroupListener = (...args: unknown[]) => void;

function groupSubscription([event, fn, context]: readonly unknown[]): [BindGroup, GroupListener] | null {
  return event === "change" && context instanceof BindGroup && typeof fn === "function"
    ? [context, fn as GroupListener]
    : null;
}

/** Re-points `source`'s slots (and its sampler's) in every group to the empty
 *  texture. Only its own slots: a batch also holds siblings. The empty texture
 *  never changes, so the groups do not subscribe to it: subscribing would add a
 *  listener per cached group to it for the rest of the session. */
function unbind(source: TextureSource, bindings: Map<BindGroup, GroupListener>): void {
  const style = source.style;
  // Unsubscribing edits `bindings`: iterate a snapshot.
  for (const [group, listener] of [...bindings]) {
    const resources = group.resources;
    for (const key in resources) {
      const resource = resources[key];
      if (resource === source) {
        source.off("change", listener, group);
        group.setResourceUnwatched(Texture.EMPTY.source, Number(key));
      } else if (resource === style) {
        style.off("change", listener, group);
        group.setResourceUnwatched(Texture.EMPTY.source.style, Number(key));
      }
    }
  }
  bindings.clear();
}

/** A bitmap or canvas source. Destroying it never closes the resource it wraps. */
export class UnbindingImageSource extends ImageSource {
  readonly #bindings = new Map<BindGroup, GroupListener>();

  override on(...args: OnArgs): this {
    const subscription = groupSubscription(args);
    if (subscription) this.#bindings.set(...subscription);
    return super.on(...args);
  }

  override off(...args: OffArgs): this {
    const subscription = groupSubscription(args);
    if (subscription) this.#bindings.delete(subscription[0]);
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
  readonly #bindings = new Map<BindGroup, GroupListener>();

  override on(...args: OnArgs): this {
    const subscription = groupSubscription(args);
    if (subscription) this.#bindings.set(...subscription);
    return super.on(...args);
  }

  override off(...args: OffArgs): this {
    const subscription = groupSubscription(args);
    if (subscription) this.#bindings.delete(subscription[0]);
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
