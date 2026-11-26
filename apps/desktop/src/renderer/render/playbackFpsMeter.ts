// The effective playback frame rate behind the preview's fps readout: how
// many comp frames per second reached the screen fresh. The clock free-runs
// off the audio output clock and never waits for decode
// (docs/preview.md#clock-and-presentation, #decode), so a decoder that falls
// behind or a stalled composite loop lowers this number, not the playback
// speed. This module owns neither the loop nor the verdict: `Compositor`
// hands it each sweep's comp frame and freshness, and says when playback
// starts, stops or jumps.

/// The shortest span one reading covers. Long enough to steady the number,
/// short enough that a stall shows within a second.
export const PLAYBACK_FPS_WINDOW_MS = 500;

/// Below this share of the composition's rate a reading is low. Grid counting
/// reads a smooth playback at exactly its rate, so this only lets a small loss
/// pass: one lost comp frame per window stays above it from about 40 fps
/// (29/30 at 60 fps); at 30 fps and below any lost frame reads low.
export const PLAYBACK_FPS_LOW_RATIO = 0.95;

export function playbackFpsIsLow(fps: number, targetFps: number): boolean {
  return targetFps > 0 && fps < targetFps * PLAYBACK_FPS_LOW_RATIO;
}

export class PlaybackFpsMeter {
  private fps = 30;
  /// The open window: when it opened, the first comp frame index it owns and
  /// the latest one swept. Null until the first sweep after a restart.
  private window: { startMs: number; fromIndex: number; lastIndex: number } | null = null;
  private lastShownIndex: number | null = null;
  private shown = 0;

  constructor(private readonly onFps: (fps: number | null) => void) {}

  /// The composition's frame rate, which sets the grid and the full reading.
  /// A new rate starts a new window: the open one's indices are on the old grid.
  setTargetFps(fpsNum: number, fpsDen: number): void {
    if (!(fpsNum > 0 && fpsDen > 0) || fpsNum / fpsDen === this.fps) return;
    this.fps = fpsNum / fpsDen;
    this.restart();
  }

  /// Playback starts or jumps: the next window opens at the next sweep.
  restart(): void {
    this.window = null;
    this.lastShownIndex = null;
    this.shown = 0;
  }

  /// Playback stopped: there is no rate to show.
  stop(): void {
    this.restart();
    this.onFps(null);
  }

  /// One composite sweep while playing. `frameUs` is the comp frame it
  /// painted; `fresh` is false when any layer painted a stale frame. A reading
  /// is the share of the comp frames passed that some sweep painted fresh,
  /// times the rate: a frame swept twice counts once, and one painted only
  /// stale or skipped by the loop counts as passed, not shown. Counted on the
  /// comp grid; per wall-clock window, 29.97 would read 29 and 31 by turns.
  noteSweep(frameUs: number, fresh: boolean, nowMs: number): void {
    const index = Math.round((frameUs * this.fps) / 1_000_000);
    // Backwards (a jump the Compositor did not report as a seek): the frames
    // ahead are not owed.
    if (this.window !== null && index < this.window.lastIndex) this.restart();
    const w = this.window;
    if (w === null) {
      this.window = { startMs: nowMs, fromIndex: index, lastIndex: index };
    } else if (index > w.lastIndex) {
      // Closed only as a new comp frame begins, so all of a frame's sweeps
      // fall in one window (stale on the first, fresh on the next still
      // counts) and a clock holding one frame keeps the window open.
      if (nowMs - w.startMs >= PLAYBACK_FPS_WINDOW_MS) {
        this.onFps((this.fps * this.shown) / (index - w.fromIndex));
        w.startMs = nowMs;
        w.fromIndex = index;
        this.shown = 0;
      }
      w.lastIndex = index;
    }
    if (fresh && index !== this.lastShownIndex) {
      this.shown += 1;
      this.lastShownIndex = index;
    }
  }
}
