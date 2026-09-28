// Per-frame raster cache for animated motifs.
//
// A motif animates over its duration: each composition frame is a distinct
// CDP capture decoded to an `ImageBitmap`. This cache holds a SEQUENCE of
// frames per motif instance, keyed by `(cacheKey, frameIndex)` — distinct
// from a single-bitmap-per-motif cache.
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
//   L2 (opt-in, lighter) — a PNG frame sequence persisted to disk
//   under `<workspace>/Cache/raster/<hash>/<i>.png`. Driven by a global
//   "Pre-bake" setting and a per-layer "Pre-bake now" action; read on the
//   default preview path via `resolveMotifFrame` (disk-first, gated by
//   an in-RAM baked-key index). The `MotifBaker` is the sole writer.
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
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/// Composite L0 map key. `frameIndex` is appended after a `#`; callers'
/// cacheKeys are JSON and may themselves contain `#`, so any code that
/// splits a key back into `(cacheKey, frameIndex)` must anchor on the
/// LAST `#` and require an all-digit suffix — see `keyMatchesCacheKey`.
///
/// `frameIndex` MUST be a non-negative integer: a negative or fractional
/// index would stringify to a non-digit suffix (`#-1`, `#1.5`) that
/// `keyMatchesCacheKey` rejects, so the entry would be unreachable by
/// `hasKey`/`clearKey` — a silent leak. Reject it at the boundary instead.
function frameMapKey(cacheKey: string, frameIndex: number): string {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error(
      `MotifFrameCache: frameIndex must be a non-negative integer, got ${frameIndex}`,
    );
  }
  return `${cacheKey}#${frameIndex}`;
}

