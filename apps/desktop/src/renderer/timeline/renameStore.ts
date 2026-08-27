import { create } from "zustand";

/// Which ONE thing is being renamed inline — a layer block, a lane header, or a
/// link's label tab.
///
/// One slot rather than a field per kind: the edits are the same gesture a few
/// pixels apart, and only one input can hold the caret, so a shape that could
/// hold several would let the second one strand the first's open field.
///
/// Lives in a store (not Timeline state) so both the double-click handler and
/// the matching context-menu "Rename" item can drive it without prop-drilling
/// the trigger through TrackLane / the header column. Atomic selectors only —
/// never select `editing` itself (feedback_zustand_composite_selector).
export interface RenameTarget {
  kind: "layer" | "track" | "link";
  id: string;
}

interface RenameState {
  editing: RenameTarget | null;
  begin: (target: RenameTarget) => void;
  end: () => void;
}

export const useRenameStore = create<RenameState>((set) => ({
  editing: null,
  begin: (target) => set({ editing: target }),
  end: () => set({ editing: null }),
}));

const editingLayer = (s: RenameState): string | null =>
  s.editing?.kind === "layer" ? s.editing.id : null;
const editingTrack = (s: RenameState): string | null =>
  s.editing?.kind === "track" ? s.editing.id : null;
const editingLink = (s: RenameState): string | null =>
  s.editing?.kind === "link" ? s.editing.id : null;

export const useEditingLayerId = (): string | null =>
  useRenameStore(editingLayer);

export const useEditingTrackId = (): string | null =>
  useRenameStore(editingTrack);

/// The link whose label tab holds the editor. The tab sits on the link's
/// anchor member (`indexLinkTabs`), whichever member the rename was asked on.
export const useEditingLinkId = (): string | null =>
  useRenameStore(editingLink);

export const beginLayerRename = (layerId: string): void =>
  useRenameStore.getState().begin({ kind: "layer", id: layerId });

export const beginTrackRename = (trackId: string): void =>
  useRenameStore.getState().begin({ kind: "track", id: trackId });

export const beginLinkRename = (linkId: string): void =>
  useRenameStore.getState().begin({ kind: "link", id: linkId });

export const endRename = (): void => useRenameStore.getState().end();
