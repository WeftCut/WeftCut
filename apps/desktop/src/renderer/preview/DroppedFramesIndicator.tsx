// Transport-bar underrun indicator — the NLE-standard "playback couldn't
// keep up" signal (Premiere's dropped-frame dot, Resolve's red fps
// readout). Lit while playback is actively behind, then dims and disappears
// after three seconds without a new problem. Counts describe this episode;
// cumulative session totals remain in PerfHUD and the status log.
//
// Two counts, never merged into a total — see `render/underrunTracker.ts`
// for why the two causes stay apart.

import { useTranslation } from "react-i18next";

import {
  useUnderrunActive,
  useUnderrunDroppedFrames,
  useUnderrunLateFrames,
} from "../state/underrunStore";

export function DroppedFramesIndicator() {
  const { t } = useTranslation();
  const active = useUnderrunActive();
  const droppedFrames = useUnderrunDroppedFrames();
  const lateFrames = useUnderrunLateFrames();
  if (droppedFrames === 0 && lateFrames === 0) return null;
  const counted: string[] = [];
  const causes: string[] = [];
  if (droppedFrames > 0) {
    counted.push(t("transport.dropped_frames", { count: droppedFrames }));
    causes.push(t("transport.dropped_frames_cause"));
  }
  if (lateFrames > 0) {
    counted.push(t("transport.late_frames", { count: lateFrames }));
    causes.push(t("transport.late_frames_cause"));
  }
  const text =
    droppedFrames > 0 && lateFrames > 0
      ? `${droppedFrames}/${lateFrames}`
      : String(droppedFrames > 0 ? droppedFrames : lateFrames);
  return (
    <span
      className={
        active ? "dropped-frames-indicator is-active" : "dropped-frames-indicator"
      }
      role="status"
      // No counts in the tooltip: they change several times a second while
      // playback is behind, and Chromium never shows a native tooltip whose
      // text keeps changing under the pointer.
      title={causes.join(" · ")}
      aria-label={counted.join(" · ")}
    >
      <span className="dropped-frames-dot" aria-hidden />
      {text}
    </span>
  );
}
