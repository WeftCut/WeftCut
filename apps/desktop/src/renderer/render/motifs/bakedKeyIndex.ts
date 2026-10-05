import { hashCacheKey } from "./frameCache";

/// Tracks which motif cacheKeys have at least one frame baked on disk, so
/// the read path can skip a per-frame `exists` IPC for never-baked content.
/// Membership is by RAW cacheKey; on-disk dirs are named by `hashCacheKey`,
/// so `hydrateFromHashes` maps a set of live cacheKeys onto the dir names a
/// `readDir(Cache/raster)` returned.
export class BakedKeyIndex {
  constructor(private readonly onChange: () => void = () => {}) {}
  private keys = new Set<string>();
  private frames = new Map<string, Set<number>>();
  /// A successful write proves one frame, not that the directory was scanned.
  private enumerated = new Set<string>();
  private prefixes = new Map<string, number>();
  private hydration: Promise<void> = Promise.resolve();
  private releaseHydration: (() => void) | null = null;

  beginHydration(): void {
    if (!this.releaseHydration) {
      this.hydration = new Promise((resolve) => { this.releaseHydration = resolve; });
    }
  }

  finishHydration(): void {
    this.releaseHydration?.();
    this.releaseHydration = null;
  }

  async whenHydrated(): Promise<void> {
    // A new snapshot can begin discovery in the microtask that wakes a reader.
    while (this.releaseHydration) await this.hydration;
  }

  framesFor(cacheKey: string): ReadonlySet<number> | undefined {
    return this.enumerated.has(cacheKey) ? this.frames.get(cacheKey) : undefined;
  }

  /// Unknown coverage may still warrant a disk probe; known holes do not.
  hasFrame(cacheKey: string, frame: number): boolean | undefined {
    if (this.frames.get(cacheKey)?.has(frame)) return true;
    return this.enumerated.has(cacheKey) || !this.keys.has(cacheKey) ? false : undefined;
  }

  forgetFrame(cacheKey: string, frame: number): void {
    this.frames.get(cacheKey)?.delete(frame);
    this.prefixes.set(cacheKey, Math.min(this.prefixes.get(cacheKey) ?? 0, frame));
    this.onChange();
  }

  isComplete(cacheKey: string, total: number): boolean {
    return total > 0 && (this.prefixes.get(cacheKey) ?? 0) >= total;
  }

  restoreFrames(cacheKey: string, frames: ReadonlySet<number>): void {
    const merged = new Set([...frames, ...(this.frames.get(cacheKey) ?? [])]);
    this.frames.set(cacheKey, merged);
    this.enumerated.add(cacheKey);
    if (merged.size) this.keys.add(cacheKey);
    let prefix = 0;
    while (merged.has(prefix)) prefix++;
    this.prefixes.set(cacheKey, prefix);
    this.onChange();
  }
  /// The set of cacheKeys the caller considers "live" this project (active
  /// motif layers). Set by the Compositor before `hydrateFromHashes`.
  private liveCandidates: string[] = [];

  has(cacheKey: string): boolean {
    return this.keys.has(cacheKey);
  }

  /// Mark a cacheKey baked (called after a successful `writeFrame`).
  add(cacheKey: string, frame?: number): void {
    this.keys.add(cacheKey);
    if (frame !== undefined) {
      let frames = this.frames.get(cacheKey);
      if (!frames) this.frames.set(cacheKey, frames = new Set());
      frames.add(frame);
      let prefix = this.prefixes.get(cacheKey) ?? 0;
      while (frames.has(prefix)) prefix++;
      this.prefixes.set(cacheKey, prefix);
    }
    this.onChange();
  }

  clear(): void {
    this.keys.clear();
    this.frames.clear();
    this.enumerated.clear();
    this.prefixes.clear();
    this.liveCandidates = [];
    this.finishHydration();
  }

  /// Tell the index which cacheKeys are live this project (you can't reverse a
  /// hash, so hydration recomputes membership against these).
  setLiveCandidates(keys: string[]): void {
    this.liveCandidates = keys;
  }

  /// Replace the set: of the live candidates, keep those whose `hashCacheKey`
  /// is among the dir names found on disk. `hashOf` is injected for
  /// testability (defaults to the real `hashCacheKey`). A baked dir with no
  /// live key is an orphan GC reclaims; it never needs to be in this index.
  hydrateFromHashes(
    diskHashes: Set<string>,
    hashOf: (cacheKey: string) => string = hashCacheKey,
  ): void {
    this.keys.clear();
    for (const key of this.frames.keys()) {
      if (!diskHashes.has(hashOf(key))) {
        this.frames.delete(key);
        this.enumerated.delete(key);
        this.prefixes.delete(key);
      }
    }
    for (const k of this.liveCandidates) {
      if (diskHashes.has(hashOf(k))) this.keys.add(k);
    }
  }
}
