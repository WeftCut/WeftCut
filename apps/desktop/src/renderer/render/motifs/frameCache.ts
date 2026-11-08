import { hashCacheKey } from "../../../shared/motifs/cacheKey";
import { MIB, PERFORMANCE_DEFAULTS } from "../../../shared/performance-settings";
import { isMotifReaderDiv, type MotifReaderDiv } from "../../../shared/motifs/readerProtocol";
import { cacheBudget } from '../cacheBudget';
import type { MotifReadOptions } from "./MotifFrameReader";
import type { MotifFrameDiv } from "./frameTransport";
// Per-frame raster cache for animated motifs.
//
// A motif animates over its duration: each composition frame is a distinct
// CDP capture decoded to an `ImageBitmap`. This cache holds a SEQUENCE of
// frames per motif instance, keyed by `(cacheKey, frameIndex, scaleDiv)` —
// distinct from a single-bitmap-per-motif cache. Preview reads stored frames
// at the Playback Resolution divisor, so a 1/2 bitmap and a full one of the
// same frame are different entries (ADR 0154).
//
// Two layers:
//
//   L0 (default, must-have) — an in-RAM LRU of per-frame `ImageBitmap`s,
//   bounded by a BYTE budget (each frame accounts width × height × 4
//   decoded RGBA bytes), not a frame count — a count cap lets 240 × 1080p
//   frames pin ~2 GB. This is what preview pulls on-demand while
//   scrubbing. Evicted bitmaps are `.close()`d so their GPU-side
//   backing is freed promptly rather than waiting on GC — except one a
//   sprite still has bound (`retain`), which closes on its last `release`.
//
//   L2 (opt-in, lighter) — a zstd frame sequence persisted to disk
//   under `<workspace>/Cache/raster/<hash>/<i>.wfrm`. Driven by a global
//   "Pre-bake" setting and a per-layer "Pre-bake now" action; read on the
//   default preview path via `resolveMotifFrame` (disk-first, gated by
//   an in-RAM baked-key index). Main-owned preparation writes durable frames.
//
// `cacheKey` is an opaque STRING the caller builds from
// `(motifId, version, canonicalPropsJSON, renderW, renderH,
// fpsNum, fpsDen, durationFrames)`. The cache never parses it; it only
// hashes it (for the L2 dir name) and uses it as the L0 key prefix.

/// Minimal contract the L0 store needs from a cached frame. The browser
/// `ImageBitmap` satisfies this; a vitest can pass `{ close: vi.fn() }`.
/// Typing the store this way is what makes the LRU / recency / eviction
/// logic unit-testable in Node, where `ImageBitmap` doesn't exist.
export interface Closeable {
  close(): void;
}

/// Default L0 byte budget. 512 MB holds ~61 1080p RGBA frames or ~555
/// 480×480 ones — deep enough that a scrub through a typical Motif stays
/// warm, shallow enough that a worst-case 1080p Motif can't pin gigabytes
/// (the old 240-FRAME cap could: 240 × 8.3 MB ≈ 2 GB).
export const DEFAULT_MAX_BYTES = PERFORMANCE_DEFAULTS.motif_cache_mib * MIB;

/// Composite L0 map key: `${cacheKey}#${frameIndex}@${scaleDiv}`. Callers'
/// cacheKeys are JSON and may themselves contain `#` and `@`; the suffix after
/// the LAST `#` is always `<digits>@<digits>`, so distinct addresses never
/// collide. Entries carry their cacheKey, so nothing parses a key back.
///
/// `frameIndex` MUST be a non-negative integer and `scaleDiv` a reader
/// divisor: anything else would mint a key no lookup can reach — a silent
/// leak. Reject it at the boundary instead.
function frameMapKey(cacheKey: string, frameIndex: number, scaleDiv: MotifReaderDiv): string {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error(
      `MotifFrameCache: frameIndex must be a non-negative integer, got ${frameIndex}`,
    );
  }
  if (!isMotifReaderDiv(scaleDiv)) throw new Error(`MotifFrameCache: invalid divisor ${String(scaleDiv)}`);
  return `${cacheKey}#${frameIndex}@${scaleDiv}`;
}

interface Entry {
  bmp: Closeable;
  bytes: number;
  cacheKey: string;
  scaleDiv: MotifReaderDiv;
  /// A live capture (always divisor 1): it serves every divisor.
  live: boolean;
}

/// Decoded RGBA cost of one frame: width × height × 4 bytes — the resident
/// size the budget actually cares about. A test double without dims (or a
/// degenerate 0×0) falls back to a 1px cost rather than NaN-/zero-poisoning
/// the accounting.
function frameCostBytes(bmp: ImageBitmap): number {
  const bytes = bmp.width * bmp.height * 4;
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 4;
}

