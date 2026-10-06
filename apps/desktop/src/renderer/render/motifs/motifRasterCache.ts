// Shared raster primitive: process-wide cache singleton and the one-frame
// render helper used by both the on-demand MotifSprite path and the
// background prewarmer.
//
// Why a separate module: the prewarmer and the sprite MUST share one
// `MotifFrameCache` instance (the prewarmer fills the cache the sprite reads).
// Pulling the cache + raster function here lets both importers reach the same
// objects without coupling them to each other's class.

import { MotifFrameCache, hashCacheKey } from "./frameCache";
import { BakedKeyIndex } from "./bakedKeyIndex";
import type { Motif } from "./catalog";
import { rasterMotifFrame } from "./motifRaster";
import { motifPreviewActive, subscribeMotifPreview } from "./previewOverlay";
import { FrameBroker } from './FrameBroker';
import { MotifFrameScheduler } from './MotifFrameScheduler';
import { captureMotifFrameResult } from './host';
import { controlStoredMotifCapture, type CapturedFrame } from './frameTransport';
import { CAPTURE_SUPERSEDED_MESSAGE } from '../../../shared/motifs/captureErrors';

/// Process-wide per-frame cache shared by every MotifSprite AND the
/// prewarmer, so identical (motif, props, dims, fps, frame) rasters resolve
/// from one bitmap. Single instance — import this, never `new`.
export const sharedMotifFrameCache = new MotifFrameCache();

/// The preview-overlay gesture lane: a separate LRU sharing the same aggregate
/// retention allowance for frames whose
/// descriptor resolved with a pending (uncommitted) params-page patch
/// (`overlayActive`). Without it, every gesture tick's fresh cacheKey would
/// enter `sharedMotifFrameCache` and evict COMMITTED content under the
/// playhead. Frames here never touch L2 (the baker omits `layerId`, so an
/// overlay key is never in `sharedBakedKeyIndex` and `resolveMotifFrame`'s
/// disk-first branch never fires for one).
export const sharedMotifOverlayCache = new MotifFrameCache();

function broker(cache: MotifFrameCache) {
  return new FrameBroker({ cache, clone: bitmap => createImageBitmap(bitmap),
    control: (key, action, bake) => {
      frameScheduler.wake();
      if (action === 'bake') { if (bake) controlStoredMotifCapture({ key, action, bake }); }
      else controlStoredMotifCapture({ key, action });
    } });
}
const committedBroker = broker(sharedMotifFrameCache);
const overlayBroker = broker(sharedMotifOverlayCache);
let requestEpoch = 0;
export function resetMotifFrameRequests(): void {
  requestEpoch++;
  frameScheduler.reset(); committedBroker.reset(); overlayBroker.reset();
}
export function cancelMotifFrameRequest(key: string): void {
  committedBroker.cancel(key);
  overlayBroker.cancel(key);
}

// The lane is transient: when the last pending patch clears (gesture commit
// / cancel / panel teardown), every frame in it is garbage. Wipe on that
// transition instead of letting stale gesture rasters linger at full byte
// cost until LRU churn. `clearAll` retires rather than force-closes, so a
// sprite still binding a lane frame keeps it until its own release.
subscribeMotifPreview(() => {
  if (!motifPreviewActive()) sharedMotifOverlayCache.clearAll();
});

/// Process-wide index of which cacheKeys have frames baked on disk. The
/// Compositor hydrates it on project load; the baker `add`s on each write.
export const sharedBakedKeyIndex = new BakedKeyIndex(() => frameScheduler.wake());
const frameScheduler = new MotifFrameScheduler({
  shouldRead: (key, frame) => sharedBakedKeyIndex.hasFrame(key, frame) !== false,
  read: (key, frame) => sharedMotifFrameCache.readBitmap(key, frame),
  readMiss: (key, frame) => sharedBakedKeyIndex.forgetFrame(key, frame),
});

