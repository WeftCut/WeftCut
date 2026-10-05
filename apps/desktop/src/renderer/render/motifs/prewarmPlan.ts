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
  /// Keep recently passed frames eligible for a late prewarm completion.
  historyFrames?: number;
}

export interface PrewarmTarget {
  cacheKey: string;
  frame: number;
}

/// Share the byte budget across content identities, then round-robin both
/// contents and their instance windows. Repeated Group instances can need
/// different frames of the same content without paying twice for shared ones.
export function planPrewarmTargets(
  contents: PrewarmContent[],
  capBytes: number,
): PrewarmTarget[] {
  const groups = new Map<string, PrewarmContent[]>();
  for (const c of contents) {
    const windows = groups.get(c.cacheKey) ?? [];
    if (!windows.some(w => w.contentFrame === c.contentFrame)) windows.push(c);
    groups.set(c.cacheKey, windows);
  }
  const keys = [...groups.keys()];
  const perContent = [...groups.values()].map(windows => {
    const frameBytes = Math.max(1, ...windows.map(c => c.frameBytes));
    const budget = Math.max(0, Math.floor(capBytes / (keys.length * frameBytes)));
    const orders = windows.map(c => {
      const n = c.contentDurationFrames;
      const want = Math.min(budget, n);
      const start = Math.max(0, Math.min(c.contentFrame, n - 1));
      const history = Math.min(c.historyFrames ?? 0, start, Math.max(0, want - 1));
      const order: number[] = [];
      for (let f = start; f < n && order.length < want - history; f++) order.push(f);
      for (let f = start - 1; f >= start - history && order.length < want; f--) order.push(f);
      for (let f = 0; f < start && order.length < want; f++) {
        if (f < start - history) order.push(f);
      }
      return order;
    });
    const frames = new Set<number>();
    const depth = Math.max(0, ...orders.map(a => a.length));
    for (let i = 0; i < depth && frames.size < budget; i++) {
      for (const order of orders) {
        if (i < order.length && frames.size < budget) frames.add(order[i]!);
      }
    }
    return [...frames];
  });

  const out: PrewarmTarget[] = [];
  const maxLen = perContent.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (let c = 0; c < keys.length; c++) {
      const frames = perContent[c]!;
      if (i < frames.length) out.push({ cacheKey: keys[c]!, frame: frames[i]! });
    }
  }
  return out;
}
