// A request to open Settings on one pane, from anywhere in the renderer. Only
// App owns the dialog (`openSettings`), and commands borrow it through their
// deps; a panel or a notice card several layers down has no such dep, so it
// asks here and App, subscribed once, opens the pane.

import { create } from "zustand";

import type { SettingsCategory } from "./SettingsPanel";

interface SettingsRequestState {
  /// The latest request; `seq` makes a repeat of the same pane a new request.
  request: { category: SettingsCategory; seq: number } | null;
}

export const useSettingsRequest = create<SettingsRequestState>(() => ({ request: null }));

let seq = 0;

export function requestSettings(category: SettingsCategory): void {
  useSettingsRequest.setState({ request: { category, seq: ++seq } });
}
