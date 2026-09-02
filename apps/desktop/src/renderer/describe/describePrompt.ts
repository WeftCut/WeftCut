import { create } from "zustand";

/// The describe dialog's open state, as module-level state.
///
/// It cannot be owned by the Timeline Panel: the command reaches the Edit menu
/// and the search palette, both of which must work with every timeline closed,
/// and a dialog owned by an unmounted Panel would simply never render. So App
/// renders the dialog and every entry point only flips this. Same shape as
/// `silence/silencePrompt.ts`.
///
/// No in-flight flag here, for that store's reason: the run is startable from
/// nowhere but this dialog, so nothing outside it needs to grey. The flag that
/// does exist lives in `descriptionsStore.ts`, because the SHOT ROWS read it —
/// a cell with no description yet says whether one is on its way.

/// The clip a description is about, captured at open.
///
/// The id AND the name, because the dialog and the log rows name the clip and
/// resolving the name again at submit would go looking for a layer the run may
/// already have re-selected around.
///
/// `mediaId` rides along because the RESULT is source-scoped: the segments land
/// under the source, the shot rows read them back by media id, and resolving it
/// from the layer afterwards would mean re-walking a project this store
/// deliberately holds no subscription to.
export interface DescribeTarget {
  layerId: string;
  layerName: string;
  mediaId: string;
}

interface DescribePromptState {
  /// Null = closed.
  target: DescribeTarget | null;
}

export const useDescribePromptStore = create<DescribePromptState>(() => ({
  target: null,
}));

export function openDescribePrompt(target: DescribeTarget): void {
  useDescribePromptStore.setState({ target });
}

export function closeDescribePrompt(): void {
  useDescribePromptStore.setState({ target: null });
}
