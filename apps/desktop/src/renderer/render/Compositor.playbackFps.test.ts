import { Container, type Application } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Compositor } from "./Compositor";
import type { DecoderPool } from "./decoder/session";
import { resolveSourceColor } from "./decoder/ffprobeColorSpace";
import { playbackFpsIsLow } from "./playbackFpsMeter";
import { summaryFixture } from "../testing/summaryFixture";

// The fps readout's session wiring at the Compositor: which jumps start a new
// window, and the post-seek grace it shares with the underrun tracker. An empty
// 30 fps timeline paints every sweep fresh, so the only frames a reading can
// miss are the ones the clock or the loop skips.

const FPS = 30;
const DISPLAY_MS = 1_000 / 60;

describe("Compositor fps readout", () => {
  let compositor: Compositor;
  let readings: number[];
  let nowMs: number;
  let clockUs: number;

  beforeEach(() => {
    nowMs = 0;
    clockUs = 0;
    readings = [];
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    compositor = new Compositor({
      // Real scene-graph Containers; only the renderer is absent (node env).
      app: { stage: new Container() } as unknown as Application,
      width: 1920,
      height: 1080,
      mode: "preview",
      originalAssetUrl: () => null,
      sourceColor: () => resolveSourceColor({ width: 1920, height: 1080 }),
      mediaById: () => undefined,
      pool: { dispose: vi.fn() } as unknown as DecoderPool,
      onPlaybackFps: (fps) => {
        if (fps !== null) readings.push(fps);
      },
    });
    compositor.setProject(summaryFixture({ root: { fps_num: FPS, fps_den: 1, duration_us: 60_000_000 } }));
    compositor.setMasterPlayState(true);
  });

  afterEach(() => {
    compositor.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /// One display frame of the loop, `intervalMs` after the last one; the clock
  /// moves on by the same time.
  function frame(intervalMs = DISPLAY_MS): void {
    nowMs += intervalMs;
    clockUs += intervalMs * 1_000;
    compositor.noteFrameInterval(intervalMs);
    compositor.compositeFrame(clockUs);
  }

  function play(seconds: number): void {
    for (let i = 0; i < seconds * 60; i++) frame();
  }

  const lowReadings = () => readings.filter((fps) => playbackFpsIsLow(fps, FPS));

  it("does not charge a Preview shown again mid-play with the frames the clock passed while it was hidden", () => {
    play(1);
    compositor.setPresentationVisible(false);
    play(5);
    compositor.setPresentationVisible(true);
    const before = readings.length;
    play(1);
    expect(readings.length).toBeGreaterThan(before);
    expect(lowReadings()).toEqual([]);
  });

  it("does not charge a document shown again with the frames the clock passed without rAF, but charges the same gap in a visible one", () => {
    play(1);
    // A minimized window: no rAF while the clock runs on, then PixiPreview's
    // visibilitychange ahead of the first rAF back.
    compositor.noteDocumentShown();
    frame(5_000);
    const before = readings.length;
    play(1);
    expect(readings.length).toBeGreaterThan(before);
    expect(lowReadings()).toEqual([]);

    frame(5_000); // the same gap with the document shown is a stalled loop
    play(1);
    expect(lowReadings().length).toBeGreaterThan(0);
  });

  it("does not charge an in-play seek with the frames it jumps over", () => {
    play(1);
    const before = readings.length;
    compositor.noteSeekWhilePlaying();
    clockUs += 10_000_000;
    play(1);
    expect(readings.length).toBeGreaterThan(before);
    expect(lowReadings()).toEqual([]);
  });

  it("waits out the post-seek grace, so only the same stall without a seek reads low", () => {
    play(1);
    compositor.noteSeekWhilePlaying();
    for (let i = 0; i < 4; i++) frame(100); // the ring rebuild stalls the loop
    play(1.5);
    expect(lowReadings()).toEqual([]);

    for (let i = 0; i < 4; i++) frame(100);
    play(1);
    expect(lowReadings().length).toBeGreaterThan(0);
  });
});
