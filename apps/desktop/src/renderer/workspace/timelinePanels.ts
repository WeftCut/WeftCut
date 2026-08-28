// The Dock's timeline Panels as the rest of the renderer addresses them: "show
// this composition" and "stop showing it". No Dockview object, no `PanelId` and
// no adapter crosses this module — the anchor store and the navigation verbs
// name a composition and nothing else.
//
// Registered by the Workspace on mount, playbackStore-style, so the stores and
// commands that move between compositions are not handed a controller they
// would then have to thread through every caller. Every verb is a safe no-op
// while no Workspace is mounted: the startup screen, agent mode and the unit
// suites all run without one.

export interface TimelinePanelCommands {
  /// Ensure a Panel showing `compositionId` exists and is active.
  open(compositionId: string): void;
  /// Retire the Panel showing `compositionId`, if one is open.
  close(compositionId: string): void;
}

let commands: TimelinePanelCommands | null = null;

/// Identity-guarded unregister (the `registerRevealTrack` pattern): a stale
/// cleanup from an old mount cannot tear down a newer registration.
export function registerTimelinePanels(
  next: TimelinePanelCommands,
): () => void {
  commands = next;
  return () => {
    if (commands === next) commands = null;
  };
}

export function openTimelinePanel(compositionId: string): void {
  commands?.open(compositionId);
}

export function closeTimelinePanel(compositionId: string): void {
  commands?.close(compositionId);
}
