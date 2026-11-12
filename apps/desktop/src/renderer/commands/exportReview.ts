import type { ActionId } from "../shortcuts/defs";
import type { MenuOnlyCommandId, SelfContainedCommandId } from "./appCommands";
import type { HandlerMap } from "../shortcuts/useShortcuts";
import type { CommandDef } from "./registry";

/// What stays available while an export holds the project: transport, view
/// and navigation. Anything not named here is locked, so a new command is
/// locked by default. Main's project mutation gate is what protects the
/// output; this lock only keeps the UI from offering edits main would refuse.
const EXPORT_REVIEW_COMMANDS: ReadonlySet<string> = new Set([
  "togglePlay", "seekFrameBack", "seekFrameForward", "seekSecondBack", "seekSecondForward",
  "seekPrevEdit", "seekNextEdit", "seekPrevMarker", "seekNextMarker", "seekStart", "seekEnd",
  "previewZoomFit", "previewZoomIn", "previewZoomOut", "selectHandTool", "selectTool",
  "toggleFollowPlayhead", "toggleDisplayMode", "toggleSafeAreaGuides", "toggleMarkersVisible",
  "zoomTimelineIn", "zoomTimelineOut",
  "focusNextPanel", "focusPreviousPanel", "toggleMaximizePanel", "restoreMaximizedPanel",
  "openSettings", "openSearchPalette", "toggleLog", "focusLogSearch",
] satisfies (ActionId | MenuOnlyCommandId | SelfContainedCommandId)[]);

/// The shortcut handlers that still run while an export holds the project.
export function exportReviewShortcuts(handlers: HandlerMap, locked: boolean): HandlerMap {
  if (!locked) return handlers;
  return Object.fromEntries(Object.entries(handlers).filter(([id]) => EXPORT_REVIEW_COMMANDS.has(id)));
}

/// The same lock for registry commands: locked ones stay listed but disabled.
export function exportReviewCommands(commands: CommandDef[], locked: boolean): CommandDef[] {
  if (!locked) return commands;
  return commands.map(command => EXPORT_REVIEW_COMMANDS.has(command.id) ? command : { ...command, enabled: () => false });
}
