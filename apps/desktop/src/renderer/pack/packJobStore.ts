// The pack or unpack main is running (`project-pack:progress`), for the work
// pill, the start screen and the menu gates.

import { create } from "zustand";
import { listen } from "@/bridge/events";
import { PROJECT_PACK_PROGRESS_EVENT, type PackJobProgress } from "../../shared/projectPack";

export const usePackJobStore = create<{ job: PackJobProgress | null }>(() => ({ job: null }));

let listening = false;

/// Starts the subscription once, for the life of the window: the pill unmounts
/// in agent mode and the start screen has none, and a run that ended
/// meanwhile must not still show.
export function listenForPackJobs(): void {
  if (listening) return;
  listening = true;
  void listen<PackJobProgress | null>(PROJECT_PACK_PROGRESS_EVENT, (e) => usePackJobStore.setState({ job: e.payload }));
}
