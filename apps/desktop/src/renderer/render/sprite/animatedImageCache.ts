// Process-wide decode-once cache for animated still images. Decoding a GIF/WebP/
// APNG/AVIF yields its full frame set as downscaled ImageBitmaps plus per-frame
// native delays; multiple ImageOverlay layers on the same media share one decode
// (keyed by mediaId + downscale cap). Ref-counted: the cache OWNS the bitmaps
// and closes them when the last sprite releases. Decode is injectable so the
// ref-count/single-flight/eviction logic is unit-testable without ImageDecoder.

import { clampFrameDurationUs } from "./gifTiming";

export interface DecodedAnimation {
  /// Cache-owned. Sprites wrap (never close) these in their own Texture.
  frames: ImageBitmap[];
  /// Per-frame display time in µs, parallel to `frames`, already clamped.
  durationsUs: number[];
  totalUs: number;
  /// Decoded frame size: the source downscaled to the composition cap.
  width: number;
  height: number;
  /// The source's own size. Layer transforms are authored against THIS, so a
  /// sprite renders a frame at `natural / decoded` times the layer scale
  /// (`naturalScale`); without it a GIF larger than the composition shrinks by
  /// exactly the cap ratio.
  naturalWidth: number;
  naturalHeight: number;
}

/// Per-axis factor that maps a decoded frame back to the source's natural size:
/// the sprite's effective scale is the layer scale times this — anchorPivot's
/// `effScale`, the same source-vs-proxy correction video sprites apply. 1 when
/// the frame was not downscaled, and defensively 1 for a degenerate size.
export function naturalScale(
  anim: Pick<DecodedAnimation, "width" | "height" | "naturalWidth" | "naturalHeight">,
): { kx: number; ky: number } {
  const kx = anim.width > 0 && anim.naturalWidth > 0 ? anim.naturalWidth / anim.width : 1;
  const ky = anim.height > 0 && anim.naturalHeight > 0 ? anim.naturalHeight / anim.height : 1;
  return { kx, ky };
}

export type DecodeFn = (
  assetUrl: string,
  maxW: number,
  maxH: number,
) => Promise<DecodedAnimation>;

export interface AnimatedImageCache {
  /// Acquire (decoding on first request for `key`) and add a reference.
  acquire(key: string, assetUrl: string, maxW: number, maxH: number): Promise<DecodedAnimation>;
  /// Drop one reference; on the last release the decode's bitmaps are closed.
  release(key: string): void;
}

interface Entry {
  promise: Promise<DecodedAnimation>;
  refs: number;
  decoded: DecodedAnimation | null;
}

export function createAnimatedImageCache(decode: DecodeFn): AnimatedImageCache {
  const entries = new Map<string, Entry>();

  const closeAll = (a: DecodedAnimation) => {
    for (const f of a.frames) {
      try {
        f.close();
      } catch {
        // best-effort
      }
    }
  };

  return {
    acquire(key, assetUrl, maxW, maxH) {
      let e = entries.get(key);
      if (!e) {
        const entry: Entry = { promise: decode(assetUrl, maxW, maxH), refs: 0, decoded: null };
        entries.set(key, entry);
        entry.promise
          .then((d) => {
            // If still referenced, retain for later release; otherwise the last
            // reference was dropped mid-decode — close now so nothing leaks.
            if (entries.get(key) === entry && entry.refs > 0) entry.decoded = d;
            else closeAll(d);
          })
          .catch(() => {
            if (entries.get(key) === entry) entries.delete(key);
          });
        e = entry;
      }
      e.refs++;
      return e.promise;
    },
    release(key) {
      const e = entries.get(key);
      if (!e) return;
      e.refs--;
      if (e.refs <= 0) {
        entries.delete(key);
        if (e.decoded) closeAll(e.decoded);
        // If decode hasn't resolved yet, the `.then` above closes on arrival.
      }
    },
  };
}

