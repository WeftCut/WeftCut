import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BindGroup, DOMAdapter, getTextureBatchBindGroup, Texture, type Renderer, type TextureSource } from "pixi.js";
import { VideoClipSprite } from "./sprite/VideoClipSprite";
import { ImageOverlaySprite } from "./sprite/ImageOverlaySprite";
import { CompositionRefSprite } from "./sprite/CompositionRefSprite";
import { sharedAnimatedImageCache, type DecodedAnimation } from "./sprite/animatedImageCache";
import { Nv12Ingest } from "./nv12/Nv12Ingest";
import { TenBitIngest } from "./tenbit/TenBitIngest";
import { TransitionNodeManager } from "./transitions/TransitionNodes";
import type { ActiveTransition } from "./transitions/activeTransitions";
import type { CompositionNode } from "./CompositionNode";
import type { CompositionSummary } from "../ipc";
import type { ResolvedImageOverlayView } from "./resolveView";
import type { NativeNv12Frame } from "./decoder/nv12Frame";
import type { TenBitFrame } from "./decoder/tenBitFrame";

// Real Pixi throughout: the property is about Pixi's own BindGroup
// subscriptions. A WebGPU batch caches its group globally
// (`getTextureBatchBindGroup`), so every texture a sprite draws stays in a
// group after the sprite moves on; `batch` stands in for that draw.

/** Every resource a BindGroup saw destroyed while it still held it. */
const destroyedWhileBound: unknown[] = [];
const groups = new Set<BindGroup>();
const cleanups: (() => void)[] = [];

beforeEach(() => {
  // A GL program probes fragment precision on a test canvas; Node has none.
  vi.spyOn(DOMAdapter.get(), "createCanvas").mockReturnValue(
    { getContext: () => null } as unknown as HTMLCanvasElement,
  );
  // Pixi's warning is emitted from here, and only for a resource the group
  // still holds; recording the resource names the culprit.
  type Watched = { onResourceChange(this: BindGroup, resource: { destroyed?: boolean }): void };
  const proto = BindGroup.prototype as unknown as Watched;
  const original = proto.onResourceChange;
  vi.spyOn(proto, "onResourceChange").mockImplementation(function (this: BindGroup, resource) {
    const held = this.resources && Object.values(this.resources).includes(resource as never);
    if (held && resource.destroyed) destroyedWhileBound.push(resource);
    original.call(this, resource);
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const group of groups) group.destroy();
  groups.clear();
  destroyedWhileBound.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function batch(...sources: TextureSource[]): BindGroup {
  const group = getTextureBatchBindGroup(sources, sources.length, sources.length);
  groups.add(group);
  return group;
}

function holds(group: BindGroup, source: TextureSource, style = source.style): boolean {
  return Object.values(group.resources).some((r) => r === source || r === style);
}

function bitmap(width = 64, height = 36): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

/** Stands in for the browser's OffscreenCanvas: VideoClipSprite only sizes it
 *  and draws into it. */
function stubOffscreenCanvas(): void {
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage: vi.fn() }; }
  });
}

it("a video clip's snapshot texture leaves every batch when its size changes and when it is disposed", () => {
  stubOffscreenCanvas();
  const clip = new VideoClipSprite({ layerId: "v", mediaId: "m" });
  cleanups.push(() => clip.dispose());
  clip.updateFrame(bitmap(64, 36));
  const first = clip.sprite.texture.source;
  const firstStyle = first.style;
  const firstGroup = batch(first);

  clip.updateFrame(bitmap(32, 18));
  const second = clip.sprite.texture.source;
  const secondStyle = second.style;
  const secondGroup = batch(second);
  expect(holds(firstGroup, first, firstStyle)).toBe(false);

  clip.dispose();
  expect(second.destroyed).toBe(true);
  expect(holds(secondGroup, second, secondStyle)).toBe(false);
  expect(destroyedWhileBound).toEqual([]);
});

