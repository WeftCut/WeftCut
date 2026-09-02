import { create } from "zustand";

/// The voiceover dialog's open state, as module-level state — `checkpointPrompt`'s
/// shape and `autoCaptionPrompt`'s reasons, minus the target: this operation has
/// no scope. It needs a script, not a selection, so there is nothing to capture
/// at open.

interface VoiceoverPromptState {
  open: boolean;
}

export const useVoiceoverPromptStore = create<VoiceoverPromptState>(() => ({
  open: false,
}));

export function openVoiceoverPrompt(): void {
  useVoiceoverPromptStore.setState({ open: true });
}

export function closeVoiceoverPrompt(): void {
  useVoiceoverPromptStore.setState({ open: false });
}
