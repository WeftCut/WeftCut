# React/Electron docking layout research

Why the workspace uses Dockview behind `workspace/dockWorkspaceAdapter.ts`, and
what not to switch on.

## Constraints

- React StrictMode, Electron sandbox (no Node globals), renderer `window.open`
  denied (`src/main/windows.ts`).
- Dock hosts must keep `min-width: 0` / `min-height: 0` and explicit overflow
  for Timeline and Preview sizing.
- Media drags (`application/x-weftcut-media`) and OS `Files` drops must pass
  through the dock untouched.
- Workspace JSON is main-owned app state, outside project state and undo.

## Findings

- **Dockview** (chosen): panels in groups on a resizable grid, tab reorder,
  edge/centre docking, JSON serialization with `fromJSON(…, { reuseExistingPanels })`
  so panels are not recreated; unique panel ids fit one-instance-per-kind. Cost:
  an imperative `DockviewApi`, hence the adapter. Its popouts open a same-origin
  window with a separate host page — incompatible with the `window.open` denial
  and with renderer-local playback/selection/GPU preview. Floating groups are
  disabled (`disableFloatingGroups`); never enable floating or popout.
- **FlexLayout**: the fallback if Dockview can no longer be isolated behind the
  adapter. Application-owned immutable tree model, action interception. Its
  popouts render through portals into another document, which breaks the app's
  many global `window`/`document` listeners.
- **rc-dock**: alpha major, larger dependency surface, no advantage.
- **Lumino**: a widget/message-loop framework, not React-first; adopting it means
  a second UI lifecycle.

## Rule kept from the research

Library JSON is never the durable schema: the adapter wraps it in a versioned
WeftCut layout record (`WEFTCUT_LAYOUT_VERSION`) so a library migration happens
at one boundary.
