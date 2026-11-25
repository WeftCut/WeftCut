import { create } from "zustand";

/// Whether What's New is on screen at launch. The project trust prompt waits
/// for it to close, and it waits while that prompt is open: two launch
/// dialogs never stack.
export const useLaunchNotesShowing = create<boolean>(() => false);
