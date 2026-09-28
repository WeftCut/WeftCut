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
    // Eviction pressure: the L0 LRU is bounded by BYTES now, so overflowing it
    // for a test would mean materializing >512 MB of real bitmaps. `clearAll`
    // drives the same retire path LRU eviction uses — unpinned frames close,
    // sprite-pinned ones park and stay open — so the survival contract under
    // test (bound bitmaps must outlive eviction + GPU unload) is identical.
    sharedMotifFrameCache.clearAll();
    for (const source of sources) source.unload();
    return {
      rendererType: app.renderer.type,
      sources: sources.size,
      liveBitmaps: [...bitmaps].filter((bitmap) => bitmap.width > 0).length,
    };
  };
}
