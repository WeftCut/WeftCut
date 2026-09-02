import { create } from "zustand";

/// The auto-caption dialog's open state, as module-level state.
///
/// It cannot be owned by the Timeline Panel: the command reaches the Edit menu
/// and the search palette, both of which must work with every timeline closed,
/// and a dialog owned by an unmounted Panel would simply never render. So App
/// renders the dialog and every entry point only flips this. Same shape as
/// `history/checkpointPrompt.ts`.
///
/// `transcribing` lives here rather than as the dialog's own `useState` because
/// the COMMAND has to grey out while a run is in flight, and a command gate
/// cannot read a component's local state
/// (`speech/autoCaptionEligibility.ts` folds it into the verdict).

interface AutoCaptionPromptState {
  /// The clip being transcribed, captured at open. Null = closed.
  ///
  /// The id AND the name, because the dialog and the log rows name the clip and
  /// resolving the name again at submit would go looking for a layer the
  /// transcription may already have re-selected around.
  target: { layerId: string; layerName: string } | null;
  transcribing: boolean;
}

export const useAutoCaptionPromptStore = create<AutoCaptionPromptState>(() => ({
  target: null,
  transcribing: false,
}));

export function openAutoCaptionPrompt(
  layerId: string,
  layerName: string,
): void {
  useAutoCaptionPromptStore.setState({
    target: { layerId, layerName },
    transcribing: false,
  });
}

export function closeAutoCaptionPrompt(): void {
  useAutoCaptionPromptStore.setState({ target: null, transcribing: false });
}

export function setAutoCaptionTranscribing(transcribing: boolean): void {
  useAutoCaptionPromptStore.setState({ transcribing });
}
