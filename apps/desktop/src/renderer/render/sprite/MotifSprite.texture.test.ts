import { afterEach, expect, it, vi } from "vitest";
import { Container, getTextureBatchBindGroup, type BindGroup } from "pixi.js";
import { MotifSprite } from "./MotifSprite";
import type { ResolvedMotifView } from "../resolveView";
import { sharedMotifFrameCache } from "../motifs/motifRasterCache";
import { getMotif, type Motif } from "../motifs/catalog";
import { motifFrameDescriptor } from "../motifs/motifFrameDescriptor";

// Keep the real Pixi source, texture, sprite and WebGPU batch bindings. The
// frame objects need only dimensions: this tests ownership, not GPU uploads.
vi.mock("../motifs/catalog", async (importOriginal) => ({
  ...await importOriginal<typeof import("../motifs/catalog")>(), getMotif: vi.fn(() => null),
}));
vi.mock("../motifs/motifRasterCache", async () => {
  const { MotifFrameCache } = await import("../motifs/frameCache");
  return {
    sharedMotifFrameCache: new MotifFrameCache(),
    sharedMotifOverlayCache: new MotifFrameCache(),
    resolveMotifFrame: vi.fn(),
  };
});

const view: ResolvedMotifView = {
  motif_id: "texture-lifecycle", x: 0, y: 0, scale_x: 1, scale_y: 1,
  rotation_deg: 0, anchor_x: 0.5, anchor_y: 0.5, opacity: 1,
  src_in_us: 0, props: {},
};
const sprites: MotifSprite[] = [];
const groups = new Set<BindGroup>();
function makeSprite() {
  const sprite = new MotifSprite({
    layerId: `layer-${sprites.length}`, motifId: view.motif_id, fpsNum: 30, fpsDen: 1,
  });
  sprites.push(sprite);
  return sprite;
}
function batch(sprite: MotifSprite) {
  const group = getTextureBatchBindGroup([sprite.sprite.texture.source], 1, 1);
  groups.add(group);
  return group;
}
function frame(width = 480, height = 270) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

it("rebinds a streamed duplicate composition frame after the prior bitmap is consumed", () => {
  const sprite = makeSprite(), first = frame(), second = frame();
  sprite.update(view, 0, 1_000_000, { frame: 0, bitmap: first });
  first.close();
  sprite.update(view, 0, 1_000_000, { frame: 0, bitmap: second });
  expect(sprite.sprite.texture.source.resource).toBe(second);
});
afterEach(() => {
  for (const group of groups) group.destroy();
  for (const sprite of sprites) sprite.dispose();
  groups.clear();
  sprites.length = 0;
  sharedMotifFrameCache.clearAll();
  vi.restoreAllMocks();
});

it("changes Motif frames without destroying a texture still in a WebGPU batch", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sprite = makeSprite();
  const frames = Array.from({ length: 60 }, () => frame());
  for (let i = 0; i < frames.length; i++) {
    sprite.update(view, Math.round(i * 1_000_000 / 30), 2_000_000, frames);
    batch(sprite);
    expect(sprite.sprite.texture.source.resource).toBe(frames[i]);
  }
  expect(warn.mock.calls.filter(args => args.join(" ").includes("[BindGroup]"))).toHaveLength(0);
  expect(groups.size).toBe(1);
});

it("detaches source and sampler bindings before disposal, without closing borrowed frames", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sprite = makeSprite();
  const bitmap = frame();
  sprite.update(view, 0, 1_000_000, [bitmap]);
  const source = sprite.sprite.texture.source;
  const style = source.style;
  const group = batch(sprite);
  sprite.dispose();
  expect(warn.mock.calls.filter(args => args.join(" ").includes("[BindGroup]"))).toHaveLength(0);
  expect(source.destroyed).toBe(true);
  expect(group.getResource(0)).not.toBe(source);
  expect(group.getResource(1)).not.toBe(style);
  expect(bitmap.close).not.toHaveBeenCalled();
});

it("updates pixels and geometry when frame dimensions change without replacing the source", () => {
  const sprite = makeSprite();
  const frames = [frame(2, 2), frame(640, 360), frame(240, 480)];
  sprite.update(view, 0, 1_000_000, frames);
  const texture = sprite.sprite.texture;
  const source = texture.source;
  const group = batch(sprite);
  for (let i = 1; i < frames.length; i++) {
    sprite.update(view, Math.round(i * 1_000_000 / 30), 1_000_000, frames);
    expect(sprite.sprite.texture).toBe(texture);
    expect(texture.source).toBe(source);
    expect(group.getResource(0)).toBe(source);
    expect(source.destroyed).toBe(false);
    expect(source.resource).toBe(frames[i]);
    expect([texture.width, texture.height]).toEqual([frames[i]!.width, frames[i]!.height]);
    expect([sprite.sprite.width, sprite.sprite.height]).toEqual([frames[i]!.width, frames[i]!.height]);
  }
});