/// True when `mapKey` is a frame of `cacheKey`. Guards against the
/// prefix-collision hazard: cacheKey "a" must NOT match "a#b"'s frame
/// "a#b#5". We require `mapKey === cacheKey + "#" + <digits>`, i.e. the
/// `#` we split on is the LAST one and everything after it is a frame
/// index. (cacheKeys can contain `#`; frame indices are always digits.)
function keyMatchesCacheKey(mapKey: string, cacheKey: string): boolean {
  const hashAt = mapKey.lastIndexOf("#");
  if (hashAt < 0) return false;
  if (mapKey.slice(0, hashAt) !== cacheKey) return false;
  const suffix = mapKey.slice(hashAt + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

/// Recover the cacheKey from a composite map key: everything before the LAST
/// `#` (the all-digits frame-index suffix is guaranteed by `frameMapKey`).
/// Used where membership events must name the key but only the composite is
/// at hand (eviction, clearAll).
function cacheKeyOf(mapKey: string): string {
  return mapKey.slice(0, mapKey.lastIndexOf("#"));
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
  private readonly store = new Map<string, { bmp: Closeable; bytes: number }>();
  private readonly maxBytes: number;
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
  /// Fired SYNCHRONOUSLY when a (cacheKey, frame) ENTERS the store (+1) or
  /// LEAVES it (−1): new insert, eviction, clearKey, clearAll. The idempotent
  /// re-set of an existing (key, frame) fires NOTHING (no membership change);
  /// pins/retirement don't fire either — the signal mirrors what `hasFrame`
  /// reads, so a subscriber can keep an exact per-key frame count. Re-entrancy
  /// contract: a listener must not call back into the cache — events fire
  /// mid-mutation. `dispose` fires nothing (terminal teardown; listeners are
  /// expected gone).
  private readonly membershipListeners = new Set<(cacheKey: string, delta: number) => void>();

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    // Guard against a zero/negative cap silently disabling the cache. A NaN
    // cap is especially dangerous: `bytesUsed > NaN` is always false, so
    // eviction would never fire and the cache would grow unbounded — fall back
    // to the default in that case rather than clamping NaN (Math.max(1, NaN) is
    // NaN). Non-integer caps floor to a sane bound.
    this.maxBytes = Number.isFinite(maxBytes)
      ? Math.max(1, Math.floor(maxBytes))
      : DEFAULT_MAX_BYTES;
  }

  // ----------------------------------------------------------------
  // L0 — in-RAM LRU of per-frame ImageBitmaps
  // ----------------------------------------------------------------

  /// Subscribe to store-membership changes (see `membershipListeners`).
  /// Returns an unsubscribe fn. Only the COMMITTED-content lane
  /// (`sharedMotifFrameCache`) gets a subscriber — the MotifFrameService's
  /// bake-status coverage counters; the transient overlay lane never does.
  onMembershipChange(listener: (cacheKey: string, delta: number) => void): () => void {
    this.membershipListeners.add(listener);
    return () => {
      this.membershipListeners.delete(listener);
    };
  }

  private emitMembership(cacheKey: string, delta: number): void {
    for (const l of this.membershipListeners) l(cacheKey, delta);
  }

  /// Return the cached frame, or null on miss. A hit refreshes recency
  /// (the entry moves to the MRU end), so a frame the preview keeps
  /// hitting won't be evicted out from under it.
  getFrame(cacheKey: string, frameIndex: number): ImageBitmap | null {
    const k = frameMapKey(cacheKey, frameIndex);
    const entry = this.store.get(k);
    if (entry === undefined) return null;
    // Refresh recency: delete + re-insert moves it to the tail.
    this.store.delete(k);
    this.store.set(k, entry);
    return entry.bmp as ImageBitmap;
  }

  /// Insert a frame, or keep the bitmap already cached for this (key, frame).
  /// A given (cacheKey, frameIndex) is deterministic — same motif, props,
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
  /// @returns The canonical cache-owned bitmap for this (cacheKey, frameIndex):
  ///   `bmp` itself on first insert, or the EXISTING (possibly already-bound)
  ///   bitmap on a same-(key,frame) re-set (in which case `bmp` has been closed).
  setFrame(cacheKey: string, frameIndex: number, bmp: ImageBitmap): ImageBitmap {
    const k = frameMapKey(cacheKey, frameIndex);
    const prev = this.store.get(k);
    if (prev !== undefined) {
      // Keep the existing (possibly already-bound) bitmap; drop the redundant
      // incoming one. Refresh recency by re-inserting at the MRU tail. Bytes
      // don't change: a given (key, frame) is deterministic, so the incoming
      // bitmap's dims equal the stored one's. No membership event: the
      // (key, frame) was already in the store.
      if (prev.bmp !== (bmp as unknown as Closeable)) this.retire(bmp);
      this.store.delete(k);
      this.store.set(k, prev);
      return prev.bmp as unknown as ImageBitmap;
    }
    const bytes = frameCostBytes(bmp);
    this.store.set(k, { bmp: bmp as unknown as Closeable, bytes });
    this.bytesUsed += bytes;
    this.emitMembership(cacheKey, +1);
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
        this.emitMembership(cacheKeyOf(oldest.value), -1);
      }
    }
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
  }

  /// True when (cacheKey, frameIndex) is held, WITHOUT touching recency (unlike
  /// getFrame). The prewarmer uses this to skip already-cached targets so a peek
  /// can't reorder the LRU.
  hasFrame(cacheKey: string, frameIndex: number): boolean {
    return this.store.has(frameMapKey(cacheKey, frameIndex));
  }

  /// The byte budget (the prewarmer scales its warm plan against it).
  capacityBytes(): number {
    return this.maxBytes;
  }

  /// True when at least one frame of `cacheKey` is currently held.
  hasKey(cacheKey: string): boolean {
    for (const k of this.store.keys()) {
      if (keyMatchesCacheKey(k, cacheKey)) return true;
    }
    return false;
  }

  /// Drop every frame of `cacheKey`, closing each bitmap. No-op when the
  /// key isn't present.
  clearKey(cacheKey: string): void {
    for (const k of Array.from(this.store.keys())) {
      if (keyMatchesCacheKey(k, cacheKey)) {
        const entry = this.store.get(k);
        this.store.delete(k);
        if (entry) {
          this.bytesUsed -= entry.bytes;
          this.retire(entry.bmp);
          this.emitMembership(cacheKey, -1);
        }
      }
    }
  }

  /// Drop EVERY frame, closing each (deferred while pinned — same retire
  /// path as eviction/clearKey, so a sprite's bound bitmap is never closed
  /// under it). Used by transient-lane wipes and e2e pressure, where the
  /// point is "everything leaves the cache", not a full `dispose` (which
  /// also force-closes parked frames and clears the pin table).
  clearAll(): void {
    for (const entry of this.store.values()) this.retire(entry.bmp);
    const removedKeys = [...this.store.keys()];
    this.store.clear();
    this.bytesUsed = 0;
    // Emit after the store is empty, so a listener observing mid-callback
    // (e.g. re-reading `hasFrame`) sees the post-clear state.
    for (const k of removedKeys) this.emitMembership(cacheKeyOf(k), -1);
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
  }

  /// Frames currently held across all keys, for diagnostics.
  size(): number {
    return this.store.size;
  }

  // ----------------------------------------------------------------
  // L2 — opt-in PNG frame sequence on disk
  //
  // Layout: `<workspace>/Cache/raster/<hash>/<i>.png`, where `<hash>` is
  // a stable 128-bit hash of `cacheKey` (32 lowercase hex chars — see
  // `hashCacheKey`).
  //
  // MIGRATION: the hash was FNV-1a 32-bit (8 hex chars) before the Phase-4
  // hardening. Workspaces from before carry `<hash>` dirs in the OLD format;
  // no live key hashes to them anymore, so the next `gcUnreferenced` reclaims
  // them (it removes every dir not in the live set — there is no name-format
  // filter to skip them) and the frames re-bake on demand. Regenerable cache,
  // so the loss is acceptable.
  //
  // Disk I/O goes through `@/bridge/fs` (`window.api.fs.*` → the Electron main
  // process), so `mkdir`/`writeFile`/`readDir`/`remove`/`exists` against
  // `<workspace>/Cache/raster/...` work whenever a project is open; there is no
  // capability gating. The methods run against the real fs: a genuine not-found
  // yields null/no-op, but an unexpected IO error surfaces as a thrown error
  // rather than being masked. The fs-bridge imports are loaded lazily so the L0
  // path never pulls the bridge — keeps `frameCache.ts` Node-loadable for the
  // unit test.
  // ----------------------------------------------------------------

  /// Read a persisted PNG frame, or null if it isn't on disk (or no
  /// project is open). Permission / IO errors other than not-found
  /// propagate.
  async readPng(cacheKey: string, frameIndex: number): Promise<Blob | null> {
    const dir = await rasterDirFor(cacheKey);
    if (dir === null) return null;
    const [{ join }, { readFile, exists }] = await Promise.all([
      import("@/bridge/path"),
      import("@/bridge/fs"),
    ]);
    const path = await join(dir, `${frameIndex}.png`);
    if (!(await exists(path))) return null;
    const bytes = await readFile(path);
    return new Blob([bytes], { type: "image/png" });
  }

  /// True if the PNG for (cacheKey, frameIndex) exists on disk. Cheaper than
  /// `readPng` (no byte read) — the baker uses it to skip already-baked frames.
  /// Null project / not-found → false; permission errors propagate.
  async hasPng(cacheKey: string, frameIndex: number): Promise<boolean> {
    const dir = await rasterDirFor(cacheKey);
    if (dir === null) return false;
    const [{ join }, { exists }] = await Promise.all([
      import("@/bridge/path"),
      import("@/bridge/fs"),
    ]);
    const path = await join(dir, `${frameIndex}.png`);
    return exists(path);
  }

  /// Persist a PNG frame, creating the `<hash>` dir as needed. No-op when
  /// no project is open (nowhere to anchor `<workspace>/Cache/`).
  async writePng(cacheKey: string, frameIndex: number, png: Blob): Promise<void> {
    const dir = await rasterDirFor(cacheKey);
    if (dir === null) return;
    const [{ join }, { mkdir, writeFile }] = await Promise.all([
      import("@/bridge/path"),
      import("@/bridge/fs"),
    ]);
    await mkdir(dir, { recursive: true });
    const path = await join(dir, `${frameIndex}.png`);
    const bytes = new Uint8Array(await png.arrayBuffer());
    await writeFile(path, bytes);
  }

  /// Prune `Cache/raster/<hash>` dirs whose hash isn't referenced by any
  /// currently-active cacheKey. Used to reclaim disk after layers are
  /// deleted or their props/dims change (a new key → a new hash dir, the
  /// old one becomes unreferenced). A missing `Cache/raster` is treated
  /// as nothing-to-GC, not an error.
  async gcUnreferenced(activeCacheKeys: string[]): Promise<void> {
    const root = await rasterRootDir();
    if (root === null) return;
    const [{ readDir, remove, exists }, { join }] = await Promise.all([
      import("@/bridge/fs"),
      import("@/bridge/path"),
    ]);
    if (!(await exists(root))) return;
    const live = new Set(activeCacheKeys.map(hashCacheKey));
    const entries = await readDir(root);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (live.has(entry.name)) continue;
      const dir = await join(root, entry.name);
      await remove(dir, { recursive: true });
    }
  }

  /// The set of `<hash>` dir names currently under `Cache/raster`. Empty when
  /// no project is open or the dir doesn't exist. Used to hydrate the
  /// in-RAM baked-key index on project load.
  async listBakedHashes(): Promise<Set<string>> {
    const root = await rasterRootDir();
    if (root === null) return new Set();
    const { readDir, exists } = await import("@/bridge/fs");
    if (!(await exists(root))) return new Set();
    const entries = await readDir(root);
    const out = new Set<string>();
    for (const e of entries) if (e.isDirectory) out.add(e.name);
    return out;
  }
}

