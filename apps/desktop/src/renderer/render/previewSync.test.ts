import { expect, it } from "vitest";
import { PreviewSyncTracker } from "./previewSync";
import type { ClockSyncSnapshot } from "./clock";
const clock = (t: number): ClockSyncSnapshot => ({ source: "output-timestamp",
  timestampAgeMs: 0, outputCompUs: t, renderCompUs: t + 100_000, presentationUs: t });

it("measures held pixels against output at submit, including time spent composing", () => {
  const s = new PreviewSyncTracker();
  s.begin(400_000); s.frame(300_000, 333_333); s.submit(10, clock(410_000));
  expect(s.snapshot()).toMatchObject({ clockSkewMs: -10, videoLateMs: 76.667, videoLeadMs: 0 });
  s.begin(500_000); s.hold(400_000, 33_333); s.submit(110, clock(500_000));
  expect(s.snapshot()).toMatchObject({ heldScenes: 1, videoLateMs: 66.667,
    submitIntervalMs: { p99: 100, max: 100 } });
});

it("does not count legitimate frame repetition as late; reports future and missing layers independently", () => {
  const s = new PreviewSyncTracker();
  for (const t of [0, 16_667]) {
    s.begin(t); s.frame(0, 33_333); s.submit(t / 1000, clock(t));
    expect(s.snapshot().videoLateMs).toBe(0);
  }
  s.begin(20_000); s.frame(40_000, 80_000); s.frame(null, null); s.submit(20, clock(20_000));
  expect(s.snapshot()).toMatchObject({ videoLeadMs: 20, missingLayers: 1 });
  s.interrupt(); s.submit(10_000, clock(20_000));
  expect(s.snapshot().submitIntervalMs!.max).toBeLessThan(20);
  s.reset(); expect(s.snapshot()).toMatchObject({ samples: 0, submitIntervalMs: null });
});

it("keeps missing output information explicit and bounds history", () => {
  const s = new PreviewSyncTracker(); s.begin(0); s.frame(0, null);
  for (let i = 0; i < 1000; i++) s.submit(i * 10, null);
  expect(s.snapshot()).toMatchObject({ samples: 1000, clockSkewMs: null,
    videoLateMs: null, videoLeadMs: null, submitIntervalMs: { p99: 10 } });
});
