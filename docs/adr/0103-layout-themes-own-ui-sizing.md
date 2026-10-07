---
status: accepted
---

# Layout themes own application UI sizing

The editor had a shared compact type scale but distributed fixed dialog widths
and window defaults. Higher-resolution layouts need a single selection without
adding independent text-size, zoom or window-size controls.

Persist one app-level `layout_theme` id: 1080p, 2K (1440p) or 4K, each Standard
or Relaxed. Existing settings default to 1080p Standard with the original sizing.
Relaxed increases horizontal room and uses 10% larger text than Standard.
These are manually selected density presets, separate from color themes and
the user's Workspace Dock arrangement.

`shared/layout-theme.ts` owns the six recipes and initial window dimensions.
`renderer/styles/layout-theme.css` owns typography roles and dialog dimensions;
feature styles consume its variables and constrain geometry to the viewport.
The renderer root owns the app-settings subscription, so saved sizing applies
to startup and secondary windows as well as the editor and portal dialogs.
Main validates ids and stores no individual sizing overrides.

The text scale also owns normal UI geometry through `--ui-px`, including minimum
and maximum sizes, control dimensions and spacing. JS-owned constraints consume
the same scale through `layoutTheme.ts`; Dock group constraints are recomputed
when the theme, available viewport or group membership changes. Small windows
may relax group floors toward baseline sizes. Dialog roles retain the separate
width multiplier. This keeps text and its containing controls proportional while
allowing Relaxed dialogs extra horizontal room, without adding sizing settings.

All dimensions are CSS pixels / Electron DIPs. OS scaling is already included;
physical resolution and device pixel ratio do not multiply these values again.
Remembered window geometry takes precedence over preset initial dimensions,
within the active minimum bounds. The native minimum width is 960 times the
width scale and minimum height is 640 times the text scale, capped to the current
display's work area. These bounds apply at startup, theme changes and display
changes. A live window grows only if below the new minimum; selecting a smaller
preset releases the constraint without shrinking the window. Switching themes
does not reset a Workspace or affect authored Text layers and rendered output.

The dark palette and Base UI cascade contract in ADR 0018 are unchanged.
The preset table and token maintenance guidance live in `docs/ui-tokens.md`.
