import { describe, expect, it, vi } from "vitest";
import { createCacheBudget } from "../render/cacheBudget";
import { MediaPosterCache } from "./mediaPosterCache";

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(limit = 20) {
  const budget = createCacheBudget(() => ({ frame_ring_mib: 0, motif_cache_mib: 0, waveform_cache_mib: 0, filmstrip_cache_mib: limit }), () => true);
  const fetch = vi.fn(async (id: string) => id.repeat(5));
  const cache = new MediaPosterCache(fetch, budget);
  cache.reconcile(new Map([['a', 'path-a'], ['b', 'path-b'], ['c', 'path-c']]));
  return { cache, fetch, budget };
}

describe("media poster retention", () => {
  it("charges string bytes, reuses mounted/hidden reads and evicts least recent hidden posters", async () => {
    const { cache, fetch, budget } = fixture();
    for (const id of ['a', 'b']) { const off = cache.subscribe(id, () => {}); await settle(); off(); }
    expect(budget.snapshot().total).toBe(20);
    expect(cache.get('a')).toBe('aaaaa');
    const off = cache.subscribe('c', () => {});
    await settle(); off();
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe('aaaaa');
    const reuse = cache.subscribe('a', () => {}); await settle(); reuse();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(budget.snapshot().total).toBe(20);
  });

  it("does not fetch job completions for unobserved media", async () => {
    const { cache, fetch } = fixture();
    cache.completed('a'); await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops old project completions and releases their budget", async () => {
    const { cache, fetch, budget } = fixture();
    let resolve!: (value: string) => void;
    fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const off = cache.subscribe('a', () => {});
    cache.reconcile(new Map([['a', 'replacement-path']]));
    off();
    const replacement = cache.subscribe('a', () => {});
    await settle();
    resolve('old-project'); await settle();
    expect(cache.get('a')).toBe('aaaaa');
    cache.reconcile(new Map()); replacement();
    expect(budget.snapshot().total).toBe(0);
  });

  it("does not revive an in-flight read after its final consumer leaves", async () => {
    const { cache, fetch, budget } = fixture();
    let resolve!: (value: string) => void;
    fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const off = cache.subscribe('a', () => {}); off();
    resolve('stale'); await settle();
    expect(cache.get('a')).toBeNull();
    cache.completed('a'); await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().total).toBe(0);
  });
});