it("removes only the retiring Motif's slots from every batch it participated in", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const a = makeSprite();
  const b = makeSprite();
  a.update(view, 0, 1_000_000, [frame()]);
  b.update(view, 0, 1_000_000, [frame()]);
  const aSource = a.sprite.texture.source;
  const bSource = b.sprite.texture.source;
  const alone = batch(a);
  const together = getTextureBatchBindGroup([aSource, bSource], 2, 2);
  groups.add(together);
  const gpuAllocation = { destroy: vi.fn() };
  // Models a renderer-owned allocation; real TextureSource.destroy must free it.
  aSource._gpuData[123] = gpuAllocation as never;
  a.dispose();
  expect(alone.getResource(0)).not.toBe(aSource);
  expect(together.getResource(0)).not.toBe(aSource);
  expect(together.getResource(2)).toBe(bSource);
  expect(together.getResource(3)).toBe(bSource.style);
  expect(bSource.destroyed).toBe(false);
  expect(gpuAllocation.destroy).toHaveBeenCalledTimes(1);
  b.dispose();
  expect(warn.mock.calls.filter(args => args.join(" ").includes("[BindGroup]"))).toHaveLength(0);
});

it("draws a 1/2 preview frame with the same world bounds and pivot as a full one", () => {
  const motif = { manifest: { id: view.motif_id, name: "M", version: 1, size: [480, 270],
    default_duration_s: 1, props_schema: {} }, hasParamsUi: false } as unknown as Motif;
  vi.mocked(getMotif).mockReturnValue(motif);
  try {
    const { cacheKey } = motifFrameDescriptor(view, 0, 1_000_000, 30, 1, motif)!;
    const full = frame(480, 270), half = frame(240, 135);
    sharedMotifFrameCache.setFrame(cacheKey, 0, 1, full);
    sharedMotifFrameCache.setFrame(cacheKey, 0, 2, half);
    const placed = { ...view, x: 100, y: 50, scale_x: 2, scale_y: 0.5, rotation_deg: 30, anchor_x: 0.25, anchor_y: 0.75 };
    const geometry = (div: 1 | 2) => {
      const sprite = new MotifSprite({ layerId: `div-${div}`, motifId: view.motif_id, fpsNum: 30, fpsDen: 1, scaleDiv: () => div });
      sprites.push(sprite);
      new Container().addChild(sprite.sprite);
      sprite.update(placed, 0, 1_000_000); // binds the cached frame
      sprite.update(placed, 0, 1_000_000); // the pivot follows the bound texture
      const b = sprite.sprite.getBounds();
      return { resource: sprite.sprite.texture.source.resource, pivot: [sprite.sprite.pivot.x, sprite.sprite.pivot.y],
        bounds: [b.x, b.y, b.width, b.height] };
    };
    const one = geometry(1), two = geometry(2);
    expect(one.resource).toBe(full);
    expect(two.resource).toBe(half);
    expect(two.pivot).toEqual([120, 202.5]);
    expect(two.pivot).toEqual(one.pivot);
    two.bounds.forEach((value, i) => expect(value).toBeCloseTo(one.bounds[i]!, 6));
  } finally { vi.mocked(getMotif).mockReturnValue(null); }
});

it("keeps an evicted shared bitmap alive until both sprites have moved off it", () => {
  const old = frame();
  sharedMotifFrameCache.setFrame("shared", 0, 1, old);
  const a = makeSprite();
  const b = makeSprite();
  const frames = [old, frame()];
  a.update(view, 0, 1_000_000, frames);
  b.update(view, 0, 1_000_000, frames);
  sharedMotifFrameCache.clearAll();
  expect(old.close).not.toHaveBeenCalled();
  a.update(view, 33_333, 1_000_000, frames);
  expect(old.close).not.toHaveBeenCalled();
  const bSource = b.sprite.texture.source;
  vi.mocked(old.close).mockImplementation(() => {
    expect(bSource.resource).not.toBe(old);
  });
  b.update(view, 33_333, 1_000_000, frames);
  expect(old.close).toHaveBeenCalledTimes(1);
});
