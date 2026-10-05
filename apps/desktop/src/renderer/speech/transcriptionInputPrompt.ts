import { create } from "zustand";
import { logEmit } from "../ipc";
import { checkTranscriptionInput, type TranscriptionInputDecision, type TranscriptionInputIssue, type TranscriptionSource } from "./transcriptionInput";

interface InputPrompt {
  issues: TranscriptionInputIssue[];
  resolve: (decision: TranscriptionInputDecision) => void;
}
export const useTranscriptionInputPrompt = create<{ pending: InputPrompt | null }>(() => ({ pending: null }));

export function answerTranscriptionInput(action: "cancel" | "original" | "normalize"): void {
  const pending = useTranscriptionInputPrompt.getState().pending;
  useTranscriptionInputPrompt.setState({ pending: null });
  pending?.resolve(action === "cancel" ? false : {
    normalizeLayerIds: action === "normalize"
      ? pending.issues.filter(i => i.kind === "quiet" && i.peakDbfs !== null).map(i => i.layerId)
      : [],
  });
}

export async function confirmTranscriptionInput(sources: readonly TranscriptionSource[]): Promise<TranscriptionInputDecision> {
  const issues = await checkTranscriptionInput(sources);
  if (issues.length === 0) return { normalizeLayerIds: [] };
  for (const issue of issues) {
    void logEmit({
      level: "warn", category: { kind: "Project" }, source: { kind: "User" },
      message: issue.kind === "quiet" ? `Low source audio level: ${issue.label}` : `Audio level check unavailable: ${issue.label}`,
      i18n_key: issue.kind === "quiet" ? "log.auto_caption_quiet" : "log.auto_caption_level_unavailable",
      i18n_args: { clip: issue.label },
      details: { context: "transcription_input", layer_id: issue.layerId, ...issue },
    });
  }
  // The run owns the in-flight guard while this promise is pending.
  return new Promise<TranscriptionInputDecision>(resolve => useTranscriptionInputPrompt.setState({ pending: { issues, resolve } }));
}