export class MotifFrameCache {
  /// Insertion-ordered store. JS `Map` preserves insertion order, which
  /// we exploit for LRU: the FIRST key is the least-recently-used, the
  /// LAST is the most-recent. `get` and `set` both move a touched entry
  /// to the tail (delete + re-insert) so recency stays accurate.
  private readonly store = new Map<string, Entry>();
  private readonly fixedMaxBytes: number | undefined;
  private get maxBytes(): number {
    return this.fixedMaxBytes ?? cacheBudget.ownerAllowance('motif_cache_mib', this);
  }
  /// Sum of the stored entries' `bytes` — the quantity eviction bounds.
  private bytesUsed = 0;
  /// Bound-by-a-sprite counts. A frame that leaves the store while pinned is
  /// parked in `retired` and closed on its last release: Pixi re-reads a
  /// texture's resource whenever it (re)creates the GPU copy — after its GC
  /// unloads an idle texture, or on a deferred first upload — and a closed
  /// bitmap throws "ImageBitmap has been detached" out of the render. At most
  /// one parked frame per live sprite, so the overshoot past `maxBytes` is
  /// bounded by the layer count.
  private readonly pins = new Map<object, number>();
  private readonly retired = new Set<Closeable>();
  /// Membership belongs to the cache, whose lifetime can exceed a preview
  /// service's. Late readers see existing frames without replaying events.
  /// Per cacheKey: frames at each divisor, plus `live` (also counted at 1).
  private readonly frameCounts = new Map<string, Map<MotifFrameDiv, number>>();

  constructor(maxBytes?: number) {
    // Guard against a zero/negative cap silently disabling the cache. A NaN
    // cap is especially dangerous: `bytesUsed > NaN` is always false, so
    // eviction would never fire and the cache would grow unbounded — fall back
    // to the default in that case rather than clamping NaN (Math.max(1, NaN) is
    // NaN). Non-integer caps floor to a sane bound.
    this.fixedMaxBytes = maxBytes === undefined ? undefined : Number.isFinite(maxBytes)
      ? Math.max(1, Math.floor(maxBytes))
      : DEFAULT_MAX_BYTES;
  }

  // ----------------------------------------------------------------
  // L0 — in-RAM LRU of per-frame ImageBitmaps
  // ----------------------------------------------------------------

  private changeMembership(cacheKey: string, div: MotifFrameDiv, delta: number): void {
    const counts = this.frameCounts.get(cacheKey) ?? new Map<MotifFrameDiv, number>();
    const count = (counts.get(div) ?? 0) + delta;
    if (count === 0) counts.delete(div);
    else counts.set(div, count);
    if (counts.size) this.frameCounts.set(cacheKey, counts);
    else this.frameCounts.delete(cacheKey);
  }

  /// Account an entry entering (+1) or leaving (-1) the store.
  private count(entry: Entry, delta: number): void {
    this.changeMembership(entry.cacheKey, entry.scaleDiv, delta);
    if (entry.live) this.changeMembership(entry.cacheKey, 'live', delta);
  }

  /// O(1) coverage of this content at `scaleDiv`, independent of a reader's
  /// lifetime.
  frameCount(cacheKey: string, scaleDiv: MotifReaderDiv): number {
    const counts = this.frameCounts.get(cacheKey);
    if (!counts) return 0;
    const exact = counts.get(scaleDiv) ?? 0;
    return scaleDiv === 1 ? exact : exact + (counts.get('live') ?? 0);
  }

  /// The map key that serves `(cacheKey, frameIndex)` at `scaleDiv`: only the
  /// entry at that exact divisor, or a live capture. A live capture is full
  /// size and the only size its frame comes in, so asking again at the divisor
  /// would only capture it again.
  private serving(cacheKey: string, frameIndex: number, scaleDiv: MotifReaderDiv): string | undefined {
    const exact = frameMapKey(cacheKey, frameIndex, scaleDiv);
    if (this.store.has(exact)) return exact;
    if (scaleDiv === 1) return undefined;
    const full = frameMapKey(cacheKey, frameIndex, 1);
    return this.store.get(full)?.live ? full : undefined;
  }

  /// Return the cached frame, or null on miss. A hit refreshes recency
  /// (the entry moves to the MRU end), so a frame the preview keeps
  /// hitting won't be evicted out from under it.
  getFrame(cacheKey: string, frameIndex: number, scaleDiv: MotifReaderDiv): ImageBitmap | null {
    const k = this.serving(cacheKey, frameIndex, scaleDiv);
    if (k === undefined) return null;
    const entry = this.store.get(k)!;
    // Refresh recency: delete + re-insert moves it to the tail.
    this.store.delete(k);
    this.store.set(k, entry);
    return entry.bmp as ImageBitmap;
  }

