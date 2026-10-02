---
status: accepted
---

# Motifs cache lossless pixels and transfer persistent textures

This revises ADR 0017's **PNG-only capture output**, while preserving its single
HTML renderer and deterministic clock takeover. PNG decoding and whole-pixel
IPC both consume a substantial part of a frame budget. Motifs now persist a
versioned LZ4/straight-RGBA frame file. Old PNG caches are ignored and frames
are regenerated; there is no migration or duplicate PNG persistence. Frames remain
independent files: atomic replacement, interrupted bakes and existing
content-directory GC stay simple; packing an entire clip would introduce
shared mutable indexes without addressing the measured bottleneck.

On Windows, the core addon reads/decompresses on a worker and uploads to a
bounded persistent D3D11 transport pool. Slot handles are shared once, and
per-frame messages carry leases. Chromium OSR output can also be copied into
that pool entirely on the GPU. This capability belongs to the core, not the
optional FFmpeg decode component. Other platforms and failures retain CPU/PNG
paths. Preview and export use the same frame reader; no author-visible engine
choice is introduced.

Playback uses three independently leased transport lanes. Each lane waits for
its own read-completion acknowledgment before reuse; disk prewarming admits
three concurrent reads for fully baked content, while live capture retains its
single-request limit. The 128 MiB/eight-pool allocation limit includes imports
in progress and retired textures until Electron releases their references.
Failed leases retire only their own lane; renderer close cancels queued work.

The consumer lifetime is a **document**, not its longer-lived WebContents.
Navigation retires the old transport generation, and preload releases all of
its imports on `pagehide`, including late arrivals. Disk reads and captures
bind that document at IPC admission, so work finishing after navigation cannot
lease slots to the replacement preload. Reloading with cached bitmaps and
in-flight reads is covered by the real-GPU transport regression.

Allocation waits for outstanding references are capped at 250 ms. Exhaustion
uses the existing CPU/PNG path; subsequent allocations fail promptly until a
reference release frees budget. The native pools stay alive until Electron's
release callback, so recovery never recycles a texture still being read.

The Motif read-completion barrier transfers the ImageBitmap to a dedicated
worker, completes the read there, and returns ownership before acknowledging
the source slot. This keeps synchronous GPU readback off the UI thread without
weakening the completion fence. Worker failure rejects outstanding reads and
uses the synchronous barrier for subsequent requests. The synthetic concurrent
frame test checks colors and alpha after repeated slot reuse.

The tradeoffs are potentially larger frame files than PNG and explicit GPU
ownership. A consumer must complete the GPU read before acknowledging a slot;
a failed/timed-out consumer retires its texture instead of permitting reuse.
Native pools outlive every Electron import. Straight PNG alpha is premultiplied
for texture import; captured OSR textures already carry premultiplied pixels.
Viewport changes settle before rendering, and OSR always waits two native rAFs
without changing virtual time. Static seeks restart the capturer because
invalidate alone need not produce a shared texture. See the reproducible
[conformance and performance evidence](../../poc/motif-frame-cache/FINDINGS.md).

The first GPU capture after navigation additionally fences the entire surface
with a CDP screenshot readback. Two native rAFs settle layout but can still leave
OSR holding the initial, pre-setup document while compositor raster work is
pending. Restarting the capturer can return that surface and bake it permanently.
A clipped readback is insufficient: tiles outside the clip may remain stale.
The full readback costs one PNG capture per navigation; subsequent frames retain
the GPU path. The `surface-v2` cache-key namespace invalidates old baked frames
without changing the frame file format or the authored Motif.

Baking also consumes the OSR lease directly on Windows. A persistent native
worker reuses a D3D11 staging texture, reads premultiplied RGBA/BGRA, converts
to straight RGBA and encodes the existing LZ4 frame format. Main atomically
writes it before acknowledging persistence. There is no format migration.
The alpha round trip preserves every valid premultiplied channel; straight RGB
can differ from Chromium's PNG unpremultiplication by one without changing
composited pixels. Unsupported hardware or failed readback retains the PNG
writer. In PNG capture mode, main stores the original captured PNG through the
existing codec without a renderer encode round trip. Disk errors remain bake
failures, not reasons to recapture.

A renderer frame broker shares L0 hits and in-flight capture between preview,
prewarm and baking. Each consumer gets an owned bitmap clone; cancelling one
sprite cannot close another consumer's frame. A bake joining an admitted
capture can attach persistence until texture consumption begins. Later joins
and L0 hits use bitmap persistence, avoiding another capture. Overlay gestures
have a separate broker. See the [bake benchmark](../../poc/motif-frame-cache/BAKE-FINDINGS.md).
