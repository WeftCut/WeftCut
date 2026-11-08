// Motif layer rendered via the CDP capture path → per-frame raster → texture.
// A Motif animates over its layer duration. A per-instance playback cursor
// selects frames and coalesces asynchronous frame demand.
//
// Preview frames come from `acquireMotifFrame` / `peekMotifFrame`
// (`motifFrameSource.ts`): L0, a stored frame, or the hidden capture host.
// Each bound frame is a lease that pins its L0 bitmap, so eviction cannot
// close it under the texture; the sprite releases the previous lease after
// binding the next. Useful late results advance forward playback. The export
// Worker binds exact pre-baked `injectedFrames` by index instead.
//
// Preview reads stored frames at the Playback Resolution divisor (ADR 0154).
// The sprite draws every preview frame at the Motif's logical (manifest) size
// whatever the bitmap's size, so geometry, anchors and the gizmo do not move
// with the divisor.

import { type Container, Rectangle, Sprite, Texture } from "pixi.js";

import { frameIndexInLayer } from "../../frames";
import { anchorPivot, textureExtent } from "../anchorPivot";
import type { ResolvedMotifView } from "../resolveView";
import { getMotif, type Motif } from "../motifs/catalog";
import { MotifPlaybackCursor, type MotifPlaybackSnapshot } from "../motifs/MotifPlaybackCursor";
import { motifFrameDescriptor } from "../motifs/motifFrameDescriptor";
import { motifDurationFrames } from "../motifs/motifFrames";
import type { StageableSprite } from "./StageableSprite";
import { MotifTextureSource } from "./MotifTextureSource";
import type { InjectedMotifFrames } from "../worker/motifStream";
import type { MotifReaderDiv } from "../../../shared/motifs/readerProtocol";

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
  /// Preview's Playback Resolution divisor; 1 when absent.
  scaleDiv?: () => MotifReaderDiv;
}

interface BoundRaster { bitmap: ImageBitmap | HTMLCanvasElement; release(): void }
const unpinned = (bitmap: ImageBitmap | HTMLCanvasElement): BoundRaster => ({ bitmap, release: () => {} });

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
  /// The texture's local size (`Texture.orig`): the Motif's logical size for
  /// preview frames, the bitmap's own for the placeholder and export frames.
  /// The texture's frame still follows the bitmap, so a 1/2 bitmap stretches
  /// over the same quad.
  private readonly orig = new Rectangle();
  /// The lease on the raster `source` wraps. A preview frame's lease pins it
  /// in L0, so an LRU eviction can't close it under a texture Pixi may still
  /// re-upload; the placeholder and export frames hold a lease that does
  /// nothing.
  private bound: BoundRaster | null = null;
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
      bind: (lease, d) => this.bindRaster(lease, { width: d.renderW, height: d.renderH }),
      onLoaded: () => this.onLoaded?.(),
      scaleDiv: init.scaleDiv ?? (() => 1),
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
    // Position is the anchor in composition pixels (anchorPivot.ts).
    // The texture's local size (`orig`) is the local space: the logical size
    // for preview frames, so the pivot does not move with the divisor.
    const pivot = anchorPivot({
      x: view.x,
      y: view.y,
      anchorX: view.anchor_x,
      anchorY: view.anchor_y,
      ...textureExtent(this.sprite.texture),
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
        if (this.bound?.bitmap !== injectedFrames.bitmap) this.bindRaster(unpinned(injectedFrames.bitmap));
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
        this.bindRaster(unpinned(bitmap));
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
      this.bindRaster(unpinned(neutralPlaceholder()));
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

  /// Takes `raster`'s lease. `size` is the local size the bitmap is drawn
  /// at; the placeholder and export frames keep their own.
  private bindRaster(
    raster: BoundRaster,
    size: { width: number; height: number } = raster.bitmap,
  ): void {
    // Release the previous lease only once the source no longer references
    // its bitmap below: its last release may close an evicted bitmap.
    const previous = this.bound;
    const bitmap = raster.bitmap;
    this.bound = raster;
    const resized = this.orig.width !== size.width || this.orig.height !== size.height;
    this.orig.width = size.width;
    this.orig.height = size.height;
    // WebGPU caches batch BindGroups by source identity. Keep one source and
    // texture per sprite: destroying them each frame leaves the previous
    // batch bound to a dead source/sampler and produces a warning every tick.
    if (this.source) {
      this.source.resource = bitmap;
      this.source.update(); // uploads new pixels; also resizes when needed
      if (resized) this.texture!.update();
    } else {
      this.source = new MotifTextureSource({
        resource: bitmap,
        width: bitmap.width,
        height: bitmap.height,
      });
      // Dynamic keeps Sprite geometry in sync when a placeholder, an edited
      // Motif or a divisor changes dimensions while retaining the same Texture
      // identity. No `frame`: it follows the source; `orig` is the local size.
      this.texture = new Texture({ source: this.source, orig: this.orig, dynamic: true });
      this.sprite.texture = this.texture;
    }
    this.boundOnce = true;
    previous?.release();
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
    this.bound?.release();
    this.bound = null;
  }
}
