export interface PrewarmContent {
  cacheKey: string;
  /// Content frame at the current playhead (0-based; clamped to the content).
  contentFrame: number;
  contentDurationFrames: number;
  /// Decoded RGBA bytes per frame of this content (renderW × renderH × 4) —
  /// what one warmed frame costs the byte-bounded L0 cache. The plan budget
  /// is in bytes, so a 480×480 Motif warms ~9× more frames than a 1080p one
  /// while both stay within the same memory bound.
  frameBytes: number;
}

export interface PrewarmTarget {
  cacheKey: string;
  frame: number;
}

/// Plan which (cacheKey, frame) to ensure cached, in priority order. Dedups
/// contents by cacheKey; each unique content gets a per-content budget of
/// floor(capBytes / uniqueContentCount / frameBytes) FRAMES (>= 1), or the
/// WHOLE content when it fits. Per content the order is playhead-first:
/// contentFrame, then forward to the budget edge, then the earlier frames
/// (backfill for small backward scrubs). Contents are ROUND-ROBINED so one
/// long content can't starve others. The union's total byte cost never
/// exceeds `capBytes`, so the cache LRU can't evict a still-targeted frame.
export function planPrewarmTargets(
  contents: PrewarmContent[],
  capBytes: number,
): PrewarmTarget[] {
  const seen = new Set<string>();
  const uniq: PrewarmContent[] = [];
  for (const c of contents) {
    if (seen.has(c.cacheKey)) continue;
    seen.add(c.cacheKey);
    uniq.push(c);
  }
  if (uniq.length === 0) return [];
  const perContent: number[][] = uniq.map((c) => {
    const n = c.contentDurationFrames;
    // A degenerate 0 frameBytes must not divide-by-zero into Infinity.
    const budget = Math.max(1, Math.floor(capBytes / (uniq.length * Math.max(1, c.frameBytes))));
    const want = Math.min(budget, n);
    const start = Math.max(0, Math.min(c.contentFrame, n - 1));
    const order: number[] = [];
    for (let f = start; f < n && order.length < want; f++) order.push(f);   // current → forward
    for (let f = 0; f < start && order.length < want; f++) order.push(f);   // backfill earlier
    return order;
  });

  const out: PrewarmTarget[] = [];
  const maxLen = perContent.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (let c = 0; c < uniq.length; c++) {
      const frames = perContent[c]!;
      if (i < frames.length) out.push({ cacheKey: uniq[c]!.cacheKey, frame: frames[i]! });
    }
  }
  return out;
}
