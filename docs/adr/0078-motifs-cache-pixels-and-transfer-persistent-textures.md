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

The tradeoffs are potentially larger frame files than PNG and explicit GPU
ownership. A consumer must complete the GPU read before acknowledging a slot;
a failed/timed-out consumer retires its texture instead of permitting reuse.
Native pools outlive every Electron import. Straight PNG alpha is premultiplied
for texture import; captured OSR textures already carry premultiplied pixels.
Viewport changes settle before rendering, and OSR always waits two native rAFs
without changing virtual time. Static seeks restart the capturer because
invalidate alone need not produce a shared texture. See the reproducible
[conformance and performance evidence](../../poc/motif-frame-cache/FINDINGS.md).
