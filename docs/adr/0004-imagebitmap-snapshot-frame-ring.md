---
status: accepted
---

# Preview's `FrameRing` caches `ImageBitmap` snapshots, not `VideoFrame`s

Date: 2026-05-22

## Context

A WebCodecs `VideoDecoder` emits `VideoFrame`s backed by the hardware
decoder's buffer pool, about 13 slots on common desktop GPUs. Every retained
`VideoFrame` pins a slot until `close()`. When the pool is exhausted the
decoder goes silent with no error.

The preview ring holds about 40 frames at steady state (0.5 s lookbehind plus
1 s lookahead). Held as `VideoFrame`s it pinned about 8 slots. The decoder's
reorder buffer held 4–5 more, so the pool ran out. Warm-up could not pre-roll
more than about 8 frames, and Play froze on the last cached frame for about
600 ms while eviction returned slots one at a time.

## Decision

- The WebCodecs preview path converts each output frame with
  `createImageBitmap(frame)` and closes the `VideoFrame` as soon as the bitmap
  exists. The ring stores bitmaps; eviction and flush close them.
- A conversion that resolves after its decoder was replaced (inactivity
  rebuild, software downgrade) closes its bitmap and is dropped, so stale
  frames never enter the live ring.
- Export does not snapshot. `ExportFrameStore` keeps `VideoFrame`s, and the
  export loop closes each frame right after composition, so the pool drains
  without a copy. Both stores implement `FrameStore`, so sprites accept
  either kind.

## Consequences

- The ring can hold its full window without back-pressuring the decoder.
- Memory: a 1 s 1080p lookahead is about 73 × 6 MB ≈ 440 MB of GPU memory per
  active clip. The first lever is `DEFAULT_LOOKAHEAD_US` (`FrameRing.ts`).
- `createImageBitmap` color conversion is implementation-defined, so preview
  pixels are not bit-identical to export.
- The snapshot is a GPU-process copy. At three 4K hardware streams it is the
  measured cause of preview stalls
  ([preview-thread-split note](../notes/preview-thread-split-2026-10-26.md)).
  Zero-copy imports (`importExternalTexture`, `texImage2D(VideoFrame)`) would
  hold frames until drawn. Any replacement must still keep fewer than ~13
  frames alive per decoder.