/// `<workspace>/Cache/raster`, or null when no project is open — or when the
/// L2 bridge is unreachable off the main renderer thread.
///
/// Every L2 disk op funnels through here, and reaching the workspace root goes
/// `workspaceDir()` → `invoke()` → `window.api.backend` — the main-process IPC
/// bridge. The export Compositor runs in a Worker (`worker/exportWorker.ts`),
/// where `window` is undefined and no such bridge exists, so the whole L2 layer
/// is unreachable there. Return null (every caller no-ops on a null root)
/// instead of letting the bare `window` reference throw
/// `ReferenceError: window is not defined` — which `hydrateBakedIndexAndGc`
/// swallowed but logged as a scary warning on every export setProject.
async function rasterRootDir(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const { workspaceDir } = await import("../../ipc");
  const ws = await workspaceDir();
  if (!ws) return null;
  const { join } = await import("@/bridge/path");
  return join(ws, "Cache", "raster");
}

/// `<workspace>/Cache/raster/<hash(cacheKey)>`, or null when no project
/// is open.
async function rasterDirFor(cacheKey: string): Promise<string | null> {
  const root = await rasterRootDir();
  if (root === null) return null;
  const { join } = await import("@/bridge/path");
  return join(root, hashCacheKey(cacheKey));
}

