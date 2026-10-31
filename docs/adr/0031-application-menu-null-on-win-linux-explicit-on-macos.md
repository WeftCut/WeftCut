---
status: accepted
---

# Application menu: `null` on Windows/Linux, explicit minimal menu on macOS

Date: 2026-07-15

## Context

Every shortcut is dispatched in the renderer by `useShortcuts` from the
`shortcuts/defs.ts` catalogue, with user rebinds in `keybindings.json`. Without
`Menu.setApplicationMenu`, Electron installs a default menu that ships Reload
(discarding unsaved timeline state) and DevTools to end users, maps Cmd+W to
window close (the app's `Mod+W` is `closeProject`) and Cmd+Z to DOM text undo.
Windows/Linux windows are frameless, so a native menu bar never renders there;
macOS owns its menu bar and `role: 'appMenu'` has no Settings slot.

Measured on Electron 42 ([electron-chromium-behavior.md](../notes/electron-chromium-behavior.md)):

1. On macOS the renderer sees every chord before the menu, and its
   `preventDefault()` suppresses the matching item (role and custom alike).
2. A role item is all-or-nothing: `accelerator: ''` kills its native behaviour,
   and `registerAccelerator: false` is ignored on macOS.
3. `role: 'viewMenu'` re-adds Reload and DevTools.

## Decision

- **Windows/Linux:** `Menu.setApplicationMenu(null)` (`shouldClearApplicationMenu`,
  `src/main/inputPolicy.ts`). Dev reload/DevTools/fullscreen live in
  `hardenWindow`'s `before-input-event`, gated on `isDev`.
- **macOS:** an explicit menu (`src/main/appMenu.ts`): App (hand-assembled from
  roles so Settings gets `Cmd+,`), `editMenu`, a hand-built View (full screen
  only — never `role: 'viewMenu'`), `windowMenu`, and a File projection. The
  in-app `AppMenuBar` stays the primary command surface on every platform (it
  also renders in fullscreen, where the system bar hides).
- The renderer pushes a `MenuProjection` (`src/shared/menu.ts`) with resolved
  labels and effective accelerators on mount, locale switch and rebind; native
  items dispatch back over `menu:action`. Main owns only the structure.
- Actions the current surface cannot run are omitted, not disabled: live
  enable-state would need an IPC push per transition.
- `Cmd+W` is `closeProject`; there is no Close Window item. Settings is the
  catalogue action `openSettings` (`Mod+Comma`), rebindable.
- Copy/paste and undo/redo carry `fireWhenEditing: false`, so inside a text field
  the native Edit role serves; elsewhere the project action does.

## Consequences

- No shipped build exposes Reload or DevTools; `e2e/electron/menu.spec.ts` gates it.
- Default-menu accelerators such as Ctrl+Q are gone on Windows/Linux; anything
  wanted must come from `before-input-event` or the renderer.
- Until the renderer's first projection, the macOS menu is roles only.
- Electron's role labels stay English regardless of app locale.
- Renderer ownership of shared chords is a manual check: `sendInputEvent`
  injects past AppKit, so an injected-key test passes whatever the menu does.

Rejected: `registerAccelerator: false` everywhere (no gain on frameless windows,
ignored on macOS); `null` everywhere (macOS needs App/Edit/Window, `Cmd+,` and
text-field undo, and a menu-less Mac relies on an undocumented copy asymmetry).
