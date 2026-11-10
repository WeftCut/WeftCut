import type { MotifColdStartResult } from "../../shared/ipc";

export interface MotifColdStartSteps {
  /// The open project's folder, or null with none open.
  openFolder: () => Promise<string | null>;
  /// Saves and closes through File › Save and Close's path, and leaves the editor.
  close: () => Promise<void>;
  /// Drops the renderer's in-memory Motif frames and baked-frame index.
  clearFrames: () => void;
  /// Main deletes the closed project's frame cache and retires its capture hosts.
  dropCache: (dir: string) => Promise<MotifColdStartResult>;
  /// Opens the folder through the startup screen's path and enters the editor.
  reopen: (dir: string) => Promise<void>;
}

/// Dev menu › Motif cold start: the open project closes, loses every cached
/// Motif frame, and reopens, so capture hosts and preview warm as on a first
/// open. Main refuses the cache drop while the project is open, hence the
/// close first; a failed drop still reopens the project.
export async function motifColdStart(steps: MotifColdStartSteps): Promise<MotifColdStartResult | null> {
  const dir = await steps.openFolder();
  if (!dir) return null;
  await steps.close();
  try {
    return await steps.dropCache(dir);
  } finally {
    // After main's round trip: by then the closed editor has unmounted and
    // stopped putting frames into the caches.
    steps.clearFrames();
    await steps.reopen(dir);
  }
}
