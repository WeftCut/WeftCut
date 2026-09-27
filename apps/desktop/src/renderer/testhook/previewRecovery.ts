// E2E-only fault/pressure controls on the LIVE preview. No renderer is mocked:
// eviction uses the shared cache, unload uses Pixi's texture-GC entry point,
// and the injected present error is consumed by the app's real ticker listener.
import { type Application, type Container, Sprite } from "pixi.js";
import { sharedMotifFrameCache } from "../render/motifs/motifRasterCache";

export function previewRecoveryControls(app: Application) {
  return async (action: "evict-and-unload" | "throw-next-present") => {
    if (action === "throw-next-present") {
      const render = app.render;
      app.render = () => {
        app.render = render;
        throw new Error("[e2e] one failed preview present");
      };
      return { rendererType: app.renderer.type, sources: 0, liveBitmaps: 0 };
    }
    const sources = new Set<InstanceType<typeof Sprite>["texture"]["source"]>();
    const visit = (container: Container): void => {
      if (container instanceof Sprite && container.texture.source.resource instanceof ImageBitmap) {
        sources.add(container.texture.source);
      }
      for (const child of container.children) visit(child);
    };
    visit(app.stage);
    const bitmaps = new Set([...sources].map((source) => source.resource as ImageBitmap));
    // Prepare first, then insert synchronously so no ticker/capture can refresh
    // the LRU between insertions. Tiny real rasters keep pressure cheap.
    const filler = await Promise.all(Array.from(
      { length: sharedMotifFrameCache.capacity() + 1 },
      () => createImageBitmap(new ImageData(1, 1)),
    ));
    filler.forEach((bitmap, frame) => sharedMotifFrameCache.setFrame("e2e-pressure", frame, bitmap));
    for (const source of sources) source.unload();
    sharedMotifFrameCache.clearKey("e2e-pressure");
    return {
      rendererType: app.renderer.type,
      sources: sources.size,
      liveBitmaps: [...bitmaps].filter((bitmap) => bitmap.width > 0).length,
    };
  };
}