/// Obtain one motif frame, preferring a pre-baked frame on disk over a live
/// raster. Read-only: writing is the MotifBaker's job (single writer →
/// no LRU-eviction race on a fire-and-forget encode). Shared by the on-demand
/// sprite path and the prewarmer, so disk-first is uniform.
///
/// Exact coverage skips disk I/O for known holes; an unscanned directory is
/// still probed. The shared scheduler releases failed reads before admitting
/// their live-capture fallback, so fallback cannot consume disk-read capacity.
export async function resolveMotifFrame(
  motif: Motif,
  cacheKey: string,
  frame: number,
  tSec: number,
  durationSec: number,
  canonicalProps: Record<string, unknown>,
  coalesceKey?: string,
  /// Composition fps `tSec` was computed on — forwarded so the capture's
  /// `meta.fps` names the real rate, not the 30 fps fallback.
  fpsNum?: number,
  fpsDen?: number,
  overlay = false,
  priority: 'foreground' | 'background' = 'foreground',
): Promise<ImageBitmap> {
  // The DOM-less export path and node tests retain the portable producer.
  if (typeof window !== 'undefined' && typeof MessageChannel !== 'undefined') {
    return (await acquireFrame(motif, cacheKey, frame, tSec, canonicalProps, coalesceKey, fpsNum, fpsDen, false, overlay, priority)).bitmap;
  }
  if (!overlay) await sharedBakedKeyIndex.whenHydrated();
  if (!overlay && sharedBakedKeyIndex.hasFrame(cacheKey, frame) !== false) {
    try {
      const bitmap = await sharedMotifFrameCache.readBitmap(cacheKey, frame);
      if (bitmap) return bitmap;
    } catch {
      // permission/io hiccup — fall through to live raster.
    }
  }
  const [w, h] = motif.manifest.size;
  // durationSec is unused by the CDP path — duration is derived in main
  // (`motifCtxDurationS`, shared/motifs/catalog.ts) from props. Kept in the
  // signature for caller parity across the read paths.
  void durationSec;
  return rasterMotifFrame(motif.manifest.id, tSec, canonicalProps, w!, h!, motif.manifest.settle_rafs, motif.manifest.content_hash, coalesceKey, fpsNum, fpsDen);
}

export function acquireBakedMotifFrame(
  motif: Motif, cacheKey: string, frame: number, fpsNum: number, fpsDen: number,
  props: Record<string, unknown>,
): Promise<CapturedFrame> {
  return acquireFrame(motif, cacheKey, frame, frame * fpsDen / fpsNum, props, undefined, fpsNum, fpsDen, true, false);
}

function acquireFrame(
  motif: Motif, cacheKey: string, frame: number, tSec: number, props: Record<string, unknown>,
  coalesceKey: string | undefined, fpsNum: number | undefined, fpsDen: number | undefined,
  bake: boolean, overlay: boolean,
  priority: 'foreground' | 'background' = 'foreground',
): Promise<CapturedFrame> {
  const epoch = requestEpoch;
  return (overlay ? overlayBroker : committedBroker).acquire(cacheKey, frame, async ticket => {
    if (!overlay) await sharedBakedKeyIndex.whenHydrated();
    if (epoch !== requestEpoch || !ticket.wanted()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
    const [w, h] = motif.manifest.size;
    return frameScheduler.acquire({ cacheKey, frame, ticket, captureOnly: bake || overlay,
      capture: () => captureMotifFrameResult(motif.manifest.id, tSec, props, w!, h!, motif.manifest.settle_rafs,
        motif.manifest.content_hash, fpsNum, fpsDen, {
          key: ticket.key, high: ticket.high(),
          ...(ticket.bake() ? { bake: ticket.bake()! } : {}),
        }),
    });
  }, coalesceKey, bake ? { hash: hashCacheKey(cacheKey), frame } : undefined, priority);
}