/// Map a bare file extension (no dot) to its canonical image MIME type: the
/// fallback when the response carries no usable type (`imageMimeFor`). Twin of
/// the image cases in main/mediaMime.ts.
const EXT_MIME: Record<string, string> = {
  gif: "image/gif",
  webp: "image/webp",
  png: "image/png",
  apng: "image/apng", // Rare; APNG's standard path is .png-named files → image/png
  avif: "image/avif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function mimeFromUrl(url: string): string {
  try {
    const raw = new URL(url).pathname;
    const ext = raw.split(".").pop()?.toLowerCase() ?? "";
    return EXT_MIME[ext] ?? "";
  } catch {
    return "";
  }
}

/// The type to hand `ImageDecoder`: the response's own when it is a definite
/// image type, else the URL extension's. `ImageDecoder` refuses an empty type
/// and `application/octet-stream` alike (unlike `createImageBitmap`, it never
/// sniffs), and a `text/*` body is an error page rather than image bytes — so
/// all three fall through to the extension. Generic types are a normal input:
/// weftcut-media:// sends octet-stream for any extension main/mediaMime.ts
/// does not know, and so does any plain file server.
export function imageMimeFor(blobType: string, url: string): string {
  const generic = !blobType || blobType === "application/octet-stream" || blobType.startsWith("text/");
  return generic ? mimeFromUrl(url) : blobType;
}

/// Real decode via WebCodecs `ImageDecoder`. Works in both the preview main
/// thread and the export Worker. Each frame is downscaled at decode to
/// `min(originalDim, maxW/maxH)` so memory stays bounded (the composition never
/// shows a GIF larger than itself); `naturalWidth/Height` let the sprite render
/// it back at source size. Throws on a missing/unsupported decoder AND on a
/// single-frame source, so the caller falls back to the static full-resolution
/// `createImageBitmap` path: a still zoomed past 1:1 must not be served from a
/// composition-capped frame, and bmp/tiff/svg never decode here at all.
export const decodeAnimatedImage: DecodeFn = async (assetUrl, maxW, maxH) => {
  const Decoder = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
  if (!Decoder) throw new Error("ImageDecoder unavailable");
  const res = await fetch(assetUrl);
  if (!res.ok) throw new Error(`fetch ${assetUrl} -> ${res.status}`);
  const blob = await res.blob();
  const type = imageMimeFor(blob.type, assetUrl);
  if (!type) throw new Error(`ImageDecoder: cannot determine MIME type (blob.type=${blob.type}, url=${assetUrl})`);
  // isTypeSupported may return false in some renderer contexts even for
  // supported types; skip the pre-check and let the decoder fail at open time.
  const buf = await blob.arrayBuffer();
  const dec = new Decoder({ data: buf, type });
  const frames: ImageBitmap[] = [];
  const durationsUs: number[] = [];
  let w = 0;
  let h = 0;
  let naturalW = 0;
  let naturalH = 0;
  try {
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    if (!track) throw new Error("ImageDecoder: no selected track");
    const count = track.frameCount;
    if (count <= 1) throw new Error("ImageDecoder: single frame, static path");
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const { image } = await dec.decode({ frameIndex: i });
      const scale = Math.min(1, maxW / image.displayWidth, maxH / image.displayHeight);
      const rw = Math.max(1, Math.round(image.displayWidth * scale));
      const rh = Math.max(1, Math.round(image.displayHeight * scale));
      // eslint-disable-next-line no-await-in-loop
      const bmp = await createImageBitmap(image, {
        resizeWidth: rw,
        resizeHeight: rh,
        resizeQuality: "high",
      });
      durationsUs.push(clampFrameDurationUs(image.duration));
      if (i === 0) { w = rw; h = rh; naturalW = image.displayWidth; naturalH = image.displayHeight; }
      image.close();
      frames.push(bmp);
    }
  } catch (err) {
    for (const f of frames) {
      try { f.close(); } catch { /* best-effort */ }
    }
    throw err;
  } finally {
    dec.close();
  }
  let total = 0;
  for (const d of durationsUs) total += d;
  return { frames, durationsUs, totalUs: total, width: w, height: h, naturalWidth: naturalW, naturalHeight: naturalH };
};

/// The singleton every ImageOverlaySprite shares within a JS realm. (Preview and
/// the export Worker are separate realms, so each has its own — correct: their
/// composition dims, hence downscale caps, are independent.)
export const sharedAnimatedImageCache: AnimatedImageCache =
  createAnimatedImageCache(decodeAnimatedImage);
