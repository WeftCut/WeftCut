import { useEffect, useRef } from "react";

import { formatTimecode } from "../frames";
import { useFocusedCompositionId } from "../state/compositionAnchorStore";
import {
  playheadLocalUs,
  subscribeLocalPlayhead,
  useAnchorFrame,
} from "../state/playheadProjection";

/// Transport-bar timecode readout. Frame-rate text via a TRANSIENT
/// playhead-store subscription (tier 2, playheadStore.ts): the subscription
/// mutates the span's text node directly, so playback causes zero React
/// commits here. Click / Enter / Space hands off to the edit field.
///
/// PROJECTED: this reads the composition the preview draws, so it is that
/// composition's timecode rather than the film's. A moment the composition's
/// placement does not reach has no timecode on its clock, and the readout says
/// so with dashes instead of naming a frame that is not on screen.
export function PlayheadTimecode({
  fpsNum,
  fpsDen,
  visible,
  editHint,
  onActivate,
}: {
  fpsNum: number;
  fpsDen: number;
  visible: boolean;
  editHint: string;
  onActivate: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const compositionId = useFocusedCompositionId();
  // Hoisted out of the per-frame callback: an anchor frame is a walk of the
  // summary and moves only when the project or the anchor does.
  const frame = useAnchorFrame(compositionId);
  useEffect(() => {
    if (!visible) return;
    return subscribeLocalPlayhead(compositionId, frame, (localUs) => {
      if (ref.current) ref.current.textContent = timecodeOf(localUs, fpsNum, fpsDen);
    });
  }, [compositionId, frame, fpsNum, fpsDen, visible]);
  return (
    <button
      type="button"
      ref={ref}
      className="preview-timecode"
      aria-live="polite"
      title={editHint}
      onClick={onActivate}
    >
      {timecodeOf(playheadLocalUs(compositionId), fpsNum, fpsDen)}
    </button>
  );
}

/// Dashes for a moment this composition is not on screen at — the text
/// counterpart of a playhead line that draws nothing.
const OFF_SCREEN_TIMECODE = "––:––:––:––";

function timecodeOf(localUs: number | null, fpsNum: number, fpsDen: number): string {
  return localUs === null ? OFF_SCREEN_TIMECODE : formatTimecode(localUs, fpsNum, fpsDen);
}
