import { create } from "zustand";
import type { PreviewSuspendedBy } from "../preview/PreviewSuspendedNotice";
import { activePreviewAudioEngine } from "./audio/previewAudioSession";

export const useExportPreviewSuspension = create<{ by: PreviewSuspendedBy | null }>(() => ({ by: null }));

/** Export preparation yields the preview even if no Preview panel is mounted.
 * The session transport and any later Preview panel observe the same hold. */
export function suspendExportPreview(by: PreviewSuspendedBy): () => void {
  const resumePlayback = activePreviewAudioEngine()?.suspendPlayback();
  useExportPreviewSuspension.setState({ by });
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    useExportPreviewSuspension.setState({ by: null });
    resumePlayback?.();
  };
}
