// Editing tool selection — which modal tool arms clicks on the editing
// surfaces. Session state, deliberately NOT persisted: a project always reopens
// on the Selection tool, matching every NLE.
//
// Each tool names the surface it changes. `blade` changes what a TIMELINE
// layer click does; `text` changes what a PREVIEW click does and leaves the
// timeline behaving as under `select` (the preview click has a frame
// coordinate to place text at, a timeline click does not). The store is one
// radio group regardless, because a user holds one tool at a time.
//
// A module-level store rather than App state because the Quick Actions Panel
// is a Dock Panel: it must read the active tool without sitting on App's
// props chain, and routing the tool through `dockPanelContracts` would rebuild
// that memo — and re-render every open Panel — on each tool switch.
//
// React subscribers must use the ATOMIC selector hook below (per
// `feedback_zustand_composite_selector` — never select a composite object).

import { create } from "zustand";

/// The modal tools. `select` is the default: layer clicks select and drag.
/// `blade` arms the razor — timeline clicks split the layer at the click point.
/// `text` arms the Text tool — a preview click edits the Text layer under the
/// pointer, or creates one at the click point (`preview/TextToolOverlay.tsx`).
///
/// Adding a tool is additive: extend this union, give it an `ActionId` + key
/// in `ACTION_DEFS`, and add a row to the Quick Actions tool section.
export type Tool = "select" | "blade" | "text";

interface State {
  tool: Tool;
}

export const useToolStore = create<State>(() => ({ tool: "select" }));

/**
 * Arm `tool`. IDEMPOTENT by design — one tool one key, so `setTool('blade')`
 * twice leaves you in blade mode.
 *
 * LANDMINE: do not "helpfully" reintroduce a toggle here. A toggle only reads
 * as sensible while exactly two tools exist; from a third tool it has no
 * defined return target (blade → ? → hand), which is precisely why every NLE
 * binds one key per tool instead.
 */
export function setTool(tool: Tool): void {
  if (useToolStore.getState().tool !== tool) useToolStore.setState({ tool });
}

/// Imperative read for event-time callers (shortcut handlers) that must not
/// subscribe.
export function activeTool(): Tool {
  return useToolStore.getState().tool;
}

export const useActiveTool = (): Tool => useToolStore((s) => s.tool);
