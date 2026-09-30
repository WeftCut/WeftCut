// Motif layer rendered via the CDP capture path → per-frame raster → texture.
// A Motif animates over its layer duration: each composition frame is a
// distinct `resolveMotifFrame` call rasterized to an `ImageBitmap` and
// bound by frame index.
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
// Capture is async: on a cache miss the sprite calls `resolveMotifFrame`
// (in-RAM cache → on-disk PNG → live `rasterMotifFrame` CDP screenshot of the
// hidden Motif host), stores the result, and binds it if the playhead still
// wants that (cacheKey, frame). The export Worker (no `document`) never takes
// this path — it binds pre-baked `injectedFrames` by index instead.

import { type Container, Sprite, Texture } from "pixi.js";

import { frameIndexInLayer } from "../../frames";
import { anchorPivot, textureExtent } from "../anchorPivot";
import type { ResolvedMotifView } from "../resolveView";
import { getMotif, type Motif } from "../motifs/catalog";
import { resolveMotifFrame, sharedMotifFrameCache, sharedMotifOverlayCache } from "../motifs/motifRasterCache";
import type { MotifFrameCache } from "../motifs/frameCache";
import { isCaptureSuperseded } from "../motifs/host";
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

interface CaptureTarget {
  cacheKey: string;
  frame: number;
  /// Which lane this target's frames live in: the small overlay LRU when the
  /// descriptor resolved with a pending params-page patch, else the shared
  /// committed-content LRU. The overlay flag folds into `cacheKey` (props are
  /// keyed), so a gesture start/end always mints a fresh target anyway.
  overlay: boolean;
  state: "idle" | "pending" | "bound";
  failures: number;
  retryAt: number;
}

// A paused/capped content frame must recover without a seek, but an unavailable
// capture host must not receive a new request on every display tick. Saturate
// the delay, not the number of attempts: a longer outage must still recover.
// A background cache fill can satisfy the target before its retry is due.
const CAPTURE_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

export class MotifSprite implements StageableSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly motifId: string;
  private readonly fpsNum: number;
  private readonly fpsDen: number;
  private motif: Motif | null;
  /// Desired frame and its request state. Identity guards async completion,
  /// including a seek away and back to the same (key, frame).
  private target: CaptureTarget | null = null;
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
    const { cacheKey, contentFrame: frame, tSec, durationSec, canonicalProps: canonical } = desc;
    // Gesture frames (pending params-page patch) go to the small overlay lane
    // so a drag's per-tick cacheKeys can't evict committed content from the
    // shared LRU. No overlay pending ⇒ the shared lane, exactly as before.
    const lane = desc.overlayActive ? sharedMotifOverlayCache : sharedMotifFrameCache;
    if (cacheKey !== this.target?.cacheKey || frame !== this.target.frame) {
      this.target = { cacheKey, frame, overlay: desc.overlayActive, state: "idle", failures: 0, retryAt: 0 };
    }
    const target = this.target;
    if (target.state === "bound" || target.state === "pending") return;
    const cached = lane.getFrame(cacheKey, frame);
    if (cached) {
      this.bindBitmap(cached, lane);
      target.state = "bound";
      return;
    }
    if (performance.now() < target.retryAt) return;
    // First-ever cold frame: show a neutral placeholder so the layer doesn't
    // flash empty while frame 0 is captured. Later misses hold the last bitmap.
    if (!this.boundOnce && this.texture === null && typeof document !== "undefined") {
      this.bindBitmap(neutralPlaceholder());
    }
    target.state = "pending";
    void this.captureAndBind(target, tSec, durationSec, canonical);
  }

  /// Re-fetch this layer's Motif from the runtime catalog and reset the render
  /// target so the next `update()` re-evaluates the cache key and re-captures.
  /// Called by `Compositor.refreshMotifs()` on a catalog change (draft edit /
  /// install / delete). Does NOT dispose — the last bound bitmap stays on screen
  /// until the fresh frame lands, so there's no flash. No-op once disposed.
  refreshMotif(): void {
    if (this.disposed) return;
    this.motif = getMotif(this.motifId);
    this.target = null;
  }

  /// Render + rasterize one frame, store it, and bind it iff the playhead
  /// still wants this exact (cacheKey, frame) and the sprite is alive. The
  /// rasterized bitmap is handed to the shared cache even when superseded /
  /// disposed so the work isn't wasted (another sprite — or a later seek back
  /// — may want it). Everything here is async + DOM-touching, kept off the
  /// synchronous `update()` path so the document-less export Worker doesn't
  /// throw out of the composite loop.
  private async captureAndBind(
    target: CaptureTarget,
    tSec: number,
    durationSec: number,
    canonicalProps: Record<string, unknown>,
  ): Promise<void> {
    if (!this.motif) return;
    const { cacheKey, frame } = target;
    const lane = target.overlay ? sharedMotifOverlayCache : sharedMotifFrameCache;
    try {
      const bitmap = await resolveMotifFrame(
           this.motif, cacheKey, frame, tSec, durationSec, canonicalProps,
           // Latest-wins on the serial capture chain: a newer frame's request
           // from THIS sprite replaces a still-queued older one, so playback
           // can't build a stale-request backlog ahead of the prewarmer/baker.
           `sprite:${this.layerId}`,
           // The rate tSec was derived from — the capture's meta.fps must
           // agree with it (30 fps fallback would render wrong at other rates).
           this.fpsNum, this.fpsDen, target.overlay,
         );
      // Hand the bitmap to the target's lane cache. `setFrame` is idempotent:
      // if a sibling sprite already cached this (cacheKey, frame), it keeps
      // that bitmap and closes ours, returning the CANONICAL cache-owned
      // bitmap. Bind THAT, so no sprite ever binds a bitmap a sibling could
      // close (the cause of the "External Image has been detached" WebGPU
      // error on project reopen).
      const canonical = lane.setFrame(cacheKey, frame, bitmap);
      // A later `update` may have superseded this request while we awaited;
      // only bind if we still want exactly this (cacheKey, frame).
      if (this.disposed) return;
      if (this.target !== target) return;
      this.bindBitmap(canonical, lane);
      target.state = "bound";
      this.onLoaded?.();
    } catch (e) {
      if (this.disposed || this.target !== target) return;
      // Superseded by this sprite's own newer request (latest-wins queueing):
      // not a failure — no backoff, no error log. The frame stays retrievable
      // if the playhead returns to it.
      if (isCaptureSuperseded(e)) {
        if (target.state !== "bound") target.state = "idle";
        return;
      }
      // Callback errors must not turn an already-bound frame into a failed
      // capture. Otherwise a repaint callback could cause repeated rebinds.
      if (target.state !== "bound") {
        target.state = "idle";
        const delay = CAPTURE_RETRY_DELAYS_MS[Math.min(target.failures++, CAPTURE_RETRY_DELAYS_MS.length - 1)]!;
        target.retryAt = performance.now() + delay;
      }
      // Keep a persistent failure visible without a stream of identical logs.
      if (target.failures > 3 && target.failures % 10 !== 0) return;
      // eslint-disable-next-line no-console
      console.error(
        `[weftcut/pixi] MotifSprite ${this.layerId}: capture/rasterize failed`,
        e,
      );
    }
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
    this.target = null;
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
