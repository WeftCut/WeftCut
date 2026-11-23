// Copies into the project's `Fonts/` in flight, fed by main's
// `project-fonts:progress` event (ADR 0176), for the work pill.

import { create } from "zustand";
import { onFontCopyProgress, type FontCopyProgress } from "../ipc";

export interface FontCopies extends FontCopyProgress {
  /// Renderer wall clock when the batch's first progress arrived: the pill's
  /// show delay counts from it.
  since: number;
}

export const useFontCopiesStore = create<{ copies: FontCopies | null }>(() => ({ copies: null }));

function fontCopyProgress(progress: FontCopyProgress | null): void {
  useFontCopiesStore.setState((s) => ({
    copies: progress === null ? null : { ...progress, since: s.copies?.since ?? Date.now() },
  }));
}

let listening = false;

/// Starts the subscription once, for the life of the window. Never torn down
/// with the pill: the status bar unmounts in agent mode, and a batch that ended
/// meanwhile must not still show when the bar comes back.
export function listenForFontCopies(): void {
  if (listening) return;
  listening = true;
  onFontCopyProgress((progress) => fontCopyProgress(progress));
}

export function resetFontCopiesForTests(): void {
  useFontCopiesStore.setState({ copies: null });
}
