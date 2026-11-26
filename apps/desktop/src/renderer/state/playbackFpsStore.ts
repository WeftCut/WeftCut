// The effective playback frame rate for the preview's fps readout. Written by
// PixiPreview from `Compositor.onPlaybackFps` (at most one reading per
// `PLAYBACK_FPS_WINDOW_MS`, never per frame), read by `PlaybackFpsReadout`,
// which lives outside the PixiPreview ref chain, as `underrunStore` does.

import { create } from "zustand";

interface State {
  /// Frames per second that reached the screen fresh in the last reading;
  /// null while nothing plays.
  fps: number | null;
}

export const usePlaybackFpsStore = create<State>(() => ({ fps: null }));

export function setPlaybackFps(fps: number | null): void {
  usePlaybackFpsStore.setState({ fps });
}

/// Called on PixiPreview unmount so a reading does not outlive its preview.
export function resetPlaybackFps(): void {
  usePlaybackFpsStore.setState({ fps: null });
}

export const usePlaybackFps = (): number | null =>
  usePlaybackFpsStore((s) => s.fps);
