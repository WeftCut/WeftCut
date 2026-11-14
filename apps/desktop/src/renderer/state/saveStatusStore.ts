// The renderer's mirror of main's save status (shared/save-status.ts): whether
// the open project is reaching disk. State only — the Save failed pill and its
// popover decide what to draw from it.

import { create } from "zustand";
import { listen } from "@/bridge/events";
import { SAVE_STATUS_EVENT, projectSaveStatus, type SaveStatus } from "../ipc";

interface SaveStatusState {
  status: SaveStatus;
}

export const useSaveStatusStore = create<SaveStatusState>(() => ({
  status: { state: "ok", revision: 0 },
}));

/// Takes `next` unless the mirror already holds a newer revision: a pull that
/// answers after a push must not roll the state back.
export function receiveSaveStatus(next: SaveStatus): void {
  useSaveStatusStore.setState((s) => (next.revision > s.status.revision ? { status: next } : s));
}

/// The failing state, or null while saving works.
export const useSaveFailure = (): Extract<SaveStatus, { state: "failing" }> | null =>
  useSaveStatusStore((s) => (s.status.state === "failing" ? s.status : null));

/// Subscribe before the pull, so a change cannot fall between them; the
/// revision check keeps whichever is newer.
export async function wireSaveStatus(): Promise<() => void> {
  let disposed = false;
  const stop = await listen<SaveStatus>(SAVE_STATUS_EVENT, (e) => {
    if (!disposed) receiveSaveStatus(e.payload);
  });
  try {
    const current = await projectSaveStatus();
    if (!disposed) receiveSaveStatus(current);
  } catch {
    /* the next change is pushed anyway */
  }
  return () => {
    disposed = true;
    stop();
  };
}
