// The preview toolbar's playback frame-rate readout, beside the zoom control:
// how many frames per second actually reach the screen while playing
// (`render/playbackFpsMeter.ts`), red when that falls short of the preview
// target's own rate. Hidden while nothing plays. The transport bar's
// DroppedFramesIndicator counts the frames lost; this says what rate the
// viewer got.

import { useTranslation } from "react-i18next";

import { PLAYBACK_FPS_LOW_RATIO, playbackFpsIsLow } from "../render/playbackFpsMeter";
import { usePlaybackFps } from "../state/playbackFpsStore";

export function PlaybackFpsReadout({ targetFps }: { targetFps: number | null }) {
  const { t } = useTranslation();
  const fps = usePlaybackFps();
  if (fps === null || targetFps === null) return null;
  const low = playbackFpsIsLow(fps, targetFps);
  // A fractional rate reads to its own precision: a healthy 29.97 is 29.97,
  // not 30.0, which would sit above the rate the hint names.
  const fractional = !Number.isInteger(targetFps);
  const threshold = {
    target: targetFps.toFixed(fractional ? 2 : 0),
    percent: Math.round(PLAYBACK_FPS_LOW_RATIO * 100),
  };
  // Not a live region: under load the reading changes every window, and a
  // polite region would re-announce each one.
  return (
    <span
      className={low ? "playback-fps-readout is-low" : "playback-fps-readout"}
      title={t("preview.playback_fps_hint", threshold)}
    >
      {t("preview.playback_fps", { fps: fps.toFixed(fractional ? 2 : 1) })}
      {low && <span className="sr-only">{t("preview.playback_fps_low", threshold)}</span>}
    </span>
  );
}
