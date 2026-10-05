import { afterEach, describe, expect, it, vi } from "vitest";
import { SyntheticClock } from "./clock";
import { snapFrameRound } from "../frames";

afterEach(() => vi.restoreAllMocks());

describe("SyntheticClock audible output mapping", () => {
  it("keeps the PCM scheduling anchor but presents the sample reaching the output", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const ctx = {
      state: "running", currentTime: 100,
      getOutputTimestamp: () => ({ contextTime: ctx.currentTime - 0.1, performanceTime: now }),
    };
    const clock = new SyntheticClock();
    clock.bindAudio(ctx as unknown as AudioContext);
    clock.play(0.01);
    expect(clock.getAnchor()).toEqual({ compUs: 0, ctxTime: 100.01 });
    now += 510; ctx.currentTime += 0.51;
    clock.tick();
    expect(clock.rawPositionUs()).toBeCloseTo(400_000, 4);
    expect(clock.syncSnapshot()).toMatchObject({ source: "output-timestamp", timestampAgeMs: 0 });
    expect(clock.syncSnapshot().renderCompUs).toBeCloseTo(500_000, 4);
    expect(clock.syncSnapshot().outputCompUs).toBeCloseTo(400_000, 4);
  });

  it("holds the seek target until its scheduled audio reaches output, and resets on replay", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const ctx = { state: "running", currentTime: 100,
      getOutputTimestamp: () => ({ contextTime: ctx.currentTime - 0.1, performanceTime: 1000 }) };
    const c = new SyntheticClock(); c.bindAudio(ctx as unknown as AudioContext);
    c.setPosition(5_000_000); c.play(0.01);
    ctx.currentTime += 0.05;
    c.tick(); expect(c.rawPositionUs()).toBe(5_000_000);
    ctx.currentTime += 0.1;
    c.tick(); expect(c.rawPositionUs()).toBeCloseTo(5_040_000, 4);
    c.pause(); const held = c.rawPositionUs();
    ctx.currentTime = 200; c.play(); c.tick();
    expect(c.rawPositionUs()).toBe(held);
  });

  it("exposes an increased output delay without reanchoring or moving the playhead backwards", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    let delay = 0.05;
    const ctx = { state: "running", currentTime: 100,
      getOutputTimestamp: () => ({ contextTime: ctx.currentTime - delay, performanceTime: 1000 }) };
    const c = new SyntheticClock(); c.bindAudio(ctx as unknown as AudioContext); c.play();
    const anchor = c.getAnchor();
    ctx.currentTime = 101; c.tick();
    delay = 0.2; c.tick();
    expect(c.rawPositionUs()).toBeCloseTo(950_000, 4);
    expect(c.syncSnapshot().outputCompUs).toBeCloseTo(800_000, 4);
    expect(c.getAnchor()).toBe(anchor);
    ctx.currentTime = 101.3; c.tick();
    expect(c.rawPositionUs()).toBeCloseTo(1_100_000, 4);
  });

  it("labels stale, missing and throwing timestamp fallbacks and estimates latency only when available", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const ctx = { state: "running", currentTime: 100, baseLatency: 0.01, outputLatency: 0.09,
      getOutputTimestamp: () => ({ contextTime: 99, performanceTime: 1 }) };
    const c = new SyntheticClock(); c.bindAudio(ctx as unknown as AudioContext); c.play();
    ctx.currentTime = 101; c.tick();
    expect(c.rawPositionUs()).toBeCloseTo(900_000, 4);
    expect(c.syncSnapshot().source).toBe("latency-estimate");
    ctx.getOutputTimestamp = () => { throw new Error("device unavailable"); };
    c.tick(); expect(c.syncSnapshot().source).toBe("latency-estimate");
    ctx.outputLatency = NaN; c.tick();
    expect(c.syncSnapshot().source).toBe("render-clock");
    expect(c.rawPositionUs()).toBeCloseTo(1_000_000, 4);
  });
});

describe("SyntheticClock audio quantum interpolation", () => {
  it("reanchors scheduling on seek/resume and labels stale timestamp estimates", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let stamp = { contextTime: 99.95, performanceTime: now };
    const ctx = { state: "running", currentTime: 100, baseLatency: 0, outputLatency: 0.05, getOutputTimestamp: () => stamp };
    const clock = new SyntheticClock();
    clock.bindFps(60, 1);
    clock.bindAudio(ctx as unknown as AudioContext);
    clock.play();
    now += 1000; ctx.currentTime += 1; stamp = { contextTime: 100.95, performanceTime: now };
    expect(clock.tick().tUs).toBe(950_000);
    clock.setPosition(5_000_000);
    expect(clock.getAnchor()).toEqual({ compUs: 5_000_000, ctxTime: 101 });
    now += 1000; ctx.currentTime += 1; // stale timestamp: use latency properties
    expect(clock.tick().tUs).toBe(5_950_000);
    stamp = { contextTime: 101.95, performanceTime: now };
    expect(clock.tick().tUs).toBe(5_950_000);
    ctx.state = "suspended";
    clock.tick();
    expect(clock.getAnchor()).toBeNull();
    ctx.state = "running"; ctx.currentTime = 500;
    stamp = { contextTime: 499.95, performanceTime: now };
    expect(clock.tick().tUs).toBe(5_950_000);
    now += 1000; ctx.currentTime += 1; stamp = { contextTime: 500.95, performanceTime: now };
    expect(clock.tick().tUs).toBe(6_900_000);
  });

  it("presents every 60 fps frame across a 512-sample audio device quantum at any start phase", () => {
    for (const phase of [0, 3, 7, 9]) {
      let now = 1000 + phase;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const ctx = {
        state: "running",
        get currentTime() { return 100 + Math.floor((now - 1000) / (512 / 48)) * 512 / 48000; },
        getOutputTimestamp() {
          const sampledMs = Math.floor(now / 10) * 10;
          return { contextTime: 99.95 + (sampledMs - 1000) / 1000, performanceTime: sampledMs };
        },
      };
      const clock = new SyntheticClock();
      clock.bindFps(60, 1);
      clock.bindAudio(ctx as unknown as AudioContext);
      clock.play();
      const anchor = clock.getAnchor();
      for (let frame = 1; frame <= 600; frame++) {
        now = 1000 + phase + frame * 1000 / 60;
        const audibleUs = Math.max(0, phase * 1000 + frame * 1_000_000 / 60 - 50_000);
        expect(clock.tick().tUs, `phase ${phase}, frame ${frame}`).toBe(snapFrameRound(audibleUs, 60, 1));
      }
      // Visual interpolation never shifts audio scheduling's anchor.
      expect(clock.getAnchor()).toBe(anchor);
      vi.restoreAllMocks();
    }
  });
});

