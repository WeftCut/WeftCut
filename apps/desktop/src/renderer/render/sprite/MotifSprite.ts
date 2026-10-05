// Motif layer rendered via the CDP capture path → per-frame raster → texture.
// A Motif animates over its layer duration. A per-instance playback cursor
// selects cache-owned bitmaps and coalesces asynchronous frame demand.
//
// Frames are stored in a process-wide `sharedMotifFrameCache` (an in-RAM
// LRU keyed by `(cacheKey, frameIndex)`) so two sprites referencing the same
// Motif with the same canonical props / dims / fps share one bitmap per
// frame. Frames whose descriptor resolved with a pending params-page patch
// (`overlayActive`) go to the separate small `sharedMotifOverlayCache`
// instead, so gesture churn can't evict committed content. Sprite dispose
// tears down the sprite's Pixi Texture wrapper but does NOT close the
// underlying bitmap — the cache (whichever lane holds it) owns its lifetime.
//
// Cache misses resolve through the shared broker (disk first, then the hidden
// capture host). Useful late results advance forward playback. The export
// Worker binds exact pre-baked `injectedFrames` by index instead.

import { type Container, Sprite, Texture } from "pixi.js";

import { frameIndexInLayer } from "../../frames";
import { anchorPivot, textureExtent } from "../anchorPivot";
import type { ResolvedMotifView } from "../resolveView";
import { getMotif, type Motif } from "../motifs/catalog";
import { sharedMotifFrameCache } from "../motifs/motifRasterCache";
import { MotifPlaybackCursor, type MotifPlaybackSnapshot } from "../motifs/MotifPlaybackCursor";
import type { MotifFrameCache } from "../motifs/frameCache";
import { motifFrameDescriptor } from "../motifs/motifFrameDescriptor";
import { motifDurationFrames } from "../motifs/motifFrames";
import type { StageableSprite } from "./StageableSprite";
import { MotifTextureSource } from "./MotifTextureSource";
import type { InjectedMotifFrames } from "../worker/motifStream";

// A faint neutral tile shown while a first-ever-cold Motif's frame 0 is still
// in flight, so the layer reads as "warming" rather than vanishing. Built once
// from a 2×2 canvas (preview only — the export Worker never hits this path).
let _placeholder: HTMLCanvasElement | null = null;
function neutralPlaceholder(): HTMLCanvasElement {
  if (_placeholder) return _placeholder;
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 2;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(128,128,128,0.18)";
  ctx.fillRect(0, 0, 2, 2);
  _placeholder = c;
  return _placeholder;
}

export interface MotifSpriteInit {
  layerId: string;
  motifId: string;
  /// Composition fps rational. The sprite maps `tInLayerUs` to a frame index
  /// with the same exact-rational math the rest of the renderer uses.
  fpsNum: number;
  fpsDen: number;
  /// Fires after a freshly-rasterized bitmap is bound. The host uses it to
  /// schedule a repaint when the playhead is paused (no rAF tick in flight to
  /// pick up the new texture). NOT fired on a synchronous cache hit — that
  /// happens inside the current paint, so a repaint would be churn.
  onLoaded?: () => void;
}

