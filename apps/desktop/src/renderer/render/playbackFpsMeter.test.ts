import { describe, expect, it } from "vitest";

import { PLAYBACK_FPS_WINDOW_MS, PlaybackFpsMeter, playbackFpsIsLow } from "./playbackFpsMeter";

const TARGET = 30_000 / 1_001;
const FRAME_US = 1_000_000 / TARGET; // one comp frame at 29.97
const DISPLAY_MS = 1_000 / 60;

interface Playhead {
  ms: number;
  frame: number;
}

/// Drives `seconds` of 60 Hz sweeps over a 29.97 composition from `from` and
/// returns where the next sweep lands. `freshAt` decides per sweep whether it
/// paints fresh; `first` marks the first sweep of its comp frame.
function play(
  meter: PlaybackFpsMeter,
  seconds: number,
  freshAt: (frame: number, first: boolean) => boolean,
  from: Playhead = { ms: 0, frame: 0 },
): Playhead {
  const frameAt = (ms: number) => from.frame + Math.floor(((ms - from.ms) * 1_000) / FRAME_US);
  const sweeps = Math.round(seconds * 60);
  let last: number | null = null;
  for (let i = 0; i < sweeps; i++) {
    const ms = from.ms + i * DISPLAY_MS;
    const frame = frameAt(ms);
    meter.noteSweep(frame * FRAME_US, freshAt(frame, frame !== last), ms);
    last = frame;
  }
  const ms = from.ms + sweeps * DISPLAY_MS;
  return { ms, frame: frameAt(ms) };
}

/// A 29.97 meter and the non-null readings it reports.
function meterAt2997(): { meter: PlaybackFpsMeter; rates: number[] } {
  const rates: number[] = [];
  const meter = new PlaybackFpsMeter((fps) => {
    if (fps !== null) rates.push(fps);
  });
  meter.setTargetFps(30_000, 1_001);
  return { meter, rates };
}

describe("PlaybackFpsMeter", () => {
  it("reads the composition's rate in every window when each frame lands fresh; a frame swept twice counts once", () => {
    const { meter, rates } = meterAt2997();
    play(meter, 3, () => true);
    expect(rates.length).toBeGreaterThan(3);
    for (const fps of rates) expect(fps).toBeCloseTo(TARGET, 6);
  });

  it("leaves out comp frames painted only stale, so a decoder at half speed reads half", () => {
    const { meter, rates } = meterAt2997();
    play(meter, 3, (frame) => frame % 2 === 0);
    expect(rates.length).toBeGreaterThan(3);
    // Each window holds whole comp frames, so half is off by at most one.
    const framesPerWindow = (TARGET * PLAYBACK_FPS_WINDOW_MS) / 1_000;
    for (const fps of rates) {
      expect(Math.abs(fps - TARGET / 2)).toBeLessThanOrEqual(TARGET / framesPerWindow);
      expect(playbackFpsIsLow(fps, TARGET)).toBe(true);
    }
  });

  it("counts frames the composite loop skipped as passed and not shown", () => {
    const { meter, rates } = meterAt2997();
    // A loop that only gets a sweep in every third comp frame, all fresh.
    for (let i = 0; i < 90; i++) meter.noteSweep(i * 3 * FRAME_US, true, i * 100);
    expect(rates.length).toBeGreaterThan(1);
    for (const fps of rates) expect(fps).toBeCloseTo(TARGET / 3, 6);
  });

  it("counts a frame stale on its first sweep and fresh on the next, also when that first sweep closes a window", () => {
    const { meter, rates } = meterAt2997();
    play(meter, 3, (_frame, first) => !first);
    expect(rates.length).toBeGreaterThan(3);
    for (const fps of rates) expect(fps).toBeCloseTo(TARGET, 6);
  });

  it("keeps the window open while the clock holds one frame longer than a window, never reading NaN", () => {
    const { meter, rates } = meterAt2997();
    const at = play(meter, 1, () => true);
    // An output-latency increase holds the presented position (clock.ts).
    const holdMs = 2 * PLAYBACK_FPS_WINDOW_MS;
    for (let ms = at.ms; ms < at.ms + holdMs; ms += DISPLAY_MS) meter.noteSweep(at.frame * FRAME_US, true, ms);
    play(meter, 1, () => true, { ms: at.ms + holdMs, frame: at.frame });
    expect(rates.length).toBeGreaterThan(2);
    for (const fps of rates) expect(fps).toBeCloseTo(TARGET, 6);
  });

  it("reads a composition slower than the window at its own rate", () => {
    const rates: number[] = [];
    const meter = new PlaybackFpsMeter((fps) => {
      if (fps !== null) rates.push(fps);
    });
    meter.setTargetFps(1, 1);
    for (let i = 0; i < 5 * 60; i++) {
      const ms = i * DISPLAY_MS;
      meter.noteSweep(Math.floor(ms / 1_000) * 1_000_000, true, ms);
    }
    expect(rates.length).toBeGreaterThan(2);
    for (const fps of rates) expect(fps).toBe(1);
  });

  it("does not count the frames a forward seek jumps over", () => {
    const { meter, rates } = meterAt2997();
    const at = play(meter, 1, () => true);
    const before = rates.length;
    meter.restart(); // what Compositor.noteSeekWhilePlaying does
    play(meter, 1.5, () => true, { ms: at.ms, frame: at.frame + 270 });
    const after = rates.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const fps of after) expect(fps).toBeCloseTo(TARGET, 6);
  });

  it("opens a new window on a jump back, counting the replayed frames as shown", () => {
    const { meter, rates } = meterAt2997();
    const at = play(meter, 1, () => true);
    const before = rates.length;
    play(meter, 1.5, () => true, { ms: at.ms, frame: 0 });
    const after = rates.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const fps of after) expect(fps).toBeCloseTo(TARGET, 6);
  });

  it("starts a new window when the frame rate changes", () => {
    const { meter, rates } = meterAt2997();
    const at = play(meter, 1, () => true);
    const before = rates.length;
    meter.setTargetFps(60_000, 1_001);
    const frame60Us = 1_001_000 / 60;
    for (let i = 0; i < 90; i++) {
      const tUs = at.frame * FRAME_US + i * DISPLAY_MS * 1_000;
      meter.noteSweep(Math.floor(tUs / frame60Us) * frame60Us, true, at.ms + i * DISPLAY_MS);
    }
    const after = rates.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const fps of after) expect(fps).toBeCloseTo(2 * TARGET, 6);
  });

  it("reports nothing once playback stops", () => {
    const seen: Array<number | null> = [];
    const meter = new PlaybackFpsMeter((fps) => seen.push(fps));
    meter.setTargetFps(30_000, 1_001);
    play(meter, 1, () => true);
    meter.stop();
    expect(seen[seen.length - 1]).toBeNull();
  });

  it("calls one comp frame lost per window low at 29.97 but not at 59.94", () => {
    const oneLost = (fps: number) => {
      const framesPerWindow = Math.ceil((fps * PLAYBACK_FPS_WINDOW_MS) / 1_000);
      return (fps * (framesPerWindow - 1)) / framesPerWindow;
    };
    expect(playbackFpsIsLow(TARGET, TARGET)).toBe(false);
    expect(playbackFpsIsLow(oneLost(TARGET), TARGET)).toBe(true);
    expect(playbackFpsIsLow(oneLost(2 * TARGET), 2 * TARGET)).toBe(false);
    expect(playbackFpsIsLow(10, 0)).toBe(false);
  });
});
