import { expect, it } from 'vitest';
import { createCacheBudget } from './cacheBudget';

const base = () => ({ frame_ring_mib: 60, motif_cache_mib: 30, filmstrip_cache_mib: 8, waveform_cache_mib: 2 });

it('lends idle shares and reclaims a borrower when another cache needs its share', () => {
  const budget = createCacheBudget(base, () => true);
  const video = {}, animation = {};
  let animationBytes = 90;
  const trim = () => {
    animationBytes = Math.min(animationBytes, budget.ownerAllowance('motif_cache_mib', animation));
    budget.update(animation, 'motif_cache_mib', animationBytes, trim);
  };
  budget.update(animation, 'motif_cache_mib', animationBytes, trim);
  expect(budget.allowance('motif_cache_mib')).toBe(100);
  budget.update(video, 'frame_ring_mib', 60);
  expect(animationBytes).toBe(40);
  expect(budget.snapshot().total).toBe(100);
  budget.release(video);
  expect(budget.allowance('motif_cache_mib')).toBe(100);
});

it('preserves pinned frames and exposes temporary overshoot without forced eviction', () => {
  const budget = createCacheBudget(base, () => true);
  const video = {}, pinned = {};
  budget.update(video, 'frame_ring_mib', 90);
  budget.update(pinned, 'motif_cache_mib', 40, () => {});
  expect(budget.snapshot().total).toBe(130);
  expect(budget.allowance('frame_ring_mib')).toBe(60);
  budget.release(pinned);
  expect(budget.snapshot().total).toBe(90);
});

it('retains legacy fixed shares and rebalances after a live budget reduction', () => {
  let enabled = false, cap = 100;
  const budget = createCacheBudget(() => ({ ...base(), frame_ring_mib: cap - 40 }), () => enabled);
  const owner = {};
  let bytes = 90;
  const trim = () => { bytes = Math.min(bytes, budget.allowance('motif_cache_mib')); budget.update(owner, 'motif_cache_mib', bytes, trim); };
  budget.update(owner, 'motif_cache_mib', bytes, trim);
  expect(budget.allowance('motif_cache_mib')).toBe(30);
  enabled = true; cap = 80;
  budget.maintain();
  expect(bytes).toBe(80);
});