it("an animated image keeps one texture across frames and leaves every batch on dispose", async () => {
  const frames = [bitmap(), bitmap(), bitmap()];
  const anim: DecodedAnimation = {
    frames, durationsUs: [100_000, 100_000, 100_000], totalUs: 300_000,
    width: 64, height: 36, naturalWidth: 64, naturalHeight: 36,
  };
  vi.spyOn(sharedAnimatedImageCache, "acquire").mockResolvedValue(anim);
  vi.spyOn(sharedAnimatedImageCache, "release").mockImplementation(() => {});
  const image = new ImageOverlaySprite({ layerId: "i", mediaId: "m", maxWidth: 64, maxHeight: 36 });
  cleanups.push(() => image.dispose());
  await image.loadFromAsset("asset://gif");
  const view = {
    x: 0, y: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, anchor_x: 0.5, anchor_y: 0.5,
    opacity: 1, fade_in_us: 0, fade_out_us: 0, src_in_us: 0,
  } as unknown as ResolvedImageOverlayView;
  const shown: TextureSource[] = [];
  const batches: BindGroup[] = [];
  for (let i = 0; i < frames.length; i++) {
    image.update(view, i * 100_000, 300_000);
    expect(image.sprite.texture.source.resource).toBe(frames[i]);
    shown.push(image.sprite.texture.source);
    batches.push(batch(image.sprite.texture.source));
  }
  expect(new Set(shown).size).toBe(1);
  const source = shown[0]!;
  const style = source.style;

  image.dispose();
  expect(source.destroyed).toBe(true);
  for (const group of batches) expect(holds(group, source, style)).toBe(false);
  for (const frame of frames) expect(frame.close).not.toHaveBeenCalled();
  expect(destroyedWhileBound).toEqual([]);
});

it("an image frame of another size gets its own texture, and the old one leaves every batch", async () => {
  const frames = [bitmap(64, 36), bitmap(32, 18)];
  const anim: DecodedAnimation = {
    frames, durationsUs: [100_000, 100_000], totalUs: 200_000,
    width: 64, height: 36, naturalWidth: 64, naturalHeight: 36,
  };
  vi.spyOn(sharedAnimatedImageCache, "acquire").mockResolvedValue(anim);
  vi.spyOn(sharedAnimatedImageCache, "release").mockImplementation(() => {});
  const image = new ImageOverlaySprite({ layerId: "i", mediaId: "m", maxWidth: 64, maxHeight: 36 });
  cleanups.push(() => image.dispose());
  await image.loadFromAsset("asset://gif");
  const view = {
    x: 0, y: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, anchor_x: 0.5, anchor_y: 0.5,
    opacity: 1, fade_in_us: 0, fade_out_us: 0, src_in_us: 0,
  } as unknown as ResolvedImageOverlayView;
  image.update(view, 0, 200_000);
  const first = image.sprite.texture.source;
  const firstStyle = first.style;
  const firstGroup = batch(first);

  image.update(view, 100_000, 200_000);
  const second = image.sprite.texture.source;
  expect(second).not.toBe(first);
  expect([second.width, second.height]).toEqual([32, 18]);
  expect(first.destroyed).toBe(true);
  expect(holds(firstGroup, first, firstStyle)).toBe(false);
  for (const frame of frames) expect(frame.close).not.toHaveBeenCalled();
  expect(destroyedWhileBound).toEqual([]);
});

function fakeNode(width: number, height: number) {
  return {
    composition: { width, height },
    setSize: vi.fn(), setComposition: vi.fn(), dispose: vi.fn(),
  } as unknown as CompositionNode;
}

it("a Group's render texture leaves every batch when the composition is resized and when it is disposed", () => {
  const group = new CompositionRefSprite({ layerId: "g", node: fakeNode(320, 180), renderer: undefined });
  cleanups.push(() => group.dispose());
  const first = group.sprite.texture.source;
  const firstStyle = first.style;
  const firstBatch = batch(first);

  group.setComposition({ width: 640, height: 360 } as CompositionSummary, null);
  expect(group.naturalSize()).toEqual({ w: 640, h: 360 });
  const second = group.sprite.texture.source;
  const secondStyle = second.style;
  const secondBatch = batch(second);
  expect(holds(firstBatch, first, firstStyle)).toBe(false);

  group.dispose();
  expect(second.destroyed).toBe(true);
  expect(holds(secondBatch, second, secondStyle)).toBe(false);
  expect(destroyedWhileBound).toEqual([]);
});