/// Controllable fake AudioContext for the audio-master derivation tests.
function fakeCtx(): { state: AudioContextState; currentTime: number } {
  return { state: "running", currentTime: 100 };
}

function bindFake(c: SyntheticClock, ctx: ReturnType<typeof fakeCtx>): void {
  c.bindAudio(ctx as unknown as AudioContext);
}

describe("SyntheticClock frame snap", () => {
  it("positionUs() returns the snapped value after setPosition", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    c.setPosition(17_000);
    expect(c.positionUs()).toBe(33_333);
  });

  it("positionUs() snaps even when fps isn't bound (defaults to 30)", () => {
    const c = new SyntheticClock();
    c.setPosition(17_000);
    expect(c.positionUs()).toBe(33_333);
  });

  it("setPosition is idempotent under snap", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    c.setPosition(17_000);
    const a = c.positionUs();
    c.setPosition(a);
    expect(c.positionUs()).toBe(a);
  });

  it("bindFps after setPosition re-snaps the next read", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    c.setPosition(33_333); // exact frame 1 at 30fps
    c.bindFps(30_000, 1001); // 29.97fps: frame 1 ≈ 33_366.667us
    // 33_333us at 29.97fps rounds to frame 1; `snapFrameRound` (../frames) is
    // half-up, so the snapped output is 33_367us.
    expect(c.positionUs()).toBe(33_367);
  });
});

describe("SyntheticClock audio-master derivation", () => {
  it("derives the playing position from ctx.currentTime exactly", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    // 90 audio-clock frames of 1/30 s: derived position tracks the fake
    // context with zero accumulation error.
    for (let i = 1; i <= 90; i++) {
      ctx.currentTime = 100 + i / 30;
      c.tick();
    }
    expect(c.positionUs()).toBe(3_000_000); // 3 s, exact
  });

  it("exposes the anchor while playing and audio-driven, null otherwise", () => {
    const c = new SyntheticClock();
    const ctx = fakeCtx();
    bindFake(c, ctx);
    expect(c.getAnchor()).toBe(null); // paused
    c.play();
    expect(c.getAnchor()).toEqual({ compUs: 0, ctxTime: 100 });
    c.pause();
    expect(c.getAnchor()).toBe(null);
  });

  it("setPosition during play re-anchors so derivation continues from there", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    ctx.currentTime = 101;
    c.tick();
    c.setPosition(5_000_000);
    expect(c.getAnchor()).toEqual({ compUs: 5_000_000, ctxTime: 101 });
    ctx.currentTime = 102;
    c.tick();
    expect(c.positionUs()).toBe(6_000_000);
  });

  it("falls back to wall deltas while suspended and re-anchors on resume without jumping", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    ctx.state = "suspended";
    bindFake(c, ctx);
    c.play();
    expect(c.getAnchor()).toBe(null); // wall mode
    c.tick(); // wall tick (dt ~0 in test time — position stays ~0)
    const before = c.positionUs();
    // Context starts running at an arbitrary epoch: the flip must
    // re-anchor from the CURRENT position, not jump to the epoch. The
    // anchor stores the RAW (unsnapped) position — a few µs of real wall
    // time elapse inside this test — so assert continuity on the snapped
    // playhead and closeness on the raw anchor, not deep equality.
    ctx.state = "running";
    ctx.currentTime = 555.5;
    c.tick();
    expect(c.positionUs()).toBe(before);
    const anchor = c.getAnchor()!;
    expect(anchor.ctxTime).toBe(555.5);
    expect(Math.abs(anchor.compUs - before)).toBeLessThan(5_000);
    // And from here it derives (snap re-grids the µs of wall residue).
    ctx.currentTime = 556.5;
    c.tick();
    expect(c.positionUs()).toBe(before + 1_000_000);
  });

  it("pause clears the anchor; replay re-anchors at the held position", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    ctx.currentTime = 102; // +2 s
    c.tick();
    c.pause();
    const held = c.positionUs();
    expect(held).toBe(2_000_000);
    ctx.currentTime = 300; // context keeps running while paused
    c.play();
    expect(c.getAnchor()).toEqual({ compUs: 2_000_000, ctxTime: 300 });
    ctx.currentTime = 301;
    c.tick();
    expect(c.positionUs()).toBe(3_000_000);
  });

  it("never moves backward across ticks with a quantized context clock", () => {
    const c = new SyntheticClock();
    c.bindFps(30, 1);
    const ctx = fakeCtx();
    bindFake(c, ctx);
    c.play();
    ctx.currentTime = 100.5;
    c.tick();
    const p1 = c.positionUs();
    // ctx.currentTime updates in render quanta — a repeat read must not
    // regress the position.
    c.tick();
    expect(c.positionUs()).toBeGreaterThanOrEqual(p1);
  });
});
