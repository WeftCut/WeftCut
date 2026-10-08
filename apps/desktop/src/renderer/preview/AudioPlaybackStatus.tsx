import { TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlaybackPhase } from "../render/audio/PreviewAudioEngine";

export function AudioPlaybackStatus({ phase, error }: { phase: PlaybackPhase; error: string | null }) {
  const { t } = useTranslation();
  if (phase !== "preparing" && phase !== "error") return null;
  const failed = phase === "error";
  const label = t(failed ? "transport.audio_failed" : "transport.preparing_audio");
  const hint = failed ? `${label} · ${t("transport.retry_playback_hint")}` : label;
  const detail = failed && error ? `${hint}\n${error}` : hint;
  return (
    <span className={`audio-playback-status${failed ? " is-error" : ""}`}
      role={failed ? "alert" : "status"} title={detail} aria-label={hint}>
      {failed && <TriangleAlertIcon aria-hidden="true" />}
      <span className="audio-playback-status-label">{label}</span>
    </span>
  );
}
