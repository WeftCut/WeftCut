// Shared raster primitive: process-wide cache singleton and the one-frame
// render helper used by both the on-demand MotifSprite path and the
// background prewarmer.
//
// Why a separate module: the prewarmer and the sprite MUST share one
// `MotifFrameCache` instance (the prewarmer fills the cache the sprite reads).
// Pulling the cache + raster function here lets both importers reach the same
// objects without coupling them to each other's class.

import { MotifFrameCache } from "./frameCache";
import { BakedKeyIndex } from "./bakedKeyIndex";
import type { Motif } from "./catalog";
import { motifPreviewActive, subscribeMotifPreview } from "./previewOverlay";
import { FrameBroker } from './FrameBroker';
import { MotifFrameScheduler } from './MotifFrameScheduler';
import { captureMotifFrameResult } from './host';
import { controlStoredMotifCapture, type CapturedFrame } from './frameTransport';
import { motifSuperseded } from '../../../shared/motifs/errors';
import { hashCacheKey } from '../../../shared/motifs/cacheKey';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';

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
    control: (key, action) => {
      frameScheduler.wake();
      controlStoredMotifCapture({ key, action });
    } });
}
const committedBroker = broker(sharedMotifFrameCache);
const overlayBroker = broker(sharedMotifOverlayCache);
let requestEpoch = 0;
let mainPreparedKeys = new Set<string>();
/** Durable preparation is the sole background producer for its content.
 * Renderer prewarming shares disk-read admission and waits for coverage; it
 * never competes with main's page-local capture slices. */
export function setMotifPreparationCoverage(cacheKeys: Iterable<string>): void {
  mainPreparedKeys = new Set(cacheKeys);
  frameScheduler.coverageChanged();
}
export function resetMotifFrameRequests(): void {
  requestEpoch++;
  mainPreparedKeys.clear();
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

/// Process-wide index of which cacheKeys have frames baked on disk.
/// MotifFrameService restores it from main's bake snapshot; a stored write
/// `add`s its frame.
export const sharedBakedKeyIndex = new BakedKeyIndex(() => frameScheduler.wake());
const frameScheduler = new MotifFrameScheduler({
  shouldRead: (key, frame) => sharedBakedKeyIndex.hasFrame(key, frame) !== false,
  read: (key, frame, scaleDiv) => sharedMotifFrameCache.readBitmap(key, frame, scaleDiv),
  readMiss: (key, frame) => sharedBakedKeyIndex.forgetFrame(key, frame),
  backgroundCaptureAllowed: key => !mainPreparedKeys.has(key),
});

/// Obtain one motif frame, preferring a pre-baked frame on disk over a live
/// raster. Read-only: main owns durable writes (single writer →
/// no LRU-eviction race on a fire-and-forget encode). Shared by the on-demand
/// sprite path and the prewarmer, so disk-first is uniform.
///
/// Exact coverage skips disk I/O for known holes; an unscanned directory is
/// still probed. The shared scheduler releases failed reads before admitting
/// their live-capture fallback, so fallback cannot consume disk-read capacity.
///
/// A stored frame is read at `scaleDiv` (Playback Resolution); a live capture
/// is full size. The result names which, so callers store it in L0 under the
/// right divisor. A `MotifTransportError` rejects: it is not a miss and
/// captures nothing.
export async function resolveMotifFrame(
  motif: Motif,
  cacheKey: string,
  frame: number,
  tSec: number,
  canonicalProps: Record<string, unknown>,
  coalesceKey?: string,
  /// Composition fps `tSec` was computed on — forwarded so the capture's
  /// `meta.fps` names the real rate, not the 30 fps fallback.
  fpsNum?: number,
  fpsDen?: number,
  overlay = false,
  priority: 'foreground' | 'background' = 'foreground',
  scaleDiv: MotifReaderDiv = 1,
): Promise<CapturedFrame> {
  const epoch = requestEpoch;
  return (overlay ? overlayBroker : committedBroker).acquire(cacheKey, frame, scaleDiv, async ticket => {
    if (!overlay) await sharedBakedKeyIndex.whenHydrated();
    if (epoch !== requestEpoch || !ticket.wanted()) throw motifSuperseded();
    const [w, h] = motif.manifest.size;
    return frameScheduler.acquire({ cacheKey, frame, scaleDiv, ticket, captureOnly: overlay,
      capture: () => captureMotifFrameResult(motif.manifest.id, tSec, canonicalProps, w!, h!,
        motif.manifest.content_hash, fpsNum, fpsDen, {
          key: ticket.key, high: ticket.high(), scaleDiv,
          ...(!overlay ? { cache: { hash: hashCacheKey(cacheKey), frame } } : {}),
        }),
    });
  }, coalesceKey, priority);
}
