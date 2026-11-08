/// Tracks which motif cacheKeys have at least one frame baked on disk, so
/// the read path can skip a per-frame disk probe for never-baked content.
/// Membership is by RAW cacheKey, never by the on-disk `<hash>` dir name.
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

  has(cacheKey: string): boolean {
    return this.keys.has(cacheKey);
  }

  /// Mark a cacheKey baked (called once main reports the frame stored).
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
    this.finishHydration();
  }
}