export class MotifSprite implements StageableSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly motifId: string;
  private readonly fpsNum: number;
  private readonly fpsDen: number;
  private motif: Motif | null;
  private readonly playback: MotifPlaybackCursor;
  /// Last comp-frame index bound from `injectedFrames` (export mode). Lets a
  /// repeated index (output fps < comp fps, or a held frame) skip the rebind +
  /// per-tick GPU texture churn. -1 = nothing bound yet.
  private injectedFrame = -1;
  private source: MotifTextureSource | null = null;
  private texture: Texture | null = null;
  /// The raster `source` wraps, pinned in its lane cache while bound so an
  /// LRU eviction can't close it under a texture Pixi may still re-upload.
  private bound: ImageBitmap | HTMLCanvasElement | null = null;
  /// The lane `bound` was pinned in (shared or overlay) — the release on
  /// rebind/dispose must go to the same lane the retain went to.
  private boundCache: MotifFrameCache | null = null;
  private onLoaded: (() => void) | null;
  private disposed = false;
  private boundOnce = false;

  constructor(init: MotifSpriteInit) {
    this.layerId = init.layerId;
    this.motifId = init.motifId;
    // The composition fps is captured ONCE at construction. If the project's
    // fps changes while this sprite is alive (a project swap that keeps the
    // sprite), the cached frame grid uses the stale rate until the sprite is
    // recreated — which the Compositor does on a composition reload.
    this.fpsNum = init.fpsNum;
    this.fpsDen = init.fpsDen;
    this.onLoaded = init.onLoaded ?? null;
    this.motif = getMotif(this.motifId);
    this.playback = new MotifPlaybackCursor({
      motif: () => this.motif, fpsNum: this.fpsNum, fpsDen: this.fpsDen,
      bind: (bitmap, lane) => this.bindBitmap(bitmap, lane),
      onLoaded: () => this.onLoaded?.(),
    });
    if (!this.motif && typeof document !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] MotifSprite ${this.layerId}: unknown motif "${this.motifId}"`,
      );
    }
    this.sprite = new Sprite(Texture.EMPTY);
  }

  get displayObject(): Container {
    return this.sprite;
  }

  /// EMPTY until the first raster (cache hit / capture) binds; not staged
  /// before then (PixiJS v8 batched renderer crashes on the EMPTY placeholder).
  get stageReady(): boolean {
    return this.sprite.texture !== Texture.EMPTY;
  }

  /// Apply the layer's transform and bind the raster for the frame at
  /// `tInLayerUs` (composition-time minus the layer's start; `src_in`
  /// windowing, where it applies, happens inside `motifFrameDescriptor`). On a
  /// cache hit the frame binds synchronously; on a miss it's captured +
  /// rasterized async and bound once ready (if still wanted).
  ///
  /// Export supplies one owned bitmap selected on the composition grid by
  /// exportMotifSource. Binding is synchronous; the worker releases pixels
  /// after rendering. Indexed arrays remain supported by isolated render tests.
  /// Absent (preview) uses the asynchronous cache/capture path below.
  update(
    view: ResolvedMotifView,
    tInLayerUs: number,
    durationUs: number,
    injectedFrames?: InjectedMotifFrames,
    playing = false,
  ): void {
    if (this.disposed) return;

    // Transforms first, every tick, BEFORE the frame no-op below: a
    // transform-only change with an unchanged frame must still take.
    this.sprite.scale.set(view.scale_x, view.scale_y);
    // Anchor is the pivot; `x`/`y` stay the unrotated top-left (anchorPivot.ts).
    // The raster's own dimensions are the local space here, so a Motif captured
    // at a different size still pivots at the same relative point.
    const pivot = anchorPivot({
      x: view.x,
      y: view.y,
      anchorX: view.anchor_x,
      anchorY: view.anchor_y,
      ...textureExtent(this.sprite.texture),
      effScaleX: view.scale_x,
      effScaleY: view.scale_y,
    });
    this.sprite.pivot.set(pivot.pivotX, pivot.pivotY);
    this.sprite.position.set(pivot.posX, pivot.posY);
    this.sprite.angle = view.rotation_deg;
    this.sprite.alpha = view.opacity;

    // Injected-frames path (export). Bind synchronously by layer-local
    // comp-frame index into the pre-baked array. The bake (`exportBake.ts`) is
    // responsible for content-window alignment: it renders each layer-local
    // frame at its CONTENT time (src_in offset + content duration), so this
    // branch only needs the layer-local index — it must NOT re-apply src_in or
    // the content cap (the preview path below does that for live rendering).
    // No canonicalize, no harness, no cache: the bitmaps are already baked.
    if (injectedFrames) {
      if ("bitmap" in injectedFrames) {
        // Each streamed bitmap has its own lifetime, even when output fps
        // repeats the same composition frame. Never reuse a closed binding.
        if (this.bound !== injectedFrames.bitmap) this.bindBitmap(injectedFrames.bitmap);
        this.injectedFrame = injectedFrames.frame;
        return;
      }
      const durationFrames = motifDurationFrames(
        durationUs,
        this.fpsNum,
        this.fpsDen,
      );
      const frame = Math.min(
        durationFrames - 1,
        frameIndexInLayer(tInLayerUs, this.fpsNum, this.fpsDen),
      );
      // Clamp into the baked array — a mid-layer export start leaves head
      // holes, and the array's length is `lastFrame + 1`, so an in-range
      // request always lands on a real bitmap. Guard against a hole / OOB
      // defensively (would otherwise bind `undefined`).
      const idx = Math.max(0, Math.min(injectedFrames.length - 1, frame));
      // Same index already bound → skip the rebind (avoids per-tick GPU
      // texture churn when output fps < comp fps or the frame is held).
      if (idx === this.injectedFrame) return;
      const bitmap = injectedFrames[idx];
      if (bitmap) {
        this.bindBitmap(bitmap);
        this.injectedFrame = idx;
      }
      return;
    }

    // Only live capture needs the catalog. The export Worker has built-ins
    // but no runtime user manifests; its injected bitmaps are already baked
    // and must render even when this Motif is unknown in the Worker.
    if (!this.motif) return;

    // `layerId` opts the on-screen frame into the preview overlay: a params
    // page mid-gesture renders here and nowhere else (the baker and the export
    // path deliberately omit it — see motifFrameDescriptor).
    const desc = motifFrameDescriptor(
      view, tInLayerUs, durationUs, this.fpsNum, this.fpsDen, this.motif, this.layerId,
    );
    if (!desc) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] MotifSprite ${this.layerId}: canonicalize failed`);
      return;
    }
    this.playback.update(desc, playing);
    if (!this.boundOnce && this.texture === null && typeof document !== "undefined") {
      this.bindBitmap(neutralPlaceholder());
    }
  }

  playbackSnapshot(): MotifPlaybackSnapshot { return this.playback.snapshot(); }
  invalidatePlayback(): void { this.playback.invalidate(); }

  /// Re-fetch this layer's Motif from the runtime catalog and reset the render
  /// target so the next `update()` re-evaluates the cache key and re-captures.
  /// Called by `Compositor.refreshMotifs()` on a catalog change (draft edit /
  /// install / delete). Does NOT dispose — the last bound bitmap stays on screen
  /// until the fresh frame lands, so there's no flash. No-op once disposed.
  refreshMotif(): void {
    if (this.disposed) return;
    this.motif = getMotif(this.motifId);
    this.playback.invalidate();
  }

  /// `pinCache` is the lane the bitmap belongs to (shared / overlay); the pin
  /// lands there and the matching release reads `boundCache`, so the two lanes'
  /// pin tables never cross. Foreign bitmaps (the placeholder canvas, export-
  /// injected frames) pin in the shared lane as before — retain is safe on
  /// anything, the cache never closes what it doesn't hold.
  private bindBitmap(
    bitmap: ImageBitmap | HTMLCanvasElement,
    pinCache: MotifFrameCache = sharedMotifFrameCache,
  ): void {
    // Pin the new raster before letting go of the old one, so a rebind of the
    // same bitmap never drops its count to zero in between. The old pin is
    // released only after the source no longer references it below.
    pinCache.retain(bitmap);
    const previous = this.bound;
    const previousCache = this.boundCache;
    this.bound = bitmap;
    this.boundCache = pinCache;
    // WebGPU caches batch BindGroups by source identity. Keep one source and
    // texture per sprite: destroying them each frame leaves the previous
    // batch bound to a dead source/sampler and produces a warning every tick.
    if (this.source) {
      this.source.resource = bitmap;
      this.source.update(); // uploads new pixels; also resizes when needed
    } else {
      this.source = new MotifTextureSource({
        resource: bitmap,
        width: bitmap.width,
        height: bitmap.height,
      });
      // Dynamic keeps Sprite geometry in sync when a placeholder or an edited
      // Motif changes dimensions while retaining the same Texture identity.
      this.texture = new Texture({ source: this.source, dynamic: true });
      this.sprite.texture = this.texture;
    }
    this.boundOnce = true;
    if (previous) (previousCache ?? sharedMotifFrameCache).release(previous);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playback.dispose();
    this.sprite.destroy({ children: true });
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        // Unbinds and frees the sprite-owned texture/source/GPU allocation,
        // never the cache-owned ImageBitmap.
        this.texture.destroy(true);
      } catch {
        // ignore
      }
    }
    this.texture = null;
    this.source = null;
    if (this.bound) (this.boundCache ?? sharedMotifFrameCache).release(this.bound);
    this.bound = null;
    this.boundCache = null;
  }
}