/** Ingest renders through the renderer only to fill its target; the pass
 *  itself is not under test. */
const renderer = { render: vi.fn() } as unknown as Renderer;

function nv12(width: number, height: number): NativeNv12Frame {
  return { width, height, data: new Uint8Array(width * height * 3 / 2), uvOffset: width * height } as unknown as NativeNv12Frame;
}

it("an NV12 clip texture leaves every batch when the frame size changes and when ingest is disposed", () => {
  const ingest = new Nv12Ingest(renderer);
  cleanups.push(() => ingest.dispose());
  const first = ingest.textureFor("clip", nv12(64, 36)).source;
  const firstStyle = first.style;
  const firstBatch = batch(first);

  const second = ingest.textureFor("clip", nv12(32, 18)).source;
  expect(second).not.toBe(first);
  const secondStyle = second.style;
  const secondBatch = batch(second);
  expect(holds(firstBatch, first, firstStyle)).toBe(false);

  ingest.dispose();
  expect(second.destroyed).toBe(true);
  expect(holds(secondBatch, second, secondStyle)).toBe(false);
  expect(destroyedWhileBound).toEqual([]);
});

function tenBit(width: number, height: number): TenBitFrame {
  const luma = width * height * 2, chroma = (width >> 1) * (height >> 1) * 2;
  return {
    width, height, data: new Uint8Array(luma + 2 * chroma),
    yOffset: 0, uOffset: luma, vOffset: luma + chroma,
  } as unknown as TenBitFrame;
}

it("a 10-bit clip texture leaves every batch when the frame size changes and when ingest is disposed", () => {
  const ingest = new TenBitIngest(renderer);
  cleanups.push(() => ingest.dispose());
  const first = ingest.textureFor("clip", tenBit(64, 36)).source;
  const firstStyle = first.style;
  const firstBatch = batch(first);

  const second = ingest.textureFor("clip", tenBit(32, 18)).source;
  const secondStyle = second.style;
  const secondBatch = batch(second);
  expect(holds(firstBatch, first, firstStyle)).toBe(false);

  ingest.dispose();
  expect(second.destroyed).toBe(true);
  expect(holds(secondBatch, second, secondStyle)).toBe(false);
  expect(destroyedWhileBound).toEqual([]);
});

function crossfade(id: string, progress: number): ActiveTransition {
  return {
    id, fromLayerId: `${id}-a`, toLayerId: `${id}-b`, kind: { kind: "Crossfade" } as ActiveTransition["kind"],
    startUs: 0, durationUs: 1_000_000, progress,
  };
}

it("a transition's side textures are destroyed only after the shader that samples them", () => {
  const transitions = new TransitionNodeManager(renderer, 64, 36);
  cleanups.push(() => transitions.dispose());
  transitions.beginFrame([crossfade("t", 0.5)]);
  transitions.beginFrame([]); // ends the window: sides go back to the pool
  transitions.beginFrame([crossfade("u", 0.5)]);
  transitions.setSize(32, 18); // stale sides are destroyed on their way back
  transitions.beginFrame([crossfade("u", 0.5)]);
  transitions.reset();
  transitions.dispose();
  expect(destroyedWhileBound).toEqual([]);
});

it("the empty texture that stands in for a destroyed one gains no listeners", () => {
  const empty = Texture.EMPTY.source;
  const before = [empty.listenerCount("change"), empty.style.listenerCount("change")];
  const group = new CompositionRefSprite({ layerId: "g", node: fakeNode(320, 180), renderer: undefined });
  cleanups.push(() => group.dispose());
  const source = group.sprite.texture.source;
  const style = source.style;
  const batches = [batch(source), batch(source), batch(source)];

  group.dispose();
  for (const b of batches) {
    expect(holds(b, source, style)).toBe(false);
    expect(holds(b, empty)).toBe(true);
  }
  expect([empty.listenerCount("change"), empty.style.listenerCount("change")]).toEqual(before);
  expect(source.listenerCount("change") + style.listenerCount("change")).toBe(0);
  expect(destroyedWhileBound).toEqual([]);
});