  /// Prefer cached frames in the current prewarm window over recently PLAYED
  /// frames. Playback reads make past frames recent; plain LRU would otherwise
  /// evict the unplayed near future when a farther-ahead frame arrives.
  /// Targets are highest-priority first. This only reorders existing entries:
  /// it neither allocates nor pins bitmaps, and the byte budget still applies.
  prioritizeFrames(targets: readonly { cacheKey: string; frame: number }[], scaleDiv: MotifReaderDiv): void {
    for (let i = targets.length - 1; i >= 0; i--) {
      const { cacheKey, frame } = targets[i]!;
      const key = this.serving(cacheKey, frame, scaleDiv);
      if (key === undefined) continue;
      const entry = this.store.get(key)!;
      this.store.delete(key);
      this.store.set(key, entry);
    }
  }

  /// Insert a frame, or keep the bitmap already serving this (key, frame,
  /// divisor). A live capture is stored as divisor 1. A given (cacheKey,
  /// frameIndex) is deterministic — same motif, props,
  /// size, fps, content-duration and absolute content frame — so a concurrent
  /// re-raster (e.g. several same-config motif layers cold-missing on
  /// project reopen) produces an IDENTICAL image. Keep the existing bitmap (a
  /// live sprite may have already bound it) and close the redundant incoming
  /// one; return the CANONICAL cache-owned bitmap the caller should bind. This
  /// makes the write idempotent so a sibling sprite never has its bound bitmap
  /// closed out from under it (which caused "External Image has been detached"
  /// on WebGPU upload). When the store exceeds `maxBytes`, LRU frames are
  /// evicted and `.close()`d (deferred while retained — see `retain`).
  ///
  /// @returns The canonical cache-owned bitmap for this (cacheKey, frameIndex,
  ///   divisor): `bmp` itself on first insert, or the EXISTING (possibly
  ///   already-bound) bitmap on a re-set (in which case `bmp` has been closed).
  setFrame(cacheKey: string, frameIndex: number, scaleDiv: MotifFrameDiv, bmp: ImageBitmap): ImageBitmap {
    const live = scaleDiv === 'live';
    const div = live ? 1 : scaleDiv;
    const k = this.serving(cacheKey, frameIndex, div);
    if (k !== undefined) {
      const prev = this.store.get(k)!;
      // Keep the existing (possibly already-bound) bitmap; drop the redundant
      // incoming one. Refresh recency by re-inserting at the MRU tail. Bytes
      // don't change: the serving entry holds the same frame at this size.
      // A live re-set marks a full-size read live: the frame is not stored.
      if (prev.bmp !== (bmp as unknown as Closeable)) this.retire(bmp);
      if (live && !prev.live) { prev.live = true; this.changeMembership(cacheKey, 'live', +1); }
      this.store.delete(k);
      this.store.set(k, prev);
      return prev.bmp as unknown as ImageBitmap;
    }
    const entry: Entry = { bmp: bmp as unknown as Closeable, bytes: frameCostBytes(bmp), cacheKey, scaleDiv: div, live };
    this.store.set(frameMapKey(cacheKey, frameIndex, div), entry);
    this.bytesUsed += entry.bytes;
    this.count(entry, +1);
    this.evictToCapacity();
    return bmp;
  }

  /// Evict LRU entries until the store fits the byte budget, closing each.
  /// One frame always stays (the store keeps at least the most-recent entry):
  /// a frame larger than the whole budget is the frame on screen RIGHT NOW —
  /// evicting it at insert would close the bitmap out from under the caller
  /// that is about to bind it. It leaves on the NEXT insert instead.
  private evictToCapacity(): void {
    while (this.bytesUsed > this.maxBytes && this.store.size > 1) {
      // The first key in insertion order is the LRU victim.
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      const victim = this.store.get(oldest.value);
      this.store.delete(oldest.value);
      if (victim) {
        this.bytesUsed -= victim.bytes;
        this.retire(victim.bmp);
        this.count(victim, -1);
      }
    }
    this.reportUsage();
  }

  private reportUsage(): void {
    if (this.fixedMaxBytes !== undefined) return;
    cacheBudget.update(this, 'motif_cache_mib', this.bytesUsed + [...this.retired].reduce((sum, bmp) =>
      sum + frameCostBytes(bmp as ImageBitmap), 0), () => this.evictToCapacity());
  }

  /// A frame leaving the store: closed now, or — while a sprite still has it
  /// bound — on that sprite's last `release`.
  private retire(bmp: Closeable): void {
    if (this.pins.has(bmp)) this.retired.add(bmp);
    else bmp.close();
  }

  /// Pin a bitmap a sprite has bound, so eviction cannot close it under the
  /// sprite. Safe on anything — a placeholder canvas or an export-injected
  /// frame the cache never held is counted but never closed by the cache.
  retain(bmp: object): void {
    this.pins.set(bmp, (this.pins.get(bmp) ?? 0) + 1);
  }

