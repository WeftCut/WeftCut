import { create } from "zustand";

/// The silence dialog's open state, as module-level state.
///
/// It cannot be owned by the Timeline Panel: the command reaches the Edit menu
/// and the search palette, both of which must work with every timeline closed,
/// and a dialog owned by an unmounted Panel would simply never render. So App
/// renders the dialog and every entry point only flips this. Same shape as
/// `speech/autoCaptionPrompt.ts`.
///
/// Unlike that one this store carries no in-flight flag, and the difference is
/// real rather than an omission: a transcription is a paid network request whose
/// second concurrent run would bill twice and race two tracks onto the timeline,
/// so its COMMAND has to grey out. Marking silences is a local commit that
/// cannot be started from anywhere but this dialog, and the dialog disables its
/// own button while the commit is in flight.

/// The clip a silence run is about, captured at open.
///
/// The id AND the name, because the dialog and the log rows name the clip and
/// resolving the name again at submit would go looking for a layer the marks may
/// already have re-selected around.
///
/// `mediaId` rides along for the waveform wait alone: the derivative-job events
/// are keyed by MEDIA, so a dialog watching for its own source's waveform has to
/// know which id to match — and resolving it from the layer later would mean
/// re-walking a project the wait is deliberately not holding a subscription to.
export interface SilenceTarget {
  layerId: string;
  layerName: string;
  mediaId: string;
}

interface SilencePromptState {
  /// Null = closed.
  target: SilenceTarget | null;
}

export const useSilencePromptStore = create<SilencePromptState>(() => ({
  target: null,
}));

export function openSilencePrompt(target: SilenceTarget): void {
  useSilencePromptStore.setState({ target });
}

export function closeSilencePrompt(): void {
  useSilencePromptStore.setState({ target: null });
}