/// Stable hash of a cacheKey for use as an on-disk directory name.
///
/// Two independent FNV-1a 64-bit lanes (different offset bases), each
/// rendered as 16 zero-padded lowercase hex chars and concatenated — a
/// 128-bit hash, dependency-free and synchronous (this feeds per-frame
/// disk paths, so an async crypto/blake3 digest is off the table). The
/// input is hashed as its UTF-16LE byte stream (low byte, then high byte,
/// per code unit), so non-ASCII prop values (e.g. zh-CN) mix fully.
/// The dir name is JS-owned (`Cache/raster/` is not created by the Rust
/// `CacheLayout`), so it does NOT need to match Rust's blake3 scheme.
///
/// Why 128 bits: a collision is NOT self-healing — two colliding keys share
/// the `<hash>` dir and their frame `<i>.png` files would CLOBBER each other,
/// since `0.png` means frame 0 of WHICHEVER key wrote last. With the handful
/// of live keys a workspace ever has, the birthday bound against a 2^128
/// space (≈2^64 keys to a 50% collision) is negligible; the old 32-bit space
/// (≈2^16 keys to 50%) was only "probably fine" and one bad roll silently
/// corrupted two Motifs' baked frames.
export function hashCacheKey(cacheKey: string): string {
  return fnv1a64Hex(cacheKey, 0xcbf29ce484222325n) + fnv1a64Hex(cacheKey, 0x9e3779b97f4a7c15n);
}

const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/// One FNV-1a 64-bit lane over the UTF-16LE byte stream of `s`, from the
/// given offset basis, rendered as 16 zero-padded lowercase hex chars.
function fnv1a64Hex(s: string, offset: bigint): string {
  let h = offset;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    h = ((h ^ BigInt(unit & 0xff)) * FNV64_PRIME) & MASK64;
    h = ((h ^ BigInt(unit >>> 8)) * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}