  /// Drop one pin. The last release of a frame that already left the store
  /// closes it; a frame still in the store stays cached. An unmatched release
  /// is a no-op.
  release(bmp: object): void {
    const n = this.pins.get(bmp);
    if (n === undefined) return;
    if (n > 1) {
      this.pins.set(bmp, n - 1);
      return;
    }
    this.pins.delete(bmp);
    const parked = bmp as Closeable;
    if (this.retired.delete(parked)) parked.close();
    this.reportUsage();
  }

  /// True when (cacheKey, frameIndex) is held at `scaleDiv`, WITHOUT touching
  /// recency (unlike getFrame). The prewarmer uses this to skip already-cached
  /// targets so a peek can't reorder the LRU.
  hasFrame(cacheKey: string, frameIndex: number, scaleDiv: MotifReaderDiv): boolean {
    return this.serving(cacheKey, frameIndex, scaleDiv) !== undefined;
  }

  /// The byte budget (the prewarmer scales its warm plan against it).
  capacityBytes(): number {
    return this.maxBytes;
  }

  /// True when at least one frame of `cacheKey` is currently held, at any
  /// divisor.
  hasKey(cacheKey: string): boolean {
    return this.frameCounts.has(cacheKey);
  }

  /// Drop every frame of `cacheKey` at every divisor, closing each bitmap.
  /// No-op when the key isn't present.
  clearKey(cacheKey: string): void {
    for (const [k, entry] of Array.from(this.store)) {
      if (entry.cacheKey !== cacheKey) continue;
      this.store.delete(k);
      this.bytesUsed -= entry.bytes;
      this.retire(entry.bmp);
      this.count(entry, -1);
    }
    this.reportUsage();
  }

  /// Drop EVERY frame, closing each (deferred while pinned — same retire
  /// path as eviction/clearKey, so a sprite's bound bitmap is never closed
  /// under it). Used by transient-lane wipes and e2e pressure, where the
  /// point is "everything leaves the cache", not a full `dispose` (which
  /// also force-closes parked frames and clears the pin table).
  clearAll(): void {
    for (const entry of this.store.values()) this.retire(entry.bmp);
    this.store.clear();
    this.bytesUsed = 0;
    this.frameCounts.clear();
    this.reportUsage();
  }

  /// Close every held bitmap — parked ones included — and empty the store.
  /// Call on teardown.
  dispose(): void {
    for (const entry of this.store.values()) entry.bmp.close();
    for (const bmp of this.retired) bmp.close();
    this.store.clear();
    this.bytesUsed = 0;
    this.retired.clear();
    this.pins.clear();
    this.frameCounts.clear();
    cacheBudget.release(this);
  }

  /// Frames currently held across all keys, for diagnostics.
  size(): number {
    return this.store.size;
  }

  // ----------------------------------------------------------------
  // L2 — opt-in zstd frame sequence on disk
  //
  // Layout: `<workspace>/Cache/raster/<hash>/<i>.wfrm`, where `<hash>` is
  // `hashCacheKey(cacheKey)` (32 lowercase hex chars). Main owns the
  // directory — writes, inventory and collection of unreferenced dirs live in
  // `MotifFrameStore` (src/main/motif/frameStore.ts). This side only reads
  // and forwards writes; both load their bridge lazily so the L0 path stays
  // Node-loadable for the unit test.
  // ----------------------------------------------------------------

  /// A stored frame at `scaleDiv`, through the document's `MotifFrameReader`
  /// (ADR 0154); null when it is not stored or is invalid. A transport failure
  /// throws `MotifTransportError`: it is not a miss. No window (the export
  /// Worker, node tests) has no reader and reads nothing.
  async readBitmap(cacheKey: string, frameIndex: number, scaleDiv: MotifReaderDiv, options: MotifReadOptions = {}): Promise<ImageBitmap | null> {
    if (typeof window === "undefined") return null;
    const { motifFrameReader } = await import("./MotifFrameReader");
    return motifFrameReader().read(cacheKey, frameIndex, scaleDiv, options);
  }

  /// Encode a PNG capture into the frame cache, creating the `<hash>` dir as needed. No-op when
  /// no project is open (nowhere to anchor `<workspace>/Cache/`).
  async writeFrame(cacheKey: string, frameIndex: number, png: Blob): Promise<void> {
    if (typeof window === "undefined") return;
    const { invoke } = await import("@/bridge/ipc");
    const bytes = new Uint8Array(await png.arrayBuffer());
    await invoke<void>("motif_write_cached_frame", { hash: hashCacheKey(cacheKey), frame: frameIndex, png: bytes });
  }
}

export { hashCacheKey } from "../../../shared/motifs/cacheKey";
