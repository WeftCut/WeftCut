import { describe, expect, it } from "vitest";

import { HandoffTimings, type FenceHandoffStats } from "./handoffTimings";

const read = (residentMs = 1) => ({ gvfMs: 0.5, cibMs: 1.5, residentMs });
const fenced = (drawMs = 0.1) => ({ drawMs, readMs: 0, proof: false });
const health = (over: Partial<FenceHandoffStats> = {}): FenceHandoffStats =>
  ({ pendingPeak: 1, forcedWaits: 0, forcedWaitMsTotal: 0, ...over });

describe("HandoffTimings", () => {
  it("is null until a sample lands, so 'no frames yet' never reads as 0 ms", () => {
    expect(new HandoffTimings().summary()).toBeNull();
  });

  // The two halves of the proof point at opposite fixes — a costly `drawImage`
  // says the GPU→CPU transfer already happened there; a costly `getImageData`
  // says it happens on the read — so the total keeps them apart.
  it("reports read completion as its draw plus its read, keeping the phases apart", () => {
    const t = new HandoffTimings();
    t.record(read(22), { drawMs: 19.4, readMs: 0.6, proof: true });
    const s = t.summary()!;
    expect(s.barrierP50).toBeCloseTo(20);
    expect(s.barrierDrawP50).toBeCloseTo(19.4);
    expect(s.barrierReadP50).toBeCloseTo(0.6);
    expect(s.cibP50).toBeCloseTo(1.5);
    expect(s.residentP50).toBeCloseTo(22);
  });

  // An order check passes under the proof as well as under the fence, so the
  // count is what tells a run that exercised the fence from one that did not.
  it("counts proof fallbacks over the whole session, past the window", () => {
    const t = new HandoffTimings(4);
    t.record(read(), { drawMs: 5, readMs: 1, proof: true });
    for (let i = 0; i < 8; i++) t.record(read(), fenced());
    t.record(read(), { drawMs: 5, readMs: 1, proof: true });
    const s = t.summary()!;
    expect(s.n).toBe(4);
    expect(s.proofFallbacks).toBe(2);
  });

  it("reports no proof fallback when the fence ran for every frame", () => {
    const t = new HandoffTimings();
    for (let i = 0; i < 3; i++) t.record(read(), fenced(), health());
    expect(t.summary()!.proofFallbacks).toBe(0);
  });

  // The fence defers the wait instead of paying it inline, so the fields below
  // are the only way to tell "moved the cost" from "removed it".
  it("reports no fence wait until a fence completes", () => {
    const t = new HandoffTimings();
    t.record(read(), fenced(), health());
    const s = t.summary()!;
    expect(s.fenceWaitP50).toBeNull();
    expect(s.fencePendingQueuePeak).toBe(1);
    expect(s.fenceForcedWaits).toBe(0);
  });

  it("keeps the deferred wait out of the blocking read-completion cost", () => {
    const t = new HandoffTimings();
    for (let i = 0; i < 4; i++) t.record(read(), fenced(0.1), health({ waitMs: 16, pendingPeak: 2 }));
    const s = t.summary()!;
    expect(s.barrierP50).toBeCloseTo(0.1);
    expect(s.fenceWaitP50).toBeCloseTo(16);
  });

  it("percentiles fence waits over their own window, not the frame window", () => {
    const t = new HandoffTimings();
    // Two frames submitted before any fence drained, then 100 carrying a wait —
    // counting the first two as zero would halve the reported p50.
    t.record(read(), fenced(), health());
    t.record(read(), fenced(), health({ pendingPeak: 2 }));
    for (let i = 1; i <= 100; i++) t.record(read(), fenced(), health({ waitMs: i, pendingPeak: 2 }));
    expect(t.summary()!.fenceWaitP50).toBe(50);
  });

  // Cumulative counters: last-known must survive the ring, or a burst of
  // forced releases early in a long session would scroll out of sight.
  it("keeps the peak queue depth, forced-wait count and spin total as maxima", () => {
    const t = new HandoffTimings(4);
    for (let i = 0; i < 9; i++) {
      t.record(read(), fenced(), health({ waitMs: 5, pendingPeak: 3, forcedWaits: 2, forcedWaitMsTotal: 41 }));
    }
    const s = t.summary()!;
    expect(s.n).toBe(4);
    expect(s.fencePendingQueuePeak).toBe(3);
    expect(s.fenceForcedWaits).toBe(2);
    expect(s.fenceForcedWaitMsTotal).toBeCloseTo(41);
  });

  it("surfaces a rising forced-wait count", () => {
    const t = new HandoffTimings();
    t.record(read(), fenced(), health({ waitMs: 20, forcedWaits: 1 }));
    t.record(read(), fenced(), health({ waitMs: 20, forcedWaits: 7 }));
    expect(t.summary()!.fenceForcedWaits).toBe(7);
  });

  it("reports zeroed fence health on a run with no fences", () => {
    const t = new HandoffTimings();
    t.record(read(22), { drawMs: 19.4, readMs: 0.6, proof: true });
    const s = t.summary()!;
    expect(s.fenceWaitP50).toBeNull();
    expect(s.fencePendingQueuePeak).toBe(0);
    expect(s.fenceForcedWaits).toBe(0);
    expect(s.fenceForcedWaitMsTotal).toBe(0);
  });

  it("reports nearest-rank percentiles and the window max", () => {
    const t = new HandoffTimings();
    for (let i = 1; i <= 100; i++) t.record(read(), { drawMs: i * 0.9, readMs: i * 0.1, proof: false });
    const s = t.summary()!;
    expect(s.n).toBe(100);
    expect(s.barrierP50).toBeCloseTo(50);
    expect(s.barrierP95).toBeCloseTo(95);
    expect(s.barrierMax).toBeCloseTo(100);
    expect(s.barrierDrawP50).toBeCloseTo(45);
    expect(s.barrierReadP50).toBeCloseTo(5);
  });

  it("keeps only the last `capacity` samples", () => {
    const t = new HandoffTimings(4);
    for (const v of [100, 100, 100, 100, 1, 2, 3, 4]) t.record(read(), fenced(v));
    const s = t.summary()!;
    expect(s.n).toBe(4);
    expect(s.barrierMax).toBe(4);
  });
});
